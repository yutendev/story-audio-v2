// T6.2 tests — storeChapterAudio: probe ffprobe (seam), 0-byte/corrupt từ chối,
// upload hỏng không ghi tts_done, chạy lại lưu được không cần tái synth.
// Store = InMemory fake; DB = PostgreSQL dev thật; ffprobe luôn qua seam (offline).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  storeChapterAudio,
  probeAudio,
  markChapterAudioDone,
  AudioInvalidError,
  type FfprobeRunner,
} from "../src/audio-verify";
import { UploadVerifyError } from "../src/asset-service";
import { createJob } from "../src/job-repository";
import { InvalidTransitionError } from "../src/state-machine";
import type { ObjectStoreAdapter } from "../src/r2-adapter";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t62Prefix = "https://example.invalid/t62";
let jobId = "";
let workdir = "";

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

class ThrowingPutStore extends InMemoryStore {
  async putObject(): Promise<{ etag: string }> {
    throw new Error("mạng đứt giữa chừng");
  }
}

// ffprobe fake: đọc được duration 259.5s cho "audio hợp lệ" (offline — không chạm binary)
const okProbe: FfprobeRunner = async () => ({
  status: "ran",
  code: 0,
  stdout: JSON.stringify({ format: { duration: "259.5", format_name: "mp3" } }),
  stderr: "",
});

const corruptProbe: FfprobeRunner = async () => ({
  status: "ran",
  code: 1,
  stdout: "",
  stderr: "Invalid data found when processing input",
});

const missingProbe: FfprobeRunner = async () => ({ status: "missing" });

const brokenProbe: FfprobeRunner = async () => ({ status: "error", message: "ffprobe treo" });

async function setStage(index: number, stage: "qa_passed" | "discovered") {
  await raw.chapter.update({
    where: { jobId_index: { jobId, index } },
    data: { stageState: stage },
  });
}

async function stageOf(index: number): Promise<string> {
  const c = await raw.chapter.findUniqueOrThrow({
    where: { jobId_index: { jobId, index } },
  });
  return c.stageState;
}

async function audioAssetIdOf(index: number): Promise<string | null> {
  const c = await raw.chapter.findUniqueOrThrow({
    where: { jobId_index: { jobId, index } },
    select: { audioAssetId: true },
  });
  return c.audioAssetId;
}

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t62Prefix } } });
  const job = await createJob({
    sourceUrl: `${t62Prefix}/truyen`,
    adapter: "webnovel-vn",
  });
  jobId = job.id;
  for (const index of [1, 2, 3, 4, 5]) {
    await raw.chapter.create({
      data: { jobId, index, title: `C${index}`, sourceUrl: `${t62Prefix}/${index}` },
    });
  }
  workdir = await mkdtemp(join(tmpdir(), "t62-work-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
  await raw.job.deleteMany({ where: { id: jobId } });
  await raw.$disconnect();
});

describe("probeAudio — semantic của ProbeRun", () => {
  it("ffprobe vắng → null (where available), không chặn pipeline", async () => {
    expect(await probeAudio("whatever", missingProbe)).toBeNull();
  });

  it("duration 0 / NaN / stdout rác / rc≠0 → AudioInvalidError", async () => {
    const zero: FfprobeRunner = async () => ({
      status: "ran",
      code: 0,
      stdout: JSON.stringify({ format: { duration: "0", format_name: "mp3" } }),
      stderr: "",
    });
    const nan: FfprobeRunner = async () => ({
      status: "ran",
      code: 0,
      stdout: JSON.stringify({ format: { duration: "không phải số" } }),
      stderr: "",
    });
    const junk: FfprobeRunner = async () => ({ status: "ran", code: 0, stdout: "junk", stderr: "" });
    await expect(probeAudio("x", zero)).rejects.toThrow(AudioInvalidError);
    await expect(probeAudio("x", nan)).rejects.toThrow(AudioInvalidError);
    await expect(probeAudio("x", junk)).rejects.toThrow(AudioInvalidError);
    await expect(probeAudio("x", corruptProbe)).rejects.toThrow(/audio bị hỏng/);
  });

  it("spawn lỗi khác → AudioInvalidError nói rõ", async () => {
    await expect(probeAudio("x", brokenProbe)).rejects.toThrow(/ffprobe không chạy được/);
  });
});

describe("storeChapterAudio — luồng hợp lệ", () => {
  it("qa_passed → probe → upload+verify+record → chapter tts_done (AFTER verify)", async () => {
    await setStage(1, "qa_passed");
    await writeFile(join(workdir, "audio-1.mp3"), "fake-real-mp3-bytes", "utf-8");
    const store = new InMemoryStore();

    const r = await storeChapterAudio({
      jobId,
      chapterIndex: 1,
      workdir,
      relativePath: "audio-1.mp3",
      store,
      ffprobe: okProbe,
    });

    expect(r.probe).toEqual({ durationSec: 259.5, format: "mp3" });
    // quy ước key T4.2: mp3 ghép 1 file/part hơn → part 0
    expect(r.objectKey).toBe(`jobs/${jobId}/chapters/0001/audio/part-000.mp3`);
    expect(store.objects.get(r.objectKey)?.toString()).toBe("fake-real-mp3-bytes");
    const asset = await raw.asset.findUniqueOrThrow({ where: { id: r.assetId } });
    expect(asset.verified).toBe(true);
    expect(asset.sha256).toBe(createHash("sha256").update("fake-real-mp3-bytes").digest("hex"));
    expect(asset.contentType).toBe("audio/mpeg");
    expect(await stageOf(1)).toBe("tts_done");
  });

  it("ffprobe vắng trên máy → probe null nhưng upload+record+tts_done vẫn xong", async () => {
    await setStage(2, "qa_passed");
    await writeFile(join(workdir, "audio-2.mp3"), "audio hai", "utf-8");
    const store = new InMemoryStore();

    const r = await storeChapterAudio({
      jobId,
      chapterIndex: 2,
      workdir,
      relativePath: "audio-2.mp3",
      store,
      ffprobe: missingProbe,
    });

    expect(r.probe).toBeNull();
    expect(store.calls.put).toBe(1);
    expect(await stageOf(2)).toBe("tts_done");
  });

  it("chạy lại cùng sha → fast path T4.3, không upload thứ hai, stage idempotent", async () => {
    await setStage(3, "qa_passed");
    await writeFile(join(workdir, "audio-3.mp3"), "audio ba", "utf-8");
    const store = new InMemoryStore();
    const opts = {
      jobId,
      chapterIndex: 3,
      workdir,
      relativePath: "audio-3.mp3",
      store,
      ffprobe: okProbe,
      cleanupLocal: false, // test fast-path giữ file; cleanup được test riêng (T6.3)
    };
    await storeChapterAudio(opts);
    await storeChapterAudio(opts);
    expect(store.calls.put).toBe(1); // lần 2 fast path — không tái upload
    expect(await stageOf(3)).toBe("tts_done");
  });
});

describe("storeChapterAudio — từ chối không ship rác", () => {
  it("0 byte → AudioInvalidError TRƯỚC upload; không asset, chapter giữ qa_passed", async () => {
    await setStage(4, "qa_passed");
    await writeFile(join(workdir, "audio-empty.mp3"), "", "utf-8");
    const store = new InMemoryStore();

    await expect(
      storeChapterAudio({
        jobId,
        chapterIndex: 4,
        workdir,
        relativePath: "audio-empty.mp3",
        store,
        ffprobe: okProbe,
      }),
    ).rejects.toThrow(/0 byte/);

    expect(store.calls.put).toBe(0);
    expect(await audioAssetIdOf(4)).toBeNull();
    expect(await stageOf(4)).toBe("qa_passed");
  });

  it("audio hỏng (probe rc≠0) → từ chối TRƯỚC upload; không có upload nào xảy ra", async () => {
    await writeFile(join(workdir, "audio-corrupt.mp3"), "rác không phải mp3", "utf-8");
    const store = new InMemoryStore();
    await setStage(4, "qa_passed");

    await expect(
      storeChapterAudio({
        jobId,
        chapterIndex: 4,
        workdir,
        relativePath: "audio-corrupt.mp3",
        store,
        ffprobe: corruptProbe,
      }),
    ).rejects.toThrow(AudioInvalidError);
    expect(store.calls.put).toBe(0);
  });

  it("upload đứt lần 1 → UploadVerifyError, KHÔNG ghi asset tts_done; audio local còn nguyên; chạy lại lưu được", async () => {
    await setStage(5, "qa_passed"); // chapter 5 sạch — chưa có asset nào (không rơi fast path)
    const file = join(workdir, "audio-5.mp3");
    await writeFile(file, "audio năm", "utf-8");
    const before = await readFile(file);

    await expect(
      storeChapterAudio({
        jobId,
        chapterIndex: 5,
        workdir,
        relativePath: "audio-5.mp3",
        store: new ThrowingPutStore(),
        ffprobe: okProbe,
      }),
    ).rejects.toThrow(UploadVerifyError);

    expect(await stageOf(5)).toBe("qa_passed"); // verify chưa xong → chưa đánh dấu
    expect(await audioAssetIdOf(5)).toBeNull();
    expect(await readFile(file)).toEqual(before); // audio hợp lệ không bị hủy khi upload đứt

    // chạy lại ngay với store khỏe — cùng file (worker KHÔNG tái synth) → thành công
    const store = new InMemoryStore();
    const r = await storeChapterAudio({
      jobId,
      chapterIndex: 5,
      workdir,
      relativePath: "audio-5.mp3",
      store,
      ffprobe: okProbe,
    });
    expect(store.calls.put).toBe(1);
    expect(await stageOf(5)).toBe("tts_done");
    expect(r.assetId.length).toBeGreaterThan(0);
  });

  it("relativePath trốn workdir → từ chối", async () => {
    await expect(
      storeChapterAudio({
        jobId,
        chapterIndex: 1,
        workdir,
        relativePath: "../audio-ngoai.mp3",
        store: new InMemoryStore(),
        ffprobe: okProbe,
      }),
    ).rejects.toThrow(AudioInvalidError);
  });
});

describe("markChapterAudioDone — guard state machine", () => {
  it("chapter không ở qa_passed (discovered) → InvalidTransition, stage giữ nguyên", async () => {
    await setStage(4, "discovered");
    await expect(markChapterAudioDone(jobId, 4)).rejects.toThrow(InvalidTransitionError);
    expect(await stageOf(4)).toBe("discovered");
  });

  it("chapter không thuộc job → NotFoundError", async () => {
    await expect(markChapterAudioDone(jobId, 999)).rejects.toThrow(/không thuộc job/);
  });
});

describe("T6.3 — không tích lũy file local mỗi chương", () => {
  it("sau khi R2 verified → audio local bị xóa (cleanup mặc định)", async () => {
    await setStage(4, "qa_passed");
    const file = join(workdir, "audio-clean.mp3");
    await writeFile(file, "audio sẽ dọn sau verify", "utf-8");
    const store = new InMemoryStore();

    await storeChapterAudio({
      jobId,
      chapterIndex: 4,
      workdir,
      relativePath: "audio-clean.mp3",
      store,
      ffprobe: okProbe,
    });

    expect(store.calls.put).toBe(1);
    expect(await stat(file).then(() => true, () => false)).toBe(false); // local đã dọn
    expect(await stageOf(4)).toBe("tts_done"); // thành công như thường
  });
});
