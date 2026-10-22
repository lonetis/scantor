"""Errors that task code raises (`Fatal`, `Retry`) or receives from the platform (`ScantorError`)."""

import datetime


class Fatal(Exception):
    """A permanent failure: the analysis (or scheduling) fails now, without further attempts."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class Retry(Exception):
    """A transient failure: the analysis is attempted again after `delay`.

    `delay` is in seconds (or a `timedelta`); `None` uses the scan's backoff. The platform clamps it to
    [1 s, backoff.max], and the attempt counts toward `maxAttempts`.
    """

    def __init__(self, message: str, delay: float | datetime.timedelta | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.delay = delay

    @property
    def delay_ms(self) -> int | None:
        """The requested delay in wire milliseconds (never negative), or `None` for the backoff."""
        if self.delay is None:
            return None
        seconds = self.delay.total_seconds() if isinstance(self.delay, datetime.timedelta) else self.delay
        return max(0, round(seconds * 1000))


class ScantorError(Exception):
    """An error reported by the platform, raised by `ctx.files` and template streams.

    `type` is a ScantorError type such as `validation` or `platform`; `retryable` says whether the
    platform considers the failure transient. Uncaught, a `validation` error fails the call without
    retries and every other type is reported as `taskError`.
    """

    def __init__(self, error_type: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.type = error_type
        self.message = message
        self.retryable = retryable


class DefinitionError(TypeError):
    """The task definition is invalid; raised by `scantor.Task(...)` when the entry is imported."""
