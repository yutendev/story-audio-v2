# Regression QA — Xích Tâm Tuận Thiên (T9.3)

- Văn bản kiểm QA: **152** (chương 6 + cache 146) — offline, không mạng, không API trả phí.
- Tên chương kiểm dải liên tiếp: 2845–2850
- Số văn bản bị CHẶN duyệt (flagged): **1**
- Tự-kiểm detector (mẫu xấu nhân tạo): **tất cả được phát hiện**

## Chờ duyệt

| Loại | Tên/Hash | Problems |
|---|---|---|
| chapter | 2850 | thiếu thuật ngữ QA: Khương Vô Ưu, Dưỡng Tâm Cung chủ, Khương Vô Tà |

## Tự-kiểm detector

| Mẫu xấu | Bắt được |
|---|---|
| CJK sót | ✓ |
| rò rỉ prompt | ✓ |
| ngoặc lệch | ✓ |
| cắt cụt | ✓ |
| câu lặp | ✓ |
| thiếu thuật ngữ | ✓ |

## Ghi chú kiểm đếm

- Tập regression gốc gồm **153 file**: 6 chương viet_lai + 146 đoạn _cache + _log.txt (nhật ký pipeline cũ) — 152 văn bản qua QA; _log.txt không phải văn bản chương.
