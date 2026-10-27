# AGENTS.md — Quy ước & Luật Tối cao Cho AI Coding Agent

Tài liệu này là bộ luật điều hành bắt buộc cho mọi AI Agent làm việc trong kho lưu trữ **Story Audio (v2)**. Mọi quyết định và hành động phải tuân thủ nghiêm ngặt các quy tắc dưới đây.

---

## 1. Các Quy Tắc Điều Hành Cốt Lõi (Operating Rules)

### 1.1. Giới hạn 1 task mỗi lần (Single-task Execution)

- Chỉ thực hiện đúng **1 task duy nhất** trong mỗi lượt tương tác.
- Không tự ý cài đặt sớm các task tiếp theo hoặc tự động scaffold toàn bộ dự án ngoài phạm vi được giao.
- Hoàn thành xong 1 task, báo cáo kết quả và dừng lại chờ người dùng nghiệm thu và yêu cầu task kế tiếp.

### 1.2. Kiểm thử Mock là bắt buộc (Mock-First Testing)

- Mọi bài test unit và integration mặc định **phải dùng mocks/fixtures**.
- **TUYỆT ĐỐI KHÔNG:**
  - Tự ý kích hoạt billing hoặc chuyển sang model trả phí.
  - Tự ý chạy batch Gemini API thật hoặc Edge-TTS thật nếu chưa có sự cho phép rõ ràng từ người dùng.
  - Thực hiện thao tác phá hủy database (DROP/TRUNCATE) hoặc xóa object trên Cloudflare R2 khi chưa được xác nhận.

### 1.3. Bảo mật tuyệt đối Secret & Dữ liệu nhạy cảm

- **TUYỆT ĐỐI KHÔNG** in ra màn hình (print), ghi log (log) hoặc commit bất kỳ giá trị secret, token, API key hoặc nội dung của file `.env`.
- File `Audio/.env` cũ là vùng cấm: không inspect, không copy. Mọi secret chỉ nằm trong cấu hình local của người dùng.
- Trong tài liệu và test chỉ được dùng biến môi trường mẫu / placeholder.

### 1.4. Nguồn tham chiếu `Audio/` là CHỈ ĐỌC (Read-Only)

- Thư mục `Audio/` là mã nguồn cũ để tham chiếu, được git ignore toàn bộ.
- Không chỉnh sửa, không xóa và không copy các file cache, text viết lại, audio cũ, `.venv` hay `.git` cũ từ `Audio/` vào dự án mới.
- Chỉ tái sử dụng mã nguồn, test fixtures, glossary sau khi đã inspect và chuẩn hóa.

### 1.5. Khảo sát thực tế trước khi code (Inspect First)

- Luôn kiểm tra cây thư mục, file hiện có và git status trước khi chỉnh sửa.
- Không bao giờ giả định một file tồn tại chỉ vì nó được nhắc đến trong tài liệu cũ.

### 1.6. Tôn trọng bản quyền & Không tự động xuất bản

- Không tích hợp cơ chế tự động upload YouTube hay công khai dữ liệu. Chỉ tạo file export MP4/M4B và mô tả timestamp cục bộ cho người dùng tự xử lý.
- Không xây dựng cơ chế vượt paywall, vượt CAPTCHA hay phá vỡ kiểm soát quyền truy cập của các trang nguồn.

### 1.7. Kiểm thử và tài liệu đi kèm code

- Mọi thay đổi logic code đều phải có unit test hoặc integration test tương ứng.
- Báo cáo trung thực: test nào chạy thành công, test nào bị bỏ qua (skipped) và lý do. Không khẳng định "test passed" nếu chưa thực sự chạy lệnh.

---

## 2. Định Dạng Báo Cáo Chuẩn (Completion Report Format)

Báo cáo tối đa 1 trang, đúng khuôn sau, rồi dừng:

0. **Skill kích hoạt:** tên skill đã nạp bằng `view_file` (hoặc `KHÔNG` nếu task không thuộc chuyên môn nào).
1. **Task & Kết quả:** mã task/tiêu chí và trạng thái (`DONE`, `BLOCKED`, `PARTIAL`).
2. **Bảng tiêu chí:** tiêu chí | ĐẠT / KHÔNG ĐẠT | lệnh đã chạy | output (tối đa 5 dòng).
3. **File thay đổi:** `git diff --stat`.
4. **Trạng thái test:** số passed / failed / skipped từ lệnh vừa chạy, kèm lý do skip.
5. **Trạng thái git:** `git status`; xác nhận không commit và file tạm không bị stage.
6. **NGOÀI PHẠM VI:** việc khác phát hiện được, mỗi việc 1 dòng, không làm, không phân tích.
7. **CẦN USER QUYẾT:** tối đa 3 câu, mỗi câu có khuyến nghị; kèm 1 dòng đề xuất bước tiếp theo.

Rủi ro đã ghi nhận được đưa vào mục 6 hoặc 7, không viết thành đoạn riêng.

## 3. Quy tắc báo cáo và thực thi

Vi phạm bất kỳ điều nào dưới đây thì báo cáo bị trả lại.

**R0. Cổng kích hoạt Skill bắt buộc (Skill-First Gate).**
Trước khi gõ bất kỳ dòng code nào hoặc đọc sâu mã nguồn dự án, Agent BẮT BUỘC phải đối chiếu yêu cầu với thư mục `.agents/skills/`:
- Dính tới Giao diện / Web / CSS / UX 👉 BẮT BUỘC gọi `view_file` nạp cả 2 file `frontend-design/SKILL.md` và `ui-ux-pro-max/SKILL.md`.
- Dính tới Sửa Bug phức tạp / Refactor / TDD 👉 BẮT BUỘC nạp `superpowers/SKILL.md`.
- Dính tới Dịch thuật / Chuốt văn / QA / Glossary 👉 BẮT BUỘC nạp `regression-qa/SKILL.md`.
- Dính tới Đóng gói M4B / Video MP4 / FFmpeg 👉 BẮT BUỘC nạp `package-builder/SKILL.md`.
- Dính tới Tối ưu / Viết code tinh gọn 👉 BẮT BUỘC nạp `ponytail/SKILL.md`.

Trong Báo cáo (Mục 0) hoặc phản hồi, BẮT BUỘC phải ghi rõ skill đã kích hoạt kèm bằng chứng đã nạp file `SKILL.md`. Bỏ qua bước này coi như vi phạm R0 và kết quả bị bác bỏ.

**R1. Một việc mỗi vòng.** Chỉ làm đúng mã task hoặc mã tiêu chí được giao (ví dụ D1).
Việc khác phát hiện được chỉ ghi 1 dòng vào mục NGOÀI PHẠM VI.

**R2. Tiêu chí xong phải kiểm tra được.** Mỗi mục có danh sách kiểm tra đạt/không đạt
nêu sẵn trong prompt. Còn 1 dòng chưa đạt thì chưa xong.

**R3. Báo cáo theo đúng khuôn Mục 2.** Cấm bảng ngoài khuôn, đoạn giải thích dài,
và thiết kế chưa được yêu cầu.

**R4. Bằng chứng từ lệnh, không từ trí nhớ.** Mọi trích dẫn code (file:line) và mọi con số
phải do một lệnh chạy trong vòng này sinh ra và hiện trong báo cáo. Không có lệnh thì ghi
"CHƯA KIỂM CHỨNG". Cấm ghi "đã đo" khi chỉ đọc code.

**R5. Không đổi phép đo giữa chừng.** Không sửa script đo/test để con số đẹp lên.
Phép đo sai thì dừng, báo cáo, chờ USER.

**R6. Sửa code theo trình tự:** (1) viết test fail trước, (2) sửa code, (3) test pass,
(4) chạy lại toàn bộ suite, (5) hoàn tác tạm thay đổi để chứng minh test fail, rồi khôi phục.
Test không fail khi hoàn tác thì xóa.

**R7. Cấm tự khen.** Không dùng "ổn định", "hoàn toàn", "triệt để", "100%"
nếu không đi kèm lệnh và số.

**R8. Mâu thuẫn số liệu:** nếu số mới khác số báo cáo trước, nêu cả hai và chỉ ra
cái nào sai trong cùng 1 dòng. Không im lặng đổi số.

**R9. Phạm vi file.** Chỉ sửa file được liệt kê trong prompt. File khác cần sửa thì dừng
và hỏi. Không đổi ngưỡng hoặc luật nghiệp vụ. Không commit trừ khi prompt của USER yêu cầu rõ.
File tạm (scratch/) không được stage.

**R10. Dừng đúng lúc.** Xong mục thì dừng. Cùng một lỗi sau 2 vòng sửa mà chưa có chẩn đoán
mới thì dừng và báo cáo, không thử tiếp.

**R11. LLM thật.** Theo 1.2 và 1.3: chỉ chạy khi key có sẵn và USER nói rõ
"cho phép chạy LLM thật". Không giả lập mock rồi gọi là LLM thật. Không in key.
