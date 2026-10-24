# Architecture decisions (ADR) — Story Audio v2

Format: quyết định ngắn, 1 mục = 1 ADR. Ghi lại **trước khi** implement phần liên quan (yêu cầu của Master Plan §2).

## ADR-001 — Repo root & source cũ read-only (T0.1)

- **Quyết định:** repo root = `D:\story-audio-v2` (không tạo thư mục con `story-audio/`); `docs/` giữ nguyên vị trí. `Audio/` (bản giải nén Audio.rar, có `.git` riêng) là tham chiếu **chỉ đọc**, bị ignore toàn phần trong git (T0.2).
- **Lý do:** workspace cho sẵn; plan §2 cho phép adapt layout nếu giữ ranh giới rõ giữa web/api/worker/contracts.
- **Hệ quả:** không tái sử dụng venv/`.git`/output cũ; chỉ inspect code, tests, glossary, fixtures khi đến task tương ứng (T0.4, T1.x, T5.x).

## ADR-002 — Ranh giới Node ↔ Python worker ↔ R2 (ghi trước khi implement, chờ T1.3/T3.4/T4.x)

- **Quyết định** (theo contract §2 của Master Plan):
  1. **Node là chủ duy nhất** của credentials R2 và trạng thái database. Credentials không bao giờ xuống React, Python worker cũng không giữ R2 credentials.
  2. Python worker nhận **per-job work directory** + **job manifest** đã validate; chỉ được ghi file trong workdir của mình.
  3. stdout = **protocol JSON Lines có version**; log thường đi stderr. Event: `stage_started`, `progress`, `chapter_status`, `artifact_ready`, `quota_wait`, `needs_review`, `error`, final result. Định nghĩa chi tiết ở T1.3.
  4. Nhận `artifact_ready`: Node kiểm tra path nằm trong workdir được cấp → upload R2 → xác minh object/checksum → ghi Asset metadata → **chỉ lúc đó** file tạm local mới được xóa.
  5. Launch worker bằng `spawn()` với **mảng tham số cố định, `shell: false`**; không bao giờ nội suy URL/user input vào chuỗi shell.
  6. Nếu trong quá trình implement thấy protocol này quá phức tạp: **dừng, viết ADR mới đề xuất phương án nhỏ nhất an toàn** — không cho Node và Python cùng ghi DB.
- **Lý do:** một chủ thể duy nhất giữ credentials/state tránh việc đồng bộ hai đường ghi storage/DB không phối hợp; worker thuần tính toán.
- **Hệ quả:** mọi task chạm ranh giới này (T3.4, T3.5, T4.3, T6.2) phải tuân thủ; vi phạm = lỗi kiến trúc.

## ADR-003 — Chính sách pin version (T0.3, cập nhật T2.2)

- **Quyết định:** pin theo **major**: Node 22 LTS · npm 10 · Python 3.12 · PostgreSQL 17 (`postgres:17-alpine` ở T2.1) · FFmpeg 8. **Prisma CLI/client pin chính xác `7.10.1`** (stable non-prerelease; `latest` trên npm là 8.0.0-rc.25 = prerelease, bị loại). Chuẩn config v7: `prisma.config.ts` + driver adapter `@prisma/adapter-pg@7.10.1`, `pg@8.23.1`, `dotenv@18.0.8`, `tsx@4.23.15`.
- **Lý do:** plan §2 yêu cầu stable non-prerelease, không chọn bản mới nhất chỉ vì mới; đã xác minh Node 22.15.1 và FFmpeg 8.1.1 có sẵn trên máy dev.
- **Hệ quả:** không nâng major giữa chừng trừ khi có ADR mới; Python chưa cài system → dùng base interpreter 3.12.14 có sẵn (xem ADR-004).

## ADR-004 — Python venv base interpreter (T1.1)

- **Quyết định:** venv worker (`workers/python/.venv`) tạo từ base interpreter 3.12.14 sẵn có của máy (`C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`) thay vì cài Python system-wide ngay.
- **Lý do:** tránh thay đổi toàn hệ thống; interpreter này đã được chính dự án cũ dùng và verify.
- **Rủi ro đã ghi nhận:** nếu runtime cache đó bị AI tool dọn, venv phải được tạo lại từ interpreter đã cài qua winget (`Python.Python.3.12` — đã ghi trong dev-setup §1); deps pin theo pyproject nên rebuild không thay đổi hành vi.
- **Hệ quả:** dev khác cài Python 3.12 riêng rồi `python -m venv .venv` như dev-setup — không phụ thuộc cache này.
