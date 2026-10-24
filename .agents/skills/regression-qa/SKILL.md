---
name: regression-qa
description: >-
  Chạy bộ kiểm thử hồi quy QA văn bản (153 parts) và TỰ ĐỘNG sửa đến khi đạt toàn bộ.
  Dùng khi thay đổi thuật toán QA, prompt dịch, glossary hoặc pipeline dịch/TTS; hoặc khi
  văn bản dịch còn sót CJK, ký tự lạ, rò rỉ prompt, thiếu thuật ngữ, cắt cụt, lặp đoạn.
---

# Regression QA Skill (tự động, tự sửa)

Chạy hoàn toàn tự động: không hỏi người dùng, không gắn cờ chờ duyệt, không gọi API mạng.
Mục tiêu: 153/153 parts đạt và không còn lỗi thuộc danh mục bên dưới.

## Quy tắc bất khả xâm phạm

- KHÔNG sửa test, dataset, ngưỡng hay glossary để "cho qua". Chỉ sửa code, prompt, hậu xử lý.
- KHÔNG nới lỏng tiêu chí (ví dụ tăng ngưỡng ±25%) để test xanh.
- KHÔNG bỏ qua (skip/xfail) test, KHÔNG bắt exception rồi nuốt lỗi.
- Văn bản chưa qua QA thì KHÔNG được chuyển sang TTS.

## Vòng lặp chính

1. Chạy:
   ```powershell
   workers\python\.venv\Scripts\python.exe -m pytest workers/python/tests/test_regression_qa.py -v
   ```
2. Nếu có part lỗi: phân loại theo danh mục lỗi, tìm nguyên nhân gốc trong code, sửa, rồi chạy lại TOÀN BỘ bộ test (không chỉ part vừa sửa) để chắc không gây hồi quy.
3. Lặp tối đa 8 vòng. Mỗi vòng phải sửa nguyên nhân khác hoặc sâu hơn vòng trước.
4. Nếu sau 8 vòng vẫn còn lỗi: dừng, in báo cáo ngắn gồm part lỗi, danh mục, và nguyên nhân nghi ngờ. Không giả vờ đã xong.

## Danh mục lỗi cần bắt (kiểm tra chặt)

1. **Sót CJK**: bất kỳ ký tự trong U+4E00–U+9FFF, U+3400–U+4DBF, U+3040–U+30FF, U+AC00–U+D7AF,
   và dấu câu CJK/fullwidth (U+3000–U+303F, U+FF00–U+FFEF) còn trong bản tiếng Việt.
   Ngoại lệ duy nhất: chuỗi nằm trong whitelist rõ ràng của dự án.
2. **Chữ lạ / hỏng**: ký tự thay thế U+FFFD, dấu hiệu mojibake, chữ Thái/Cyrillic/Ả Rập xuất hiện
   không đúng ngữ cảnh, chuỗi vô nghĩa, ký tự lặp bất thường (≥5 ký tự giống nhau liên tiếp),
   tổ hợp dấu tiếng Việt không hợp lệ.
3. **Rò rỉ prompt**: câu dẫn của model ("Dưới đây là bản dịch...", "Sure, here is...",
   "Tôi đã dịch...", ghi chú trong ngoặc của model, tag hệ thống).
4. **Ngoặc thoại**: số lượng 「」, “”, 【】 lệch quá ±25% so với bản gốc, hoặc ngoặc mở/đóng không cân.
5. **Glossary**: thiếu hoặc dịch sai thuật ngữ bắt buộc trong `glossary.json`
   (kiểm tra đúng dạng được quy định, không chỉ có mặt từ).
6. **Cắt cụt**: đoạn kết thúc giữa câu, hoặc độ dài bản dịch thấp bất thường so với bản gốc.
7. **Lặp đoạn**: câu/đoạn bị lặp lại liên tiếp hoặc lặp theo n-gram bất thường.
8. **Sót chưa dịch**: câu còn nguyên ngôn ngữ nguồn, tên riêng phiên âm không nhất quán với glossary.

## Cách tự sửa theo mức tăng dần (áp dụng ở cả lúc chạy thật)

Với mỗi đoạn lỗi, chỉ làm lại ĐÚNG đoạn đó, không dịch lại cả chương:

- **Mức 1: sửa xác định (không gọi model):** xóa câu dẫn bị rò rỉ, thay thuật ngữ theo glossary,
  chuẩn hóa ngoặc, loại ký tự hỏng, gộp đoạn lặp.
- **Mức 2: dịch lại đoạn lỗi** với prompt chặt hơn: nêu rõ lỗi vừa mắc, yêu cầu chỉ trả bản dịch,
  tiếng Việt thuần, nhúng glossary liên quan.
- **Mức 3: tách nhỏ** đoạn lỗi thành các câu rồi dịch từng câu, ghép lại.
- Sau mỗi mức: chạy lại bộ kiểm tra trên đoạn đó. Đạt thì dừng, không đạt thì lên mức tiếp.

Nếu hết cả 3 mức mà đoạn vẫn lỗi: ghi vào log (`qa_report`) đoạn, danh mục lỗi và số lần thử, dùng
bản tốt nhất đã đạt (ít lỗi nhất) rồi TIẾP TỤC pipeline. Không dừng, không chờ người, không gắn cờ chặn.

## Báo cáo cuối mỗi lần chạy

In ngắn gọn: số part đạt/tổng, số đoạn phải tự sửa theo từng mức, số đoạn dùng bản dự phòng.
Nếu số đoạn dự phòng khác 0, nói rõ đây là chỗ cần cải thiện thuật toán ở lần tới.
