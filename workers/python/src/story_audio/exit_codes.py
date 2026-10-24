"""Exit code contract của worker (T1.2) — doc tại workers/python/README.md."""

import enum


class ExitCode(enum.IntEnum):
    SUCCESS = 0
    RETRYABLE = 10      # lỗi tạm thời (mạng, 429 rate-limit trong round) — Node có thể schedule lại
    PERMANENT = 20      # payload/paths sai, action chưa có, lỗi không thể retry
    NEEDS_REVIEW = 30   # hoàn thành một phần nhưng cần người duyệt (QA fail...)
    QUOTA_WAIT = 40     # hết quota free — Node phải lưu notBefore và đợi
