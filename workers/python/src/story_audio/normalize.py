r"""T5.2 — normalization thuần: import không đụng cwd/file nào, mọi path truyền vào tường minh.

Port nguyên vẹn behavior của Audio/truyen_audio.py::normalize (READ-ONLY):
- thay replacements an toàn biên từ (chặn khớp trong chữ khóe dài hơn qua \w),
  key dài được xử lý trước để chiếm ưu thế;
- co mọi whitespace (kể cả \n/\t) thành 1 khoảng trắng + trim.
Việc co whitespace nằm ở tầng TEXT (mỗi đoạn 1 dòng khi ghi file) — ranh giới
đoạn văn giữ nguyên ở tầng stage (xem actions.normalize_stage).
"""

from __future__ import annotations

import json
import re
from pathlib import Path


def normalize_text(text: str, replacements: dict[str, str] | None = None) -> str:
    for key in sorted(replacements or {}, key=len, reverse=True):
        text = re.sub(r"(?<!\w)" + re.escape(key) + r"(?!\w)", replacements[key], text)
    return re.sub(r"\s+", " ", text).strip()


def load_replacements(path: str | Path) -> dict[str, str]:
    """Đọc file replacements (replace.json) theo path TƯỜNG MINH — không mặc định cwd.

    File không tồn tại → {} (task không cấu hình replacements là bình thường).
    JSON hỏng/không phải object → ValueError — fail rõ, không nuốt (nuốt lỗi
    sẽ làm output vô tình sai tên nhân vật).
    """
    p = Path(path)
    if not p.is_file():
        return {}
    data = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"replacements phải là JSON object: {p}")
    return {str(k): str(v) for k, v in data.items()}


def split_raw(text: str) -> tuple[str, list[str]]:
    """Định dạng artifact raw của extract: dòng đầu title, dòng trống, các đoạn sau."""
    lines = [line.strip() for line in text.splitlines()]
    if not lines:
        return "", []
    title = lines[0]
    paragraphs = [line for line in lines[1:] if line]
    return title, paragraphs


def split_sentences(text: str) -> list[str]:
    """Port từ truyen_audio.py — tách câu theo .!?… (dùng cho prev_tail, chunking, QA)."""
    parts = re.findall(r'[^.!?…]+[.!?…]+[”’"]*|[^.!?…]+$', text)
    return [p.strip() for p in parts if p.strip()]


_CJK_BRACKET = re.compile(r"【([^】]*)】")


def normalize_brackets(text: str) -> str:
    """Rule duy nhất và tường minh cho 【...】 (T5.5): GIỮ NGUYÊN nội dung, chỉ đổi
    ngoặc sang (...) để TTS đọc được; 【】 rỗng mới được bỏ — tuyệt đối không có
    quy tắc xóa sạch mọi nội dung trong ngoặc."""

    def _sub(m: re.Match) -> str:
        inner = m.group(1).strip()
        return f"({inner})" if inner else " "  # bracket rỗng: bỏ + chèn 1 space (collapse sau)

    return _CJK_BRACKET.sub(_sub, text)
