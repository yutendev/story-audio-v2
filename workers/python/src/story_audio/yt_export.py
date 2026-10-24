"""T7.5 — stage yt_export: MP4 16:9 cho YouTube (KHÔNG tự upload) + description timestamp.

- INPUT: workdir/packages/{seq:04d}/book.m4b (T7.3) + cover.jpg (Node đặt vào, từ ảnh
  người dùng chọn qua API — configurable image/cover; không mặc định cover nào).
- ffprobe ĐO book.m4b -show_chapters → description.txt:
  dòng đầu 00:00:00, timestamp tăng dần (giây non-decreasing, khớp boundary chương).
- ffmpeg argv ARRAY: cover loop scale/pad 1920x1080 (yuv420p) + audio COPY (aac từ m4b)
  + -shortest + faststart → book.mp4; ffprobe KIỂM: có video h264 1920x1080, audio aac,
  format mp4, duration ≈ m4b (tol max(1s, 1%)) — sai = KHÔNG BAO GIỜ success (PERMANENT).
- artifact: kind "mp4" (book.mp4) + kind "description" (description.txt), checksum sha256.
- KHÔNG có bước upload YouTube ở worker — Node chỉ upload PRIVATE lên R2 (acceptance).
- seams: probe_runner inject cho test MOCKED; mặc định binary thật; live: LIVE_FFMPEG=1.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Callable

from story_audio.exit_codes import ExitCode

DURATION_TOL_ABS_S = 1.0
DURATION_TOL_REL = 0.01

ProgRunner = Callable[[list[str]], tuple[int, str, str]]


def _real_runner(cmd: list[str]) -> tuple[int, str, str]:
    """Binary thật qua argv ARRAY — không shell."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60 * 60,
                           encoding="utf-8", errors="replace")
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except OSError as e:
        return 127, "", str(e)


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _fmt_ts(sec: int | float) -> str:
    total = int(round(float(sec)))
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def build_description(title: str, entries: list[tuple[int, str]]) -> str:
    """entries: [(giây >= 0 không giảm, tiêu đề)] — dòng đầu luôn 00:00:00."""
    lines = [str(title), ""]
    for sec, name in entries:
        lines.append(f"{_fmt_ts(sec)} {name}")
    return "\n".join(lines) + "\n"


def _probe_book(book_path: Path, probe: ProgRunner) -> tuple[float, list[dict]] | None:
    """ffprobe book.m4b: (total_s, chapters[{start_s,title}]) — lỗi → None (đã gửi final)."""
    # caller đã gửi error/final khi rc != 0; chỉ bóc JSON ở đây
    rc, out, stderr = probe(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-show_chapters",
         "-of", "json", str(book_path)]
    )
    if rc != 0:
        return None
    try:
        doc = json.loads(out)
        total_s = float(doc["format"]["duration"])
        raw_chapters = doc.get("chapters") or []
    except (ValueError, KeyError, TypeError):
        return None
    chapters: list[dict] = []
    for ch in raw_chapters:
        try:
            start_s = float(ch["start_time"])
        except (KeyError, TypeError, ValueError):
            return None
        title = str((ch.get("tags") or {}).get("title") or "—")
        chapters.append({"startS": start_s, "title": title})
    return total_s, chapters


def _description_entries(chapters: list[dict]) -> list[tuple[int, str]]:
    """Giây nguyên không-giảm (khớp boundary chương); giãn cách bị cá biệt < 1s vẫn tăng."""
    entries: list[tuple[int, str]] = []
    prev_sec = -1
    for ch in chapters:
        sec = max(prev_sec, round(ch["startS"]))
        entries.append((sec, ch["title"]))
        prev_sec = sec
    return entries


def _validate_mp4(stdout: str, m4b_duration_s: float) -> str | None:
    """None = chuẩn: format mp4, h264 1920x1080 + aac, duration ≈ m4b."""
    try:
        doc = json.loads(stdout)
    except ValueError:
        return "ffprobe output không phải JSON"
    fmt = doc.get("format") or {}
    if "mp4" not in str(fmt.get("format_name", "")):
        return f"container không phải mp4: {fmt.get('format_name')!r}"
    streams = doc.get("streams")
    if not isinstance(streams, list):
        return "thiếu streams"
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video:
        return "không có stream video"
    if not audio:
        return "không có stream audio"
    if video.get("codec_name") != "h264":
        return f"codec video {video.get('codec_name')!r} ≠ h264"
    if (video.get("width"), video.get("height")) != (1920, 1080):
        return f"độ phân giải {(video.get('width'), video.get('height'))} ≠ 1920x1080 (16:9)"
    if audio.get("codec_name") != "aac":
        return f"codec audio {audio.get('codec_name')!r} ≠ aac"
    try:
        dur_s = float(fmt.get("duration"))
    except (TypeError, ValueError):
        return "output thiếu duration"
    tol = max(DURATION_TOL_ABS_S, DURATION_TOL_REL * m4b_duration_s)
    if abs(dur_s - m4b_duration_s) > tol:
        return f"duration lệch: mp4 {dur_s:.2f}s ≠ m4b {m4b_duration_s:.2f}s (tol {tol:.2f}s)"
    return None


def yt_export_stage(payload, workdir: Path, em, probe_runner: ProgRunner | None = None) -> ExitCode:
    probe = probe_runner or _real_runner

    seq_raw = payload.get("sequence")
    if not isinstance(seq_raw, int) or isinstance(seq_raw, bool) or seq_raw < 1:
        em.send("error", message=f"payload.sequence phải nguyên ≥ 1: {seq_raw!r}", retryable=False)
        em.send("final", status="failed", summary="payload sai: sequence")
        return ExitCode.PERMANENT

    pkg_dir = workdir / "packages" / f"{seq_raw:04d}"
    book_path = pkg_dir / "book.m4b"
    cover_rel = str(payload.get("cover_rel") or f"packages/{seq_raw:04d}/cover.jpg")
    cover_path = workdir / cover_rel
    mp4_path = pkg_dir / "book.mp4"
    desc_path = pkg_dir / "description.txt"

    if not book_path.is_file():
        em.send("error", message="book.m4b không có — cần build M4B (T7.3) trước", retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: thiếu book.m4b")
        return ExitCode.PERMANENT
    if not cover_path.is_file():
        em.send("error", message=f"cover không có ({cover_rel}) — cần ảnh bìa do người dùng chọn", retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: thiếu cover")
        return ExitCode.PERMANENT

    em.send("stage_started", stage="yt_export")

    probed = _probe_book(book_path, probe)
    if probed is None:
        em.send("error", message="ffprobe không đọc được chapter/duration của book.m4b", retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: book.m4b không hợp lệ")
        return ExitCode.PERMANENT
    m4b_duration_s, chapters = probed
    if not chapters:
        em.send("error", message="book.m4b không có chapter markers", retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: m4b thiếu chapters")
        return ExitCode.PERMANENT

    # description từ duration ĐO THẬT; nội dung trước, upload là việc Node
    entries = _description_entries(chapters)
    title = str(payload.get("title") or f"Gói {seq_raw}")
    desc_path.write_text(build_description(title, entries), encoding="utf-8")
    em.send("progress", stage="yt_export", done=1, total=2)

    filter_complex = (
        "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,"
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=1[v]"
    )
    mp4_path.unlink(missing_ok=True)  # chắc chắn không húp file cũ thành "thành công"
    ffmpeg_args = [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        "-loop", "1", "-i", str(cover_path),
        "-i", str(book_path),
        "-filter_complex", filter_complex,
        "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-tune", "stillimage",
        "-c:a", "copy",
        "-shortest",
        "-movflags", "+faststart",
        "-f", "mp4", str(mp4_path),
    ]
    ff_code, _ff_out, ff_err = probe(ffmpeg_args)
    if ff_code != 0:
        em.send("error", message=f"ffmpeg lỗi (rc={ff_code}): {ff_err.strip()[-400:]}", retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: ffmpeg thất bại")
        return ExitCode.PERMANENT

    vrc, vout, verr = probe(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(mp4_path)]
    )
    if vrc != 0:
        em.send("error", message=f"ffprobe không xác nhận mp4: {verr.strip()[:200]}", retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: mp4 không đọc được")
        return ExitCode.PERMANENT
    validation = _validate_mp4(vout, m4b_duration_s)
    if validation is not None:
        em.send("error", message=validation, retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: mp4 không đạt kiểm tra")
        return ExitCode.PERMANENT
    em.send("progress", stage="yt_export", done=2, total=2)

    em.send(
        "artifact_ready",
        path=mp4_path.relative_to(workdir).as_posix(),
        kind="mp4",
        checksum=_sha256_file(mp4_path),
    )
    em.send(
        "artifact_ready",
        path=desc_path.relative_to(workdir).as_posix(),
        kind="description",
        checksum=_sha256_file(desc_path),
    )
    em.send(
        "final", status="success",
        summary=f"yt {seq_raw}: 1920x1080, {m4b_duration_s:.1f}s, {len(chapters)} mốc timestamp",
    )
    return ExitCode.SUCCESS
