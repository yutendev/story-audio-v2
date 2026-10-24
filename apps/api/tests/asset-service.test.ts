// T4.3 tests — upload/verify/record: happy path, failed upload KHÔNG ghi asset,
// verify fail + dọn orphan, retry idempotent (cùng sha & đổi sha), path escape chặn sớm.
// Store = InMemory fake (không chạm R2 thật). DB = PostgreSQL dev thật.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { recordChapterArtifact, UploadVerifyError } from "../src/asset-service";
import { NotFoundError, ValidationError } from "../src/db";
import { createJob } from "../src/job-repository";
import type { ObjectStoreAdapter } from "../src/r2-adapter";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t43Prefix = "https://example.invalid/t43";
let jobId = "";
let workdir = "";

class InMemoryStore implements ObjectStoreAdapter {
  objects = new Map<string, Buffer>();
  calls = { put: 0, head: 0, delete: 0 };

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

// head lệch 1 byte — mô phỏng upload hỏng im lặng
class WrongHeadStore extends InMemoryStore {
  async headObject(key: string) {
    const h = await super.headObject(key);
    return h ? { size: h.size + 1, etag: h.etag } : null;
  }
}

class ThrowingPutStore extends InMemoryStore {
  async putObject(): Promise<{ etag?: string }> {
    throw new Error("mạng đứt giữa chừng");
  }
}

const md5Of = (s: string) => createHash("md5").update(s).digest("hex");

async function record(
  chapterIndex: number,
  kind: "rewritten_text" | "source_html" | "chapter_audio" | "normalized_text",
  store: InMemoryStore,
  relativePath = "rewritten.txt",
  fileContent = "nội dung chương",
) {
  return recordChapterArtifact({
    jobId,
    chapterIndex,
    kind,
    workdir,
    relativePath,
    store,
  });
}

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t43Prefix } } });
  const job = await createJob({
    sourceUrl: "https://example.invalid/t43/truyen",
    adapter: "webnovel-vn",
  });
  jobId = job.id;
  for (const index of [1, 2, 3, 4, 5, 6, 8]) {
    await raw.chapter.create({
      data: { jobId, index, title: `C${index}`, sourceUrl: `https://example.invalid/t43/${index}` },
    });
  }
  workdir = await mkdtemp(join(tmpdir(), "t43-work-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
  await raw.job.deleteMany({ where: { id: jobId } });
  await raw.$disconnect();
});

describe("recordChapterArtifact — happy path", () => {
  it("upload → verify → ghi asset verified=true + set pointer + contentType", async () => {
    const store = new InMemoryStore();
    await writeFile(join(workdir, "rewritten.txt"), "nội dung chương", "utf-8");

    const r = await record(1, "rewritten_text", store);

    expect(r.objectKey).toBe(`jobs/${jobId}/chapters/0001/rewritten.txt`);
    expect(store.objects.get(r.objectKey)?.toString()).toBe("nội dung chương");

    const asset = await raw.asset.findUniqueOrThrow({ where: { id: r.assetId } });
    expect(asset.verified).toBe(true);
    expect(asset.sha256).toBe(createHash("sha256").update("nội dung chương").digest("hex"));
    expect(asset.size).toBe(Buffer.byteLength("nội dung chương"));
    expect(asset.contentType).toBe("text/plain; charset=utf-8");

    const chapter = await raw.chapter.findUniqueOrThrow({
      where: { jobId_index: { jobId, index: 1 } },
    });
    expect(chapter.textAssetId).toBe(asset.id);
  });

  it("source_html → asset tạo nhưng KHÔNG đụng pointer (textAssetId giữ nguyên)", async () => {
    const store = new InMemoryStore();
    await writeFile(join(workdir, "source.html"), "<h1>chương 8</h1>", "utf-8");
    const before = await raw.chapter.findUniqueOrThrow({
      where: { jobId_index: { jobId, index: 8 } },
    });

    const r = await record(8, "source_html", store, "source.html");

    expect(r.objectKey).toContain("source.html");
    const chapter = await raw.chapter.findUniqueOrThrow({
      where: { jobId_index: { jobId, index: 8 } },
    });
    expect(chapter.textAssetId).toBe(before.textAssetId);
    expect((await raw.asset.findUniqueOrThrow({ where: { id: r.assetId } })).verified).toBe(true);
  });

  it("chapter_audio: part suy ra từ tên file, pointer audioAssetId, contentType audio/mpeg", async () => {
    const store = new InMemoryStore();
    await writeFile(join(workdir, "part-012.mp3"), Buffer.alloc(11, 7));

    const r = await record(6, "chapter_audio", store, "part-012.mp3");

    expect(r.objectKey).toBe(`jobs/${jobId}/chapters/0006/audio/part-012.mp3`);
    expect((await raw.asset.findUniqueOrThrow({ where: { id: r.assetId } })).contentType).toBe(
      "audio/mpeg",
    );
    const chapter = await raw.chapter.findUniqueOrThrow({
      where: { jobId_index: { jobId, index: 6 } },
    });
    expect(chapter.audioAssetId).toBe(r.assetId);
  });
});

describe("recordChapterArtifact — thất bại không ghi asset", () => {
  it("upload throw → UploadVerifyError, DB không có asset row", async () => {
    await writeFile(join(workdir, "f2.txt"), "x", "utf-8");
    const store = new ThrowingPutStore();

    await expect(record(2, "rewritten_text", store, "f2.txt")).rejects.toBeInstanceOf(
      UploadVerifyError,
    );
    expect(await raw.asset.count({ where: { chapter: { jobId, index: 2 } } })).toBe(0);
  });

  it("verify size lệch → UploadVerifyError + KHÔNG ghi + orphan đã bị xóa khỏi store", async () => {
    await writeFile(join(workdir, "f3.txt"), "y", "utf-8");
    const store = new WrongHeadStore();

    await expect(record(3, "rewritten_text", store, "f3.txt")).rejects.toBeInstanceOf(
      UploadVerifyError,
    );
    expect(store.objects.size).toBe(0); // orphan đã bị dọn
    expect(await raw.asset.count({ where: { chapter: { jobId, index: 3 } } })).toBe(0);
  });
});

describe("retry idempotent", () => {
  it("cùng nội dung → cùng assetId, KHÔNG upload lại (put=1 lần), không trùng row", async () => {
    await writeFile(join(workdir, "f4.txt"), "lần 1", "utf-8");
    const store = new InMemoryStore();

    const first = await record(4, "rewritten_text", store, "f4.txt");
    const second = await record(4, "rewritten_text", store, "f4.txt");

    expect(second.assetId).toBe(first.assetId);
    expect(store.calls.put).toBe(1); // fast path: không upload lại
    expect(await raw.asset.count({ where: { chapter: { jobId, index: 4 } } })).toBe(1);
  });

  it("đổi nội dung rồi retry → giữ nguyên assetId, sha/size metadata cập nhật", async () => {
    const file = join(workdir, "f5.txt");
    await writeFile(file, "phiên bản A", "utf-8");
    const store = new InMemoryStore();

    const first = await record(5, "rewritten_text", store, "f5.txt");
    await writeFile(file, "phiên bản B dài hơn", "utf-8");
    const second = await record(5, "rewritten_text", store, "f5.txt");

    expect(second.assetId).toBe(first.assetId);
    const asset = await raw.asset.findUniqueOrThrow({ where: { id: first.assetId } });
    expect(asset.sha256).toBe(createHash("sha256").update("phiên bản B dài hơn").digest("hex"));
    expect(asset.size).toBe(Buffer.byteLength("phiên bản B dài hơn"));
    expect(asset.verified).toBe(true);
    expect(store.objects.get(second.objectKey)?.toString()).toBe("phiên bản B dài hơn");
  });
});

describe("path safety & lỗi đầu vào", () => {
  it("path escape (../ và tuyệt đối) → ValidationError, store KHÔNG bị đụng", async () => {
    const store = new InMemoryStore();
    await expect(record(1, "rewritten_text", store, "../../etc/passwd")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(record(1, "rewritten_text", store, "C:/windows/system32/x.txt")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(store.calls.put).toBe(0);
    expect(store.calls.head).toBe(0);
    expect(store.calls.delete).toBe(0);
  });

  it("file không tồn tại trong workdir → ValidationError", async () => {
    await expect(
      record(1, "rewritten_text", new InMemoryStore(), "khong-co.txt"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("chapter không thuộc job → NotFoundError, KHÔNG upload", async () => {
    await writeFile(join(workdir, "f9.txt"), "z", "utf-8");
    const store = new InMemoryStore();

    await expect(
      recordChapterArtifact({
        jobId,
        chapterIndex: 999,
        kind: "rewritten_text",
        workdir,
        relativePath: "f9.txt",
        store,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(store.calls.put).toBe(0);
  });

  it("kind lạ → ValidationError ngay từ đầu", async () => {
    await expect(
      record(1, "fifo" as never, new InMemoryStore()),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
