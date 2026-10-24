# Quy chuẩn Lập trình (Coding Standards)

Áp dụng cho toàn bộ codebase của **Story Audio (v2)**.

---

## 1. Node.js & TypeScript (`apps/api`, `apps/web`)

* **Phiên bản & Quản lý phụ thuộc:**
  * Node.js v22 LTS, npm 10.
  * Fastify cho REST API + SSE progress.
  * Prisma ORM pin chính xác version stable `7.10.1` (không dùng prerelease / release candidate).
* **Kiểu dữ liệu & Schemas:**
  * Mọi API route phải có schema validation (Zod hoặc JSON schema).
  * Trạng thái job và chapter phải tuân thủ nghiêm ngặt State Machine định nghĩa trong `apps/api/src/state-machine.ts`.
  * Không bao giờ dùng `any` bừa bãi.
* **Child Process & Shell Safety:**
  * Khi gọi tiến trình con (Python worker, FFmpeg), luôn dùng `spawn()` với mảng tham số cố định và `shell: false`.
  * Tuyệt đối không nội suy chuỗi URL hoặc input của người dùng trực tiếp vào shell command.

---

## 2. Python Worker (`workers/python`)

* **Phiên bản & Quản lý phụ thuộc:**
  * Python 3.12 (không dùng Python 3.13 do tương thích thư viện).
  * Cấu hình dự án bằng `pyproject.toml` chuẩn (setuptools/wheel).
* **Nguyên tắc xử lý file & thư mục:**
  * Worker chỉ được thao tác và ghi file tạm bên trong `workdir` được cấp phát từ Node.
  * Các thao tác ghi cache hoặc file âm thanh phải ghi vào file tạm `.tmp` rồi đổi tên atomic (`os.replace` / `Path.replace`).
* **AI & TTS Providers:**
  * Mặc định luôn ưu tiên Gemini API Free.
  * Phân biệt rõ các loại lỗi: 429 rate limit (chờ retry), hết quota ngày (đưa về `waiting_quota`), lỗi xác thực / sai key (báo lỗi dừng).
  * QA Gate: Mọi chương sau khi viết lại phải vượt qua kiểm tra QA (không sót ký tự CJK, không lệch ngoặc thoại, không leak prompt). Nếu vi phạm phải gắn cờ `NEEDS_REVIEW`.
