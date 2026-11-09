"""Analysis streams: typed analyses with their files, checkpoints, resumes, error lines, limits."""

import hashlib
from typing import Any

import pydantic
import pytest

from scantor import FileRef
from scantor.script import Analysis, Cancelled, Scan, ScriptError
from scantor.script._errors import CancelState
from tests.script_fake import FakePlatform
from tests.script_support import PIXEL, files_scan, make_context


class Attachments(pydantic.BaseModel):
    data: FileRef
    image: FileRef


class Result(pydantic.BaseModel):
    item: str
    length: int
    data: FileRef
    image: FileRef
    notes: FileRef
    nested: Attachments
    gallery: list[FileRef]


class ItemConfig(pydantic.BaseModel):
    item: str
    index: int


def test_typed_analyses_with_files(platform: FakePlatform) -> None:
    scan = files_scan(platform, ["a.org", "b.org", "c.org", "d.org"])
    ctx = make_context(platform)
    assert [s.name for s in ctx.scans] == ["files-scan"]
    target = ctx.scan("files-scan")
    assert target is ctx.scan(scan.id)
    assert (target.task_name, target.revision_number, target.max_seq, target.counts.succeeded) == ("files", 3, 3, 4)

    stream = ctx.analyses(target, result=Result, analysis_config=ItemConfig, status="succeeded")
    analyses = list(stream)
    assert [a.seq for a in analyses] == [0, 1, 2, 3]
    first = analyses[0]
    assert isinstance(first.result, Result)
    assert first.config == ItemConfig(item="a.org", index=0)
    assert first.scan_id == scan.id
    assert first.read_json(first.result.data) == {"item": "a.org", "index": 0, "upper": "A.ORG"}
    assert first.read_bytes(first.result.gallery[1]) == PIXEL
    assert first.read_text("notes.txt") == "Notes on a.org\n"
    assert first.file(first.result.notes.model_dump(by_alias=True)) == first.result.notes
    with first.open(first.result.image) as source:
        assert source.read() == PIXEL
    assert stream.complete
    assert stream.watermark == 3
    assert stream.count == 4

    # The presigned URLs stay out of the representation; the request used the defaults.
    assert "X-Amz" not in repr(first)
    assert "X-Amz" not in first.model_dump_json()
    assert platform.stream_requests[0] == {"fileUrls": True, "status": ["succeeded"], "afterSeq": -1}


def test_untyped_results_get_file_refs(platform: FakePlatform, tmp_path: Any) -> None:
    files_scan(platform, ["a.org"])
    ctx = make_context(platform)
    (analysis,) = list(ctx.analyses(ctx.scans[0]))
    result = analysis.result
    assert isinstance(result, dict)
    assert isinstance(result["data"], FileRef)
    assert isinstance(result["nested"]["image"], FileRef)
    assert all(isinstance(ref, FileRef) for ref in result["gallery"])
    assert result["item"] == "a.org"
    target = analysis.download(result["image"], tmp_path / "image.png")
    assert target.read_bytes() == PIXEL


def test_resume_after_a_dropped_stream(platform: FakePlatform) -> None:
    files_scan(platform, [f"site-{n}.org" for n in range(10)])
    platform.stream_faults.drop_after = 4
    ctx = make_context(platform)
    stream = ctx.analyses(ctx.scans[0], result=Result)
    assert [a.seq for a in stream] == list(range(10))
    assert [request["afterSeq"] for request in platform.stream_requests] == [-1, 3]


def test_resume_from_a_checkpoint_line(platform: FakePlatform) -> None:
    scan = platform.add_scan("mixed")
    for n in range(9):
        platform.add_analysis(scan, status="failed" if n < 7 else "succeeded", result={"n": n})
    platform.stream_faults.drop_after = 1
    ctx = make_context(platform)
    stream = ctx.analyses(ctx.scans[0], status="succeeded")
    assert [a.seq for a in stream] == [7, 8]
    # The first response passed checkpoints at seqs 2 and 5 before seq 7 and broke after it.
    assert [request["afterSeq"] for request in platform.stream_requests] == [-1, 7]


def test_retryable_error_line_resumes(platform: FakePlatform) -> None:
    files_scan(platform, [f"s{n}" for n in range(5)])
    platform.stream_faults.error_after = 2
    ctx = make_context(platform)
    assert [a.seq for a in ctx.analyses(ctx.scans[0])] == [0, 1, 2, 3, 4]
    assert [request["afterSeq"] for request in platform.stream_requests] == [-1, 1]


def test_fatal_error_line_raises(platform: FakePlatform) -> None:
    files_scan(platform, [f"s{n}" for n in range(5)])
    platform.stream_faults.error_after = 2
    platform.stream_faults.error_retryable = False
    ctx = make_context(platform)
    seen: list[int] = []
    with pytest.raises(ScriptError) as error:
        seen.extend(a.seq for a in ctx.analyses(ctx.scans[0]))
    assert error.value.code == "cursorLost"
    assert seen == [0, 1]


def test_after_and_until_seq(platform: FakePlatform) -> None:
    files_scan(platform, [f"s{n}" for n in range(8)])
    ctx = make_context(platform)
    stream = ctx.analyses(ctx.scans[0], after_seq=2, until_seq=5, fields=["result.item"], file_urls=False)
    assert [a.seq for a in stream] == [3, 4, 5]
    assert platform.stream_requests[0]["fields"] == ["id", "seq", "status", "attempt", "round", "result.item"]
    assert platform.stream_requests[0]["untilSeq"] == 5


@pytest.mark.parametrize("until_seq", [2, 3])
def test_a_stream_cut_at_until_seq_is_complete(platform: FakePlatform, until_seq: int) -> None:
    # The connection breaks before the end line: after the analysis at until_seq (3), or after the window
    # checkpoint at until_seq (2, a failed analysis). Nothing is left to read, and the platform refuses
    # afterSeq >= untilSeq.
    scan = platform.add_scan("cut")
    for n in range(6):
        platform.add_analysis(scan, status="failed" if n == 2 else "succeeded", result={"n": n})
    platform.stream_faults.drop_before_end = True
    ctx = make_context(platform)
    stream = ctx.analyses(ctx.scans[0], status="succeeded", until_seq=until_seq)
    assert [a.seq for a in stream] == [n for n in range(until_seq + 1) if n != 2]
    assert stream.complete
    assert stream.watermark == until_seq
    assert len(platform.stream_requests) == 1


def test_a_stream_resumed_at_until_seq_sends_no_request(platform: FakePlatform) -> None:
    files_scan(platform, [f"s{n}" for n in range(6)])
    ctx = make_context(platform)
    stream = ctx.analyses(ctx.scans[0], after_seq=3, until_seq=3)
    assert list(stream) == []
    assert stream.complete
    assert stream.watermark == 3
    assert not platform.stream_requests


def test_limit_caps_the_stream(platform: FakePlatform) -> None:
    files_scan(platform, [f"s{n}" for n in range(10)])
    platform.limit = 4
    platform.stream_faults.drop_after = 2
    ctx = make_context(platform)
    assert ctx.limit == 4
    stream = ctx.analyses(ctx.scans[0])
    assert [a.seq for a in stream] == [0, 1, 2, 3]
    assert stream.limited


def test_invalid_analyses_raise_or_skip(platform: FakePlatform, capsys: pytest.CaptureFixture[str]) -> None:
    scan = platform.add_scan("odd")
    platform.add_analysis(scan, result={"item": "ok", "length": 2})
    platform.add_analysis(scan, result={"item": "broken"})
    platform.add_analysis(scan, result={"item": "fine", "length": 4})

    class Small(pydantic.BaseModel):
        item: str
        length: int

    ctx = make_context(platform)
    with pytest.raises(pydantic.ValidationError) as error:
        list(ctx.analyses(ctx.scans[0], result=Small))
    assert any("analysis" in note for note in getattr(error.value, "__notes__", []))

    stream = ctx.analyses(ctx.scans[0], result=Small, invalid="skip")
    assert [a.seq for a in stream] == [0, 2]
    assert stream.skipped == 1
    assert f"skipped analysis {scan.id}-1" in capsys.readouterr().err


def test_file_url_refresh_after_403(platform: FakePlatform) -> None:
    scan = files_scan(platform, ["a.org"])
    key = next(ref["key"] for ref in scan.analyses[0]["files"] if ref["name"] == "notes.txt")
    platform.expire_once.add(key)
    ctx = make_context(platform)
    (analysis,) = list(ctx.analyses(ctx.scans[0], result=Result))
    assert analysis.result is not None
    assert analysis.read_text(analysis.result.notes) == "Notes on a.org\n"
    refreshed = [path for method, path, _ in platform.requests if method == "GET" and "/files/" in path]
    assert refreshed == [f"/analyses/{analysis.id}/files/{analysis.result.notes.id}"]
    assert [key for method, key, _ in platform.file_requests].count(key) == 2


def test_integrity_and_file_selection(platform: FakePlatform) -> None:
    scan = files_scan(platform, ["a.org"])
    ref = next(ref for ref in scan.analyses[0]["files"] if ref["name"] == "notes.txt")
    platform.objects[ref["key"]] = b"tampered"
    ctx = make_context(platform)
    (analysis,) = list(ctx.analyses(ctx.scans[0], result=Result))
    with pytest.raises(ScriptError) as error:
        analysis.read_bytes("notes.txt")
    assert error.value.code == "integrity"
    assert analysis.read_bytes("notes.txt", verify=False) == b"tampered"
    with pytest.raises(ScriptError) as missing:
        analysis.file("nope.txt")
    assert missing.value.code == "notFound"
    assert hashlib.sha256(PIXEL).hexdigest() == analysis.file("image.png").sha256


def test_file_urls_outside_the_file_store_are_refused(platform: FakePlatform) -> None:
    files_scan(platform, ["a.org"])
    ctx = make_context(platform)
    (analysis,) = list(ctx.analyses(ctx.scans[0]))
    ref = analysis.file("notes.txt")
    analysis._urls[ref.id] = f"{platform.url}/elsewhere?sig=1"
    with pytest.raises(ScriptError) as error:
        analysis.read_bytes(ref)
    assert error.value.code == "badUrl"


def test_cancellation_stops_the_stream(platform: FakePlatform) -> None:
    files_scan(platform, [f"s{n}" for n in range(5)])
    cancel = CancelState()
    ctx = make_context(platform, cancel=cancel)
    seen: list[int] = []

    def consume() -> None:
        for analysis in ctx.analyses(ctx.scans[0]):
            seen.append(analysis.seq)
            if analysis.seq == 1:
                cancel.cancel("test")

    with pytest.raises(Cancelled):
        consume()
    assert seen == [0, 1]
    assert ctx.cancelled


def test_streams_are_single_use_and_scans_resolve(platform: FakePlatform) -> None:
    files_scan(platform, ["a"])
    ctx = make_context(platform)
    stream = ctx.analyses(ctx.scans[0])
    list(stream)
    with pytest.raises(RuntimeError):
        list(stream)
    with pytest.raises(ScriptError):
        ctx.scan("missing")
    with pytest.raises(ValueError, match="status"):
        ctx.analyses(ctx.scans[0], status="done")
    assert isinstance(ctx.scans[0], Scan)


def test_count_and_aggregate(platform: FakePlatform) -> None:
    scan = platform.add_scan("counts", state="running")
    for status in ["succeeded", "failed", "succeeded", "lost"]:
        platform.add_analysis(scan, status=status, result={})
    ctx = make_context(platform)
    assert ctx.count(ctx.scans[0]) == 4
    assert ctx.count(ctx.scans[0], status="succeeded") == 2
    assert ctx.count(ctx.scans[0], status=["failed", "lost"]) == 2
    groups = ctx.aggregate("counts", [{"$group": {"_id": "$status", "n": {"$sum": 1}}}])
    assert not groups.truncated
    assert {item["_id"]: item["n"] for item in groups} == {"succeeded": 2, "failed": 1, "lost": 1}


def test_an_unnamed_scan_is_named_by_its_id(platform: FakePlatform) -> None:
    scan = platform.add_scan(None)
    ctx = make_context(platform)
    assert ctx.scans[0].name == scan.id
    assert ctx.scan(scan.id) is ctx.scans[0]


def test_counts_of_a_finished_scan_come_from_bootstrap(platform: FakePlatform) -> None:
    files_scan(platform, ["a", "b"])
    ctx = make_context(platform)
    before = len(platform.requests)
    assert ctx.count(ctx.scans[0], status="succeeded") == 2
    assert len(platform.requests) == before


def test_analysis_generic_defaults() -> None:
    analysis = Analysis[Result].model_validate(
        {"id": "x-1", "seq": 1, "status": "failed", "error": {"type": "fatal", "message": "no"}}
    )
    assert analysis.result is None
    assert analysis.error is not None
    assert analysis.error.type == "fatal"
    assert analysis.config is None
    assert analysis.files == []
