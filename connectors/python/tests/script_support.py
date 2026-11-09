"""Helpers of the script SDK tests: a ScriptContext against the fake platform, analyses like the `files` task's."""

import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from scantor.script import ScriptContext
from scantor.script._errors import CancelState
from scantor.script._http import ClientConfig, HttpClient, RetryPolicy
from scantor.script._map import MapEnvironment
from scantor.script._models import Bootstrap, FileAccess, set_process_file_access
from scantor.script._report import Reporter
from tests.script_fake import TOKEN, FakePlatform, FakeScan

FAST_RETRY = RetryPolicy(initial_delay=0.01, max_delay=0.05, budget=2.0)
SCRIPT_ENTRIES = Path(__file__).resolve().parent / "fixtures" / "scripts"
PIXEL = b"\x89PNG\r\n\x1a\n" + bytes(range(64))


def make_client(platform: FakePlatform, retry: RetryPolicy = FAST_RETRY) -> HttpClient:
    return HttpClient(ClientConfig(url=platform.url, token=TOKEN), retry)


def make_context(
    platform: FakePlatform,
    *,
    retry: RetryPolicy = FAST_RETRY,
    cancel: CancelState | None = None,
    progress_interval: float = 0.05,
    checkpoint_interval: float = 0.1,
) -> ScriptContext:
    """What the runner builds after bootstrap, without an entry (worker processes import nothing)."""
    client = make_client(platform, retry)
    bootstrap = Bootstrap.model_validate(client.call("GET", "/bootstrap"))
    client.set_file_origin(bootstrap.s3_origin)
    access = FileAccess(client)
    set_process_file_access(access)
    cancel = cancel or CancelState()
    reporter = Reporter(
        client,
        max_checkpoint_bytes=bootstrap.limits.max_checkpoint_bytes,
        progress_interval=progress_interval,
        checkpoint_interval=checkpoint_interval,
    )
    return ScriptContext(
        bootstrap=bootstrap,
        client=client,
        access=access,
        cancel=cancel,
        reporter=reporter,
        map_environment=MapEnvironment(cancel=cancel, client=client, entry=None),
    )


def flush(ctx: ScriptContext) -> None:
    ctx._reporter.flush()


def files_result(item: str, copies: int) -> Callable[[dict[str, Any]], dict[str, Any]]:
    """The result of the example task `files` for the FileRefs of its files."""

    def build(refs: dict[str, Any]) -> dict[str, Any]:
        return {
            "item": item,
            "length": len(item),
            "data": refs["data.json"],
            "image": refs["image.png"],
            "notes": refs["notes.txt"],
            "nested": {"data": refs["nested.json"], "image": refs["nested.png"]},
            "gallery": [refs[f"gallery-{n}.png"] for n in range(copies)],
        }

    return build


def add_files_analysis(platform: FakePlatform, scan: FakeScan, item: str, *, copies: int = 2) -> dict[str, Any]:
    """An analysis as the example task `files` stores it (tasks/files/main.py)."""
    seq = len(scan.analyses)
    files = {
        "data.json": json.dumps({"item": item, "index": seq, "upper": item.upper()}, indent=2).encode(),
        "image.png": PIXEL,
        "notes.txt": f"Notes on {item}\n".encode(),
        "nested.json": json.dumps({"nested": True}).encode(),
        "nested.png": PIXEL,
        **{f"gallery-{n}.png": PIXEL for n in range(copies)},
    }
    return platform.add_analysis(
        scan, result=files_result(item, copies), config={"item": item, "index": seq}, files=files
    )


FILE_REF_PATHS = ["/data", "/image", "/notes", "/nested/data", "/nested/image", "/gallery/*"]


def files_scan(platform: FakePlatform, items: list[str], *, name: str = "files-scan") -> FakeScan:
    scan = platform.add_scan(name, file_ref_paths=FILE_REF_PATHS)
    for item in items:
        add_files_analysis(platform, scan, item)
    return scan


class ScriptProcess:
    """`python -m scantor.script <entry>` against the fake platform."""

    def __init__(self, platform: FakePlatform, entry: Path, *, cwd: Path | None = None) -> None:
        environment = {**os.environ, **platform.environment()}
        self.process = subprocess.Popen(
            [sys.executable, "-m", "scantor.script", entry.name],
            cwd=cwd or entry.parent,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def wait(self, timeout: float = 120) -> tuple[int, str, str]:
        stdout, stderr = self.process.communicate(timeout=timeout)
        return self.process.returncode, stdout, stderr

    def terminate(self) -> None:
        self.process.send_signal(signal.SIGTERM)


def wait_until(condition: Callable[[], bool], timeout: float = 30) -> None:
    end = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > end:
            raise AssertionError("condition not met in time")
        time.sleep(0.02)
