r"""T5.3–T5.8 — rewrite service: prompt, cache key định danh, validation, chunking.

Port và nâng cấp theo Phase 1 (Chất lượng dịch):
- chunk_text/_split_oversized: gộp theo đoạn, tách an toàn đoạn quá dài.
- cache: key = f(prompt_version, part, subset, model); entry v2
  chứa checksum — corrupt/truncated bị từ chối; ghi qua atomic_write.
- validate: kiểm tra toàn diện chunk (CJK, fullwidth, mojibake, rò rỉ prompt,
  lời dẫn AI, thiếu thuật ngữ, dấu kết câu, tỉ lệ độ dài, ngoặc thoại, finish_reason).
- Vòng tự sửa theo mức (Tiered Self-Healing): Mức 1 (sửa xác định), Mức 2 (gọi lại LLM kèm lỗi),
  Mức 3 (tách câu dịch), Hết mức 3 chọn bản ít lỗi nhất + ghi qa_report.
- QA gate chạy trên văn đã ghép, kể cả cache hit.
Output: mỗi chương chapters/NNNN/rewritten.txt + cache ở workdir/rewrite-cache/.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import unicodedata
from pathlib import Path

from story_audio import config
from story_audio import paths as P
from story_audio.exit_codes import ExitCode
from story_audio.normalize import (
    CJK_CHAR_RE,
    COMMON_CJK_TRANSLIT,
    _pattern_for_key,
    auto_sanitize_cjk,
    clean_corrupted_chars,
    normalize_brackets,
    split_raw,
    split_sentences,
    strip_cjk,
)
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

PROMPT_VERSION = config.PROMPT_VERSION
CHUNK_MAX_CHARS = config.CHUNK_MAX_CHARS
CHUNK_MIN_CHARS, CHUNK_MAX_LIMIT = config.CHUNK_MIN_CHARS, config.CHUNK_MAX_LIMIT
ATTEMPTS = config.MAX_LLM_ATTEMPTS

BAD_LEADINS = config.BAD_LEADINS
PROMPT_LEAK_MARKERS = config.PROMPT_LEAK_MARKERS

TERMINALS = set(".!?…。”’\"")


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
    """Chỉ giữ mục thuật ngữ có lộ trong phần văn bản — không gửi cả bảng ra LLM.
    Chuẩn hóa NFC cả hai vế và so khớp case-insensitive đối với key."""
    text_nfc = unicodedata.normalize("NFC", text)
    text_lower = text_nfc.lower()
    res: dict[str, str] = {}
    for k, v in glossary.items():
        k_nfc = unicodedata.normalize("NFC", k)
        if k_nfc in text_nfc or k_nfc.lower() in text_lower:
            res[k] = v
    return res


def mask_glossary_tokens(
    text: str,
    subset: dict[str, str],
) -> tuple[str, dict[str, str]]:
    """Thay thuật ngữ glossary trước khi gửi LLM bằng token giữ chỗ.
    Đảm bảo ranh giới từ an toàn (chữ Latin/Việt vs CJK) và chuẩn hóa NFC.
    Trả về (text_masked, token_map) với token_map = {token: fixed_nfc}."""
    if not subset or not text:
        return text, {}

    text_nfc = unicodedata.normalize("NFC", text)
    token_map: dict[str, str] = {}
    sorted_items = sorted(
        subset.items(),
        key=lambda kv: len(unicodedata.normalize("NFC", kv[0])),
        reverse=True,
    )

    idx = 0
    for raw_k, fixed_v in sorted_items:
        k_nfc = unicodedata.normalize("NFC", raw_k)
        f_nfc = unicodedata.normalize("NFC", fixed_v)
        pattern = re.compile(_pattern_for_key(k_nfc), re.IGNORECASE)
        if pattern.search(text_nfc):
            token = f"[[GLOSS_TOKEN_{idx}]]"
            text_nfc = pattern.sub(token, text_nfc)
            token_map[token] = f_nfc
            idx += 1

    return text_nfc, token_map


def restore_glossary_tokens(text: str, token_map: dict[str, str]) -> str:
    """Khôi phục token giữ chỗ [[GLOSS_TOKEN_xx]] về thuật ngữ chuẩn (NFC)."""
    if not token_map or not text:
        return text
    res = text
    for token, fixed in token_map.items():
        res = res.replace(token, fixed)
    return unicodedata.normalize("NFC", res)


def pre_replace_glossary(text: str, subset: dict[str, str]) -> str:
    """Thay trực tiếp thuật ngữ glossary trước khi gửi LLM (giữ nguyên ranh giới từ và NFC)."""
    if not subset or not text:
        return text
    text_nfc = unicodedata.normalize("NFC", text)
    sorted_items = sorted(
        subset.items(),
        key=lambda kv: len(unicodedata.normalize("NFC", kv[0])),
        reverse=True,
    )
    for raw_k, fixed_v in sorted_items:
        k_nfc = unicodedata.normalize("NFC", raw_k)
        f_nfc = unicodedata.normalize("NFC", fixed_v)
        pattern = re.compile(_pattern_for_key(k_nfc), re.IGNORECASE)
        text_nfc = pattern.sub(f_nfc, text_nfc)
    return unicodedata.normalize("NFC", text_nfc)


def build_prompt(
    part: str,
    subset: dict[str, str],
    prev_tail: str,
    previous_errors: list[str] | None = None,
    sentence_mode: bool = False,
    token_mode: bool = False,
) -> str:
    lines = [
        "Bạn là biên tập viên người Việt, viết lại truyện convert (bản dịch Hán Việt rời rạc, câu cứng) "
        "thành văn xuôi tiếng Việt tự nhiên, mạch lạc, giàu cảm xúc, đọc lên trôi chảy.",
        "",
        "Yêu cầu bắt buộc:",
        "- Ưu tiên câu ngắn gọn (mỗi câu tối đa khoảng 25 từ). Tách các câu dài phức tạp bằng dấu chấm hoặc dấu phẩy để giọng đọc tự nhiên, có nhịp thở.",
        "- Ưu tiên văn nói tự nhiên, thuần Việt, trôi chảy, đọc lên êm tai, không dùng từ ngữ tối nghĩa.",
        "- Giữ nguyên toàn bộ tên riêng và thuật ngữ Hán Việt (nhân vật, địa danh, tông môn, cảnh giới, công pháp).",
        "- Dịch hoặc phiên âm toàn bộ chữ Hán, ký tự Trung Quốc (nếu còn sót trong bản gốc) sang chữ Quốc ngữ / âm Hán-Việt tiêu chuẩn. Tuyệt đối không để sót ký tự chữ Hán (CJK) nào trong văn bản viết lại.",
        "- Giữ đúng thứ tự và số lượng tình tiết của bản gốc, không thêm không bớt chi tiết.",
        "- Có thể gộp hoặc sắp lại câu cho dễ đọc nhưng không đổi ý.",
        "- Không thêm chú thích, bình luận, không thêm mở bài hay kết bài.",
        "- Giữ nguyên cách xuống đoạn: mỗi đoạn gốc tương ứng một đoạn, phân cách bằng dòng trống.",
        "- Chỉ trả về văn bản đã viết lại, không thêm bất kỳ lời dẫn hay giải thích nào khác.",
    ]
    if token_mode:
        lines.append("- Giữ nguyên vẹn các mã định danh dạng [[GLOSS_TOKEN_xx]] tại đúng vị trí trong câu (không dịch, không đổi tên).")
    if previous_errors:
        lines += [
            "",
            "LƯU Ý QUAN TRỌNG: Lần thử trước chưa đạt các tiêu chí sau, hãy khắc phục triệt để:",
        ]
        lines += [f"- {err}" for err in previous_errors]
    if sentence_mode:
        orig_s = split_sentences(part)
        lines += [
            "",
            f"Yêu cầu bổ sung cho chế độ câu (Mức 3): Bản gốc gồm {len(orig_s)} câu. "
            f"Hãy dịch chính xác lần lượt từng câu trên từng dòng riêng biệt (đúng {len(orig_s)} dòng, không thêm bớt dòng).",
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


def validate(
    original: str,
    rewritten: str,
    subset: dict[str, str],
    finish_reason: str = "STOP",
    check_cjk: bool = True,
) -> list[str]:
    """Kiểm đầu ra LLM ở tầng chunk — danh sách problems; [] = đạt."""
    problems: list[str] = []
    if not rewritten.strip():
        return ["đầu ra rỗng"]

    if finish_reason and finish_reason.upper() not in ("STOP", "END_TURN", "COMPLETE"):
        problems.append(f"finish_reason bất thường ({finish_reason})")

    if check_cjk:
        cjk_found = CJK_CHAR_RE.findall(rewritten)
        if cjk_found:
            problems.append(f"còn sót CJK ({len(cjk_found)} ký tự: {''.join(cjk_found[:5])})")

    if "\ufffd" in rewritten:
        problems.append("chứa ký tự hỏng U+FFFD")
    fullwidth = re.findall(r"[\uff01-\uff5e\u3000]", rewritten)
    if fullwidth:
        problems.append(f"chứa ký tự fullwidth ({len(fullwidth)} ký tự)")
    if re.search(r"(?:Ã¡|Ã©|Ã­|Ã³|Ãº|â€|â€™|â€œ)", rewritten):
        problems.append("chứa chuỗi mojibake")

    head = rewritten.strip().lower()
    for bad in BAD_LEADINS:
        if head.startswith(bad):
            problems.append(f"lời dẫn AI: {rewritten.strip()[:40]}")
            break

    for mk in PROMPT_LEAK_MARKERS:
        if mk in rewritten:
            problems.append(f"rò rỉ prompt ({mk.rstrip(':')})")
            break

    ratio = len(rewritten) / max(1, len(original))
    if not (config.MIN_RATIO <= ratio <= config.MAX_RATIO):
        problems.append(f"độ dài lệch (tỉ lệ {ratio:.2f})")

    # Đo độ phủ nội dung ở tầng chunk
    # 1. Số câu: bản gốc >= 3 câu mà bản dịch bị thiếu hụt quá nửa
    orig_s = split_sentences(original)
    rewr_s = split_sentences(rewritten)
    if len(orig_s) >= 3:
        min_expected_s = max(1, int(len(orig_s) * config.MIN_SENTENCE_RATIO))
        if len(rewr_s) < min_expected_s:
            problems.append(f"thiếu câu (gốc {len(orig_s)} câu, dịch {len(rewr_s)} câu)")

    # 2. Số liệu (digits): số liệu của nguồn phải tương ứng với đầu ra
    orig_nums = set(re.findall(r"\b\d+\b", original))
    if orig_nums:
        rewr_lower = rewritten.lower()
        missing_nums = []
        for num in orig_nums:
            if num in rewr_lower:
                continue
            if num in config.DIGIT_WORDS and any(w in rewr_lower for w in config.DIGIT_WORDS[num]):
                continue
            missing_nums.append(num)
        if missing_nums:
            problems.append(f"thiếu số liệu: {', '.join(sorted(missing_nums))}")

    rewr_nfc = unicodedata.normalize("NFC", rewritten)
    for term, fixed in subset.items():
        f_nfc = unicodedata.normalize("NFC", fixed)
        if f_nfc not in rewr_nfc:
            problems.append(f"thiếu thuật ngữ: {fixed}")

    orig_stripped = original.rstrip()
    rewr_stripped = rewritten.rstrip()
    if orig_stripped and orig_stripped[-1] in TERMINALS:
        if not rewr_stripped or rewr_stripped[-1] not in TERMINALS:
            problems.append("câu cuối mất dấu kết câu")

    qin = original.count('"') + original.count("“") + original.count("”")
    qout = rewritten.count('"') + rewritten.count("“") + rewritten.count("”")
    if abs(qout - qin) > max(1, config.QUOTE_DEVIATION_TOLERANCE * qin):
        problems.append(f"ngoặc thoại lệch (vào {qin}, ra {qout})")

    return problems


def apply_deterministic_fixes(
    text: str,
    original: str = "",
    subset: dict[str, str] | None = None,
) -> str:
    """Mức 1 — Sửa xác định không cần gọi lại LLM:
    - Bỏ dòng rò rỉ prompt hoặc dòng lời dẫn AI độc lập
    - Chuẩn hóa ngoặc 【...】 -> (...), quote fullwidth -> chuẩn
    - Bỏ ký tự hỏng (U+FFFD), zero-width, fullwidth space
    - Phiên âm các chữ CJK có trong bảng translit chuẩn / subset
    - Gộp câu lặp lại liên tiếp
    - Đảm bảo dấu kết câu nếu bản gốc có
    """
    if not text.strip():
        return text

    # Bỏ các dòng rò rỉ prompt hoặc dòng chỉ là lời dẫn AI
    lines = []
    for line in text.splitlines():
        l_strip = line.strip()
        l_lower = l_strip.lower()
        if any(mk in line for mk in PROMPT_LEAK_MARKERS):
            continue
        # Dòng độc lập chỉ chứa lời dẫn AI (kết thúc bằng dấu hai chấm hoặc là câu xã giao AI)
        if any(l_lower.startswith(bad) for bad in BAD_LEADINS):
            if (
                l_strip.endswith(":")
                or l_lower in ("chắc chắn rồi!", "chắc chắn rồi.", "tất nhiên!", "tất nhiên.")
                or l_strip.endswith("dưới đây:")
            ):
                continue
        lines.append(line)
    text = "\n".join(lines).strip()

    # Chuẩn hóa ngoặc và ký tự hỏng
    text = normalize_brackets(text)
    text = clean_corrupted_chars(text)

    # Phiên âm CJK có trong bảng phiên âm chuẩn
    text = auto_sanitize_cjk(text, replacements=subset)

    # Thay thuật ngữ theo glossary nếu raw key có trong text mà fixed chưa có (chuẩn hóa NFC & case-insensitive)
    if subset:
        text_nfc = unicodedata.normalize("NFC", text)
        for k, v in subset.items():
            k_nfc = unicodedata.normalize("NFC", k)
            f_nfc = unicodedata.normalize("NFC", v)
            if f_nfc not in text_nfc:
                pattern = re.compile(_pattern_for_key(k_nfc), re.IGNORECASE)
                if pattern.search(text_nfc):
                    text_nfc = pattern.sub(f_nfc, text_nfc)
        text = text_nfc

    # Gộp câu lặp lại liên tiếp:
    # - Thoại trong ngoặc kép (“...”) hoặc câu ngắn (< 15 ký tự) được phép lặp hợp lệ (tối đa repeat_max)
    # - Câu trần thuật dài bị lặp do AI kẹt loop được gộp về 1 câu duy nhất
    sentences = split_sentences(text)
    if sentences:
        dedup_s = []
        cur_s = None
        consecutive_count = 0
        max_repeat = int(config.DEFAULT_QA.get("repeat_max", 3))
        for s in sentences:
            is_dialogue_or_short = (
                s.startswith(('"', "“", "'", "‘"))
                or s.endswith(('"', "”", "'", "’"))
                or len(s) < 15
            )
            if s == cur_s:
                consecutive_count += 1
                if is_dialogue_or_short and consecutive_count <= max_repeat:
                    dedup_s.append(s)
            else:
                cur_s = s
                consecutive_count = 1
                dedup_s.append(s)
        text = " ".join(dedup_s)

    return text


def model_fingerprint(custom_model: str = "") -> str:
    """Danh tính cấu hình LLM hiện tại (env) — đổi model/config → cache vô hiệu (T5.8)."""
    return (
        f"gem={os.environ.get('VIETLAI_GEMINI_MODEL', DEFAULT_GEMINI_MODEL)}"
        f";or={os.environ.get('VIETLAI_OPENROUTER_MODEL', DEFAULT_OPENROUTER_MODEL)}"
        f";dk={os.environ.get('VIETLAI_DEVKIT_MODEL', DEFAULT_DEVKIT_MODEL)}"
        f";m={custom_model}"
    )


def cache_key(
    part: str,
    subset: dict[str, str],
    version: str = PROMPT_VERSION,
    model: str = "",
) -> str:
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


def rewrite_part(
    part: str,
    subset: dict[str, str],
    prev_tail: str,
    client: LLMClient,
    cache: dict[str, str],
    attempts: int = ATTEMPTS,
    model: str = "",
    strip_cjk_fallback: bool = False,
    cache_heal: bool = True,
) -> dict:
    """Vòng tự sửa theo mức cho từng chunk: Mức 1 (deterministic) -> Mức 2 (retry prompt)
    -> Mức 3 (sentence-level) -> Fallback bản ít lỗi nhất. Tối đa `attempts` LLM calls."""
    key = cache_key(part, subset, model=model)
    if key in cache:
        cached_text = cache[key]
        cached_probs = validate(part, cached_text, subset)
        if not cached_probs:
            return {
                "key": key,
                "text": cached_text,
                "backend": "cache",
                "attempts": 0,
                "calls": 0,
                "problems": [],
                "cached": True,
                "tier": "cache",
            }
        # Cache hit mà validate trượt:
        # Nếu cache_heal=True: coi như cache miss và chạy vòng tự sửa
        # Nếu cache_heal=False: giữ bản cache kèm problems để QA Gate chương bắt
        if cache_heal:
            cache.pop(key, None)
        else:
            return {
                "key": key,
                "text": cached_text,
                "backend": "cache",
                "attempts": 0,
                "calls": 0,
                "problems": cached_probs,
                "cached": True,
                "tier": "cache",
            }

    calls = 0
    candidates: list[dict] = []
    prev_errors: list[str] = []

    for attempt in range(1, attempts + 1):
        is_sentence_mode = (attempt >= 3 and len(split_sentences(part)) > 1)
        # Chuẩn bị bản gốc với token giữ chỗ glossary trước khi gửi LLM
        masked_part, token_map = mask_glossary_tokens(part, subset)
        prompt = build_prompt(
            masked_part,
            subset,
            prev_tail,
            previous_errors=prev_errors if attempt > 1 else None,
            sentence_mode=is_sentence_mode,
            token_mode=bool(token_map),
        )

        try:
            raw_text, backend, n = client.complete(prompt)
        except RateLimited:
            raise
        except AuthError as e:
            raise AuthError(str(e)) from e
        except ProviderError as e:
            return {
                "key": key,
                "text": part,
                "backend": "lỗi",
                "attempts": attempt,
                "calls": calls,
                "problems": [str(e)],
                "cached": False,
                "tier": "error",
            }

        calls += n

        # Khôi phục token giữ chỗ trước tiên
        restored_text = restore_glossary_tokens(raw_text, token_map)

        # Mức 1: Sửa xác định trên kết quả LLM (xử lý ghép dòng cho Mức 3)
        if is_sentence_mode:
            orig_sentences = split_sentences(part)
            out_lines = [l.strip() for l in restored_text.splitlines() if l.strip()]
            if len(out_lines) == len(orig_sentences):
                combined = "\n".join(out_lines)
            else:
                combined = " ".join(out_lines)
            fixed_text = apply_deterministic_fixes(combined, original=part, subset=subset)
            problems = validate(part, fixed_text, subset)
            if len(out_lines) != len(orig_sentences) and abs(len(out_lines) - len(orig_sentences)) > max(1, len(orig_sentences) // 3):
                if problems:
                    problems.append(f"số dòng dịch Mức 3 lệch số câu (gốc {len(orig_sentences)}, trả về {len(out_lines)})")
        else:
            fixed_text = apply_deterministic_fixes(restored_text, original=part, subset=subset)
            problems = validate(part, fixed_text, subset)

        if not problems:
            cache[key] = fixed_text
            tier_name = f"tier{attempt}" if attempt > 1 else "tier1"
            return {
                "key": key,
                "text": fixed_text,
                "backend": backend,
                "attempts": attempt,
                "calls": calls,
                "problems": [],
                "cached": False,
                "tier": tier_name,
            }

        candidates.append({
            "text": fixed_text,
            "problems": problems,
            "backend": backend,
            "attempt": attempt,
        })
        prev_errors = list(problems)

    # Hết số lần thử mà vẫn còn lỗi: chọn bản ít lỗi nhất (fallback)
    best = min(candidates, key=lambda c: len(c["problems"]))
    best_text = best["text"]
    best_probs = list(best["problems"])
    cjk_stripped = 0

    if strip_cjk_fallback:
        best_text, cjk_stripped = strip_cjk(best_text)

    # Đảm bảo kết quả fallback TUYỆT ĐỐI KHÔNG được lưu vào cache
    cache.pop(key, None)

    return {
        "key": key,
        "text": best_text,
        "backend": "gốc",
        "attempts": attempts,
        "calls": calls,
        "problems": best_probs,
        "cached": False,
        "tier": "fallback",
        "cjk_stripped": cjk_stripped,
    }


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
        )
    if not providers:
        raise ValueError(
            "không có provider nào cho rewrite — cấu hình GEMINI_API_KEY/OPENROUTER_API_KEY/DEVKIT_API_KEY "
            "hoặc payload.providers tường minh"
        )
    client = LLMClient(providers, sleep=sleep)
    raw_bound = payload.get("chunk_max_chars")
    if isinstance(raw_bound, bool) or not isinstance(raw_bound, int):
        bound = CHUNK_MAX_CHARS
    else:
        bound = max(CHUNK_MIN_CHARS, min(CHUNK_MAX_LIMIT, raw_bound))
    cache_dir = workdir / "rewrite-cache"
    cache = load_cache(cache_dir)
    qa_cfg = qa_cfg_from_payload(payload.get("qa"))
    fp = model_fingerprint(custom_model=ai_model)
    strip_fallback = bool(payload.get("strip_cjk_fallback", config.DEFAULT_STRIP_CJK_FALLBACK))
    cache_heal = bool(payload.get("cache_heal", config.DEFAULT_CACHE_HEAL))

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

    qa_report: dict = {
        "chapters": [],
        "total_calls": 0,
        "val_fallback": 0,
        "qa_failed": 0,
    }

    for d in chapters:
        no = int(d.name)
        src = d / "normalized.txt"
        if not src.is_file():
            skipped += 1
            em.send("chapter_status", chapter_no=no, state="failed")
            em.send("error", message=f"chương {no} thiếu normalized.txt (chạy normalize trước)", retryable=False)
            continue
        raw = src.read_text(encoding="utf-8")
        title, paragraphs = split_raw(raw)
        # Tiền xử lý phiên âm các ký tự CJK có trong bảng chuẩn (không xóa CJK còn lại để LLM dịch)
        paragraphs = [auto_sanitize_cjk(p, replacements=glossary) for p in paragraphs]
        parts = [p for p in chunk_text(paragraphs, bound) if p]
        if not title or not parts:
            skipped += 1
            em.send("chapter_status", chapter_no=no, state="failed")
            em.send("error", message=f"chương {no} rỗng sau normalize", retryable=False)
            continue

        out_parts: list[str] = []
        prev_tail = ""
        chapter_stats = {
            "chapter_no": no,
            "chunks_count": len(parts),
            "tier1_count": 0,
            "tier2_count": 0,
            "tier3_count": 0,
            "fallback_count": 0,
            "cjk_stripped_count": 0,
        }

        for i, part in enumerate(parts, 1):
            subset = glossary_subset(part, glossary)
            try:
                r = rewrite_part(
                    part,
                    subset,
                    prev_tail,
                    client,
                    cache,
                    model=fp,
                    strip_cjk_fallback=strip_fallback,
                    cache_heal=cache_heal,
                )
            except RateLimited as e:
                quota = e
                break
            except AuthError as e:
                auth_err = e
                break

            total_calls += r["calls"]
            tier = r.get("tier", "unknown")
            if tier == "tier1":
                chapter_stats["tier1_count"] += 1
            elif tier == "tier2":
                chapter_stats["tier2_count"] += 1
            elif tier == "tier3":
                chapter_stats["tier3_count"] += 1
            elif tier == "fallback":
                chapter_stats["fallback_count"] += 1
            chapter_stats["cjk_stripped_count"] += r.get("cjk_stripped", 0)

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
            elif not r["cached"] and r.get("tier") != "fallback" and not r.get("problems"):
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
        # QA gate chạy TRÊN văn đã ghép — kể cả khi mọi part từ cache (T5.6)
        qa_probs = qa_check(content, raw, glossary, qa_cfg)
        if qa_probs:
            qa_failed += 1
            em.send("error", message=f"chương {no} trượt QA: {'; '.join(qa_probs)}", retryable=False)

        dst = d / "rewritten.txt"
        P.atomic_write(dst, content)

        # Lưu qa_report của chương
        chapter_stats["qa_problems"] = qa_probs
        qa_report["chapters"].append(chapter_stats)
        P.atomic_write(d / "qa_report.json", json.dumps(chapter_stats, ensure_ascii=False, indent=2))

        processed += 1
        em.send("chapter_status", chapter_no=no, state="rewritten")
        em.send(
            "artifact_ready",
            path=dst.relative_to(workdir).as_posix(),
            kind="rewritten_text",
            checksum=hashlib.sha256(dst.read_bytes()).hexdigest(),
        )

    # Lưu tổng hợp qa_report toàn job
    qa_report["total_calls"] = total_calls
    qa_report["val_fallback"] = val_fallback
    qa_report["qa_failed"] = qa_failed
    P.atomic_write(workdir / "qa_report.json", json.dumps(qa_report, ensure_ascii=False, indent=2))

    if quota is not None:
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
        em.send("final", status="failed", summary=f"{summary}; {net_fallback} phần lỗi mạng")
        return ExitCode.RETRYABLE
    if val_fallback or qa_failed or skipped:
        em.send("final", status="needs_review", summary=summary)
        return ExitCode.NEEDS_REVIEW
    em.send("final", status="success", summary=summary)
    return ExitCode.SUCCESS
