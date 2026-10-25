import io
import json

import pytest

from story_audio import events
from story_audio.events import ProtocolError, decode, encode, emit, event, validate


def base(ev_type, seq=0, **payload):
    return event("j1", ev_type, seq, **payload)


def test_event_types_match_spec():
    assert set(events.EVENT_TYPES) == {
        "stage_started", "progress", "chapter_status", "artifact_ready",
        "quota_wait", "needs_review", "error", "final",
    }


def test_encode_roundtrip(tmp_path):
    ev = base("progress", stage="tts", done=3, total=10)
    line = encode(ev)
    assert isinstance(line, str) and line.endswith("")
    assert json.loads(line) == ev
    assert decode(line) == ev


def test_emit_writes_single_jsonl_line():
    buf = io.StringIO()
    emit(base("chapter_status", chapter_no=5, state="NORMALIZED"), buf)
    assert buf.getvalue().count("\n") == 1
    assert isinstance(json.loads(buf.getvalue().strip()), dict)
    # stdout protocol-only: không log thường chen vào
    log_buf = io.StringIO()
    events.log("log thường", log_buf)
    assert "log" in log_buf.getvalue()


def test_progress_event():
    ev = base("progress", stage="extract", done=1, total=9)
    assert validate(decode(encode(ev)))["done"] == 1
    with pytest.raises(ProtocolError):
        validate(base("progress", stage="extract", done=5, total=3))


def test_artifact_ready_event():
    ev = base("artifact_ready", path="chapters/0001/rewritten.txt",
              kind="rewritten_text", checksum="a" * 64)
    decoded = decode(encode(ev))
    assert decoded["kind"] == "rewritten_text"

    # path tuyệt đối dấu từ chối (Node sẽ xác minh nằm trong workdir)
    with pytest.raises(ProtocolError):
        validate(base("artifact_ready", path="/etc/passwd", kind="m4b", checksum="a" * 64))
    with pytest.raises(ProtocolError):
        validate(base("artifact_ready", path="a/../../b", kind="m4b", checksum="a" * 64))
    with pytest.raises(ProtocolError):
        validate(base("artifact_ready", path="ch\\" + "\\", kind="m4b", checksum="a" * 64))
    with pytest.raises(ProtocolError):
        validate(base("artifact_ready", path="chapters/1.mp3", kind="chapter_audio", checksum="xy" ))


def test_error_event():
    ev = base("error", message="429 rate-limit", retryable=True, stage="rewrite")
    assert decode(encode(ev))["retryable"] is True
    with pytest.raises(ProtocolError):
        validate(base("error", message="x", retryable="yes"))


def test_malformed_json_line_raises(tmp_path):
    with pytest.raises(ProtocolError):
        decode("{khong phai json")
    with pytest.raises(ProtocolError):
        decode("[1, 2]")


def test_unknown_or_missing_fields_rejected():
    with pytest.raises(ProtocolError):
        decode(json.dumps({"protocol": "1", "type": "lạ", "seq": 0, "job_id": "j"}))
    with pytest.raises(ProtocolError):
        decode(json.dumps({"type": "progress", "stage": "s", "done": 1, "total": 2}))  # thiếu 4 trường gốc
    with pytest.raises(ProtocolError):
        decode(json.dumps({"protocol": "9", "type": "final", "seq": 0, "job_id": "j",
                           "status": "success", "summary": "x"}))


def test_seq_rules():
    with pytest.raises(ProtocolError):
        validate(base("stage_started", stage="x", seq=-1))
    with pytest.raises(ProtocolError):
        validate(base("stage_started", stage="x", seq=True))


def test_final_event_statuses():
    for status in ("success", "failed", "needs_review", "quota_wait"):
        assert validate(base("final", status=status, summary="s"))["status"] == status
    with pytest.raises(ProtocolError):
        validate(base("final", status="kệ", summary="s"))


def test_emit_fallback_on_unicode_encode_error():
    """T1.3/Phase 1: khi stream bị lỗi mã hóa (ví dụ cp1252), emit tự động fallback sang ASCII JSON."""
    class CP1252Stream(io.StringIO):
        def write(self, s):
            s.encode("cp1252")  # ném UnicodeEncodeError nếu có ký tự ngoài cp1252
            return super().write(s)

    buf = CP1252Stream()
    ev = base("progress", stage="tts", done=1, total=2, message="Đang thu âm giọng đọc AI: Chương 12")
    emit(ev, buf)
    val = buf.getvalue().strip()
    assert "\\u0110" in val  # Ký tự 'Đ' được escape thành \\u0110 an toàn
    decoded = json.loads(val)
    assert decoded["message"] == "Đang thu âm giọng đọc AI: Chương 12"

