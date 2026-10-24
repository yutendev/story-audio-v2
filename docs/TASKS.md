# Danh sách Công việc (Tasks Tracker) — Story Audio v2

## 1. Trạng thái Hoàn thành (Completed Phases)

Toàn bộ các task kỹ thuật cốt lõi theo Master Plan đã được triển khai và vượt qua bộ kiểm thử tự động offline (API 199/199, Web 20/20, Python 166 passed / 3 skipped):

- [x] **Phase 0 — Workspace & Môi trường:** Khởi tạo cấu trúc monorepo, quy tắc ignore bảo vệ secret, audit source code cũ.
- [x] **Phase 1 — Nền tảng Python Worker:** Đóng gói thư viện Python, xây dựng CLI, chuẩn hóa đường dẫn và cấu hình.
- [x] **Phase 2 — Cơ sở dữ liệu & Trạng thái:** PostgreSQL Docker, Prisma 7.10.1, Schema dữ liệu và State Machine cứng.
- [x] **Phase 3 — Fastify API & Điều phối:** REST API, quản lý hàng đợi job, spawn Python an toàn, SSE live progress.
- [x] **Phase 4 — Lưu trữ Cloudflare R2:** Adapter S3-compatible, quản lý vòng đời object key, upload verify và presigned download URL.
- [x] **Phase 5 — Trích xuất & Biên tập AI:** Adapter crawl webnovel.vn & truyendich.space, chunking an toàn, Gemini rewrite, QA Gate và Quota manager.
- [x] **Phase 6 — Tổng hợp Giọng nói (TTS):** Edge-TTS tích hợp, validate file âm thanh và cache audio.
- [x] **Phase 7 — Đóng gói M4B & MP4:** Gom chương linh hoạt, tạo M4B với chapter markers, xuất video MP4 và mô tả YouTube bằng FFmpeg.
- [x] **Phase 8 — Giao diện Web (React + Vite):** Form tạo job, danh sách/chi tiết job, theo dõi tiến độ SSE, thư viện tải thành phẩm.
- [x] **Phase 9 — Kiểm thử Tích hợp & Tài liệu:** Ma trận kiểm thử 3 tầng, kiểm thử hồi quy 153 chapters, script khởi chạy Windows.
- [x] **Post-Plan FF-1 — Pipeline Wiring:** Nối toàn diện orchestrator, xử lý retry/resume và bảo đảm số thứ tự event seq.

---

## 2. Công việc Hiện tại & Backlog Kế tiếp (Next Steps)

### Chờ người dùng nghiệm thu thực tế (Live Run Verification):
- [ ] **Live Gemini Test:** Chạy thử nghiệm một chương mẫu với `GEMINI_API_KEY` thật để đánh giá chất lượng văn bản thực tế của model Free.
- [ ] **Live Cloudflare R2 Verification:** Cấu hình credentials R2 thật vào `.env` và xác thực quy trình upload/download qua presigned URL.
- [ ] **Live TTS & Packaging:** Chạy tổng hợp giọng đọc thật bằng Edge-TTS và xuất file M4B/MP4 thành phẩm trên máy thật.

### Cải tiến trong tương lai (Nice-to-have):
- [ ] Bổ sung thêm các adapter cho các trang truyện mới theo nhu cầu.
- [ ] Tối ưu hóa giao diện người dùng (Dark mode, hiển thị chi tiết tiến độ từng đoạn text trong chương).
