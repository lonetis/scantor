"""Errors that task code raises (`Fatal`, `Retry`) or receives from the platform (`ScantorError`)."""

import datetime
import math
import numbers

# The longest delay the runtime can hold (a Go time.Duration) in milliseconds; the platform clamps every
# delay to the scan's backoff maximum anyway.
_MAX_DELAY_MS = (2**63 - 1) // 1_000_000


class Fatal(Exception):
    """A permanent failure: the analysis (or scheduling) fails now, without further attempts."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class Retry(Exception):
    """A transient failure: the analysis is attempted again after `delay`.

    `delay` is in seconds (or a `timedelta`); `None` uses the scan's backoff. The platform clamps it to
    [1 s, backoff.max], and the attempt counts toward `maxAttempts`. A delay that is not a number or not
    finite (for example parsed from a `Retry-After: nan` header) raises `TypeError` or `ValueError` here.
    """

    def __init__(self, message: str, delay: float | datetime.timedelta | None = None) -> None:
        super().__init__(message)
        _delay_ms(delay)
        self.message = message
        self.delay = delay

    @property
    def delay_ms(self) -> int | None:
        """The requested delay in wire milliseconds (never negative), or `None` for the backoff."""
        return _delay_ms(self.delay)


def _delay_ms(delay: object) -> int | None:
    if delay is None:
        return None
    if isinstance(delay, datetime.timedelta):
        seconds: float = delay.total_seconds()
    elif isinstance(delay, numbers.Real) and not isinstance(delay, bool):
        # int stays exact: float() would overflow for huge values
        seconds = int(delay) if isinstance(delay, int) else float(delay)
    else:
        raise TypeError(f"Retry delay must be seconds (a float) or a datetime.timedelta, not {type(delay).__name__}")
    if isinstance(seconds, float) and not math.isfinite(seconds):
        raise ValueError(f"Retry delay must be a finite number of seconds, not {seconds}")
    if seconds <= 0:
        return 0
    if seconds >= _MAX_DELAY_MS / 1000:
        return _MAX_DELAY_MS
    return round(seconds * 1000)


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
