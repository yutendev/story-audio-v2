"""Danh sách action hợp lệ + dispatch của worker.

- T1.2: shell + registry 1 nơi để Node spawn chỉ cần biết tên action.
- T5.2: extract/normalize hoạt động thật (extraction tách hẳn khỏi TTS):
  · extract   → chapters/NNNN/text.txt       (raw text nguồn, kind=chapter_text)
  · normalize → chapters/NNNN/normalized.txt (text đã thay replacements + co space,
               kind=normalized_text) — raw và normalized là 2 artifact riêng.
- rewrite/tts/package vẫn 20 (tới T5.3–T5.6, T6, T7).

Events luôn theo protocol v1 (events.py validate từng event); lỗi payload/URL sai
dạng = PERMANENT; FetchError = RETRYABLE; gặp chương khoá có phần đã tải =
NEEDS_REVIEW, không tải được chương nào = PERMANENT.
"""

from __future__ import annotations

import hashlib
import time
from pathlib import Path

from story_audio import events
from story_audio import paths as P
from story_audio import sources
from story_audio.exit_codes import ExitCode
from story_audio.normalize import load_replacements, normalize_brackets, normalize_text, split_raw, strip_author_notes
from story_audio.rewrite import rewrite_stage
from story_audio.tts import tts_stage
from story_audio.package import package_stage
from story_audio.yt_export import yt_export_stage

ACTIONS = frozenset({"extract", "normalize", "rewrite", "tts", "package", "yt_export"})

EXTRACT_PACE_S = 2.0  # đệm giữa 2 lần fetch chương: fetch dồn dập khiến site trả trang rỗng


class _Emitter:
    """Đếm seq LIÊN TỤC GIỮA CÁC LẦN CHẠY job qua file counter trong workdir.

    Node lưu event với unique (job_id, seq) — nếu seq về 0 ở mỗi lần spawn
    thì mọi run sau run đầu bị DB coi là replay (nuốt event + side-effect).
    Read counter từ run trước (workdir/events-seq.txt, absent = 0); sau mỗi
    send ghi lại giá trị KẾ (atomic tmp+replace): crash đúng giữa chừng chỉ
    replay-đông-buổi, không bao giờ nhảy lùi."""

    def __init__(self, job_id: str, stream=None, seq_path: Path | None = None) -> None:
        self._job_id = job_id or "unknown-job"  # events.py yêu cầu job_id khác rỗng
        self._stream = stream  # None = stdout thật (CLI); test dùng StringIO
        self._seq = 0
        self._seq_path = seq_path
        if seq_path is not None:
            try:
                self._seq = int(seq_path.read_text(encoding="utf-8").strip())
            except (OSError, ValueError):
                self._seq = 0
            if self._seq < 0:
                self._seq = 0

    def send(self, ev_type: str, **payload_fields) -> None:
        ev = events.event(self._job_id, ev_type, self._seq, **payload_fields)
        events.emit(ev, stream=self._stream)
        self._seq += 1
        if self._seq_path is not None:
            P.atomic_write(self._seq_path, str(self._seq))


def _require_str(payload, key):
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"payload.{key} phải là chuỗi khác rỗng")
    return value


def _require_count(payload):
    value = payload.get("count")
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"payload.count phải là integer ≥ 1, nhận: {value!r}")
    return value


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _chapter_dirs(workdir: Path) -> list[Path]:
    root = workdir / "chapters"
    if not root.is_dir():
        return []
    return sorted(d for d in root.iterdir() if d.is_dir() and d.name.isdigit())


def _rel(path: Path, workdir: Path) -> str:
    # protocol yêu cầu path TƯƠNG ĐỐI so với workdir (dùng '/' POSIX)
    return path.relative_to(workdir).as_posix()


def extract_stage(payload, workdir: Path, fetch, em: _Emitter, sleep=time.sleep) -> ExitCode:
    url = _require_str(payload, "url")
    count = _require_count(payload)
    fetch = fetch or sources.requests_fetcher()

    em.send("stage_started", stage="extract")
    records: list[sources.ChapterRecord] = []
    try:
        # resume: các vị trí 1..k đã có text.txt → không fetch lại (site chống dồn dập;
        # rerun sau needs_review không đốt lại 9 chương cũ). Chỉ hồi được với adapter
        # có chuỗi số học (truyendich +1) — webnovel phải đi theo link nên tái fetch.
        skipped = 0
        adapter = sources.resolve_adapter(sources._clean_url(url))
        for pos in range(1, count + 1):
            if not (P.chapter_dir(workdir, pos) / "text.txt").is_file():
                break
            if not getattr(adapter, "ARITHMETIC_CHAIN", False):
                break
            skipped = pos
        base: str = ""
        start_no = 0
        url_for_iter = url
        if skipped:
            base, start_no = adapter.parse_chapter_url(sources._clean_url(url))
            url_for_iter = adapter.chapter_url(base, start_no + skipped)
            for pos in range(1, skipped + 1):
                path = P.chapter_dir(workdir, pos) / "text.txt"
                em.send("chapter_status", chapter_no=pos, state="downloaded")
                em.send(
                    "artifact_ready",
                    path=_rel(path, workdir),
                    kind="chapter_text",
                    checksum=_sha256_file(path),
                )
                em.send("progress", stage="extract", done=pos, total=count)

        for pos, rec in enumerate(
            sources.iter_sequence(url_for_iter, count - skipped, fetch=fetch),
            start=skipped + 1,
        ):
            records.append(rec)
            raw = rec.title + "\n\n" + "\n".join(rec.paragraphs) + "\n"
            # chapters/NNNN = VỊ TRÍ trong job (1..N) — số chương sách không ổn định
            # (webnovel nhảy số theo link "Chương sau"); các stage sau đọc theo thư mục.
            path = P.chapter_dir(workdir, pos) / "text.txt"
            P.atomic_write(path, raw)
            em.send("chapter_status", chapter_no=pos, state="downloaded")
            em.send(
                "artifact_ready",
                path=_rel(path, workdir),
                kind="chapter_text",
                checksum=_sha256_file(path),
            )
            em.send("progress", stage="extract", done=pos, total=count)
            if pos < count:
                sleep(EXTRACT_PACE_S)  # nghỉ giữa các lần fetch, đừng dồn dập đốt van site
    except sources.LockedChapter as e:
        if records or skipped:
            # không vượt paywall: đã có phần → chờ người duyệt quyết định tiếp/đổi nguồn
            em.send("error", message=str(e), retryable=False)
            em.send(
                "final",
                status="needs_review",
                summary=f"{skipped + len(records)}/{count} chương đã tải; dừng: {e}",
            )
            return ExitCode.NEEDS_REVIEW
        em.send("error", message=str(e), retryable=False)
        em.send("final", status="failed", summary=f"{e} (không tải được chương nào)")
        return ExitCode.PERMANENT
    except sources.FetchError as e:
        em.send("error", message=str(e), retryable=True)
        em.send("final", status="failed", summary=f"lỗi mạng: {e}")
        return ExitCode.RETRYABLE
    except sources.BlockedPage as e:
        # trang challenge/veil là tạm thời — requeue để tự chạy lại sau khung nghỉ
        em.send("error", message=str(e), retryable=True)
        em.send("final", status="failed", summary=f"trang bị chặn tạm thời: {e}")
        return ExitCode.RETRYABLE
    except sources.UnsupportedSource as e:
        em.send("error", message=str(e), retryable=False)
        em.send("final", status="failed", summary=str(e))
        return ExitCode.PERMANENT

    em.send("final", status="success", summary=f"{skipped + len(records)}/{count} chương đã tải")
    return ExitCode.SUCCESS


def _split_raw(text: str) -> tuple[str, list[str]]:
    """Định dạng text.txt của extract: dòng đầu title, dòng trống, các đoạn sau."""
    return split_raw(text)


def normalize_stage(payload, workdir: Path, em: _Emitter) -> ExitCode:
    replacements: dict[str, str] = {}
    inline = payload.get("replacements")
    if isinstance(inline, dict):
        replacements = {str(k): str(v) for k, v in inline.items()}
    rep_path = payload.get("replacements_path")
    if isinstance(rep_path, str) and rep_path.strip():
        # gọi lỗi JSON hỏng → ValueError → PERMANENT (thấy em bắt ở execute_job)
        replacements = load_replacements(rep_path)

    dirs = _chapter_dirs(workdir)
    if not dirs:
        em.send("error", message="workdir không có chapters/NNNN/text.txt nào", retryable=False)
        em.send("final", status="failed", summary="normalize không có input")
        return ExitCode.PERMANENT

    em.send("stage_started", stage="normalize")
    total = len(dirs)
    done = failed = 0
    for d in dirs:
        no = int(d.name)
        text_path = d / "text.txt"
        _, paragraphs = _split_raw(text_path.read_text(encoding="utf-8"))
        paragraphs = strip_author_notes(paragraphs)
        if not paragraphs:
            # chương rỗng — dữ liệu nguồn lỗi, cần người duyệt sau khi chạy xong phần còn lại
            failed += 1
            em.send("chapter_status", chapter_no=no, state="failed")
            em.send("error", message=f"chương {no} không có đoạn nào (text.txt rỗng/trục trặc)", retryable=False)
            continue
        # bracket 【】 xử TRƯỚC normalize_text để khoảng trắng được collapse sạch
        cleaned = [normalize_text(normalize_brackets(p), replacements) for p in paragraphs]
        path = d / "normalized.txt"
        P.atomic_write(path, "\n".join(cleaned) + "\n")
        done += 1
        em.send("chapter_status", chapter_no=no, state="normalized")
        em.send(
            "artifact_ready",
            path=_rel(path, workdir),
            kind="normalized_text",
            checksum=_sha256_file(path),
        )
        em.send("progress", stage="normalize", done=done + failed, total=total)

    if failed:
        em.send(
            "final",
            status="needs_review",
            summary=f"{done}/{total} chương đã normalize; {failed} chương rỗng cần duyệt",
        )
        return ExitCode.NEEDS_REVIEW
    em.send("final", status="success", summary=f"{done} chương đã normalize")
    return ExitCode.SUCCESS


def execute_job(action, payload, workdir, job_id="", fetch=None, providers=None,
                sleep=time.sleep, probe_runner=None) -> ExitCode:
    """Chạy 1 stage. fetch/providers/sleep/probe_runner: seam offline cho test (mặc định = thật)."""
    em = _Emitter(job_id, seq_path=Path(workdir) / "events-seq.txt")
    if action not in ACTIONS:
        raise ValueError(f"action lạ: {action}")
    try:
        if action == "extract":
            return extract_stage(payload, Path(workdir), fetch, em, sleep=sleep)
        if action == "normalize":
            return normalize_stage(payload, Path(workdir), em)
        if action == "rewrite":
            return rewrite_stage(payload, Path(workdir), em, providers=providers, sleep=sleep)
        if action == "tts":
            # engine thật chỉ chạy khi không inject (test luôn inject fake — không mạng)
            return tts_stage(payload, Path(workdir), em)
        if action == "package":
            # T7.3: ffprobe/ffmpeg thật chỉ chạy khi không inject probe_runner
            return package_stage(payload, Path(workdir), em, probe_runner=probe_runner)
        if action == "yt_export":
            return yt_export_stage(payload, Path(workdir), em, probe_runner=probe_runner)
    except ValueError as e:
        em.send("error", message=str(e), retryable=False)
        em.send("final", status="failed", summary=f"payload sai: {e}")
        return ExitCode.PERMANENT
