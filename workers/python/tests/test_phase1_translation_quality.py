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
    split_sentences,
    strip_cjk,
)
from story_audio.providers import LLMClient
from story_audio.qa import qa_check
from story_audio.rewrite import (
    PROMPT_VERSION,
    apply_deterministic_fixes,
    build_prompt,
    cache_key,
    glossary_subset,
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


# =====================================================================
# BỔ SUNG CÁC TEST THEO 11 TIÊU CHÍ NGHIỆM THU
# =====================================================================


def test_item1_glossary_self_healing_tier1_deterministic_fix():
    """Mục 1: Mức 1 tự động thay thuật ngữ chuẩn nếu raw có key và LLM để sót key thô."""
    orig = "khương không lo cùng Dưỡng Tâm Cung chủ đứng đợi ở ngoài điện."
    glossary = {
        "khương không lo": "Khương Vô Ưu",
        "Dưỡng Tâm Cung chủ": "Dưỡng Tâm Cung chủ",
    }
    # LLM giữ nguyên cụm convert thô "khương không lo"
    raw_llm = "Hắn nhìn thấy khương không lo cùng Dưỡng Tâm Cung chủ đang đứng đợi ở đại điện."
    fixed = apply_deterministic_fixes(raw_llm, original=orig, subset=glossary)
    assert "Khương Vô Ưu" in fixed
    assert "Dưỡng Tâm Cung chủ" in fixed
    assert validate(orig, fixed, glossary) == []


def test_item1_glossary_self_healing_tier2_feedback_retry():
    """Mục 1: Mức 2 tự sửa khi LLM bỏ quên hoàn toàn thuật ngữ (không có cả key thô)."""
    orig = "khương không lo xuất hiện với khí thế lẫm liệt."
    glossary = {"khương không lo": "Khương Vô Ưu"}

    # Lần 1: LLM quên hẳn tên Khương Vô Ưu
    res1 = "Vị vương gia trẻ tuổi xuất hiện với khí thế lẫm liệt."
    # Lần 2: Nhận lỗi thiếu thuật ngữ và đưa đúng tên vào (giữ đúng tỉ lệ độ dài)
    res2 = "Khương Vô Ưu xuất hiện với khí thế lẫm liệt."

    provider = ScriptedProvider([res1, res2])
    client = LLMClient([provider], sleep=_NO_SLEEP)
    cache: dict[str, str] = {}

    r = rewrite_part(orig, glossary, "", client, cache, attempts=3)
    assert r["tier"] == "tier2"
    assert r["attempts"] == 2
    assert "thiếu thuật ngữ: Khương Vô Ưu" in provider.prompts[1]
    assert "Khương Vô Ưu" in r["text"]


def test_item5_no_blind_terminal_append_when_truncated():
    """Mục 5: Mức 1 KHÔNG được tự ý bù dấu chấm khi câu bị cắt cụt; phải để validate bắt lỗi."""
    orig = "Hắn bước vào sân rồi rút thanh trường kiếm ra."
    # Câu bị cắt cụt do chạm token limit (thiếu dấu kết câu và cụt ý)
    truncated = "Hắn bước vào sân rồi rút thanh trường kiếm ra sau đó thì"
    fixed = apply_deterministic_fixes(truncated, original=orig, subset={})
    # Không được tự ý nhét '.' vào đuôi câu cụt
    assert not fixed.endswith(".")
    probs = validate(orig, fixed, {})
    assert any("câu cuối mất dấu kết câu" in p for p in probs)


def test_item6_nfkc_ellipsis_and_split_sentences():
    """Mục 6: NFKC bảo toàn dấu '…' và các dấu câu khác; split_sentences tách câu chuẩn xác."""
    text_with_ellipsis = "Hắn im lặng hồi lâu… Rồi thở dài một tiếng! “Đi thôi…”"
    cleaned = clean_corrupted_chars(text_with_ellipsis)
    # Dấu ba chấm '…' (U+2026) được bảo toàn
    assert "…" in cleaned
    assert "..." not in cleaned

    # Tách câu đúng trên cả '…' và '!' và ngoặc thoại
    sentences = split_sentences(cleaned)
    assert len(sentences) == 3
    assert sentences[0] == "Hắn im lặng hồi lâu…"
    assert sentences[1] == "Rồi thở dài một tiếng!"
    assert sentences[2] == "“Đi thôi…”"

    # Với chuỗi có fullwidth
    fw_text = "Chào các bạn！Các bạn có khoẻ không？Tôi rất khoẻ．"
    fw_cleaned = clean_corrupted_chars(fw_text)
    assert "！" not in fw_cleaned and "!" in fw_cleaned
    assert "？" not in fw_cleaned and "?" in fw_cleaned
    assert "．" not in fw_cleaned and "." in fw_cleaned
    fw_sentences = split_sentences(fw_cleaned)
    assert len(fw_sentences) == 3


def test_item7_dialogue_repetition_threshold():
    """Mục 7: Thoại lặp hợp lệ (2-3 lần) được GIỮ NGUYÊN; chỉ gộp khi lặp > repeat_max (> 3 lần)."""
    # Lời thoại lặp 2 lần thể hiện cảm xúc khẩn cấp -> GIỮ NGUYÊN
    dialogue_2 = "“Chạy mau đi! Chạy mau đi!” Hắn hét lớn."
    fixed_2 = apply_deterministic_fixes(dialogue_2)
    assert "Chạy mau đi! Chạy mau đi!" in fixed_2

    # Lời thoại lặp 3 lần -> GIỮ NGUYÊN (<= repeat_max = 3)
    dialogue_3 = "Cứu mạng! Cứu mạng! Cứu mạng! Ai đó cứu với!"
    fixed_3 = apply_deterministic_fixes(dialogue_3)
    assert fixed_3.count("Cứu mạng!") == 3

    # LLM kẹt loop lặp 7 lần liên tiếp câu trần thuật dài -> gộp về 1 câu
    hallucination = "Trời sẫm tối thật rồi. " * 7
    fixed_loop = apply_deterministic_fixes(hallucination)
    assert fixed_loop.count("Trời sẫm tối thật rồi.") == 1


def test_requirement3_cache_hit_invalid_triggers_self_healing():
    """Yêu cầu 3: Cache hit mà validate trượt: coi như cache miss và kích hoạt vòng tự sửa."""
    part = "Đoạn văn gốc cần viết lại một cách tự nhiên và trôi chảy."
    key = cache_key(part, {})
    # Cache chứa text bị lỗi (chứa CJK chưa dịch)
    corrupted_cache = {key: "Đoạn văn viết lại có chữ Hán 宗 môn chưa dịch."}
    
    # LLM trả về bản sạch chuẩn
    clean_llm = "Đoạn văn viết lại hoàn chỉnh tự nhiên và không còn lỗi nào."
    provider = ScriptedProvider([clean_llm])
    client = LLMClient([provider])

    r = rewrite_part(part, {}, "", client, corrupted_cache)
    # Không được nhận bản lỗi từ cache
    assert r["cached"] is False
    assert r["tier"] in ("tier1", "tier2")
    assert r["calls"] >= 1
    assert "宗" not in r["text"]
    assert r["text"] == clean_llm
    # Cache được cập nhật bản sạch mới
    assert corrupted_cache[key] == clean_llm


def test_requirement3_fallback_not_cached():
    """Yêu cầu 3: Kết quả fallback tuyệt đối KHÔNG được ghi vào cache."""
    part = "Bản gốc truyện convert."
    key = cache_key(part, {})
    cache: dict[str, str] = {}
    
    # Mọi lượt LLM đều trả về text hỏng (quá ngắn < MIN_RATIO)
    provider = ScriptedProvider(["Quá ngắn.", "Vẫn ngắn.", "Ngắn."])
    client = LLMClient([provider])

    r = rewrite_part(part, {}, "", client, cache, attempts=3)
    assert r["tier"] == "fallback"
    assert r["cached"] is False
    # Key tuyệt đối không có trong cache
    assert key not in cache


def test_requirement4_nfc_glossary_duong_tam_cung_chu_and_khuong_vo_ta():
    """Yêu cầu 4: So khớp glossary (validate và QA Gate) chuẩn hóa NFC hai vế và không phân biệt hoa thường.
    Kiểm tra cụ thể 'Dưỡng Tâm Cung chủ' với u\\u0309 và 'khương vô tà'."""
    # 1. 'Dưỡng Tâm Cung chủ' với combining accent u\u0309
    raw_combining = "Đại điện vắng vẻ, Dưỡng Tâm Cung chu\u0309 cùng khương vô tà đứng ngoài cửa."
    glossary = {
        "Dưỡng Tâm Cung chu\u0309": "Dưỡng Tâm Cung chủ",  # key có combining accent
        "khương vô tà": "Khương Vô Tà",                   # key viết thường toàn bộ
    }
    subset = glossary_subset(raw_combining, glossary)
    assert len(subset) == 2

    # Văn bản đầu ra chuẩn hóa precomposed NFC
    rewritten = "Đại điện vắng vẻ, Dưỡng Tâm Cung chủ cùng Khương Vô Tà đứng ngoài cửa."
    
    # validate tầng chunk
    probs_val = validate(raw_combining, rewritten, subset)
    assert probs_val == []

    # QA Gate tầng chương
    probs_qa = qa_check(rewritten, raw_combining, glossary)
    assert probs_qa == []

    # Trường hợp bản gốc viết hoa 'Khương Vô Tà', glossary viết thường 'khương vô tà'
    raw_capitalized = "Khương Vô Tà chậm rãi bước vào đại điện nguy nga tráng lệ."
    subset_cap = glossary_subset(raw_capitalized, glossary)
    assert "khương vô tà" in subset_cap
    fixed_text = apply_deterministic_fixes("khương vô tà bước vào đại điện nguy nga.", subset=subset_cap)
    assert "Khương Vô Tà" in fixed_text


def test_requirement5_tier3_sentence_line_mismatch_handling():
    """Yêu cầu 5: Mức 3 xử lý khi số dòng LLM trả về khác số câu gửi đi."""
    # Bản gốc có 3 câu
    part = "Câu thứ nhất rất rõ ràng. Câu thứ hai tiếp diễn nhịp nhàng. Câu thứ ba kết thúc trọn vẹn."
    orig_s = split_sentences(part)
    assert len(orig_s) == 3

    # LLM ở Mức 3 trả về 2 dòng (gộp câu 1 và câu 2 vào cùng một dòng)
    llm_2_lines = "Câu thứ nhất rất rõ ràng và câu thứ hai tiếp diễn nhịp nhàng.\nCâu thứ ba kết thúc trọn vẹn."
    
    # Provider mô phỏng 2 lượt đầu fail, lượt 3 vào sentence mode với 2 dòng
    provider = ScriptedProvider([
        "Lỗi một còn sót CJK 宗.",
        "Lỗi hai còn sót CJK 宗.",
        llm_2_lines,
    ])
    client = LLMClient([provider])
    cache: dict[str, str] = {}

    r = rewrite_part(part, {}, "", client, cache, attempts=3)
    assert r["tier"] == "tier3"
    assert r["calls"] == 3
    assert r["problems"] == []
    # Văn bản được ghép chuẩn xác
    assert "Câu thứ nhất rất rõ ràng" in r["text"]
    assert "Câu thứ ba kết thúc trọn vẹn." in r["text"]


# =====================================================================
# PHASE 1 PHẢN HỒI BỔ SUNG: Item 3, 4, 5
# =====================================================================


def test_item3_qa_check_case_difference_warning():
    """Item 3: qa.py: bản dịch lệch hoa thường chỉ ghi warning, không kích hoạt retry (problems = [])."""
    orig = "Khâu Cát cẩn thận thưa: Lý nguyên soái cùng Định Viễn Hầu vừa tới."
    # Bản dịch dùng 'Định Viễn Hầu' trong khi glossary yêu cầu 'Định Viễn hầu'
    trans = "Khâu Cát cẩn thận thưa: Lý nguyên soái cùng Định Viễn Hầu vừa tới nơi."
    glossary = {"Định Viễn Hầu": "Định Viễn hầu"}
    warnings: list[str] = []
    probs = qa_check(trans, orig, glossary, warnings=warnings)
    assert probs == []
    assert any("lệch hoa thường: Định Viễn hầu" in w for w in warnings)


def test_item4_glossary_pre_replace_and_token_restore_when_llm_changes_name():
    """Item 4: Thay thuật ngữ glossary trước khi gửi LLM và khôi phục token.
    LLM mock cố tình đổi tên nhân vật, kết quả vẫn ra đúng tên glossary chuẩn."""
    part = "Khương Không Lo chậm rãi bước ra từ trong bóng tối, nhìn về phía chân trời xa xôi."
    subset = {"Khương Không Lo": "Khương Vô Ưu"}

    # Mock LLM mô phỏng trường hợp LLM cố tình đổi tên nhân vật khác (ví dụ: 'Trương Vô Kỵ' hoặc 'Khương Vô Lượng')
    # nhưng vì pipeline đã mã hóa token giữ chỗ [[GLOSS_TOKEN_0]], LLM giữ token và dịch câu xuôi
    class RenamingMockProvider:
        name = "mock_renaming"

        def complete(self, prompt: str, system: str = "") -> str:
            # Kiểm chứng prompt đã được bảo vệ bằng token giữ chỗ
            assert "[[GLOSS_TOKEN_0]]" in prompt
            # LLM dịch văn xuôi tự nhiên xung quanh token
            return "[[GLOSS_TOKEN_0]] chậm rãi bước ra từ bóng tối mịt mùng, ngước nhìn về phía chân trời xa xăm."

    client = LLMClient([RenamingMockProvider()])
    cache: dict[str, str] = {}

    res = rewrite_part(part, subset, "", client, cache)
    assert res["problems"] == []
    # Kết quả cuối cùng BẮT BUỘC chứa đúng tên chuẩn 'Khương Vô Ưu'
    assert "Khương Vô Ưu" in res["text"]
    assert "Khương Không Lo" not in res["text"]
    assert "[[GLOSS_TOKEN_0]]" not in res["text"]


def test_item5_content_coverage_sentences_and_digits_and_retry_from_original_chunk():
    """Item 5: Đo độ phủ nội dung ở tầng chunk: số câu, số liệu; chunk thiếu câu gọi lại từ BẢN GỐC."""
    orig = (
        "Trận chiến diễn ra tại đỉnh núi cao 2850 trượng. "
        "Quân số tham chiến lên tới 500 vạn binh mã. "
        "Sau ba ngày ba đêm kịch chiến, thế cục ngã ngũ. "
        "Toàn bộ kẻ địch đều bị tiêu diệt sạch sẽ."
    )
    subset = {}

    # 1. Kiểm tra validate: thiếu câu (> 50% số câu gốc)
    incomplete_draft = "Trận chiến diễn ra rất ác liệt tại đỉnh núi cao 2850 trượng."
    probs_incomplete = validate(orig, incomplete_draft, subset)
    assert any("thiếu câu" in p for p in probs_incomplete)

    # 2. Kiểm tra validate: thiếu số liệu (ví dụ thiếu '2850' hoặc '500')
    draft_missing_nums = (
        "Trận chiến diễn ra tại đỉnh núi cao vời vợi. "
        "Quân số tham chiến đông đảo vô số kể. "
        "Sau nhiều ngày kịch chiến, thế cục ngã ngũ. "
        "Toàn bộ kẻ địch đều bị tiêu diệt sạch sẽ."
    )
    probs_missing_nums = validate(orig, draft_missing_nums, subset)
    assert any("thiếu số liệu" in p for p in probs_missing_nums)
    assert any("2850" in p or "500" in p for p in probs_missing_nums)

    # Số nhỏ như '3' được dịch thành 'ba' không bị báo thiếu số liệu
    draft_with_words = (
        "Trận chiến diễn ra tại đỉnh núi cao 2850 trượng. "
        "Quân số tham chiến lên tới 500 vạn binh mã. "
        "Sau ba ngày kịch chiến, thế cục đã ngã ngũ. "
        "Toàn bộ kẻ địch đều bị tiêu diệt sạch sẽ."
    )
    assert not any("thiếu số liệu" in p for p in validate(orig, draft_with_words, subset))

    # 3. Kiểm tra retry: chunk thiếu câu phải được gọi lại từ BẢN GỐC (chứa đủ 2850 và 500 vạn)
    prompts_received = []

    class CapturingProvider:
        name = "capturing"
        calls = 0

        def complete(self, prompt: str, system: str = "") -> str:
            self.calls += 1
            prompts_received.append(prompt)
            if self.calls == 1:
                # Lần 1 trả về thiếu câu
                return incomplete_draft
            # Lần 2 sửa lại đầy đủ
            return draft_with_words

    client = LLMClient([CapturingProvider()])
    cache: dict[str, str] = {}

    res = rewrite_part(orig, subset, "", client, cache, attempts=2)
    assert res["tier"] == "tier2"
    assert res["problems"] == []

    # Kiểm chứng: Lần gọi thứ 2 gửi prompt chứa BẢN GỐC (chứa '2850 trượng' và '500 vạn')
    assert len(prompts_received) == 2
    assert "2850 trượng" in prompts_received[1]
    assert "500 vạn binh mã" in prompts_received[1]
    assert "LƯU Ý QUAN TRỌNG" in prompts_received[1]



