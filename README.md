# Story Audio (v2 rebuild)

Pipeline audiobook cá nhân chạy local trên Windows: dán URL truyện → tải/chia chương → dịch lại tiếng Việt (Gemini Free) → QA → TTS (edge-tts) → đóng gói M4B (tùy chọn MP4 để upload YouTube thủ công). File thành phẩm lưu trên bucket Cloudflare R2 riêng tư.

> **⚠️ Quyền nguồn:** tool chỉ đọc truyện từ URL người dùng cung cấp cho mục đích **nghe cá nhân**. Không phân phối/thương mại hóa output; upload YouTube (nếu có) là thủ công và người dùng tự chịu trách nhiệm về nội dung + quyền tác giả của nguồn. Tôn trọng rights của tác phẩm gốc (plan §117).

Stack: React + TypeScript + Vite · Node.js + TypeScript + Fastify · PostgreSQL + Prisma · Python worker · FFmpeg/FFprobe · Cloudflare R2.

## Cấu trúc (theo Section 2 của Master Plan)

| Thư mục | Vai trò |
|---|---|
| `apps/web` | Frontend React (chưa scaffold) |
| `apps/api` | Fastify REST API + Prisma + Job Manager (chưa scaffold) |
| `workers/python` | Python worker (`src/story_audio/`, `tests/`) thực hiện extract/rewrite/TTS/packaging |
| `packages/contracts` | JSON schemas / TS types dùng chung API + events |
| `prisma` | Schema + migrations |
| `docs` | `architecture/`, `runbooks/`, Master Plan, prompt cho agent |

## `Audio/` là source cũ — CHỈ ĐỌC

`Audio/` là bộ source Python cũ (bản giải nén từ Audio.rar) dùng làm tham chiếu. **Không sửa, không xóa; không copy output/cache/`.venv`/`.git` của nó vào project mới** (Xem §1, §3.9, API prompt rule 6–7).

## Trạng thái công việc

Backlog task chạy theo thứ tự tại `docs/STORY_AUDIO_MASTER_PLAN.md` — chỉ hoàn thành 1 task mỗi iteration.
