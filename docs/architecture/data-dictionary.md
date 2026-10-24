# Data dictionary — schema v1 (T2.3)

Nguồn sự thật: `apps/api/prisma/schema.prisma`. Migration: `20261022093236_data_schema`.

## ERD (ASCII — 1 job và các con của nó)

```
Job 1──N Chapter          (jobs.id ← chapters.job_id, ON DELETE CASCADE)
Job 1──N Asset            (jobs.id ← assets.job_id,  CASCADE)
Job 1──N BookPackage      (jobs.id ← book_packages.job_id, CASCADE)
Job 1──N JobEvent         (jobs.id ← job_events.job_id, CASCADE)

Chapter 1─0..1 Asset (text, chapter_text ptr: chapters.text_asset_id → assets.id, UNIQUE, SET NULL)
Chapter 1─0..1 Asset (audio, chapter_audio ptr: chapters.audio_asset_id → assets.id, UNIQUE, SET NULL)
Chapter 1──N Asset   (chapter_assets: assets.chapter_id → chapters.id, CASCADE)
Chapter 1──N JobEvent (job_events.chapter_id → chapters.id, SET NULL)

BookPackage 1──N Asset (package_assets: assets.package_id → book_packages.id, CASCADE)
```

## Bảng

### jobs — 1 lần xây 1 cuốn sách audio
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | text PK, cuid | |
| source_url | text | URL gốc của truyện |
| adapter | text | id adapter nguồn (`webnovel-vn-#chapter-c`, `truyendich-space` — xem source-audit §3) |
| state | JobState, default `queued` | state machine cứng sẽ chặn transition ở T2.5 |
| config_snapshot | jsonb, default `{}` | manifest gốc Node cấp cho worker (protocol T1.3) |
| chapters_per_book | int, default 20 | quy mô 1 book package |
| not_before | timestamptz? | QUOTA_WAIT: đóng băng tới thời điểm này (event protocol `quota_wait`) |
| last_error | text? | lỗi gần nhất — render UI + báo user |
| started_at / ended_at | timestamptz? | run window |
| created_at / updated_at | timestamptz | now() / @updatedAt |
| Index | (state, created_at) | hàng đợi "job đang chờ" |

### chapters — 1 chương
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | text PK | |
| job_id | text FK → jobs, CASCADE | |
| index | int | thứ tự trong book; **UNIQUE (job_id, index)** |
| title | text | |
| source_url | text | URL chương |
| stage_state | ChapterStage, default `discovered` | pipeline §7 |
| review_state | ReviewState, default `none` | NEEDS_REVIEW khóa TTS/packaging |
| text_asset_id | text? FK, UNIQUE → assets | con trỏ asset text "active" (SET NULL) |
| audio_asset_id | text? FK, UNIQUE → assets | con trỏ asset audio "active" (SET NULL) |
| Index | (job_id, stage_state) | lọc chương theo stage khi retry |

### assets — 1 file/nội dung (text, audio, m4b...)
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | text PK | |
| job_id | text FK → jobs, CASCADE | |
| chapter_id | text? FK → chapters, CASCADE | null = asset cấp job/package |
| package_id | text? FK → book_packages, CASCADE | |
| kind | AssetKind | |
| object_key | text | key trên R2 — chống path escape theo pattern workdir (T1.4) |
| content_type | text | MIME |
| size | int, default 0 | byte |
| sha256 | text? | checksum hex — khớp `artifact_ready.checksum` |
| verified | bool, default false | đã kiểm tra size/checksum sau upload |
| fingerprint | text? | fingerprint trùng lặp (dedup) |
| Constraint | **UNIQUE (chapter_id, kind)** | mỗi chapter 1 asset/kind; chapter_id NULL (asset job/package) không bị chặn |
| Index | (job_id, kind), (chapter_id) | |

### book_packages — 1 file sách đầy đủ (1.000 chương → ~50 package)
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | text PK | |
| job_id | text FK → jobs, CASCADE | |
| sequence | int | **UNIQUE (job_id, sequence)** |
| start_chapter / end_chapter / chapter_count | int | range 1-based đóng |
| grouping_snapshot | jsonb, default `{}` | snapshot grouping tại lúc tạo |
| state | PackageState, default `pending` | |
| Index | — | |

### job_events — luồng event persist theo chuẩn protocol (T1.3)
| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | text PK | |
| job_id | text FK → jobs, CASCADE | |
| chapter_id | text? FK → chapters, SET NULL | |
| seq | int | **UNIQUE (job_id, seq)** — lỗ seq = event mất, phát hiện replay |
| event_type | JobEventType | |
| message | text? | |
| data | jsonb? | payload phụ |
| created_at | timestamptz, now() | |
| Index | (job_id, created_at) | tail log |

## State machine (T2.5) — bảng transition hợp lệ

Nguồn: `apps/api/src/state-machine.ts`. idempotent: same→same là no-op (replay an toàn).
Ngoài bảng → `InvalidTransitionError` — KHÔNG âm thầm ghi.

**Job**
| từ | được phép đi |
|---|---|
| queued | running, canceled |
| running | waiting_quota, needs_review, failed, completed, canceled |
| waiting_quota | running, failed, canceled |
| needs_review | running, canceled |
| failed | queued (retry), canceled |
| canceled / completed | — (terminal) |

**Chapter (pipeline §7)**
| từ | được phép đi |
|---|---|
| discovered | downloaded, failed |
| downloaded | normalized, failed |
| normalized | rewritten, failed |
| rewritten | qa_passed, failed |
| qa_passed | tts_done, failed |
| tts_done | verified, failed |
| verified / failed | — (terminal) |

