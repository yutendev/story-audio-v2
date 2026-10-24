"""T7.3 — stage package: ghép audio chương của MỘT gói thành book.m4b.

- INPUT: workdir/packages/{seq:04d}/manifest.json (Node ghi — pattern T6.2:
  Node tải audio chương VERIFIED từ R2 vào parts/, worker chỉ chạy ffmpeg CỤC BỘ):
  {"sequence": 1, "title": "...",
   "chapters": [{"no": 1, "title": "...", "audio": "packages/0001/parts/audio-0001.mp3"}]}
- ffprobe ĐO DURATION từng file (không tin manifest) → chapter markers
  TIMEBASE 1/1000 (ms tích lũy) → ffmpeg argv ARRAY (không shell):
  concat -safe 0 → aac -b:a 96k → -f ipod (mux .m4b; ffmpeg không nhận đuôi .m4b).
- ffprobe KIỂM output: rc=0, duration ≈ tổng (tol = max(2s, 2%)), số + tiêu đề +
  mốc START chapter khớp metadata — output sai = KHÔNG BAO GIỜ success (PERMANENT).
- seams probe_runner/ffmpeg_runner inject cho test MOCKED (không đụng binary);
  mặc định = binary thật qua subprocess argv (không shell). Live smoke: LIVE_FFMPEG=1.
- Thành công: artifact kind "m4b" + checksum sha256; dọn parts/ (audio đã verified
  trên R2 — chính sách §7: dùng xong xóa bản local, nguồn trên R2 còn nguyên).
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from typing import Callable

from story_audio.exit_codes import ExitCode

DEFAULT_BITRATE = "96k"
DURATION_TOL_ABS_S = 2.0
DURATION_TOL_REL = 0.02
START_TOL_S = 0.001

ProgRunner = Callable[[list[str]], tuple[int, str, str]]


def _real_runner(cmd: list[str]) -> tuple[int, str, str]:
    """Binary thật qua argv ARRAY — không shell, không ghép chuỗi lệnh."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=30 * 60,
                           encoding="utf-8", errors="replace")
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except OSError as e:  # binary vắng mặt trên máy
        return 127, "", str(e)


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _meta_escape(value: str) -> str:
    """FFMETADATA escape: `=` `;` `#` `\\` phải có backslash; newline bị thay bằng space."""
    text = str(value).replace("\\", "\\\\").replace("=", "\\=")
    text = text.replace(";", "\\;").replace("#", "\\#")
    return text.replace("\n", " ").replace("\r", " ")


def build_ffmetadata(title: str, chapters: list[dict]) -> str:
    """chapters: [{"title": ..., "startMs": ..., "endMs": ...}] — ms tăng dần."""
    lines = [";FFMETADATA1", f"title={_meta_escape(title)}"]
    for ch in chapters:
        lines += [
            "[CHAPTER]",
            "TIMEBASE=1/1000",
            f"START={int(ch['startMs'])}",
            f"END={int(ch['endMs'])}",
            f"title={_meta_escape(ch['title'])}",
        ]
    return "\n".join(lines) + "\n"


def build_concat_list(audio_rel_to_workdir: list[str]) -> str:
    """ffconcat v1.0; path trong list tính TỪ THƯ MỤC CHỨA list (packages/{seq}/).

    manifest ghi path POSIX so workdir: packages/{seq}/parts/x.mp3
    → cắt 2 đầu ("packages", "{seq}") thành "parts/x.mp3" (sai cấu trúc → ValueError).
    """
    lines = ["ffconcat version 1.0"]
    for rel in audio_rel_to_workdir:
        parts = rel.split("/")
        if len(parts) < 3 or parts[0] != "packages":
            raise ValueError(f"path audio trong manifest sai cấu trúc: {rel!r}")
        trimmed = "/".join(parts[2:])
        lines.append(f"file '{trimmed}'")
    return "\n".join(lines) + "\n"


def _probe_inputs(payload, workdir: Path, probe: ProgRunner, em) -> list[tuple[Path, float]] | None:
    """đo duration từng audio; lỗi → đã gửi error/final rồi, trả None (PERMANENT)."""
    chapters = payload  # list đã validate trước; chỉ đo
    inputs: list[tuple[Path, float]] = []
    for entry in chapters:
        no = entry["no"]
        audio_path = workdir / str(entry["audio"])
        rc, out, stderr = probe(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "json", str(audio_path)]
        )
        if rc != 0:
            em.send("error", message=f"audio chương {no} probe hỏng: {stderr.strip()[:200]}",
                    retryable=False)
            em.send("final", status="failed", summary=f"gói: audio chương {no} hỏng")
            return None
        try:
            dur = float(json.loads(out).get("format", {}).get("duration"))
        except (ValueError, TypeError, AttributeError):
            dur = float("nan")
        if not (dur > 0):
            em.send("error", message=f"audio chương {no} duration không hợp lệ", retryable=False)
            em.send("final", status="failed", summary=f"gói: audio chương {no} kỳ lạ")
            return None
        inputs.append((audio_path, dur))
        em.send("progress", stage="package", done=len(inputs), total=len(chapters))
    return inputs


def _validate_output(stdout: str, marks: list[dict], titles: list[str]) -> str | None:
    """Trả None nếu output chuẩn: duration ≈ tổng, đủ chapter, START + title khớp."""
    try:
        doc = json.loads(stdout)
    except ValueError:
        return "ffprobe output không phải JSON"
    duration = doc.get("format", {}).get("duration")
    try:
        dur_s = float(duration)
    except (TypeError, ValueError):
        return "output thiếu duration"
    total_s = marks[-1]["endMs"] / 1000.0
    tol = max(DURATION_TOL_ABS_S, DURATION_TOL_REL * total_s)
    if abs(dur_s - total_s) > tol:
        return f"duration lệch: ffprobe {dur_s:.2f}s ≠ tổng metadata {total_s:.2f}s (tol {tol:.2f}s)"
    got = doc.get("chapters")
    if not isinstance(got, list) or len(got) != len(marks):
        return f"số chapter lệch: {0 if not isinstance(got, list) else len(got)} ≠ {len(marks)}"
    for i, (entry, mark, title) in enumerate(zip(got, marks, titles), start=1):
        try:
            start_s = float(entry.get("start_time"))
        except (TypeError, ValueError):
            return f"chapter {i}: thiếu start_time"
        if abs(start_s - mark["startMs"] / 1000.0) > START_TOL_S:
            return f"chapter {i}: START {start_s:.3f}s ≠ {mark['startMs'] / 1000.0:.3f}s"
        got_title = (entry.get("tags") or {}).get("title")
        if got_title != title:
            return f"chapter {i}: title {got_title!r} ≠ {title!r}"
    return None


def package_stage(payload, workdir: Path, em, probe_runner: ProgRunner | None = None) -> ExitCode:
    probe = probe_runner or _real_runner

    seq_raw = payload.get("sequence")
    if not isinstance(seq_raw, int) or isinstance(seq_raw, bool) or seq_raw < 1:
        em.send("error", message=f"payload.sequence phải nguyên ≥ 1: {seq_raw!r}", retryable=False)
        em.send("final", status="failed", summary="payload sai: sequence")
        return ExitCode.PERMANENT

    pkg_dir = workdir / "packages" / f"{seq_raw:04d}"
    manifest_path = pkg_dir / "manifest.json"
    if not manifest_path.is_file():
        em.send("error", message="manifest.json không có (Node chưa prepare?)", retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: thiếu manifest")
        return ExitCode.PERMANENT
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        em.send("error", message=f"manifest đọc hỏng: {e}", retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: manifest sai")
        return ExitCode.PERMANENT
    chapters = manifest.get("chapters")
    if (
        not isinstance(chapters, list)
        or not chapters
        or any(
            not isinstance(c, dict)
            or not isinstance(c.get("no"), int)
            or isinstance(c.get("no"), bool)
            or not isinstance(c.get("audio"), str)
            for c in chapters
        )
    ):
        em.send("error", message="manifest.chapters rỗng/sai cấu trúc", retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: manifest không có chương hợp lệ")
        return ExitCode.PERMANENT

    # audio file phải có thật trước khi đo — thiếu = input sai (Node chưa tải đủ)
    for entry in chapters:
        if not (workdir / entry["audio"]).is_file():
            em.send("error", message=f"chương {entry['no']}: audio không có ({entry['audio']})",
                    retryable=False)
            em.send("final", status="failed", summary=f"gói {seq_raw}: thiếu audio chương {entry['no']}")
            return ExitCode.PERMANENT
    em.send("stage_started", stage="package")

    inputs = _probe_inputs(chapters, workdir, probe, em)
    if inputs is None:
        return ExitCode.PERMANENT

    checkpoint_ms = 0.0
    marks: list[dict] = []
    for _path, dur in inputs:
        end_ms = round(checkpoint_ms + dur * 1000.0)
        marks.append({"startMs": round(checkpoint_ms), "endMs": end_ms})
        checkpoint_ms = end_ms

    audio_rels = [entry["audio"] for entry in chapters]
    titles = [str(entry.get("title") or f"Chương {entry['no']}") for entry in chapters]
    title = str(manifest.get("title") or f"Gói {seq_raw}")
    metadata_text = build_ffmetadata(
        title, [{"title": t, "startMs": m["startMs"], "endMs": m["endMs"]} for t, m in zip(titles, marks)]
    )

    parts_dir = pkg_dir / "parts"
    list_path = pkg_dir / "list.txt"
    metadata_path = pkg_dir / "ffmetadata.txt"
    out_path = pkg_dir / "book.m4b"
    out_path.unlink(missing_ok=True)  # chắc chắn không húp file cũ thành "thành công"
    try:
        list_path.write_text(build_concat_list(audio_rels), encoding="utf-8")
        metadata_path.write_text(metadata_text, encoding="utf-8")
    except ValueError as e:  # manifest path sai cấu trúc — input lỗi, không phải ffmpeg
        em.send("error", message=str(e), retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: manifest path sai")
        return ExitCode.PERMANENT

    bitrate = str(manifest.get("bitrate") or DEFAULT_BITRATE)
    ffmpeg_args = [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        "-f", "concat", "-safe", "0", "-i", str(list_path),
        "-f", "ffmetadata", "-i", str(metadata_path),
        "-map_metadata", "1",
        "-map_chapters", "1",
        "-c:a", "aac", "-b:a", bitrate,
        "-vn",
        "-f", "ipod",
        str(out_path),
    ]
    ff_code, _ff_out, ff_err = probe(ffmpeg_args)
    if ff_code != 0:
        em.send("error", message=f"ffmpeg lỗi (rc={ff_code}): {ff_err.strip()[-400:]}", retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: ffmpeg thất bại")
        return ExitCode.PERMANENT

    vrc, vout, verr = probe(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-show_chapters",
         "-of", "json", str(out_path)]
    )
    if vrc != 0:
        em.send("error", message=f"ffprobe không xác nhận output: {verr.strip()[:200]}", retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: output không đọc được")
        return ExitCode.PERMANENT
    validation = _validate_output(vout, marks, titles)
    if validation is not None:
        em.send("error", message=validation, retryable=False)
        em.send("final", status="failed", summary=f"gói {seq_raw}: output không đạt kiểm tra")
        return ExitCode.PERMANENT

    em.send(
        "artifact_ready",
        path=out_path.relative_to(workdir).as_posix(),
        kind="m4b",
        checksum=_sha256_file(out_path),
    )
    shutil.rmtree(parts_dir, ignore_errors=True)  # audio nguồn còn nguyên trên R2 (verified)
    em.send("final", status="success",
            summary=f"gói {seq_raw}: {len(inputs)} chương, {checkpoint_ms / 1000.0:.1f}s")
    return ExitCode.SUCCESS
