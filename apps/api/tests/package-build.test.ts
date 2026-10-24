// T7.3 tests — Node glue đóng gói: prepare (claim + tải audio verified + manifest),
// finish (upload/verify/record m4b → ready; sai file → failed, không bao giờ ready).
// Store = InMemory fake; DB = PostgreSQL dev thật; ffmpeg là việc của worker (không đụng).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { planJobPackages, getJobPackages } from "../src/pkg-groups";
import { preparePackageBuild, finishPackageBuild } from "../src/package-build";
import type { ObjectStoreAdapter } from "../src/r2-adapter";
import { UploadVerifyError } from "../src/asset-service";
import { createChapterAsset, createJob } from "../src/job-repository";
import { updatePackagingSettings } from "../src/pkg-settings";
import { ConflictError } from "../src/db";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t73Prefix = "https://example.invalid/t73";
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

/** Seed audio chương đúng BẤT BIẾN production: tạo asset + gắn CON TRỎ
 * Chapter.audioAssetId (như createChapterAsset) — download tra qua con trỏ này. */
async function seedChapterAudio(index: number, store: InMemoryStore): Promise<void> {
  const body = Buffer.from(`mp3-chapter-${index}`);
  const objectKey = `jobs/${jobId}/chapters/${String(index).padStart(4, "0")}/audio/part-000.mp3`;
  store.objects.set(objectKey, body);
  await createChapterAsset({
    jobId,
    chapterIndex: index,
    kind: "chapter_audio",
    objectKey,
    contentType: "audio/mpeg",
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
}

function bookKey(sequence: number): string {
  return `jobs/${jobId}/packages/${String(sequence).padStart(4, "0")}/book.m4b`;
}

function bookLocal(sequence: number): string {
  return join(workdir, "packages", String(sequence).padStart(4, "0"), "book.m4b");
}

async function setState(sequence: number, state: string): Promise<void> {
  await raw.bookPackage.update({
    where: { jobId_sequence: { jobId, sequence } },
    data: { state: state as never },
  });
}

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t73Prefix } } });
  const job = await createJob({ sourceUrl: `${t73Prefix}/truyen`, adapter: "webnovel-vn" });
  jobId = job.id;
  for (const index of [1, 2, 3]) {
    await raw.chapter.create({
      data: { jobId, index, title: `Chương ${index}`, sourceUrl: `${t73Prefix}/${index}` },
    });
  }
  await updatePackagingSettings(jobId, { chaptersPerBook: 30 }); // 1 gói chứa cả 3
  workdir = await mkdtemp(join(tmpdir(), "t73n-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
  await raw.job.deleteMany({ where: { id: jobId } });
  await raw.$disconnect();
});

describe("preparePackageBuild — claim + tải audio verified + manifest", () => {
  it("prepare: pending → building, tải đủ parts/, manifest đúng chapters + title", async () => {
    const store = new InMemoryStore();
    for (const index of [1, 2, 3]) await seedChapterAudio(index, store);
    const plan = await planJobPackages(jobId); // tạo BookPackage seq 1 [1..3]
    expect(plan.packages).toHaveLength(1);

    const p = await preparePackageBuild(jobId, 1, workdir, { store });
    expect(p.sequence).toBe(1);
    expect(p.bookRelPath).toBe("packages/0001/book.m4b");
    expect(p.chapters.map((c) => [c.no, c.title, c.audio])).toEqual([
      [1, "Chương 1", "packages/0001/parts/audio-0001.mp3"],
      [2, "Chương 2", "packages/0001/parts/audio-0002.mp3"],
      [3, "Chương 3", "packages/0001/parts/audio-0003.mp3"],
    ]);
    for (const c of p.chapters) {
      const local = await readFile(join(workdir, c.audio));
      expect(local.equals(Buffer.from(`mp3-chapter-${c.no}`))).toBe(true);
    }
    const manifest = JSON.parse(
      await readFile(join(workdir, "packages", "0001", "manifest.json"), "utf-8"),
    );
    expect(manifest).toMatchObject({ sequence: 1 });
    expect(manifest.chapters).toHaveLength(3);
    expect(manifest.chapters[2].audio).toBe("packages/0001/parts/audio-0003.mp3");
    const row = (await getJobPackages(jobId))[0];
    expect(row.state).toBe("building");
  });

  it("prepare lần nữa khi đang building → ConflictError (không claim chồng)", async () => {
    const store = new InMemoryStore();
    await expect(preparePackageBuild(jobId, 1, workdir, { store })).rejects.toThrow(ConflictError);
  });

  it("chapter rơi khỏi DB sau khi đã plan → NotFound + state failed (không nuốt im lặng)", async () => {
    // KHÔNG seed asset: prepare chặn thiếu chương TRƯỚC bước download (rẻ + không trùng seed)
    const store = new InMemoryStore();
    await setState(1, "pending");
    await raw.chapter.delete({ where: { jobId_index: { jobId, index: 2 } } });
    await expect(preparePackageBuild(jobId, 1, workdir, { store })).rejects.toThrow(/thiếu.*2/);
    expect((await getJobPackages(jobId))[0].state).toBe("failed");
  });
});

describe("finishPackageBuild — upload/verify/record m4b → ready", () => {
  let store: InMemoryStore;

  beforeAll(async () => {
    store = new InMemoryStore();
    await setState(1, "building");
    // chapter 2 đã xóa ở describe trên — finish KHÔNG đọc chapters, chỉ file/building state
  });

  it("file m4b hụt/0 byte → ValidationError message + state failed (KHÔNG BAO GIỜ ready)", async () => {
    await rm(bookLocal(1), { force: true });
    await expect(finishPackageBuild(jobId, 1, workdir, { store })).rejects.toThrow(/0 byte|không tồn tại/);
    expect((await getJobPackages(jobId))[0].state).toBe("failed");

    await setState(1, "building");
    await writeFile(bookLocal(1), Buffer.alloc(0));
    await expect(finishPackageBuild(jobId, 1, workdir, { store })).rejects.toThrow(/0 byte/);
    expect((await getJobPackages(jobId))[0].state).toBe("failed");
  });

  it("happy path: upload → verify → record asset m4b (verified) → ready; local bị dọn; audio nguồn R2 còn nguyên", async () => {
    await setState(1, "building");
    const audioCountBefore = await raw.asset.count({ where: { jobId, kind: "chapter_audio" } });
    const body = Buffer.from("m4b-that-lap-roi-verify");
    await writeFile(bookLocal(1), body);

    const r = await finishPackageBuild(jobId, 1, workdir, { store, cleanupLocal: true });
    expect(r.objectKey).toBe(bookKey(1));
    expect(r.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    const asset = await raw.asset.findUniqueOrThrow({ where: { id: r.assetId } });
    expect(asset.kind).toBe("m4b");
    expect(asset.verified).toBe(true);
    expect(asset.packageId).toBe((await getJobPackages(jobId))[0].id);
    expect(store.objects.get(bookKey(1))?.equals(body)).toBe(true);
    expect((await getJobPackages(jobId))[0].state).toBe("ready");
    // chính sách §7: audio nguồn giữ nguyên trên R2; book.m4b local bị dọn sau verify
    expect(await raw.asset.count({ where: { jobId, kind: "chapter_audio" } })).toBe(audioCountBefore);
    await expect(readFile(bookLocal(1))).rejects.toThrow();
  });

  it("upload đứt → UploadVerifyError, state failed, không có asset m4b nào", async () => {
    await setState(1, "building");
    await writeFile(bookLocal(1), "bytes khác sha cũ");
    await expect(
      finishPackageBuild(jobId, 1, workdir, { store: new ThrowingPutStore() }),
    ).rejects.toThrow(UploadVerifyError);
    expect((await getJobPackages(jobId))[0].state).toBe("failed");
    // happy path đã record 1 asset m4b (content cũ) — upload đứt KHÔNG đổi nó
    const after = await raw.asset.findFirstOrThrow({ where: { jobId, kind: "m4b" } });
    expect(after.sha256).toBe(createHash("sha256").update("m4b-that-lap-roi-verify").digest("hex"));
  });

  it("finish khi package KHÔNG ở building (ready) → ConflictError", async () => {
    await writeFile(bookLocal(1), "nội dung mới hơn nữa");
    await expect(finishPackageBuild(jobId, 1, workdir, { store })).rejects.toThrow(ConflictError);
  });

  it("re-run cùng sha (state về building) → fast path: không upload lại, asset id giữ nguyên", async () => {
    const before = await raw.asset.findFirstOrThrow({ where: { jobId, kind: "m4b" } });
    const putsBefore = store.calls.put;
    await setState(1, "building");
    await writeFile(bookLocal(1), Buffer.from("m4b-that-lap-roi-verify"));
    const r = await finishPackageBuild(jobId, 1, workdir, { store, cleanupLocal: false });
    expect(store.calls.put).toBe(putsBefore); // nội dung đã verified từ trước — fast path
    expect(r.assetId).toBe(before.id);
    expect((await getJobPackages(jobId))[0].state).toBe("ready");
  });

  it("package lạ → NotFoundError", async () => {
    await expect(finishPackageBuild(jobId, 7, workdir, { store })).rejects.toThrow(/không thuộc job/);
  });
});
