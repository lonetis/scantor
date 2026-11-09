"""`ctx.progress` and `ctx.checkpoint`: the latest values, sent at most once per interval in the background.

The platform persists progress and checkpoints at most once per interval (bootstrap `progressIntervalMs`,
`checkpointIntervalMs`: one and ten seconds); the SDK sends at the same pace, always the latest value, and
flushes what is pending when the run ends (also when it fails or is cancelled), so a restarted run resumes
from the last checkpoint. One background thread sends every value in order: the platform keeps the value it
accepts last, so an older value still being retried must never overtake a newer one.
"""

import json
import math
import threading
import time
from collections.abc import Callable
from typing import Any

import pydantic

from scantor.script._errors import ScriptError
from scantor.script._http import HttpClient
from scantor.script._stream import warn

MAX_PROGRESS_MESSAGE = 256


def fit_text(text: str, limit: int, *, keep_end: bool = False) -> str:
    """At most `limit` UTF-16 code units (what the platform counts), with "…" where text was cut."""
    if len(text) <= limit // 2 or len(text.encode("utf-16-le")) // 2 <= limit:
        return text
    kept: list[str] = []
    units = 1  # the ellipsis
    for char in reversed(text) if keep_end else text:
        units += 2 if ord(char) > 0xFFFF else 1
        if units > limit:
            break
        kept.append(char)
    return "…" + "".join(reversed(kept)) if keep_end else "".join(kept) + "…"


def encode_json(value: object, what: str) -> bytes:
    """Strict JSON (no NaN or infinity); pydantic models are dumped in JSON mode."""

    def default(item: object) -> object:
        if isinstance(item, pydantic.BaseModel):
            return item.model_dump(mode="json")
        raise TypeError(f"{what} must be JSON: {type(item).__name__} is not serialisable")

    try:
        text = json.dumps(value, default=default, allow_nan=False, separators=(",", ":"), ensure_ascii=False)
    except ValueError as exc:
        raise ValueError(f"{what} must be JSON: {exc}") from exc
    return text.encode("utf-8", errors="surrogatepass")


class Reporter:
    def __init__(
        self,
        client: HttpClient,
        *,
        max_checkpoint_bytes: int,
        progress_interval: float,
        checkpoint_interval: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = client
        self._max_checkpoint_bytes = max_checkpoint_bytes
        self._intervals = {"progress": progress_interval, "checkpoint": checkpoint_interval}
        self._clock = clock
        self._condition = threading.Condition()
        self._pending: dict[str, bytes] = {}
        self._last_sent: dict[str, float] = {}
        self._closed = False
        self._thread: threading.Thread | None = None

    def progress(self, done: float, total: float | None, message: str | None) -> None:
        if not _is_count(done):
            raise ValueError(f"progress done must be a finite number >= 0, not {done!r}")
        if total is not None and not _is_count(total):
            raise ValueError(f"progress total must be a finite number >= 0 or None, not {total!r}")
        body: dict[str, Any] = {"done": done, "total": total}
        body["message"] = None if message is None else fit_text(str(message), MAX_PROGRESS_MESSAGE)
        self._submit("progress", json.dumps(body, separators=(",", ":")).encode())

    def checkpoint(self, state: object) -> None:
        encoded = encode_json(state, "the checkpoint state")
        if len(encoded) > self._max_checkpoint_bytes:
            raise ValueError(
                f"the checkpoint state is {len(encoded)} bytes of JSON; the limit is {self._max_checkpoint_bytes}"
            )
        self._submit("checkpoint", b'{"state":' + encoded + b"}")

    def flush(self) -> None:
        """Send what is pending now and stop the background thread (the run is ending).

        The thread sends the pending values after the send it is in, ignoring the intervals; waiting for it
        is bounded by the client's retry budget (and the container's stop grace).
        """
        with self._condition:
            self._closed = True
            thread = self._thread
            self._condition.notify_all()
        if thread is not None:
            thread.join()

    def _submit(self, kind: str, payload: bytes) -> None:
        with self._condition:
            if self._closed:
                raise ScriptError(f"{kind} can only be reported while the script runs", code="ended")
            self._pending[kind] = payload
            if self._thread is None:
                self._thread = threading.Thread(target=self._loop, name="scantor-report", daemon=True)
                self._thread.start()
            self._condition.notify_all()

    def _loop(self) -> None:
        while True:
            with self._condition:
                while True:
                    final = self._closed
                    now = self._clock()
                    due = [kind for kind in self._pending if final or self._due_at(kind) <= now]
                    if due or final:
                        batch = {kind: self._pending.pop(kind) for kind in due}
                        for kind in due:
                            self._last_sent[kind] = now
                        break
                    waits = [self._due_at(kind) - now for kind in self._pending]
                    self._condition.wait(timeout=min(waits) if waits else None)
            for kind, payload in batch.items():
                self._send(kind, payload)
            if final:
                return

    def _due_at(self, kind: str) -> float:
        last = self._last_sent.get(kind)
        return -math.inf if last is None else last + self._intervals[kind]

    def _send(self, kind: str, payload: bytes) -> None:
        method, path = ("POST", "/progress") if kind == "progress" else ("PUT", "/checkpoint")
        try:
            self._client.call(method, path, raw=payload)
        except ScriptError as exc:
            warn(f"could not save the {kind}: {exc.message}")


def _is_count(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
