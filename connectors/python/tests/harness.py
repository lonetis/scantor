"""A scripted runtime that drives a real connector process over its protocol pipes."""

import fcntl
import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import uuid
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMAS = REPO_ROOT / "schemas"

DEFAULT_LIMITS = {
    "maxLineBytes": 8388608,
    "maxResultBytes": 1048576,
    "maxAnalysisConfigBytes": 65536,
    "maxFileBytes": 1073741824,
    "maxFilesPerAnalysis": 100,
}


def protocol_validator(definition: str) -> Draft202012Validator:
    """Validator for `message.schema.json#/$defs/<definition>` with every protocol schema registered."""
    from referencing import Registry, Resource

    resources: list[tuple[str, Resource[Any]]] = []
    for path in sorted((SCHEMAS / "protocol").glob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        resources.append((schema["$id"], Resource.from_contents(schema)))
    registry: Registry[Any] = Registry().with_resources(resources)
    root = {"$ref": f"https://scantor.dev/schemas/protocol/message.schema.json#/$defs/{definition}"}
    return Draft202012Validator(root, registry=registry)


CONNECTOR_TO_RUNTIME = protocol_validator("connectorToRuntime")


# Runs in the child: protocol pipes onto fds 3 and 4, then exec (the pid stays the connector's pid).
_LAUNCHER = """
import os, sys
in_fd, out_fd = int(sys.argv[1]), int(sys.argv[2])
os.dup2(in_fd, 3)
os.dup2(out_fd, 4)
os.close(in_fd)
os.close(out_fd)
os.execvp(sys.argv[3], sys.argv[3:])
"""


class ProtocolTimeoutError(AssertionError):
    pass


class FakeRuntime:
    """Spawns `python -m scantor.serve <entry>` with fds 3 and 4 and plays the runtime's side."""

    def __init__(
        self,
        entry: str | Path,
        *,
        cwd: Path,
        protocol_fds: bool = True,
        env: Mapping[str, str] | None = None,
        command: list[str] | None = None,
    ) -> None:
        self.cwd = cwd
        self.lines: list[bytes] = []
        self.violations: list[str] = []
        self._messages: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._reading = threading.Event()
        self._reading.set()
        child_env = {**os.environ, **(env or {}), "PYTHONUNBUFFERED": "1"}
        argv = command or [sys.executable, "-m", "scantor.serve", str(entry)]
        if protocol_fds:
            to_connector_r, to_connector_w = os.pipe()
            from_connector_r, from_connector_w = os.pipe()
            # Move the child's ends above 100, so the launcher can place them at exactly 3 and 4 (as
            # the runtime does) without clobbering them, and then exec the connector in place.
            in_fd = fcntl.fcntl(to_connector_r, fcntl.F_DUPFD, 100)
            out_fd = fcntl.fcntl(from_connector_w, fcntl.F_DUPFD, 100)
            os.close(to_connector_r)
            os.close(from_connector_w)
            self.process = subprocess.Popen(
                [sys.executable, "-c", _LAUNCHER, str(in_fd), str(out_fd), *argv],
                cwd=cwd,
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                pass_fds=(in_fd, out_fd),
                start_new_session=True,
            )
            os.close(in_fd)
            os.close(out_fd)
            self._to_connector: int | None = to_connector_w
            self._from_connector = os.fdopen(from_connector_r, "rb")
            threading.Thread(target=self._read_protocol, daemon=True).start()
        else:
            self.process = subprocess.Popen(
                argv,
                cwd=cwd,
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            self._to_connector = None
        self.stdout = _Collector(self.process.stdout)
        self.stderr = _Collector(self.process.stderr)

    # Protocol output ------------------------------------------------------------------------------

    def _read_protocol(self) -> None:
        try:
            while True:
                self._reading.wait()
                line = self._from_connector.readline()
                if not line:
                    break
                self.lines.append(line)
                self._check_line(line)
                self._messages.put(json.loads(line))
        finally:
            self._messages.put(None)

    def _check_line(self, line: bytes) -> None:
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError:
            self.violations.append(f"not UTF-8: {line[:200]!r}")
            return
        if not text.endswith("\n") or "\n" in text[:-1] or len(line) > DEFAULT_LIMITS["maxLineBytes"]:
            self.violations.append(f"bad framing: {text[:200]!r}")
        try:
            CONNECTOR_TO_RUNTIME.validate(json.loads(text))
        except (ValueError, ValidationError) as exc:
            self.violations.append(f"{exc}: {text[:300]}")

    def pause_reading(self) -> None:
        self._reading.clear()

    def resume_reading(self) -> None:
        self._reading.set()

    def recv(self, timeout: float = 15.0) -> dict[str, Any]:
        try:
            message = self._messages.get(timeout=timeout)
        except queue.Empty:
            raise ProtocolTimeoutError(f"no message within {timeout} s; stderr: {self.stderr.text()}") from None
        if message is None:
            self._messages.put(None)
            raise ProtocolTimeoutError(f"connector closed fd 4; stderr: {self.stderr.text()}")
        return message

    def recv_type(self, *types: str, timeout: float = 15.0) -> dict[str, Any]:
        """The next message, which must have one of `types`."""
        message = self.recv(timeout)
        assert message["type"] in types, f"expected {types}, got {message}"
        return message

    def until(self, *types: str, timeout: float = 15.0) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Messages up to (excluding) the first one of `types`, and that message."""
        seen: list[dict[str, Any]] = []
        while True:
            message = self.recv(timeout)
            if message["type"] in types:
                return seen, message
            seen.append(message)

    def closed_without_messages(self, timeout: float = 5.0) -> bool:
        try:
            return self._messages.get(timeout=timeout) is None
        except queue.Empty:
            return False

    # Requests -------------------------------------------------------------------------------------

    def send(self, message: Mapping[str, Any]) -> None:
        assert self._to_connector is not None
        os.write(self._to_connector, (json.dumps(message) + "\n").encode())

    def close_input(self) -> None:
        if self._to_connector is not None:
            os.close(self._to_connector)
            self._to_connector = None

    def handshake(self, limits: Mapping[str, int] | None = None, **extra: Any) -> dict[str, Any]:
        hello = self.recv_type("hello")
        self.send(
            {
                "type": "welcome",
                "id": "hello",
                "protocolVersion": 1,
                "mode": "local",
                "runtime": {"version": "test"},
                "limits": dict(limits or DEFAULT_LIMITS),
                "cancelGraceMs": 5000,
                **extra,
            }
        )
        self.recv_type("ready")
        return hello

    def run(
        self,
        request_id: str,
        ctx: Mapping[str, Any],
        analysis_config: Mapping[str, Any] | None = None,
        task_config: Mapping[str, Any] | None = None,
        **extra: Any,
    ) -> None:
        self.send(
            {
                "type": "run",
                "id": request_id,
                "ctx": dict(ctx),
                "analysisConfig": dict(analysis_config or {}),
                "taskConfig": dict(task_config or {}),
                **extra,
            }
        )

    def schedule(
        self,
        request_id: str,
        ctx: Mapping[str, Any],
        scan_config: Mapping[str, Any] | None = None,
        task_config: Mapping[str, Any] | None = None,
    ) -> None:
        self.send(
            {
                "type": "schedule",
                "id": request_id,
                "ctx": dict(ctx),
                "scanConfig": dict(scan_config or {}),
                "taskConfig": dict(task_config or {}),
            }
        )

    def answer_file(self, message: Mapping[str, Any]) -> dict[str, Any]:
        """Reply to a `file` request like the runtime: hash the file and return its FileRef."""
        content = Path(message["path"]).read_bytes()
        file_ref = {
            "id": str(uuid.uuid4()),
            "name": message["name"],
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "contentType": message["contentType"] or "application/octet-stream",
        }
        self.send({"type": "fileRef", "id": message["id"], "fileRef": file_ref})
        return file_ref

    def serve_template(
        self,
        items: Iterator[dict[str, Any]] | list[dict[str, Any]],
        *,
        error: Mapping[str, Any] | None = None,
        timeout: float = 30.0,
    ) -> TemplateTranscript:
        """Play the runtime for one wrapped template call until the schedule ends."""
        transcript = TemplateTranscript()
        source = iter(items)
        request: dict[str, Any] | None = None
        allowance = 0
        sent = 0
        finished = False
        exhausted = False
        while True:
            message = self.recv(timeout)
            kind = message["type"]
            if kind == "template":
                request = message
                transcript.request = message
                if error is not None:
                    self.send({"type": "error", "id": message["id"], "error": dict(error)})
                    finished = True
                    continue
                allowance = message["credit"]
            elif kind == "templateCredit":
                assert request is not None
                assert message["id"] == request["id"]
                allowance += message["credit"]
                transcript.credits.append(message["credit"])
            elif kind == "templateCancel":
                assert request is not None
                transcript.cancelled = True
                self.send({"type": "templateDone", "id": request["id"], "count": sent})
                finished = True
            elif kind == "analysis":
                transcript.analyses.append(message["config"])
            elif kind in ("done", "error"):
                transcript.end = message
                return transcript
            else:
                transcript.other.append(message)
            if request is not None and not finished:
                while sent < allowance and not exhausted:
                    try:
                        item = next(source)
                    except StopIteration:
                        exhausted = True
                        break
                    self.send({"type": "templateItem", "id": request["id"], "config": item})
                    sent += 1
                    transcript.max_outstanding = max(transcript.max_outstanding, sent - len(transcript.analyses))
                if exhausted:
                    self.send({"type": "templateDone", "id": request["id"], "count": sent})
                    finished = True
                transcript.sent = sent

    # Lifecycle ------------------------------------------------------------------------------------

    def wait(self, timeout: float = 10.0) -> int:
        return self.process.wait(timeout)

    def kill(self) -> None:
        if self.process.poll() is None:
            os.killpg(self.process.pid, 9)
            self.process.wait(5)

    def shutdown(self, timeout: float = 5.0) -> int:
        self.send({"type": "shutdown", "id": "x1", "graceMs": 5000})
        return self.wait(timeout)


class TemplateTranscript:
    def __init__(self) -> None:
        self.request: dict[str, Any] | None = None
        self.credits: list[int] = []
        self.analyses: list[dict[str, Any]] = []
        self.cancelled = False
        self.sent = 0
        self.max_outstanding = 0
        self.end: dict[str, Any] = {}
        self.other: list[dict[str, Any]] = []


class _Collector:
    """Collects a child output pipe in the background."""

    def __init__(self, stream: Any) -> None:
        self._chunks: list[bytes] = []
        self._lock = threading.Lock()
        threading.Thread(target=self._pump, args=(stream,), daemon=True).start()

    def _pump(self, stream: Any) -> None:
        for chunk in iter(lambda: stream.read1(65536), b""):
            with self._lock:
                self._chunks.append(chunk)

    def text(self) -> str:
        with self._lock:
            return b"".join(self._chunks).decode("utf-8", errors="replace")


def make_ctx(
    root: Path,
    *,
    request_id: str,
    kind: str = "run",
    seq: int = 0,
    attempt: int = 1,
    deadline_ms: int | None = None,
) -> dict[str, Any]:
    """A protocol ctx object with fresh tmp and files directories under `root`."""
    execution_id = str(uuid.uuid4())
    base = root / f"x-{execution_id}"
    (base / "tmp").mkdir(parents=True)
    if kind == "run":
        (base / "files").mkdir()
        return {
            "scanId": "scan-1",
            "analysisId": f"scan-1-{seq}",
            "seq": seq,
            "round": 1,
            "attempt": attempt,
            "executionId": execution_id,
            "deadlineMs": deadline_ms,
            "tmpDir": str(base / "tmp"),
            "filesDir": str(base / "files"),
        }
    return {
        "scanId": "scan-1",
        "analysisId": None,
        "seq": None,
        "round": None,
        "attempt": attempt,
        "executionId": None,
        "deadlineMs": deadline_ms,
        "tmpDir": str(base / "tmp"),
        "filesDir": None,
    }
