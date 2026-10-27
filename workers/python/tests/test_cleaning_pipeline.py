"""Test suite kiểm thử các bộ lọc dọn dẹp hệ thống:
1. clean_llm_reasoning_and_cot: Dọn dẹp CoT, thẻ <think> và đoạn suy luận tiếng Anh của DeepSeek-R1.
2. strip_author_notes: Tự động loại bỏ lời cảm ơn minh chủ, donate, chú thích tác giả ở cuối chương.
3. Han-Viet transliteration: Đảm bảo các ký tự Hán tự như 尉獠 được phiên âm chuẩn Úy Liêu.
"""

from __future__ import annotations

import pytest

from story_audio.normalize import (
    COMMON_CJK_TRANSLIT,
    auto_sanitize_cjk,
    strip_author_notes,
)
from story_audio.rewrite import (
    apply_deterministic_fixes,
    clean_llm_reasoning_and_cot,
    validate,
)


def test_clean_think_tags():
    raw = "<think>\nThinking about the translation...\nDeepSeek-R1 logic\n</think>\nKhương Vô Ưu đứng trên đỉnh núi."
    cleaned = clean_llm_reasoning_and_cot(raw)
    assert cleaned.strip() == "Khương Vô Ưu đứng trên đỉnh núi."


def test_clean_unclosed_think_tag():
    raw = "<think>\nUnclosed reasoning\nKhương Vô Ưu đứng trên đỉnh núi."
    cleaned = clean_llm_reasoning_and_cot(raw)
    assert "Unclosed reasoning" not in cleaned
    assert "Khương Vô Ưu đứng trên đỉnh núi." in cleaned


def test_clean_english_cot_planning_block():
    raw = (
        "We need rewrite the given passage into natural Vietnamese, short sentences, keep names and terms. "
        "Must keep original order and number of sentences. We need to count original sentences. Let's parse original:\n\n"
        "Original text:\n\n"
        "Count sentences: Let's split by period or question mark. Sentences:\n\n"
        "1. Sentence 1.\n2. Sentence 2.\n\n"
        "Sentence1: “Không có sức mạnh, trí tuệ chỉ là lâu đài vô hình, ý chí chỉ là cỏ gãy gió.”\n\n"
        "Khương Vô Ưu mỉm cười nói: “Chúng ta đi thôi.”"
    )
    cleaned = clean_llm_reasoning_and_cot(raw)
    assert "We need rewrite" not in cleaned
    assert "Let's parse original" not in cleaned
    assert "Count sentences" not in cleaned
    assert "Khương Vô Ưu mỉm cười" in cleaned


def test_clean_markdown_code_fence():
    raw = "```markdown\nKhương Vô Ưu mỉm cười nói: “Chúng ta đi thôi.”\n```"
    cleaned = clean_llm_reasoning_and_cot(raw)
    assert "```" not in cleaned
    assert cleaned == "Khương Vô Ưu mỉm cười nói: “Chúng ta đi thôi.”"


def test_strip_author_notes_tail():
    paragraphs = [
        "Khương Vô Ưu quay người bước vào bóng đêm.",
        "Tiếng gió rít gào qua khe núi như tiếng thở dài của trời đất.",
        "Cảm ơn thư hữu 'Miết Niết Va Miêu Đầu Ưng' trở thành minh chủ thứ 1016 của bản thư!",
        "Tấu chương hết, hẹn gặp lại quý độc giả vào ngày mai.",
    ]
    cleaned = strip_author_notes(paragraphs)
    assert len(cleaned) == 2
    assert cleaned[0] == "Khương Vô Ưu quay người bước vào bóng đêm."
    assert cleaned[1] == "Tiếng gió rít gào qua khe núi như tiếng thở dài của trời đất."


def test_strip_author_notes_ps_and_vote():
    paragraphs = [
        "Đao quang chợt lóe, thiên địa yên lặng.",
        "PS: Hôm nay tác giả có chút việc bận nên đăng trễ 1 chút.",
        "Cầu nguyệt phiếu, cầu đề cử hoa!",
    ]
    cleaned = strip_author_notes(paragraphs)
    assert len(cleaned) == 1
    assert cleaned[0] == "Đao quang chợt lóe, thiên địa yên lặng."


def test_uy_lieu_translit():
    assert COMMON_CJK_TRANSLIT.get("尉獠") == "Úy Liêu"
    assert COMMON_CJK_TRANSLIT.get("尉") == "Úy"
    assert COMMON_CJK_TRANSLIT.get("獠") == "Liêu"

    text = "尉獠 đang mài đao."
    trans = auto_sanitize_cjk(text)
    assert "尉獠" not in trans
    assert "Úy Liêu đang mài đao." in trans


def test_apply_deterministic_fixes_cleans_cot():
    raw = (
        "We need rewrite the given passage into natural Vietnamese.\n"
        "Khương Vô Ưu đứng trên đỉnh núi nhìn xuống chân thành."
    )
    fixed = apply_deterministic_fixes(raw)
    assert "We need rewrite" not in fixed
    assert "Khương Vô Ưu đứng trên đỉnh núi" in fixed


def test_auto_balance_quotes():
    from story_audio.normalize import auto_balance_quotes
    
    # 1. Unclosed open quote at line end
    text1 = "Hắn nhìn nàng nói: “Ta nhất định sẽ trở lại."
    balanced1 = auto_balance_quotes(text1)
    assert balanced1 == "Hắn nhìn nàng nói: “Ta nhất định sẽ trở lại.”"
    
    # 2. Odd straight quotes
    text2 = 'Hắn nói: "Ta đi đây.'
    balanced2 = auto_balance_quotes(text2)
    assert balanced2 == 'Hắn nói: "Ta đi đây."'
    
    # 3. Already balanced quotes preserved
    text3 = "Hắn nói: “Được rồi.” Nàng gật đầu: “Đi thôi.”"
    assert auto_balance_quotes(text3) == text3


def test_quote_imbalance_severity_is_formatting():
    from story_audio.config import get_error_severity
    assert get_error_severity("ngoặc thoại lệch (vào 12, ra 4)") == "formatting"


def test_transliterate_pinyin_tokens():
    from story_audio.normalize import transliterate_pinyin_tokens
    
    text = "Úy Liao đứng cạnh Đường Liệt, phía xa là Diệp Chen và Tiêu Xiao."
    fixed = transliterate_pinyin_tokens(text)
    assert "Úy Liao" not in fixed
    assert "Úy Liêu" in fixed
    assert "Diệp Trần" in fixed
    assert "Tiêu Tiêu" in fixed


def test_normalize_narrative_pronouns():
    from story_audio.normalize import normalize_narrative_pronouns
    
    text = (
        "Lâm Quang Minh thay đổi vẻ nghiêm nghị khi huấn luyện. "
        "Anh nhìn chằm chằm vào các đệ tử. "
        "Anh nhấp chén rượu mạnh rồi thở dài. "
        "Nàng bước tới khẽ hỏi: “Anh nhìn bọn họ làm gì?”"
    )
    fixed = normalize_narrative_pronouns(text)
    # Outside dialogue: "Anh nhìn..." -> "Hắn nhìn...", "Anh nhấp..." -> "Hắn nhấp..."
    assert "Hắn nhìn chằm chằm" in fixed
    assert "Hắn nhấp chén rượu" in fixed
    # Inside dialogue: “Anh nhìn bọn họ làm gì?” preserved
    assert "“Anh nhìn bọn họ làm gì?”" in fixed


def test_anti_convert_traps():
    raw = (
        "Lâm Quang Minh rất thưởng thức Đường Liệt vì lòng dũng cảm. "
        "Kẻ địch trong bóng tối đã đặt trước linh hồn của hắn. "
        "Bụng to thì bát cũng phải to, không thể tham lam quá độ."
    )
    fixed = apply_deterministic_fixes(raw)
    assert "thưởng thức Đường Liệt" not in fixed
    assert "đánh giá cao Đường Liệt" in fixed
    assert "đặt trước linh hồn" not in fixed
    assert "nhắm vào linh hồn" in fixed
    assert "tham vọng lớn" in fixed


def test_transliterate_pinyin_does_not_corrupt_vietnamese_words():
    from story_audio.normalize import transliterate_pinyin_tokens
    
    text = (
        "Hắn đứng trên đỉnh cao, là nhân vật cấp cao, được đánh giá cao. "
        "Hắn giơ cao nắm đấm ở nơi cao nhất. "
        "Úy Liao và Diệp Chen cũng bước tới."
    )
    fixed = transliterate_pinyin_tokens(text)
    # MUST NOT convert "cao" to "tào"
    assert "đỉnh cao" in fixed
    assert "cấp cao" in fixed
    assert "đánh giá cao" in fixed
    assert "giơ cao" in fixed
    assert "nơi cao nhất" in fixed
    assert "tào" not in fixed.lower()
    # Pinyin names converted properly
    assert "Úy Liêu" in fixed
    assert "Diệp Trần" in fixed


def test_clean_english_prompt_leakage_and_leadins():
    raw = (
        'Phạm Vô Sử nói: "Các hạ đạp trăng mà đến." '
        'The text is garbled. We need to reconstruct meaning: The young man wearing Dao Bao '
        'looks at Lý quốc pillar: "You know who I am?" Use "hắn" for male narrator. Avoid "anh". '
        'Paragraph 1: "Ồ?" Thiếu niên mặc đạo bào quay đầu lại.\n\n'
        'Đoạn văn viết lại:\n'
        'Một đoàn sương khói bạc trắng cuồn cuộn.'
    )
    cleaned = clean_llm_reasoning_and_cot(raw)
    assert "The text is garbled" not in cleaned
    assert "We need to reconstruct meaning" not in cleaned
    assert "Use \"hắn\" for male narrator" not in cleaned
    assert "Avoid \"anh\"" not in cleaned
    assert "Đoạn văn viết lại:" not in cleaned
    assert 'Phạm Vô Sử nói: "Các hạ đạp trăng mà đến."' in cleaned
    assert 'Một đoàn sương khói bạc trắng cuồn cuộn.' in cleaned


def test_fallback_selection_penalizes_empty_candidate():
    candidates = [
        {"text": "", "problems": ["đầu ra rỗng"], "backend": "devkit", "attempt": 3},
        {"text": "Đoạn văn dịch hợp lệ nhưng thiếu một thuật ngữ.", "problems": ["thiếu thuật ngữ: ABC"], "backend": "devkit", "attempt": 1},
    ]
    def _candidate_penalty(c: dict) -> int:
        probs = c.get("problems", [])
        txt = c.get("text", "")
        if not txt or not txt.strip() or any("đầu ra rỗng" in p for p in probs):
            return 999999
        return len(probs)

    best = min(candidates, key=_candidate_penalty)
    assert best["text"] == "Đoạn văn dịch hợp lệ nhưng thiếu một thuật ngữ."


