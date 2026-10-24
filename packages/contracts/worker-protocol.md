# Worker protocol v1 — Node ↔ Python (spec dùng chung)

Đúng contract ở `docs/architecture/decisions.md` ADR-002: **stdout** chỉ chứa JSON Lines; log thường đi stderr.

## Rules

1. **Version:** mỗi event có `protocol: "1"` — Node đứng trước version lạ thì báo log + fail line (không đoán).
2. **`seq`:** mỗi event có `seq` nguyên tăng dần **per-job QUA CÁC LẦN CHẠY** (không reset về 0 mỗi lần spawn): worker đọc counter lưu trong workdir (`events-seq.txt`) — Node lưu event với unique `(job_id, seq)`, seq nhảy lùi = replay. Mất line giữa 2 run (process chết giữa chừng) chỉ lặp cùng seq — an toàn.
3. **Decode lỗi:** một dòng stdout không parse/valid → Node **không** làm rơi job: log line nguyên văn sang stderr của API, đánh dấu `worker.unparseable_event` tăng; tiếp tục đọc các dòng sau. Termination vẫn do exit code + `final` event.
4. **Unknown event type** (protocol mới hơn Node hiểu): bỏ qua + log; không crash worker lẫn Node.
5. **Encoding:** UTF-8, `ensure_ascii=False`, không BOM, `\n` end-line.

## Event types + payload (schema: `story_audio-events.schema.json`)

| type | Bắt buộc thêm | Ý nghĩa |
|---|---|---|
| `stage_started` | `stage` | bắt đầu 1 stage of job |
| `progress` | `stage`, `done`, `total` (done ≤ total) | tiến độ stage |
| `chapter_status` | `chapter_no`, `state`, (`title` tuỳ chọn) | trạng thái 1 chương — `chapter_no` là VỊ TRÍ trong job (1..N), KHÔNG phải số chương gốc trên site |
| `artifact_ready` | `path` (relative workdir), `kind`, `checksum` (SHA-256 hex) | file sẵn sàng để Node xác minh + upload R2 |
| `quota_wait` | `backend`, `not_before` (ISO-8601) | worker đang đóng băng chờ free quota |
| `needs_review` | `chapter_no`, `reason` | chương cần người duyệt (theo vị trí 1..N) — block TTS/package |
| `error` | `message`, `retryable`, (`stage` tuỳ chọn) | lỗi có phân loại |
| `final` | `status`: `success|failed|needs_review|quota_wait`, `summary` | event bắt buộc cuối cùng trước exit |

Ánh xạ exit code (workers/python/README.md): final.success/needs_review/quota_wait/failed ↔ 0/30/40/10/20 tương ứng ngữ cảnh.

## Acknowledgement

T1.3 chưa định ack (worker chạy 1 rượt, không cần). Khi T4.3 cần xác nhận upload đầy đủ, **thêm ADR mới trước khi thay đổi ranh giới này** — không cho worker tự đánh dấu hoàn thành.
