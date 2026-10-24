r"""T9.3 CLI — chạy QA offline toàn tập regression + ghi báo cáo markdown.

Chạy (từ workers/python): .venv\\Scripts\\python.exe scripts\\regression_qa.py
Thoát 1 nếu: dải chương đứt, detector trượt mẫu xấu, hoặc đếm sai tập 153 phần.
Nguyên liệu Audio/ CHỈ ĐỌC — không ghi gì vào đó; báo cáo ghi vào docs/runbooks/.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from story_audio.regression_qa import render_report, run_qa, verify_order

ROOT = Path(__file__).resolve().parents[3]
CORPUS = ROOT / "Audio" / "viet_lai" / "xich-tam-tuan-thien"
SOURCE = ROOT / "Audio" / "nguon" / "xich-tam-tuan-thien"
GLOSSARY = ROOT / "data" / "glossary.json"
REPORT = ROOT / "docs" / "runbooks" / "regression-qa.md"

EXPECTED_CHAPTERS = 6
EXPECTED_CACHE = 146


def main() -> int:
    # PowerShell/console Windows có thể là cp1252 — in Unicode không crash
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    glossary = json.loads(GLOSSARY.read_text(encoding="utf-8")) if GLOSSARY.exists() else {}
    result = run_qa(CORPUS, SOURCE, glossary)
    verify_order([{"name": name} for name in result["chapter_names"]])

    problems: list[str] = []
    if result["chapter_count"] != EXPECTED_CHAPTERS:
        problems.append(f"chương {result['chapter_count']} ≠ {EXPECTED_CHAPTERS}")
    if result["cache_count"] != EXPECTED_CACHE:
        problems.append(f"cache {result['cache_count']} ≠ {EXPECTED_CACHE}")
    slipped = [s["sample"] for s in result["self_check"] if not s["detect"]]
    if slipped:
        problems.append("detector trượt mẫu xấu: " + ", ".join(slipped))

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        render_report(result)
        + "\n## Ghi chú kiểm đếm\n\n"
        + "- Tập regression gốc gồm **153 file**: 6 chương viet_lai + 146 đoạn _cache + _log.txt "
        + "(nhật ký pipeline cũ) — 152 văn bản qua QA; _log.txt không phải văn bản chương.\n",
        encoding="utf-8",
    )

    print(
        f"chapters={result['chapter_count']} cache={result['cache_count']} "
        f"flagged={len(result['flagged'])}"
    )
    for r in result["flagged"]:
        print(f"  chờ duyệt [{r['kind']}] {r['name']}: {r['problems']}")
    print(f"báo cáo: {REPORT}")
    if problems:
        for p in problems:
            print(f"LỖI: {p}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
