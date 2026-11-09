"""ctx.progress and ctx.checkpoint: throttled, always the latest value, flushed at the end."""

import math
import threading
import time
from collections.abc import Callable
from typing import Any

import pytest

from scantor.script._http import ClientConfig, HttpClient
from scantor.script._report import Reporter, fit_text
from tests.script_fake import TOKEN, FakePlatform
from tests.script_support import FAST_RETRY, flush, make_context, wait_until


def test_progress_is_throttled_and_flushed(platform: FakePlatform) -> None:
    ctx = make_context(platform, progress_interval=0.3)
    ctx.progress(1, 200)
    wait_until(lambda: len(platform.progress) == 1)
    for done in range(2, 201):
        ctx.progress(done, 200, "working")
    time.sleep(0.1)
    assert len(platform.progress) == 1  # the next value waits for the interval
    wait_until(lambda: len(platform.progress) == 2)
    assert platform.progress == [
        {"done": 1, "total": 200, "message": None},
        {"done": 200, "total": 200, "message": "working"},
    ]
    ctx.progress(201, None)
    flush(ctx)
    assert platform.progress[-1] == {"done": 201, "total": None, "message": None}
    assert len(platform.progress) == 3


def test_checkpoints_are_copied_throttled_and_flushed(platform: FakePlatform) -> None:
    ctx = make_context(platform, checkpoint_interval=10)
    state = {"done": 1}
    ctx.checkpoint(state)
    wait_until(lambda: len(platform.checkpoints) == 1)
    for _ in range(99):
        state["done"] += 1
        ctx.checkpoint(state)
    state["done"] = -1  # changed after the last call: the checkpoint keeps the copy taken by the call
    time.sleep(0.1)
    assert platform.checkpoints == [{"done": 1}]
    flush(ctx)
    assert platform.checkpoints == [{"done": 1}, {"done": 100}]


def test_invalid_values(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    with pytest.raises(ValueError, match="done"):
        ctx.progress(-1)
    with pytest.raises(ValueError, match="total"):
        ctx.progress(1, math.nan)
    with pytest.raises(ValueError, match="JSON"):
        ctx.checkpoint({"bad": math.inf})
    with pytest.raises(TypeError, match="JSON"):
        ctx.checkpoint({"bad": object()})
    with pytest.raises(ValueError, match="limit"):
        ctx.checkpoint({"big": "x" * (1024 * 1024)})


def test_failed_reports_are_logged(platform: FakePlatform, capsys: pytest.CaptureFixture[str]) -> None:
    ctx = make_context(platform)
    platform.faults["PUT /checkpoint"] = [400]
    ctx.checkpoint({"n": 1})
    flush(ctx)
    assert "could not save the checkpoint" in capsys.readouterr().err


class _GatedClient(HttpClient):
    """Holds the first checkpoint until `release` is set; records the thread of every checkpoint send."""

    def __init__(self, platform: FakePlatform) -> None:
        super().__init__(ClientConfig(url=platform.url, token=TOKEN), FAST_RETRY)
        self.started = threading.Event()
        self.release = threading.Event()
        self.senders: list[str] = []

    def call(
        self,
        method: str,
        path: str,
        body: object = None,
        *,
        raw: bytes | None = None,
        interrupt: Callable[[], None] | None = None,
    ) -> Any:
        if path == "/checkpoint":
            self.senders.append(threading.current_thread().name)
            if not self.started.is_set():
                self.started.set()
                self.release.wait(10)
        return super().call(method, path, body, raw=raw, interrupt=interrupt)


def test_flush_sends_the_last_checkpoint_after_the_one_in_flight(platform: FakePlatform) -> None:
    # The platform keeps the checkpoint it accepts last: the final one must never race a slow older one.
    client = _GatedClient(platform)
    reporter = Reporter(client, max_checkpoint_bytes=1024, progress_interval=0.05, checkpoint_interval=60)
    reporter.checkpoint({"n": "A"})
    assert client.started.wait(5)
    reporter.checkpoint({"n": "B"})
    flushing = threading.Thread(target=reporter.flush)
    flushing.start()
    time.sleep(0.2)
    assert platform.checkpoints == []  # A is still in flight; B waits for it
    client.release.set()
    flushing.join(10)
    assert not flushing.is_alive()
    assert platform.checkpoints == [{"n": "A"}, {"n": "B"}]  # B despite the 60 s interval
    assert client.senders == ["scantor-report", "scantor-report"]


def test_texts_fit_the_platform_limits() -> None:
    assert fit_text("short", 10) == "short"
    cut = fit_text("😀" * 300, 256)
    assert len(cut.encode("utf-16-le")) // 2 <= 256
    assert cut.endswith("…")
    tail = fit_text("a" * 100 + "end", 10, keep_end=True)
    assert tail == "…aaaaaaend"
