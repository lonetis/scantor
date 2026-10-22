"""origins: fetch every origin of a Tranco top list and record its HTTP status and response headers.

The schedule wraps the template `tranco`: it iterates the list, skips domains by top-level domain and
turns each domain into an origin. The network access happens in `run`, never in `schedule`, which must
stay deterministic.
"""

from collections.abc import Iterator
from typing import Literal

import httpx
from pydantic import BaseModel, Field

import scantor
from scantor import templates


class TaskConfig(scantor.Config):
    user_agent: str = Field(
        default="scantor-origins/1.0 (+https://github.com/lonetis/scantor)", description="User-Agent of every request."
    )
    timeout_seconds: float = Field(default=10, gt=0, le=300, description="Timeout of one request.")
    follow_redirects: bool = Field(default=True, description="Follow redirects to the final URL.")


class ScanConfig(templates.tranco.ScanConfig):
    """The tranco template's fields plus our own filters."""

    scheme: Literal["https", "http"] = Field(default="https", description="Scheme of the fetched origins.")
    skip_tlds: list[str] = Field(default=[], description='Top-level domains to skip, for example ["cn"].')


class AnalysisConfig(scantor.Config):
    origin: str
    rank: int


class Result(BaseModel):
    origin: str
    rank: int
    status: int | None
    final_url: str | None
    headers: dict[str, str]
    error: str | None


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> Iterator[AnalysisConfig]:
    skipped = {tld.lower().lstrip(".") for tld in scan_config.skip_tlds}
    for item in templates.tranco.schedule(ctx, scan_config):  # wrapped: streamed from the runtime
        if item.domain.rsplit(".", 1)[-1] not in skipped:
            yield AnalysisConfig(origin=f"{scan_config.scheme}://{item.domain}", rank=item.rank)


async def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> Result:
    origin, rank = analysis_config.origin, analysis_config.rank
    remaining = ctx.remaining()
    timeout = task_config.timeout_seconds if remaining is None else min(task_config.timeout_seconds, remaining)
    headers = {"user-agent": task_config.user_agent}
    async with httpx.AsyncClient(
        headers=headers, timeout=timeout, follow_redirects=task_config.follow_redirects
    ) as client:
        try:
            # Only the status and the headers are recorded, so the body is never downloaded.
            async with client.stream("GET", origin) as response:
                status, final_url, response_headers = response.status_code, str(response.url), dict(response.headers)
        except httpx.TransportError as exc:
            # An unreachable origin is a measurement result, not a failure of the task.
            ctx.log("warning", "request failed", origin=origin, error=repr(exc))
            return Result(
                origin=origin, rank=rank, status=None, final_url=None, headers={}, error=f"{type(exc).__name__}: {exc}"
            )
    if status == 429:
        retry_after = response_headers.get("retry-after", "")
        raise scantor.Retry("rate limited", delay=float(retry_after) if retry_after.isdigit() else None)
    ctx.log("info", "fetched", origin=origin, status=status)
    return Result(origin=origin, rank=rank, status=status, final_url=final_url, headers=response_headers, error=None)


task = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule,
    run=run,
)
