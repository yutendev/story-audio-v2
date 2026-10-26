"""T6.1 — stage TTS (MOCKED, offline): success/failure/retry, thứ tự, voice/rate,
cache hit, rerun idempotent; live TTS là smoke test opt-in qua biến LIVE_TTS=1."""

import hashlib
import json
import os
from pathlib import Path

import pytest

from story_audio import actions
from story_audio import tts as tts_mod
from story_audio.exit_codes import ExitCode
from story_audio.rewrite import chunk_text


def _seed_sidecar(wd, no, text, status="ok", corrupt_hash=False):
    d = wd / "chapters" / f"{no:04d}"
    d.mkdir(parents=True, exist_ok=True)
    text_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if corrupt_hash:
        text_sha = "0" * 64
    data = {
        "schema_version": "1.0",
        "chapter_no": no,
        "text_sha256": text_sha,
        "total_chunks": 1,
        "chapter_status": status,
        "chunks": [{
            "index": 0,
            "char_start": 0,
            "char_end": len(text),
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest() if not corrupt_hash else "0" * 64,
        }],
    }
    (d / "rewritten.chunks.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _seed_rewritten(wd, no, title, paras, write_sidecar=True):
    d = wd / "chapters" / f"{no:04d}"
    d.mkdir(parents=True, exist_ok=True)
    body = title + "\n\n" + "\n\n".join(paras) + "\n"
    (d / "rewritten.txt").write_text(body, encoding="utf-8")
    if write_sidecar:
        _seed_sidecar(wd, no, body, status="ok")
    return body


def _events(capsys):
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def _no_ffmpeg(monkeypatch):
    # concat rẽ nhánh byte-fallback — tất định, không phụ thuộc máy có ffmpeg
    monkeypatch.setattr(tts_mod.shutil, "which", lambda *_a, **_k: None)


def fake_engine(calls, fails=0):
    """Engine giả: fail `fails` lượt ĐẦU cho mỗi text rồi thành công; cache lại
    bytes đặc trưng theo nội dung để kiểm thứ tự ghép."""
    attempts: dict[str, int] = {}

    async def engine(text, voice, rate, path):
        key = text[:12]
        attempts[key] = attempts.get(key, 0) + 1
        calls.append((text, voice, rate))
        if attempts[key] <= fails:
            raise RuntimeError("mạng TTS chập trầm")
        path.write_bytes(f"mp3|{key}|".encode("utf-8") * 8)

    return engine


def fake_sleep(recorder):
    async def sleep_fn(seconds):
        recorder.append(seconds)

    return sleep_fn


def test_tts_success_statuses_artifact_and_voice_default(tmp_path, capsys, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    _seed_rewritten(wd, 12, "Chương 12", ["Đoạn một cho chương mười hai. Khép màn."])
    _seed_rewritten(wd, 13, "Chương 13", ["Đoạn một cho chương mười ba. Hết."]
                    )
    calls = []
    em = actions._Emitter("t61")
    rc = tts_mod.tts_stage({}, wd, em, engine=fake_engine(calls))
    assert rc == ExitCode.SUCCESS
    evs = _events(capsys)
    assert [e for e in evs if e["type"] == "final"][-1]["status"] == "success"
    states = [e["state"] for e in evs if e["type"] == "chapter_status"]
    assert states == ["tts_done", "tts_done"]
    arts = [e for e in evs if e["type"] == "artifact_ready"]
    assert [a["path"] for a in arts] == ["chapters/0012/audio.mp3", "chapters/0013/audio.mp3"]
    assert all(a["kind"] == "chapter_audio" for a in arts)
    audio = (wd / "chapters" / "0012" / "audio.mp3")
    assert audio.stat().st_size > 0
    # voice/rate mặc định đã truyền vào engine (port bản cũ)
    assert {v for _, v, _ in calls} == {"vi-VN-HoaiMyNeural"}
    assert {r for _, _, r in calls} == {"-10%"}
    # không để rác tmp trong chương (tmpdir được dọn sau ghép)
    assert list((wd / "chapters" / "0012").glob("*.tmp")) == []


def test_tts_voice_rate_setting_per_job(tmp_path, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    _seed_rewritten(wd, 12, "Chương 12", ["Giọng đọc khác theo job này."])
    calls = []
    rc = tts_mod.tts_stage(
        {"voice": "vi-VN-NamMinh", "rate": "+5%"},
        wd, actions._Emitter("t61"), engine=fake_engine(calls),
    )
    assert rc == ExitCode.SUCCESS
    assert {(v, r) for _, v, r in calls} == {("vi-VN-NamMinh", "+5%")}


def test_tts_invalid_rate_is_permanent(tmp_path, capsys):
    wd = tmp_path / "work"
    wd.mkdir()
    _seed_rewritten(wd, 12, "Chương 12", ["Đoạn văn."])
    rc = actions.execute_job("tts", {"rate": "nhanh hơn"}, wd, job_id="t61")
    assert rc == ExitCode.PERMANENT  # sai cấu hình job — không thèm synth
    final = [e for e in _events(capsys) if e["type"] == "final"][-1]
    assert final["status"] == "failed" and "rate" in final["summary"]


def test_tts_splits_long_text_and_keeps_order(tmp_path, capsys, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    paras = ["MỞ ĐẦU. " + "chi tiết một " * 150,
             "GIỮA TRỐNG. " + "chi tiết hai " * 150,
             "KẾT ÚC. " + "chi tiết ba " * 150]
    _seed_rewritten(wd, 12, "Chương 12", paras)
    calls = []
    rc = tts_mod.tts_stage({}, wd, actions._Emitter("t61"), engine=fake_engine(calls))
    assert rc == ExitCode.SUCCESS
    assert len(calls) >= 4  # > 1500 ký tự → tách theo câu an toàn (chunk_text T5.4)
    # thứ tự: điểm mốc MỞ ĐẦU → GIỮA TRỐNG → KẾT ÚC xuất hiện tăng dần theo lượt gọi
    seen = []
    for text, _v, _r in calls:
        for marker in ("MỞ ĐẦU", "GIỮA TRỐNG", "KẾT ÚC"):
            if marker in text and marker not in seen:
                seen.append(marker)
    assert seen == ["MỞ ĐẦU", "GIỮA TRỐNG", "KẾT ÚC"]
    # ghép byte-fallback đúng thứ tự parts (engine được gọi đúng theo thứ tự chunk)
    chunks = chunk_text(["Chương 12"] + paras)  # tái dựng đúng cách stage đã làm
    expected = b"".join((f"mp3|{c[:12]}|" * 8).encode("utf-8") for c in chunks)
    assert (wd / "chapters" / "0012" / "audio.mp3").read_bytes() == expected


def test_tts_retry_transient_then_success(tmp_path, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    _seed_rewritten(wd, 12, "Chương 12", ["Chỉ một đoạn để đo retry."])
    sleeps = []
    calls = []
    rc = tts_mod.tts_stage(
        {}, wd, actions._Emitter("t61"),
        engine=fake_engine(calls, fails=2), sleep_fn=fake_sleep(sleeps),
    )
    assert rc == ExitCode.SUCCESS
    assert sleeps == [2, 4]  # bounded backoff min(30, 2^n) trước khi thành công
    assert len(calls) == 3   # 2 lần chập + 1 lần thành công
    assert (wd / "chapters" / "0012" / "audio.mp3").stat().st_size > 0


def test_tts_exhausted_retries_is_retryable(tmp_path, capsys, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    _seed_rewritten(wd, 12, "Chương 12", ["Đoạn để đo cạn retry."])
    sleeps = []
    rc = tts_mod.tts_stage(
        {}, wd, actions._Emitter("t61"),
        engine=fake_engine([], fails=999), sleep_fn=fake_sleep(sleeps),
    )
    assert rc == ExitCode.RETRYABLE  # TTS lỗi tạm thời — Node schedule lại, không DEAD
    evs = _events(capsys)
    assert [e for e in evs if e["type"] == "final"][-1]["status"] == "failed"
    err = [e for e in evs if e["type"] == "error"][-1]
    assert err["retryable"] is True
    assert sleeps == [min(30, 2 ** k) for k in range(1, tts_mod.TTS_RETRIES + 1)]
    assert not (wd / "chapters" / "0012" / "audio.mp3").exists()


def test_tts_cache_hit_avoids_second_call(tmp_path, capsys, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    _seed_rewritten(wd, 12, "Chương 12", ["Đoạn một duy nhất để chạy lại."])
    calls1 = []
    rc1 = tts_mod.tts_stage({}, wd, actions._Emitter("t61"), engine=fake_engine(calls1))
    assert rc1 == ExitCode.SUCCESS
    audio1 = (wd / "chapters" / "0012" / "audio.mp3").read_bytes()
    cache_after_run1 = sorted(p.name for p in (wd / "tts-cache").glob("*.mp3"))
    calls2 = []
    rc2 = tts_mod.tts_stage({}, wd, actions._Emitter("t61b"), engine=fake_engine(calls2))
    assert rc2 == ExitCode.SUCCESS
    assert calls2 == []                     # mọi chunk đến từ cache mp3
    assert (wd / "chapters" / "0012" / "audio.mp3").read_bytes() == audio1  # đầu ra ổn định
    # T6.3: chạy lại không tích lũy file cục bộ — cache giữ nguyên số entry, tmp đã dọn
    assert sorted(p.name for p in (wd / "tts-cache").glob("*.mp3")) == cache_after_run1
    assert not (wd / "tts-tmp" / "0012").exists()


def test_tts_rerun_reuses_existing_audio(tmp_path, capsys, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    _seed_rewritten(wd, 12, "Chương 12", ["Đoạn văn đã đọc từ trước."])
    out = wd / "chapters" / "0012" / "audio.mp3"
    out.write_bytes(b"mp3-da-co-truoc")
    calls = []
    rc = tts_mod.tts_stage({}, wd, actions._Emitter("t61"), engine=fake_engine(calls))
    assert rc == ExitCode.SUCCESS
    assert calls == []  # đã có mp3 — không tái synth
    arts = [e for e in _events(capsys) if e["type"] == "artifact_ready"]
    assert arts[0]["checksum"] == hashlib.sha256(b"mp3-da-co-truoc").hexdigest()


def test_tts_without_chapters_is_permanent(tmp_path, capsys):
    rc = tts_mod.tts_stage({}, tmp_path / "work", actions._Emitter("t61"))
    assert rc == ExitCode.PERMANENT
    evs = _events(capsys)
    assert [e for e in evs if e["type"] == "final"][-1]["status"] == "failed"


def test_tts_skip_missing_rewritten_needs_review(tmp_path, capsys, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    d = wd / "chapters" / "0007"
    d.mkdir(parents=True)
    (d / "text.txt").write_text("Chương 7\n\nraw thôi.\n", encoding="utf-8")  # không rewritten
    rc = tts_mod.tts_stage({}, wd, actions._Emitter("t61"), engine=fake_engine([]))
    assert rc == ExitCode.NEEDS_REVIEW  # không bao giờ đọc text chưa qua rewrite/QA
    final = [e for e in _events(capsys) if e["type"] == "final"][-1]
    assert "1 chương thiếu rewritten.txt" in final["summary"]


class FakeCommunicate:
    def __init__(self, text, voice, rate="+0%"):
        self.text = text

    async def save(self, path):
        Path(path).write_bytes(("::" + self.text[:12]).encode("utf-8") * 3)


def test_tts_dispatch_via_execute_job(monkeypatch, tmp_path):
    # dispatch wiring qua execute_job — engine thật được thay bằng fake Communicate
    monkeypatch.setattr(tts_mod, "edge_tts", type("M", (), {"Communicate": FakeCommunicate}))
    monkeypatch.setattr(tts_mod.shutil, "which", lambda *_a, **_k: None)
    wd = tmp_path / "work"
    wd.mkdir()
    _seed_rewritten(wd, 12, "Chương 12", ["Đoạn văn cho dispatch test."])
    rc = actions.execute_job("tts", {}, wd, job_id="t61")
    assert rc == ExitCode.SUCCESS and (wd / "chapters" / "0012" / "audio.mp3").stat().st_size > 0


@pytest.mark.skipif(os.environ.get("LIVE_TTS") != "1",
                    reason="live TTS chỉ chạy khi LIVE_TTS=1 (opt-in, cần mạng)")
def test_live_tts_smoke(tmp_path, capsys):
    """Chạy edge-tts thật - chỉ bật khi LIVE_TTS=1; mặc định bị skip."""
    wd = tmp_path / "work"
    wd.mkdir()
    _seed_rewritten(wd, 12, "Chương thử live", ["Một câu rất ngắn để đọc thật."])
    rc = tts_mod.tts_stage({}, wd, actions._Emitter("t61live"))
    assert rc == ExitCode.SUCCESS
    assert (wd / "chapters" / "0012" / "audio.mp3").stat().st_size > 0


def test_t1_tts_rejects_blocked_chapter(tmp_path, capsys, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    text = _seed_rewritten(wd, 1, "Chương 1", ["Nội dung chương một."])
    _seed_sidecar(wd, 1, text, status="blocked")
    calls = []
    em = actions._Emitter("t1")
    rc = tts_mod.tts_stage({}, wd, em, engine=fake_engine(calls))
    assert rc != ExitCode.SUCCESS
    evs = _events(capsys)
    statuses = [e for e in evs if e["type"] == "chapter_status"]
    assert any(s["chapter_no"] == 1 and s["state"] == "failed" for s in statuses)
    assert not (wd / "chapters" / "0001" / "audio.mp3").exists()
    assert len(calls) == 0


def test_t2_tts_rejects_needs_review_without_flag(tmp_path, capsys, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    text = _seed_rewritten(wd, 2, "Chương 2", ["Nội dung chương hai."])
    _seed_sidecar(wd, 2, text, status="needs_review")
    calls = []
    em = actions._Emitter("t2")
    rc = tts_mod.tts_stage({}, wd, em, engine=fake_engine(calls))
    assert rc != ExitCode.SUCCESS
    evs = _events(capsys)
    statuses = [e for e in evs if e["type"] == "chapter_status"]
    assert any(s["chapter_no"] == 2 and s["state"] == "failed" for s in statuses)
    assert not (wd / "chapters" / "0002" / "audio.mp3").exists()
    assert len(calls) == 0


def test_t3_tts_allows_needs_review_with_flag(tmp_path, capsys, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    text = _seed_rewritten(wd, 3, "Chương 3", ["Nội dung chương ba."])
    _seed_sidecar(wd, 3, text, status="needs_review")
    calls = []
    em = actions._Emitter("t3")
    rc = tts_mod.tts_stage({"allow_fallback_tts": True}, wd, em, engine=fake_engine(calls))
    assert rc == ExitCode.SUCCESS
    evs = _events(capsys)
    statuses = [e for e in evs if e["type"] == "chapter_status"]
    assert any(s["chapter_no"] == 3 and s["state"] == "tts_done" for s in statuses)
    assert (wd / "chapters" / "0003" / "audio.mp3").stat().st_size > 0
    assert len(calls) > 0


def test_t4_tts_rejects_missing_or_corrupt_sidecar(tmp_path, capsys, monkeypatch):
    _no_ffmpeg(monkeypatch)
    wd = tmp_path / "work"
    wd.mkdir()
    # Chương 4: thiếu sidecar hoàn toàn
    _seed_rewritten(wd, 4, "Chương 4", ["Nội dung chương bốn."], write_sidecar=False)
    # Chương 5: có sidecar nhưng hash lệch
    text5 = _seed_rewritten(wd, 5, "Chương 5", ["Nội dung chương năm."])
    _seed_sidecar(wd, 5, text5, status="ok", corrupt_hash=True)
    calls = []
    em = actions._Emitter("t4")
    rc = tts_mod.tts_stage({}, wd, em, engine=fake_engine(calls))
    assert rc != ExitCode.SUCCESS
    evs = _events(capsys)
    statuses = [e for e in evs if e["type"] == "chapter_status"]
    assert any(s["chapter_no"] == 4 and s["state"] == "failed" for s in statuses)
    assert any(s["chapter_no"] == 5 and s["state"] == "failed" for s in statuses)
    assert not (wd / "chapters" / "0004" / "audio.mp3").exists()
    assert not (wd / "chapters" / "0005" / "audio.mp3").exists()
    assert len(calls) == 0

