"""ctx.outputs: whole values and streamed files as multipart uploads, partial outputs, resume outputs."""

import csv
import hashlib
from pathlib import Path

import pytest

from scantor.script import Cancelled, ScriptContext, ScriptError
from tests.script_fake import RUN_ID, FakePlatform, Fault
from tests.script_support import make_context


def test_put_bytes_text_and_paths(platform: FakePlatform, tmp_path: Path) -> None:
    ctx = make_context(platform)
    payload = bytes(range(256)) * 3  # 768 bytes: 12 parts of 64 bytes
    output = ctx.outputs.put("blob.bin", payload)
    assert (output.name, output.size, output.sha256) == ("blob.bin", 768, hashlib.sha256(payload).hexdigest())
    assert output.content_type == "application/octet-stream"
    stored = platform.stored_outputs()["blob.bin"]
    assert stored.data == payload
    assert stored.reported_sha256 == stored.sha256
    assert len([key for method, key, _ in platform.file_requests if method == "PUT"]) == 12

    ctx.outputs.put("summary.json", '{"ok": true}')
    assert platform.stored_outputs()["summary.json"].content_type == "application/json"
    source = tmp_path / "report.csv"
    source.write_text("a,b\n" * 100, encoding="utf-8")
    ctx.outputs.put("report.csv", source)
    stored_csv = platform.stored_outputs()["report.csv"]
    assert stored_csv.data == source.read_bytes()
    assert stored_csv.content_type == "text/csv"
    assert output.read_bytes() == payload


def test_open_streams_parts(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    with ctx.outputs.open("rows.csv") as file:
        writer = csv.writer(file)
        for n in range(1000):
            writer.writerow([n, f"name-{n}", "é"])
        # Parts are uploaded while the file is written (past the text layer's own 8 KiB buffer).
        puts = [key for method, key, _ in platform.file_requests if method == "PUT"]
        assert len(puts) >= 100
        assert "rows.csv" not in platform.stored_outputs()
    stored = platform.stored_outputs()["rows.csv"]
    text = stored.data.decode("utf-8")
    assert text.startswith("0,name-0,é\r\n")
    assert text.count("\r\n") == 1000
    assert stored.reported_sha256 == hashlib.sha256(stored.data).hexdigest()

    with ctx.outputs.open("raw.bin", "wb") as binary:
        binary.write(b"\x00" * 200)
    assert platform.stored_outputs()["raw.bin"].data == b"\x00" * 200


def _write_then_fail(ctx: ScriptContext, name: str, data: bytes, error: BaseException) -> None:
    with ctx.outputs.open(name, "wb") as file:
        file.write(data)
        raise error


def test_exception_stores_a_partial_output(platform: FakePlatform, capsys: pytest.CaptureFixture[str]) -> None:
    ctx = make_context(platform)
    with pytest.raises(RuntimeError, match="boom"):
        _write_then_fail(ctx, "rows.csv", b"first\n" * 20, RuntimeError("boom"))
    stored = platform.stored_outputs()
    assert "rows.csv" not in stored
    assert stored["rows.csv.partial"].data == b"first\n" * 20
    assert "rows.csv.partial" in capsys.readouterr().err

    # More than one part was uploaded: the upload is completed under the new name.
    complete = [body for method, path, body in platform.requests if path.endswith("/complete")]
    assert complete[-1] is not None
    assert complete[-1]["name"] == "rows.csv.partial"

    # Less than one part, still in memory: a new output of the new name holds it.
    with pytest.raises(Cancelled):
        _write_then_fail(ctx, "cancelled.txt", b"x" * 10, Cancelled("cancelled: test"))
    assert platform.stored_outputs()["cancelled.txt.partial"].data == b"x" * 10
    assert "cancelled.txt" not in platform.stored_outputs()
    complete = [body for method, path, body in platform.requests if path.endswith("/complete")]
    assert complete[-1] is not None
    assert "name" not in complete[-1]


def _write_two_parts(ctx: ScriptContext, name: str, platform: FakePlatform, fault: str, faults: list[Fault]) -> None:
    """Write two parts of 64 bytes; part 2 fails with `faults` at its upload (`PUT`) or its presign (`POST`)."""
    with ctx.outputs.open(name, "wb") as binary:
        output_id = next(output.id for output in platform.outputs.values() if output.name == name)
        key = f"PUT parts/{output_id}/2" if fault == "PUT" else f"POST /outputs/{output_id}/parts"
        binary.write(b"a" * 64)  # part 1 is uploaded
        platform.faults[key] = list(faults)
        binary.write(b"b" * 64)  # part 2 fails


@pytest.mark.parametrize(
    ("fault", "status", "code"),
    [("PUT", 400, "fileStore"), ("POST", 413, "payloadTooLarge")],
    ids=["rejected-part", "output-cap"],
)
def test_a_failed_part_propagates_and_stores_a_partial_output(
    platform: FakePlatform, capsys: pytest.CaptureFixture[str], fault: str, status: int, code: str
) -> None:
    ctx = make_context(platform)
    # Part 2 fails once: storing the partial output uploads it again, so it holds every byte.
    with pytest.raises(ScriptError) as error:
        _write_two_parts(ctx, "once.bin", platform, fault, [(status, code)])
    assert (error.value.status, error.value.code) == (status, code)
    assert platform.stored_outputs()["once.bin.partial"].data == b"a" * 64 + b"b" * 64

    # Part 2 keeps failing: the partial output holds the part uploaded before.
    with pytest.raises(ScriptError) as error:
        _write_two_parts(ctx, "always.bin", platform, fault, [(status, code)] * 2)
    assert (error.value.status, error.value.code) == (status, code)
    stored = platform.stored_outputs()["always.bin.partial"]
    assert stored.data == b"a" * 64
    assert stored.reported_sha256 == hashlib.sha256(b"a" * 64).hexdigest()
    assert "storing the 64 bytes uploaded before" in capsys.readouterr().err
    assert not platform.violations


def _fail_with_an_unstorable_partial(ctx: ScriptContext, platform: FakePlatform) -> None:
    with ctx.outputs.open("lost.bin", "wb") as binary:
        binary.write(b"z" * 10)
        platform.faults["POST /outputs"] = [(409, "alreadyExists")]  # creating lost.bin.partial fails
        raise RuntimeError("boom")


def test_a_failing_partial_output_never_replaces_the_error(
    platform: FakePlatform, capsys: pytest.CaptureFixture[str]
) -> None:
    ctx = make_context(platform)
    with pytest.raises(RuntimeError, match="boom"):
        _fail_with_an_unstorable_partial(ctx, platform)
    assert "lost.bin.partial" not in platform.stored_outputs()
    assert "could not store the partial output 'lost.bin'" in capsys.readouterr().err


def test_names_and_empty_outputs(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    with pytest.raises(ValueError, match="must not contain"):
        ctx.outputs.put("a/b.txt", b"x")
    with pytest.raises(ValueError, match="1-255"):
        ctx.outputs.put("", b"x")
    with pytest.raises(ValueError, match="empty"):
        ctx.outputs.put("empty.txt", b"")
    ctx.outputs.put("once.txt", b"1")
    with pytest.raises(ScriptError) as error:
        ctx.outputs.put("once.txt", b"2")
    assert error.value.code == "alreadyExists"
    assert error.value.status == 409


def test_retries_and_expired_part_urls(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    platform.faults["POST /outputs"] = [503, 429]
    output_id_holder: list[str] = []

    with ctx.outputs.open("retried.bin", "wb") as binary:
        output_id_holder.append(next(iter(platform.outputs)))
        platform.faults[f"PUT parts/{output_id_holder[0]}/1"] = [503]
        platform.faults[f"PUT parts/{output_id_holder[0]}/2"] = [403]
        binary.write(b"y" * 130)
    assert platform.stored_outputs()["retried.bin"].data == b"y" * 130
    presigns = [body for method, path, body in platform.requests if path.endswith("/parts")]
    assert [body["partNumber"] for body in presigns if body] == [1, 2, 2, 3]


def test_retry_budget_runs_out(platform: FakePlatform) -> None:
    ctx = make_context(platform)
    platform.faults["POST /progress"] = [503] * 1000
    platform.retry_after = None
    with pytest.raises(ScriptError) as error:
        ctx._client.call("POST", "/progress", {"done": 1})
    assert error.value.code == "unavailable"
    assert error.value.retryable


def test_resume_outputs(platform: FakePlatform) -> None:
    earlier = platform.seed_output("rows.csv.partial", b"seq\n1\n2\n")
    platform.resume = {"runId": RUN_ID, "checkpoint": {"after_seq": 2}, "outputs": [earlier]}
    ctx = make_context(platform)
    assert ctx.resume_state == {"after_seq": 2}
    (output,) = ctx.resume_outputs
    assert output.name == "rows.csv.partial"
    assert output.size == 8
    assert output.read_bytes() == b"seq\n1\n2\n"
    with output.open() as source:
        assert source.read() == b"seq\n1\n2\n"
