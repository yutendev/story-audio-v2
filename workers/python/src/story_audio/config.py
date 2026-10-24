"""Cấu hình tập trung cho toàn bộ pipeline Story Audio.

Mọi hằng số (ngưỡng, số lần thử, concurrency, độ dài chunk, độ dài khoảng lặng,
thông số audio, retry) được tập trung tại đây theo quy tắc chung của pipeline.
"""

from __future__ import annotations

import os

# ---------------------------------------------------------
# Prompt & LLM Settings
# ---------------------------------------------------------
PROMPT_VERSION = "2.0"  # Tăng version để cache cũ không bị dùng nhầm

CHUNK_MAX_CHARS = 1500  # Độ dài tối đa mỗi chunk khi chuốt văn
CHUNK_MIN_CHARS = 200   # Biên dưới cấu hình chunk cho phép
CHUNK_MAX_LIMIT = 10000 # Biên trên tuyệt đối để bảo vệ LLM prompt

MAX_LLM_ATTEMPTS = 3    # Tối đa 3 lần gọi LLM cho mỗi chunk
DEFAULT_TEMPERATURE = float(os.environ.get("VIETLAI_TEMPERATURE", "0.3"))
DEFAULT_CONCURRENCY = int(os.environ.get("VIETLAI_CONCURRENCY", "4"))

BAD_LEADINS = (
    "dưới đây là",
    "đây là bản",
    "đây là đoạn",
    "sau đây là",
    "chắc chắn rồi",
    "bản viết lại",
    "tất nhiên",
)

PROMPT_LEAK_MARKERS = (
    "Ngữ cảnh:",
    "Đoạn bản gốc cần viết lại",
    "Bảng thuật ngữ",
    "Yêu cầu bắt buộc",
    "biên tập viên người Việt",
    "Bạn là biên tập viên",
)

# ---------------------------------------------------------
# Validation & Length Ratio Settings
# ---------------------------------------------------------
MIN_RATIO = 0.7
MAX_RATIO = 1.3
QUOTE_DEVIATION_TOLERANCE = 0.25

# ---------------------------------------------------------
# QA Gate Chương (Default Thresholds)
# ---------------------------------------------------------
DEFAULT_QA: dict[str, float] = {
    "cjk_max": 0,          # Tối đa ký tự CJK còn sót trong chương
    "repeat_max": 3,       # Tối đa lần một câu (≥ repeat_min_len) được lặp
    "repeat_min_len": 8,   # Câu ngắn hơn không tính là lặp đáng ngờ
    "min_ratio": MIN_RATIO,      # Biên dưới tỉ lệ độ dài đầu ra / bản gốc
    "max_ratio": MAX_RATIO,      # Biên trên tỉ lệ độ dài đầu ra / bản gốc
}

# ---------------------------------------------------------
# Fallback Options
# ---------------------------------------------------------
# Phase 1: Mặc định tắt (False) để QA Gate cấp chương kiểm tra trung thực;
# có thể opt-in qua payload["strip_cjk_fallback"] = True.
# Sang Phase 2: Chặn cứng trước TTS sẽ kích hoạt triệt để.
DEFAULT_STRIP_CJK_FALLBACK = False

# ---------------------------------------------------------
# TTS & Audio Settings (Phase 3 & 4)
# ---------------------------------------------------------
TTS_CHUNK_MIN_CHARS = 200
TTS_CHUNK_MAX_CHARS = 400
TTS_RETRIES = 8                # Số lần thử lại khi edge-tts trả rỗng

SILENCE_SENTENCE_SEC = 0.35    # Khoảng lặng sau câu
SILENCE_PARAGRAPH_SEC = 0.9    # Khoảng lặng sau đoạn
SILENCE_TITLE_SEC = 1.2        # Khoảng lặng sau tiêu đề chương

# Thông số thật của Edge-TTS đo đạc bằng ffprobe ở Phase 0
AUDIO_SAMPLE_RATE = 24000      # 24 kHz
AUDIO_CHANNELS = 1             # Mono
AUDIO_BITRATE = "48k"          # 48 kbps khớp nguồn MP3

# Filter hậu kỳ loudnorm & dynamic processing
LOUDNORM_I = -18.0
LOUDNORM_TP = -1.5
LOUDNORM_LRA = 11.0
