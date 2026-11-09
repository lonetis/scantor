"""`python -m scantor.script <entry>` (SCANTOR_SCRIPT_CMD): one script run.

Import the entry → bootstrap → describe (the config and result JSON Schemas) → validate the config →
`run(ctx, config)` → serialise the result → flush progress and checkpoint → finish. A failure is
reported through `finish` as an error; the exit code is 0 for success, 1 for a failure and 143 after a
cancellation (SIGTERM).
"""

import asyncio
import inspect
import os
import sys
from collections.abc import Mapping
from typing import Any

import pydantic

from scantor._entry import load_entry
from scantor._json import (
    MAX_ERROR_MESSAGE,
    ModelCodec,
    NotJsonError,
    describe_exception,
    format_stack,
    truncate,
    validation_error,
)
from scantor.script._context import ScriptContext
from scantor.script._definition import SCRIPT_DEFINITION, Script
from scantor.script._errors import Cancelled, CancelState, ScriptError
from scantor.script._http import ClientConfig, HttpClient
from scantor.script._map import EntryInfo, MapEnvironment
from scantor.script._models import Bootstrap, FileAccess, set_process_file_access
from scantor.script._report import Reporter, encode_json, fit_text
from scantor.script._stream import warn

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_CANCELLED = 143
_MAX_FINISH_MESSAGE = 16384
_MAX_FINISH_STACK = 65536


class _ReportedError(Exception):
    """A failure of the script, reported through `finish` (`type` validation or scriptError)."""

    def __init__(self, error: dict[str, Any]) -> None:
        super().__init__(error["message"])
        self.error = error


def main(argv: list[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python -m scantor.script <entry>", file=sys.stderr)
        return EXIT_USAGE
    try:
        config = ClientConfig.from_environment(os.environ if environ is None else environ)
    except ScriptError as exc:
        print(f"scantor: {exc.message}", file=sys.stderr)
        return EXIT_USAGE
    cancel = CancelState()
    cancel.install_signal_handlers()
    client = HttpClient(config)
    return Runner(client, cancel).run(args[0])


class Runner:
    def __init__(self, client: HttpClient, cancel: CancelState) -> None:
        self.client = client
        self.cancel = cancel
        self.reporter: Reporter | None = None
        self.map_environment: MapEnvironment | None = None

    def run(self, entry: str) -> int:
        try:
            result = self._run(entry)
        except Cancelled as exc:
            self._end()
            self._finish({"error": {"type": "scriptError", "message": str(exc) or "cancelled"}}, quiet=True)
            return EXIT_CANCELLED
        except _ReportedError as exc:
            self._end()
            self._report_failure(exc.error)
            return EXIT_FAILED
        except (Exception, SystemExit) as exc:
            message = describe_exception(exc)
            if isinstance(exc, SystemExit):
                message = f"the script called sys.exit({exc.code!r}); return from run to end it"
            self._end()
            self._report_failure({"type": "scriptError", "message": message, "stack": format_stack(exc)})
            return EXIT_FAILED
        self._end()
        if not self._finish(raw=b'{"result":' + result + b"}"):
            return EXIT_FAILED
        return EXIT_OK

    def _run(self, entry: str) -> bytes:
        """Run the script; the result as JSON."""
        loaded = load_entry(entry, SCRIPT_DEFINITION)
        if isinstance(loaded, dict):
            raise _ReportedError(loaded)
        script: Script[Any, Any] = loaded.definition
        bootstrap = Bootstrap.model_validate(self.client.call("GET", "/bootstrap"))
        self.client.set_file_origin(bootstrap.s3_origin)
        access = FileAccess(self.client)
        set_process_file_access(access)
        self._describe(script)
        config = self._config(script, bootstrap)
        limits = bootstrap.limits
        self.reporter = Reporter(
            self.client,
            max_checkpoint_bytes=limits.max_checkpoint_bytes,
            progress_interval=limits.progress_interval_ms / 1000,
            checkpoint_interval=limits.checkpoint_interval_ms / 1000,
        )
        self.map_environment = MapEnvironment(
            cancel=self.cancel, client=self.client, entry=EntryInfo(str(loaded.path), loaded.module_name)
        )
        ctx = ScriptContext(
            bootstrap=bootstrap,
            client=self.client,
            access=access,
            cancel=self.cancel,
            reporter=self.reporter,
            map_environment=self.map_environment,
        )
        for scan in ctx.scans:
            if scan.state not in {"completed", "failed", "cancelled"}:
                warn(f"scan {scan.name!r} is {scan.state}: the run reads its analyses as they are now")
        value = self._call(script, ctx, config)
        return self._serialise(script, value, bootstrap.limits.max_result_bytes)

    def _describe(self, script: Script[Any, Any]) -> None:
        try:
            body = {
                "configSchema": script.config.model_json_schema(mode="validation"),
                "resultSchema": script.result.model_json_schema(mode="serialization") if script.result else None,
            }
        except (pydantic.PydanticUserError, TypeError, ValueError) as exc:
            raise _ReportedError(
                {"type": "validation", "message": f"cannot export the JSON Schemas: {describe_exception(exc)}"}
            ) from exc
        try:
            self.client.call("POST", "/describe", body)
        except ScriptError as exc:
            warn(f"could not store the config and result schemas (the run form uses them): {exc.message}")

    def _config(self, script: Script[Any, Any], bootstrap: Bootstrap) -> Any:
        try:
            return ModelCodec.of(script.config).validate_json_value(bootstrap.script_run.config)
        except pydantic.ValidationError as exc:
            raise _ReportedError(validation_error("the script config", exc)) from exc

    def _call(self, script: Script[Any, Any], ctx: ScriptContext, config: Any) -> Any:
        value = script.run(ctx, config)
        if not inspect.isawaitable(value):
            return value
        return asyncio.run(self._await(value))

    async def _await(self, awaitable: Any) -> Any:
        task = asyncio.ensure_future(awaitable)
        loop = asyncio.get_running_loop()

        def cancel_task() -> None:
            loop.call_soon_threadsafe(task.cancel)

        self.cancel.on_cancel(cancel_task)
        try:
            return await task
        except asyncio.CancelledError:
            if self.cancel.cancelled:
                raise Cancelled(f"cancelled: {self.cancel.reason}") from None
            raise

    def _serialise(self, script: Script[Any, Any], value: Any, max_bytes: int) -> bytes:
        try:
            if script.result is not None:
                codec = ModelCodec.of(script.result)
                data: Any = codec.to_json_object(codec.validate_python(value))
            else:
                data = value.model_dump(mode="json") if isinstance(value, pydantic.BaseModel) else value
            encoded = encode_json(data, "the result")
        except pydantic.ValidationError as exc:
            raise _ReportedError(validation_error("the result", exc)) from exc
        except (NotJsonError, TypeError, ValueError) as exc:
            raise _ReportedError(
                {"type": "validation", "message": truncate(f"the result: {exc}", MAX_ERROR_MESSAGE)}
            ) from exc
        if len(encoded) > max_bytes:
            message = f"the result is {len(encoded)} bytes of JSON; the limit is {max_bytes}"
            raise _ReportedError({"type": "validation", "message": message})
        return encoded

    def _end(self) -> None:
        """Stop parallel work and flush progress and checkpoint (they matter most for a failed run)."""
        if self.map_environment is not None:
            for open_map in list(self.map_environment.open_maps):
                open_map.close()
        if self.reporter is not None:
            self.reporter.flush()

    def _report_failure(self, error: dict[str, Any]) -> None:
        print(f"scantor: the script failed: {error['message']}", file=sys.stderr, flush=True)
        if error.get("stack"):
            print(error["stack"], file=sys.stderr, flush=True)
        self._finish({"error": _finish_error(error)})

    def _finish(self, body: dict[str, Any] | None = None, *, raw: bytes | None = None, quiet: bool = False) -> bool:
        try:
            self.client.call("POST", "/finish", body, raw=raw)
        except ScriptError as exc:
            if not quiet:
                warn(f"could not report the end of the run: {exc.message}")
            return False
        return True


def _finish_error(error: Mapping[str, Any]) -> dict[str, Any]:
    """The `finish` error of a protocol-style error object (only `validation` keeps its type)."""
    reported: dict[str, Any] = {
        "type": "validation" if error.get("type") == "validation" else "scriptError",
        "message": fit_text(str(error.get("message", "")), _MAX_FINISH_MESSAGE),
    }
    details = error.get("details")
    issues = details.get("issues") if isinstance(details, Mapping) else None
    if isinstance(issues, list) and issues:
        lines = [
            f"{issue.get('path') or '/'}: {issue.get('message')}" for issue in issues if isinstance(issue, Mapping)
        ]
        reported["message"] = fit_text(reported["message"] + "\n" + "\n".join(lines), _MAX_FINISH_MESSAGE)
    stack = error.get("stack")
    if isinstance(stack, str) and stack:
        reported["stack"] = fit_text(stack, _MAX_FINISH_STACK, keep_end=True)
    return reported
