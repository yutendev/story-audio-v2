r"""T5.3–T5.8 — rewrite service: prompt, cache key định danh, validation, chunking.

Port các phần hữu ích của Audio/viet_lai.py + truyen_audio.py (READ-ONLY):
- chunk_text/_split_oversized (T5.4): gộp theo đoạn, tách an toàn đoạn quá dài.
- cache (T5.8): key = f(prompt_version, part, subset, model); entry v2
  chứa checksum — corrupt/truncated bị từ chối; ghi qua atomic_write.
- QA gate (T5.6) chạy trên văn đã ghép, kể cả cache hit.
Output: mỗi chương chapters/NNNN/rewritten.txt + cache ở workdir/rewrite-cache/.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path

from story_audio import paths as P
from story_audio.exit_codes import ExitCode
from story_audio.normalize import split_raw, split_sentences
from story_audio.providers import (
    DEFAULT_DEVKIT_MODEL,
    DEFAULT_GEMINI_MODEL,
    DEFAULT_OPENROUTER_MODEL,
    AuthError,
    LLMClient,
    ProviderError,
    RateLimited,
    quota_not_before,
    resolve_providers,
)
from story_audio.qa import qa_check, qa_cfg_from_payload

PROMPT_VERSION = "1"
CHUNK_MAX_CHARS = 1500  # port mặc định của Audio/truyen_audio.py::chunk_text
CHUNK_MIN_CHARS, CHUNK_MAX_LIMIT = 200, 10000  # biên cấu hình cho phép của job
ATTEMPTS = 3

BAD_LEADINS = ("dưới đây là", "đây là bản", "đây là đoạn", "sau đây là",
               "chắc chắn rồi", "bản viết lại")


def load_glossary(path: str | Path) -> dict[str, str]:
    """Port: file vắng → {}; sai định dạng → ValueError (fail rõ, không nuốt)."""
    p = Path(path)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except ValueError as e:
        raise ValueError(f"glossary lỗi định dạng ({p}): {e}") from e
    if not isinstance(data, dict):
        raise ValueError(f"glossary phải là JSON object: {p}")
    return {str(k): str(v) for k, v in data.items()}


def glossary_subset(text: str, glossary: dict[str, str]) -> dict[str, str]:
    """Chỉ giữ mục thuật ngữ có lộ trong phần văn bản — không gửi cả bảng ra LLM."""
    return {k: v for k, v in glossary.items() if k in text}


COMMON_CJK_TRANSLIT: dict[str, str] = {
    "淄": "Tri",
    "眾": "chúng",
    "众": "chúng",
    "故": "cố",
    "阁": "Các",
    "閣": "Các",
    "夫": "phu",
    "剿": "tiễu",
    "怀": "hoài",
    "长期": "trường kỳ",
    "街": "phố",
    "抚朝": "vỗ về triều chính",
    "抚不朝之臣": "vỗ về kẻ không chịu vào chầu",
    "抚": "vỗ về",
    "道": "Đạo",
    "门": "môn",
    "門": "môn",
    "宗": "tông",
    "皇": "hoàng",
    "帝": "đế",
    "王": "vương",
    "君": "quân",
    "神": "thần",
    "仙": "tiên",
    "魔": "ma",
    "鬼": "quỷ",
    "佛": "Phật",
    "剑": "kiếm",
    "劍": "kiếm",
    "刀": "đao",
    "法": "pháp",
    "阵": "trận",
    "陣": "trận",
    "丹": "đan",
    "符": "phù",
    "器": "khí",
    "灵": "linh",
    "靈": "linh",
    "气": "khí",
    "氣": "khí",
    "心": "tâm",
    "天": "thiên",
    "地": "địa",
    "人": "nhân",
    "生": "sinh",
    "死": "tử",
    "大": "đại",
    "小": "tiểu",
    "第": "thứ",
    "章": "chương",
}

CJK_CHAR_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")


def auto_sanitize_cjk(text: str) -> str:
    """Tự động phiên âm và làm sạch các ký tự chữ Hán (CJK) còn sót từ bản gốc convert."""
    for cjk, vi in sorted(COMMON_CJK_TRANSLIT.items(), key=lambda x: len(x[0]), reverse=True):
        if cjk in text:
            text = text.replace(cjk, vi)
    # Loại bỏ triệt để mọi ký tự CJK còn lại (nếu có ký tự lạ/watermark) để TTS đọc trơn tru
    text = CJK_CHAR_RE.sub("", text)
    return re.sub(r"[ \t]+", " ", text)


def build_prompt(part: str, subset: dict[str, str], prev_tail: str) -> str:
    lines = [
        "Bạn là biên tập viên người Việt, viết lại truyện convert (bản dịch Hán Việt rời rạc, câu cứng) "
        "thành văn xuôi tiếng Việt tự nhiên, mạch lạc, đọc lên trôi chảy.",
        "",
        "Yêu cầu bắt buộc:",
        "- Giữ nguyên toàn bộ tên riêng và thuật ngữ Hán Việt (nhân vật, địa danh, tông môn, cảnh giới, công pháp).",
        "- Dịch hoặc phiên âm toàn bộ chữ Hán, ký tự Trung Quốc (nếu còn sót trong bản gốc) sang chữ Quốc ngữ / âm Hán-Việt tiêu chuẩn. Tuyệt đối không để sót ký tự chữ Hán (CJK) nào trong văn bản viết lại.",
        "- Giữ đúng thứ tự và số lượng tình tiết của bản gốc, không thêm không bớt chi tiết.",
        "- Có thể gộp hoặc sắp lại câu cho dễ đọc nhưng không đổi ý.",
        "- Không thêm chú thích, bình luận, không thêm mở bài hay kết bài.",
        "- Giữ nguyên cách xuống đoạn: mỗi đoạn gốc tương ứng một đoạn, phân cách bằng dòng trống.",
        "- Chỉ trả về văn bản đã viết lại, không thêm gì khác.",
    ]
    if subset:
        lines += ["", "Bảng thuật ngữ (bắt buộc viết đúng như cột phải):"]
        lines += [f"- {k} → {v}" for k, v in sorted(subset.items())]
    if prev_tail:
        lines += [
            "",
            "Ngữ cảnh: mấy câu cuối của phần văn trước (chỉ để nhất quán xưng hô, KHÔNG viết lại phần này):",
            prev_tail,
        ]
    lines += ["", "Đoạn bản gốc cần viết lại:", part]
    return "\n".join(lines)


def validate(original: str, rewritten: str, subset: dict[str, str]) -> list[str]:
    """Kiểm đầu ra LLM — danh sách problems; [] = đạt."""
    problems = []
    if not rewritten.strip():
        return ["đầu ra rỗng"]
    ratio = len(rewritten) / max(1, len(original))
    if not (0.7 <= ratio <= 1.3):
        problems.append(f"độ dài lệch (tỉ lệ {ratio:.2f})")
    for term, fixed in subset.items():
        if fixed not in rewritten:
            problems.append(f"thiếu thuật ngữ: {fixed}")
    head = rewritten.strip().lower()
    for bad in BAD_LEADINS:
        if head.startswith(bad):
            problems.append(f"lời dẫn AI: {rewritten.strip()[:40]}")
            break
    qin = original.count('"') + original.count("“") + original.count("”")
    qout = rewritten.count('"') + rewritten.count("“") + rewritten.count("”")
    if abs(qout - qin) > max(1, 0.25 * qin):
        problems.append(f"ngoặc thoại lệch (vào {qin}, ra {qout})")
    return problems


def model_fingerprint(custom_model: str = "") -> str:
    """Danh tính cấu hình LLM hiện tại (env) — đổi model/config → cache vô hiệu (T5.8)."""
    return (f"gem={os.environ.get('VIETLAI_GEMINI_MODEL', DEFAULT_GEMINI_MODEL)}"
            f";or={os.environ.get('VIETLAI_OPENROUTER_MODEL', DEFAULT_OPENROUTER_MODEL)}"
            f";dk={os.environ.get('VIETLAI_DEVKIT_MODEL', DEFAULT_DEVKIT_MODEL)}"
            f";m={custom_model}")


def cache_key(part: str, subset: dict[str, str], version: str = PROMPT_VERSION,
              model: str = "") -> str:
    """Key cache ĐỊNH DANH: version \\0 part \\0 subset (json sorted) \\0 model.
    Cùng (part, subset, version, model) luôn sinh cùng key — cache bền qua lần chạy."""
    h = hashlib.sha256()
    h.update(version.encode("utf-8"))
    h.update(b"\x00")
    h.update(part.encode("utf-8"))
    h.update(b"\x00")
    h.update(json.dumps(subset, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    h.update(b"\x00")
    h.update(model.encode("utf-8"))
    return h.hexdigest()[:32]


def _split_oversized(text: str, max_chars: int) -> list[str]:
    """Port: cắt chuỗi quá dài tại khoảng trắng gần nhất; không có space → cắt cứng."""
    if len(text) <= max_chars:
        return [text]
    pieces = []
    rest = text
    while len(rest) > max_chars:
        cut = rest[:max_chars]
        at = cut.rfind(" ")
        if at < max_chars // 2:
            at = len(cut)
        pieces.append(rest[:at])
        rest = rest[at:].lstrip()
    if rest:
        pieces.append(rest)
    return pieces


def chunk_text(paragraphs: list[str], max_chars: int = CHUNK_MAX_CHARS) -> list[str]:
    """Port truyen_audio.py (T5.4): gộp theo ĐOẠN; đoạn quá dài tách theo CÂU
    rồi theo khoảng trắng — không chunk rỗng, ≤ max_chars, thứ tự giữ nguyên."""
    chunks = []
    cur = ""

    def push(piece):
        nonlocal cur
        if not piece:
            return
        if cur and len(cur) + 1 + len(piece) > max_chars:
            chunks.append(cur)
            cur = ""
        cur = piece if not cur else cur + "\n" + piece

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(para) <= max_chars:
            push(para)
            continue
        for sentence in split_sentences(para):
            for piece in _split_oversized(sentence, max_chars):
                push(piece)
    if cur:
        chunks.append(cur)
    return chunks


def load_cache(cache_dir: Path) -> dict[str, str]:
    """T5.8 — entry v2, dòng đầu là checksum sha256 của phần text bên dưới.
    corrupt/truncated/checksum lệch → entry bị BỎ (coi như vắng); provider sẽ
    sinh lại và ghi lại đúng format — không bao giờ dùng nội dung nát."""
    cache: dict[str, str] = {}
    if cache_dir.is_dir():
        for p in cache_dir.glob("*.txt"):
            cp, sep, text = p.read_text(encoding="utf-8").partition("\n")
            if sep and cp == hashlib.sha256(text.encode("utf-8")).hexdigest():
                cache[p.stem] = text
    return cache


def save_cache_entry(cache_dir: Path, key: str, text: str) -> None:
    """Ghi checksum-line v2 qua atomic_write (temp → commit) — crash giữa đường
    để lại file ĐẦY ĐỦ hoặc KHÔNG hẳn, không bao giờ nát nửa chừng."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cp = hashlib.sha256(text.encode("utf-8")).hexdigest()
    P.atomic_write(cache_dir / f"{key}.txt", f"{cp}\n{text}")


def rewrite_part(part, subset, prev_tail, client, cache, attempts=ATTEMPTS, model=""):
    """Port rewrite_part: cache trước, thử `attempts` lần; cạn vòng → giữ phần gốc."""
    key = cache_key(part, subset, model=model)
    if key in cache:
        return {"key": key, "text": cache[key], "backend": "cache", "attempts": 0,
                "calls": 0, "problems": [], "cached": True}
    prompt = build_prompt(part, subset, prev_tail)
    problems: list[str] = []
    calls = 0
    for _i in range(1, attempts + 1):
        try:
            text, backend, n = client.complete(prompt)
        except RateLimited:
            raise  # quota xử lý ở tầng stage (không đếm là attempt validation)
        except AuthError as e:
            raise AuthError(str(e)) from e  # sai key — không fallback, tầng stage dừng PERMANENT
        except ProviderError as e:
            # mạng/HTTP nát — không retry validation; tầng stage quyết exit code
            return {"key": key, "text": part, "backend": "lỗi", "attempts": _i,
                    "calls": calls, "problems": [str(e)], "cached": False}
        calls += n
        problems = validate(part, text, subset)
        if not problems:
            cache[key] = text
            return {"key": key, "text": text, "backend": backend, "attempts": _i,
                    "calls": calls, "problems": [], "cached": False}
    return {"key": key, "text": part, "backend": "gốc", "attempts": attempts,
            "calls": calls, "problems": problems, "cached": False}


def _chapter_dirs(workdir: Path) -> list[Path]:
    root = workdir / "chapters"
    if not root.is_dir():
        return []
    return sorted(d for d in root.iterdir() if d.is_dir() and d.name.isdigit())


def rewrite_stage(payload, workdir: Path, em, providers=None, sleep=time.sleep) -> ExitCode:
    """Stage rewrite: đọc normalized.txt → viết lại → rewritten.txt + event protocol v1."""
    glossary: dict[str, str] = {}
    inline = payload.get("glossary")
    if isinstance(inline, dict):
        glossary = {str(k): str(v) for k, v in inline.items()}
    gpath = payload.get("glossary_path")
    if isinstance(gpath, str) and gpath.strip():
        glossary = load_glossary(gpath)

    ai_model = payload.get("ai_model") or payload.get("aiModel") or ""
    openrouter_key = payload.get("openrouter_api_key") or payload.get("openrouterApiKey") or ""
    gemini_key = payload.get("gemini_api_key") or payload.get("geminiApiKey") or ""
    devkit_key = payload.get("devkit_api_key") or payload.get("devkitApiKey") or ""
    devkit_base_url = payload.get("devkit_base_url") or payload.get("devkitBaseUrl") or ""

    if providers is None:
        providers = resolve_providers(
            payload.get("providers"),
            ai_model=ai_model or None,
            openrouter_api_key=openrouter_key or None,
            gemini_api_key=gemini_key or None,
            devkit_api_key=devkit_key or None,
            devkit_base_url=devkit_base_url or None,
        )  # sai policy → ValueError
    if not providers:
        raise ValueError(
            "không có provider nào cho rewrite — cấu hình GEMINI_API_KEY/OPENROUTER_API_KEY/DEVKIT_API_KEY "
            "hoặc payload.providers tường minh"
        )
    client = LLMClient(providers, sleep=sleep)
    # biên chunk cấu hình theo job — kẹp trong [200, 10000] để bảo vệ prompt/LLM
    raw_bound = payload.get("chunk_max_chars")
    if isinstance(raw_bound, bool) or not isinstance(raw_bound, int):
        bound = CHUNK_MAX_CHARS
    else:
        bound = max(CHUNK_MIN_CHARS, min(CHUNK_MAX_LIMIT, raw_bound))
    cache_dir = workdir / "rewrite-cache"
    cache = load_cache(cache_dir)
    qa_cfg = qa_cfg_from_payload(payload.get("qa"))
    fp = model_fingerprint(custom_model=ai_model)  # fingerprint cấu hình LLM của lần chạy — cache key v2 (T5.8)

    em.send("stage_started", stage="rewrite")
    chapters = _chapter_dirs(workdir)
    if not chapters:
        em.send("error", message="workdir không có chapters/NNNN/normalized.txt nào", retryable=False)
        em.send("final", status="failed", summary="rewrite không có input")
        return ExitCode.PERMANENT

    total_calls = 0
    net_fallback = val_fallback = 0
    qa_failed = 0
    skipped = 0
    processed = 0
    quota: RateLimited | None = None
    auth_err: AuthError | None = None
    for d in chapters:
        no = int(d.name)
        src = d / "normalized.txt"
        if not src.is_file():
            skipped += 1
            em.send("chapter_status", chapter_no=no, state="failed")
            em.send("error", message=f"chương {no} thiếu normalized.txt (chạy normalize trước)",
                    retryable=False)
            continue
        raw = src.read_text(encoding="utf-8")
        title, paragraphs = split_raw(raw)
        parts = [p for p in chunk_text(paragraphs, bound) if p]
        if not title or not parts:
            skipped += 1
            em.send("chapter_status", chapter_no=no, state="failed")
            em.send("error", message=f"chương {no} rỗng sau normalize", retryable=False)
            continue
        out_parts: list[str] = []
        prev_tail = ""
        for i, part in enumerate(parts, 1):
            subset = glossary_subset(part, glossary)
            try:
                r = rewrite_part(part, subset, prev_tail, client, cache, model=fp)
            except RateLimited as e:
                quota = e
                break
            except AuthError as e:
                auth_err = e
                break
            total_calls += r["calls"]
            if r["backend"] in ("gốc", "lỗi"):
                if r["backend"] == "lỗi":
                    net_fallback += 1
                else:
                    val_fallback += 1
                em.send(
                    "error",
                    message=f"chương {no} phần {i}: giữ bản gốc — {r['problems']}",
                    retryable=r["backend"] == "lỗi",
                )
            elif not r["cached"]:
                save_cache_entry(cache_dir, r["key"], r["text"])
            out_parts.append(r["text"])
            prev_tail = " ".join(split_sentences(r["text"])[-3:])
            em.send(
                "progress",
                stage="rewrite",
                done=i,
                total=len(parts),
                chapter_no=no,
                message=f"Đã chuốt văn xong: Chương {no} (Đoạn {i}/{len(parts)})",
            )
        if quota is not None or auth_err is not None:
            break
        content = title + "\n\n" + "\n\n".join(out_parts) + "\n"
        # Tự động phiên âm và làm sạch các ký tự CJK còn sót từ truyện convert gốc
        content = auto_sanitize_cjk(content)
        # QA gate chạy TRÊN văn đã ghép — kể cả khi mọi part từ cache (T5.6)
        qa_probs = qa_check(content, raw, glossary, qa_cfg)
        if qa_probs:
            qa_failed += 1
            em.send("error", message=f"chương {no} trượt QA: {'; '.join(qa_probs)}",
                    retryable=False)
        dst = d / "rewritten.txt"
        P.atomic_write(dst, content)
        processed += 1
        em.send("chapter_status", chapter_no=no, state="rewritten")
        em.send(
            "artifact_ready",
            path=dst.relative_to(workdir).as_posix(),
            kind="rewritten_text",
            checksum=hashlib.sha256(dst.read_bytes()).hexdigest(),
        )

    if quota is not None:
        # cạn quota toàn provider free → Node lưu notBefore rồi đợi, KHÔNG retry spin
        kind, not_before = quota_not_before(str(quota))
        em.send(
            "quota_wait",
            backend=quota.args[0].split(":")[0],
            not_before=not_before,
        )
        em.send(
            "final",
            status="quota_wait",
            summary=f"rewrite dừng vì quota {kind}: {quota}",
        )
        return ExitCode.QUOTA_WAIT

    if auth_err is not None:
        msg = f"lỗi xác thực/cấu hình — dừng không thử lại: {auth_err}"
        em.send("error", message=msg, retryable=False)
        em.send("final", status="failed", summary=msg)
        return ExitCode.PERMANENT

    summary = f"{processed} chương rewritten; {total_calls} request"
    if val_fallback:
        summary += f"; {val_fallback} phần giữ bản gốc cần duyệt"
    if qa_failed:
        summary += f"; {qa_failed} chương trượt QA"
    if skipped:
        summary += f"; {skipped} chương thiếu input"
    if net_fallback:
        # lỗi mạng — cache đã lưu phần xong; Node schedule lại, chỉ gọi phần còn thiếu
        em.send("final", status="failed", summary=f"{summary}; {net_fallback} phần lỗi mạng")
        return ExitCode.RETRYABLE
    if val_fallback or qa_failed or skipped:
        em.send("final", status="needs_review", summary=summary)
        return ExitCode.NEEDS_REVIEW
    em.send("final", status="success", summary=summary)
    return ExitCode.SUCCESS
