# Object keys & asset lifecycle (T4.2)

Nguồn code: `apps/api/src/object-keys.ts` — mọi key R2 phải build qua các hàm này.

## Namespace

```
jobs/{jobId}/chapters/{chapterNo:04d}/source.html        # html gốc crawl được
jobs/{jobId}/chapters/{chapterNo:04d}/normalized.txt     # text đã normalize
jobs/{jobId}/chapters/{chapterNo:04d}/rewritten.txt      # text đã rewrite
jobs/{jobId}/chapters/{chapterNo:04d}/audio/part-{NNN}.mp3   # từng mp3 của chương

jobs/{jobId}/packages/{sequence:04d}/book.m4b
jobs/{jobId}/packages/{sequence:04d}/book.mp4           (nếu tạo)
jobs/{jobId}/packages/{sequence:04d}/thumbnail.jpg      (nếu tạo)
jobs/{jobId}/packages/{sequence:04d}/description.txt
```

- `jobId` = cuid của job — dùng làm root namespace 1-1 với job trong DB.
- Chapter/padStart 4; package sequence padStart 4; part 3 chữ số.
- JobId chặn `[\\/]..`, NUL — không cho navigate/nhầm lẫn giữa các job.

## An toàn — chỉ 2 đường hợp pháp vào storage

1. Write: build key bằng `chapterObjectKey()/packageObjectKey()` từ dữ liệu đã validate.
2. Read/patch: key từ nguồn ngoài (worker payload, event) phải qua `ensureKeyBelongsToJob(key, jobId)` — khác namespace → `UnsafeKeyError` (tests chặn cross-job confusion).

## Metadata — cột `assets` (xem data-dictionary.md)

| Cột | Điền khi |
|---|---|
| object_key | key trên (bắt buộc) |
| sha256 | checksum worker Event gửi lên (artifact_ready) |
| size | byte duyệt sau upload |
| verified | true chỉ sau khi head-check size/sha khớp (T4.3) |
| content_type | MIME chuẩn từng loại: .txt text/plain; .html text/html; .mp3 audio/mpeg; .m4b audio/mp4; .mp4 video/mp4; .jpg image/jpeg |

## Lifecycle (từ tạo tới xóa)

1. **Tạo** — worker ghi file R2 (T4.3); node tạo Asset(mark unverified).
2. **Verify** — head/GET-đối-soát size + sha256; khớp `verified=true`.
3. **Active** — chapter con trỏ text/audio/trỏ tới; chữ inactive giữ nguyên object (dedup).
4. **Xóa** — chủ động khi job bị delete (Cascade) hoặc người dùng xóa job; R2 không có lifecycle rule tự xóa (free tier 10GB — theo dõi ở dashboard; không bật auto-expire auto vì viết lại text đắt).

## Quy tắc giữ & privacy

- Private bucket — **không có public URL**; mọi download đi qua API.
- Retention: không tự xóa; dọn tay qua job deletion. Bucket Key KHÔNG chứa password/secret/PII — chỉ id + contents.

## Integration path download (T4.4)

- **UI (React):** `GET /api/jobs/{jobId}/assets/{assetId}/download-url?expires_in=N` →
  `{url, objectKey, expiresIn}` (TTL clamp 30s..7d, mặc định **300s**). URL là signed GET SigV4 —
  **không chứa credentials**; React chỉ nhận URL, không bao giờ thấy ACCESS_KEY/SECRET.
- **Packager (T7):** service `fetchAssetBytes(assetId, jobId)` — đọc bytes trực tiếp qua adapter
  (không đi qua network của browser); luôn kiểm asset thuộc job + `ensureKeyBelongsToJob`.
- Route `GET .../download` proxy bytes cho client cần stream; Content-Type từ asset row.
- Lỗi: R2 chưa cấu hình → **503 R2_UNAVAILABLE**; asset của job khác → **404** (không tiết lộ).
- **Verify R2 thật:** CHƯA XONG — cần bucket + credentials từ user. Offline: tests thay SDK bằng
  fake (`fakeSend`/`FakePresigner`) + docs này. Khi có credentials: dùng `/download-url` với TTL ngắn
  và `curl` không-signed → phải 403 (anonymous bị chặn).
- Unused/unneeded script: không thêm `smoke:r2` cho tới khi dùng credentials thật.

## Free-tier budget (2026-10: R2 10GB, 1M Class-A, 10M Class-B) — theo dõi qua usage R2 dashboard; rất khó vượt giữa dev.
