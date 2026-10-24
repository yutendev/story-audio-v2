---
name: superpowers
description: >-
  Kỹ năng thực thi phương pháp luận kỹ thuật phần mềm chuẩn mực (Software Engineering Methodology):
  brainstorming, lập kế hoạch chi tiết, Test-Driven Development (TDD), điều tra nguyên nhân gốc
  (Systematic Debugging) và review code trước khi hoàn tất.
---

# Superpowers Skill — Engineering Excellence Methodology

Kỹ năng này bắt buộc AI Agent tuân thủ kỷ luật kỹ thuật phần mềm nghiêm ngặt, ngăn chặn việc vội vã viết code cẩu thả hoặc đoán mò khi gặp lỗi.

---

## 1. Các Trụ Cột Phương Pháp Luận (Core Pillars)

### 1.1. Khám phá & Động não (Brainstorming First)
* Trước khi nhảy vào code một tính năng mới hoặc thay đổi lớn, phải làm rõ:
  - Yêu cầu thực sự là gì?
  - Có những edge cases (trường hợp biên) nào?
  - Có giải pháp thay thế đơn giản hơn không?
* Xác định rõ tiêu chí nghiệm thu (Definition of Done) trước khi gõ dòng code đầu tiên.

### 1.2. Kế hoạch từng bước (Structured Planning)
* Chia nhỏ bài toán thành các bước nhỏ, độc lập, có thể xác minh được ngay.
* Mỗi bước phải nêu rõ: Mục tiêu, file dự kiến thay đổi, và lệnh test kiểm chứng.
* Thực hiện tuần tự, không nhảy cóc hoặc gộp nhiều bước phức tạp vào một lần.

### 1.3. Lập trình Hướng Kiểm thử (Test-Driven Development - TDD)
* **Red:** Viết bài test mô tả hành vi mong muốn trước. Chạy test và xác nhận test **phải FAIL** đúng lý do.
* **Green:** Viết lượng code tối thiểu cần thiết để bài test chuyển sang **PASS**.
* **Refactor:** Tối ưu hóa, làm sạch code mà vẫn đảm bảo test tiếp tục **PASS**.

### 1.4. Điều tra lỗi có hệ thống (Systematic Debugging)
* **Tuyệt đối không đoán mò (No Guesswork):** Không tự ý sửa code lung tung với hy vọng nó "tự nhiên chạy được".
* **4 bước xử lý sự cố:**
  1. *Quan sát:* Đọc kỹ stack trace, log lỗi và message cụ thể.
  2. *Tái hiện:* Tạo test case nhỏ nhất hoặc lệnh tối giản để tái hiện lỗi 100%.
  3. *Khoanh vùng & Đặt giả thuyết:* Tìm ra file, hàm và nguyên nhân gốc (Root Cause).
  4. *Xử lý & Xác thực:* Áp dụng bản vá đúng tại nguyên nhân gốc, chạy lại toàn bộ test suite để tránh regression.

### 1.5. Đánh giá Code (Code Review Checkpoint)
* Tự review lại diff trước khi báo cáo hoàn thành:
  - Code có sạch, dễ đọc và đúng quy chuẩn dự án không?
  - Có để lọt secret, token, console.log thừa thãi không?
  - Có phá vỡ các hợp đồng API hoặc interface hiện có không?
