// T4.4 tests — download service + presign: job-scoped, chống cross-job confusion, clamp TTL.
// Offline: fake store/presigner qua overrideR2ForTests. DB thật cho asset rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PRESIGN_MAX_SECONDS,
  PRESIGN_MIN_SECONDS,
  clampPresignTtl,
  fetchAssetBytes,
  presignAssetDownload,
} from "../src/asset-download";
import {
  AssetCorruptError,
  downloadChapterAudioTo,
  fetchVerifiedAssetBytes,
} from "../src/asset-download";
import { chaptersNeedingTts } from "../src/job-repository";
import {
  overrideR2ForTests,
  resolveR2,
  type PresignerLike,
} from "../src/r2-resolver";
import type { ObjectStoreAdapter } from "../src/r2-adapter";
import { createChapterAsset, createJob } from "../src/job-repository";
import { NotFoundError } from "../src/db";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t44Prefix = "https://example.invalid/t44";
let jobId = ""; // job chính (chủ asset)
let otherJobId = ""; // job khác — chống lẫn
let assetId = "";
let audioAssetId = "";

class FakeStore implements ObjectStoreAdapter {
  objects = new Map<string, Buffer>();
  tracked: string[] = [];
  async putObject({ key, body }: { key: string; body: Buffer }) {
    this.objects.set(key, body);
    return { etag: "fake" };
  }
  async headObject(key: string) {
    const b = this.objects.get(key);
    return b ? { size: b.length, etag: "fake" } : null;
  }
  async getObject(key: string) {
    this.tracked.push(`get:${key}`);
    const b = this.objects.get(key);
    return b ? { data: b, contentType: "text/plain" } : null;
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
}

class FakePresigner implements PresignerLike {
  calls: { key: string; expiresIn: number }[] = [];
  async presign(key: string, expiresIn: number): Promise<string> {
    this.calls.push({ key, expiresIn });
    return `https://fake.signed/${key}?X-Amz-Expires=${expiresIn}`;
  }
}

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t44Prefix } } });
  const job = await createJob({ sourceUrl: `${t44Prefix}/main`, adapter: "webnovel-vn" });
  jobId = job.id;
  const other = await createJob({ sourceUrl: `${t44Prefix}/other`, adapter: "webnovel-vn" });
  otherJobId = other.id;

  for (const index of [1, 2]) {
    await raw.chapter.create({
      data: { jobId, index, title: `C${index}`, sourceUrl: `${t44Prefix}/c${index}` },
    });
  }
  const text = await createChapterAsset({
    jobId,
    chapterIndex: 1,
    kind: "rewritten_text",
    objectKey: `jobs/${jobId}/chapters/0001/rewritten.txt`,
    contentType: "text/plain; charset=utf-8",
    size: 5,
    sha256: "a".repeat(64),
  });
  assetId = text.assetId;

  const audio = await createChapterAsset({
    jobId,
    chapterIndex: 2,
    kind: "chapter_audio",
    objectKey: `jobs/${jobId}/chapters/0002/audio/part-000.mp3`,
    contentType: "audio/mpeg",
    size: 9,
    sha256: "b".repeat(64),
  });
  audioAssetId = audio.assetId;
});

afterAll(async () => {
  overrideR2ForTests(null);
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t44Prefix } } });
  await raw.$disconnect();
});

describe("clampPresignTtl — config theo Acceptance 'expires as configured'", () => {
  it("clamp về [30..604800], default 300, garbage → default", () => {
    expect(clampPresignTtl(undefined)).toBe(300);
    expect(clampPresignTtl(1)).toBe(PRESIGN_MIN_SECONDS);
    expect(clampPresignTtl(999_999_999)).toBe(PRESIGN_MAX_SECONDS);
    expect(clampPresignTtl(120)).toBe(120);
    expect(clampPresignTtl(Number.NaN)).toBe(300);
    expect(clampPresignTtl(120.7)).toBe(120);
  });
});

describe("presignAssetDownload / fetchAssetBytes — job-scoped + chống lẫn", () => {
  const store = new FakeStore();
  const presigner = new FakePresigner();

  beforeAll(() => {
    // seed khi jobId đã có (beforeAll file chạy trước beforeAll describe này)
    store.objects.set(`jobs/${jobId}/chapters/0001/rewritten.txt`, Buffer.from("hello"));
    overrideR2ForTests({ store, presigner });
  });

  it("presign đúng namespace + TTL truyền qua; không credentials trong URL", async () => {
    const r = await presignAssetDownload(jobId, assetId, 120);
    expect(r.url).toContain(`jobs/${jobId}/chapters/0001/rewritten.txt`);
    expect(r.url).toContain("X-Amz-Expires=120");
    expect(r.expiresIn).toBe(120);
    expect(r.url).not.toContain("SECRET"); // credentials không bao giờ vào URL
    expect(presigner.calls[0].key).toBe(`jobs/${jobId}/chapters/0001/rewritten.txt`);  });

  it("asset của JOB KHÁC → NotFoundError và presigner/store KHÔNG bị đụng", async () => {
    const presignCalls = presigner.calls.length;
    const getCalls = store.tracked.length;
    await expect(presignAssetDownload(otherJobId, assetId, 60)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(fetchAssetBytes(assetId, otherJobId)).rejects.toBeInstanceOf(NotFoundError);
    expect(presigner.calls.length).toBe(presignCalls);
    expect(store.tracked.length).toBe(getCalls);
  });

  it("asset id lạ → NotFoundError", async () => {
    await expect(presignAssetDownload(jobId, "asset-khong-ton-tai")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("fetchAssetBytes → data + contentType (packager dùng)", async () => {
    const r = await fetchAssetBytes(assetId, jobId);
    expect(r.data.toString()).toBe("hello");
    expect(r.contentType).toBe("text/plain");
    expect(r.objectKey).toBe(`jobs/${jobId}/chapters/0001/rewritten.txt`);
  });

  it("object mất trên storage (asset row còn) → NotFoundError", async () => {
    // audioAssetId trỏ tới object chưa được fake-store cất
    await expect(fetchAssetBytes(audioAssetId, jobId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------- T6.3 — tái dùng audio đã verify: fetchVerified + download + scheduler ----------

let t63Store = new FakeStore();
let t63Dest = "";

describe("T6.3 — tái dùng audio đã verify từ R2", () => {
  let okAssetId = ""; // chapter 3 — audio verified, object trong store, sha khớp
  let tampAssetId = ""; // chapter 4 — object KHÔNG khớp sha (mô phỏng hỏng/bị thay)
  let unverifiedAssetId = ""; // chapter 5 — asset chưa verified

  beforeAll(async () => {
    t63Store = new FakeStore();
    t63Dest = await mkdtemp(join(tmpdir(), "t63-dl-"));

    await raw.chapter.create({
      data: { jobId, index: 3, title: "C3", sourceUrl: `${t44Prefix}/c3` },
    });
    await raw.chapter.create({
      data: { jobId, index: 4, title: "C4", sourceUrl: `${t44Prefix}/c4` },
    });
    await raw.chapter.create({
      data: { jobId, index: 5, title: "C5", sourceUrl: `${t44Prefix}/c5` },
    });

    const body = "mp3-chương-ba-đã-verify";
    const audio3 = await createChapterAsset({
      jobId,
      chapterIndex: 3,
      kind: "chapter_audio",
      objectKey: `jobs/${jobId}/chapters/0003/audio/part-000.mp3`,
      contentType: "audio/mpeg",
      size: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    okAssetId = audio3.assetId;
    t63Store.objects.set(`jobs/${jobId}/chapters/0003/audio/part-000.mp3`, Buffer.from(body));

    const audio4 = await createChapterAsset({
      jobId,
      chapterIndex: 4,
      kind: "chapter_audio",
      objectKey: `jobs/${jobId}/chapters/0004/audio/part-000.mp3`,
      contentType: "audio/mpeg",
      size: 5,
      sha256: "d".repeat(64),
    });
    tampAssetId = audio4.assetId;
    // object thực tế lệch sha row record — coi là hỏng khi tái tải
    t63Store.objects.set(
      `jobs/${jobId}/chapters/0004/audio/part-000.mp3`,
      Buffer.from("đã-bị-thay-đổi"),
    );

    const audio5 = await createChapterAsset({
      jobId,
      chapterIndex: 5,
      kind: "chapter_audio",
      objectKey: `jobs/${jobId}/chapters/0005/audio/part-000.mp3`,
      contentType: "audio/mpeg",
      size: 3,
      sha256: "e".repeat(64),
      verified: false,
    });
    unverifiedAssetId = audio5.assetId;

    overrideR2ForTests({ store: t63Store, presigner: new FakePresigner() });
  });

  afterAll(() => {
    overrideR2ForTests(null);
    void rm(t63Dest, { recursive: true, force: true });
  });

  it("fetchVerifiedAssetBytes → bytes + sha256 khớp bản đã record", async () => {
    const r = await fetchVerifiedAssetBytes(okAssetId, jobId);
    expect(r.data.toString()).toBe("mp3-chương-ba-đã-verify");
    expect(r.sha256).toBe(createHash("sha256").update("mp3-chương-ba-đã-verify").digest("hex"));
  });

  it("object rõ là hỏng: sha TẢI VỀ ≠ sha baseline đã lưu → AssetCorruptError", async () => {
    await expect(fetchVerifiedAssetBytes(tampAssetId, jobId)).rejects.toBeInstanceOf(
      AssetCorruptError,
    );
  });

  it("asset chưa verified → NotFoundError (không tái dùng), object không bị đụng", async () => {
    await expect(fetchVerifiedAssetBytes(unverifiedAssetId, jobId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(t63Store.objects.has(`jobs/${jobId}/chapters/0005/audio/part-000.mp3`)).toBe(false);
  });

  it("downloadChapterAudioTo — ghi file audio-0003.mp3 vào destDir, đúng nội dung", async () => {
    const r = await downloadChapterAudioTo(jobId, 3, t63Dest);
    expect(r.localPath).toBe(join(t63Dest, "audio-0003.mp3"));
    expect((await readFile(r.localPath)).length).toBe(
      Buffer.byteLength("mp3-chương-ba-đã-verify"),
    );
    expect(r.sha256).toBe(createHash("sha256").update("mp3-chương-ba-đã-verify").digest("hex"));
  });

  it("chapter chưa có audio (chapter 1) → NotFoundError — scheduler phải gọi lại TTS, không im lặng", async () => {
    await expect(downloadChapterAudioTo(jobId, 1, t63Dest)).rejects.toThrow(/chưa có audio/);
  });

  it("chaptersNeedingTts — chỉ qa_passed và chưa có audio, xếp tăng dần", async () => {
    await raw.chapter.update({
      where: { jobId_index: { jobId, index: 1 } },
      data: { stageState: "qa_passed" },
    });
    await raw.chapter.update({
      where: { jobId_index: { jobId, index: 2 } },
      data: { stageState: "discovered" },
    });
    await raw.chapter.update({
      where: { jobId_index: { jobId, index: 3 } },
      data: { stageState: "tts_done" },
    });
    expect(await chaptersNeedingTts(jobId)).toEqual([1]); // 2 chưa qa_passed; 3 đã có audio
  });
});

// ---------- routes — /download-url và /download (T4.4) ----------
describe("routes — /download-url và /download", () => {
  const store = new FakeStore();
  const presigner = new FakePresigner();

  beforeAll(() => {
    store.objects.set(`jobs/${jobId}/chapters/0001/rewritten.txt`, Buffer.from("ui-bytes"));
    overrideR2ForTests({ store, presigner });
  });

  it("GET download-url → 200 {url, expiresIn}; expiresIn=lá góc→clamp", async () => {
    const { buildApp } = await import("../src/app");
    const app = buildApp({ logger: false });
    const r = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/assets/${assetId}/download-url?expires_in=5`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().expiresIn).toBe(PRESIGN_MIN_SECONDS);
    expect(r.json().url).toBeTruthy();
    await app.close();
  });

  it("GET download → bytes với Content-Type đúng", async () => {
    const { buildApp } = await import("../src/app");
    const app = buildApp({ logger: false });
    const r = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/assets/${assetId}/download`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/plain");
    expect(r.body).toBe("ui-bytes");
    await app.close();
  });

  it("asset lạ → 404 NOT_FOUND", async () => {
    const { buildApp } = await import("../src/app");
    const app = buildApp({ logger: false });
    const r = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/assets/nope/download-url`,
    });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it("R2 chưa cấu hình → 503 R2_UNAVAILABLE (không crash app)", async () => {
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    overrideR2ForTests(null); // resolved thật → config thiếu → R2UnavailableError
    try {
      const { buildApp } = await import("../src/app");
      const app = buildApp({ logger: false });
      const r = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}/assets/${assetId}/download-url`,
      });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe("R2_UNAVAILABLE");
      await app.close();
    } finally {
      Object.assign(process.env, savedEnv);
      overrideR2ForTests(null);
    }
  });
});
