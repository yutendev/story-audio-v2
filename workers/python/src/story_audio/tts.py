r"""T6.1 — Edge TTS service (port Audio/truyen_audio.py READ-ONLY) + stage worker.

- Chỉ đọc chapters/NNNN/rewritten.txt — Node chỉ dispatch chương đã qa_passed
  (state machine T2.5); worker thêm lớp self: chương thiếu rewritten.txt = skip.
- Chia câu an toàn dùng lại chunk_text (T5.4); title nói đầu chương như bản cũ.
- Retry transient: backoff 2^n ≤ 30s, file .tmp → rename; mp3 0 byte = fail.
- Concurrency giữ bản cũ (semaphore 3); cache mp3 bền theo (voice, rate, text).
- engine/sleep_fn là seam cho test MOCKED (không mạng); mặc định = edge_tts thật —
  live TTS chỉ chạy khi stage thật được schedule (smoke test opt-in riêng).
- Output: chapters/NNNN/audio.mp3 (kind chapter_audio); concat qua ffmpeg nếu có,
  không có thì nối byte (cùng codec mp3 — behavior bản cũ).
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import shutil
import subprocess
from pathlib import Path
from typing import Awaitable, Callable, Protocol

import edge_tts

from story_audio.exit_codes import ExitCode
from story_audio.normalize import split_raw
from story_audio.rewrite import chunk_text

DEFAULT_VOICE = "vi-VN-HoaiMyNeural"  # port từ bản cũ
DEFAULT_RATE = "-10%"                 # port từ bản cũ
TTS_RETRIES = 8  # service edge-tts thỉnh thoảng trả rỗng (NoAudioReceived) cả với text nhỏ — thêm cơ hội thử lại
TTS_CONCURRENCY = 3
_RATE_RE = re.compile(r"^[+-]\d+%$")


class TTSEngine(Protocol):
    def __call__(self, text: str, voice: str, rate: str, path: Path) -> Awaitable[None]: ...


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _rel(path: Path, workdir: Path) -> str:
    return path.relative_to(workdir).as_posix()


def _voice_rate(payload) -> tuple[str, str]:
    voice = payload.get("voice")
    voice = voice if isinstance(voice, str) and voice.strip() else DEFAULT_VOICE
    rate = payload.get("rate")
    rate = rate if isinstance(rate, str) and rate.strip() else DEFAULT_RATE
    if not _RATE_RE.match(rate):  # trust boundary: payload.job cấu hình sai → PERMANENT
        raise ValueError(f"payload.rate sai dạng ({rate!r}) — cần [+|-]<số>% (vd -10%)")
    return voice.strip(), rate


def tts_chunk_hash(text: str, voice: str, rate: str) -> str:
    """Port: key cache mp3 bền theo (voice, rate, text)."""
    h = hashlib.sha256()
    h.update(voice.encode("utf-8"))
    h.update(b"\x00")
    h.update(rate.encode("utf-8"))
    h.update(b"\x00")
    h.update(text.encode("utf-8"))
    return h.hexdigest()[:32]


async def _tts_one(text: str, voice: str, path: Path, rate: str,
                   retries: int = TTS_RETRIES, engine: TTSEngine | None = None,
                   sleep_fn: Callable[[float], Awaitable[None]] = asyncio.sleep) -> Path:
    """Port: thử `retries` lần, backoff bounded min(30, 2^n) — ghi .tmp rồi rename."""
    last = None
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    for attempt in range(1, retries + 1):
        try:
            if engine is not None:
                await engine(text, voice, rate, tmp_path)
            else:
                await edge_tts.Communicate(text, voice, rate=rate).save(str(tmp_path))
            if tmp_path.exists() and tmp_path.stat().st_size > 0:
                tmp_path.replace(path)
                return path
            last = "file rỗng"
        except Exception as e:  # noqa — trust boundary: mọi lỗi mạng TTS
            last = e
        tmp_path.unlink(missing_ok=True)
        await sleep_fn(min(30, 2 ** attempt))
    raise RuntimeError(f"TTS thất bại sau {retries} lần: {last}")


async def _synthesize_async(chunks: list[str], voice: str, rate: str, tmpdir: Path,
                            concurrency: int = TTS_CONCURRENCY, cache_dir: Path | None = None,
                            engine: TTSEngine | None = None,
                            sleep_fn: Callable[[float], Awaitable[None]] = asyncio.sleep,
                            on_chunk: Callable[[int, int], None] | None = None) -> list[Path]:
    """Port: gọi song song theo semaphore; thứ tự giữ nguyên qua sort theo index."""
    sem = asyncio.Semaphore(concurrency)
    tmpdir.mkdir(parents=True, exist_ok=True)  # caller không lo — tránh retry mù do thư mục vắng
    if cache_dir:
        cache_dir.mkdir(parents=True, exist_ok=True)
    done_count = 0
    lock = asyncio.Lock()

    async def one(i: int, text: str) -> tuple[int, Path]:
        nonlocal done_count
        async with sem:
            path = tmpdir / f"part-{i:03d}.mp3"
            if cache_dir:
                cache_file = cache_dir / f"{tts_chunk_hash(text, voice, rate)}.mp3"
                if cache_file.exists() and cache_file.stat().st_size > 0:
                    shutil.copyfile(cache_file, path)
                    async with lock:
                        done_count += 1
                        if on_chunk:
                            on_chunk(done_count, len(chunks))
                    return i, path
            await _tts_one(text, voice, path, rate, engine=engine, sleep_fn=sleep_fn)
            if cache_dir and path.exists() and path.stat().st_size > 0:
                shutil.copyfile(path, cache_file)
            async with lock:
                done_count += 1
                if on_chunk:
                    on_chunk(done_count, len(chunks))
            return i, path

    results = await asyncio.gather(*(one(i, c) for i, c in enumerate(chunks)))
    parts = [path for _, path in sorted(results)]
    if len(parts) != len(chunks) or not all(p.exists() and p.stat().st_size > 0 for p in parts):
        raise RuntimeError(f"Chưa đủ {len(chunks)} đoạn audio (chỉ có {len(parts)}) — không ghép mp3")
    return parts


def synthesize(chunks: list[str], voice: str, rate: str, tmpdir: Path,
               concurrency: int = TTS_CONCURRENCY, cache_dir: Path | None = None,
               engine: TTSEngine | None = None,
               sleep_fn: Callable[[float], Awaitable[None]] = asyncio.sleep,
               on_chunk: Callable[[int, int], None] | None = None) -> list[Path]:
    return asyncio.run(_synthesize_async(chunks, voice, rate, tmpdir, concurrency,
                                         cache_dir, engine, sleep_fn, on_chunk=on_chunk))


def concat_mp3(parts: list[Path], out_path: Path) -> None:
    """Port: ffmpeg concat nếu có; ffmpeg vắng → nối byte (cùng codec mp3)."""
    if shutil.which("ffmpeg"):
        lst = out_path.parent / "concat-list.txt"
        try:
            lines = "".join(
                "file '{}'\n".format(p.resolve().as_posix().replace("'", "'\\''"))
                for p in parts
            )
            lst.write_text(lines, encoding="utf-8")
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                 "-i", str(lst), "-c", "copy", "-f", "mp3", str(out_path)],
                check=True,
            )
        finally:
            lst.unlink(missing_ok=True)
    else:
        with open(out_path, "wb") as f:
            for p in parts:
                f.write(p.read_bytes())


def _chapter_dirs(workdir: Path) -> list[Path]:
    root = workdir / "chapters"
    if not root.is_dir():
        return []
    return sorted(d for d in root.iterdir() if d.is_dir() and d.name.isdigit())


def tts_stage(payload, workdir: Path, em, engine: TTSEngine | None = None,
              sleep_fn: Callable[[float], Awaitable[None]] | None = None) -> ExitCode:
    """Stage tts: rewritten.txt → chunks → synthesize → audio.mp3 + artifact."""
    voice, rate = _voice_rate(payload)  # sai cấu hình → ValueError → PERMANENT
    sleep_fn = sleep_fn if sleep_fn is not None else asyncio.sleep
    dirs = _chapter_dirs(workdir)
    if not dirs:
        em.send("error", message="workdir không có chapters/NNNN nào", retryable=False)
        em.send("final", status="failed", summary="tts không có input")
        return ExitCode.PERMANENT

    em.send("stage_started", stage="tts")
    cache_dir = workdir / "tts-cache"
    processed = skipped = tts_failed = 0
    for d in dirs:
        no = int(d.name)
        src = d / "rewritten.txt"
        out = d / "audio.mp3"
        if not src.is_file():
            # chương chưa qua rewrite/QA — không bao giờ đọc text chưa duyệt
            skipped += 1
            em.send("chapter_status", chapter_no=no, state="failed")
            em.send("error", message=f"chương {no} thiếu rewritten.txt (mất văn bản đã duyệt)",
                    retryable=False)
            continue
        if out.exists() and out.stat().st_size > 0:
            processed += 1  # chạy lại: đã có mp3 — báo artifact để Node verify, không tái synth
            em.send("chapter_status", chapter_no=no, state="tts_done")
            em.send("artifact_ready", path=_rel(out, workdir), kind="chapter_audio",
                    checksum=_sha256_file(out))
            em.send("progress", stage="tts", done=processed, total=len(dirs))
            continue
        title, paragraphs = split_raw(src.read_text(encoding="utf-8"))
        chunks = [c for c in chunk_text([title] + paragraphs) if c]
        em.send("progress", stage="tts", done=processed, total=len(dirs), chapter_no=no,
                message=f"Đang thu âm giọng đọc AI: Chương {no} ({len(chunks)} đoạn)")
        tmpdir = workdir / "tts-tmp" / f"{no:04d}"
        def on_chunk(done_cnt: int, total_cnt: int) -> None:
            pct = round((done_cnt / total_cnt) * 100)
            em.send(
                "progress",
                stage="tts",
                done=processed,
                total=len(dirs),
                chapter_no=no,
                message=f"Đang thu âm giọng đọc AI: Chương {no} (Đoạn {done_cnt}/{total_cnt} · {pct}%)",
            )
        try:
            parts = synthesize(chunks, voice, rate, tmpdir, cache_dir=cache_dir,
                               engine=engine, sleep_fn=sleep_fn, on_chunk=on_chunk)
            tmp_out = out.with_name(out.name + ".tmp")
            concat_mp3(parts, tmp_out)
            if tmp_out.stat().st_size <= 0:
                raise RuntimeError("mp3 rỗng sau ghép — không chấp nhận file 0 byte")
            tmp_out.replace(out)
        except Exception as e:  # noqa — trust boundary: TTS là dịch vụ ngoài, lỗi → retryable
            tts_failed += 1
            em.send("error", message=f"chương {no} TTS lỗi: {e}", retryable=True)
            em.send("chapter_status", chapter_no=no, state="failed")
            shutil.rmtree(tmpdir, ignore_errors=True)
            continue
        shutil.rmtree(tmpdir, ignore_errors=True)
        processed += 1
        em.send("chapter_status", chapter_no=no, state="tts_done")
        em.send("artifact_ready", path=_rel(out, workdir), kind="chapter_audio",
                checksum=_sha256_file(out))
        em.send("progress", stage="tts", done=processed, total=len(dirs), chapter_no=no,
                message=f"Đã hoàn thành thu âm: Chương {no}")

    summary = f"{processed}/{len(dirs)} chương có audio"
    if tts_failed:
        em.send("final", status="failed", summary=f"{summary}; {tts_failed} chương lỗi TTS")
        return ExitCode.RETRYABLE  # TTS dịch vụ ngoài — lỗi tạm thời, Node schedule lại
    if skipped:
        em.send("final", status="needs_review",
                summary=f"{summary}; {skipped} chương thiếu rewritten.txt cần duyệt")
        return ExitCode.NEEDS_REVIEW
    em.send("final", status="success", summary=summary)
    return ExitCode.SUCCESS
