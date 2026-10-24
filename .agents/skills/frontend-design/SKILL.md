---
name: frontend-design
description: >-
  Kỹ năng thiết kế giao diện cao cấp (Intentional & Distinctive Frontend Design).
  Chống "AI slop" và các giao diện khuôn mẫu nhàm chán (purple gradients, generic cards).
  Định hướng tạo ra giao diện có cá tính thị giác riêng biệt, typography ấn tượng và trải nghiệm chỉn chu.
---

# Frontend Design Skill — Anti "AI-Slop" & Distinctive Visuals

Kỹ năng này đóng vai trò như một **Design Lead** độc lập, ngăn chặn Agent tạo ra các giao diện chung chung, lặp lại các khuôn mẫu AI thông thường (như nền xám nhạt với các card bo tròn gắn icon màu tím vô hồn).

---

## 1. Nguyên Tắc Thiết Kế Cốt Lõi

### 1.1. Bản Sắc Riêng Biệt (Distinct Visual Identity)
* Trước khi code giao diện, phải xác định **ngữ cảnh và tinh thần (Vibe)** của sản phẩm:
  - Dự án này là công cụ audiobook/âm thanh: Cần cảm giác tập trung, hiện đại, mượt mà (như Spotify / Audible / Linear).
  - Không sao chép các template landing page generic.
* Dám đưa ra các quyết định thẩm mỹ có chủ đích: Lựa chọn phong cách phù hợp (Modern Clean, Dark Minimal, Editorial Typography, hoặc Industrial Functional).

### 1.2. Phân Cấp Typography & Nhịp Điệu (Hierarchy & Rhythm)
* **Font Pairing:** Sử dụng typography có cá tính thay vì chỉ dùng system font mặc định vô hồn.
* **Tỷ lệ tương phản kích thước:** Tiêu đề (Headings) và nội dung (Body text) phải có sự tương phản rõ ràng về trọng số (`font-weight`) và kích thước (`font-size`).
* **Letter-spacing & Line-height:** Luôn tinh chỉnh `tracking-tight` cho heading lớn và `leading-relaxed` cho body đọc dài.

### 1.3. Bảng Màu Có Chủ Đích (Color Palette with Intent)
* Không dùng các dải gradient tím/xanh ngọc lặp đi lặp lại.
* Dùng nguyên tắc phân bổ màu **60-30-10**:
  - **60%:** Màu nền chủ đạo (Background/Surface trung tính sạch sẽ).
  - **30%:** Màu cấu trúc (Text, borders, cards, panels).
  - **10%:** Màu điểm nhấn (Accent/Action CTA nổi bật, tạo sự tập trung).

### 1.4. Chi Tiết & Tương Tác Vi Mô (Micro-interactions)
* Không để component "bất động": Mọi nút bấm, card, input đều cần transitions mượt mà (`duration-150` hoặc `duration-200`).
* Phản hồi trạng thái rõ ràng: Hover, Active, Focus-visible, Loading (skeleton hoặc spinner tinh tế) và Disabled.
* Phân tầng chiều sâu bằng border mờ (`border-border/40`) kết hợp subtle shadow thay vì các shadow đen đậm gắt.
