"""Serving the runtime's requests: describe, run and schedule, with error classification."""

import asyncio
import contextlib
import inspect
import sys
from collections.abc import AsyncIterable, Iterable, Mapping
from typing import Any, cast

import pydantic

from scantor._connector import Connector
from scantor._json import (
    MAX_ERROR_MESSAGE,
    ModelCodec,
    NotJsonError,
    describe_exception,
    encode_line,
    format_stack,
    not_json_error,
    truncate,
    validation_error,
)
from scantor._request import ActiveRequest, Cancelled, RequestKind
from scantor.context import Context
from scantor.errors import Fatal, Retry, ScantorError
from scantor.task import Task

_REASONS = {"deadline": "deadline exceeded"}


class InvalidOutputError(Exception):
    """Task code produced a value the connector cannot send (invalid config or result)."""

    def __init__(self, error: dict[str, Any]) -> None:
        super().__init__(error["message"])
        self.error = error


def error_object(exc: BaseException, request: ActiveRequest) -> dict[str, Any]:
    """Map an exception that ended a request to the protocol error object (docs/tasks.md §5.4)."""
    reason = request.scope.reason
    if reason is not None:
        # Once cancellation was requested, any failure is its consequence.
        return {"type": "cancelled", "message": f"cancelled: {_REASONS.get(reason, reason)}"}
    if isinstance(exc, InvalidOutputError):
        return exc.error
    if isinstance(exc, Fatal):
        return {
            "type": "fatal",
            "message": truncate(exc.message or "Fatal", MAX_ERROR_MESSAGE),
            "stack": format_stack(exc),
        }
    if isinstance(exc, Retry):
        error: dict[str, Any] = {
            "type": "retry",
            "message": truncate(exc.message or "Retry", MAX_ERROR_MESSAGE),
            "stack": format_stack(exc),
        }
        if exc.delay_ms is not None:
            error["delayMs"] = exc.delay_ms
        return error
    if isinstance(exc, ScantorError):
        # Connectors never claim `platform`; only `validation` keeps its type.
        kind = "validation" if exc.type == "validation" else "taskError"
        return {"type": kind, "message": truncate(exc.message, MAX_ERROR_MESSAGE), "stack": format_stack(exc)}
    if isinstance(exc, pydantic.ValidationError):
        # Model validation failures are deterministic: retrying the same input cannot help.
        error = validation_error(exc.title, exc)
        error["stack"] = format_stack(exc)
        return error
    return {"type": "taskError", "message": describe_exception(exc), "stack": format_stack(exc)}


def handle_describe(connector: Connector, task: Task[Any, Any, Any, Any], message: Mapping[str, Any]) -> None:
    request_id = cast(str, message["id"])
    try:
        description = describe(task)
    except (pydantic.PydanticUserError, TypeError, ValueError) as exc:
        connector.reply_error(
            request_id,
            {"type": "validation", "message": f"cannot export the JSON Schemas: {describe_exception(exc)}"},
        )
        return
    connector.send({"type": "description", "id": request_id, **description})


def describe(task: Task[Any, Any, Any, Any]) -> dict[str, Any]:
    """The `description` payload: raw schemas (configs in input mode, result in output mode)."""
    warnings: list[str] = []
    if task.template == "single":
        try:
            task.analysis_config.model_validate({})
        except pydantic.ValidationError:
            warnings.append(
                f"the task has no schedule, so every analysis gets the analysis config {{}}, which "
                f"{task.analysis_config.__name__} rejects; give its fields defaults or add a schedule"
            )
    return {
        "schemas": {
            "taskConfig": task.task_config.model_json_schema(mode="validation"),
            "scanConfig": task.scan_config.model_json_schema(mode="validation"),
            "analysisConfig": task.analysis_config.model_json_schema(mode="validation"),
            "result": task.result.model_json_schema(mode="serialization"),
        },
        "schedule": (
            {"kind": "template", "template": task.template} if task.template is not None else {"kind": "custom"}
        ),
        "warnings": warnings,
    }


def handle_run(connector: Connector, task: Task[Any, Any, Any, Any], message: Mapping[str, Any]) -> None:
    request = _begin(connector, message, "run")
    reply = _run(connector, task, request, message)
    _end(connector, request, reply)


def handle_schedule(connector: Connector, task: Task[Any, Any, Any, Any], message: Mapping[str, Any]) -> None:
    request = _begin(connector, message, "schedule")
    reply = _schedule(connector, task, request, message)
    _end(connector, request, reply)


def _begin(connector: Connector, message: Mapping[str, Any], kind: RequestKind) -> ActiveRequest:
    ctx = message.get("ctx")
    request = ActiveRequest(connector, cast(str, message["id"]), kind, ctx if isinstance(ctx, Mapping) else {})
    connector.activate(request)
    request.start_deadline_timer()
    return request


def _end(connector: Connector, request: ActiveRequest, reply: dict[str, Any]) -> None:
    try:
        request.finish()
        # Output of the call belongs to its log tail: flush it before the reply ends the request.
        for stream in (sys.stdout, sys.stderr):
            with contextlib.suppress(OSError, ValueError):
                stream.flush()
        line = encode_line(reply)
        if len(line) > connector.limits.max_line_bytes:
            line = encode_line(
                {
                    "type": "error",
                    "id": request.id,
                    "error": {
                        "type": "validation",
                        "message": f"the {reply['type']} message is {len(line)} bytes, above the protocol "
                        f"line limit of {connector.limits.max_line_bytes}; store large data with ctx.files",
                    },
                }
            )
        request.end(line)
    finally:
        connector.deactivate()


def _validate_input(codec: ModelCodec, value: object, subject: str) -> Any:
    try:
        return codec.validate_json_value(value if value is not None else {})
    except pydantic.ValidationError as exc:
        raise InvalidOutputError(validation_error(subject, exc)) from exc


def _run(
    connector: Connector, task: Task[Any, Any, Any, Any], request: ActiveRequest, message: Mapping[str, Any]
) -> dict[str, Any]:
    try:
        analysis_config = _validate_input(
            ModelCodec.of(task.analysis_config), message.get("analysisConfig"), "analysis config"
        )
        task_config = _validate_input(ModelCodec.of(task.task_config), message.get("taskConfig"), "task config")
        ctx = Context(request)
        value = task.run(ctx, analysis_config, task_config)
        if inspect.isawaitable(value):
            value = connector.run_async(request, value)
        result = _encode_result(task, value)
    except (Exception, asyncio.CancelledError, Cancelled) as exc:
        return {"type": "error", "id": request.id, "error": error_object(exc, request)}
    return {"type": "result", "id": request.id, "result": result}


def _encode_result(task: Task[Any, Any, Any, Any], value: object) -> dict[str, Any]:
    codec = ModelCodec.of(task.result)
    try:
        return codec.to_json_object(codec.validate_python(value))
    except pydantic.ValidationError as exc:
        raise InvalidOutputError(validation_error("result", exc)) from exc
    except NotJsonError as exc:
        raise InvalidOutputError(not_json_error("result", exc)) from exc


class _Emitter:
    """Validates and sends the analysis configs a schedule produces, in order."""

    def __init__(self, connector: Connector, request: ActiveRequest, codec: ModelCodec) -> None:
        self._connector = connector
        self._request = request
        self._codec = codec
        self.count = 0

    def emit(self, item: object) -> None:
        try:
            config = self._codec.to_json_object(self._codec.validate_python(item))
        except pydantic.ValidationError as exc:
            raise InvalidOutputError(validation_error("analysis config", exc)) from exc
        except NotJsonError as exc:
            raise InvalidOutputError(not_json_error("analysis config", exc)) from exc
        line = encode_line({"type": "analysis", "id": self._request.id, "config": config})
        if len(line) > self._connector.limits.max_line_bytes:
            raise InvalidOutputError(
                {
                    "type": "validation",
                    "message": f"an analysis config of {len(line)} bytes exceeds the protocol line limit",
                }
            )
        # A blocking write here is the intended backpressure: the runtime reads only as fast as it publishes.
        self._connector.send_line(line)
        self.count += 1


def _schedule(
    connector: Connector, task: Task[Any, Any, Any, Any], request: ActiveRequest, message: Mapping[str, Any]
) -> dict[str, Any]:
    emitter = _Emitter(connector, request, ModelCodec.of(task.analysis_config))
    try:
        scan_config = _validate_input(ModelCodec.of(task.scan_config), message.get("scanConfig"), "scan config")
        task_config = _validate_input(ModelCodec.of(task.task_config), message.get("taskConfig"), "task config")
        ctx = Context(request)
        produced = task.schedule(ctx, scan_config, task_config)
        if inspect.isawaitable(produced) or not isinstance(produced, Iterable):
            connector.run_async(request, _drive_async(produced, emitter, request))
        else:
            _drive_sync(cast(Iterable[object], produced), emitter, request)
    except (Exception, asyncio.CancelledError, Cancelled) as exc:
        return {"type": "error", "id": request.id, "error": error_object(exc, request)}
    return {"type": "done", "id": request.id, "count": emitter.count}


def _drive_sync(produced: Iterable[object], emitter: _Emitter, request: ActiveRequest) -> None:
    iterator = iter(produced)
    try:
        while True:
            request.scope.raise_if_cancelled()
            try:
                item = next(iterator)
            except StopIteration:
                return
            emitter.emit(item)
    finally:
        close = getattr(iterator, "close", None)
        if callable(close):
            close()


async def _drive_async(produced: object, emitter: _Emitter, request: ActiveRequest) -> None:
    if inspect.isawaitable(produced):
        produced = await produced
    if isinstance(produced, AsyncIterable):
        iterator = aiter(cast(AsyncIterable[object], produced))
        try:
            async for item in iterator:
                emitter.emit(item)
        finally:
            aclose = getattr(iterator, "aclose", None)
            if callable(aclose):
                await cast(Any, aclose)()
    elif isinstance(produced, Iterable):
        _drive_sync(cast(Iterable[object], produced), emitter, request)
    else:
        raise TypeError(
            f"schedule must return an iterable or async iterable of analysis configs, not {type(produced).__name__}"
        )
