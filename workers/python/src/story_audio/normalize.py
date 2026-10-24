r"""T5.2 — normalization thuần: import không đụng cwd/file nào, mọi path truyền vào tường minh.

Port nguyên vẹn behavior của Audio/truyen_audio.py::normalize (READ-ONLY):
- thay replacements an toàn biên từ (chặn khớp trong chữ khóe dài hơn qua \w),
  key dài được xử lý trước để chiếm ưu thế;
- hỗ trợ an toàn cho CJK: key chữ Hán nằm sát chữ Hán khác vẫn khớp và thay thế chuẩn;
- auto_sanitize_cjk: chỉ thay các chữ có trong bảng phiên âm hoặc replace.json,
  KHÔNG xóa CJK còn sót trước khi gọi LLM (để LLM dịch);
- strip_cjk: phương án cuối cùng xóa CJK còn sót khi tự sửa hết lượt;
- co mọi whitespace (kể cả \n/\t) thành 1 khoảng trắng + trim.
Việc co whitespace nằm ở tầng TEXT (mỗi đoạn 1 dòng khi ghi file) — ranh giới
đoạn văn giữ nguyên ở tầng stage (xem actions.normalize_stage).
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

_CJK_CHAR = r"[\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]"
CJK_CHAR_RE = re.compile(_CJK_CHAR)
# Ký tự chữ/số thường (Latin, tiếng Việt, v.v.) nhưng KHÔNG phải ký tự CJK
_WORD_NON_CJK = rf"[^\W\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]"

COMMON_CJK_TRANSLIT: dict[str, str] = {
    "淄": "Tri",
    "眾": "chúng",
    "众": "chúng",
    "故": "cố",
    "阁": "Các",
    "閣": "Các",
    "夫": "phu",
    "剿": "tiễu",
    "怀": "hoài",
    "长期": "trường kỳ",
    "街": "phố",
    "抚朝": "vỗ về triều chính",
    "抚不朝之臣": "vỗ về kẻ không chịu vào chầu",
    "抚": "vỗ về",
    "道": "Đạo",
    "门": "môn",
    "門": "môn",
    "宗": "tông",
    "皇": "hoàng",
    "帝": "đế",
    "王": "vương",
    "君": "quân",
    "神": "thần",
    "仙": "tiên",
    "魔": "ma",
    "鬼": "quỷ",
    "佛": "Phật",
    "剑": "kiếm",
    "劍": "kiếm",
    "刀": "đao",
    "法": "pháp",
    "阵": "trận",
    "陣": "trận",
    "丹": "đan",
    "符": "phù",
    "器": "khí",
    "灵": "linh",
    "靈": "linh",
    "气": "khí",
    "氣": "khí",
    "心": "tâm",
    "地": "địa",
    "人": "nhân",
    "生": "sinh",
    "死": "tử",
    "大": "đại",
    "小": "tiểu",
    "第": "thứ",
    "章": "chương",
}


def _pattern_for_key(key: str) -> str:
    """Xây dựng pattern regex an toàn biên từ cho key thay thế.

    Nếu ký tự đầu/cuối là chữ Latin/Việt (_WORD_NON_CJK), yêu cầu biên từ để không
    ăn vào giữa từ dài hơn (ví dụ 'Ch' không ăn vào 'Chương').
    Nếu ký tự đầu/cuối là chữ Hán/CJK, không đặt biên từ chống lại chữ Hán liền kề,
    vì tiếng Trung viết liền không có khoảng trắng giữa các chữ.
    """
    escaped = re.escape(key)
    left = rf"(?<!{_WORD_NON_CJK})" if re.match(rf"^{_WORD_NON_CJK}", key) else ""
    right = rf"(?!{_WORD_NON_CJK})" if re.search(rf"{_WORD_NON_CJK}$", key) else ""
    return f"{left}{escaped}{right}"


def normalize_text(text: str, replacements: dict[str, str] | None = None) -> str:
    for key in sorted(replacements or {}, key=len, reverse=True):
        pattern = _pattern_for_key(key)
        text = re.sub(pattern, replacements[key], text)
    return re.sub(r"\s+", " ", text).strip()


def auto_sanitize_cjk(text: str, replacements: dict[str, str] | None = None) -> str:
    """Tự động phiên âm các ký tự CJK có trong COMMON_CJK_TRANSLIT hoặc replacements.

    TUYỆT ĐỐI KHÔNG xóa các ký tự CJK còn lại trước khi gọi LLM — giữ nguyên để
    LLM dịch hoặc xử lý theo ngữ cảnh.
    """
    combined = dict(COMMON_CJK_TRANSLIT)
    if replacements:
        combined.update(replacements)
    for cjk in sorted(combined, key=len, reverse=True):
        if cjk in text:
            pattern = _pattern_for_key(cjk)
            text = re.sub(pattern, combined[cjk], text)
    return re.sub(r"[ \t]+", " ", text)


def strip_cjk(text: str) -> tuple[str, int]:
    """Phương án cuối cùng: xóa triệt để mọi ký tự CJK còn lại.

    Trả về tuple (text_mới, số_ký_tự_đã_xóa).
    """
    matches = CJK_CHAR_RE.findall(text)
    count = len(matches)
    cleaned = CJK_CHAR_RE.sub("", text)
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    return cleaned, count


def clean_corrupted_chars(text: str) -> str:
    """Loại bỏ ký tự hỏng (U+FFFD), zero-width characters, chuẩn hóa fullwidth."""
    text = text.replace("\ufffd", "")
    text = re.sub(r"[\ufeff\u200b\u200c\u200d\u200e\u200f]", "", text)
    text = text.replace("\u3000", " ")
    text = unicodedata.normalize("NFKC", text)
    return text


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
