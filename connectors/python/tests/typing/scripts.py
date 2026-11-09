"""Typing tests of scantor.script (checked by basedpyright, never executed).

Every line ending in `# pyright: ignore[...]` must be a type error: the project enables
reportUnnecessaryTypeIgnoreComment, so an expected error that disappears fails the check.
"""

from typing import Any, assert_type

from pydantic import BaseModel

import scantor
from scantor import FileRef
from scantor.script import Analysis, AnalysisStream, MapResult, Output, Scan, Script, ScriptContext


class Params(scantor.Config):
    min_bytes: int = 0


class Other(scantor.Config):
    name: str = ""


class Result(BaseModel):
    title: str
    report: FileRef | None = None


class ItemConfig(BaseModel):
    item: str


class Summary(BaseModel):
    analyses: int


def run(ctx: ScriptContext, config: Params) -> Summary:
    return Summary(analyses=config.min_bytes)


ok_typed = Script(run=run, config=Params, result=Summary)
assert_type(ok_typed, Script[Params, Summary])


async def run_async(ctx: ScriptContext, config: Params) -> Summary:
    return Summary(analyses=0)


ok_async = Script(run=run_async, config=Params, result=Summary)


def run_plain(ctx: ScriptContext, config: scantor.Empty) -> dict[str, int]:
    return {"n": 1}


ok_plain = Script(run=run_plain)
assert_type(ok_plain, Script[scantor.Empty, BaseModel])


def run_wrong_return(ctx: ScriptContext, config: Params) -> Params:
    return config


bad_return = Script(run=run_wrong_return, config=Params, result=Summary)  # pyright: ignore[reportArgumentType, reportCallIssue]
bad_config = Script(run=run, config=Other, result=Summary)  # pyright: ignore[reportArgumentType, reportCallIssue]
bad_config_type = Script(run=run, config=int, result=Summary)  # pyright: ignore[reportArgumentType, reportCallIssue]


def check(analysis: Analysis[Result]) -> bool:
    return analysis.result is not None and analysis.result.title != ""


def reads(ctx: ScriptContext) -> None:
    scan: Scan = ctx.scans[0]
    typed = ctx.analyses(scan, result=Result, status="succeeded")
    assert_type(typed, AnalysisStream[Result, dict[str, Any]])
    for analysis in typed:
        result = analysis.result
        assert_type(result, Result | None)
        if result is not None and result.report is not None:
            text: str = analysis.read_text(result.report)
            data: bytes = analysis.read_bytes(result.report)
            summary = analysis.read_json(result.report, Summary)
            assert_type(summary, Summary)
            del text, data
        wrong: int = analysis.result  # pyright: ignore[reportAssignmentType]
        del wrong

    both = ctx.analyses(scan, result=Result, analysis_config=ItemConfig)
    assert_type(both, AnalysisStream[Result, ItemConfig])
    for analysis in both:
        assert_type(analysis.config, ItemConfig | None)

    untyped = ctx.analyses(scan.name)
    assert_type(untyped, AnalysisStream[dict[str, Any], dict[str, Any]])

    results = ctx.map(check, typed, processes=ctx.cpus)
    assert_type(results, MapResult[bool])
    watermark: int | None = results.watermark
    for ok in results:
        assert_type(ok, bool)
    del watermark

    ctx.map(check, untyped)  # pyright: ignore[reportArgumentType]
    ctx.analyses(scan, result=int)  # pyright: ignore[reportArgumentType, reportCallIssue]


def writes(ctx: ScriptContext) -> None:
    output: Output = ctx.outputs.put("summary.json", "{}")
    with ctx.outputs.open("rows.csv") as text_file:
        text_file.write("a,b\n")
        text_file.write(b"bytes")  # pyright: ignore[reportArgumentType]
    with ctx.outputs.open("raw.bin", "wb") as binary_file:
        binary_file.write(b"\x00")
    ctx.progress(1, 10, "message")
    ctx.checkpoint({"after_seq": 3})
    ctx.log("done", rows=1)
    secret: str = ctx.secrets["API_KEY"]
    del output, secret
