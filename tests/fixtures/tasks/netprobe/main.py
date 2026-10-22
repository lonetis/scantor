"""netprobe: what a worker can reach (sandbox tests, docs/security.md).

Mode `connect` tries a TCP connection to every `host:port` of the task config and reports which succeeded; mode
`env` reports the names (never the values) of the process's environment variables.
"""

import os
import socket
from typing import Literal

from pydantic import BaseModel, Field

import scantor


class TaskConfig(scantor.Config):
    mode: Literal["connect", "env"] = "connect"
    targets: list[str] = Field(default=[], description='host:port pairs, for example ["mongo:27017"].')
    timeout_seconds: float = Field(default=3, gt=0, le=30)


class Result(BaseModel):
    reachable: dict[str, bool]
    errors: dict[str, str]
    env: list[str]


def probe(target: str, timeout: float) -> str | None:
    host, _, port = target.rpartition(":")
    try:
        with socket.create_connection((host.strip("[]"), int(port)), timeout=timeout):
            return None
    except (OSError, ValueError) as exc:
        return f"{type(exc).__name__}: {exc}"


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    if task_config.mode == "env":
        return Result(reachable={}, errors={}, env=sorted(os.environ))
    reachable: dict[str, bool] = {}
    errors: dict[str, str] = {}
    for target in task_config.targets:
        error = probe(target, task_config.timeout_seconds)
        reachable[target] = error is None
        if error is not None:
            errors[target] = error
    return Result(reachable=reachable, errors=errors, env=[])


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
