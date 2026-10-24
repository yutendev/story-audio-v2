# Release checklist — Story Audio v2 (T9.5)

Ký hiệu: ✅ đã kiểm bằng lệnh/đọc mã (kèm bằng chứng), ⚠️ chấp nhận có điều kiện hoặc ghi nhận known-issue. **Không còn critical issue nào mở.**

## 1. Secrets

- ✅ `.env` gitignored (`.gitignore`: `.env`, `.env.*`, trừ `.env.example` — file example là template có chủ ý).
- ✅ `.env.example` chỉ chứa placeholder rỗng — **đã khử secret thật (Gemini key + R2 credentials) ngày 2026-10-23** trước khi file kịp được commit; trước fix, file đã từng rò secret trong working tree.
- ✅ Git history sạch: `git log --all -S"R2_SECRET_ACCESS_KEY="` → **0 commit** (chuỗi này chưa từng vào bất kỳ commit nào).
- ✅ Sweep toàn working-tree (md/ts/tsx/py/json/ps1/yaml/example, trừ `node_modules`/`.venv`/`generated`/`Audio`): **0** giá trị secret. Chỉ `.env` thật chứa — không đọc/in.
- ✅ `scripts/dev.ps1` không đọc/in giá trị `.env` (chỉ Test-Path sự tồn tại).
- ⚠️ **Khuyến nghị sau release:** rotate (đổi) cả Gemini API key và R2 secret đã từng nằm trong `.env.example` của máy dev này.

## 2. R2 privacy & object policy

- ✅ Bucket riêng tư (private); credentials chỉ nằm trong Node process env (r2-resolver / r2-config).
- ✅ Mọi truy cập object đi qua 2 surface job-scoped (asset-download.ts): `loadScopedAsset` (asset phải thuộc jobId) + `ensureKeyBelongsToJob` (namespace key — defence-in-depth); vi phạm → 404, **không tiết lộ tồn tại** của asset job khác.
- ✅ Presigned GET: TTL clamp [30s, 7 ngày], mặc định **300s**; URL không chứa credentials.

## 3. URL authorization

- ✅ Theo plan §16: app cá nhân single-user — không hệ auth user; authorization thực tế = job-scoping trên từng route (mục 2) + asset list không trả `objectKey` (T8.4, asset-routes.ts).
- ✅ API không có route public nào liệt kê/đọc object xuyên job — mọi endpoint asset chỉ nhắm đúng jobId cụ thể.

## 4. Storage budget (T4.5)

- ✅ Chặn upload vượt `STORAGE_BUDGET_MB` **trước khi** ghi R2 (asset-service.ts — lỗi rõ `vượt budget: cần thêm X B trên tổng Y B — đang dùng Z B`); cảnh báo theo `STORAGE_BUDGET_WARN_PERCENT`.
- ⚠️ Budget là giới hạn cấp app; hard quota của Cloudflare vẫn do tài khoản quyết định.

## 5. Paid-model blocking

- ✅ Whitelist free-tier trong `workers/python/src/story_audio/providers.py` ("Provider trả phí → không bao giờ"); tên provider ngoài policy → lỗi rõ (providers.py:149).
- ✅ Model mặc định: `gemini-3.1-flash-lite` / `deepseek-chat-v3-0324:free` (không có code path sang model trả phí).
- ✅ Hết quota free → worker exit 40 `QUOTA_WAIT` → Node lưu `notBefore` + state `waiting_quota`; không retry spin (rewrite.py:348).
- ✅ Test không gọi mạng live: chỉ chạy khi opt-in `LIVE_TTS=1` / `LIVE_FFMPEG=1` (docs/testing.md).

## 6. Logs

- ✅ Python: sweep `log.*(api_key|token|secret|Authorization)` → 0 dòng.
- ✅ Node: fastify logger (pino) chỉ log method/URL/status/reqId — presigned URL chỉ **return** cho client, không in; ENV_INVALID chỉ in tên field thiếu.
- ⚠️ Prisma error message có thể kèm connection string — password được Prisma mask mặc định; chấp nhận.

## 7. Source rights warning

- ✅ README: khối cảnh báo "Quyền nguồn" — nghe cá nhân, không phân phối, upload YouTube thủ công tự chịu trách nhiệm.
- ✅ Plan §117 ("Respect rights to the source work") + AI_CODING_AGENT_PROMPT rule 9 (no publish; no bypass paywalls).

## 8. No auto-YouTube publishing

- ✅ Không có dependency upload nào (sweep package.json/pyproject: không youtube/googleapis/boto3); pipeline kết thúc ở **export files** (MP4 + thumb + description timestamps) — plan §13/§117, test T7.5 comment "KHÔNG có bước upload YouTube tự động".

## 9. Backup/restore

- ✅ Quy trình 3 tầng (PostgreSQL / R2 / code) tại docs/runbooks/dev-setup.md §8; `docker compose down` giữ volume.

## 10. Known issues (không critical)

1. ~~Claim loop chỉ nhận `queued`/`waiting_quota`...~~ **ĐÃ VÁ (post-plan FF-1):** claim bổ sung `running AND claimed_at IS NULL`; route retry/resume clearClaims (xóa claimed_at + notBefore cũ). Bù lại: runner boot requeueOrphanedJobs giữ nguyên.
2. Orchestrator pipeline được dựng sau plan (FF-1, `apps/api/src/pipeline.ts`): stage `extract→normalize→rewrite→tts→package`, skip-logic theo DB, exit-code mapping. `yt_export` không tự chạy (thủ công như thiết kế).
3. Worker `seq` event giờ LIÊN TỤC QUA CÁC LẦN CHẠY (counter trong workdir —⁠ FF-1); contract `worker-protocol.md` đã cập nhật tương ứng.
4. `dev.ps1` chạy lại `prisma generate` mỗi lần boot (~200ms, vô hại — điều kiện kiểm chưa trùng output dir).
5. Console PowerShell hiển thị mojibake tiếng Việt (display-only; file thật UTF-8 đúng).
6. Corpus regression cũ có mojibake — đã bị QA engine bắt đúng (T9.3: 1 chương flagged).
7. **Post-FF-1 live-find:** site `truyendich.space` chống fetch dồn dập (trang rỗng "0 đoạn"/veil `mystic-cipher` + Cloudflare challenge khi burst). Vá: fetcher curl-fallback khi requests bị chặn (sources.py), extract pacing 2s/chương + resume-skip (không fetch lại chương đã có file). Lưu ý: màn veil xuất hiện NGẪU NHIÊN theo request — job mới nhất có thể dừng needs_review; retry sau khung nghỉ thường qua.
8. Chạy suite API (`npx vitest run`) phải khi dev server TẮT: runner sống poll DB test (cùng DATABASE_URL) → claim job của test và ném JOB_FAILED → flake ngẫu nhiên (đã chứng minh: server tắt = 199/199 xanh). **Và chạy `--fileParallelism=false`** (2026-10-23): chạy song-song-file nhiều file chạm chung DB Postgres test → đụng nhau ngẫu nhiên (bộ test fail ĐỔI KHÁC giữa các lần chạy; sequential = 205/205 xanh).
9. **Post-FF-1 live-find 2 (2026-10-23):** PUT lớn (~20MB mp3) lên R2 bị TLS đứt giữa dòng (`ssl3 alert bad record mac`, 2 lần lặp lại được). Vá: `r2-adapter.ts` multipart S3 tự động ≥8MB (part 5MiB chuẩn R2, retry per-part) + `asset-service.ts` verify bỏ md5 toàn-file cho etag composite (dạng "…-N"); adapter tự verify md5 từng part. Multipart R2 KHÔNG trả etag md5 → verify per-part là mạch bắt lỗi nội dung thật.
10. **Post-FF-1 live-find 3 (2026-10-23):** edge-tts thỉnh thoảng trả rỗng (`NoAudioReceived` cả với text nhỏ — service-side, không sửa được client). Vá: `TTS_RETRIES` 5→8 + cache chunk bền theo (voice, rate, text) → mỗi lần Node retry stage chỉ synth phần còn thiếu. Tail orchestration: rewrite NEEDS_REVIEW(30) giờ ghi tiến độ (DB advance + upload artifact) trước khi park — resume sau đó tái dùng kết quả, không đốt lại quota Gemini (pipeline.ts).

## Sign-off

- Ngày duyệt: **2026-10-23** — duyệt: user (theo quy trình plan task T9.5); tổng hợp bằng chứng: agent.
- Kết luận: **công bố nội bộ dev (v0.1) OK** — không known critical issue; các ⚠️ là khuyến nghị/ngoại lệ đã đánh giá.

## Release notes (v0.1 dev-complete)

- Phase 0–8: adapter nguồn, rewrite Gemini Free, QA engine (6 detector + glossary), TTS edge-tts, R2 riêng tư + presign ngắn hạn, state machine + graceful shutdown + recovery, M4B builder + YouTube export (thủ công), API Fastify (**192 tests**), Web React (**20 tests**), Python worker (**166 passed / 3 skipped**).
- Phase 9: ma trận test tái tạo sạch (T9.1), failure-injection/recovery 4 kịch bản (T9.2), QA offline tập regression 153 phần — 1 chương flagged 2850 (T9.3), launcher một lệnh Windows (T9.4), checklist + release notes này (T9.5).
- Sản phẩm: audio M4B/MP4 chỉ dùng cá nhân; không dịch vụ public, không upload tự động, no microservices/Redis/K8s.
