"""A loopback script runtime API and file store for the script SDK tests (http.server; works with --network none).

`FakePlatform` serves `/api/script-runtime/*` as docs/scripts.md describes it (run token, NDJSON analysis
streams with checkpoint and end lines, outputs as multipart uploads) and a presigning file store on a
second port. Tests seed scans with analyses and files, inject faults and read what the SDK sent.
"""

import hashlib
import http.server
import json
import re
import threading
import urllib.parse
import uuid
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Any

TOKEN = "ssr_00000000-0000-4000-8000-000000000001.secret"
RUN_ID = "00000000-0000-4000-8000-000000000001"


@dataclass
class FakeScan:
    id: str
    name: str | None
    state: str = "completed"
    analyses: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])
    file_ref_paths: list[str] = field(default_factory=list[str])


@dataclass
class FakeOutput:
    id: str
    name: str
    content_type: str
    state: str = "pending"
    parts: dict[int, bytes] = field(default_factory=dict[int, bytes])
    data: bytes = b""
    sha256: str = ""
    reported_sha256: str = ""


@dataclass
class StreamFaults:
    drop_after: int | None = None
    """close the connection after this many analysis lines (once)"""
    error_after: int | None = None
    """send an error line after this many analysis lines (once)"""
    error_retryable: bool = True
    drop_before_end: bool = False
    """close the connection instead of sending the end line (once)"""
    window: int = 3
    """a checkpoint line after every window of this many seqs"""


Fault = int | tuple[int, str]
"""an injected error answer: a status (code `unavailable`), or a status and an error code"""


class FakePlatform:
    def __init__(self, *, part_bytes: int = 64, max_result_bytes: int = 1024 * 1024, cpus: float = 2) -> None:
        self.lock = threading.Lock()
        self.scans: dict[str, FakeScan] = {}
        self.objects: dict[str, bytes] = {}
        self.expire_once: set[str] = set()
        self.outputs: dict[str, FakeOutput] = {}
        self.config: dict[str, Any] = {}
        self.secrets: dict[str, str] = {}
        self.limit: int | None = None
        self.resume: dict[str, Any] | None = None
        self.part_bytes = part_bytes
        self.max_result_bytes = max_result_bytes
        self.cpus = cpus
        self.faults: dict[str, list[Fault]] = {}
        self.retry_after: str | None = "0"
        """Retry-After of injected API faults (None: the client's own backoff)"""
        self.stream_faults = StreamFaults()
        self.requests: list[tuple[str, str, dict[str, Any] | None]] = []
        self.stream_requests: list[dict[str, Any]] = []
        self.file_requests: list[tuple[str, str, dict[str, str]]] = []
        self.describes: list[dict[str, Any]] = []
        self.progress: list[dict[str, Any]] = []
        self.checkpoints: list[Any] = []
        self.finishes: list[dict[str, Any]] = []
        self.violations: list[str] = []
        self.api = self._server(_ApiHandler)
        self.files = self._server(_FileHandler)

    # ── setup ────────────────────────────────────────────────────────────────────────────────────

    def _server(self, handler: type[http.server.BaseHTTPRequestHandler]) -> http.server.ThreadingHTTPServer:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.daemon_threads = True
        server.platform = self  # type: ignore[attr-defined]
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
        return server

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.api.server_address[1]}"

    @property
    def file_origin(self) -> str:
        return f"http://127.0.0.1:{self.files.server_address[1]}"

    def environment(self) -> dict[str, str]:
        return {"SCANTOR_URL": self.url, "SCANTOR_SCRIPT_TOKEN": TOKEN}

    def close(self) -> None:
        for server in (self.api, self.files):
            server.shutdown()
            server.server_close()

    def add_scan(
        self, name: str | None, *, state: str = "completed", file_ref_paths: list[str] | None = None
    ) -> FakeScan:
        scan = FakeScan(str(uuid.uuid4()), name, state, file_ref_paths=file_ref_paths or [])
        self.scans[scan.id] = scan
        return scan

    def add_analysis(
        self,
        scan: FakeScan,
        *,
        status: str = "succeeded",
        result: Any = None,
        config: dict[str, Any] | None = None,
        files: Mapping[str, bytes] | None = None,
        error: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Add an analysis; `result` may be a function of the FileRefs by name."""
        seq = len(scan.analyses)
        refs: dict[str, dict[str, Any]] = {}
        for name, content in (files or {}).items():
            file_id = str(uuid.uuid4())
            key = f"files/{scan.id}/{seq}/{file_id}/{name}"
            self.objects[key] = content
            refs[name] = {
                "id": file_id,
                "name": name,
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "contentType": "application/octet-stream",
                "key": key,
            }
        analysis: dict[str, Any] = {
            "id": f"{scan.id}-{seq}",
            "scanId": scan.id,
            "seq": seq,
            "status": status,
            "attempt": 1,
            "round": 0,
            "config": config if config is not None else {"item": f"item-{seq}", "index": seq},
            "files": list(refs.values()),
        }
        if status == "succeeded":
            public = {name: {k: v for k, v in ref.items() if k != "key"} for name, ref in refs.items()}
            analysis["result"] = result(public) if callable(result) else result
        if error is not None:
            analysis["error"] = error
        scan.analyses.append(analysis)
        return analysis

    def presign(self, key: str) -> str:
        return f"{self.file_origin}/bucket/{urllib.parse.quote(key)}?X-Amz-Signature=sig-{uuid.uuid4().hex[:8]}"

    def bootstrap(self) -> dict[str, Any]:
        return {
            "scriptRun": {
                "id": RUN_ID,
                "scriptId": "00000000-0000-4000-8000-0000000000aa",
                "scriptName": "test-script",
                "config": self.config,
                "secrets": self.secrets,
                "settings": {
                    "timeoutMs": 3_600_000,
                    "resources": {"cpus": self.cpus, "memoryMiB": 512},
                    "limit": self.limit,
                },
                "cpus": self.cpus,
                "startedAt": "2026-11-08T10:00:00.000Z",
                "deadline": "2099-01-01T00:00:00.000Z",
            },
            "scans": [
                {
                    "id": scan.id,
                    "name": scan.name,
                    "state": scan.state,
                    "task": {"id": "t1", "name": "files"},
                    "revision": {"id": "r1", "number": 3},
                    "createdAt": "2026-11-08T09:00:00.000Z",
                    "completedAt": "2026-11-08T09:30:00.000Z",
                    "maxSeq": len(scan.analyses) - 1 if scan.analyses else None,
                    "counts": self.counts(scan),
                    "schemas": {"analysisConfig": {"type": "object"}, "result": {"type": "object"}},
                    "fileRefPaths": scan.file_ref_paths,
                    "secretPaths": {"analysisConfig": [], "result": []},
                }
                for scan in self.scans.values()
            ],
            "resume": self.resume,
            "limits": {
                "maxResultBytes": self.max_result_bytes,
                "maxCheckpointBytes": 1024 * 1024,
                "maxOutputs": 100,
                "maxOutputBytes": 1 << 30,
                "partBytes": self.part_bytes,
                "fileUrlTtlSeconds": 3600,
                "maxStreams": 4,
                "progressIntervalMs": 1000,
                "checkpointIntervalMs": 10000,
            },
            "s3Origin": self.file_origin,
        }

    @staticmethod
    def counts(scan: FakeScan) -> dict[str, Any]:
        counts: dict[str, Any] = {"total": len(scan.analyses), "hint": False}
        for analysis in scan.analyses:
            counts[analysis["status"]] = counts.get(analysis["status"], 0) + 1
        return counts

    def take_fault(self, key: str) -> tuple[int, str] | None:
        with self.lock:
            queue = self.faults.get(key)
            fault = queue.pop(0) if queue else None
        if fault is None or isinstance(fault, tuple):
            return fault
        return fault, "unavailable"

    def stored_outputs(self) -> dict[str, FakeOutput]:
        return {output.name: output for output in self.outputs.values() if output.state == "stored"}

    def seed_output(self, name: str, data: bytes, content_type: str = "text/plain") -> dict[str, Any]:
        """A stored output of an earlier run (for resume)."""
        output = FakeOutput(str(uuid.uuid4()), name, content_type, "stored", data=data)
        output.sha256 = hashlib.sha256(data).hexdigest()
        self.outputs[output.id] = output
        self.objects[f"outputs/{output.id}"] = data
        return {"id": output.id, "name": name, "size": len(data), "sha256": output.sha256, "contentType": content_type}

    # ── the stream ───────────────────────────────────────────────────────────────────────────────

    def stream_lines(self, scan: FakeScan, body: dict[str, Any]) -> Iterator[bytes | None]:
        """The lines of one stream response; None = drop the connection here."""
        faults = self.stream_faults
        after = body.get("afterSeq", -1)
        until = body.get("untilSeq")
        statuses = body.get("status")
        fields = body.get("fields")
        sent = 0
        last = after
        for analysis in scan.analyses:
            seq = analysis["seq"]
            if seq <= after or (until is not None and seq > until):
                continue
            if statuses is None or analysis["status"] in statuses:
                if self.limit is not None and sent >= self.limit:
                    yield _line({"end": {"afterSeq": last, "count": sent, "limited": True}})
                    return
                if faults.drop_after is not None and sent == faults.drop_after:
                    faults.drop_after = None
                    yield None
                    return
                if faults.error_after is not None and sent == faults.error_after:
                    faults.error_after = None
                    yield _line(
                        {"error": {"code": "cursorLost", "message": "cursor lost", "retryable": faults.error_retryable}}
                    )
                    return
                yield _line(self.analysis_line(analysis, fields, body.get("fileUrls", True)))
                sent += 1
            last = seq
            if (seq + 1) % faults.window == 0:
                yield _line({"checkpoint": {"afterSeq": seq}})
        if faults.drop_before_end:
            faults.drop_before_end = False
            yield None
            return
        final = max(last, len(scan.analyses) - 1 if until is None else min(until, len(scan.analyses) - 1))
        yield _line({"end": {"afterSeq": final, "count": sent, "limited": False}})

    def analysis_line(self, analysis: dict[str, Any], fields: Any, file_urls: bool) -> dict[str, Any]:
        public = {key: value for key, value in analysis.items() if key not in {"files", "scanId"}}
        public["files"] = [{k: v for k, v in ref.items() if k != "key"} for ref in analysis["files"]]
        if isinstance(fields, list):
            public = {key: public[key] for key in fields if key in public}
        line: dict[str, Any] = {"analysis": public}
        if file_urls and analysis["files"]:
            line["urls"] = {ref["id"]: self.presign(ref["key"]) for ref in analysis["files"]}
        return line

    def find_file(self, analysis_id: str, file_id: str) -> dict[str, Any] | None:
        scan_id, _, seq = analysis_id.rpartition("-")
        scan = self.scans.get(scan_id)
        if scan is None or not seq.isdigit() or int(seq) >= len(scan.analyses):
            return None
        return next((ref for ref in scan.analyses[int(seq)]["files"] if ref["id"] == file_id), None)


def _line(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode() + b"\n"


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True  # headers and body are separate writes; no delayed-ACK stalls

    @property
    def platform(self) -> FakePlatform:
        return self.server.platform  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - signature of the base class
        pass

    def body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def reply(self, status: int, value: Any = None, headers: Mapping[str, str] | None = None) -> None:
        data = b"" if value is None else json.dumps(value).encode()
        self.send_response(status)
        for key, header in (headers or {}).items():
            self.send_header(key, header)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def error(self, status: int, code: str, message: str) -> None:
        self.reply(status, {"error": {"code": code, "message": message}})


_ANALYSES = re.compile(r"^/scans/([^/]+)/analyses$")
_AGGREGATE = re.compile(r"^/scans/([^/]+)/aggregate$")
_FILE_URL = re.compile(r"^/analyses/([^/]+)/files/([^/]+)$")
_OUTPUT = re.compile(r"^/outputs/([^/]+)$")
_OUTPUT_PARTS = re.compile(r"^/outputs/([^/]+)/parts$")
_OUTPUT_COMPLETE = re.compile(r"^/outputs/([^/]+)/complete$")


class _ApiHandler(_Handler):
    def do_GET(self) -> None:
        self.handle_api("GET")

    def do_POST(self) -> None:
        self.handle_api("POST")

    def do_PUT(self) -> None:
        self.handle_api("PUT")

    def handle_api(self, method: str) -> None:
        platform = self.platform
        raw = self.body()
        prefix = "/api/script-runtime"
        if not self.path.startswith(prefix):
            self.error(404, "notFound", "no such operation")
            return
        path = self.path[len(prefix) :]
        body: Any = json.loads(raw) if raw else None
        with platform.lock:
            platform.requests.append((method, path, body))
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.error(401, "unauthorized", "missing or invalid credential")
            return
        fault = platform.take_fault(f"{method} {path}")
        if fault is not None:
            status, code = fault
            headers = {} if platform.retry_after is None else {"Retry-After": platform.retry_after}
            self.reply(status, {"error": {"code": code, "message": f"injected {code}"}}, headers)
            return
        self.route(method, path, body)

    def route(self, method: str, path: str, body: Any) -> None:
        platform = self.platform
        if (method, path) == ("GET", "/bootstrap"):
            self.reply(200, platform.bootstrap())
        elif (method, path) == ("POST", "/describe"):
            platform.describes.append(body)
            self.reply(204)
        elif (method, path) == ("POST", "/progress"):
            platform.progress.append(body)
            self.reply(200, {"state": "running"})
        elif (method, path) == ("PUT", "/checkpoint"):
            platform.checkpoints.append(body["state"])
            self.reply(200, {"savedAt": "2026-11-08T10:00:00.000Z"})
        elif (method, path) == ("POST", "/finish"):
            platform.finishes.append(body)
            self.reply(204)
        elif (method, path) == ("POST", "/outputs"):
            self.create_output(body)
        elif match := _ANALYSES.match(path):
            self.stream(match[1], body)
        elif match := _AGGREGATE.match(path):
            self.aggregate(match[1], body)
        elif match := _FILE_URL.match(path):
            ref = platform.find_file(match[1], match[2])
            if ref is None:
                self.error(404, "notFound", "file not found")
            else:
                self.reply(200, {"url": platform.presign(ref["key"]), "expiresAt": "2099-01-01T00:00:00Z"})
        elif match := _OUTPUT_PARTS.match(path):
            self.presign_part(match[1], body)
        elif match := _OUTPUT_COMPLETE.match(path):
            self.complete_output(match[1], body)
        elif (match := _OUTPUT.match(path)) and method == "GET":
            output = platform.outputs.get(match[1])
            if output is None or output.state != "stored":
                self.error(404, "notFound", "output not found")
            else:
                self.reply(200, {"url": platform.presign(f"outputs/{output.id}"), "expiresAt": "2099-01-01T00:00:00Z"})
        else:
            self.error(404, "notFound", f"no operation {method} {path}")

    def stream(self, scan_id: str, body: dict[str, Any]) -> None:
        platform = self.platform
        scan = platform.scans.get(scan_id)
        if scan is None:
            self.error(404, "notFound", "scan not found")
            return
        platform.stream_requests.append(body)
        if body.get("untilSeq") is not None and body["untilSeq"] <= body.get("afterSeq", -1):
            self.error(400, "validationFailed", "untilSeq must be greater than afterSeq")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            for line in platform.stream_lines(scan, body):
                if line is None:
                    self.wfile.flush()
                    self.connection.shutdown(2)
                    return
                self.wfile.write(line)
            self.wfile.flush()
        except BrokenPipeError, ConnectionResetError:
            return  # the client closed the stream early (it stops or was cancelled)

    def aggregate(self, scan_id: str, body: dict[str, Any]) -> None:
        scan = self.platform.scans[scan_id]
        analyses = scan.analyses
        for stage in body["pipeline"]:
            if "$match" in stage:
                allowed = stage["$match"]["status"]["$in"]
                analyses = [analysis for analysis in analyses if analysis["status"] in allowed]
        groups: dict[str, int] = {}
        for analysis in analyses:
            groups[analysis["status"]] = groups.get(analysis["status"], 0) + 1
        self.reply(200, {"items": [{"_id": key, "n": n} for key, n in groups.items()], "truncated": False})

    def create_output(self, body: dict[str, Any]) -> None:
        platform = self.platform
        with platform.lock:
            for output in platform.outputs.values():
                if output.name == body["name"]:
                    if output.state == "stored":
                        self.error(409, "alreadyExists", f"output {body['name']} exists")
                        return
                    if output.content_type == body.get("contentType"):
                        self.reply(
                            201, {"output": {"id": output.id, "name": output.name}, "partBytes": platform.part_bytes}
                        )
                        return
            output = FakeOutput(str(uuid.uuid4()), body["name"], body.get("contentType", "application/octet-stream"))
            platform.outputs[output.id] = output
        reply = {"id": output.id, "name": output.name, "contentType": output.content_type}
        self.reply(201, {"output": reply, "partBytes": platform.part_bytes})

    def presign_part(self, output_id: str, body: dict[str, Any]) -> None:
        platform = self.platform
        key = f"parts/{output_id}/{body['partNumber']}"
        url = f"{platform.file_origin}/bucket/{key}?size={body['size']}&X-Amz-Signature=sig"
        self.reply(
            200, {"url": url, "method": "PUT", "headers": {"x-amz-test": "signed"}, "expiresAt": "2099-01-01T00:00:00Z"}
        )

    def complete_output(self, output_id: str, body: dict[str, Any]) -> None:
        platform = self.platform
        output = platform.outputs[output_id]
        numbers = [part["partNumber"] for part in body["parts"]]
        if numbers != list(range(1, len(numbers) + 1)):
            platform.violations.append(f"parts of {output.name} are not 1..n: {numbers}")
        for part in body["parts"]:
            if part["etag"] != f'"etag-{output_id}-{part["partNumber"]}"':
                platform.violations.append(f"wrong etag for part {part['partNumber']} of {output.name}")
        output.data = b"".join(platform.objects.pop(f"parts/{output_id}/{n}", b"") for n in numbers)
        output.sha256 = hashlib.sha256(output.data).hexdigest()
        output.reported_sha256 = body["sha256"]
        output.name = body.get("name", output.name)
        output.state = "stored"
        platform.objects[f"outputs/{output.id}"] = output.data
        reply = {"id": output.id, "name": output.name, "size": len(output.data), "sha256": body["sha256"]}
        self.reply(200, {"output": {**reply, "contentType": output.content_type, "createdAt": "2026-11-08T10:00:00Z"}})


class _FileHandler(_Handler):
    def do_GET(self) -> None:
        platform = self.platform
        url = urllib.parse.urlsplit(self.path)
        key = urllib.parse.unquote(url.path.removeprefix("/bucket/"))
        platform.file_requests.append(("GET", key, dict(self.headers)))
        if self.headers.get("Authorization"):
            platform.violations.append(f"the run token was sent to the file store for {key}")
        if key in platform.expire_once:
            platform.expire_once.discard(key)
            self.send_error_body(403)
            return
        data = platform.objects.get(key)
        if data is None:
            self.send_error_body(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self) -> None:
        platform = self.platform
        url = urllib.parse.urlsplit(self.path)
        key = urllib.parse.unquote(url.path.removeprefix("/bucket/"))
        data = self.body()
        platform.file_requests.append(("PUT", key, dict(self.headers)))
        size = urllib.parse.parse_qs(url.query).get("size", ["-1"])[0]
        if str(len(data)) != size or self.headers.get("x-amz-test") != "signed":
            platform.violations.append(f"PUT {key}: {len(data)} bytes for a part presigned for {size}")
        fault = platform.take_fault(f"PUT {key}")
        if fault is not None:
            self.send_error_body(fault[0])
            return
        platform.objects[key] = data
        _prefix, output_id, number = key.split("/")
        self.send_response(200)
        self.send_header("ETag", f'"etag-{output_id}-{number}"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_error_body(self, status: int) -> None:
        data = b"<Error><Code>AccessDenied</Code></Error>"
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
