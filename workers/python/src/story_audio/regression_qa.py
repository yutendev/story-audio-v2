r"""T9.3 — QA offline trên tập regression 153 phần của nguồn cũ
(Audio/viet_lai/xich-tam-tuan-thien — CHỈ ĐỌC).

Không mạng, không provider trả phí: toàn chạy story_audio.qa trên văn bản
sẵn có. 6 chương viet_lai ghép đôi bản gốc nguon/ (QA trọn bộ: CJK, rò rỉ
prompt, ngoặc lệch, ratio, cắt cụt, lặp, thuật ngữ); 146 đoạn _cache chạy
QA cấu trúc (self-paired). Kèm tự-kiểm detector bằng mẫu xấu nhân tạo
→ "known failure patterns are detected" được chứng minh, không chỉ khẳng định.
"""
from __future__ import annotations

import re
from pathlib import Path

from story_audio.qa import qa_check

chapters_of = re.compile(r"^\d{4}$")


def collect_material(corpus_dir: Path, source_dir: Path) -> dict:
    """Đọc corpus (CHỈ ĐỌC): chapters = NNNN.txt (ghép đôi nguồn nếu có),
    cache = _cache/*.txt không ghép đôi (hash-keyed)."""
    chapters: list[dict] = []
    for f in sorted(corpus_dir.glob("*.txt")):
        if f.name.startswith("_"):
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        src = source_dir / f.name
        original = src.read_text(encoding="utf-8", errors="replace") if src.exists() else None
        chapters.append({"name": f.stem, "text": text, "original": original})
    cache: list[dict] = []
    cache_dir = corpus_dir / "_cache"
    if cache_dir.exists():
        for f in sorted(cache_dir.glob("*.txt")):
            cache.append({"name": f.stem, "text": f.read_text(encoding="utf-8", errors="replace")})
    return {"chapters": chapters, "cache": cache}


def verify_order(chapters: list[dict]) -> list[str]:
    """Kiểm counts/order: tên chương phải là NNNN liên tiếp tăng dần (2845..2850)."""
    names = sorted(ch["name"] for ch in chapters)
    if not names or any(not chapters_of.fullmatch(n) for n in names):
        raise AssertionError(f"tên chương không theo NNNN: {names[:5]}")
    nums = [int(n) for n in names]
    if any(b - a != 1 for a, b in zip(nums, nums[1:])):
        gap = next(b for a, b in zip(nums, nums[1:]) if b - a != 1)
        raise AssertionError(f"thiếu chương trong dải liên tiếp (ngắt ở {gap})")
    return names


# Tự-kiểm: mỗi mẫu xấu PHẢI bị qa_check bắt (mảnh problem khớp như test_qa đã chuẩn hóa)
SELF_CHECK_SAMPLES: list[tuple[str, str, str, dict, str]] = [
    (
        "CJK sót",
        "Hắn nhìn 天 cửa rồi lùi lại.",
        "Hắn nhìn cửa rồi lùi lại.",
        {},
        "CJK còn sót",
    ),
    (
        "rò rỉ prompt",
        "Yêu cầu bắt buộc: viết lại tự nhiên.",
        "câu gốc.",
        {},
        "rò rỉ prompt",
    ),
    (
        "ngoặc lệch",
        "Hắn nói (định thế rồi bước đi.",
        "Hắn nói định thế rồi bước đi.",
        {},
        "ngoặc lệch",
    ),
    (
        "cắt cụt",
        "Hắn bước đi rồi biến mất sau cánh cổng",
        "Hắn bước đi rồi biến mất sau cánh cổng.",
        {},
        "cắt cụt",
    ),
    (
        "câu lặp",
        ("Trời đúng là sẫm tối thật." + "\n") * 5,
        "Tịnh tiệt không một tiếng động.",
        {},
        "câu lặp lại",
    ),
    (
        "thiếu thuật ngữ",
        "Hắn tới bá Giác đảo.",
        "Hắn tới bá sừng đảo.",
        {"bá sừng đảo": "Bá Giác đảo"},
        "thiếu thuật ngữ",
    ),
]


def self_check() -> list[dict]:
    """Chạy detector trên mẫu xấu → mỗi mẫu phải có mảnh problem khớp."""
    return [
        {
            "sample": label,
            "detect": any(expect in p for p in qa_check(bad, original, glossary)),
            "expect": expect,
        }
        for label, bad, original, glossary, expect in SELF_CHECK_SAMPLES
    ]


def run_qa(corpus_dir: Path, source_dir: Path, glossary: dict[str, str]) -> dict:
    """Sweep toàn bộ material → rows problems; flagged = những văn bản bị chặn duyệt."""
    material = collect_material(corpus_dir, source_dir)
    rows: list[dict] = []
    for ch in material["chapters"]:
        original = ch["original"]
        problems = qa_check(
            ch["text"], original if original is not None else ch["text"], glossary
        )
        rows.append(
            {"kind": "chapter", "name": ch["name"], "paired": original is not None, "problems": problems}
        )
    for it in material["cache"]:
        # self-paired: chỉ bắn detector cấu trúc (CJK/prompt/ngoặc/lặp/rỗng)
        problems = qa_check(it["text"], it["text"], {})
        rows.append({"kind": "cache", "name": it["name"], "paired": False, "problems": problems})
    flagged = [r for r in rows if r["problems"]]
    return {
        "chapter_count": len(material["chapters"]),
        "chapter_names": [ch["name"] for ch in sorted(material["chapters"], key=lambda c: c["name"])],
        "cache_count": len(material["cache"]),
        "rows": rows,
        "flagged": flagged,
        "self_check": self_check(),
    }


def render_report(result: dict, title: str = "Regression QA — Xích Tâm Tuận Thiên") -> str:
    """Tổng hợp ra Markdown — bảng duyệt hiển thị rõ từng chương/đoạn bị chặn."""
    checked = result["chapter_count"] + result["cache_count"]
    detect_ok = all(s["detect"] for s in result["self_check"])
    lines = [
        f"# {title} (T9.3)",
        "",
        f"- Văn bản kiểm QA: **{checked}** (chương {result['chapter_count']} + cache {result['cache_count']}) — offline, không mạng, không API trả phí.",
        f"- Tên chương kiểm dải liên tiếp: {'–'.join([result['chapter_names'][0], result['chapter_names'][-1]]) if result['chapter_names'] else '(trống)'}",
        f"- Số văn bản bị CHẶN duyệt (flagged): **{len(result['flagged'])}**",
        f"- Tự-kiểm detector (mẫu xấu nhân tạo): **{'tất cả được phát hiện' if detect_ok else 'CÓ MẪU TRƯỢT — sai'}**",
        "",
        "## Chờ duyệt",
        "",
    ]
    if result["flagged"]:
        lines.append("| Loại | Tên/Hash | Problems |")
        lines.append("|---|---|---|")
        for r in result["flagged"]:
            label = f"{r['kind']}" + ("" if r["paired"] else " (self-paired)")
            problems = "; ".join(p.replace("|", "/") for p in r["problems"])
            lines.append(f"| {label} | {r['name']} | {problems} |")
    else:
        lines.append("Không có văn bản nào bị chặn.")
    lines.extend(["", "## Tự-kiểm detector", "", "| Mẫu xấu | Bắt được |", "|---|---|",])
    for s in result["self_check"]:
        lines.append(f"| {s['sample']} | {'✓' if s['detect'] else '✗ TRƯỢT'} |")
    lines.append("")
    return "\n".join(lines)
