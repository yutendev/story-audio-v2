# AGENTS.md — Quy ước & Luật Tối cao Cho AI Coding Agent

Tài liệu này là bộ luật điều hành bắt buộc cho mọi AI Agent làm việc trong kho lưu trữ **Story Audio (v2)**. Mọi quyết định và hành động phải tuân thủ nghiêm ngặt các quy tắc dưới đây.

---

## 1. Các Quy Tắc Điều Hành Cốt Lõi (Operating Rules)

### 1.1. Giới hạn 1 task mỗi lần (Single-task Execution)
* Chỉ thực hiện đúng **1 task duy nhất** trong mỗi lượt tương tác.
* Không tự ý cài đặt sớm các task tiếp theo hoặc tự động scaffold toàn bộ dự án ngoài phạm vi được giao.
* Hoàn thành xong 1 task, báo cáo kết quả và dừng lại chờ người dùng nghiệm thu và yêu cầu task kế tiếp.

### 1.2. Kiểm thử Mock là bắt buộc (Mock-First Testing)
* Mọi bài test unit và integration mặc định **phải dùng mocks/fixtures**.
* **TUYỆT ĐỐI KHÔNG:**
  * Tự ý kích hoạt billing hoặc chuyển sang model trả phí.
  * Tự ý chạy batch Gemini API thật hoặc Edge-TTS thật nếu chưa có sự cho phép rõ ràng từ người dùng.
  * Thực hiện thao tác phá hủy database (DROP/TRUNCATE) hoặc xóa object trên Cloudflare R2 khi chưa được xác nhận.

### 1.3. Bảo mật tuyệt đối Secret & Dữ liệu nhạy cảm
* **TUYỆT ĐỐI KHÔNG** in ra màn hình (print), ghi log (log) hoặc commit bất kỳ giá trị secret, token, API key hoặc nội dung của file `.env`.
* File `Audio/.env` cũ là vùng cấm: không inspect, không copy. Mọi secret chỉ nằm trong cấu hình local của người dùng.
* Trong tài liệu và test chỉ được dùng biến môi trường mẫu / placeholder.

### 1.4. Nguồn tham chiếu `Audio/` là CHỈ ĐỌC (Read-Only)
* Thư mục `Audio/` là mã nguồn cũ để tham chiếu, được git ignore toàn bộ.
* Không chỉnh sửa, không xóa và không copy các file cache, text viết lại, audio cũ, `.venv` hay `.git` cũ từ `Audio/` vào dự án mới.
* Chỉ tái sử dụng mã nguồn, test fixtures, glossary sau khi đã inspect và chuẩn hóa.

### 1.5. Khảo sát thực tế trước khi code (Inspect First)
* Luôn kiểm tra cây thư mục, file hiện có và git status trước khi chỉnh sửa.
* Không bao giờ giả định một file tồn tại chỉ vì nó được nhắc đến trong tài liệu cũ.

### 1.6. Tôn trọng bản quyền & Không tự động xuất bản
* Không tích hợp cơ chế tự động upload YouTube hay công khai dữ liệu. Chỉ tạo file export MP4/M4B và mô tả timestamp cục bộ cho người dùng tự xử lý.
* Không xây dựng cơ chế vượt paywall, vượt CAPTCHA hay phá vỡ kiểm soát quyền truy cập của các trang nguồn.

### 1.7. Kiểm thử và tài liệu đi kèm code
* Mọi thay đổi logic code đều phải có unit test hoặc integration test tương ứng.
* Báo cáo trung thực: test nào chạy thành công, test nào bị bỏ qua (skipped) và lý do. Không khẳng định "test passed" nếu chưa thực sự chạy lệnh.

---

## 2. Định Dạng Báo Cáo Chuẩn (Completion Report Format)

Sau khi hoàn thành công việc của mỗi task, Agent phải báo cáo theo mẫu sau:
1. **Task & Kết quả:** Mã task và trạng thái (`DONE`, `BLOCKED`, hoặc `PARTIAL`).
2. **File thay đổi:** Danh sách các đường dẫn file kèm tóm tắt mục đích.
3. **Lệnh đã chạy:** Lệnh shell cụ thể và kết quả trả về.
4. **Trạng thái test:** Số test pass / fail / skip.
5. **Vấn đề / Rủi ro đã ghi nhận:** Nếu có bất thường hoặc điểm cần lưu ý.
6. **Bước tiếp theo:** Đề xuất task kế tiếp cần thực hiện, sau đó dừng lại.
