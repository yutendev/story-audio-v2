"""T7.3 — stage package (MOCKED, offline): thành công/từ chối đầu vào, ffmpeg lỗi,
output không đạt kiểm tra; kiểm metadata/list/argv array/escaping; live ffmpeg
là smoke opt-in qua env LIVE_FFMPEG=1 (không bao giờ chạy mặc định)."""

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from story_audio.actions import _Emitter, execute_job
from story_audio.exit_codes import ExitCode
from story_audio.package import build_concat_list, build_ffmetadata, package_stage


def _events(capsys):
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def _seed(wd, chapters, title=None, extra=None):
    """Tạo packages/0001/manifest.json + rác mp3 cho từng entry (probe sẽ fake)."""
    pkg = wd / "packages" / "0001"
    (pkg / "parts").mkdir(parents=True, exist_ok=True)
    manifest = {"sequence": 1, "chapters": chapters, **(extra or {})}
    if title is not None:
        manifest["title"] = title
    (pkg / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    for ch in chapters:
        (wd / ch["audio"]).write_bytes(b"\xff\xfb" + bytes([ch["no"] % 256]) * 100)
    return pkg


def _fake_probe(durations, out_doc=None, ffmpeg_rc=0):
    """Seam chung argv → (rc, out, err): ffprobe đầu vào theo tên file;
    ffmpeg ghi file giả (argv[-1]); ffprobe output (-show_chapters) → out_doc."""
    calls = []

    def runner(argv):
        calls.append(argv)
        if argv[0] == "ffmpeg":
            if ffmpeg_rc != 0:
                return ffmpeg_rc, "", "ffmpeg calamity"
            Path(argv[-1]).write_bytes(b"fake-m4b-bytes")
            return 0, "", ""
        if "-show_chapters" in argv:
            return 0, json.dumps(out_doc or {}), ""
        d = durations.get(Path(argv[-1]).name)
        if d is None:
            return 1, "", "Invalid data found"
        return 0, json.dumps({"format": {"duration": str(d)}}), ""

    return runner, calls


def _out_doc(duration, starts, titles):
    return {
        "format": {"duration": str(duration)},
        "chapters": [{"start_time": str(s), "tags": {"title": t}} for s, t in zip(starts, titles)],
    }


CHAPTERS_2 = [
    {"no": 1, "title": "C1", "audio": "packages/0001/parts/audio-0001.mp3"},
    {"no": 2, "title": "C2", "audio": "packages/0001/parts/audio-0002.mp3"},
]


def test_package_success(tmp_path, capsys):
    wd = tmp_path
    pkg = _seed(wd, CHAPTERS_2)
    runner, calls = _fake_probe(
        durations={"audio-0001.mp3": 3.0, "audio-0002.mp3": 4.25},
        out_doc=_out_doc(7.25, [0.0, 3.0], ["C1", "C2"]),
    )

    rc = package_stage({"sequence": 1}, wd, _Emitter("t73"), probe_runner=runner)
    assert rc == ExitCode.SUCCESS

    events = _events(capsys)
    artifact = [e for e in events if e["type"] == "artifact_ready"][-1]
    assert artifact["kind"] == "m4b"
    assert artifact["path"] == "packages/0001/book.m4b"
    assert artifact["checksum"] == hashlib.sha256(b"fake-m4b-bytes").hexdigest()

    final = [e for e in events if e["type"] == "final"][-1]
    assert final["status"] == "success" and "2 chương" in final["summary"]

    # parts/ dọn sau khi thành công — audio nguồn còn nguyên trên R2 (verified)
    assert not (pkg / "parts").exists()

    # list.txt: ffconcat, path so với list dir
    list_text = (pkg / "list.txt").read_text(encoding="utf-8")
    assert list_text.splitlines()[0] == "ffconcat version 1.0"
    assert "file 'parts/audio-0001.mp3'" in list_text
    assert "file 'parts/audio-0002.mp3'" in list_text

    # metadata: TIMEBASE 1/1000, ms tích lũy 0→3000→7250, tiêu đề chapter
    meta = (pkg / "ffmetadata.txt").read_text(encoding="utf-8")
    assert meta.startswith(";FFMETADATA1\n")
    assert "START=0\nEND=3000\ntitle=C1\n" in meta
    assert "START=3000\nEND=7250\ntitle=C2\n" in meta

    # ffmpeg bằng argv ARRAY (không shell), mux -f ipod, codec aac
    ff = next(c for c in calls if c[0] == "ffmpeg")
    assert all(isinstance(a, str) for a in ff)
    assert ff[-2] == "ipod"
    assert ff[-1].endswith("book.m4b")
    assert "-c:a" in ff and "aac" in ff[ff.index("-c:a") :]

    progress = [e for e in events if e["type"] == "progress"]
    assert [p["done"] for p in progress] == [1, 2]


def test_package_manifest_missing(tmp_path, capsys):
    runner, calls = _fake_probe({})
    rc = package_stage({"sequence": 1}, tmp_path, _Emitter("t73"), probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    assert calls == []  # không đụng ffmpeg khi đầu vào sai
    final = [e for e in _events(capsys) if e["type"] == "final"][-1]
    assert final["status"] == "failed" and "manifest" in final["summary"]


def test_package_audio_missing(tmp_path, capsys):
    wd = tmp_path
    _seed(wd, CHAPTERS_2)
    (wd / CHAPTERS_2[1]["audio"]).unlink()  # chương 2 thiếu file
    runner, _calls = _fake_probe({})
    rc = package_stage({"sequence": 1}, wd, _Emitter("t73"), probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    final = [e for e in _events(capsys) if e["type"] == "final"][-1]
    assert "thiếu audio chương 2" in final["summary"]


def test_package_input_probe_fail_no_ffmpeg_call(tmp_path, capsys):
    wd = tmp_path
    _seed(wd, CHAPTERS_2)
    runner, calls = _fake_probe(durations={"audio-0001.mp3": 3.0})  # thiếu duration file 2
    rc = package_stage({"sequence": 1}, wd, _Emitter("t73"), probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    assert not any(c[0] == "ffmpeg" for c in calls)


def test_package_input_duration_junk(tmp_path, capsys):
    wd = tmp_path
    _seed(wd, CHAPTERS_2)
    runner, calls = _fake_probe(durations={"audio-0001.mp3": float("nan"), "audio-0002.mp3": 4.0})
    rc = package_stage({"sequence": 1}, wd, _Emitter("t73"), probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    assert not any(c[0] == "ffmpeg" for c in calls)


def test_package_ffmpeg_fail(tmp_path, capsys):
    wd = tmp_path
    _seed(wd, CHAPTERS_2)
    runner, _calls = _fake_probe(
        durations={"audio-0001.mp3": 3.0, "audio-0002.mp3": 4.25}, ffmpeg_rc=3
    )
    rc = package_stage({"sequence": 1}, wd, _Emitter("t73"), probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    final = [e for e in _events(capsys) if e["type"] == "final"][-1]
    assert "ffmpeg" in final["summary"]


def test_package_output_duration_off(tmp_path, capsys):
    wd = tmp_path
    _seed(wd, CHAPTERS_2)
    runner, _calls = _fake_probe(
        durations={"audio-0001.mp3": 3.0, "audio-0002.mp3": 4.25},
        out_doc=_out_doc(12.0, [0.0, 3.0], ["C1", "C2"]),  # lệch 4.75s > tol 2s
    )
    rc = package_stage({"sequence": 1}, wd, _Emitter("t73"), probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    events = _events(capsys)
    assert any("duration lệch" in e["message"] for e in events if e["type"] == "error")


def test_package_output_chapters_off(tmp_path, capsys):
    wd = tmp_path
    _seed(wd, CHAPTERS_2)
    runner, _calls = _fake_probe(
        durations={"audio-0001.mp3": 3.0, "audio-0002.mp3": 4.25},
        out_doc=_out_doc(7.25, [0.0], ["C1"]),  # mất chapter 2
    )
    rc = package_stage({"sequence": 1}, wd, _Emitter("t73"), probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    events = _events(capsys)
    assert any("số chapter lệch" in e["message"] for e in events if e["type"] == "error")


def test_package_output_title_mismatch(tmp_path, capsys):
    wd = tmp_path
    _seed(wd, CHAPTERS_2)
    runner, _calls = _fake_probe(
        durations={"audio-0001.mp3": 3.0, "audio-0002.mp3": 4.25},
        out_doc=_out_doc(7.25, [0.0, 3.0], ["C1", "SAI"]),
    )
    rc = package_stage({"sequence": 1}, wd, _Emitter("t73"), probe_runner=runner)
    assert rc == ExitCode.PERMANENT
    events = _events(capsys)
    assert any("title" in e["message"] for e in events if e["type"] == "error")


def test_package_bad_sequence(tmp_path, capsys):
    for bad in (0, "x", True, None, 1.5):
        rc = package_stage({"sequence": bad}, tmp_path, _Emitter("t73"))
        assert rc == ExitCode.PERMANENT
        final = [e for e in _events(capsys) if e["type"] == "final"][-1]
        assert final["status"] == "failed"


def test_build_ffmetadata_escapes_special_chars():
    meta = build_ffmetadata("A=B;#C", [{"title": "X=Y", "startMs": 0, "endMs": 5}])
    assert "title=A\\=B\\;\\#C" in meta
    assert "title=X\\=Y" in meta
    assert "TIMEBASE=1/1000" in meta


def test_build_concat_list_paths_and_validation():
    out = build_concat_list(["packages/0001/parts/a.mp3", "packages/0001/parts/b.mp3"])
    assert out.splitlines()[0] == "ffconcat version 1.0"
    assert "file 'parts/a.mp3'" in out and "file 'parts/b.mp3'" in out
    # path trong list phải để lại bằng nối thẳng (không shell-escape) — kiểm quote lồng
    with pytest.raises(ValueError):
        build_concat_list(["chapters/0001/audio.mp3"])  # không thuộc packages/{seq}/
    with pytest.raises(ValueError):
        build_concat_list(["../escape.mp3"])


def test_execute_job_package_dispatch(tmp_path, capsys):
    _seed(tmp_path, CHAPTERS_2)
    runner, calls = _fake_probe(
        durations={"audio-0001.mp3": 3.0, "audio-0002.mp3": 4.25},
        out_doc=_out_doc(7.25, [0.0, 3.0], ["C1", "C2"]),
    )
    rc = execute_job("package", {"sequence": 1}, tmp_path, job_id="t73", probe_runner=runner)
    assert rc == ExitCode.SUCCESS
    assert any(c[0] == "ffmpeg" for c in calls)
    artifact = [e for e in _events(capsys) if e["type"] == "artifact_ready"][-1]
    assert artifact["kind"] == "m4b"


def test_package_live_ffmpeg_opt_in(tmp_path, capsys):
    if os.environ.get("LIVE_FFMPEG") != "1":
        pytest.skip("live ffmpeg: chỉ chạy khi LIVE_FFMPEG=1")
    wd = tmp_path
    parts = wd / "packages" / "0001" / "parts"
    parts.mkdir(parents=True, exist_ok=True)
    for i in (1, 2):
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
             "-c:a", "libmp3lame", "-b:a", "32k", str(parts / f"audio-000{i}.mp3")],
            check=True,
        )
    _seed(wd, CHAPTERS_2)
    rc = package_stage({"sequence": 1}, wd, _Emitter("t73"))  # không inject = binary thật
    assert rc == ExitCode.SUCCESS
    events = _events(capsys)
    artifact = [e for e in events if e["type"] == "artifact_ready"][-1]
    assert artifact["path"] == "packages/0001/book.m4b"
    assert not (wd / "packages" / "0001" / "parts").exists()
