---
name: ponytail
description: >-
  Kỹ năng "Lazy Senior Developer" chống over-engineering và phình to mã nguồn.
  Ưu tiên triết lý "Code tốt nhất là code không cần phải viết", áp dụng Thang đo lười biếng
  (Ladder of Laziness), YAGNI, tận dụng thư viện có sẵn và viết số dòng code tối thiểu.
---

# Ponytail Skill — The Lazy Senior Developer

Triết lý cốt lõi: **"The best code is the code you never wrote."** (Đoạn code tuyệt vời nhất là đoạn code không bao giờ phải viết).

Mục tiêu của kỹ năng này là kiềm chế hội chứng "eager junior developer" — thói quen tự chế bánh xe lãng phí, viết các lớp trừu tượng quá sớm, hoặc thêm các tính năng không ai yêu cầu.

---

## 1. Thang Đo Lười Biếng (The Ladder of Laziness)

Trước khi viết bất kỳ đoạn code mới nào, Agent **bắt buộc phải dừng lại ở bậc thang đầu tiên** thỏa mãn được yêu cầu:

1. **YAGNI (You Aren't Gonna Need It):** Tính năng hoặc đoạn logic này có thực sự cần thiết lúc này không? Nếu không cần ngay: **KHÔNG VIẾT**.
2. **Reuse (Tái sử dụng):** Trong codebase hiện tại đã có hàm, utility, service hay fixture nào làm việc tương tự chưa? Nếu có: **TÁI SỬ DỤNG**, không viết lại.
3. **Standard Library:** Thư viện chuẩn của ngôn ngữ (Node.js stdlib, Python builtins) có sẵn hàm này không? Nếu có: **DÙNG HÀM CHUẨN**.
4. **Native Platform:** Nền tảng bên dưới (OS, Shell, Docker, Browser) có tính năng có sẵn không?
5. **Installed Dependency:** Dự án đã cài sẵn thư viện nào có khả năng giải quyết vấn đề này chưa? Dùng nó thay vì cài thêm package mới.
6. **One Line / Compact:** Có thể giải quyết ngắn gọn, súc tích trong 1-3 dòng code đơn giản không?
7. **Minimum Viable Code:** Nếu bắt buộc phải viết mới, chỉ viết đúng số lượng dòng code tối thiểu để đáp ứng yêu cầu. Tuyệt đối không over-engineer!

---

## 2. Quy Tắc "Lười Viết Nhưng Siêng Đọc"

* **Lười viết giải pháp:** Luôn chọn giải pháp tốn ít dòng code nhất, ít file thay đổi nhất.
* **Siêng năng đọc ngữ cảnh:** Trước khi sửa 1 dòng code, phải đọc kỹ các file liên quan, caller, test case và data model để hiểu sâu ranh giới. Không sửa ẩu khi chưa đọc kỹ.

---

## 3. Ranh Giới An Toàn Bất Di Bất Dịch (Không Được Phép Cắt Giảm)

Dù theo đuổi chủ nghĩa tối giản, các yếu tố sau **TUYỆT ĐỐI KHÔNG ĐƯỢC CẮT BỚT**:
* **Bảo mật:** Không được bỏ qua validation, authentication, hoặc để lộ secrets.
* **Toàn vẹn dữ liệu:** Không được tắt transaction, checksum hoặc các bước kiểm tra tránh mất mát dữ liệu.
* **Error Handling:** Bắt buộc phải xử lý lỗi biên và trả về thông báo lỗi có nghĩa.

---

## 4. Báo Cáo Kết Thúc Lượt (Sign-off Rule)

Ở cuối phản hồi, Agent phải tóm tắt ngắn gọn:
- Những gì đã cố tình **bỏ qua / không làm** để giữ mọi thứ tinh gọn.
- Những rủi ro tiềm ẩn (nếu có) mà người dùng cần lưu ý.
