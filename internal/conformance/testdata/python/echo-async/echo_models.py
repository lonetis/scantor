"""Models shared by the echo fixtures (docs/protocol.md §12.2)."""

import os

from pydantic import BaseModel, Field, SecretStr

import scantor


class TaskConfig(scantor.Config):
    greeting: str = "Hello"
    api_token: SecretStr | None = Field(default=None, alias="apiToken")


class AnalysisConfig(scantor.Config):
    name: str = "world"
    mode: str = "ok"
    sleep_ms: int = Field(default=0, alias="sleepMs")
    size: int = Field(default=0, alias="bytes")


class CtxEcho(BaseModel):
    scanId: str  # noqa: N815 - JSON field names of the conformance fixture
    analysisId: str | None  # noqa: N815
    seq: int | None
    attempt: int
    hasDeadline: bool  # noqa: N815
    tmpDirWritable: bool  # noqa: N815


class Result(BaseModel):
    text: str
    ctx: CtxEcho
    secretLength: int  # noqa: N815
    files: list[scantor.FileRef]


def echo_ctx(ctx: scantor.Context) -> CtxEcho:
    writable = os.access(ctx.tmp_dir, os.W_OK) and not any(ctx.tmp_dir.iterdir())
    return CtxEcho(
        scanId=ctx.scan_id,
        analysisId=ctx.analysis_id,
        seq=ctx.seq,
        attempt=ctx.attempt,
        hasDeadline=ctx.deadline is not None,
        tmpDirWritable=writable,
    )


def secret_length(task_config: TaskConfig) -> int:
    return len(task_config.api_token.get_secret_value()) if task_config.api_token else 0
