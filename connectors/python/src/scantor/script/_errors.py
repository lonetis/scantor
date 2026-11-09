"""Errors of the script API and the cancellation state of a script run."""

import signal
import threading
from collections.abc import Callable
from types import FrameType
from typing import Any


class ScriptError(Exception):
    """A failure reported by the platform (the script runtime API or the file store), or broken data.

    `code` is the API error code (`notFound`, `unauthorized`, `validationFailed`, ...) or an SDK code
    (`unavailable` after the retries ran out, `integrity` for a SHA-256 mismatch, `stream` for a broken
    analysis stream); `status` is the HTTP status when there was one.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = "scriptError",
        status: int | None = None,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.retryable = retryable
        self.details = details


class Cancelled(BaseException):
    """Raised in the main thread once the run is cancelled (SIGTERM: cancel, timeout or shutdown).

    A BaseException, so that `except Exception` in script code does not swallow it. Analysis streams,
    `ctx.map` and `ctx.check_cancelled()` raise it; open outputs are stored as `<name>.partial`.
    """


class CancelState:
    """The cancellation flag of the process, set by SIGTERM/SIGINT."""

    def __init__(self) -> None:
        self._event = threading.Event()
        self._reason: str | None = None
        self._callbacks: list[Callable[[], None]] = []
        self._lock = threading.Lock()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    @property
    def reason(self) -> str | None:
        return self._reason

    def cancel(self, reason: str) -> None:
        with self._lock:
            if self._event.is_set():
                return
            self._reason = reason
            self._event.set()
            callbacks = list(self._callbacks)
        for callback in callbacks:
            callback()

    def on_cancel(self, callback: Callable[[], None]) -> None:
        """Run `callback` once at cancellation (at once when already cancelled)."""
        with self._lock:
            if not self._event.is_set():
                self._callbacks.append(callback)
                return
        callback()

    def check(self) -> None:
        if self._event.is_set():
            raise Cancelled(f"cancelled: {self._reason}")

    def wait(self, timeout: float) -> bool:
        return self._event.wait(timeout)

    def install_signal_handlers(self) -> None:
        """SIGTERM and SIGINT set the flag; the main thread raises `Cancelled` at its next check."""

        def handle(signum: int, _frame: FrameType | None) -> None:
            self.cancel(f"received {signal.Signals(signum).name}")

        signal.signal(signal.SIGTERM, handle)
        signal.signal(signal.SIGINT, handle)
