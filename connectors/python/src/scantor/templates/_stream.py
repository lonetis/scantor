"""Template proxies: typed `schedule` functions whose items are streamed from the runtime.

Passed unwrapped (`schedule=tranco.schedule`), a proxy is only a marker: describe reports the template
and the runtime runs it natively. Called inside a custom schedule (wrapped), it sends a `template`
request and yields the runtime's `templateItem`s under credit flow control (docs/protocol.md §5.8, §6.2).
"""

import asyncio
import threading
from collections import deque
from collections.abc import AsyncIterator, Callable, Iterator, Mapping
from typing import Any, cast

import pydantic

from scantor._json import ModelCodec, describe_exception
from scantor._request import ActiveRequest
from scantor.context import Context
from scantor.errors import ScantorError

INITIAL_CREDIT = 256
CREDIT_STEP = 128
CANCEL_WAIT_SECONDS = 10.0
_WAIT_SLICE_SECONDS = 0.1

TEMPLATE_ATTRIBUTE = "__scantor_template__"


def template_schedule[F: Callable[..., Any]](name: str) -> Callable[[F], F]:
    """Mark a proxy function as the `schedule` of template `name` (unwrapped detection)."""

    def mark(function: F) -> F:
        setattr(function, TEMPLATE_ATTRIBUTE, name)
        return function

    return mark


def template_name(schedule: object) -> str | None:
    """The template a schedule function proxies, or None for a custom schedule."""
    name = getattr(schedule, TEMPLATE_ATTRIBUTE, None)
    return name if isinstance(name, str) else None


def canonical_scan_config(
    scan_config: pydantic.BaseModel | Mapping[str, Any], model: type[pydantic.BaseModel]
) -> dict[str, Any]:
    """The template's canonical fields of `scan_config` (a model instance, a subclass or a mapping)."""
    json_names: dict[str, str] = {}
    for attribute, field in model.model_fields.items():
        json_name = field.serialization_alias or field.alias or attribute
        json_names[json_name] = json_name
        json_names[attribute] = json_name
    if isinstance(scan_config, pydantic.BaseModel):
        data = ModelCodec.of(type(scan_config)).to_json_object(scan_config)
    elif isinstance(scan_config, Mapping):
        data = dict(scan_config)
    else:
        raise TypeError(f"scan_config must be a {model.__name__} or a mapping, not {type(scan_config).__name__}")
    return {json_names[key]: value for key, value in data.items() if key in json_names}


class TemplateStream[T: pydantic.BaseModel]:
    """The analysis configs of a wrapped template call; iterate it with `for` or `async for`.

    Every iteration opens a new template stream. Stopping early cancels the stream in the runtime.
    Failures of the template (for example an unavailable list) are raised as `ScantorError`.
    """

    def __init__(self, ctx: Context, template: str, scan_config: dict[str, Any], model: type[T]) -> None:
        self._request: ActiveRequest = ctx._request
        self._template = template
        self._scan_config = scan_config
        self._codec = ModelCodec.of(model)

    def __iter__(self) -> Iterator[T]:
        return self._iterate()

    def __aiter__(self) -> AsyncIterator[T]:
        return self._aiterate()

    def _iterate(self) -> Iterator[T]:
        call = self._open()
        try:
            while (config := call.next_sync()) is not None:
                yield self._parse(config)
        finally:
            call.close()

    async def _aiterate(self) -> AsyncIterator[T]:
        call = self._open()
        try:
            while (config := await call.next_async()) is not None:
                yield self._parse(config)
        finally:
            call.close()

    def _open(self) -> TemplateCall:
        if self._request.kind != "schedule":
            raise ScantorError("validation", "templates can only be used in schedule")
        return TemplateCall(self._request, self._template, self._scan_config)

    def _parse(self, config: dict[str, Any]) -> T:
        try:
            return cast(T, self._codec.validate_json_value(config))
        except pydantic.ValidationError as exc:
            raise ScantorError(
                "validation",
                f"template {self._template} produced an analysis config that "
                f"{self._codec.model.__name__} rejects: {describe_exception(exc)}",
            ) from exc


class TemplateCall:
    """One `template` request: buffers `templateItem`s and grants credit as user code consumes them."""

    def __init__(self, request: ActiveRequest, template: str, scan_config: dict[str, Any]) -> None:
        self._request = request
        self._wire = request.wire
        self._template = template
        self._cond = threading.Condition()
        self._items: deque[dict[str, Any]] = deque()
        self._finished = False
        self._error: ScantorError | None = None
        self._cancelled = False
        self._closed = False
        self._consumed = 0
        self._async_waiters: list[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = []
        self.id = self._wire.next_call_id()
        self._wire.register_call(self.id, self)
        sent = request.send_scoped(
            {
                "type": "template",
                "id": self.id,
                "parent": request.id,
                "template": template,
                "scanConfig": scan_config,
                "credit": INITIAL_CREDIT,
            }
        )
        if not sent:
            self._wire.unregister_call(self.id)
            raise ScantorError("validation", "the schedule has ended; templates can only be used in schedule")
        request.track_template_call(self)

    # Reader thread side.

    def on_reply(self, message: Mapping[str, Any]) -> None:
        kind = message.get("type")
        with self._cond:
            if self._finished:
                return
            if kind == "templateItem":
                config = message.get("config")
                if not self._cancelled and isinstance(config, dict):
                    self._items.append(cast(dict[str, Any], config))
            elif kind == "templateDone":
                self._finished = True
            elif kind == "error":
                self._error = _stream_error(message.get("error"), self._template)
                self._finished = True
            self._cond.notify_all()
            waiters = list(self._async_waiters)
        for loop, event in waiters:
            if not loop.is_closed():
                loop.call_soon_threadsafe(event.set)

    def on_closed(self) -> None:
        self.on_reply({"type": "error", "error": {"type": "platform", "message": "the runtime closed the connection"}})

    # Consumer side (the thread or event loop running the schedule).

    def next_sync(self) -> dict[str, Any] | None:
        """The next item, or None at the end of the stream; blocks until one arrives."""
        with self._cond:
            while not self._items and not self._finished:
                self._request.scope.raise_if_cancelled()
                self._cond.wait(_WAIT_SLICE_SECONDS)
            item = self._take()
        self._consumed_one(item)
        return item

    async def next_async(self) -> dict[str, Any] | None:
        loop = asyncio.get_running_loop()
        while True:
            with self._cond:
                if self._items or self._finished:
                    item = self._take()
                    break
                waiter = (loop, asyncio.Event())
                self._async_waiters.append(waiter)
            try:
                await waiter[1].wait()
            finally:
                with self._cond:
                    self._async_waiters.remove(waiter)
        self._consumed_one(item)
        return item

    def close(self) -> None:
        """End the stream; cancels it in the runtime unless it already finished. Idempotent."""
        with self._cond:
            if self._closed:
                return
            self._closed = True
            cancel = not self._finished
            if cancel:
                self._cancelled = True
                self._items.clear()
        if cancel:
            self._wire.send({"type": "templateCancel", "id": self.id})
            with self._cond:
                # Wait for templateDone, so the schedule's `done` follows the end of its streams.
                self._cond.wait_for(lambda: self._finished, CANCEL_WAIT_SECONDS)
        self._wire.unregister_call(self.id)

    def _take(self) -> dict[str, Any] | None:
        if self._items:
            return self._items.popleft()
        if self._error is not None:
            raise self._error
        return None

    def _consumed_one(self, item: dict[str, Any] | None) -> None:
        if item is None:
            return
        self._consumed += 1
        if self._consumed % CREDIT_STEP == 0:
            with self._cond:
                grant = not self._finished and not self._cancelled
            if grant:
                self._wire.send({"type": "templateCredit", "id": self.id, "credit": CREDIT_STEP})


def _stream_error(error: object, template: str) -> ScantorError:
    error_map = cast(Mapping[str, Any], error) if isinstance(error, Mapping) else {}
    return ScantorError(
        str(error_map.get("type", "platform")),
        str(error_map.get("message", f"template {template} failed")),
        retryable=bool(error_map.get("retryable", False)),
    )
