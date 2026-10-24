# T9.3 tests — runner regression QA: đếm/order đúng, _log bị bỏ, detector tự-kiểm
# bắn đủ mẫu xấu, flagged hiển thị rõ trong báo cáo. Tmp corpus — không đụng Audio/.
from __future__ import annotations

from pathlib import Path

import pytest

from story_audio.qa import qa_check
from story_audio.regression_qa import (
    collect_material,
    render_report,
    run_qa,
    self_check,
    verify_order,
)


def _chapter(d: Path, num: str, body: str, original: str | None) -> None:
    (d / f"{num}.txt").write_text(body, encoding="utf-8")
    if original is not None:
        src = d / "nguon"
        src.mkdir(exist_ok=True)
        (src / f"{num}.txt").write_text(original, encoding="utf-8")


def test_self_check_config_bắn_đủ_mẫu_xấu() -> None:
    rows = self_check()
    assert len(rows) == 6
    slipped = [r["sample"] for r in rows if not r["detect"]]
    assert slipped == [], slipped


def test_collect_đếm_order_tên_và_log_bỏ_qua(tmp_path: Path) -> None:
    _chapter(tmp_path, "0001", "Một câu trần thuật đủ dài hơn tám chữ.", "nguon 1.")
    _chapter(tmp_path, "0002", "Hai câu trần thuật đủ dài hơn tám chữ.", "nguon 2.")
    (tmp_path / "_log.txt").write_text("log rác", encoding="utf-8")  # phải bị bỏ qua
    (tmp_path / "_cache").mkdir()
    (tmp_path / "_cache" / "hash1.txt").write_text("Đoạn cache có (ngoặc) cân.", encoding="utf-8")
    (tmp_path / "_cache" / "hash2.txt").write_text("Đoạn cache (ngoặc lệch.", encoding="utf-8")

    material = collect_material(tmp_path, tmp_path / "nguon")
    assert len(material["chapters"]) == 2  # _log.txt KHÔNG lọt
    assert [c["name"] for c in sorted(material["chapters"], key=lambda c: c["name"])] == [
        "0001",
        "0002",
    ]
    assert material["chapters"][0]["original"] == "nguon 1."  # ghép đôi nguồn
    assert len(material["cache"]) == 2

    result = run_qa(tmp_path, tmp_path / "nguon", {})
    assert result["chapter_count"] == 2
    assert result["chapter_names"] == ["0001", "0002"]
    assert result["cache_count"] == 2
    # đoạn cache lệch ngoặc bị bắt; đoạn cache cân sạch
    flagged = {r["name"]: r["problems"] for r in result["flagged"]}
    assert any("ngoặc lệch" in p for p in flagged["hash2"])
    assert "hash1" not in flagged
    # order thuật toán: dải liên tiếp cũng phải được verify khớp
    assert verify_order([{"name": name} for name in result["chapter_names"]]) == ["0001", "0002"]


def test_order_đứt_dải_lên_lỗi_rõ_ràng() -> None:
    with pytest.raises(AssertionError, match="không theo NNNN|ngắt ở"):
        verify_order([{"name": "0001"}, {"name": "0003"}, {"name": "khoảnh"}])


def test_render_bảng_chờ_duyệt_và_trượt_detector_suốt_câu() -> None:
    result = {
        "chapter_count": 1,
        "chapter_names": ["0001"],
        "cache_count": 1,
        "rows": [
            {"kind": "chapter", "name": "0001", "paired": True, "problems": ["CJK còn sót (1 ký tự)"]},
            {"kind": "cache", "name": "abc", "paired": False, "problems": []},
        ],
        "flagged": [
            {"kind": "chapter", "name": "0001", "paired": True, "problems": ["CJK còn sót (1 ký tự)"]}
        ],
        "self_check": [
            {"sample": "CJK sót", "detect": True, "expect": "CJK"},
            {"sample": "câu lặp", "detect": False, "expect": "lặp"},
        ],
    }
    md = render_report(result, title="Kiểm riêng")
    assert "# Kiểm riêng (T9.3)" in md
    assert "bị CHẶN duyệt (flagged): **1**" in md
    assert "CJK còn sót (1 ký tự)" in md  # problem hiển thị nguyên văn cho người duyệt
    assert "✓" in md and "TRƯỢT" in md  # mẫu lọt hiển thị ✗ TRƯỢT rõ ràng


def test_qa_check_thuật_ngữ_bắn_trên_ghép_đôi() -> None:
    # key nằm trong original nhưng thuật ngữ chuẩn không có trong output → bắt
    problems = qa_check(
        "Hắn tới bá Giác đảo.", "Hắn tới bá sừng đảo.", {"bá sừng đảo": "Bá Giác đảo"}
    )
    assert any("thiếu thuật ngữ" in p for p in problems)
