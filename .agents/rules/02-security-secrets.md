# Quy chuẩn Bảo mật & Quản lý Secrets (Security & Secrets)

---

## 1. Biến môi trường & Credentials

* Mọi thông tin xác thực (`GEMINI_API_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `DATABASE_URL`) chỉ được lưu trong `.env` cục bộ.
* Mẫu cấu hình không chứa dữ liệu thật được duy trì tại `.env.example`.
* **Cấm tuyệt đối:**
  * Hardcode secrets hoặc khóa API vào mã nguồn.
  * In toàn bộ giá trị bí mật ra màn hình console / stdout / log.
  * Đưa thông tin bí mật vào URL hoặc response trả về phía frontend React.

---

## 2. R2 Object Storage Privacy

* Cloudflare R2 bucket luôn ở chế độ **Private**, không bật Public Domain.
* Phía frontend chỉ truy cập tài nguyên (audio, M4B) thông qua presigned download URLs ngắn hạn (TTL mặc định 300 giây) được cấp phát bởi Fastify API.
* Mọi khóa đối tượng (object key) trên R2 phải tuân thủ namespace đã được thẩm định (`jobs/{jobId}/...`) để ngăn chặn tấn công path traversal hoặc truy cập chéo job.
