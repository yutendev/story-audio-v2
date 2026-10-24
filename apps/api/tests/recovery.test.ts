// T9.2 tests — failure-injection / resume: kill giữa stage, kill giữa upload,
// corrupt file local tạm, chờ quota + duplicate start. Offline hoàn toàn:
// store = InMemory, ffprobe qua seam, DB = PostgreSQL dev thật.
// Acceptance: (1) stage đã xong không chạy lại; (2) asset chưa verify trọn vẹn
// không bao giờ được đánh verified; (3) job luôn về một state nhất quán.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { buildApp } from "../src/app";
import { claimNextJob, requeueOrphanedJobs } from "../src/queue";
import {
  chaptersNeedingTts,
  createChapterAsset,
  createJob,
  persistWorkerEvents,
} from "../src/job-repository";
import { storeChapterAudio, type FfprobeRunner } from "../src/audio-verify";
import { UploadVerifyError } from "../src/asset-service";
import { preparePackageBuild } from "../src/package-build";
import { planJobPackages } from "../src/pkg-groups";
import { updatePackagingSettings } from "../src/pkg-settings";
import type { ObjectStoreAdapter } from "../src/r2-adapter";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t92Prefix = "https://example.invalid/t92";
let app: Awaited<ReturnType<typeof buildApp>>;
let workdir = "";
let jobStage = ""; // test 1: kill giữa stage TTS
let jobUpload = ""; // test 2: kill giữa chừng upload
let jobPackage = ""; // test 3: corrupt file local
let jobQuota = ""; // test 4: quota wait + duplicate start

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

class InMemoryStore implements ObjectStoreAdapter {
  objects = new Map<string, Buffer>();
  calls: { put: number; head: number; delete: number } = { put: 0, head: 0, delete: 0 };

  async putObject({ key, body }: { key: string; body: Buffer }) {
    this.calls.put++;
    this.objects.set(key, body);
    return { etag: `"${createHash("md5").update(body).digest("hex")}"` };
  }

  async headObject(key: string) {
    this.calls.head++;
    const b = this.objects.get(key);
    if (!b) return null;
    return { size: b.length, etag: `"${createHash("md5").update(b).digest("hex")}"` };
  }

  async getObject(key: string) {
    const b = this.objects.get(key);
    return b ? { data: b, contentType: "application/octet-stream" } : null;
  }

  async deleteObject(key: string) {
    this.calls.delete++;
    this.objects.delete(key);
  }
}

/** put OK nhưng head trả etag SAI (mô phỏng object bay giữa chừng / verify lệch). */
class BadHeadStore extends InMemoryStore {
  async headObject(): Promise<{ size: number; etag: string } | null> {
    this.calls.head++;
    return { size: 999, etag: `"etag-khong-khop"` };
  }
}

const okProbe: FfprobeRunner = async () => ({
  status: "ran",
  code: 0,
  stdout: JSON.stringify({ format: { duration: "120.5", format_name: "mp3" } }),
  stderr: "",
});

async function jobState(jobId: string): Promise<string> {
  const j = await raw.job.findUniqueOrThrow({ where: { id: jobId }, select: { state: true } });
  return j.state;
}

async function stageOf(jobId: string, index: number): Promise<string> {
  const c = await raw.chapter.findUniqueOrThrow({
    where: { jobId_index: { jobId, index } },
    select: { stageState: true },
  });
  return c.stageState;
}

async function setChapterStage(jobId: string, index: number, stage: string): Promise<void> {
  await raw.chapter.update({
    where: { jobId_index: { jobId, index } },
    data: { stageState: stage as never },
  });
}

/** Seed audio verified đúng bất biến production: asset + CON TRỎ qua createChapterAsset. */
async function seedAudio(jobId: string, index: number, store: InMemoryStore): Promise<Buffer> {
  const body = Buffer.from(`mp3-chuong-${index}-${jobId.slice(-4)}`);
  const key = `jobs/${jobId}/chapters/${String(index).padStart(4, "0")}/audio/part-000.mp3`;
  store.objects.set(key, body);
  await createChapterAsset({
    jobId,
    chapterIndex: index,
    kind: "chapter_audio",
    objectKey: key,
    contentType: "audio/mpeg",
    size: body.length,
    sha256: sha(body),
  });
  return body;
}

async function audioCount(jobId: string): Promise<number> {
  return raw.asset.count({ where: { jobId, kind: "chapter_audio" } });
}

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t92Prefix } } });
  app = await buildApp();
  workdir = await mkdtemp(join(tmpdir(), "t92-"));
  const mk = async (tag: string, chapterCount: number): Promise<string> => {
    const job = await createJob({ sourceUrl: `${t92Prefix}/${tag}`, adapter: "webnovel-vn" });
    for (let index = 1; index <= chapterCount; index++) {
      await raw.chapter.create({
        data: {
          jobId: job.id,
          index,
          title: `Chương ${index} (${tag})`,
          sourceUrl: `${t92Prefix}/${tag}/${index}`,
        },
      });
    }
    return job.id;
  };
  jobStage = await mk("stage", 3);
  jobUpload = await mk("upload", 1);
  jobPackage = await mk("package", 1);
  jobQuota = await mk("quota", 0);
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
  await raw.job.deleteMany({
    where: { sourceUrl: { startsWith: t92Prefix } },
  });
  await raw.$disconnect();
});

describe("T9.2.1 — kill sau stage: chương xong không chạy lại, job về state nhất quán", () => {
  it("requeue orphan → chỉ chương 2,3 cần TTS; TTS lại chương 2 → fast path không duplicate", async () => {
    // c1 đã TTS xong (tts_done + audio verified có con trỏ); c2/c3 chờ TTS (qa_passed)
    const store = new InMemoryStore();
    await seedAudio(jobStage, 1, store);
    await setChapterStage(jobStage, 1, "tts_done");
    await setChapterStage(jobStage, 2, "qa_passed");
    await setChapterStage(jobStage, 3, "qa_passed");

    // mô phỏng crash: job đang running, process chết → orphan
    await raw.job.update({ where: { id: jobStage }, data: { state: "running" } });
    const requeued = await requeueOrphanedJobs();
    expect(requeued).toBeGreaterThanOrEqual(1); // job này được requeue (job khác có thể xen giữa)
    expect(await jobState(jobStage)).toBe("queued");

    // stage durability: chương đã verified không bị hẹn TTS lại
    expect(await chaptersNeedingTts(jobStage)).toEqual([2, 3]);

    // resume xử lý chương 2: TTS + upload + verify → tts_done
    await writeFile(join(workdir, "t92-c2.mp3"), Buffer.from("mp3-chuong-2-noi-dung"));
    const first = await storeChapterAudio({
      jobId: jobStage,
      chapterIndex: 2,
      workdir,
      relativePath: "t92-c2.mp3",
      store,
      ffprobe: okProbe,
      cleanupLocal: false,
    });
    expect(await chaptersNeedingTts(jobStage)).toEqual([3]);

    // chạy lại chương 2 với CÙNG nội dung (crash lần 2 ngay sau tts_done):
    // fast path trả lại asset cũ — KHÔNG tạo dòng asset thứ hai
    const again = await storeChapterAudio({
      jobId: jobStage,
      chapterIndex: 2,
      workdir,
      relativePath: "t92-c2.mp3",
      store,
      ffprobe: okProbe,
      cleanupLocal: false,
    });
    expect(again.assetId).toBe(first.assetId);
    expect(await audioCount(jobStage)).toBe(2); // c1 + c2, không duplicate
  });
});

describe("T9.2.2 — kill giữa upload: asset incomplete không bao giờ được đánh verified", () => {
  it("head-verify fail → UploadVerifyError, 0 asset, stage giữ nguyên, orphan bị xóa; chạy lại lành", async () => {
    await setChapterStage(jobUpload, 1, "qa_passed");
    await writeFile(join(workdir, "t92-b1.mp3"), Buffer.from("mp3-chuong-1-noi-dung"));

    const badStore = new BadHeadStore(); // put OK nhưng head luôn lệch etag
    await expect(
      storeChapterAudio({
        jobId: jobUpload,
        chapterIndex: 1,
        workdir,
        relativePath: "t92-b1.mp3",
        store: badStore,
        ffprobe: okProbe,
        cleanupLocal: false,
      }),
    ).rejects.toThrow(UploadVerifyError);

    // KHÔNG ghi asset (verified hay không) — con trỏ không đổi, stage không advance
    expect(await audioCount(jobUpload)).toBe(0);
    expect(await stageOf(jobUpload, 1)).toBe("qa_passed");
    // object mồ côi đã bị dọn khỏi store — R2 không tích dữ liệu rác
    expect(badStore.objects.size).toBe(0);
    expect(badStore.calls.delete).toBeGreaterThanOrEqual(1);

    // mạng lành lại → chạy tiếp: upload trọn vẹn mới được verify + tts_done
    const goodStore = new InMemoryStore();
    const ok = await storeChapterAudio({
      jobId: jobUpload,
      chapterIndex: 1,
      workdir,
      relativePath: "t92-b1.mp3",
      store: goodStore,
      ffprobe: okProbe,
      cleanupLocal: false,
    });
    expect(ok.assetId).toBeTruthy();
    expect(await stageOf(jobUpload, 1)).toBe("tts_done");
    const asset = await raw.asset.findFirstOrThrow({
      where: { jobId: jobUpload, kind: "chapter_audio" },
      select: { verified: true, sha256: true },
    });
    expect(asset.verified).toBe(true);
  });
});

describe("T9.2.3 — corrupt file local tạm: packager tự chữa từ R2 (sha-verified)", () => {
  it("part local hỏng → prepare lại tải mới trọn vẹn, manifest không dùng rác", async () => {
    await updatePackagingSettings(jobPackage, { chaptersPerBook: 30 });
    const store = new InMemoryStore();
    const original = await seedAudio(jobPackage, 1, store);
    const plan = await planJobPackages(jobPackage);
    expect(plan.packages).toHaveLength(1);

    await preparePackageBuild(jobPackage, 1, workdir, { store });
    const part1 = join(workdir, "packages", "0001", "parts", "audio-0001.mp3");
    expect((await readFile(part1)).equals(original)).toBe(true);

    // hỏng local (mô phỏng đĩa/crash giữa ghi) + đánh dấu failed như runner boot
    await writeFile(part1, Buffer.from("noi-dung-hong-khong-phai-audio"));
    await raw.bookPackage.update({
      where: { jobId_sequence: { jobId: jobPackage, sequence: 1 } },
      data: { state: "failed" },
    });

    const again = await preparePackageBuild(jobPackage, 1, workdir, { store });
    expect(again.chapters.map((c) => [c.no, c.audio])).toEqual([
      [1, "packages/0001/parts/audio-0001.mp3"],
    ]);
    // download lại LUÔN qua R2 verified → nội dung local được chữa trọn vẹn
    expect((await readFile(part1)).equals(original)).toBe(true);
    const pkg = await raw.bookPackage.findUniqueOrThrow({
      where: { jobId_sequence: { jobId: jobPackage, sequence: 1 } },
      select: { state: true },
    });
    expect(pkg.state).toBe("building");
  });
});

describe("T9.2.4 — quota wait durable + replay an toàn + duplicate start bị từ chối", () => {
  it("quota_wait → waiting_quota + notBefore; replay không đổi; claim nhặt đúng luật; duplicate start no-op an toàn", async () => {
    await raw.job.update({ where: { id: jobQuota }, data: { state: "running" } });
    const notBefore = new Date(Date.now() + 60_000).toISOString();
    const batch = [
      { protocol: "1", type: "progress", seq: 1, job_id: jobQuota, stage: "rewrite", done: 1, total: 3 },
      {
        protocol: "1",
        type: "quota_wait",
        seq: 2,
        job_id: jobQuota,
        backend: "gemini",
        not_before: notBefore,
      },
    ];

    const first = await persistWorkerEvents(jobQuota, batch);
    expect(first.rejected).toHaveLength(0);
    const job1 = await raw.job.findUniqueOrThrow({ where: { id: jobQuota } });
    expect(job1.state).toBe("waiting_quota");
    expect(job1.notBefore?.getTime()).toBeGreaterThan(Date.now());

    // replay cùng batch (at-least-once): không lỗi, state + notBefore giữ nguyên
    const replay = await persistWorkerEvents(jobQuota, batch);
    expect(replay.rejected).toHaveLength(0);
    expect(replay.persisted).toBe(0);
    expect(replay.duplicate).toBe(2);
    const job2 = await raw.job.findUniqueOrThrow({ where: { id: jobQuota } });
    expect(job2.state).toBe("waiting_quota");
    expect(job2.notBefore?.toISOString()).toBe(notBefore);

    // chưa tới notBefore → claim KHÔNG được nhặt job đang chờ quota
    // (claim quét cả DB — chỉ cấm NHẬT job này, job lạ của file test khác không cản)
    const claimed = await claimNextJob();
    if (claimed) expect(claimed.id).not.toBe(jobQuota);

    // user chủ động resume → running; duplicate start (resume lần nữa CÙNG state)
    // là no-op an toàn theo T2.5 (replay idempotent, assertTransition cho phép to===from)
    // — job về đúng state nhất quán, KHÔNG chạy kép; terminal khác state → 409
    // đã phủ ở job-controls.test.ts (resume canceled → 409)
    const res1 = await app.inject({ method: "POST", url: `/api/jobs/${jobQuota}/resume` });
    expect(res1.statusCode).toBe(200);
    expect(await jobState(jobQuota)).toBe("running");
    const res2 = await app.inject({ method: "POST", url: `/api/jobs/${jobQuota}/resume` });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ jobId: jobQuota, resumed: true });
    expect(await jobState(jobQuota)).toBe("running");
  });
});
