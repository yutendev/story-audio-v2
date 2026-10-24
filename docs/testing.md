# Ma trận kiểm thử (T9.1)

Số liệu: chạy ngày 23/10/2026 — **API 188 passed (22 file)**, **web 20 passed (4 file)**, **Python 161 passed / 3 skipped**. Toàn bộ test offline trừ các gate opt-in ghi rõ bên dưới. Chạy lại các bước 1→4 theo đúng thứ tự khi dựng máy sạch.

## 0. Clean setup (Windows)

1. Cài đặt nền: Node ≥ 22.12 (đã verify 22.15.1), npm 10, Python **3.12** (không 3.13), Docker Desktop, **FFmpeg/ffprobe trong PATH** (FFmpeg 8.x đã verify).
2. `.env` ở root (copy từ `.env.example`): `POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB`, `DATABASE_URL` (host 5454), `PORT=3000`. Test **không cần R2 thật** (dùng InMemoryStore; R2 thật chỉ cho chạy live).
3. Hạ Docker DB:

   ```powershell
   docker compose up -d db   # container: story-audio-db (host 5454)
   ```

4. Cài phụ thuộc:

   ```powershell
   npm install --prefix apps/api
   npm run prisma:generate --prefix apps/api
   npx prisma migrate deploy --schema apps/api/prisma/schema.prisma   # áp migrations vào DB
   npm install --prefix apps/web
   python -m venv workers/python/.venv
   workers\python\.venv\Scripts\pip install -e "workers/python[test]"
   ```

## 1. Lệnh chạy + kết quả chuẩn

| Bộ test | Lệnh (thư mục làm việc) | Chuẩn xanh |
|---|---|---|
| API (Node/TS) | `apps/api`: `npx vitest run` | 188 passed / 22 file |
| Worker (Python) | `workers/python`: `.venv\Scripts\python.exe -m pytest tests -q` | 161 passed, 3 skipped |
| Frontend | `apps/web`: `npx vitest run` (`npm test`) | 20 passed / 4 file |
| Frontend build | `apps/web`: `npm run build` | build ✓ |

`vitest run` = một lượt (không watch). Test API nạp `.env` root qua dotenv và nối **PostgreSQL thật qua docker `story-audio-db`**; test Python/web không đụng mạng.

## 2. Ma trận phủ theo khu vực (plan T9.1)

| Khu vực | File test | Ghi chú khối lượng |
|---|---|---|
| Source adapter | `workers/python/tests/test_sources.py` | fetch mock (fixture HTML), phân mục, mốc chương, lỗi mạng → PERMANENT |
| Text stages + QA | `test_text_stages.py`, `test_qa.py` | extract/normalize; QA CJK, bracket lệch, độ dài bất thường, prompt leak, output rỗng — anomaly → NEEDS_REVIEW (không auto-fix) |
| Rewrite + cache | `test_rewrite.py` | provider mock; cache hit bỏ qua provider, cache hỏng từ chối, QA chạy lại trên cache hit |
| TTS | `test_audio.py` | edge-tts mock; retry tạm thời, chia khúc; **live opt-in `LIVE_TTS=1`** |
| State machine | `apps/api/tests/state-machine.test.ts`, `job-controls.test.ts` | bảng JOB_TRANSITIONS/CHAPTER_TRANSITIONS; retry/resume 409 đúng luật |
| Worker protocol | Python `test_events.py`, `test_cli_contract.py`; TS `worker-events.test.ts`, `worker-spawn.test.ts` | event schema, seq unique, final statuses, exit code, ACTIONS registry |
| R2 mock | TS `r2-adapter.test.ts`, `asset-service.test.ts`, `asset-download.test.ts`, `storage-budget.test.ts`, `object-keys.test.ts`, `assets-list.test.ts` | InMemoryStore; upload head-verify (etag/md5), delete orphan, budget, unsafe key |
| Packaging | Python `test_package.py`, `test_package_builder.py`, `test_yt_export.py`; TS `package-build.test.ts`, `pkg-groups.test.ts`, `pkg-settings.test.ts`, `package-yt.test.ts`, `pkg-repackage.test.ts` | ffmpeg argv ARRAY (không shell), ffprobe seam inject, manifest atomic, group/plan idempotent, m4b/mp4/description validate, **LIVE_FFMPEG=1** opt-in 2 test |
| API validation | `apps/api/tests/api.test.ts`, `job-api.test.ts`, `assets-list.test.ts`, `shutdown-cancel.test.ts`, `queue.test.ts` | body schema, 4xx chuẩn, cancel signal, claim SKIP LOCKED |
| Frontend states | `apps/web/tests/` (4 file) | form validate/POST shape/settings persist reflect; list theo state; SSE live + reconnect + reload; nút theo máy trạng thái (409 nguyên văn); thư viện output + presign |

## 3. Test opt-in (không chạy mặc định)

| Gate | dùng | Yêu cầu |
|---|---|---|
| `LIVE_TTS=1` | `test_audio.py` — gọi edge-tts thật | cần mạng; không tốn phí |
| `LIVE_FFMPEG=1` | 2 test live ffmpeg/ffprobe thật (M4B + composite package→yt_export) | cần ffmpeg PATH; không mạng |

Không test nào tự gọi API trả phí (Gemini) — rewrite provider luôn mock; R2 thật chờ credentials riêng (không tự chạy).

## 4. Giới hạn (explicit)

- Test API **giả định DB đã migrate** (dùng `prisma migrate deploy` ở trên); không tự migrate.
- Web test dùng jsdom + FakeEventSource — **không trình duyệt thật** (không Selenium/Playwright — chưa trong scope plan).
- Test API tạo/xoá job theo prefix `https://example.invalid/...` — không cần data sạch tuyệt đối, nhưng đừng truy vấn data thật trong DB cùng lúc (test deleteMany theo prefix).
- Presign dựa trên server time; TTL clamp đã test ở T4.4 — UI không cho người dùng tự đặt TTL tuỳ ý.
