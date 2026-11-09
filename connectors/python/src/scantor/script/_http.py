"""HTTP of a script run: the script runtime API (run token, JSON, NDJSON streams) and presigned file URLs.

stdlib `http.client` only, with keep-alive connections per thread. Every call follows one retry policy:
429, 500, 502, 503 and 504 answers and connection failures are retried with a capped exponential backoff
for a total of ten minutes, long enough to outlast an orchestrator restart or a database failover; 504
`queryTimeout` is not retried, because the query hit its time limit and would hit it again. File-store
URLs are presigned by the platform: they are fetched without the run token, without redirects and only
from the file-store origin announced at bootstrap.
"""

import http.client
import io
import json
import ssl
import threading
import time
import urllib.parse
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, NoReturn, cast

from scantor._version import __version__
from scantor.script._errors import ScriptError

API_PREFIX = "/api/script-runtime"
TIMEOUT_SECONDS = 60.0
"""Socket timeout; streams send a checkpoint line at least every 10 s, so silence this long is a broken stream."""
MAX_LINE_BYTES = 64 * 1024 * 1024
_RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 504})
_API_PERMANENT_CODES = frozenset({"queryTimeout"})
"""error codes of retryable statuses that the same request would get again"""
_STALE_CONNECTION_ERRORS = (
    http.client.RemoteDisconnected,
    ConnectionResetError,
    ConnectionAbortedError,
    BrokenPipeError,
)


@dataclass(frozen=True)
class ClientConfig:
    """The environment of a script-run container; read here and nowhere else."""

    url: str
    """SCANTOR_URL: the orchestrator's internal URL"""
    token: str = field(repr=False)
    """SCANTOR_SCRIPT_TOKEN: the run-scoped `ssr_` token (never shown in a representation)"""
    ca_cert: str | None = field(default=None, repr=False)
    """SCANTOR_CA_CERT: extra trusted CA certificates (PEM), for an https SCANTOR_URL"""

    @classmethod
    def from_environment(cls, environ: Mapping[str, str]) -> ClientConfig:
        url = environ.get("SCANTOR_URL", "").strip()
        token = environ.get("SCANTOR_SCRIPT_TOKEN", "").strip()
        if not url or not token:
            raise ScriptError(
                "SCANTOR_URL and SCANTOR_SCRIPT_TOKEN are not set: scripts run in script runs "
                "(scantor scripts run, the web UI or MCP), not directly",
                code="configuration",
            )
        ca_cert = environ.get("SCANTOR_CA_CERT", "").replace("\\n", "\n").strip() or None
        return cls(url=url.rstrip("/"), token=token, ca_cert=ca_cert)


@dataclass(frozen=True)
class RetryPolicy:
    initial_delay: float = 1.0
    max_delay: float = 30.0
    budget: float = 600.0
    """seconds of retrying after which a call fails"""


class TransientError(Exception):
    """A failure the retry policy retries."""

    def __init__(self, reason: str, *, retry_after: float | None = None, status: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.retry_after = retry_after
        self.status = status


class UrlExpiredError(Exception):
    """The file store answered 403 to a presigned URL (expired); the caller presigns again once."""


def retrying[T](
    policy: RetryPolicy, operation: Callable[[], T], what: str, interrupt: Callable[[], None] | None = None
) -> T:
    """Run `operation`, retrying `TransientError`s; `interrupt` runs during waits (it may raise)."""
    started = time.monotonic()
    delay = policy.initial_delay
    while True:
        try:
            return operation()
        except TransientError as exc:
            wait = delay if exc.retry_after is None else min(policy.max_delay, max(0.0, exc.retry_after))
            elapsed = time.monotonic() - started
            if elapsed + wait > policy.budget:
                raise ScriptError(
                    f"{what}: {exc.reason}; gave up after {elapsed:.0f} s of retries",
                    code="unavailable",
                    status=exc.status,
                    retryable=True,
                ) from exc
            _sleep(wait, interrupt)
            delay = min(delay * 2, policy.max_delay)


def _sleep(seconds: float, interrupt: Callable[[], None] | None) -> None:
    end = time.monotonic() + seconds
    while True:
        if interrupt is not None:
            interrupt()
        remaining = end - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 0.25))


@dataclass(frozen=True)
class Origin:
    scheme: str
    host: str
    port: int

    @classmethod
    def of(cls, url: str) -> tuple[Origin, str]:
        """The origin of `url` and its request target (path and query)."""
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            raise ScriptError(f"not an http(s) URL: {_redact(url)}", code="badUrl")
        try:
            port = parts.port or (443 if parts.scheme == "https" else 80)
        except ValueError as exc:
            raise ScriptError(f"invalid port in {_redact(url)}", code="badUrl") from exc
        target = parts.path or "/"
        if parts.query:
            target = f"{target}?{parts.query}"
        return cls(parts.scheme, parts.hostname.lower(), port), target

    def __str__(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{self.scheme}://{host}:{self.port}"


def _encode(body: object) -> bytes:
    return json.dumps(body, separators=(",", ":"), allow_nan=False).encode()


def _redact(url: str) -> str:
    """A URL for messages: presigned query strings carry signatures."""
    return url.split("?", 1)[0]


def _retry_after(response: http.client.HTTPResponse) -> float | None:
    value = response.getheader("Retry-After")
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def api_error(status: int, body: bytes, what: str) -> ScriptError:
    """The `ScriptError` of an error answer (`{"error": {"code", "message", "details"}}`)."""
    code, message, details = f"http{status}", body.decode("utf-8", errors="replace")[:500].strip(), None
    try:
        envelope = json.loads(body)
    except ValueError:
        envelope = None
    if isinstance(envelope, dict) and isinstance(envelope.get("error"), dict):
        error = cast(dict[str, Any], envelope["error"])
        code = str(error.get("code", code))
        message = str(error.get("message", message))
        details = error.get("details") if isinstance(error.get("details"), dict) else None
    if status == 401:
        message = f"{message} (the run token is valid only while the script run is running)"
    return ScriptError(f"{what}: {message or f'HTTP {status}'}", code=code, status=status, details=details)


def api_failure(response: http.client.HTTPResponse, body: bytes, what: str) -> TransientError | ScriptError:
    """What an error answer of the script runtime API raises: a `TransientError` to retry, else a `ScriptError`.

    Decided after the envelope is parsed: the retryable statuses are retried unless their code says that
    the same request fails again (`queryTimeout`). Retrying a 500 is safe because every call of the API is
    idempotent (a re-requested part URL only reserves its bytes again).
    """
    status = response.status
    error = api_error(status, body, what)
    if status not in _RETRYABLE_STATUSES or error.code in _API_PERMANENT_CODES:
        return error
    reason = f"HTTP {status}" if error.code == f"http{status}" else f"HTTP {status} {error.code}"
    return TransientError(reason, retry_after=_retry_after(response), status=status)


class _Connections(threading.local):
    def __init__(self) -> None:
        self.open: dict[Origin, http.client.HTTPConnection] = {}


class Lines:
    """The lines of an NDJSON response on its own connection; `next_line` returns b"" at the end."""

    def __init__(self, response: http.client.HTTPResponse, connection: http.client.HTTPConnection) -> None:
        self._response = response
        self._connection = connection

    def next_line(self) -> bytes:
        try:
            line = self._response.readline(MAX_LINE_BYTES + 1)
        except (OSError, http.client.HTTPException) as exc:
            raise TransientError(f"the stream broke: {exc}") from exc
        if len(line) > MAX_LINE_BYTES:
            raise ScriptError(f"a stream line exceeds {MAX_LINE_BYTES} bytes", code="stream")
        return line

    def close(self) -> None:
        self._response.close()
        self._connection.close()


class _ResponseReader(io.RawIOBase):
    """A streamed response body as a raw binary stream; closing it closes its connection."""

    def __init__(self, response: http.client.HTTPResponse, connection: http.client.HTTPConnection) -> None:
        self._response = response
        self._connection = connection

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        return self._response.readinto(buffer)

    def close(self) -> None:
        if not self.closed:
            self._response.close()
            self._connection.close()
        super().close()


class HttpClient:
    """Requests of one script-run process (each worker process creates its own)."""

    def __init__(self, config: ClientConfig, retry: RetryPolicy | None = None) -> None:
        self.config = config
        self.retry = retry or RetryPolicy()
        self._api_origin, base_path = Origin.of(config.url)
        self._api_prefix = base_path.rstrip("/") + API_PREFIX
        self._file_origin: Origin | None = None
        self._connections = _Connections()
        self._ssl: ssl.SSLContext | None = None
        self._ssl_lock = threading.Lock()

    def set_file_origin(self, origin: str | None) -> None:
        """The only origin presigned file URLs may point at (bootstrap `s3Origin`)."""
        self._file_origin = Origin.of(origin)[0] if origin else None

    @property
    def file_origin(self) -> str | None:
        return None if self._file_origin is None else str(self._file_origin)

    # ── the script runtime API ───────────────────────────────────────────────────────────────────

    def call(
        self,
        method: str,
        path: str,
        body: object = None,
        *,
        raw: bytes | None = None,
        interrupt: Callable[[], None] | None = None,
    ) -> Any:
        """One JSON call of the script runtime API; the answer's JSON, `None` for an empty body.

        `body` is encoded as JSON; `raw` is a body already encoded.
        """
        payload = raw if raw is not None else None if body is None else _encode(body)
        target = self._api_prefix + path
        what = f"{method} {API_PREFIX}{path}"

        def attempt() -> Any:
            response, connection = self._send(
                self._api_origin, method, target, self._api_headers(payload), payload, dedicated=False
            )
            data = self._read_all(response, connection, self._api_origin, dedicated=False)
            if 200 <= response.status < 300:
                return json.loads(data) if data.strip() else None
            raise api_failure(response, data, what)

        return retrying(self.retry, attempt, what, interrupt)

    def stream(self, path: str, body: object, *, interrupt: Callable[[], None] | None = None) -> Lines:
        """POST that answers NDJSON, on a connection of its own until the stream is closed."""
        payload = _encode(body)
        target = self._api_prefix + path
        what = f"POST {API_PREFIX}{path}"

        def attempt() -> Lines:
            response, connection = self._send(
                self._api_origin, "POST", target, self._api_headers(payload), payload, dedicated=True
            )
            if response.status == 200:
                return Lines(response, connection)
            data = self._read_all(response, connection, self._api_origin, dedicated=True)
            raise api_failure(response, data, what)

        return retrying(self.retry, attempt, what, interrupt)

    def _api_headers(self, payload: bytes | None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.config.token}",
            "Accept": "application/json, application/x-ndjson",
            "User-Agent": f"scantor-script/{__version__}",
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"
        return headers

    # ── presigned file-store URLs ────────────────────────────────────────────────────────────────

    def get_file(self, url: str) -> bytes:
        """The whole object at a presigned GET URL; `UrlExpiredError` on 403."""
        origin, target = self._file_target(url)

        def attempt() -> bytes:
            response, connection = self._send(origin, "GET", target, {}, None, dedicated=False)
            data = self._read_all(response, connection, origin, dedicated=False)
            self._check_file_status(response, data, url)
            return data

        return retrying(self.retry, attempt, f"GET {_redact(url)}")

    def open_file(self, url: str) -> io.BufferedReader:
        """The object at a presigned GET URL as a stream on a connection of its own."""
        origin, target = self._file_target(url)

        def attempt() -> io.BufferedReader:
            response, connection = self._send(origin, "GET", target, {}, None, dedicated=True)
            if response.status == 200:
                return io.BufferedReader(_ResponseReader(response, connection), buffer_size=256 * 1024)
            data = self._read_all(response, connection, origin, dedicated=True)
            self._check_file_status(response, data, url)
            raise ScriptError(f"GET {_redact(url)}: HTTP {response.status}", code="fileStore", status=response.status)

        return retrying(self.retry, attempt, f"GET {_redact(url)}")

    def put_file(self, url: str, data: bytes | memoryview, headers: Mapping[str, str]) -> str:
        """PUT to a presigned URL (an upload part); returns the ETag."""
        origin, target = self._file_target(url)
        request_headers = {key: value for key, value in headers.items() if key.lower() != "host"}
        request_headers["Content-Length"] = str(len(data))

        def attempt() -> str:
            response, connection = self._send(origin, "PUT", target, request_headers, data, dedicated=False)
            body = self._read_all(response, connection, origin, dedicated=False)
            self._check_file_status(response, body, url)
            etag = response.getheader("ETag")
            if not etag:
                raise ScriptError(f"PUT {_redact(url)}: the file store returned no ETag", code="fileStore")
            return etag

        return retrying(self.retry, attempt, f"PUT {_redact(url)}")

    def _file_target(self, url: str) -> tuple[Origin, str]:
        origin, target = Origin.of(url)
        if self._file_origin is None or origin != self._file_origin:
            raise ScriptError(
                f"refusing the file URL {_redact(url)}: its origin is not the file store "
                f"{self.file_origin or '(unknown)'}",
                code="badUrl",
            )
        return origin, target

    @staticmethod
    def _check_file_status(response: http.client.HTTPResponse, body: bytes, url: str) -> None:
        status = response.status
        if 200 <= status < 300:
            return
        if status == 403:
            raise UrlExpiredError(_redact(url))
        if status in _RETRYABLE_STATUSES:
            raise TransientError(f"HTTP {status}", retry_after=_retry_after(response), status=status)
        text = body.decode("utf-8", errors="replace")[:300]
        raise ScriptError(f"{_redact(url)}: HTTP {status} {text}".rstrip(), code="fileStore", status=status)

    # ── connections ──────────────────────────────────────────────────────────────────────────────

    def _send(
        self,
        origin: Origin,
        method: str,
        target: str,
        headers: Mapping[str, str],
        body: bytes | memoryview | None,
        *,
        dedicated: bool,
    ) -> tuple[http.client.HTTPResponse, http.client.HTTPConnection]:
        """Send one request; a stale keep-alive connection is replaced at once, other failures are transient."""
        for _ in range(2):
            reused = False
            if dedicated:
                connection = self._connect(origin)
            else:
                existing = self._connections.open.get(origin)
                reused = existing is not None
                connection = existing or self._connect(origin)
                self._connections.open[origin] = connection
            try:
                connection.request(method, target, body=body, headers=dict(headers))
                return connection.getresponse(), connection
            except _STALE_CONNECTION_ERRORS as exc:
                self._discard(origin, connection, dedicated=dedicated)
                if reused:
                    continue
                self._fail(origin, exc)
            except (OSError, http.client.HTTPException) as exc:
                self._discard(origin, connection, dedicated=dedicated)
                self._fail(origin, exc)
        raise AssertionError("unreachable")

    @staticmethod
    def _fail(origin: Origin, exc: BaseException) -> NoReturn:
        raise TransientError(f"connection to {origin} failed: {type(exc).__name__}: {exc}") from exc

    def _read_all(
        self,
        response: http.client.HTTPResponse,
        connection: http.client.HTTPConnection,
        origin: Origin,
        *,
        dedicated: bool,
    ) -> bytes:
        try:
            data = response.read()
        except (OSError, http.client.HTTPException) as exc:
            self._discard(origin, connection, dedicated=dedicated)
            raise TransientError(f"reading the answer from {origin} failed: {exc}") from exc
        if dedicated or response.will_close:
            self._discard(origin, connection, dedicated=dedicated)
        return data

    def _discard(self, origin: Origin, connection: http.client.HTTPConnection, *, dedicated: bool) -> None:
        connection.close()
        if not dedicated and self._connections.open.get(origin) is connection:
            del self._connections.open[origin]

    def _connect(self, origin: Origin) -> http.client.HTTPConnection:
        if origin.scheme == "https":
            return http.client.HTTPSConnection(
                origin.host, origin.port, timeout=TIMEOUT_SECONDS, context=self._ssl_context()
            )
        return http.client.HTTPConnection(origin.host, origin.port, timeout=TIMEOUT_SECONDS)

    def _ssl_context(self) -> ssl.SSLContext:
        with self._ssl_lock:
            if self._ssl is None:
                context = ssl.create_default_context()
                if self.config.ca_cert:
                    context.load_verify_locations(cadata=self.config.ca_cert)
                self._ssl = context
            return self._ssl
