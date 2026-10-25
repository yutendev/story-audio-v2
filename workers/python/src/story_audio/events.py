"""Worker event protocol v1 (T1.3).

Spec: packages/contracts/worker-protocol.md; schema: story_audio-events.schema.json.

- Validation phía Python là thủ công tối thiểu (không thêm dependency
  jsonschema) — Node validate bằng schema thật ở phía nó.
- stdout chỉ hợp JSONL; log thường đi stderr.
"""

import json
import re
import sys

# Đảm bảo stdout dùng UTF-8 trên Windows nếu có thể
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

PROTOCOL_VERSION = "1"

EVENT_TYPES = (
    "stage_started",
    "progress",
    "chapter_status",
    "artifact_ready",
    "quota_wait",
    "needs_review",
    "error",
    "final",
)

FINAL_STATUSES = ("success", "failed", "needs_review", "quota_wait")

ARTIFACT_KINDS = (
    "chapter_text", "normalized_text", "rewritten_text",
    "chapter_audio", "m4b", "mp4", "thumbnail", "description",
)

# Trường bắt buộc thêm ngoài (protocol, type, seq, job_id)
_REQUIRED = {
    "stage_started": ("stage",),
    "progress": ("stage", "done", "total"),
    "chapter_status": ("chapter_no", "state"),
    "artifact_ready": ("path", "kind", "checksum"),
    "quota_wait": ("backend", "not_before"),
    "needs_review": ("chapter_no", "reason"),
    "error": ("message", "retryable"),
    "final": ("status", "summary"),
}

_INT_MIN = {"done": 0, "total": 1, "chapter_no": 1}
_CHECKSUM_RE = re.compile(r"[0-9a-f]{64}")
_MAX_SEQ = 2**63


class ProtocolError(ValueError):
    """Event không hợp lệ — phải bị từ chối, không bao giờ phát/accept."""


def _bad(message):
    raise ProtocolError(message)


def validate(ev):
    """Validate event dict; lệch bất kì rule nào → ProtocolError."""
    if not isinstance(ev, dict):
        _bad("event phải là object")
    for key in ("protocol", "type", "seq", "job_id"):
        if key not in ev:
            _bad(f"thiếu trường bắt buộc: {key}")
    if ev["protocol"] != PROTOCOL_VERSION:
        _bad(f"protocol không hỗ trợ: {ev['protocol']!r}")
    if ev["type"] not in EVENT_TYPES:
        _bad(f"event type lạ: {ev['type']!r}")
    seq = ev["seq"]
    if isinstance(seq, bool) or not isinstance(seq, int) or not (0 <= seq < _MAX_SEQ):
        _bad("seq phải là integer trong [0, 2^63)")
    if not isinstance(ev["job_id"], str) or not ev["job_id"]:
        _bad("job_id phải là chuỗi khác rỗng")

    req = _REQUIRED[ev["type"]]
    missing = [k for k in req if k not in ev]
    if missing:
        _bad(f"event {ev['type']} thiếu: {', '.join(missing)}")

    for k in req:
        if k in _INT_MIN:
            v = ev[k]
            lo = _INT_MIN[k]
            if isinstance(v, bool) or not isinstance(v, int) or v < lo:
                _bad(f"{k} phải là integer ≥ {lo}")

    if ev["type"] == "progress" and ev["done"] > ev["total"]:
        _bad("progress: done > total")
    if ev["type"] == "error" and not isinstance(ev["retryable"], bool):
        _bad("error.retryable phải là boolean")
    if ev["type"] == "final" and ev["status"] not in FINAL_STATUSES:
        _bad(f"final.status lạ: {ev['status']!r}")
    if ev["type"] == "artifact_ready":
        if not _CHECKSUM_RE.fullmatch(str(ev["checksum"])):
            _bad("checksum phải là SHA-256 hex 64 ký tự")
        if ev["kind"] not in ARTIFACT_KINDS:
            _bad(f"kind lạ: {ev['kind']!r}")
        path = str(ev["path"])
        if path.startswith("/") or "\\" in path or ".." in path.split("/"):
            _bad("path phải tương đối, dùng '/', không phải dấu ..")
    return ev


def event(job_id, ev_type, seq, **payload):
    """Tạo + validate event dict."""
    ev = {"protocol": PROTOCOL_VERSION, "type": ev_type, "seq": seq, "job_id": job_id, **payload}
    return validate(ev)


def encode(ev):
    """Event dict → một dòng JSON (ensure_ascii=False)."""
    return json.dumps(validate(ev), ensure_ascii=False)


def decode(line):
    """Dòng stdout → event đã validate; dòng hỏng/lạ → ProtocolError."""
    try:
        data = json.loads(line)
    except ValueError as e:
        raise ProtocolError(f"dòng không phải JSON: {e}") from e
    return validate(data)


def emit(ev, stream=None):
    """In 1 event JSONL ra stdout (mặc định) — chỉ protocol, không log."""
    out = stream if stream is not None else sys.stdout
    try:
        out.write(encode(ev) + "\n")
    except UnicodeEncodeError:
        # Fallback an toàn trên Windows console cp1252
        out.write(json.dumps(validate(ev), ensure_ascii=True) + "\n")
    out.flush()


def log(message, stream=None):
    """Log thường — luôn đi stderr, không bao giờ stdout."""
    err = stream if stream is not None else sys.stderr
    print(message, file=err)
