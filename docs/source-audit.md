# Source audit — baseline report (T0.4)

Ngày: 2026-10-22 · Nguồn: `Audio/` (bản giải nén Audio.rar, read-only). Tài liệu này chỉ **đoán được sau khi đã đọc hết** 3 module + 8 file test. **Không chạy live Gemini/TTS, không crawl, không đọc `Audio/.env`.**

## 1. Kiểm kê

| File | Kích thước | Vai trò |
|---|---|---|
| `truyen_audio.py` | ~540 dòng | Crawler webnovel.vn (URL `chuong-N`) + TTS edge-tts + concat mp3 + CLI |
| `tai_nguon.py` | 126 dòng | TảI text bản convert truyendich.space (`section.prose-novel`) |
| `viet_lai.py` | ~430 dòng | Viết lại tiếng Việt bằng LLM Gemini free (+OpenRouter free dự phòng) |
| `tests/` | 8 file | Tất cả offline — mock/monkeypatch, không network |
| `requirements.txt` | — | **chưa pin version**: requests, beautifulsoup4, edge-tts, pytest |
| Assets giữ lại | — | `glossary.json` (~97 mục), `replace.json`, `glossary_de_xuat.json`, `README.md`, `PLAN.md`, `PLAN3.md`, `Huongdan.html`, `tests/fixtures/*.html` |

### 2 source adapter (duy nhất, không đoán thêm)
1. **webnovel.vn** — selector `#chapter-c`, tiêu đề `.reader__chapter`, link "Chương sau"; phát hiện khoá qua marker `"Đăng nhập để đọc ngay"`/`"Click để xem"` + độ dài < 200 ký tự → dừng rõ ràng, không vượt paywall.
2. **truyendich.space** — URL `/doc-truyen/<loại>/<slug>/chuong-N`; selector `section.prose-novel`; lọc rác ("Cảm tạ thư hữu", dòng chỉ dấu chấm hỏi…), tối thiểu 3 đoạn/cương.

## 2. Hàm tái sử dụng (per module)

### truyen_audio.py
| Hàm | Định mức |Task mới |
|---|---|---|
| `fetch_html` (retry 3 lần, UA headers, ép UTF-8, backoff tuyến tính) | Giữ, mở rộng phân loại lỗi | T1.3/T5.1 |
| `parse_chapter_url`, `chapter_url`, `novel_slug`, `extract_chapter` | **Giữ nguyên selector** (đã test bằng fixture) | T5.1 |
| `normalize` (thay thế theo độ dài giảm dần + gộp khoảng trắng) | Giữ | T5.2 |
| `split_sentences`, `_split_oversized`, `chunk_text(max_chars=1500)` | Chunk có chốt ~ranh giới câu; phục vụ TTS | T6.1 |
| `tts_chunk_hash` (sha256 voice+rate+text) | Cơ sở cache key; phải thêm fingerprint prompt/config | T6.1 |
| `_tts_one` (ghi `.tmp` → `replace` atomic, retry mũ 2 min 30s, từ chối file rỗng), `_synthesize_async`/`synthesize` (semaphore concurrency 3, cache `_tts_cache/`) | Lõi TTS giữ refactored | T6.1/T6.2 |
| `concat_mp3` (ffmpeg concat qua file list, path escape; fallback byte) | Giữ cho regression; M4B viết mới | T7.3 |
| `save_text`, `discover_chapters` (đoán khoảng thiếu giữa), `load_chapter_file` (dòng 1 = tiêu đề) | Định dạng txt chuẩn giữ lại | T5.2 |
| `main()` hai chế độ (URL crawl / `--input-dir` local không mạng) | Tách thành job actions của worker | T1.2 |

### tai_nguon.py
| Hàm | Ghi chú | Task |
|---|---|---|
| `parse_nguon_url`, `extract_chapter_td` | Giữ nguyên logic lọc | T5.1 |
| Vòng lặp: skip file tồn tại, min 3 đoạn, dừng sau 3 lỗi liên tiếp, ghi atomic tmp→replace | Pattern chuyển thành per-chapter stage | T5.1 |

### viet_lai.py
| Hàm | Ghi chú | Task |
|---|---|---|
| `PROMPT_VERSION`, `TEMPERATURE=0.3`, `split_parts(min 1000/max 1800)` | Giữ khung; **giant paragraph không bị tách** (ngược T5.4) | T5.3/T5.4 |
| `build_prompt` (biên tập viên tiếng Việt; glossary; `prev_tail` = 3 câu cuối cho liên tục xưng hô) | Giữ nguyên thư; đưa sau provider interface | T5.3 |
| `glossary_subset` (chỉ mục xuất hiện trong chunk), `load_glossary` | Giữ; cần version hoá vào cache fingerprint | T5.5 |
| `validate()` (rỗng; tỉ lệ dài 0.7–1.3; thiếu thuật ngữ — check giá trị thay thế, không check dạng gốc; `BAD_LEADINS`; ngoặc thoại lệch ±25%) | Cốt lõi QA; **thiếu**: CJK còn sót, prompt leakage, 【】 lặp lại, đoạn lặp/truncation | T5.6 |
| `cache_key` (sha256 version+part+subset) + `load_cache`/`save_cache_entry` | Giữ khung; **cache write chưa atomic**, cache hit chưa re-QA | T5.8 |
| `LLMClient.complete` (backoff mũ 2 từ 10s, 4 vòng, `RateLimited`/`BackendError`, fallback gemini→openrouter) + `gemini_complete`/`openrouter_complete` | Giữ phân loại; **429/chưa persist `notBefore`**, fallback giữa provider phải thành policy kiểm soát | T5.7 |
| `suggest_glossary` + `_parse_json_reply` (bóc code fence) | Giữ như công cụ hỗ trợ thủ công | đã có |
| `dry_run_stats` — đếm request dự kiến vs cache | Bảo tồn làm cost guard | T5.3 |
| `load_env_file` (dotenv tối thiểu, tôn trọng env có sẵn) | Giữ cho worker cho tới khi Node quản config | T1.2 |

## 3. Gaps → đối chiếu rủi ro của Master Plan §1

| Rủi ro plan | In evidence ở source cũ |
|---|---|
| #1 CWD-dependent paths | `main`/`run_from_dir` đều ghi `Path("audio")/slug`, `nguon`, `viet_lai` tương đối |
| #2 Cache-hit validation yếu | mp3 skip khi `exists and size>0`; txt cache không xác minh |
| #3 Rewritten text dùng lại không QA | `rewrite_part` cache hit trả về luôn mà không chạy `validate` lại |
| #4 Chunking cần chốt biên | Có sẵn `chunk_text` (TTS); `split_parts` lại để nguyên huge paragraph |
| #5 Retry không phân loại sâu | 429 vs HttpError đã tách 2 class nhưng chưa phân rate-limit/ngày/từ-hết-key |
| #6 Failure path thành "thành công" | `--no-rewrite` copy bản gốc tới output như kết quả bình thường; rewrite fail giữ "bản gốc" và chỉ log file |
| #7 Worker cần exit code + event protocol | `main()` in stdout tự do, chưa có JSONL, exit code không hoá chuẩn, webnovel path trả None |

**Component bị thiếu (không nằm trong archive):** `gop_audio.py`, `tao_video.py` chỉ được nhắc trong `PLAN3.md` — **không có file thật**; không có Node API, PostgreSQL/Prisma, R2 adapter, M4B/chapter markers, thumbnail/MP4, storage budget, SSE.

## 4. Trạng thái test cũ — **đã xác minh trong buổi này, không dùng số cũ**

- Chạy bằng venv cũ (3.12, pytest 9.1.1): `Audio\.venv\Scripts\python.exe -m pytest tests -q -p no:cacheprovider` tại `Audio/`, biến `PYTHONDONTWRITEBYTECODE=1` → không ghi file rác vào archive.
- **Kết quả: 61/62 passed, 1 failed** (`test_input_dir.py::test_tts_loop_creates_mp3_and_skips_on_rerun`).
- Chẩn đoán failure: **test stale, không phải bug code cũ** — fake `synthesize(chunks, voice, rate, tmpdir, concurrency=3)` trong test thiếu `cache_dir`, trong khi code thật đã truyền `cache_dir=` từ khi thêm cache mp3 bền vững. Bỏ qua vì sao v2 phải refactor: sẽ viết lại toàn bộ khuôn khổ test trong T1.x/T9.x chứ không vá test test cũ.
- Process vai trò: kế thừa `requirements.txt` phải pin version ở T1.1.
- Test cũ viết offline bằng mock — hoàn toàn hợp lệ với policy mock/fixture của v2 (§3.10).

## 5. Chính sách reuse (cho T1.x+)

1. **Copy logic có chọn lọc**: selector/extractor, chunker, hash cache, atomic write, REUSE pattern skip-existing → đưa vào `workers/python/src/story_audio/` và cover lại bằng test mới.
2. **Không copy**: vòng lặp CLI main (rejat thành CLI per-job của T1.2), CWD-relative paths (T1.4), cache validation yếu (T5.8/T6.2), retry client nguyên trạng (T5.7), `--no-rewrite` chống lại NEEDS_REVIEW (T5.6).
3. **Assets đưa vào tree mới (vẫn giữ bản gốc đọc-only):** `glossary.json`, `replace.json`, `tests/fixtures/*.html` → `workers/python/tests/fixtures/` ở T5.1.
4. Tuyệt đối: không di chuyển/copy output cũ (cache/audio/text đã sinh), không copy `.venv`, không mở `Audio/.env`.
