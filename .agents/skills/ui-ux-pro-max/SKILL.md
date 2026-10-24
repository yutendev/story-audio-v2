---
name: ui-ux-pro-max
description: >-
  Kỹ năng chuyên gia UI/UX toàn diện (UI/UX Pro Max Intelligence).
  Áp dụng tiêu chuẩn công thái học phần mềm, quy tắc phối màu chuẩn token, khả năng tiếp cận (WCAG 2.1 AA),
  thiết kế component đa trạng thái và layout thích ứng tối ưu.
---

# UI/UX Pro Max Skill — Expert System & Ergonomics

Kỹ năng này cung cấp bộ khung tiêu chuẩn chuyên sâu về công thái học (ergonomics), thiết kế hệ thống (design systems) và khả năng tiếp cận (accessibility) cho frontend.

---

## 1. Tiêu Chuẩn Tiếp Cận & Khả Năng Đọc (Accessibility - a11y)

* **Tương phản màu sắc (Contrast Ratio):**
  - Text thường và nền: Tối thiểu **4.5:1** (chuẩn WCAG AA).
  - Text lớn (≥ 18pt hoặc ≥ 14pt bold) & UI components: Tối thiểu **3:1**.
* **Vùng tương tác (Touch / Click Targets):**
  - Mọi nút bấm, link hoặc icon bấm được phải đạt diện tích tối thiểu **44x44px** (tính cả padding/hitbox).
* **Bàn phím & Focus State:**
  - Không bao giờ xóa `outline: none` mà không cung cấp focus ring thay thế (`focus-visible:ring-2 focus-visible:ring-offset-2`).
  - Hỗ trợ phím tắt và phím Tab logic theo đúng thứ tự DOM.

---

## 2. Thiết Kế Trạng Thái Toàn Diện (8-State Component Design)

Khi xây dựng bất kỳ component nào (đặc biệt là Form, Table, Job List, Player), Agent bắt buộc phải tính toán đủ **8 trạng thái**:

1. **Default:** Trạng thái nghỉ bình thường.
2. **Hover:** Con trỏ chuột lướt qua, có phản hồi thị giác nhẹ nhàng.
3. **Active / Pressed:** Khoảnh khắc đang bấm chuột.
4. **Focus-visible:** Trạng thái được chọn bằng bàn phím.
5. **Loading / Processing:** Khi đang gửi request hoặc xử lý nền (nút disabled + spinner hoặc skeleton).
6. **Success / Completed:** Phản hồi khi tác vụ hoàn tất (toast hoặc icon xanh dịu).
7. **Error / Invalid:** Báo lỗi rõ ràng, có gợi ý hành động khắc phục, không chỉ đổi viền đỏ.
8. **Empty State:** Khi chưa có dữ liệu (kèm minh họa nhẹ và nút kêu gọi hành động khởi tạo).

---

## 3. Hệ Thống Khoảng Cách & Spacing Rhythms

* **Hệ thống lưới 4px / 8px:** Toàn bộ `padding`, `margin`, `gap` phải là bội số của 4 (ví dụ: `4px`, `8px`, `12px`, `16px`, `24px`, `32px`, `48px`).
* **Tránh giao diện ngột ngạt:** Luôn để khoảng trắng (whitespace) "thở" giữa các khối dữ liệu lớn.
* **Layout thích ứng (Responsive):**
  - Mobile-first hoặc Breakpoint rõ ràng (`sm: 640px`, `md: 768px`, `lg: 1024px`, `xl: 1280px`).
  - Không để tràn ngang (horizontal scroll) ngoài ý muốn trên màn hình nhỏ.

---

## 4. Quản Lý Thông Báo & Feedback

* Không dùng popup alert chặn thao tác người dùng (`window.alert`).
* Sử dụng Toast hoặc Inline banner với 4 phân loại rõ rệt: Info, Success, Warning, Error.
* Báo lỗi phải thân thiện: Tránh quăng mã lỗi raw (như `Error 500: Database failed`) ra màn hình; giải thích ngắn gọn nguyên nhân và cung cấp nút thử lại (Retry).
