// Orchestrator sản phẩm (wiring còn thiếu của T3.3→T7) — JobRunner chạy handler này.
// Nguyên tắc:
//  - Node chỉ ghi DB/R2; worker python làm tính toán (pattern T6.2);
//  - stage đã xong KHÔNG chạy lại (skip-logic theo DB — resume/T9.2);
//  - exit code của worker là nguồn sự thật cho state job; persistWorkerEvents chỉ
//    giữ event (audit) + map kết cục phụ, KHÔNG auto-completed giữa chừng;
//  - handler phải để job RỜI khỏi 'running' trước khi return (tránh claim-loop khô).
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDb, ValidationError } from "./db";
import {
  chaptersNeedingTts,
  getJob,
  listChapters,
  persistWorkerEvents,
  setChapterStage,
  setJobState,
  upsertChapters,
} from "./job-repository";
import { recordChapterArtifact } from "./asset-service";
import { storeChapterAudio, type FfprobeRunner } from "./audio-verify";
import { finishPackageBuild, preparePackageBuild } from "./package-build";
import { planJobPackages } from "./pkg-groups";
import { InvalidTransitionError } from "./state-machine";
import type { ActiveHandler } from "./queue";
import type { ObjectStoreAdapter } from "./r2-adapter";
import { resolveR2 } from "./r2-resolver";
import {
  buildWorkerArgv,
  runWorkerProcess,
  type RunWorkerOptions,
  type WorkerRunResult,
} from "./worker-spawn";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

type WorkerAction = "extract" | "normalize" | "rewrite" | "tts" | "package";

const ACTION_TIMEOUTS: Record<WorkerAction, number> = {
  extract: 15 * 60_000,
  normalize: 10 * 60_000,
  rewrite: 60 * 60_000,
  tts: 60 * 60_000,
  package: 30 * 60_000,
};

const MAX_RETRYABLE_ATTEMPTS = 3; // exit 10 → thử lại trong cùng lần chạy, quá cap = failed
const RETRY_DELAY_MS = 180_000; // nghỉ đủ khung hạ nhiệt của Cloudflare (bằng chứng: 60s ×3 vẫn bị chặn)

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface PipelineDeps {
  /** Seam test: thay runWorkerProcess (fake worker offline). */
  spawn?: (opts: RunWorkerOptions) => Promise<WorkerRunResult>;
  store?: ObjectStoreAdapter;
  ffprobe?: FfprobeRunner;
  pythonPath?: string;
  workRoot?: string;
  timeouts?: Partial<Record<WorkerAction, number>>;
  /** Nghỉ giữa 2 lần retry exit-10 (default 60s — trang bị chặn cần thời gian hạ nhiệt). */
  retryDelayMs?: number;
  /** Seam test: thay hàm ngủ (mặc định setTimeout thật). */
  sleep?: (ms: number) => Promise<void>;
}

interface StageOutcome {
  exitCode: number | null;
  aborted: boolean;
  events: Record<string, unknown>[];
}

const pad4 = (n: number): string => String(n).padStart(4, "0");
const CHAPTER_DIR_RE = /^chapters\/(\d{4})\//;

function lastFinalSummary(events: Record<string, unknown>[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "final" && typeof ev.summary === "string" && ev.summary) return ev.summary;
  }
  return null;
}

export function createPipelineHandler(deps: PipelineDeps = {}): ActiveHandler {
  const spawn = deps.spawn ?? ((o: RunWorkerOptions) => runWorkerProcess(o));
  const getStore = (): ObjectStoreAdapter => deps.store ?? resolveR2().store;
  const pythonPath =
    deps.pythonPath?.trim() ||
    process.env.STORY_AUDIO_PYTHON?.trim() ||
    (() => {
      const venv = path.join(REPO_ROOT, "workers", "python", ".venv", "Scripts", "python.exe");
      return existsSync(venv) ? venv : "python";
    })();

  return async function handle(jobId: string, signal: AbortSignal): Promise<void> {
    const workRoot = deps.workRoot?.trim() || process.env.STORY_AUDIO_WORK_ROOT?.trim();
    if (!workRoot) {
      throw new ValidationError(
        "STORY_AUDIO_WORK_ROOT chưa cấu hình — không biết ghi workdir của job ở đâu",
      );
    }
    const job = await getJob(jobId);
    if (!job) throw new ValidationError(`job ${jobId} không tồn tại`);

    const state = String(job.state);
    // terminal: replay sau crash/idempotent — không làm gì cả
    if (["completed", "failed", "canceled"].includes(state)) return;
    if (state !== "queued" && state !== "waiting_quota" && state !== "running" && state !== "needs_review") {
      return;
    }

    const snap = (job.configSnapshot ?? {}) as Record<string, unknown>;
    const exp = (snap.export ?? {}) as Record<string, unknown>;
    let count = Number(snap.count ?? job.chaptersPerBook);
    if (!Number.isInteger(count) || count < 1) {
      throw new ValidationError(`job không khai báo số chương hợp lệ (count): ${String(snap.count ?? job.chaptersPerBook)}`);
    }

    const workdir = path.join(workRoot, "jobs", jobId);
    await fs.mkdir(path.join(workdir, "chapters"), { recursive: true });

    // Hỗ trợ cấu hình linh hoạt AI Provider & Model từ export settings hoặc snapshot
    const providers = snap.providers ?? exp.aiProvider ?? exp.providers;
    const aiModel = snap.ai_model ?? snap.aiModel ?? exp.aiModel ?? exp.ai_model;
    const openrouterApiKey = exp.openrouterApiKey ?? snap.openrouter_api_key ?? snap.openrouterApiKey;
    const geminiApiKey = exp.geminiApiKey ?? snap.gemini_api_key ?? snap.geminiApiKey;
    const devkitApiKey = exp.devkitApiKey ?? snap.devkit_api_key ?? snap.devkitApiKey;
    const devkitBaseUrl = exp.devkitBaseUrl ?? snap.devkit_base_url ?? snap.devkitBaseUrl;
    const allowFallbackTts = Boolean(snap.allow_fallback_tts ?? snap.allowFallbackTts ?? exp.allowFallbackTts ?? exp.allow_fallback_tts);

    const payloadBase: Record<string, unknown> = {
      url: String(job.sourceUrl),
      count,
      replacements: snap.replacements,
      glossary: snap.glossary,
      qa: snap.qa,
      voice: snap.voice,
      rate: snap.rate,
      allow_fallback_tts: allowFallbackTts,
      providers: providers ? String(providers) : undefined,
      ai_model: aiModel ? String(aiModel) : undefined,
      openrouter_api_key: openrouterApiKey ? String(openrouterApiKey) : undefined,
      gemini_api_key: geminiApiKey ? String(geminiApiKey) : undefined,
      devkit_api_key: devkitApiKey ? String(devkitApiKey) : undefined,
      devkit_base_url: devkitBaseUrl ? String(devkitBaseUrl) : undefined,
      chunk_max_chars: snap.chunk_max_chars,
    };
    // JSON.stringify tự bỏ key undefined — payload chỉ chứa field người dùng khai

    const db = getDb();

    // cast InvalidTransition (vd job bị cancel giữa chừng) — giữ state hiện tại
    const trySetState = async (s: string, lastError?: string): Promise<void> => {
      try {
        await setJobState({ jobId, state: s, lastError });
      } catch (e) {
        if (!(e instanceof InvalidTransitionError)) throw e;
      }
    };

    const configPath = path.join(workdir, "config.json");
    const spawnStage = async (
      action: WorkerAction,
      extra: Record<string, unknown> = {},
    ): Promise<StageOutcome> => {
      const payload = { ...payloadBase, ...extra };
      await fs.writeFile(configPath, JSON.stringify(payload), "utf-8");
      const argv = buildWorkerArgv({ pythonPath, configPath, jobId, action, workdir });
      const timeoutMs = deps.timeouts?.[action] ?? ACTION_TIMEOUTS[action];
      const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
      let attempt = 0;
      for (;;) {
        if (signal.aborted) return { exitCode: null, aborted: true, events: [] };
        attempt++;
        const workerEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...(openrouterApiKey ? { OPENROUTER_API_KEY: String(openrouterApiKey) } : {}),
          ...(geminiApiKey ? { GEMINI_API_KEY: String(geminiApiKey) } : {}),
          ...(devkitApiKey ? { DEVKIT_API_KEY: String(devkitApiKey) } : {}),
          ...(devkitBaseUrl ? { DEVKIT_BASE_URL: String(devkitBaseUrl) } : {}),
          ...(aiModel
            ? {
                VIETLAI_OPENROUTER_MODEL: String(aiModel),
                VIETLAI_DEVKIT_MODEL: String(aiModel),
                VIETLAI_GEMINI_MODEL: String(aiModel),
              }
            : {}),
        };
        const onEvent = async (ev: Record<string, unknown>) => {
          try {
            await persistWorkerEvents(jobId, [ev], { completeOnFinalSuccess: false });
            if (ev.type === "chapter_status") {
              const st = String(ev.state);
              if (["downloaded", "normalized", "rewritten", "failed"].includes(st)) {
                try {
                  await setChapterStage({ jobId, chapterIndex: Number(ev.chapter_no), stage: st });
                } catch (e) {
                  if (!(e instanceof InvalidTransitionError)) throw e;
                }
              }
            }
          } catch {
            // Live persist failure shouldn't kill worker run
          }
        };
        const r = await spawn({ argv, timeoutMs, env: workerEnv, signal, onEvent });
        await persistWorkerEvents(jobId, r.events, { completeOnFinalSuccess: false });
        if (r.exitCode === null) {
          // bị kill (cancel/shutdown/treo): cancel → rời im lặng (boot requeue lại);
          // timeout thật → park failed có lý do rõ
          if (signal.aborted) return { exitCode: null, aborted: true, events: r.events };
          await trySetState("failed", `${action}: quá hạn ${Math.round(timeoutMs / 1000)}s`);
          return { exitCode: null, aborted: false, events: r.events };
        }
        if (r.exitCode === 0) return { exitCode: 0, aborted: false, events: r.events };
        // 10 retryable → NGHỈ (challenge/veil cần hạ nhiệt) rồi thử lại; quá cap = park failed
        if (r.exitCode === 10 && attempt < MAX_RETRYABLE_ATTEMPTS) {
          await (deps.sleep ?? defaultSleep)(retryDelayMs);
          continue;
        }
        const summary =
          lastFinalSummary(r.events) ??
          `${action}: exit ${r.exitCode}${r.stderr ? ` — ${r.stderr.slice(0, 300)}` : ""}`;
        if (r.exitCode === 30) {
          await trySetState("needs_review", summary);
        } else if (r.exitCode === 40) {
          await trySetState("waiting_quota", summary);
        } else {
          await trySetState("failed", summary);
        }
        return { exitCode: r.exitCode, aborted: false, events: r.events };
      }
    };

    const applyChapterEvents = async (events: Record<string, unknown>[]): Promise<void> => {
      for (const ev of events) {
        if (ev.type !== "chapter_status") continue;
        const st = String(ev.state);
        // tts_done chỉ được ghi qua storeChapterAudio sau khi audio verify — bỏ qua event này
        if (!["downloaded", "normalized", "rewritten", "failed"].includes(st)) continue;
        try {
          await setChapterStage({ jobId, chapterIndex: Number(ev.chapter_no), stage: st });
        } catch (e) {
          if (!(e instanceof InvalidTransitionError)) throw e; // replay out-of-order — idempotent
        }
      }
    };

    const uploadArtifact = async (rel: string, chapterIndex: number): Promise<void> => {
      // raw text (chapter_text) + normalized chưa upload — chỉ rewritten/audio cần R2;
      // m4b do finishPackageBuild tự upload (T7.3)
      const store = getStore();
      if (rel.startsWith("chapters/")) {
        if (rel.endsWith("rewritten.txt")) {
          await recordChapterArtifact({
            jobId,
            chapterIndex,
            kind: "rewritten_text",
            workdir,
            relativePath: rel,
            store,
          });
        } else if (rel.endsWith(".mp3") || rel.endsWith(".m4a")) {
          await storeChapterAudio({
            jobId,
            chapterIndex,
            workdir,
            relativePath: rel,
            store,
            ...(deps.ffprobe ? { ffprobe: deps.ffprobe } : {}),
          });
        }
      }
    };

    const applyArtifactEvents = async (events: Record<string, unknown>[]): Promise<void> => {
      for (const ev of events) {
        if (ev.type !== "artifact_ready") continue;
        const rel = String(ev.path);
        const m = CHAPTER_DIR_RE.exec(rel);
        if (!m) continue;
        await uploadArtifact(rel, Number(m[1])); // lỗi upload 1 chương = park failed (chuẩn T4.3)
      }
    };

    const promoteRewrittenChapters = async (): Promise<void> => {
      for (const c of await listChapters(jobId)) {
        if (c.stageState === "rewritten") {
          const sidecarPath = path.join(workdir, "chapters", pad4(c.index), "rewritten.chunks.json");
          let eligible = false;
          if (existsSync(sidecarPath)) {
            try {
              const raw = await fs.readFile(sidecarPath, "utf-8");
              const sidecar = JSON.parse(raw);
              const status = sidecar.chapter_status ?? "ok";
              if (status === "ok") {
                eligible = true;
              } else if (status === "needs_review" && allowFallbackTts) {
                eligible = true;
              }
            } catch {
              eligible = false;
            }
          }
          if (eligible) {
            await setChapterStage({ jobId, chapterIndex: c.index, stage: "qa_passed" });
          }
        }
      }
    };

    // ---- stages ----------------------------------------------------------

    await trySetState("running"); // idempotent — claim thường đã set; needs_review/queued thì chính ở đây chuyển

    let chapters = await listChapters(jobId);

    const countDownloadedOnDisk = (): number => {
      let n = 0;
      while (existsSync(path.join(workdir, `chapters/${pad4(n + 1)}/text.txt`))) {
        n++;
      }
      return n;
    };

    // Phục hồi chapters từ đĩa nếu DB chưa có (do extract dừng ở needs_review trước khi ghi DB)
    let diskCount = countDownloadedOnDisk();
    if (chapters.length === 0 && diskCount > 0) {
      const items: { index: number; title: string }[] = [];
      for (let no = 1; no <= diskCount; no++) {
        const rel = `chapters/${pad4(no)}/text.txt`;
        const txt = await fs.readFile(path.join(workdir, rel), "utf-8").catch(() => null);
        items.push({ index: no, title: txt ? (txt.split("\n", 1)[0]?.trim() || `Chương ${no}`) : `Chương ${no}` });
      }
      await upsertChapters(jobId, items);
      for (let no = 1; no <= diskCount; no++) {
        try {
          await setChapterStage({ jobId, chapterIndex: no, stage: "downloaded" });
        } catch {
          // idempotent
        }
      }
      chapters = await listChapters(jobId);
    }

    // Nếu người dùng duyệt tiếp tục sau needs_review của extract (chỉ tải được một số chương do web hết chương/khóa):
    // điều chỉnh count theo số chương thực tế đã tải thành công để tiếp tục xử lý các stage sau.
    if (chapters.length > 0 && chapters.length < count) {
      count = chapters.length;
      payloadBase.count = count;
    }

    if (chapters.length < count) {
      const out = await spawnStage("extract");
      diskCount = countDownloadedOnDisk();
      if (diskCount > 0) {
        const items: { index: number; title: string }[] = [];
        for (let no = 1; no <= diskCount; no++) {
          const rel = `chapters/${pad4(no)}/text.txt`;
          const txt = await fs.readFile(path.join(workdir, rel), "utf-8").catch(() => null);
          items.push({ index: no, title: txt ? (txt.split("\n", 1)[0]?.trim() || `Chương ${no}`) : `Chương ${no}` });
        }
        await upsertChapters(jobId, items);
        await applyChapterEvents(out.events);
        chapters = await listChapters(jobId);
      }
      if (out.aborted || out.exitCode !== 0) return;
    }

    if (chapters.some((c) => c.stageState === "discovered" || c.stageState === "downloaded")) {
      const out = await spawnStage("normalize");
      if (out.aborted || out.exitCode !== 0) return;
      await applyChapterEvents(out.events);
      chapters = await listChapters(jobId);
    }

    if (
      chapters.some((c) =>
        ["discovered", "downloaded", "normalized"].includes(c.stageState),
      )
    ) {
      const out = await spawnStage("rewrite");
      if (out.aborted) return;
      // NEEDS_REVIEW(30) vẫn có tiến độ thật (rewritten + artifact) — phải ghi để
      // resume tái dùng; nếu không, mỗi lần resume spawn lại rewrite và đốt thêm
      // quota Gemini cho cùng kết quả (lỗi live FF-1, vòng lặp vô hạn)
      await applyChapterEvents(out.events);
      await applyArtifactEvents(out.events); // upload rewritten_text (idempotent theo sha)
      // QA gate chạy trong worker-rewrite; chỉ nâng chương hợp lệ sang qa_passed (loại trừ blocked và needs_review chưa duyệt)
      await promoteRewrittenChapters();
      if (out.exitCode !== 0) return;
      chapters = await listChapters(jobId);
      await planJobPackages(jobId);
    }

    // Đường resume: duyệt các chương rewritten và chỉ nâng sang qa_passed nếu không bị blocked
    await promoteRewrittenChapters();

    if ((await chaptersNeedingTts(jobId, workdir)).length > 0) {
      const out = await spawnStage("tts");
      if (out.aborted || out.exitCode !== 0) return;
      await applyArtifactEvents(out.events); // storeChapterAudio → probe + upload + tts_done
      chapters = await listChapters(jobId);
    }

    const readyForPackage = chapters.filter((c) =>
      ["tts_done", "verified"].includes(c.stageState) || Boolean(c.audioAssetId),
    );
    if (readyForPackage.length >= count) {
      await planJobPackages(jobId); // idempotent — resume thường xuyên nhảy qua stages đầu
      const pkgs = await db.bookPackage.findMany({
        where: { jobId },
        orderBy: { sequence: "asc" },
        select: { id: true, sequence: true, state: true },
      });
      if (pkgs.length === 0) {
        throw new ValidationError("planJobPackages không tạo được gói nào cho job này");
      }
      for (const pkg of pkgs) {
        if (signal.aborted) return;
        if (pkg.state === "ready") continue;
        if (pkg.state !== "pending" && pkg.state !== "failed") {
          // building từ run bị kill — thử finish (m4b có thể đã build xong);
          // hỏng → đánh failed để lần sau build lại từ đầu
          try {
            await finishPackageBuild(jobId, pkg.sequence, workdir, { store: getStore() });
            continue;
          } catch {
            await db.bookPackage.update({ where: { id: pkg.id }, data: { state: "failed" } });
          }
        }
        await preparePackageBuild(jobId, pkg.sequence, workdir, { store: getStore() });
        const out = await spawnStage("package", { sequence: pkg.sequence });
        if (out.aborted) return;
        if (out.exitCode !== 0) {
          await db.bookPackage.update({ where: { id: pkg.id }, data: { state: "failed" } });
          return; // job đã được park theo exit code trong spawnStage
        }
        await finishPackageBuild(jobId, pkg.sequence, workdir, { store: getStore() });
      }
      await trySetState("completed");
    } else {
      const hasPendingChapters = chapters.some((c) =>
        ["rewritten", "discovered", "downloaded", "normalized"].includes(c.stageState),
      );
      if (hasPendingChapters) {
        await trySetState("needs_review");
      }
    }
  };
}
