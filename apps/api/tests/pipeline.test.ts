// Pipeline orchestrator tests — wiring production thiếu của T3.3→T7: Node lái job
// qua extract → normalize → rewrite → tts → package bằng worker spawn thật
// (test thay bằng FAKE spawn — offline chặt, không mạng). DB = PostgreSQL dev thật.
// Acceptance: (1) stage xong không chạy lại; (2) exit codes map đúng state;
// (3) trọn bộ xong → job completed; (4) cancel dừng đàng hoàng; (5) quota đợi đúng.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { ObjectStoreAdapter } from "../src/r2-adapter";
import type { RunWorkerOptions, WorkerRunResult } from "../src/worker-spawn";
import type { FfprobeRunner } from "../src/audio-verify";
import { createJob, setJobState } from "../src/job-repository";
import { createPipelineHandler } from "../src/pipeline";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
const pad4 = (n: number): string => String(n).padStart(4, "0");

// ---- fakes ---------------------------------------------------------------

class InMemoryStore implements ObjectStoreAdapter {
  objects = new Map<string, Buffer>();
  puts: string[] = [];

  async putObject({ key, body }: { key: string; body: Buffer }) {
    this.puts.push(key);
    this.objects.set(key, body);
    return { etag: `"${createHash("md5").update(body).digest("hex")}"`, size: body.length };
  }

  async getObject(key: string) {
    const b = this.objects.get(key);
    if (!b) return null;
    return { data: b };
  }

  async headObject(key: string) {
    const b = this.objects.get(key);
    if (!b) return null;
    return { size: b.length, etag: `"${createHash("md5").update(b).digest("hex")}"` };
  }

  async deleteObject(key: string) {
    this.objects.delete(key);
  }
}

const fakeFfprobe: FfprobeRunner = async () => ({
  status: "exit",
  code: 0,
  stdout: JSON.stringify({ format: { duration: "9.5", format_name: "mp3" } }),
  stderr: "",
});

interface Call {
  action: string;
  jobId: string;
  config: Record<string, unknown>;
  workdir: string;
}

interface EmitArgs {
  workdir: string;
  config: Record<string, unknown>;
  jobId: string;
}

interface ActionScript {
  exit: number;
  /** exit theo số lần spawn của action (1-based) — đè `exit` khi có. */
  exitByCall?: Record<number, number>;
  emit?: (arg: EmitArgs) => Promise<Record<string, unknown>[]>;
}

function runFakeSpawn(scripts: Record<string, ActionScript>, calls: Call[]) {
  const attemptOf = new Map<string, number>();
  return async (opts: RunWorkerOptions): Promise<WorkerRunResult> => {
    const argv = opts.argv;
    const pick = (flag: string): string => argv[argv.indexOf(flag) + 1];
    const action = pick("--action");
    const jobId = pick("--job-id");
    const workdir = pick("--workdir");
    const configPath = pick("--config");
    const config = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
    calls.push({ action, jobId, config, workdir });
    const script = scripts[action];
    if (!script) throw new Error(`fake worker không có script cho action '${action}'`);
    const attempt = (attemptOf.get(action) ?? 0) + 1;
    attemptOf.set(action, attempt);
    const exitCode = script.exitByCall?.[attempt] ?? script.exit; // đọc TRƯỚC emit — script có thể đổi exit theo số lần emit (retry)
    const rawEvents = script.emit ? await script.emit({ workdir, config, jobId }) : [];
    // seq LIÊN TỤC giữa các lần chạy (giống _Emitter đọc counter trong workdir thật)
    let seq = seqCounters.get(jobId) ?? 0;
    for (const ev of rawEvents) {
      (ev as Record<string, unknown>).seq = seq++;
    }
    seqCounters.set(jobId, seq);
    const events = rawEvents.map((ev) => ({
      protocol: "1",
      job_id: jobId,
      ...ev,
    }));
    return {
      exitCode,
      timedOut: false,
      events: events as Record<string, unknown>[],
      malformed: [],
      stderr: "",
    };
  };
}

async function writeChapterFiles(
  workdir: string,
  count: number,
  fileName: string,
  body: (no: number) => string,
  status: string,
  kind: string,
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for (let no = 1; no <= count; no++) {
    const dir = join(workdir, "chapters", pad4(no));
    await mkdir(dir, { recursive: true });
    const content = body(no);
    const rel = `chapters/${pad4(no)}/${fileName}`;
    await writeFile(join(workdir, rel), content, "utf-8");
    if (fileName === "rewritten.txt") {
      const sidecar = {
        schema_version: "1.0",
        chapter_no: no,
        text_sha256: sha(content),
        chapter_status: "ok",
        chunks: [],
      };
      await writeFile(join(dir, "rewritten.chunks.json"), JSON.stringify(sidecar, null, 2), "utf-8");
    }
    events.push(
      { type: "chapter_status", chapter_no: no, state: status },
      { type: "artifact_ready", path: rel, kind, checksum: sha(content) },
      { type: "progress", stage: fileName.replace(/\.txt$/, "").replace(".mp3", ""), done: no, total: count },
    );
  }
  return events;
}

const FINAL_SUCCESS = [{ type: "final", status: "success", summary: "ok" }];

function happyScripts(count: number): Record<string, ActionScript> {
  return {
    extract: {
      exit: 0,
      emit: async ({ workdir }) => [
        { type: "stage_started", stage: "extract" },
        ...(await writeChapterFiles(
          workdir,
          count,
          "text.txt",
          (no) => `Chương ${no}\n\nNội dung nguồn chương ${no}.\n`,
          "downloaded",
          "chapter_text",
        )),
        ...FINAL_SUCCESS,
      ],
    },
    normalize: {
      exit: 0,
      emit: async ({ workdir }) => [
        { type: "stage_started", stage: "normalize" },
        ...(await writeChapterFiles(
          workdir,
          count,
          "normalized.txt",
          (no) => `Nội dung chuẩn hoá chương ${no}.\n`,
          "normalized",
          "normalized_text",
        )),
        ...FINAL_SUCCESS,
      ],
    },
    rewrite: {
      exit: 0,
      emit: async ({ workdir }) => [
        { type: "stage_started", stage: "rewrite" },
        ...(await writeChapterFiles(
          workdir,
          count,
          "rewritten.txt",
          (no) => `Bản viết lại chương ${no}.\n`,
          "rewritten",
          "rewritten_text",
        )),
        ...FINAL_SUCCESS,
      ],
    },
    tts: {
      exit: 0,
      emit: async ({ workdir }) => [
        { type: "stage_started", stage: "tts" },
        ...(await writeChapterFiles(workdir, count, "audio.mp3", (no) => `AUDIO-BYTES-${no}`, "tts_done", "chapter_audio")),
        ...FINAL_SUCCESS,
      ],
    },
    package: {
      exit: 0,
      emit: async ({ workdir, config }) => {
        const seq = Number(config.sequence);
        const body = `M4B-BOOK-${seq}`;
        const rel = `packages/${pad4(seq)}/book.m4b`;
        await mkdir(join(workdir, "packages", pad4(seq)), { recursive: true });
        await writeFile(join(workdir, rel), body, "utf-8");
        return [
          { type: "stage_started", stage: "package" },
          { type: "artifact_ready", path: rel, kind: "m4b", checksum: sha(body) },
          ...FINAL_SUCCESS,
        ];
      },
    },
  };
}

// ---- harness -------------------------------------------------------------

const pPrefix = "https://example.invalid/pipeline";
const seqCounters = new Map<string, number>();
let workdir = "";
let store: InMemoryStore;
let spawnCalls: Call[];
let scripts: Record<string, ActionScript>;

async function jobRow(jobId: string) {
  const r = await raw.job.findUnique({
    where: { id: jobId },
    select: { state: true, notBefore: true, lastError: true },
  });
  return r;
}

async function chapterRows(jobId: string) {
  return raw.chapter.findMany({
    where: { jobId },
    orderBy: { index: "asc" },
    select: { index: true, stageState: true, audioAssetId: true, textAssetId: true },
  });
}

function handlerFactory(extra: Partial<Parameters<typeof createPipelineHandler>[0]> = {}) {
  return createPipelineHandler({
    spawn: runFakeSpawn(scripts, spawnCalls),
    store,
    ffprobe: fakeFfprobe,
    pythonPath: "python-fake",
    workRoot: workdir,
    sleep: async () => {}, // default: test không ngủ thật — test riêng muốn assert sleep thì override
    ...extra,
  });
}

async function newJob(extraSnapshot: Record<string, unknown> = {}): Promise<string> {
  const r = await createJob({
    sourceUrl: `${pPrefix}/${Date.now()}-${Math.random()}`,
    adapter: "test",
    chaptersPerBook: 2,
    configSnapshot: { replacements: { "tên sai": "tên đúng" }, ...extraSnapshot },
  });
  await setJobState({ jobId: r.id, state: "running" });
  return r.id;
}

const actionsOf = (): string[] => spawnCalls.map((c) => c.action);

describe("pipeline orchestrator (wiring production)", () => {
  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pipeline-test-"));
  });

  beforeEach(async () => {
    store = new InMemoryStore();
    spawnCalls = [];
    scripts = happyScripts(2);
  });

  afterAll(async () => {
    // dọn sạch job của test này (cascade chapters/assets/packages/events) —
    // không xóa job thật của user (URL prefix riêng)
    await raw.job.deleteMany({ where: { sourceUrl: { startsWith: pPrefix } } });
    await rm(workdir, { recursive: true, force: true });
    await raw.$disconnect();
  });

  it("happy path toàn bộ stage theo thứ tự → job completed, chapters đúng trạng thái", async () => {
    const jobId = await newJob();
    await handlerFactory()(jobId, new AbortController().signal);

    expect(actionsOf()).toEqual(["extract", "normalize", "rewrite", "tts", "package"]);
    // config payload đúng cấu trúc (url + count + replacements của snapshot)
    const cfg = spawnCalls[0].config;
    expect(cfg.url).toContain(pPrefix);
    expect(cfg.count).toBe(2);
    expect((cfg.replacements as Record<string, string>)["tên sai"]).toBe("tên đúng");

    const job = await jobRow(jobId);
    expect(job?.state).toBe("completed");

    const chapters = await chapterRows(jobId);
    expect(chapters).toHaveLength(2);
    for (const ch of chapters) {
      expect(ch.stageState).toBe("tts_done");
      expect(ch.audioAssetId).toBeTruthy();
      expect(ch.textAssetId).toBeTruthy();
    }
    // 2 audio + 2 rewritten + 1 book = 5 upload R2 (extract raw text không upload)
    expect(store.puts).toHaveLength(5);
    // package đã ready
    const pkgs = await raw.bookPackage.findMany({ where: { jobId } });
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0].state).toBe("ready");
  }, 30_000);

  it("exit RETRYABLE(10) → nghỉ retryDelayMs rồi thử lại trong cùng lần chạy → completed", async () => {
    const happy = happyScripts(2);
    scripts = {
      ...happy,
      extract: { exit: 0, exitByCall: { 1: 10 }, emit: happy.extract.emit },
    };
    const sleeps: number[] = [];
    const jobId = await newJob();
    await handlerFactory({
      retryDelayMs: 90_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    })(jobId, new AbortController().signal);

    expect(sleeps).toEqual([90_000]); // đúng 1 lần nghỉ giữa 2 attempt
    expect(actionsOf().filter((a) => a === "extract").length).toBe(2);
    expect((await jobRow(jobId))?.state).toBe("completed");
  }, 30_000);

  it("extract PERMANENT(20) → job failed, không stage nào chạy tiếp", async () => {
    scripts.extract = { exit: 20 };
    const jobId = await newJob();
    await handlerFactory()(jobId, new AbortController().signal);

    expect(actionsOf()).toEqual(["extract"]);
    const job = await jobRow(jobId);
    expect(job?.state).toBe("failed");
    expect(job?.lastError ?? "").toMatch(/fake|exit|20|lỗi/i);
  });

  it("rewrite NEEDS_REVIEW(30) → job needs_review; resume chạy lại KHÔNG lặp extract/normalize", async () => {
    scripts.rewrite = { exit: 30 };
    const jobId = await newJob();
    await handlerFactory()(jobId, new AbortController().signal);
    expect(actionsOf()).toEqual(["extract", "normalize", "rewrite"]);
    expect((await jobRow(jobId))?.state).toBe("needs_review");

    // user duyệt xong — resume về running; lần chạy 2 rewrite thành công thật
    scripts.rewrite = happyScripts(2).rewrite;
    await setJobState({ jobId, state: "running" });
    spawnCalls = [];
    await handlerFactory()(jobId, new AbortController().signal);
    expect(actionsOf()).toEqual(["rewrite", "tts", "package"]);
    expect((await jobRow(jobId))?.state).toBe("completed");
  }, 30_000);

  it("rewrite NEEDS_REVIEW(30) CÓ tiến độ → resume tái dùng kết quả, KHÔNG spawn rewrite lần 2", async () => {
    // lặp thật phát hiện live: exit-30 phải ghi tiến độ (DB advance + artifact) —
    // nếu không, mỗi lần resume lại đốt thêm quota Gemini cho cùng kết quả
    scripts.rewrite = {
      exit: 30,
      emit: async ({ workdir }) => [
        { type: "stage_started", stage: "rewrite" },
        ...(await writeChapterFiles(
          workdir,
          2,
          "rewritten.txt",
          (no) => `Bản viết lại chương ${no}.\n`,
          "rewritten",
          "rewritten_text",
        )),
        { type: "final", status: "needs_review", summary: "2 chương rewritten; 2 phần fallback cần duyệt" },
      ],
    };
    const jobId = await newJob();
    await handlerFactory()(jobId, new AbortController().signal);
    expect(actionsOf()).toEqual(["extract", "normalize", "rewrite"]);
    expect((await jobRow(jobId))?.state).toBe("needs_review");

    // user duyệt xong (resume) — rewrite KHÔNG được gọi lại
    scripts.rewrite = {
      exit: 20,
      emit: async () => {
        throw new Error("rewrite KHÔNG được spawn lại — tiến độ exit-30 đã advance DB");
      },
    };
    await setJobState({ jobId, state: "running" });
    spawnCalls = [];
    await handlerFactory()(jobId, new AbortController().signal);
    expect(actionsOf()).toEqual(["tts", "package"]);
    expect((await jobRow(jobId))?.state).toBe("completed");
  }, 30_000);

  it("quota_wait(40) → waiting_quota + notBefore; đợi hết hạn chạy tiếp cùng chỗ", async () => {
    scripts.rewrite = {
      exit: 40,
      emit: async () => [
        { type: "stage_started", stage: "rewrite" },
        { type: "quota_wait", backend: "gemini", not_before: new Date(Date.now() + 60_000).toISOString() },
        { type: "final", status: "quota_wait", summary: "rewrite dừng vì quota" },
      ],
    };
    const jobId = await newJob();
    await handlerFactory()(jobId, new AbortController().signal);
    const job = await jobRow(jobId);
    expect(job?.state).toBe("waiting_quota");
    expect(job?.notBefore).toBeTruthy();

    // quota hết hạn (notBefore về quá khứ) → claim được lại → rewrite re-run tiếp tts/package
    scripts.rewrite = happyScripts(2).rewrite;
    await raw.job.update({ where: { id: jobId }, data: { notBefore: new Date(Date.now() - 1000) } });
    // claim thật: claimNextJob chuyển waiting_quota → running trực tiếp (bảng cho phép)
    await setJobState({ jobId, state: "running" });
    spawnCalls = [];
    await handlerFactory()(jobId, new AbortController().signal);
    expect(actionsOf()).toEqual(["rewrite", "tts", "package"]);
    expect((await jobRow(jobId))?.state).toBe("completed");
  }, 30_000);

  it("tts RETRYABLE(10) → spawn lại đúng action tts (≤ cap), rồi thành công", async () => {
    let ttsCalls = 0;
    const base = scripts.tts;
    scripts.tts = {
      get exit() {
        return ttsCalls === 0 ? 10 : 0;
      },
      emit: async ({ workdir }) => {
        ttsCalls++;
        return base.exit === undefined ? [] : ((base.emit ? await base.emit({ workdir, config: {}, jobId: "" }) : []));
      },
    };
    const jobId = await newJob();
    await handlerFactory()(jobId, new AbortController().signal);

    expect(actionsOf().filter((a) => a === "tts")).toHaveLength(2);
    expect(actionsOf().filter((a) => a === "rewrite")).toHaveLength(1); // stage trước không lặp
    expect((await jobRow(jobId))?.state).toBe("completed");
  }, 30_000);

  it("cancel giữa chừng: signal aborted → không spawn thêm, job giữ canceled", async () => {
    const jobId = await newJob();
    const controller = new AbortController();
    // hành xử như cancel route: state → canceled + signal (T8.3 + T3.6)
    controller.abort("user-cancel");
    await setJobState({ jobId, state: "canceled" });
    await handlerFactory()(jobId, controller.signal);
    expect(actionsOf()).toEqual([]); // không spawn gì nữa
    expect((await jobRow(jobId))?.state).toBe("canceled");
  }, 30_000);

  it("completed rồi gọi lại (crash replay/anomaly) → 0 spawn, không đổi state", async () => {
    const jobId = await newJob();
    await handlerFactory()(jobId, new AbortController().signal);
    expect((await jobRow(jobId))?.state).toBe("completed");

    spawnCalls = [];
    await handlerFactory()(jobId, new AbortController().signal);
    expect(actionsOf()).toEqual([]);
    expect((await jobRow(jobId))?.state).toBe("completed");
  }, 30_000);

  it("T5 API không đưa chương blocked vào TTS", async () => {
    scripts = happyScripts(1);
    scripts.rewrite = {
      exit: 0,
      emit: async ({ workdir }) => {
        const evs = await writeChapterFiles(
          workdir,
          1,
          "rewritten.txt",
          () => "Bản viết lại chương 1 có lỗi nghiêm trọng.\n",
          "rewritten",
          "rewritten_text",
        );
        const sidecar = {
          schema_version: "1.0",
          chapter_no: 1,
          text_sha256: sha("Bản viết lại chương 1 có lỗi nghiêm trọng.\n"),
          chapter_status: "blocked",
          chunks: [],
        };
        await writeFile(
          join(workdir, "chapters", pad4(1), "rewritten.chunks.json"),
          JSON.stringify(sidecar, null, 2),
          "utf-8",
        );
        return [
          { type: "stage_started", stage: "rewrite" },
          ...evs,
          ...FINAL_SUCCESS,
        ];
      },
    };
    const jobId = await newJob();
    await handlerFactory()(jobId, new AbortController().signal);

    const rows = await chapterRows(jobId);
    expect(rows[0].stageState).not.toBe("qa_passed");
    expect(rows[0].stageState).toBe("rewritten");
    expect(actionsOf()).not.toContain("tts");
  }, 30_000);

  it("T6 Resume không lọt chương blocked", async () => {
    scripts = happyScripts(1);
    scripts.rewrite = {
      exit: 30, // needs_review
      emit: async ({ workdir }) => {
        const evs = await writeChapterFiles(
          workdir,
          1,
          "rewritten.txt",
          () => "Bản viết lại chương 1 có fatal error.\n",
          "rewritten",
          "rewritten_text",
        );
        const sidecar = {
          schema_version: "1.0",
          chapter_no: 1,
          text_sha256: sha("Bản viết lại chương 1 có fatal error.\n"),
          chapter_status: "blocked",
          chunks: [],
        };
        await writeFile(
          join(workdir, "chapters", pad4(1), "rewritten.chunks.json"),
          JSON.stringify(sidecar, null, 2),
          "utf-8",
        );
        return [
          { type: "stage_started", stage: "rewrite" },
          ...evs,
          { type: "final", status: "needs_review", summary: "blocked" },
        ];
      },
    };
    const jobId = await newJob();
    await handlerFactory()(jobId, new AbortController().signal);
    expect((await jobRow(jobId))?.state).toBe("needs_review");

    await setJobState({ jobId, state: "running" });
    spawnCalls = [];
    await handlerFactory()(jobId, new AbortController().signal);

    const rows = await chapterRows(jobId);
    expect(rows[0].stageState).toBe("rewritten");
    expect(actionsOf()).not.toContain("tts");
  }, 30_000);
});

