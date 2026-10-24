# Product Requirements Document (PRD) — Story Audio v2

## 1. Tổng quan Sản phẩm

**Story Audio (v2)** là ứng dụng cá nhân chạy trên môi trường Windows, cho phép người dùng nhập URL truyện online được hỗ trợ, tự động tải nội dung, chuẩn hóa văn bản, biên tập/viết lại tiếng Việt tự nhiên bằng AI, kiểm định chất lượng, chuyển văn bản thành giọng nói (TTS), và đóng gói thành sách nói M4B hoàn chỉnh (tùy chọn video MP4 để upload thủ công).

---

## 2. Luồng Người dùng (User Flow)

1. **Khởi tạo:** Người dùng dán URL mục lục truyện được hỗ trợ vào giao diện Web, thiết lập số chương mỗi gói (`chaptersPerBook`, mặc định: 20) và bấm "Bắt đầu".
2. **Xử lý nền:** Backend tạo một Job bền vững và tiến hành xử lý tuần tự qua từng chương:
   - **Download:** Tải text/HTML từ nguồn.
   - **Normalize:** Làm sạch rác, chuẩn hóa khoảng trắng và chia đoạn an toàn.
   - **Rewrite:** Dịch/viết lại văn bản mượt mà bằng Gemini Free với thuật ngữ từ `glossary.json`.
   - **QA Gate:** Kiểm tra chất lượng (không sót CJK, không lệch ngoặc, không rò rỉ prompt).
   - **TTS:** Tổng hợp giọng đọc tiếng Việt bằng Edge-TTS thành từng file MP3.
   - **Packaging:** Ghép các chương thành sách nói `.m4b` có đánh dấu chapter markers.
3. **Theo dõi tiến độ:** Người dùng theo dõi tiến trình trực tiếp qua Server-Sent Events (SSE).
4. **Xử lý bất thường:** Nếu chương bị lỗi QA, trạng thái chuyển thành `NEEDS_REVIEW` để người dùng kiểm tra thủ công; quy trình đóng gói tạm dừng cho tới khi được duyệt.
5. **Tải thành phẩm:** Sau khi hoàn tất và xác minh trên Cloudflare R2, người dùng tải file M4B/MP4 qua presigned URL.

---

## 3. Các Nguyên Tắc Bất Biến (Product Invariants)

1. **Chi phí $0:** Mặc định sử dụng Gemini Free và Edge-TTS. Ứng dụng tuyệt đối không tự động chuyển sang mô hình trả phí khi hết hạn ngạch. Khi gặp giới hạn rate limit/daily quota, hệ thống tự động lưu checkpoint và chờ phục hồi.
2. **Quyền riêng tư:** Cloudflare R2 bucket luôn ở chế độ riêng tư (Private). URL tải về là presigned URL có thời hạn ngắn (TTL 300s).
3. **Checkpoint & Resume:** Mỗi công đoạn của từng chương đều được lưu trạng thái vào PostgreSQL. Nếu tắt máy hoặc dừng tiến trình, job sẽ tiếp tục từ checkpoint hợp lệ gần nhất mà không cần chạy lại các bước đã hoàn thành.
4. **Cổng kiểm soát chất lượng (QA Gate):** Không bao giờ âm thầm gửi văn bản chưa đạt tiêu chuẩn sang bước TTS. Mọi chương lỗi phải được chặn lại ở `NEEDS_REVIEW`.
5. **Đóng gói linh hoạt:** Tham số `chaptersPerBook` có thể điều chỉnh lại để tạo các gói sách mới từ dữ liệu audio đã có mà không cần chạy lại AI hay TTS.
6. **Không tự động xuất bản:** Ứng dụng chỉ tạo file MP4, thumbnail và description cục bộ; người dùng tự chịu trách nhiệm và thực hiện upload thủ công nếu muốn đưa lên YouTube.

---

## 4. Mục tiêu Ngoài Phạm vi (Non-Goals)

* Không xây dựng hệ thống tài khoản nhiều người dùng, phân quyền phức tạp hay dịch vụ SaaS công cộng.
* Không hỗ trợ tùy tiện mọi website bằng cách đoán selector. Chỉ hỗ trợ các nguồn đã được kiểm thử (webnovel.vn, truyendich.space).
* Không vượt paywall, CAPTCHA hay phá vỡ các biện pháp bảo vệ bản quyền của trang nguồn.
