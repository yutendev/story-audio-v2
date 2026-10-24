// T7.5 tests — Node glue export YouTube: prepare (tải book.m4b VERIFIED + cover người
// dùng vào workdir; yêu cầu m4b đã build T7.3), finish (upload PRIVATE mp4 + description
// → verify từng file; KHÔNG đụng package state; KHÔNG có bước upload YouTube tự động).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { planJobPackages, getJobPackages } from "../src/pkg-groups";
import {
  preparePackageBuild,
  finishPackageBuild,
  prepareYtExport,
  finishYtExport,
} from "../src/package-build";
import { updatePackagingSettings } from "../src/pkg-settings";
import { createChapterAsset, createJob } from "../src/job-repository";
import type { ObjectStoreAdapter } from "../src/r2-adapter";
import { NotFoundError, ValidationError } from "../src/db";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t75Prefix = "https://example.invalid/t75";
let jobId = "";
let workdir = "";
let store: InMemoryStore;

class InMemoryStore implements ObjectStoreAdapter {
  objects = new Map<string, Buffer>();
  calls: { put: number } = { put: 0 };

  async putObject({ key, body }: { key: string; body: Buffer }) {
    this.calls.put++;
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

const BOOK_M4B = Buffer.from("m4b-xuat-yt-opt-1");
const MP4 = Buffer.from("mp4-frame-1920x1080-fake");
const DESC = Buffer.from("Truyện Chạy Bộ\n\n00:00:00 C1\n00:00:04 C2\n");

function pkgKey(file: string): string {
  return `jobs/${jobId}/packages/0001/${file}`;
}

function pkgLocal(file: string): string {
  return join(workdir, "packages", "0001", file);
}

async function seedChapterAudio(index: number): Promise<void> {
  const body = Buffer.from(`mp3-chuong-${index}`);
  await createChapterAsset({
    jobId,
    chapterIndex: index,
    kind: "chapter_audio",
    objectKey: `jobs/${jobId}/chapters/${String(index).padStart(4, "0")}/audio/part-000.mp3`,
    contentType: "audio/mpeg",
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  store.objects.set(
    `jobs/${jobId}/chapters/${String(index).padStart(4, "0")}/audio/part-000.mp3`,
    body,
  );
}

async function setState(state: string): Promise<void> {
  await raw.bookPackage.update({
    where: { jobId_sequence: { jobId, sequence: 1 } },
    data: { state: state as never },
  });
}

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t75Prefix } } });
  store = new InMemoryStore();
  const job = await createJob({ sourceUrl: `${t75Prefix}/truyen`, adapter: "webnovel-vn" });
  jobId = job.id;
  for (const index of [1, 2]) {
    await raw.chapter.create({
      data: { jobId, index, title: `Chương ${index}`, sourceUrl: `${t75Prefix}/${index}` },
    });
    await seedChapterAudio(index);
  }
  await updatePackagingSettings(jobId, {
    chaptersPerBook: 30,
    export: { bookTitle: "Truyện Chạy Bộ" },
  });
  await planJobPackages(jobId); // BookPackage seq 1 [1..2]
  workdir = await mkdtemp(join(tmpdir(), "t75-"));
  await mkdir(join(workdir, "uploads-src"), { recursive: true }); // nơi cover nguồn (UI upload)
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
  await raw.job.deleteMany({ where: { id: jobId } });
  await raw.$disconnect();
});

describe("prepareYtExport — cần m4b verified + cover người dùng", () => {
  it("chưa build M4B → NotFoundError (dep T7.3 đúng nghĩa)", async () => {
    const src = join(workdir, "uploads-src", "anh-bia.jpg");
    await expect(
      prepareYtExport(jobId, 1, workdir, { store, coverAbsPath: src }),
    ).rejects.toThrow(/chưa có book\.m4b/);
  });

  it("m4b hợp lệ nhưng cover sai đuôi/tồn tại → ValidationError/NotFound", async () => {
    // dựng m4b từ glue T7.3: prepare + giả worker + finish
    await preparePackageBuild(jobId, 1, workdir, { store });
    await writeFile(pkgLocal("book.m4b"), BOOK_M4B);
    await finishPackageBuild(jobId, 1, workdir, { store });
    expect((await getJobPackages(jobId))[0].state).toBe("ready");

    const srcTxt = join(workdir, "uploads-src", "khong-phai-anh.txt");
    await writeFile(join(workdir, "uploads-src", "khong-phai-anh.txt"), "text");
    await expect(
      prepareYtExport(jobId, 1, workdir, { store, coverAbsPath: srcTxt }),
    ).rejects.toThrow(ValidationError);
    await expect(
      prepareYtExport(jobId, 1, workdir, {
        store,
        coverAbsPath: join(workdir, "uploads-src", "khong-ton-tai.jpg"),
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("happy: book.m4b bytes = R2 (sha), cover copy đúng bytes, title từ export settings", async () => {
    const coverSrc = join(workdir, "uploads-src", "anh-bia.jpg");
    await writeFile(coverSrc, Buffer.from("jpeg-bia-goc"));

    const p = await prepareYtExport(jobId, 1, workdir, { store, coverAbsPath: coverSrc });
    expect(p.title).toBe("Truyện Chạy Bộ"); // từ settings.export.bookTitle (T7.1)
    expect(p.relPaths).toEqual({
      book: "packages/0001/book.m4b",
      cover: "packages/0001/cover.jpg",
      mp4: "packages/0001/book.mp4",
      description: "packages/0001/description.txt",
    });
    expect((await readFile(pkgLocal("book.m4b"))).equals(BOOK_M4B)).toBe(true);
    expect((await readFile(pkgLocal("cover.jpg"))).equals(Buffer.from("jpeg-bia-goc"))).toBe(true);
  });
});

describe("finishYtExport — upload PRIVATE mp4 + description (không đụng state)", () => {
  it("happy: 2 asset (mp4, description) verified gắn package; local dọn; state vẫn ready", async () => {
    const putsBefore = store.calls.put;
    await writeFile(pkgLocal("book.mp4"), MP4);
    await writeFile(pkgLocal("description.txt"), DESC);

    const r = await finishYtExport(jobId, 1, workdir, { store });
    expect(r.mp4.objectKey).toBe(pkgKey("book.mp4"));
    expect(r.description.objectKey).toBe(pkgKey("description.txt"));
    expect(r.description.sha256).toBe(createHash("sha256").update(DESC).digest("hex"));

    const mp4Row = await raw.asset.findUniqueOrThrow({ where: { id: r.mp4.assetId } });
    expect(mp4Row.kind).toBe("mp4");
    expect(mp4Row.verified).toBe(true);
    const descRow = await raw.asset.findUniqueOrThrow({ where: { id: r.description.assetId } });
    expect(descRow.kind).toBe("description");
    expect(descRow.packageId).toBe((await getJobPackages(jobId))[0].id);
    // nội dung nằm trên R2 riêng tư
    expect(store.objects.get(pkgKey("book.mp4"))!.equals(MP4)).toBe(true);
    expect(store.calls.put).toBe(putsBefore + 2);
    // KHÔNG đụng state — book.m4b vẫn ready; local mp4/description cleaned (default)
    expect((await getJobPackages(jobId))[0].state).toBe("ready");
    await expect(readFile(pkgLocal("book.mp4"))).rejects.toThrow();
    await expect(readFile(pkgLocal("description.txt"))).rejects.toThrow();
  });

  it("file hụt → ValidationError, KHÔNG record gì thêm (số asset không đổi)", async () => {
    const assetsBefore = await raw.asset.count({ where: { jobId, packageId: { not: null } } });
    await expect(finishYtExport(jobId, 1, workdir, { store })).rejects.toThrow(
      /0 byte|không tồn tại/,
    );
    expect(await raw.asset.count({ where: { jobId, packageId: { not: null } } })).toBe(assetsBefore);
  });

  it("re-run cùng sha → fast path không upload lại (idempotent như T7.3)", async () => {
    const putsBefore = store.calls.put;
    await writeFile(pkgLocal("book.mp4"), MP4); // nội dung giống lần đã verify
    await writeFile(pkgLocal("description.txt"), DESC);
    const r = await finishYtExport(jobId, 1, workdir, { store });
    expect(store.calls.put).toBe(putsBefore);
    expect(r.mp4.objectKey).toBe(pkgKey("book.mp4"));
  });

  it("package lạ → NotFoundError", async () => {
    await writeFile(pkgLocal("book.mp4"), MP4);
    await writeFile(pkgLocal("description.txt"), DESC);
    await expect(
      finishYtExport("job-không-có", 1, workdir, { store }),
    ).rejects.toThrow(/không thuộc job/);
  });
});
