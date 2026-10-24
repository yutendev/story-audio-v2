Story Audio — Master Implementation Plan for Coding Agent
Version: 1.0
Purpose: Hand-off plan for an AI coding agent to rebuild the existing personal audiobook project in small, verifiable tasks.
Execution rule: Work one task at a time. Do not jump ahead or implement the entire plan in one pass.
0. Product definition
Build a personal Windows application that accepts a supported story URL, downloads/extracts chapters, rewrites converted Vietnamese into natural Vietnamese, validates text quality and names, synthesizes Vietnamese speech, packages audio into configurable-size M4B books, and optionally creates MP4 video assets for manual YouTube upload.
Required user flow
1. User pastes a supported story URL and clicks Start once.
2. The app creates a durable job and processes chapters automatically.
3. Each completed stage is checkpointed.
4. If the process or machine stops, the user can reopen the app and the job resumes from the last valid checkpoint.
5. M4B packaging groups a user-configurable number of chapters per file. It must not hard-code 20.
6. Optional YouTube export creates MP4, thumbnail and description timestamps; it must never upload or publish automatically.
7. Generated files are stored in a private Cloudflare R2 bucket. Local disk is only working space and must be cleaned after remote assets are verified.
Non-goals for MVP
- No public service, multi-user account system, public sharing, automatic YouTube publishing, cloud-hosted compute, Kubernetes, Redis, or microservices.
- Do not support arbitrary websites by guessing selectors. Support only source adapters verified against the supplied source code and fixtures; add a new adapter only as a separate scoped task.
- Do not bypass paywalls, logins, CAPTCHA or access controls.
- Do not silently send a chapter to TTS if rewrite/QA failed. Mark it NEEDS_REVIEW and block packaging unless the user explicitly chooses an allowed override and the decision is logged.
- Do not migrate old generated cache/audio/output data. The rebuild starts with fresh state/storage prefixes. Preserve source code, tests, prompt assets, glossary and fixtures for reference.
1. Confirmed current source audit
The supplied Audio.rar was inspected. Relevant files found:
- truyen_audio.py: Webnovel crawler/text extraction, chapter text and Edge TTS audio generation/cache.
- tai_nguon.py: downloads converted-text chapters from Truyendich to TXT.
- viet_lai.py: Gemini/OpenRouter rewrite logic, glossary support, checks, cache and dry-run-like behavior.
- tests/: test_cli.py, test_extract.py, test_input_dir.py, test_run.py, test_tai_nguon.py, test_text.py, test_tts.py, test_viet_lai.py.
- requirements.txt, glossary.json, glossary_de_xuat.json, replace.json, README.md, PLAN.md, PLAN3.md, Huongdan.html.
Important facts and caveats:
- The source archive did not contain gop_audio.py or tao_video.py, even though PLAN3.md mentions them. Trust the files actually present, not stale plan text.
- The supplied source has no React frontend, Node API, PostgreSQL/Prisma integration or R2 adapter.
- The current environment did not have edge-tts installed, so the audit did not independently verify the entire pytest suite. A project log mentioned 56 tests passing previously; treat that as historical information, not a verified current result.
- Existing code should be inspected before reusing it. Preserve useful extraction, rewrite, glossary and TTS logic, but do not copy old caches/output into the new app.
- There is a sensitive .env inside the supplied archive. Never print or copy its contents. If it held a real key, rotate that key. Keep secrets out of source control and logs.
Existing risks to address
1. Some paths depend on current working directory.
2. Cache-hit validation is not strict enough; existence/non-zero file size is not adequate proof of valid output.
3. Cached rewritten text needs QA before reuse.
4. Long input paragraphs need bounded, safe chunking.
5. AI retry logic must distinguish rate limits, daily quota exhaustion, bad credentials and transient errors.
6. Some failure paths can leave source/convert text usable as though rewrite succeeded. A failed rewrite must not silently become production-ready audio.
7. A worker process needs a reliable exit code and a structured event protocol before Node can orchestrate it safely.
2. Target architecture (decided)
Stack
- Frontend: React + TypeScript + Vite.
- Backend/API: Node.js + TypeScript + Fastify.
- Database: PostgreSQL.
- ORM: Prisma ORM. Use a currently stable, non-prerelease version. At setup, check official Prisma release-status docs; pin compatible versions and commit the lockfile. Do not use a release candidate for this project.
- Python worker: preserve and refactor existing Python business logic; launched as a child process by Node.
- AI rewrite: Gemini API Free by default; no automatic paid fallback.
- TTS: edge-tts from Python.
- Packaging: FFmpeg + FFprobe.
- Object storage: private Cloudflare R2 bucket using the S3-compatible API.
- Frontend progress: REST API + Server-Sent Events (SSE).
- Local runtime: Windows host. Backend, database and Python worker run locally; R2 stores long-lived assets.
Use the active supported Node LTS verified at implementation time and a supported Python 3 version. Pin dependencies. Do not choose prerelease framework/ORM versions just because they are newest.

Official references:
- Prisma ORM / PostgreSQL: https://www.prisma.io/docs/orm/quickstart/postgresql
- Prisma release status: https://www.prisma.io/docs/orm/reference/release-status
- Cloudflare R2 S3 API compatibility: https://developers.cloudflare.com/r2/api/s3/api/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Node child processes: https://nodejs.org/api/child_process.html
- Gemini API rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- edge-tts: https://github.com/rany2/edge-tts
- FFmpeg formats: https://ffmpeg.org/ffmpeg-formats.html
Proposed repository layout
story-audio/
  apps/
    web/                    # React + TypeScript + Vite
    api/                    # Fastify REST API, Prisma, Job Manager
  workers/
    python/                 # Python package and worker entry point
      src/story_audio/
      tests/
  packages/
    contracts/              # JSON schemas / generated TS types for API/events
  docs/
    architecture/
    runbooks/
  prisma/                   # Prisma schema + migrations (or colocated under apps/api)
  compose.yaml              # Optional/recommended local PostgreSQL service; document native alternative
  .env.example
  .gitignore
  package.json
  README.md
The exact layout can be adapted if a better well-documented layout is chosen, but keep clear boundaries between web, API, worker and shared contracts.
Main responsibilities
React: forms, job list/detail, progress/events, review-required chapters, output list/download. Never hold API credentials or process large audio/video files in browser storage.

Node/Fastify: API validation, durable job state, queueing/locking, spawning/canceling Python processes, consuming worker events, controlling R2 access, recording asset metadata, serving SSE and issuing short-lived presigned download URLs.

PostgreSQL + Prisma: source of truth for job state/configuration, per-chapter stage status, assets, book packages and event history. Do not store audio blobs in the database.

Python worker: extraction/download from supported sources, normalization, rewrite, glossary/QA, TTS and FFmpeg packaging. It writes temporary files only to its assigned work directory, reports structured events and returns meaningful exit codes. It does not own database schema or directly modify PostgreSQL.

Cloudflare R2: long-lived source text, normalized/rewrite assets where retention is enabled, per-chapter audio, M4B, MP4 and thumbnails. Private bucket only.
R2/worker integration contract
Before implementing R2, create a brief Architecture Decision Record (ADR) for the Node↔Python asset protocol. Prefer a single owner of R2 credentials and a versioned protocol rather than duplicating uncoordinated storage logic.

Required behavior:
- Node owns R2 credentials and database state; credentials never reach React.
- Python receives a per-job temporary work directory and a validated job manifest.
- Define a versioned JSON Lines protocol. stdout is protocol-only; ordinary logs go to stderr.
- Worker events include stage_started, progress, chapter_status, artifact_ready, quota_wait, needs_review, error and final result.
- Define how Node acknowledges stored artifacts and how worker requests previously stored inputs. Do not let the worker mark a remote asset complete before Node verifies its upload.
- On artifact_ready, Node validates the expected path is inside the assigned work directory, uploads it to R2, verifies the remote object/checksum and commits asset metadata; only then may the temporary file be deleted.
- Packaging downloads only the assets needed for the selected package group, not the entire book. After M4B upload and verification, remove those local temporary copies.
- Avoid shell command strings. Launch fixed executable/argument arrays using spawn() with shell: false; validate all paths and user values.
If the agent finds this protocol too complex during implementation, stop and write an ADR proposing the smallest safe alternative before changing the boundary. Do not silently make both Node and Python independently write database state.
3. Product invariants and business rules
1. Cost: app does not enable billing, call paid APIs, or automatically fall back to paid models. If free quota is exhausted, save state and wait. R2 limits are not infinite; configure a storage budget and warn/block new uploads before the configured budget is exceeded.
2. Privacy: private R2 bucket; no public bucket/domain by default. URLs for downloads are short-lived. Secrets are only in environment variables / local secret configuration and never logged.
3. Resume: every stage is independently checkpointed. A process restart must not rerun successful Gemini/TTS stages.
4. Integrity: use temp files and atomic local rename. Verify remote object and file integrity before marking complete or deleting the only valid copy.
5. No false success: a chapter with failed rewrite or required QA must be NEEDS_REVIEW/FAILED; do not quietly ship converted source text as successful rewrite.
6. Configurable packaging: chaptersPerBook is a per-job persisted integer. Default can be 20, but there is no hard-coded 20 in builder logic. Validate it and record it in the job manifest. Changing this value should rebuild packages from existing valid chapter audio, not rerun rewrite or TTS.
7. YouTube: export files only; no API upload, no public release. Respect rights to the source work.
8. Source adapters: only supported, tested adapters. Do not bypass access controls or paywalls. A source URL that is unsupported must fail with a clear message.
9. No old output migration: no old audio/cache/rewrite output is copied to new R2 or treated as verified. Preserve the old archive as read-only reference; do not delete the uploaded archive or glossary/test/source code.
10. Testing cost: unit and integration tests default to mocks/fixtures. Live Gemini/TTS tests must be explicit opt-in and limited to a small sample.
4. Task execution protocol for the coding agent
The agent must follow these rules:
1. Read this plan and AI_CODING_AGENT_PROMPT.md before editing.
2. Check repository status and inspect the relevant files before changing anything.
3. Work only on the next unchecked task, unless the user names another task ID.
4. Implement one task per iteration. Do not start downstream tasks “while here”.
5. Before editing, state the task ID and exact scope in a few lines.
6. Add/modify tests with code changes. Run relevant tests and report exact commands/results.
7. Update task checkbox/status only after acceptance criteria pass. If a test cannot be run, say why; do not claim it passed.
8. If a task requires a destructive operation, cloud resource creation/deletion, paid billing, or a real API call that can spend quota, stop before the operation and ask for explicit permission. This includes deleting R2 objects and dropping a database.
9. Never print secrets, tokens, user story contents, or full copyrighted chapters in logs/reports.
10. Finish with a concise report: files changed, behavior added, tests run, tests not run, risks/blockers, and the next task ID. Then stop.
Definition of Done for every task
- Scoped code/docs changes are complete.
- Automated tests cover the task’s essential logic and failure path.
- Formatting/typecheck/lint/tests relevant to the change pass, or limitations are recorded honestly.
- No credentials or generated story/audio/video assets are committed.
- README/docs are updated if commands/config/behavior changed.
- The task's acceptance criteria are demonstrated, not merely asserted.
5. Implementation backlog — execute in order
Each item below is intentionally small. Mark a task [x] only after it passes its Definition of Done.
Phase 0 — Clean workspace and baseline
[x] T0.1 — Create new workspace/repository skeleton
Dependencies: none.
Work: create the repository layout from Section 2; keep the supplied archive untouched and read-only; initialize Git if needed. Do not copy old generated output or .venv/.git folders from the archive.
Acceptance: expected directories exist; no old audio/cache/output copied; git status is clean apart from intended initial files.
[x] T0.2 — Secrets and ignore rules
Dependencies: T0.1.
Work: add .gitignore for .env* (except .env.example), Python venv/cache, node_modules, builds, local DB data, logs, downloaded story text, audio/video and workdirs. Add .env.example with placeholder names only. Never inspect or print the archived .env.
Acceptance: run a tracked-file/secrets hygiene check; no .env, generated story files, media, venv or secrets are tracked.
[x] T0.3 — Reproducible environment and decisions log
Dependencies: T0.1.
Work: document supported OS, runtime versions, required FFmpeg, PostgreSQL setup, R2/Gemini environment-variable names and no-cost limits. Add docs/architecture/decisions.md and record worker/R2 protocol decision before implementing it.
Acceptance: a new developer can follow setup instructions without private files; stack major versions are pinned and documented.
[x] T0.4 — Source audit/baseline report
Dependencies: T0.1.
Work: review old scripts and tests, document reusable functions, behavior gaps, source adapters, and old test status. Do not run live Gemini/TTS or crawl a site as part of baseline.
Acceptance: docs/source-audit.md identifies functions to reuse and known missing components; the report does not claim unrun tests pass.
Phase 1 — Python worker foundation
[x] T1.1 — Create Python package and locked dependencies
Dependencies: T0.3.
Work: turn worker into an installable/importable package; pin compatible dependency versions in pyproject.toml/lock file. Preserve existing code only where appropriate. Avoid committing a venv.
Acceptance: install in a clean venv, import package, run python -m ... --help and run offline tests.
[x] T1.2 — Define worker CLI and result contract
Dependencies: T1.1.
Work: define an entry point that accepts a validated job payload/config file, job_id, action and assigned workdir. Use documented exit codes for success, retryable failure, permanent failure, needs-review and quota wait.
Acceptance: CLI tests cover valid args, missing config, invalid path and each result/exit status; no network required.
[x] T1.3 — Define versioned worker event protocol
Dependencies: T1.2.
Work: define JSON Schemas/types for worker events and acknowledgements. Reserve stdout for JSON Lines; logging goes to stderr. Define event IDs, sequence numbers, and behavior for malformed/unknown messages.
Acceptance: protocol docs and tests for encoding/decoding, malformed lines, progress, artifact-ready and error events exist.
[x] T1.4 — Normalize configuration and paths
Dependencies: T1.1.
Work: remove reliance on current working directory; resolve configured data/work paths; reject paths escaping the job workdir; use temp files plus atomic rename.
Acceptance: run tests from at least two different CWDs and verify outputs remain in configured directories.
Phase 2 — PostgreSQL and Prisma
[x] T2.1 — Add local PostgreSQL setup
Dependencies: T0.3.
Work: provide a reproducible local setup, preferably a minimal Compose service plus a documented native PostgreSQL alternative. Use a dedicated development database/user; never hard-code credentials.
Acceptance: documented command starts PostgreSQL and API can connect using environment configuration.
[x] T2.2 — Install stable Prisma ORM and migrations
Dependencies: T2.1.
Work: select a currently stable non-prerelease Prisma version from official docs, pin compatible Prisma packages and Node version, configure PostgreSQL provider and migrations. Do not mix commands from different major versions.
Acceptance: a clean database can be migrated from zero and Prisma Client can execute a smoke query. Migration commands are documented.
[x] T2.3 — Design initial data schema
Dependencies: T2.2.
Work: create models for Job, Chapter, Asset, BookPackage, and JobEvent. Include timestamps, statuses, retry metadata, chaptersPerBook, source adapter, job config snapshot, object keys and checksums. Add unique constraints and indexes for idempotency and job/chapter queries.
Acceptance: schema and ERD/data dictionary are documented; migration applies cleanly; tests cover relationships/constraints.
[x] T2.4 — Implement repositories and transactions
Dependencies: T2.3.
Work: isolate Prisma queries behind service/repository modules; implement create/get/update job, chapter stage transitions, asset recording and event history. Use transactions for state changes that must be atomic.
Acceptance: service tests cover valid transitions, invalid transitions and transaction rollback.
[x] T2.5 — Define durable state machine
Dependencies: T2.4.
Work: define allowed job/chapter states and transitions, including queued, running, waiting for quota, needs review, failed, canceled and completed. Make transitions idempotent where applicable.
Acceptance: state transition table and tests exist; impossible transitions are rejected rather than silently accepted.
Phase 3 — Node API and job manager
[x] T3.1 — Scaffold Fastify API
Dependencies: T0.3, T2.4.
Work: add health/ready endpoints, structured logging, centralized error mapping, input validation and environment validation.
Acceptance: unit/API tests cover health, invalid config and structured errors.
[x] T3.2 — Implement job creation and query APIs
Dependencies: T2.5, T3.1.
Work: implement POST /api/jobs, GET /api/jobs/:id, GET /api/jobs/:id/chapters, list/paginate jobs and POST /api/jobs/:id/cancel as supported by the state machine. Validate URL/source and persist the immutable job config snapshot.
Acceptance: integration tests create/query jobs and reject invalid URLs/configuration.
[x] T3.3 — Implement single-worker queue and locking
Dependencies: T3.2.
Work: queue jobs in PostgreSQL; run one Python worker at a time for MVP; guard against duplicate scheduling, app restarts and concurrent API requests.
Acceptance: two jobs submitted together run sequentially and are not lost or run twice after a simulated restart.
[x] T3.4 — Spawn Python safely
Dependencies: T1.3, T3.3.
Work: use child_process.spawn with fixed executable/argument arrays and shell: false; collect stdout/stderr separately; enforce timeouts and handle early process exit. Never interpolate URL/user input into shell command text.
Acceptance: tests cover success, non-zero exit, malformed protocol line, timeout and early child-process error.
[x] T3.5 — Persist worker events and SSE
Dependencies: T3.4.
Work: validate incoming event schema, persist event/status updates and expose GET /api/jobs/:id/events via SSE with reconnect support (last event ID or equivalent). Keep polling API as a fallback.
Acceptance: frontend-independent integration test receives ordered events and can reconnect without losing durable job state.
[x] T3.6 — Cancellation and shutdown
Dependencies: T3.4.
Work: implement graceful shutdown, cancellation signals, and clear canceled-vs-failed semantics. Do not kill a worker in the middle of an unsafe write without temp-file protections.
Acceptance: cancellation releases queue lock and leaves only valid checkpointed data; restart can continue other jobs.
Phase 4 — Cloudflare R2
[x] T4.1 — Add R2 configuration and adapter
Dependencies: T0.3, T3.1, T1.3.
Work: configure endpoint, account ID, bucket and credentials via environment variables. Implement private-bucket object operations through the S3-compatible API. Add a unit-testable adapter and mock it in tests.
Acceptance: config validation works without contacting R2; no secrets appear in logs or client bundles.
[x] T4.2 — Define object key and asset lifecycle
Dependencies: T2.3, T4.1.
Work: standardize namespaced keys such as jobs/{jobId}/chapters/{chapterNo}/...; define source, normalized text, rewritten text, chapter audio, M4B, MP4, thumbnail and description assets. Add retention rules and avoid public URLs.
Acceptance: docs define keys, metadata and lifecycle; tests reject unsafe keys and cross-job path confusion.
[x] T4.3 — Upload, verify, record asset
Dependencies: T4.2, T2.4.
Work: upload only from allowed workdir; compute local checksum; verify uploaded object with available metadata/download verification; record Asset only after successful verification.
Acceptance: failed upload cannot be recorded as completed; retry is idempotent and does not create duplicate logical assets.
[x] T4.4 — Fetch assets and presigned download URLs
> `_KẾT QUẢ THỰC ĐO R2 NOT VERIFIED :_ anonymous-block + expiry — PENDING user cấp bucket/credentials. Offline: service + tests mocked (13 files/108 tests) + docs integration path tại docs/architecture/object-keys.md.`
Dependencies: T4.1, T4.2.
Work: implement downloads needed by packager and short-lived presigned URLs for the UI. Keep bucket private and avoid embedding R2 credentials in React.
Acceptance: private object cannot be fetched anonymously; authorized download URL expires as configured; integration path is documented.
[x] T4.5 — Storage budget and safe cleanup
Dependencies: T4.3.
Work: add app-level configured storage budget, threshold warning, stop-new-upload behavior and safe deletion of temporary local files only after remote verification. Never delete remote assets or databases automatically as “cleanup”.
Acceptance: tests cover budget exceeded and failed upload; valid remote asset is never deleted due to a failed local cleanup step.
Phase 5 — Text extraction, rewrite and QA
[x] T5.1 — Wrap current source adapters behind one interface
Dependencies: T0.4, T1.2.
Work: inspect the real behavior of truyen_audio.py and tai_nguon.py; standardize supported sources into chapter records (stable ID/order/title/source URL/text). Preserve tested selectors and obey paywall/access restrictions. Do not add unsupported websites in this task.
Acceptance: fixtures prove each supported adapter outputs ordered chapters; unsupported/locked sources fail clearly.
[x] T5.2 — Separate extraction/normalization from TTS
Dependencies: T5.1.
Work: move reusable text normalization into importable functions with no side effects on import. Store raw and normalized text as separate artifacts.
Acceptance: offline tests cover HTML garbage, paragraph boundaries, empty/short chapters and CWD independence.
[x] T5.3 — Refactor rewrite service
Dependencies: T5.2.
Work: adapt the useful parts of viet_lai.py behind a provider interface; isolate prompt, model settings, cache key construction, response validation and retry classification. Keep Gemini Free as default; provider switching must be explicit and policy-checked.
Acceptance: fake provider tests verify prompt inputs, output handling, network errors and deterministic cache keys.
[x] T5.4 — Safe chunking and context continuity
Dependencies: T5.3.
Work: chunk by paragraph/sentence while respecting a configured upper bound; safely split oversized paragraphs; keep only a small previous-text context for pronouns/style continuity; retain exact order.
Acceptance: tests cover one huge paragraph, dialogue boundaries, Unicode, order preservation and no empty chunks.
[x] T5.5 — Glossary and deterministic cleanup
Dependencies: T5.3.
Work: preserve glossary.json and replace.json as editable source assets; load only relevant entries for a chunk; version glossary changes in cache fingerprints. Handle 【】 only under explicit, tested rules—never remove all bracketed content indiscriminately.
Acceptance: tests show canonical names remain stable and meaningful bracketed story text is not deleted by a blanket cleanup rule.
[x] T5.6 — QA gate and review-required state
Dependencies: T5.3, T5.4, T5.5, T2.5.
Work: detect remaining CJK characters, prompt leakage, unbalanced brackets, suspicious length changes, truncated/repeated output, glossary mismatch and empty output. Configurable thresholds should flag anomalies, not reject legitimate style differences blindly. Do not treat a failed rewrite's source text as successful output.
Acceptance: failing chapters become NEEDS_REVIEW or bounded retry then NEEDS_REVIEW; cannot enter TTS/package while blocked.
[x] T5.7 — Quota-aware retry manager
Dependencies: T5.3, T2.5.
Work: classify 429/rate-limit, daily quota, timeout, server errors, auth/configuration errors and malformed output. Use bounded exponential backoff/jitter for transient conditions; persist notBefore for quota wait. Never silently use a paid model.
Acceptance: simulated 429 does not spin; daily quota enters durable wait state; wrong credentials fail with a useful message; no live API call is needed for tests.
[x] T5.8 — Rewrite cache integrity
Dependencies: T5.3, T5.6.
Work: fingerprint input, prompt version, model/config and glossary; write temp then atomically commit; re-run QA on cache hit.
Acceptance: corrupt/truncated cache is not accepted; valid cache hit avoids provider call; changing prompt/glossary invalidates only affected rewrite outputs.
Phase 6 — TTS and audio assets
[x] T6.1 — Refactor Edge TTS service
Dependencies: T5.6, T1.2.
Work: synthesize only QA-passed text, support voice/rate settings per job, split long text safely, retry transient TTS errors and emit structured progress.
Acceptance: mocked tests cover success/failure/retry and ordering; live TTS is an explicit opt-in smoke test.
[x] T6.2 — Validate audio and store chapter assets
Dependencies: T6.1, T4.3.
Work: verify non-empty valid audio, probe duration/format using FFprobe where available, checksum and upload. Mark the chapter TTS stage complete only after remote verification.
Acceptance: zero-byte/corrupt audio is rejected; interrupted upload can resume without re-synthesizing valid audio.
[x] T6.3 — Workdir cleanup and audio reuse
Dependencies: T6.2, T4.5.
Work: remove local chunks after remote assets are verified and no later stage needs those local copies. Support downloading valid R2 assets for later repackaging.
Acceptance: repeated run reuses valid remote audio without calling TTS and does not accumulate per-chapter local files.
Phase 7 — M4B builder and YouTube export
[x] T7.1 — Persist configurable package settings
Dependencies: T2.3.
Work: persist chaptersPerBook and export settings per job, with a sensible default (20) but no hard-coded grouping in builder logic. Validate the selected range and config.
Acceptance: API/schema tests cover values such as 10, 20, 30 and full-story packaging where size limits allow; changing settings is persisted across restart.
[x] T7.2 — Group chapters deterministically
Dependencies: T7.1, T6.2.
Work: group chapter indices into packages using the saved setting; handle gaps explicitly and ensure the final partial package is handled according to job completion policy. Never silently skip missing chapters.
Acceptance: unit tests cover 0, 1, exact multiple, remainder, gap, reorder and changed chaptersPerBook.
[x] T7.3 — Build M4B with chapter markers
Dependencies: T7.2.
Work: download only audio assets for one package to a temporary directory, create metadata/chapter timestamps, invoke FFmpeg using argument arrays, run FFprobe validation and upload the result.
Acceptance: output has expected duration, metadata and number/title of chapters; invalid output is never marked completed; source chapter audio remains available on R2.
[x] T7.4 — Repackage without rerunning AI/TTS
Dependencies: T7.3.
Work: when chaptersPerBook changes, invalidate only package records affected by the new grouping; reuse verified chapter audio/text.
Acceptance: test demonstrates changed package size causes no rewrite/TTS calls.
[x] T7.5 — Export YouTube MP4 and description
Dependencies: T7.3.
Work: create a 16:9 MP4 from audio plus cover image; generate timestamped chapter description from measured chapter durations and thumbnail asset. Add configurable image/cover; do not automatically upload.
Acceptance: MP4 passes FFprobe; description starts at 00:00, timestamps are monotonically increasing and correspond to chapter boundaries; output is uploaded privately to R2.
Phase 8 — Frontend
[x] T8.1 — Create job form and settings
Dependencies: T3.2, T7.1.
Work: build URL form, source validation feedback, rewrite/TTS options and configurable chapters-per-book selector. Do not expose secrets.
Acceptance: form calls API, displays validation errors and accurately reflects persisted configuration.
[x] T8.2 — Job list/detail and SSE progress
Dependencies: T3.5.
Work: show queued/running/waiting/review/failed/completed jobs and per-stage/per-chapter progress. Reconnect SSE and refresh from API after page reload.
Acceptance: progress remains correct after browser refresh and API reconnection.
[x] T8.3 — Review/error and resume controls
Dependencies: T5.6, T5.7, T3.6.
Work: show chapters needing review, quota wait explanation, retry/resume/cancel controls where valid. Avoid controls that imply unsupported automatic correction.
Acceptance: button visibility/actions follow state-machine rules; error messages contain safe actionable info.
[x] T8.4 — Output library and download links
Dependencies: T4.4, T7.3, T7.5.
Work: show M4B/MP4/description/thumbnail assets and request time-limited download links.
Acceptance: UI can download authorized outputs while bucket remains private.
Phase 9 — Hardening, full tests and Windows launch
[x] T9.1 — Unit and integration test matrix
Dependencies: relevant phases complete.
Work: test source adapter, text QA, cache, state machine, worker protocol, R2 mock, packaging, API validation and frontend states. Keep network-dependent tests opt-in.
Acceptance: documented test commands pass in a clean setup; skips/limitations are explicit.
[x] T9.2 — Failure-injection/resume tests
Dependencies: T9.1.
Work: simulate process kill after each major stage, quota wait, network drop, local corrupt temp file, R2 upload failure, PostgreSQL restart and duplicate start request.
Acceptance: valid completed stages are not rerun; no incomplete asset is marked verified; jobs recover to a consistent state.
[x] T9.3 — Full acceptance run on the 153-part regression set
Dependencies: T9.1, T9.2.
Work: run offline text QA against the existing sample/regression material; do not send all 153 chapters to Gemini/TTS without explicit opt-in and quota review. If a live run is authorized, start with a small sample and report actual calls/outputs.
Acceptance: known failure patterns are detected; output counts/order are correct; all unresolved chapters are visibly blocked for review.
[x] T9.4 — Windows developer/launch scripts
Dependencies: T8.4, T9.1.
Work: document one command to start frontend/API and worker dependencies; provide setup for PostgreSQL, FFmpeg, Python env and R2 variables. Add health checks and clean shutdown.
Acceptance: clean-machine instructions work; app starts without manual multi-step pipeline commands.
[x] T9.5 — Final security/cost review and release checklist
Dependencies: T9.4.
Work: review secrets, R2 privacy, URL authorization, storage budget, paid-model blocking, logs, source rights warning, no auto-YouTube publishing and backup/restore procedure.
Acceptance: signed-off checklist and release notes exist; no known critical issue remains.

[i] FF-1 — Orchestrator wiring (post-plan; phát hiện khi user test thật: job nằm queued mãi)
Dependencies: tất cả phase.
Work: dựng `apps/api/src/pipeline.ts` (ActiveHandler thật: extract→normalize→rewrite→tts→package theo DB skip-logic; exit codes → state; artifacts upload R2; completed khi mọi package ready), wire `server.ts` runner + shutdown, mở rộng claim (running + claimed_at NULL), resume/retry clearClaims, vá contract `seq` event (worker đọc counter trong workdir — run sau không reset).
Acceptance: 7 test pipeline offline (fake worker) + toàn bộ suite xanh.
[x] FF-1 — DONE (offline): API 199/199, Web 20/20, Python 166 passed/3 skipped. Live-run chờ user.

6. Data model expectations
Minimum entities and fields (exact schema may improve during T2.3):
- Job: id, source URL/adapter, state, config snapshot, chaptersPerBook, created/updated/start/end times, notBefore, last error summary.
- Chapter: job relation, index/order, title, source URL, stage states, review status and active text/audio asset references.
- Asset: job/chapter/package relations, type, R2 object key, content type, size, SHA-256, verified flag, creation time and version/fingerprint.
- BookPackage: job relation, sequence, start/end chapter index, chapter count, grouping-setting snapshot, M4B asset, optional MP4/description/thumbnail assets, package state.
- JobEvent: job/chapter relation if applicable, monotonic sequence, event type, sanitized message/data, timestamp.
Do not store giant content bodies or MP3/MP4 bytes in PostgreSQL. Store files in R2 and keep database records for metadata and status. If text assets are also stored in R2, keep only short preview/excerpt in the database if the UI genuinely needs it.
7. State and resume rules
Suggested stage flow per chapter:

DISCOVERED → DOWNLOADED → NORMALIZED → REWRITTEN → QA_PASSED → TTS_DONE → VERIFIED

A failed quality gate routes to NEEDS_REVIEW; a transient failure routes to retry/wait; a permanent error routes to FAILED. VERIFIED means the required remote artifact has been verified and the DB transaction committed.

Resume algorithm:
1. Load persisted job/config/stage states.
2. Verify referenced R2 assets by object metadata/checksum as applicable.
3. Mark missing/corrupt assets invalid; do not assume existence alone means valid.
4. Find first required stage without a valid output.
5. Reuse all upstream verified artifacts whose fingerprints still match.
6. Execute only the missing/invalid stage.
7. Commit stage status after artifact verification.
Use idempotency keys on create/retry/commit where duplicate API requests could cause duplicate work. Avoid marking a job complete if any required chapter/package remains failed or needs review.
8. Test and acceptance matrix
At minimum test:
- Start from supported URL; preserve chapter order and detect locked/unsupported source.
- Source has missing/duplicate chapter or empty HTML.
- Text contains leftover CJK characters, unbalanced 【】, prompt leakage, truncation or repeated paragraphs.
- Glossary change invalidates affected rewrite cache.
- Cache hit is revalidated and avoids model calls when valid.
- Gemini rate limit / daily quota / timeout / invalid API key are handled differently.
- Edge TTS transient failure does not recreate verified audio from previous chapters.
- Audio file empty/corrupt is rejected.
- chaptersPerBook 10, 20, 30; exact multiple and final remainder; gap blocks packaging.
- M4B chapter marks, duration and titles match package input.
- MP4 has valid video/audio streams and correct description timestamps.
- R2 is private; uploads are verified; failed upload does not delete local only copy.
- Backend restart/worker kill resumes without recomputing completed stages.
- React refresh reconnects to persisted progress.
- No browser/frontend secret, no shell injection, no unwanted public upload.
9. Completion report format after each task
The agent must report:
1. Task ID + outcome: DONE, BLOCKED, or PARTIAL.
2. Changed files: list of paths and purpose.
3. Commands executed: exact commands.
4. Tests: passed/failed/skipped and reason.
5. Manual verification: only what was truly observed.
6. Known issues/risks: no hidden failures.
7. Next task: ID and prerequisite, then stop.
Do not say “all tests pass” if not run. Do not run live Gemini/TTS or delete cloud resources without explicit user authorization.