"""A Retry delay that cannot be sent, and a failure of the error classification itself."""

import threading

from pydantic import BaseModel

import scantor


class AnalysisConfig(scantor.Config):
    mode: str = "nan"


class Result(BaseModel):
    text: str


class BrokenRetry(scantor.Retry):
    """Makes error classification fail, as a connector bug would."""

    @property
    def delay_ms(self) -> int | None:
        raise RuntimeError("broken classification " + "x" * 5000)


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: scantor.Empty) -> Result:
    if analysis_config.mode == "nan":
        raise scantor.Retry("rate limited", float("nan"))
    if analysis_config.mode == "broken":
        threading.Timer(0.5, ctx.log, ("info", "late")).start()
        raise BrokenRetry("retry requested")
    return Result(text="ok")


task = scantor.Task(analysis_config=AnalysisConfig, result=Result, run=run)
