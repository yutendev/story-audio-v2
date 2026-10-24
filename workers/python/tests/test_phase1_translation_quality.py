"""Bộ kiểm thử đơn vị cho Phase 1 — Nâng cấp chất lượng dịch & Tự sửa lỗi.

Kiểm chứng các mục:
- 1.1: normalize.py, auto_sanitize_cjk không xóa CJK lạ, thay CJK liền kề, strip_cjk phương án cuối.
- 1.2: validate mở rộng (CJK, fullwidth, mojibake, U+FFFD, rò rỉ prompt, lời dẫn AI, kết câu, finish_reason).
- 1.3: Tiered Self-Healing (Mức 1 deterministic, Mức 2 feedback prompt, Mức 3 sentence, Fallback + qa_report).
- 1.4: Prompt mới (câu ngắn, văn nói, cấu hình temperature, PROMPT_VERSION tăng).
"""

from __future__ import annotations

import pytest

from story_audio import config
from story_audio.normalize import (
    auto_sanitize_cjk,
    clean_corrupted_chars,
    normalize_text,
    strip_cjk,
)
from story_audio.providers import LLMClient
from story_audio.rewrite import (
    PROMPT_VERSION,
    apply_deterministic_fixes,
    build_prompt,
    rewrite_part,
    validate,
)

_NO_SLEEP = lambda _s: None


# =====================================================================
# PHASE 1.1: normalize.py & CJK boundary tests
# =====================================================================


def test_1_1_auto_sanitize_cjk_transliterates_known_and_keeps_unknown():
    """auto_sanitize_cjk chỉ thay chữ có trong bảng phiên âm hoặc replace.json.
    Phần CJK còn lại giữ nguyên để LLM dịch — TUYỆT ĐỐI không xóa."""
    # "淄" -> "Tri", "众" -> "chúng" (có trong COMMON_CJK_TRANSLIT)
    # "玄" (huyền) không có trong bảng phiên âm mặc định -> phải giữ nguyên
    raw = "Hắn tới 淄 phường, nhìn thấy 众 đệ tử cùng Huyền Vũ 玄。"
    sanitized = auto_sanitize_cjk(raw, replacements={"玄": "Huyền"})
    assert "Tri phường" in sanitized
    assert "chúng đệ tử" in sanitized
    assert "Huyền Vũ Huyền" in sanitized

    # Khi không có replacement cho ký tự CJK lạ: ký tự đó phải còn nguyên
    raw_unknown = "Đoạn văn chứa chữ Hán lạ: 乾 và 坤 chưa có trong từ điển."
    kept = auto_sanitize_cjk(raw_unknown)
    assert "乾" in kept
    assert "坤" in kept


def test_1_1_cjk_adjacent_boundary_replacement():
    """Key chữ Hán nằm sát chữ Hán khác không bị chặn bởi regex biên từ."""
    # Hai chữ Hán liền kề không có khoảng trắng
    text = "淄眾 cùng xuất hiện"
    # replacements có "淄" và "眾"
    res = normalize_text(text, {"淄": "Tri", "眾": "chúng"})
    assert res == "Tri chúng cùng xuất hiện" or res == "Trichúng cùng xuất hiện" or "Tri" in res

    # Chữ Hán nằm sát chữ Hán khác
    text_adjacent = "众淄"
    res_adj = normalize_text(text_adjacent, {"众": "chúng", "淄": "Tri"})
    assert "chúng" in res_adj and "Tri" in res_adj

    # Từ Latin liền kề vẫn được bảo vệ biên từ chuẩn
    text_latin = "Chương trình mới bắt đầu cùng Ch mới."
    res_latin = normalize_text(text_latin, {"Ch": "X"})
    assert res_latin == "Chương trình mới bắt đầu cùng X mới."


def test_1_1_strip_cjk_last_resort():
    """strip_cjk chỉ là phương án cuối cùng, trả về chuỗi sạch và số ký tự đã xóa."""
    text = "Văn bản đã sạch chữ 乾坤 này."
    cleaned, count = strip_cjk(text)
    assert count == 2
    assert "乾" not in cleaned and "坤" not in cleaned
    assert cleaned == "Văn bản đã sạch chữ này."


# =====================================================================
# PHASE 1.2: validate mở rộng ở tầng chunk
# =====================================================================


def test_1_2_validate_catches_cjk_characters():
    """validate phải bắt lỗi nếu chunk còn sót CJK."""
    orig = "Đoạn văn gốc bình thường."
    rewr = "Đoạn văn viết lại còn dính chữ 宗 môn."
    probs = validate(orig, rewr, {})
    assert any("còn sót CJK" in p for p in probs)
    assert any("宗" in p for p in probs)


def test_1_2_validate_catches_fullwidth_and_mojibake():
    """validate bắt lỗi ký tự fullwidth, mojibake và U+FFFD."""
    orig = "Câu chuyện tiếp diễn."
    # Ký tự hỏng U+FFFD
    assert any("U+FFFD" in p for p in validate(orig, "Câu chuyện tiếp diễn \ufffd.", {}))
    # Fullwidth dấu chấm than hoặc ngoặc
    assert any("fullwidth" in p for p in validate(orig, "Câu chuyện tiếp diễn！", {}))
    assert any("fullwidth" in p for p in validate(orig, "Câu chuyện tiếp diễn　với space.", {}))
    # Mojibake
    assert any("mojibake" in p for p in validate(orig, "Câu chuyÃ¡n tiÃªp diÃªn.", {}))


def test_1_2_validate_catches_prompt_leaks_and_leadins():
    """validate bắt lỗi lời dẫn AI và các mảnh rò rỉ prompt."""
    orig = "Hắn bước vào sơn môn."
    # Lời dẫn AI
    assert any("lời dẫn AI" in p for p in validate(orig, "Dưới đây là bản viết lại: Hắn bước vào sơn môn.", {}))
    assert any("lời dẫn AI" in p for p in validate(orig, "Chắc chắn rồi! Hắn bước vào sơn môn.", {}))
    # Rò rỉ prompt
    assert any("rò rỉ prompt" in p for p in validate(orig, "Bảng thuật ngữ: Hắn bước vào sơn môn.", {}))
    assert any("rò rỉ prompt" in p for p in validate(orig, "Yêu cầu bắt buộc: không thêm bớt tình tiết.", {}))


def test_1_2_validate_catches_truncated_terminal_punctuation():
    """validate bắt lỗi câu cuối mất dấu kết câu trong khi bản gốc có."""
    orig = "Hắn nhìn về phía chân trời xa xăm."
    rewr_no_dot = "Hắn nhìn về phía chân trời xa xăm"
    probs = validate(orig, rewr_no_dot, {})
    assert any("câu cuối mất dấu kết câu" in p for p in probs)

    rewr_ok = "Hắn nhìn về phía chân trời xa xăm."
    assert not any("câu cuối mất dấu kết câu" in p for p in validate(orig, rewr_ok, {}))


def test_1_2_validate_catches_non_stop_finish_reason():
    """validate bắt lỗi khi finish_reason khác STOP (bị cắt token)."""
    orig = "Đoạn văn vừa vặn."
    rewr = "Đoạn văn vừa vặn."
    assert any("finish_reason" in p for p in validate(orig, rewr, {}, finish_reason="LENGTH"))
    assert not any("finish_reason" in p for p in validate(orig, rewr, {}, finish_reason="STOP"))


def test_1_2_build_prompt_includes_previous_errors():
    """Khi retry, prompt phải đưa vào danh sách lỗi cụ thể của lần trước."""
    errors = ["còn sót CJK (1 ký tự: 宗)", "thiếu thuật ngữ: Cổ Oai"]
    p = build_prompt("Đoạn gốc.", {}, "", previous_errors=errors)
    assert "LƯU Ý QUAN TRỌNG: Lần thử trước chưa đạt các tiêu chí sau" in p
    assert "- còn sót CJK (1 ký tự: 宗)" in p
    assert "- thiếu thuật ngữ: Cổ Oai" in p


# =====================================================================
# PHASE 1.3: Vòng tự sửa theo mức (Tiered Self-Healing)
# =====================================================================


def test_1_3_deterministic_fixes_tier1():
    """Mức 1 tự động sửa xác định: bỏ dòng dẫn AI, bỏ rò rỉ prompt, chuẩn ngoặc, chuẩn ký tự."""
    raw = (
        "Dưới đây là đoạn văn viết lại:\n"
        "Bảng thuật ngữ:\n"
        "Hắn thi triển 【Cửu Kiếm】 với uy lực lớn \ufffd.\n"
        "Hắn thi triển 【Cửu Kiếm】 với uy lực lớn \ufffd.\n"
    )
    fixed = apply_deterministic_fixes(raw, original="Bản gốc kết câu.", subset={"Cửu Kiếm": "Cửu Dương Kiếm"})
    assert "Dưới đây là" not in fixed
    assert "Bảng thuật ngữ" not in fixed
    assert "\ufffd" not in fixed
    assert "(Cửu Dương Kiếm)" in fixed
    # Gộp lặp
    assert fixed.count("Cửu Dương Kiếm") == 1
    # Đảm bảo dấu kết câu
    assert fixed.endswith(".")


class ScriptedProvider:
    name = "scripted"

    def __init__(self, responses: list[str]):
        self._responses = list(responses)
        self.calls = 0
        self.prompts: list[str] = []

    def complete(self, prompt: str) -> str:
        self.calls += 1
        self.prompts.append(prompt)
        if self._responses:
            return self._responses.pop(0)
        return "Văn bản mặc định an toàn."


def test_1_3_tiered_self_healing_resolves_at_tier2():
    """Lần 1 lỗi CJK (chữ lạ chưa có trong bảng phiên âm), lần 2 nhận feedback lỗi và sửa sạch -> đạt ở Tier 2."""
    orig = "Tần Thiên tiến bước vào đại điện nguy nga."
    # Lần 1: LLM vô tình sót chữ CJK lạ 玄 (không có trong COMMON_CJK_TRANSLIT)
    res1 = "Tần Thiên tiến bước vào 玄 đại điện nguy nga."
    # Lần 2: LLM sửa sạch chữ 玄
    res2 = "Tần Thiên tiến bước vào Huyền Vũ đại điện nguy nga."

    provider = ScriptedProvider([res1, res2])
    client = LLMClient([provider], sleep=_NO_SLEEP)
    cache: dict[str, str] = {}

    r = rewrite_part(orig, {}, "", client, cache, attempts=3)
    assert r["tier"] == "tier2"
    assert r["attempts"] == 2
    assert provider.calls == 2
    assert "LƯU Ý QUAN TRỌNG" in provider.prompts[1]
    assert "còn sót CJK" in provider.prompts[1]
    assert r["text"] == "Tần Thiên tiến bước vào Huyền Vũ đại điện nguy nga."


def test_1_3_tiered_self_healing_fallback_with_cjk_stripping():
    """Hết 3 mức vẫn lỗi: chọn bản ít lỗi nhất, xóa CJK còn sót như phương án cuối."""
    orig = "Kiểm tra phương án xử lý cuối cùng của quy trình."
    # Cả 3 lần LLM đều cố chấp để sót CJK 乾
    res_bad = "Kiểm tra phương án xử lý cố chấp dính chữ 乾."

    provider = ScriptedProvider([res_bad, res_bad, res_bad])
    client = LLMClient([provider], sleep=_NO_SLEEP)
    cache: dict[str, str] = {}

    r = rewrite_part(orig, {}, "", client, cache, attempts=3, strip_cjk_fallback=True)
    assert r["tier"] == "fallback"
    assert r["attempts"] == 3
    assert provider.calls == 3
    # Phương án cuối: đã xóa CJK còn sót
    assert "乾" not in r["text"]
    assert r["cjk_stripped"] == 1


# =====================================================================
# PHASE 1.4: Prompt mới & Model settings
# =====================================================================


def test_1_4_prompt_contains_pacing_and_spoken_vietnamese_requirements():
    """Prompt mới phải có yêu cầu câu ngắn (<= 25 từ), văn nói tự nhiên."""
    p = build_prompt("Bản gốc ngắn.", {}, "")
    assert "tối đa khoảng 25 từ" in p
    assert "văn nói tự nhiên" in p
    assert "giàu cảm xúc, đọc lên trôi chảy" in p
    assert "Tách các câu dài phức tạp bằng dấu chấm hoặc dấu phẩy" in p


def test_1_4_prompt_version_bumped():
    """PROMPT_VERSION phải được tăng (không còn là '1')."""
    assert PROMPT_VERSION != "1"
    assert config.PROMPT_VERSION != "1"
    assert config.DEFAULT_TEMPERATURE == 0.3
