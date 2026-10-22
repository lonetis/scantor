import os
import shutil
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from tests.harness import FakeRuntime, make_ctx

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def basedpyright() -> str:
    """The basedpyright executable: the base image's tool venv, else next to this interpreter or on PATH."""
    for candidate in (
        "/opt/scantor/tools/bin/basedpyright",
        shutil.which("basedpyright", path=str(Path(sys.executable).parent)),
        shutil.which("basedpyright"),
    ):
        if candidate and Path(candidate).is_file():
            return candidate
    pytest.fail("basedpyright is not installed")


def tool_env() -> dict[str, str]:
    """Environment in which `python -m scantor.check` finds basedpyright."""
    tool_dir = str(Path(basedpyright()).parent)
    return {**os.environ, "PATH": f"{tool_dir}{os.pathsep}{os.environ.get('PATH', '')}"}


StartConnector = Callable[..., FakeRuntime]


@pytest.fixture
def start_connector() -> Iterator[StartConnector]:
    started: list[FakeRuntime] = []

    def start(entry: str | Path, *, handshake: bool = True, cwd: Path = FIXTURES, **options: Any) -> FakeRuntime:
        runtime = FakeRuntime(entry, cwd=cwd, **options)
        started.append(runtime)
        if handshake:
            runtime.handshake()
        return runtime

    yield start
    for runtime in started:
        runtime.kill()
    violations = [violation for runtime in started for violation in runtime.violations]
    assert not violations, "protocol violations:\n" + "\n".join(violations)


@pytest.fixture
def ctx_factory(tmp_path: Path) -> Callable[..., dict[str, Any]]:
    def factory(request_id: str, **options: Any) -> dict[str, Any]:
        return make_ctx(tmp_path, request_id=request_id, **options)

    return factory
