# Báo Cáo Đo Đạc Baseline (Phase 0) — Story Audio v2

- **Thời điểm thực hiện:** 2026-10-24
- **Môi trường thực thi:** Windows, Python 3.12.14, FFmpeg 8.x, edge-tts 7.3.1.
- **Mục tiêu:** Đo đạc và ghi nhận nguyên trạng hiệu năng, thông số kỹ thuật và hành vi hệ thống trước khi thực hiện bất kỳ thay đổi logic nào.

---

## 1. Kết Quả Kiểm Thử Hồi Quy Hiện Tại

### 1.1. Bộ kiểm thử hồi quy 153 parts (`workers/python/scripts/regression_qa.py`)
- **Tổng số văn bản kiểm tra:** 152 văn bản (6 chương viet_lai + 146 đoạn _cache). File `_log.txt` thứ 153 là nhật ký, được bỏ qua đúng quy chuẩn.
- **Kết quả:**
  - `chapters`: 6
  - `cache`: 146
  - `flagged`: 1 (Chương 2850 bị chặn do thiếu thuật ngữ QA: *Khương Vô Ưu*, *Dưỡng Tâm Cung chủ*, *Khương Vô Tà*).
  - `self_check`: 6/6 mẫu xấu nhân tạo (CJK sót, rò rỉ prompt, ngoặc lệch, cắt cụt, câu lặp, thiếu thuật ngữ) đều bị bắt chính xác 100%.

### 1.2. Bộ kiểm thử đơn vị Pytest (`workers/python/tests/`)
- **Kết quả:** 174 passed, 3 skipped (live tests opt-in), 2 failed.
- **Chi tiết 2 test failed:**
  1. `test_rewrite_qa_failed_chapter_needs_review`
  2. `test_rewrite_qa_runs_on_cache_hit`
- **Nguyên nhân thất bại (Root Cause):**
  - Tại dòng 421 file `workers/python/src/story_audio/rewrite.py`: hàm `auto_sanitize_cjk(content)` đang được gọi **trước** khi chạy `qa_check`.
  - Việc này vô tình khử sạch/phiên âm các ký tự Hán tự CJK trước khi tới cổng kiểm định QA, làm cho QA không bắt được lỗi CJK trong test mock (`CJKEcho`), dẫn tới trả về `ExitCode.SUCCESS` thay vì `ExitCode.NEEDS_REVIEW`.
  - *Lưu ý:* Đúng theo yêu cầu của Phase 0, lỗi này được giữ nguyên trạng làm baseline và sẽ được giải quyết triệt để tại Phase 1.1.

---

## 2. Đo Đạc Hiệu Năng Từng Tầng (Chương & Cuốn Mẫu)

Dữ liệu đo đạc thực tế từ script `workers/python/scripts/measure_baseline.py`:

### 2.1. Chương mẫu: Chương 2845 (Truyện *Xích Tâm Tuần Thiên*)
- **Văn bản nguồn:** `Audio/nguon/xich-tam-tuan-thien/2845.txt` (~468 đoạn, 14.5 KB).
- **Văn bản đã viết lại:** `Audio/viet_lai/xich-tam-tuan-thien/2845.txt` (~12.8 KB).

| Tầng xử lý | Thời gian thực thi | Thông số chi tiết |
|---|---|---|
| **1. Normalize** | **17.77 ms** | Xử lý regex 468 đoạn văn, thay thế replace.json |
| **2. Chunking (Rewrite)** | **0.84 ms** | Chia thành 37 chunks (ngưỡng max 1500 ký tự) |
| **3. Validate từng chunk** | **11.69 ms** | 37 chunks; trượt validate: 29 chunks (do lệch tỉ lệ/thuật ngữ so với bản dịch cũ) |
| **4. QA Gate toàn chương** | **7.13 ms** | Quét 8 lớp kiểm tra; số lỗi: 0 (đạt tiêu chuẩn) |
| **5. TTS Chunking** | **0.83 ms** | Chia thành 38 chunks cho TTS (max 1500 ký tự) |
| **6. Edge-TTS Network Sample** | **11.74 s** | Tạo 1 chunk mẫu (200 ký tự) → tạo ra 16.20s audio MP3 |

### 2.2. Cuốn mẫu: Đóng gói M4B 6 Chương (2845 – 2850)
- **Cấu hình:** Ghép 6 file audio chương thành 1 file `book.m4b` kèm `FFMETADATA1` (chapter markers).

| Công đoạn đóng gói | Thời gian thực thi | Ghi chú |
|---|---|---|
| **ffprobe đo duration 6 file** | **512.44 ms** | Lấy chính xác thời lượng từng file để tính ms |
| **Sinh metadata & concat list** | **2.64 ms** | Tạo file ffmetadata.txt & concat.txt |
| **ffmpeg muxing M4B** | **246.21 ms** | Lệnh: `ffmpeg -f concat ... -c:a aac -b:a 96k -f ipod` |
| **ffprobe verify M4B** | **77.73 ms** | Xác thực 6 chapter markers, tổng duration 30.05s |
| **Tổng thời gian đóng gói M4B** | **~839.02 ms** | Chưa tính thời gian render TTS của từng chương |

---

## 3. Kết Quả Kiểm Chứng Các Giả Định Kỹ Thuật (a, b, c, d)

### (a) Thông số thật của MP3 do Edge-TTS tạo (kiểm chứng bằng ffprobe)
Kết quả trích xuất trực tiếp từ `ffprobe -show_streams -show_format`:
- **Codec:** `mp3` (MPEG audio layer 3).
- **Sample Rate:** `24000 Hz` (24 kHz).
- **Channels:** `1` (kênh đơn - `mono`).
- **Bitrate:** `48000 bps` (`48 kbps`).
- **Container Format:** `mp3`.
- *Nhận xét:* Nguồn âm thanh Edge-TTS trả về là **mono 48 kbps**. Do đó, việc đóng gói M4B với bitrate 96 kbps hiện tại là dư thừa gấp đôi dung lượng mà không làm tăng chất lượng gốc. Nên cân nhắc tối ưu bitrate ở Phase 3.4.

### (b) Khả năng hỗ trợ SSML / break của thư viện `edge-tts` (v7.3.1)
- **Kết quả kiểm chứng:** **KHÔNG hỗ trợ SSML raw.**
- **Bằng chứng mã nguồn:**
  Trong file `edge_tts/communicate.py`, hàm khởi tạo `Communicate.__init__` luôn thực thi lệnh escape bắt buộc:
  ```python
  self.texts = split_text_by_byte_length(
      escape(remove_incompatible_characters(text)), 4096
  )
  ```
  Hàm `escape()` tự động biến đổi toàn bộ ký tự `<` và `>` thành `&lt;` và `&gt;`. Mọi thẻ như `<break time="500ms"/>` sẽ bị biến thành text thường và bị đọc thành lời.
- **Kết luận kiến trúc:** Giải pháp chèn file âm thanh im lặng (Silence MP3) có cùng thông số (24000Hz, mono, MP3) vào danh sách `concat` là phương án ổn định và chuẩn xác nhất.

### (c) Nguồn gốc của `prev_tail`
- **Kết quả kiểm chứng:** Hiện đang lấy từ **BẢN ĐÃ VIẾT LẠI** (`r["text"]` ở dòng 408 file `rewrite.py`):
  ```python
  prev_tail = " ".join(split_sentences(r["text"])[-3:])
  ```
- **Hệ quả:** Do chunk sau phải chờ kết quả viết lại của chunk trước để lấy `prev_tail`, quá trình gọi LLM hiện tại buộc phải chạy tuần tự (sequential). Khi chuyển sang lấy từ **BẢN GỐC** ở Phase 4, ta có thể chạy song song (parallel) các chunk độc lập.

### (d) Số lớp kiểm tra thực tế của QA Gate (`qa.py`)
Mặc dù tài liệu mô tả thường tóm tắt 6-7 lớp, mã nguồn thực tế trong `qa.py::qa_check` sở hữu đầy đủ **8 lớp kiểm tra độc lập**:
1. **Kiểm tra rỗng:** Trả về lỗi nếu văn bản sau ghép rỗng (`not text.strip()`).
2. **Kiểm tra CJK còn sót:** Quét regex `CJK_RE`, lỗi nếu số ký tự CJK > `cjk_max` (mặc định 0).
3. **Kiểm tra rò rỉ prompt:** Quét các từ khóa hệ thống: *"Ngữ cảnh:"*, *"Đoạn bản gốc cần viết lại"*, *"Bảng thuật ngữ"*, *"Yêu cầu bắt buộc"*, *"biên tập viên người Việt"*.
4. **Kiểm tra lệch cặp ngoặc:** Quét cân bằng số lượng mở/đóng của `()`, `[]`, `「」`.
5. **Kiểm tra tỷ lệ độ dài:** So sánh độ dài bản dịch / bản gốc trong dải [0.7, 1.3].
6. **Kiểm tra cắt cụt:** Lỗi nếu câu cuối bản gốc có dấu kết câu (`.!?…。”’"`) nhưng bản dịch bị mất dấu.
7. **Kiểm tra lặp câu:** Đếm số lần lặp của câu dài ≥ 8 ký tự; lỗi nếu vượt quá `repeat_max` (mặc định 3).
8. **Kiểm tra thuật ngữ glossary:** Kiểm tra sự xuất hiện của các từ khóa bắt buộc trong `glossary.json`.

---

## 4. Kết Luận & Điều Kiện Nghiệm Thu Phase 0

- [x] Đã chạy và lưu kết quả bộ kiểm thử hồi quy 153 parts.
- [x] Đã đo thời gian chi tiết từng tầng trên chương 2845 và cuốn mẫu 6 chương.
- [x] Đã kiểm chứng độc lập và làm rõ 4 câu hỏi kỹ thuật (a, b, c, d).
- [x] Không sửa đổi bất kỳ logic vận hành nào của pipeline.
- [x] Tạo tài liệu `docs/BASELINE.md` đầy đủ.
