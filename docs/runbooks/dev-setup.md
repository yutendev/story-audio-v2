# Dev setup — Windows (T0.3)

Mục tiêu: dev mới dựng được môi trường mà không cần file riêng tư nào (secrets nằm trong `.env` local, chỉ có tên biến trong `.env.example`).

## 1. OS & runtime đã xác minh trên máy dev (2026-10-22)

| Thành phần | Pin (major) | Đã xác minh | Ghi chú |
|---|---|---|---|
| OS | Windows 11 x64 | ✔ | Windows 10 x64 cũng được |
| Node.js | **22 LTS** | `node -v` → 22.15.1 | không dùng bản non-LTS |
| npm | 10 | `npm -v` → 10.9.2 | đi kèm Node 22 |
| Python | **3.12** | ⚠ chưa cài system | venv cũ của `Audio/` dùng 3.12 (chứng tỏ tương thích máy này); **không tái sử dụng venv cũ** — tạo venv mới ở T1.1 |
| FFmpeg / FFprobe | **8.x** | `ffmpeg -version` → 8.1.1 (gyan.dev full build) | đã trong PATH |
| Git | 2.x | `git --version` → 2.51.2.windows.1 | |
| PostgreSQL | **17** | ⚠ chưa cài native | ưu tiên Compose service (`postgres:17-alpine`, T2.1); phương án native: cài từ postgresql.org, cấu hình user/db dev riêng |

Cài Python khi cần: `winget install Python.Python.3.12` (hoặc python.org installer). Không pin patch version — chỉ pin major.

## 2. Biến môi trường

Xem `.env.example` (chỉ tên biến, giá trị rỗng). Copy thành `.env` và điền local — `.env` bị gitignore (T0.2). Không commit, không log giá trị thật.

## 3. Giới hạn không mất phí (đã tra 2026-10-22)

### Gemini API Free (AI rewrite — T5.x)
- Free tier = project chưa bật billing; app **không bao giờ** bật billing hay fallback sang model trả phí (invariant §3.1).
- Giới hạn đo theo 3 chiều: **RPM** (requests/phút), **TPM** (token/phút), **RPD** (requests/ngày); vượt chiều nào cũng nhận `429 RESOURCE_EXHAUSTED`.
- RPD reset lúc **00:00 giờ Pacific**.
- Số cụ thể từng model không còn công bố trên docs — xem giới hạn thực tế trong AI Studio: https://aistudio.google.com/rate-limit — do đó quota manager (T5.7) phải xử lý 429/quota động, không hard-code con số.

### Cloudflare R2 Free tier (private bucket — T4.x)
- Storage: **10 GB-tháng/tháng** miễn phí (chỉ Standard storage; không áp dụng Infrequent Access).
- Class A (write/list…): **1 triệu requests/tháng** miễn phí.
- Class B (read/head…): **10 triệu requests/tháng** miễn phí.
- Egress (trả data ra Internet): **miễn phí**.
- Nguồn: https://developers.cloudflare.com/r2/pricing/ (cập nhật Oct 2026).
- App vẫn phải cấu hình **storage budget** riêng và cảnh báo/chặn upload mới trước khi vượt (invariant §3.1, task T4.5) — free tier không phải vô hạn.

## 4. PostgreSQL local (T2.1)

Lệnh chuẩn (yêu cầu Docker Desktop đang chạy):

```powershell
# 1) copy .env.example → .env, điền: POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
#    + DATABASE_URL=postgresql://<user>:<pw>@localhost:5454/<db>
# 2) khởi động + xác minh health:
docker compose up -d db
docker compose ps db            # phải thấy (healthy)
```

- Image pin `postgres:17-alpine`, data giữ trong docker volume `dbdata` (không nằm trong repo).
- Port host 5454 → tránh trùng native 5432.
- **Không hard-code credential trong compose.yaml** — compose đọc `./.env` (gitignored); thiếu biến sẽ fail-fast có báo lỗi rõ.
- Native alternative (không dùng Docker): cài PostgreSQL 17 từ postgresql.org Windows installer, tạo user/db riêng cho dev (không dùng postgres superuser), rồi cấu hình `DATABASE_URL=postgresql://...@localhost:5432/<db>` trong `.env`; bỏ qua bước compose.

### Prisma migrations (T2.2, chuẩn Prisma v7)

```powershell
Set-Location apps\api
npx prisma migrate dev --name <tên-migration>   # tạo + áp migration (cần DATABASE_URL trong ..\.env)
npx prisma generate                             # regenerate client
npm run smoke                                   # smoke query qua driver adapter
```

- Prisma 7 đổi cách cấu hình: connection URL nằm ở `apps/api/prisma.config.ts` (không còn `url = env()` trong schema); runtime client phải tạo với driver adapter (`@prisma/adapter-pg`).
- Đang pin `prisma@7.10.1` + `@prisma/client@7.10.1` (stable non-prerelease; `latest` của npm đang là 8.0.0-rc.25 → prerelease, bị loại theo plan).

## 6. Khởi động một lệnh (T9.4)

Mọi bước dựng môi trường + chạy dev gọn thành một lệnh (từ root repo):

```powershell
.\scripts\dev.ps1
```

Script tự làm theo thứ tự (idempotent — chạy lại an toàn):

1. **Prereq:** có `.env`, `node`, `docker`, `ffmpeg` trong PATH — thiếu thì dừng với thông báo rõ (cài gì xem §1, §4).
2. **PostgreSQL:** `docker compose up -d db` + chờ healthy (tối đa 30s).
3. **Phụ thuộc thiếu mới cài:** `npm install` apps/api + apps/web, `prisma generate`, `prisma migrate deploy`; venv workers/python nếu chưa có (`python -m venv` + `pip install -e "workers/python[test]"`).
4. **Chạy API + Web** cùng console: API `:3000` (health `GET /api/jobs?limit=1`), Web `:5173` — script chờ health rồi mới báo "ready".
5. **Clean shutdown:** Ctrl+C ở cửa sổ script — Node/API nhận SIGINT → `gracefulShutdown` (T3.6, chờ job đang chạy trong grace period); script dọn node còn lắng nghe 3000/5173 (chống process mồ côi). Job bị ngắt ở state `running` được `requeueOrphanedJobs` tự khôi phục ở lần boot sau (T3.3/T9.2).

R2 variables: điền trong `.env` local (tên biến xem `.env.example`; account/key chỉ Node đọc). Script không in giá trị nào.

## 7. Quy tắc chi phí

Không bật billing, không gọi API trả phí, không fallback tự động sang model trả phí. Hết quota free → lưu state và chờ (`quota_wait`). Test mặc định dùng mock/fixture; test live Gemini/TTS phải được user cho phép rõ ràng.

## 8. Backup & restore (T9.5)

Dữ liệu sống ở 3 chỗ — mỗi chỗ một cách bảo vệ:

| Dữ liệu | Ở đâu | Backup | Restore |
|---|---|---|---|
| PostgreSQL (job/chapter/asset metadata) | container `story-audio-db` (`host:5454`) | nạp env trước (`. .\scripts\load-env.ps1`) rồi `docker compose exec -T db pg_dump -U $env:POSTGRES_USER story_audio > backup-YYYYMMDD.sql` | dựng lại container + `psql -U user -d story_audio < backup.sql`, xong chạy `npx prisma migrate deploy` để đồng bộ |
| Audio/text đã verify | bucket R2 privada | data **tái tạo được**: chạy lại job từ stage văn bản (TTS free) — không mất gì ngoài audio tính lại; muốn chắc thêm: bật versioning bucket trong dashboard Cloudflare (thủ công 1 lần) | re-run pipeline; không edit object trực tiếp |
| Code + corpus gốc | git + `Audio/` (chỉ đọc) | commits; media/language gốc không nằm trong repo | `git checkout` |

- `docker compose down` MẶC ĐỊNH giữ volume; chỉ `down -v` mới xóa dữ liệu — tránh nếu chưa backup. Đổi POSTGRES_PASSWORD trong `.env` trước lần render container đầu tiên.
- Kiểm volume: `docker volume ls | findstr story-audio`.
