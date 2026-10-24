// T7.4 tests — REPACKAGE KHÔNG RERUN AI/TTS: đổi chaptersPerBook → chỉ gói bị ảnh
// hưởng về pending; audio/text asset VERIFIED giữ nguyên (không có TTS/rewrite nào
// cần chạy lại); re-plan không đụng gói giữ nguyên (ready vẫn ready).
// Nền: planJobPackages (T7.2, affected-only) + createChapterAsset + package-build glue.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { planJobPackages, getJobPackages } from "../src/pkg-groups";
import { preparePackageBuild, finishPackageBuild } from "../src/package-build";
import { updatePackagingSettings } from "../src/pkg-settings";
import { chaptersNeedingTts } from "../src/job-repository";
import { createChapterAsset, createJob } from "../src/job-repository";
import type { ObjectStoreAdapter } from "../src/r2-adapter";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t74Prefix = "https://example.invalid/t74";
let jobId = "";
let workdir = "";
let seededStore: InMemoryStore | null = null; // "R2" giả — seed object một lần, tái dùng giữa các test

class InMemoryStore implements ObjectStoreAdapter {
  objects = new Map<string, Buffer>();
  async putObject({ key, body }: { key: string; body: Buffer }) {
    this.objects.set(key, body);
    return { etag: `"${createHash("md5").update(body).digest("hex")}"` };
  }
  async headObject(key: string) {
    const b = this.objects.get(key);
    if (!b) return null;
    return { size: b.length, etag: `"${createHash("md5").update(b).digest("hex")}"` };
  }
  async getObject(key: string) {
    const b = this.objects.get(key);
    return b ? { data: b, contentType: "application/octet-stream" } : null;
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
}

async function seedChapter(index: number, store: InMemoryStore): Promise<void> {
  // stageState qa_passed: nếu audio pointer thiếu → chaptersNeedingTts SẼ trả số này
  // (assertion rỗng sau repackage có Ý NGHĨA: TTS không phải chạy lại)
  await raw.chapter.create({
    data: {
      jobId,
      index,
      title: `Chương ${index}`,
      sourceUrl: `${t74Prefix}/${index}`,
      stageState: "qa_passed",
    },
  });
  // TEXT rewritten: asset verified + con trỏ (production path) — "AI không chạy lại"
  const textKey = `jobs/${jobId}/chapters/${String(index).padStart(4, "0")}/rewritten.txt`;
  store.objects.set(textKey, Buffer.from(`thuit-muon-chuong-${index}`));
  await createChapterAsset({
    jobId,
    chapterIndex: index,
    kind: "rewritten_text",
    objectKey: textKey,
    contentType: "text/plain; charset=utf-8",
    size: store.objects.get(textKey)!.length,
    sha256: createHash("sha256").update(store.objects.get(textKey)!).digest("hex"),
  });
  // AUDIO: asset verified + con trỏ audioAssetId (TTS không chạy lại)
  const audioKey = `jobs/${jobId}/chapters/${String(index).padStart(4, "0")}/audio/part-000.mp3`;
  store.objects.set(audioKey, Buffer.from(`mp3-chuong-${index}`));
  await createChapterAsset({
    jobId,
    chapterIndex: index,
    kind: "chapter_audio",
    objectKey: audioKey,
    contentType: "audio/mpeg",
    size: store.objects.get(audioKey)!.length,
    sha256: createHash("sha256").update(store.objects.get(audioKey)!).digest("hex"),
  });
}

/** Xây gói seq = sách thật: prepare → worker giả (ghi book.m4b) → finish → ready. */
async function buildPackageToReady(sequence: number, store: InMemoryStore): Promise<void> {
  await preparePackageBuild(jobId, sequence, workdir, { store });
  await writeFile(
    join(workdir, "packages", String(sequence).padStart(4, "0"), "book.m4b"),
    Buffer.from(`m4b-cua-goi-${sequence}`),
  );
  await finishPackageBuild(jobId, sequence, workdir, { store });
}

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t74Prefix } } });
  const job = await createJob({ sourceUrl: `${t74Prefix}/truyen`, adapter: "webnovel-vn" });
  jobId = job.id;
  workdir = await mkdtemp(join(tmpdir(), "t74-"));
  seededStore = new InMemoryStore();
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
  await raw.job.deleteMany({ where: { id: jobId } });
  await raw.$disconnect();
});

describe("đổi chaptersPerBook → repackaging KHÔNG rerun TTS/rewrite", () => {
  it("4 chương / perBook 4 → 1 gói ready; đổi perBook 2 → gói span-đổi về pending + gói mới pending; asset verified còn nguyên; TTS không phải chạy lại", async () => {
    const store = seededStore;
    for (const index of [1, 2, 3, 4]) await seedChapter(index, store);
    await updatePackagingSettings(jobId, { chaptersPerBook: 4 });
    expect((await planJobPackages(jobId)).packages).toHaveLength(1);
    await buildPackageToReady(1, store);
    expect((await getJobPackages(jobId)).map((r) => r.state)).toEqual(["ready"]);

    const audioBefore = await raw.asset.count({ where: { jobId, kind: "chapter_audio", verified: true } });
    const textBefore = await raw.asset.count({ where: { jobId, kind: "rewritten_text", verified: true } });

    // === ĐỔI KÍCH THƯỚC GÓI (điểm chính của T7.4) ===
    await updatePackagingSettings(jobId, { chaptersPerBook: 2 });
    const plan = await planJobPackages(jobId);
    expect(plan.packages.map((p) => [p.sequence, p.startChapter, p.endChapter])).toEqual([
      [1, 1, 2],
      [2, 3, 4],
    ]);
    const rows = await getJobPackages(jobId);
    expect(rows).toHaveLength(2);
    // gói 1 span cũ [1-4] ≠ [1-2] → bị ảnh hưởng → pending (phải xây lại — đúng nghĩa invalidate)
    expect(rows.find((r) => r.sequence === 1)!.state).toBe("pending");
    // gói 2 mới hoàn toàn → pending
    expect(rows.find((r) => r.sequence === 2)!.state).toBe("pending");

    // KHÔNG rerun TTS: mọi chương vẫn có audio verified → chaptersNeedingTts rỗng
    expect(await chaptersNeedingTts(jobId)).toEqual([]);
    expect(await raw.asset.count({ where: { jobId, kind: "chapter_audio", verified: true } })).toBe(audioBefore);
    // KHÔNG rerun rewrite AI: text verified giữ nguyên
    expect(await raw.asset.count({ where: { jobId, kind: "rewritten_text", verified: true } })).toBe(textBefore);

    // chuẩn bị gói 2 MỚI từ CHÍNH audio đã verified trên R2 — không TTS
    const p = await preparePackageBuild(jobId, 2, workdir, { store });
    expect(p.chapters.map((c) => c.no)).toEqual([3, 4]);
  });

  it("re-plan khi settings KHÔNG đổi → gói đang READY GIỮ NGUYÊN (không invalidate vô tội vạ)", async () => {
    const store = seededStore;
    // gói 2 (building dở từ test 1) vượt khỏi plan thu gọn — policy phải dọn rõ ràng
    // trước khi plan (T7.2: không âm thầm xóa building/ready → ConflictError)
    await raw.bookPackage.delete({ where: { jobId_sequence: { jobId, sequence: 2 } } });
    // các chương đã seed từ test trước — dựng lại gói 1 theo [1-4] origin
    await updatePackagingSettings(jobId, { chaptersPerBook: 4 });
    await planJobPackages(jobId);
    await buildPackageToReady(1, store);
    expect((await getJobPackages(jobId)).filter((r) => r.sequence === 1)[0].state).toBe("ready");

    // plan LẦI NỮA cùng settings — gói 1 không đổi nội dung → giữ state ready
    await planJobPackages(jobId);
    expect((await getJobPackages(jobId)).filter((r) => r.sequence === 1)[0].state).toBe("ready");

    // âm bản: chapter audio/text vẫn nguyên vẹn sau mọi lần plan lại
    expect(await chaptersNeedingTts(jobId)).toEqual([]);
  });
});
