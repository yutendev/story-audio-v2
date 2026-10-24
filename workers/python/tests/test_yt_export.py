"""T7.5 — stage yt_export (MOCKED, offline): MP4 16:9 từ book.m4b + cover; description
00:00 đầu, tăng dần, khớp boundary chương; sai output = PERMANENT; live opt-in
LIVE_FFMPEG=1 (chạy thật sau stage package live — không bao giờ chạy mặc định)."""

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from story_audio.actions import _Emitter, execute_job
from story_audio.exit_codes import ExitCode
from story_audio.yt_export import build_description

SEQ = 1
PKG = "packages/0001"


def _events(capsys):
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def _seed(wd, book_bytes=b"fake-m4b-bytes", cover=True):
    pkg = wd / PKG
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / "book.m4b").write_bytes(book_bytes)
    if cover:
        (pkg / "cover.jpg").write_bytes(b"\xff\xd8-fake-jpeg")


def _m4b_doc(chapters, duration="7.25"):
    return {
        "format": {"duration": duration, "format_name": "mov,mp4,m4a"},
        "chapters": [
            {"start_time": str(s), "tags": {"title": t}} for s, t in chapters
        ],
    }


def _mp4_doc(duration="7.25", width=1920, height=1080, video_codec="h264",
             audio_codec="aac", format_name="mov,mp4,m4a,ipod", video=True, audio=True):
    streams = []
    if video:
        streams.append({"codec_type": "video", "codec_name": video_codec,
                        "width": width, "height": height})
    if audio:
        streams.append({"codec_type": "audio", "codec_name": audio_codec})
    return {"format": {"duration": duration, "format_name": format_name}, "streams": streams}


def _fake_probe(m4b_doc, mp4_doc=None, ffmpeg_rc=0):
    """Seam chung: ffprobe book.m4b → m4b_doc; ffmpeg → ghi book.mp4 giả;
    ffprobe book.mp4 → mp4_doc (validate)."""
    calls = []

    def runner(argv):
        calls.append(argv)
        if argv[0] == "ffmpeg":
            if ffmpeg_rc != 0:
                return ffmpeg_rc, "", "ffmpeg calamity"
            Path(argv[-1]).write_bytes(b"fake-mp4-bytes")
            return 0, "", ""
        target = Path(argv[-1])
        if target.name == "book.m4b":
            return 0, json.dumps(m4b_doc), ""
        if target.name == "book.mp4":
            return 0, json.dumps(mp4_doc or {}), ""
        return 1, "", "Invalid data"

    return runner, calls


CHAPTERS = [(0.0, "C1"), (3.0, "C2")]


def test_yt_export_success(tmp_path, capsys):
    wd = tmp_path
    _seed(wd)
    runner, calls = _fake_probe(_m4b_doc(CHAPTERS), _mp4_doc())
    rc = execute_job("yt_export", {"sequence": 1}, wd, job_id="t75", probe_runner=runner)
    assert rc == ExitCode.SUCCESS

    events = _events(capsys)
    artifacts = [e for e in events if e["type"] == "artifact_ready"]
    assert [(a["kind"], a["path"]) for a in artifacts] == [
        ("mp4", "packages/0001/book.mp4"),
        ("description", "packages/0001/description.txt"),
    ]
    assert artifacts[0]["checksum"] == hashlib.sha256(b"fake-mp4-bytes").hexdigest()

    argv = next(c for c in calls if c[0] == "ffmpeg")
    assert all(isinstance(a, str) for a in argv)
    assert "-c:a" in argv and "copy" in argv[argv.index("-c:a") :]
    assert "scale=1920:1080" in argv[argv.index("-filter_complex") + 1]
    assert argv[-2] == "mp4" and argv[-1].endswith("book.mp4")
    assert "-loop" in argv  # cover loop 1 frame/giây

    desc = (wd / "packages" / "0001" / "description.txt").read_text(encoding="utf-8")
    assert desc == "Gói 1\n\n00:00:00 C1\n00:00:03 C2\n"  # đầu 00:00 + khớp boundary

    progress = [e for e in events if e["type"] == "progress"]
    assert [p["done"] for p in progress] == [1, 2]
    final = [e for e in events if e["type"] == "final"][-1]
    assert final["status"] == "success"


def test_yt_export_title_override(tmp_path, capsys):
    wd = tmp_path
    _seed(wd)
    runner, _calls = _fake_probe(_m4b_doc(CHAPTERS), _mp4_doc())
    rc = execute_job(
        "yt_export", {"sequence": 1, "title": "Truyện Chạy Bộ"}, wd, job_id="t75",
        probe_runner=runner,
    )
    assert rc == ExitCode.SUCCESS
    desc = (wd / "packages" / "0001" / "description.txt").read_text(encoding="utf-8")
    assert desc.startswith("Truyện Chạy Bộ\n")


def test_yt_export_missing_m4b_no_ffmpeg(tmp_path, capsys):
    wd = tmp_path
    _seed(wd, cover=True)
    (wd / PKG / "book.m4b").unlink()
    runner, calls = _fake_probe(_m4b_doc(CHAPTERS))
    rc = execute_job("yt_export", {"sequence": 1}, wd, job_id="t75", probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    assert calls == []
    final = [e for e in _events(capsys) if e["type"] == "final"][-1]
    assert "book.m4b" in final["summary"]


def test_yt_export_missing_cover(tmp_path, capsys):
    wd = tmp_path
    _seed(wd, cover=False)
    runner, calls = _fake_probe(_m4b_doc(CHAPTERS))
    rc = execute_job("yt_export", {"sequence": 1}, wd, job_id="t75", probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    assert calls == []
    final = [e for e in _events(capsys) if e["type"] == "final"][-1]
    assert "cover" in final["summary"]


def test_yt_export_cover_override_path(tmp_path, capsys):
    wd = tmp_path
    _seed(wd, cover=False)
    # cover ở nơi khác (Node copy vào sau prepare) — payload trỏ thẳng
    custom = wd / "uploads" / "anh-cua-toi.png"
    custom.parent.mkdir(parents=True, exist_ok=True)
    custom.write_bytes(b"\x89PNG-fake")
    runner, calls = _fake_probe(_m4b_doc(CHAPTERS), _mp4_doc())
    rc = execute_job(
        "yt_export", {"sequence": 1, "cover_rel": "uploads/anh-cua-toi.png"}, wd,
        job_id="t75", probe_runner=runner,
    )
    assert rc == ExitCode.SUCCESS
    assert any(c[0] == "ffmpeg" for c in calls)


def test_yt_export_ffmpeg_fail(tmp_path, capsys):
    wd = tmp_path
    _seed(wd)
    runner, _calls = _fake_probe(_m4b_doc(CHAPTERS), _mp4_doc(), ffmpeg_rc=2)
    rc = execute_job("yt_export", {"sequence": 1}, wd, job_id="t75", probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    final = [e for e in _events(capsys) if e["type"] == "final"][-1]
    assert "ffmpeg" in final["summary"]


def test_yt_export_mp4_wrong_resolution(tmp_path, capsys):
    wd = tmp_path
    _seed(wd)
    runner, _calls = _fake_probe(
        _m4b_doc(CHAPTERS), _mp4_doc(width=1280, height=720)  # sai 16:9 chuẩn 1080p
    )
    rc = execute_job("yt_export", {"sequence": 1}, wd, job_id="t75", probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    assert any("1920x1080" in e["message"] for e in _events(capsys) if e["type"] == "error")


def test_yt_export_mp4_no_video(tmp_path, capsys):
    wd = tmp_path
    _seed(wd)
    runner, _calls = _fake_probe(_m4b_doc(CHAPTERS), _mp4_doc(video=False))
    rc = execute_job("yt_export", {"sequence": 1}, wd, job_id="t75", probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    assert any("video" in e["message"] for e in _events(capsys) if e["type"] == "error")


def test_yt_export_mp4_duration_off(tmp_path, capsys):
    wd = tmp_path
    _seed(wd)
    runner, _calls = _fake_probe(_m4b_doc(CHAPTERS), _mp4_doc(duration="15.0"))
    rc = execute_job("yt_export", {"sequence": 1}, wd, job_id="t75", probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    assert any("duration lệch" in e["message"] for e in _events(capsys) if e["type"] == "error")


def test_yt_export_bad_sequence(tmp_path, capsys):
    for bad in (0, "x", True, None, 1.5):
        rc = execute_job("yt_export", {"sequence": bad}, tmp_path, job_id="t75")
        assert rc == ExitCode.PERMANENT
        final = [e for e in _events(capsys) if e["type"] == "final"][-1]
        assert final["status"] == "failed"


def test_description_monotonic_and_start_zero():
    # boundary chương thật; giây bị làm tròn phải không-giảm
    desc = build_description(
        "T", [(0.0, "A"), (0.4, "B"), (0.7, "C"), (1.2, "D")]
    )
    lines = desc.splitlines()
    assert lines[0] == "T" and lines[1] == ""
    stamps = [line.split(" ")[0] for line in lines[2:]]
    assert stamps == ["00:00:00", "00:00:00", "00:00:01", "00:00:01"]  # non-decreasing
    # ứng với start tăng dần (0, 0.4, 0.7, 1.2)
    assert all(t.endswith(name) for t, name in zip(lines[2:], ["A", "B", "C", "D"]))


def test_description_hour_format():
    desc = build_description("T", [(3665.0, "Muộn")])
    assert "01:01:05 Muộn" in desc


def test_yt_export_live_opt_in(tmp_path, capsys):
    if os.environ.get("LIVE_FFMPEG") != "1":
        pytest.skip("live ffmpeg: chỉ chạy khi LIVE_FFMPEG=1")
    from story_audio.actions import execute_job as run_action
    from story_audio.package import package_stage

    wd = tmp_path
    pkg = wd / "packages" / "0001"
    parts = pkg / "parts"
    parts.mkdir(parents=True, exist_ok=True)
    # 2 mp3 sine thật + metadata + concat → package_stage thật → book.m4b có chapters
    chapters = [
        {"no": 1, "title": "C1", "audio": "packages/0001/parts/audio-0001.mp3"},
        {"no": 2, "title": "C2", "audio": "packages/0001/parts/audio-0002.mp3"},
    ]
    for i in (1, 2):
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
             "-c:a", "libmp3lame", "-b:a", "32k", str(parts / f"audio-000{i}.mp3")],
            check=True,
        )
    (pkg / "manifest.json").write_text(
        json.dumps({"sequence": 1, "chapters": chapters}, ensure_ascii=False),
        encoding="utf-8",
    )
    assert package_stage({"sequence": 1}, wd, _Emitter("t75")) == ExitCode.SUCCESS

    # cover thật từ ffmpeg color source
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
         "-f", "lavfi", "-i", "color=c=red:size=640x480:rate=1",
         "-frames:v", "1", str(pkg / "cover.jpg")],
        check=True,
    )
    rc = run_action("yt_export", {"sequence": 1, "title": "Live"}, wd, job_id="t75")
    assert rc == ExitCode.SUCCESS
    artifacts = [e for e in _events(capsys) if e["type"] == "artifact_ready"]
    assert {a["kind"] for a in artifacts} == {"mp4", "description"}
    desc = (pkg / "description.txt").read_text(encoding="utf-8")
    assert desc.startswith("Live\n\n00:00:00 C1\n")
