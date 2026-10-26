"""T5.6 — QA gate chương: phát hiện CJK sót, rò rỉ prompt, ngoặc lệch,
độ dài lệch, sai/cắt cụt, câu lặp, thiếu thuật ngữ; ngưỡng cấu hình được."""

from story_audio.qa import DEFAULT_QA, qa_cfg_from_payload, qa_check

G = {"Nhiên Dạ": "Nhiên Khanh"}
ORIG = "Nhiên Dạ đứng dậy. Hắn nhìn quanh một lượt rồi bước đi."
CLEAN = "Nhiên Khanh đứng dậy. Hắn nhìn quanh một lượt rồi bước đi."


def test_qa_clean_passes():
    assert qa_check(CLEAN, ORIG, G) == []


def test_qa_empty_output_flagged():
    assert qa_check("  ", ORIG, G) == ["đầu ra rỗng"]


def test_qa_cjk_residue_configurable():
    # original cùng chiều dài với đầu ra để riêng CJK là prize duy nhất
    base = "Hắn nhìn ra cửa rồi."
    flagged = qa_check("Hắn nhìn 天 cửa rồi.", base, {})
    assert any("CJK" in p for p in flagged)
    # nới ngưỡng trên số CJK hiện có → hợp lệ, không blindly từ chối phong cách
    assert qa_check("Hắn nhìn 天 cửa rồi.", base, {},
                    qa_cfg_from_payload({"cjk_max": 5})) == []


def test_qa_prompt_leak_flagged():
    leak = "Ngữ cảnh: viết tiếp đoạn sau đây cho cẩn thận thôi."
    assert any("rò rỉ prompt" in p for p in qa_check(leak, ORIG[:40] + ".", G))


def test_qa_brackets_balance():
    base = "Hắn nói ghi cả ba loại ngoặc này đây poung."
    assert qa_check(base, base, {}) == []  # không ngoặc lệch → sạch
    lopsided = "Hắn nói ghi (ba loại ngoặc thiếu đóng poung."
    assert any("ngoặc lệch (" in p for p in qa_check(lopsided, base, {}))


def test_qa_length_ratio_configurable():
    orig = "A" * 99 + "."
    stretched = "B" * 159 + "."  # tỉ lệ 1.6
    assert any("độ dài lệch QA" in p for p in qa_check(stretched, orig, {}))
    # nới biên cấu hình → chấp nhận khác biệt sau khi biên tập
    assert qa_check(stretched, orig, {}, qa_cfg_from_payload({"max_ratio": 1.7})) == []


def test_qa_repeated_sentences():
    dup = "Một hai ba bốn năm sáu bảy tám. " * 4
    assert any("câu lặp lại" in p for p in qa_check(dup.strip(), dup.strip(), G))
    # nới repeat_max lên 4 → 4 lần lặp không còn là dị thường
    assert qa_check(dup.strip(), dup.strip(), G,
                    qa_cfg_from_payload({"repeat_max": 4})) == []


def test_qa_truncated_output():
    orig = "Hắn mở cửa. Rồi bước đi luôn không nói nốt lời nào nữa."
    cut = "Hắn mở cửa. Rồi bước đi luôn không nói nốt lời"  # không dấu kết
    assert any("cắt cụt" in p for p in qa_check(cut, orig, G))
    # bản kết trọn câu → sạch
    ok = "Hắn mở cửa. Rồi bước đi luôn không nói nốt lời nào nữa."
    assert qa_check(ok, orig, G) == []


def test_qa_glossary_mismatch():
    missing = "Nhiên Dạ đứng dậy. Hắn nhìn quanh một lượt rồi bước đi."
    assert any("thiếu thuật ngữ QA" in p for p in qa_check(missing, ORIG, G))


def test_qa_glossary_all_missing_terms_reported_no_limit():
    """Kiểm chứng bỏ giới hạn [:3]: khi thiếu >= 4 thuật ngữ, toàn bộ phải được báo."""
    orig = "A Di Đà, Nhiên Dạ, Chấp Địa Tạng, Khương Vô Ưu cùng bước vào."
    # Bản dịch thiếu cả 4 thuật ngữ
    text = "Hắn bước vào đại điện một mình, không thấy ai khác xung quanh."
    glossary = {
        "A Di Đà": "A Di Đà",
        "Nhiên Dạ": "Nhiên Dạ",
        "Chấp Địa Tạng": "Chấp Địa Tạng",
        "Khương Vô Ưu": "Khương Vô Ưu",
    }
    probs = qa_check(text, orig, glossary)
    missing_prob = next((p for p in probs if "thiếu thuật ngữ QA" in p), None)
    assert missing_prob is not None
    assert "A Di Đà" in missing_prob
    assert "Nhiên Dạ" in missing_prob
    assert "Chấp Địa Tạng" in missing_prob
    assert "Khương Vô Ưu" in missing_prob


def test_qa_cfg_coercion_rejects_junk():
    cfg = qa_cfg_from_payload(
        {"cjk_max": "5", "repeat_max": True, "min_ratio": 0.5, "max_ratio": 9, "lạ": 1}
    )
    assert cfg == {**DEFAULT_QA, "min_ratio": 0.5, "max_ratio": 9}
    assert qa_cfg_from_payload(None) == dict(DEFAULT_QA)
    assert qa_cfg_from_payload("rác") == dict(DEFAULT_QA)
