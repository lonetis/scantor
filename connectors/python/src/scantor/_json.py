"""JSON helpers shared by the protocol layer: model serialisation, validation issues and truncation."""

import json
import math
import threading
import traceback
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, cast

import pydantic
import pydantic_core

_PACKAGE_DIR = str(Path(__file__).resolve().parent)

MAX_ERROR_MESSAGE = 4096
MAX_STACK = 16384
MAX_ISSUES = 20
MAX_ISSUE_MESSAGE = 300


class NotJsonError(ValueError):
    """A value cannot be represented in JSON (NaN, infinity, bytes, a non-string key, a non-object root, ...).

    `path` is the JSON pointer of the offending value when it is known.
    """

    def __init__(self, message: str, path: str | None = None) -> None:
        super().__init__(message)
        self.path = path


def encode_line(message: Mapping[str, Any]) -> bytes:
    """Encode one protocol message as a single NDJSON line (UTF-8, terminated by a newline)."""
    try:
        text = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        return text.encode("utf-8") + b"\n"
    except UnicodeEncodeError:
        # Lone surrogates (e.g. from surrogateescape-decoded bytes) cannot be UTF-8 encoded; escaping
        # them keeps the line valid UTF-8 and the receiver replaces them with U+FFFD.
        text = json.dumps(message, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
        return text.encode("ascii") + b"\n"


def check_json(value: object) -> None:
    """Raise `NotJsonError` when `value` is not representable as strict JSON."""
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise NotJsonError(str(exc)) from exc


class ModelCodec:
    """Validates values with a model type and serialises them in JSON (output) mode.

    Secrets (`SecretStr`, `SecretBytes`) are serialised in plaintext: values travel to the platform,
    which masks `writeOnly` paths in every response. pydantic itself masks them in JSON mode.
    """

    _cache: dict[object, ModelCodec] = {}
    _cache_lock = threading.Lock()

    def __init__(self, model: type[pydantic.BaseModel]) -> None:
        self.model = model
        self.adapter: pydantic.TypeAdapter[Any] = pydantic.TypeAdapter(model)
        self._has_secrets: bool | None = None

    @classmethod
    def of(cls, model: type[pydantic.BaseModel]) -> ModelCodec:
        with cls._cache_lock:
            codec = cls._cache.get(model)
            if codec is None:
                codec = cls(model)
                cls._cache[model] = codec
            return codec

    def validate_json_value(self, value: object) -> Any:
        """Validate a value decoded from protocol JSON (JSON-mode validation of its re-encoding)."""
        return self.adapter.validate_json(json.dumps(value, separators=(",", ":")))

    def validate_python(self, value: object) -> Any:
        """Validate a value produced by task code (a model instance or a plain dict).

        An instance of another model (for example a template's item yielded as is) is validated by
        its fields, like a dict.
        """
        if isinstance(value, pydantic.BaseModel) and not isinstance(value, self.model):
            value = value.model_dump(mode="python", by_alias=True)
        return self.adapter.validate_python(value)

    def to_json_object(self, value: object) -> dict[str, Any]:
        """Serialise a validated value to a JSON object; raises `NotJsonError` when impossible.

        JSON mode would turn bytes and non-string keys into strings and NaN in untyped fields into null;
        the Python-mode dump is checked first, so such values fail deterministically instead
        (docs/protocol.md §5.5).
        """
        try:
            raw = self.adapter.dump_python(value, mode="python", by_alias=True, warnings="error")
            check_representable(raw)
            data = self.adapter.dump_python(value, mode="json", by_alias=True, warnings="error")
            if self.has_secrets():
                data = _reveal_secrets(data, raw)
        except (pydantic_core.PydanticSerializationError, UnicodeError) as exc:
            raise NotJsonError(str(exc)) from exc
        if not isinstance(data, dict):
            raise NotJsonError(f"{self.model.__name__} must serialise to a JSON object")
        check_json(data)
        return cast(dict[str, Any], data)

    def has_secrets(self) -> bool:
        if self._has_secrets is None:
            try:
                schema = self.adapter.json_schema(mode="serialization")
                self._has_secrets = '"writeOnly": true' in json.dumps(schema)
            except pydantic.PydanticUserError:
                self._has_secrets = True
        return self._has_secrets


def check_representable(value: object) -> None:
    """Raise `NotJsonError` for binary data, a non-string mapping key or a non-finite float in `value`.

    `value` is a Python-mode dump: models are dicts, while bytes, keys and floats are still the task's own
    values. Secrets are skipped; they are revealed as text.
    """
    stack: list[tuple[object, tuple[int | str, ...]]] = [(value, ())]
    while stack:
        item, location = stack.pop()
        if isinstance(item, pydantic.SecretStr | pydantic.SecretBytes):
            continue
        if isinstance(item, bytes | bytearray | memoryview):
            raise _unrepresentable("binary data", location, "; store it with ctx.files or encode it as text")
        if isinstance(item, float) and not math.isfinite(item):
            raise _unrepresentable(f"the float {item}", location)
        children: list[tuple[object, tuple[int | str, ...]]] = []
        if isinstance(item, Mapping):
            for key, child in cast(Mapping[object, object], item).items():
                if not isinstance(key, str):
                    raise _unrepresentable(f"the non-string key {key!r}", location)
                children.append((child, (*location, key)))
        elif isinstance(item, list | tuple | set | frozenset):
            children = [(child, (*location, index)) for index, child in enumerate(cast(Iterable[object], item))]
        stack.extend(reversed(children))


def _unrepresentable(what: str, location: tuple[int | str, ...], hint: str = "") -> NotJsonError:
    path = json_pointer(location)
    return NotJsonError(f"{what} at {path or '/'}{hint}", path)


def not_json_error(subject: str, error: NotJsonError) -> dict[str, Any]:
    """Protocol error object for a config or result that JSON cannot represent."""
    payload: dict[str, Any] = {
        "type": "validation",
        "message": truncate(f"{subject} is not representable in JSON: {error}", MAX_ERROR_MESSAGE),
    }
    if error.path is not None:
        payload["details"] = {"issues": [{"path": error.path, "message": truncate(str(error), MAX_ISSUE_MESSAGE)}]}
    return payload


def _reveal_secrets(data: object, raw: object) -> object:
    if isinstance(raw, pydantic.SecretStr):
        return raw.get_secret_value()
    if isinstance(raw, pydantic.SecretBytes):
        return raw.get_secret_value().decode("utf-8", errors="replace")
    if isinstance(data, dict) and isinstance(raw, Mapping):
        data_map = cast(dict[str, object], data)
        raw_map = cast(Mapping[str, object], raw)
        return {key: _reveal_secrets(item, raw_map.get(key)) for key, item in data_map.items()}
    if isinstance(data, list) and isinstance(raw, Sequence) and not isinstance(raw, str | bytes):
        data_list = cast(list[object], data)
        raw_seq = cast(Sequence[object], raw)
        if len(data_list) == len(raw_seq):
            return [_reveal_secrets(item, raw_seq[i]) for i, item in enumerate(data_list)]
    return data


def json_pointer(location: Sequence[int | str]) -> str:
    """RFC 6901 pointer of a pydantic error location."""
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in location)


def validation_issues(error: pydantic.ValidationError) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    for item in error.errors(include_url=False, include_input=False)[:MAX_ISSUES]:
        issues.append({"path": json_pointer(item["loc"]), "message": truncate(item["msg"], MAX_ISSUE_MESSAGE)})
    return issues


def validation_error(subject: str, error: pydantic.ValidationError) -> dict[str, Any]:
    """Protocol error object for an invalid config or result."""
    count = error.error_count()
    plural = "error" if count == 1 else "errors"
    return {
        "type": "validation",
        "message": truncate(f"{subject} is invalid ({count} {plural})", MAX_ERROR_MESSAGE),
        "details": {"issues": validation_issues(error)},
    }


def truncate(text: str, limit: int) -> str:
    """Keep the start of `text`, at most `limit` characters."""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def truncate_tail(text: str, limit: int) -> str:
    """Keep the end of `text` (stack traces end with the most relevant frame)."""
    return text if len(text) <= limit else "…" + text[len(text) - limit + 1 :]


def format_stack(exc: BaseException) -> str:
    """Format a traceback without the connector's own leading frames."""
    summary = traceback.TracebackException.from_exception(exc)
    frames = list(summary.stack)
    first_user_frame = next(
        (index for index, frame in enumerate(frames) if not frame.filename.startswith(_PACKAGE_DIR)),
        0,
    )
    summary.stack = traceback.StackSummary.from_list(frames[first_user_frame:])
    return truncate_tail("".join(summary.format()), MAX_STACK)


def describe_exception(exc: BaseException) -> str:
    text = str(exc)
    name = type(exc).__name__
    return truncate(f"{name}: {text}" if text else name, MAX_ERROR_MESSAGE)
