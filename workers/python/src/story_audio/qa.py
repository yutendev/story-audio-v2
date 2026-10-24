r"""T5.6 — QA gate chương: chạy trên văn đã GHÉP xong (kể cả cache hit).

Khác validate() của từng part (rewrite.py — chặn lời dẫn/thuật ngữ ngay khi gọi
LLM), QA nhìn toàn chương: CJK sót dịch, rò rỉ prompt, ngoặc lệch, độ dài
lệch, câu lặp, bị cắt cụt, thiếu thuật ngữ. Trượt QA → chương KHÔNG được coi là
đạt (job NEEDS_REVIEW) — văn bản "giữ bản gốc" khi fallback cũng không lỡ báo thành công.
Ngưỡng cấu hình được qua payload["qa"]; mặc định chặt nhưng không blindly từ chối
khác biệt phong cách hợp lệ (ratio có biên 0.7–1.3, lặp phải vượt repeat_max).
"""

from __future__ import annotations

import re
import unicodedata

from story_audio import config
from story_audio.normalize import split_sentences

CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")

# mảnh prompt có thể bị LLM nhét nhầm vào đầu ra
PROMPT_MARKERS = config.PROMPT_LEAK_MARKERS

# cặp ngoặc cân đối từng chữ (ngoặc thoại "…"" đã xử lý riêng ở validate)
BRACKET_PAIRS = (("(", ")"), ("[", "]"), ("「", "」"))

TERMINALS = set(".!?…。”’\"")

DEFAULT_QA: dict[str, float] = dict(config.DEFAULT_QA)


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def qa_cfg_from_payload(raw) -> dict[str, float]:
    """Coerce payload["qa"]: chỉ nhận key ngầm định + giá trị số (bool loại trừ)
    — cấu hình rác khác bị bỏ qua lặng lẽ thay vì crash cả job."""
    cfg = dict(DEFAULT_QA)
    if isinstance(raw, dict):
        for k in DEFAULT_QA:
            v = raw.get(k)
            if _is_number(v):
                cfg[k] = v
    return cfg


def qa_check(text: str, original: str, glossary: dict[str, str],
             cfg: dict[str, float] | None = None) -> list[str]:
    """Kiểm chương hoàn chỉnh → danh sách problems; [] = đạt."""
    cfg = {**DEFAULT_QA, **(cfg or {})}
    problems: list[str] = []
    if not text.strip():
        return ["đầu ra rỗng"]

    cjk = len(CJK_RE.findall(text))
    if cjk > cfg["cjk_max"]:
        problems.append(f"CJK còn sót ({cjk} ký tự)")

    for mk in PROMPT_MARKERS:
        if mk in text:
            problems.append(f"rò rỉ prompt ({mk.rstrip(':')})")
            break

    for o, c in BRACKET_PAIRS:
        if text.count(o) != text.count(c):
            problems.append(f"ngoặc lệch {o}{c} (vào {text.count(o)}, ra {text.count(c)})")

    ratio = len(text) / max(1, len(original))
    if not (cfg["min_ratio"] <= ratio <= cfg["max_ratio"]):
        problems.append(f"độ dài lệch QA (tỉ lệ {ratio:.2f})")

    # bị cắt cụt: bản gốc kết thúc trọn câu mà đầu ra chỏng tay không dấu kết
    if original.rstrip()[-1:] in TERMINALS and text.rstrip()[-1:] not in TERMINALS:
        problems.append("có thể bị cắt cụt (câu cuối không có dấu kết)")

    counts: dict[str, int] = {}
    for s in split_sentences(text):
        if len(s) >= cfg["repeat_min_len"]:
            counts[s] = counts.get(s, 0) + 1
    dup = max(counts.values(), default=0)
    if dup > cfg["repeat_max"]:
        problems.append(f"câu lặp lại ({dup} lần)")

    # So khớp glossary: chuẩn hóa NFC cả hai vế; so khớp case-insensitive cho key trong original
    orig_nfc = unicodedata.normalize("NFC", original)
    text_nfc = unicodedata.normalize("NFC", text)
    orig_lower = orig_nfc.lower()

    missing: list[str] = []
    for key, fixed in glossary.items():
        k_nfc = unicodedata.normalize("NFC", key)
        f_nfc = unicodedata.normalize("NFC", fixed)
        in_orig = (k_nfc in orig_nfc) or (k_nfc.lower() in orig_lower)
        if in_orig:
            if f_nfc not in text_nfc:
                missing.append(fixed)
    if missing:
        problems.append("thiếu thuật ngữ QA: " + ", ".join(missing[:3]))

    return problems
