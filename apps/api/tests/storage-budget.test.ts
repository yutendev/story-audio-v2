// T4.5 tests — storage budget: vượt → chặn trước upload; warn threshold; cleanup local
// KHÔNG BAO GIỜ xóa remote/DB (acceptance: "valid remote asset is never deleted due to a failed
// local cleanup step").
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { recordChapterArtifact } from "../src/asset-service";
import { StorageBudgetExceededError, getUsedBytes, allowsUploadDelta, readBudget } from "../src/storage-budget";
import { ValidationError } from "../src/db";
import { createJob } from "../src/job-repository";
import type { ObjectStoreAdapter } from "../src/r2-adapter";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t45Prefix = "https://example.invalid/t45";
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
    return b ? { data: b, contentType: "text/plain" } : null;
  }
  async deleteObject(key: string) {
    this.calls.delete++;
    this.objects.delete(key);
  }
}

const envBackup: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined) {
  if (!(k in envBackup)) envBackup[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

afterAll(async () => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t45Prefix } } });
  const job = await createJob({ sourceUrl: `${t45Prefix}/main`, adapter: "webnovel-vn" });
  jobId = job.id;
  for (const index of [1, 2]) {
    await raw.chapter.create({
      data: { jobId, index, title: `C${index}`, sourceUrl: `${t45Prefix}/c${index}` },
    });
  }
  workdir = await mkdtemp(join(tmpdir(), "t45-work-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
  await raw.job.deleteMany({ where: { id: jobId } });
  await raw.$disconnect();
});

describe("readBudget — env config", () => {
  it("mặc định 1GB / 80%; sai kiểu → default; MB > 0 chấp nhận", () => {
    setEnv("STORAGE_BUDGET_MB", undefined);
    setEnv("STORAGE_BUDGET_WARN_PERCENT", undefined);
    expect(readBudget()).toEqual({ bytes: 1024 * 1024 * 1024, warnPercent: 80 });
    setEnv("STORAGE_BUDGET_MB", "5");
    setEnv("STORAGE_BUDGET_WARN_PERCENT", "50");
    expect(readBudget()).toEqual({ bytes: 5 * 1024 * 1024, warnPercent: 50 });
    setEnv("STORAGE_BUDGET_MB", "abc");
    setEnv("STORAGE_BUDGET_WARN_PERCENT", "200");
    expect(readBudget().warnPercent).toBe(80);
  });
});

describe("allowsUploadDelta + getUsedBytes", () => {
  it("delta nhỏ qua; delta vượt → ok=false + overBytes đúng", async () => {
    const before = await getUsedBytes();
    expect(before).toBeGreaterThanOrEqual(0); // các test khác có thể đã lấp DB
    // budget GẮN TRẬN theo DB hiện tại (live từng ghi asset thật) — vẫn giữ hợp đồng:
    // delta 0 luôn qua khi cap > used; delta vượt cap → chặn
    const budget = { bytes: before + 1024, warnPercent: 80 };
    const d = await allowsUploadDelta(0, budget);
    expect(d.ok).toBe(true);
    const over = await allowsUploadDelta(budget.bytes * 10, budget);
    expect(over.ok).toBe(false);
    expect(over.overBytes).toBeGreaterThan(0);
  });
});

describe("recordChapterArtifact ⊗ budget", () => {
  it("budget 1MB + file > 1MB → StorageBudgetExceededError, KHÔNG upload, KHÔNG ghi asset", async () => {
    setEnv("STORAGE_BUDGET_MB", "1");
    const big = Buffer.alloc(2 * 1024 * 1024, 1); // 2MB > 1MB budget
    await writeFile(join(workdir, "big.mp3"), big);
    const store = new InMemoryStore();

    await expect(
      recordChapterArtifact({
        jobId,
        chapterIndex: 1,
        kind: "chapter_audio",
        workdir,
        relativePath: "big.mp3",
        store,
      }),
    ).rejects.toBeInstanceOf(StorageBudgetExceededError);

    expect(store.calls.put).toBe(0); // chặn TRƯỚC upload
    expect(await raw.asset.count({ where: { chapter: { jobId, index: 1 } } })).toBe(0);
  });

  it("re-upload thay nội dung (delta âm hoặc nhỏ) vẫn được phép dưới budget", async () => {
    setEnv("STORAGE_BUDGET_MB", "1");
    const file = join(workdir, "small1.txt");
    const store = new InMemoryStore();
    await writeFile(file, "A");
    const first = await recordChapterArtifact({
      jobId,
      chapterIndex: 2,
      kind: "rewritten_text",
      workdir,
      relativePath: "small1.txt",
      store,
    });
    await writeFile(file, "B nh hơn cùng đoạn văn dài hơn A một chút");
    const second = await recordChapterArtifact({
      jobId,
      chapterIndex: 2,
      kind: "rewritten_text",
      workdir,
      relativePath: "small1.txt",
      store,
    });
    expect(second.assetId).toBe(first.assetId);
  });
});

describe("cleanup local sau verify — an toàn tuyệt đối với remote", () => {
  it("cleanupLocalAfterVerify=true → file bị unlink; asset + object remote còn nguyên", async () => {
    setEnv("STORAGE_BUDGET_MB", undefined);
    const file = join(workdir, "cleanup.txt");
    await writeFile(file, "sau khi upload không cần file này", "utf-8");
    const store = new InMemoryStore();

    const r = await recordChapterArtifact({
      jobId,
      chapterIndex: 2,
      kind: "source_html",
      workdir,
      relativePath: "cleanup.txt",
      store,
      cleanupLocalAfterVerify: true,
      part: undefined,
    });

    await expect(stat(file)).rejects.toThrow(); // file đã unlink
    expect((await raw.asset.findUniqueOrThrow({ where: { id: r.assetId } })).verified).toBe(true);
    expect(store.objects.get(r.objectKey)).toBeDefined(); // remote còn
  });

  it("unlink fail (file bị khóaOpen) → KHÔNG throw, asset + remote VẪN còn nguyên", async () => {
    const fsPromises = await import("node:fs/promises");
    const file = join(workdir, "cleanup-locked.txt");
    await writeFile(file, "khóa 1", "utf-8");
    const store = new InMemoryStore();

    // Windows: giữ file handle mở → unlink bị chặn (EPERM/EBUSY) — mô phỏng "disk locked"
    const fh = await fsPromises.open(file, "r+");
    try {
      const r = await recordChapterArtifact({
        jobId,
        chapterIndex: 2,
        kind: "normalized_text",
        workdir,
        relativePath: "cleanup-locked.txt",
        store,
        cleanupLocalAfterVerify: true,
      });

      expect(await raw.asset.findUniqueOrThrow({ where: { id: r.assetId } })).toBeTruthy();
      expect(store.objects.get(r.objectKey)).toBeDefined(); // remote KHÔNG bị đụng khi cleanup fail
    } finally {
      await fh.close();
    }
  });

  it("cleanup path ngoài workdir → bỏ qua unlink, không nổ", async () => {
    setEnv("STORAGE_BUDGET_MB", undefined);
    const store = new InMemoryStore();
    // relativePath "..": readFromWorkdir chặn server ValidationError; không thể vô cleanup path
    await expect(
      recordChapterArtifact({
        jobId,
        chapterIndex: 1,
        kind: "rewritten_text",
        workdir,
        relativePath: "../outside.txt",
        store,
        cleanupLocalAfterVerify: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(store.calls.put).toBe(0);
  });
});
