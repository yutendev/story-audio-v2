// Repository layer tests (T2.4) — chạy trên DB dev thật qua getDb().
// Kiểm chứng: validation đầu vào, idempotent event append, transaction rollback.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

import { ConflictError, NotFoundError, ValidationError } from "../src/db";
import {
  appendJobEvent,
  createChapterAsset,
  createJob,
  getJob,
  setChapterStage,
  setJobState,
} from "../src/job-repository";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});
const PREFIX = "t24-";
let jobId = "";

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: "https://example.invalid/t24" } } });
  const job = await createJob({ sourceUrl: "https://example.invalid/t24/truyen", adapter: "webnovel-vn" });
  jobId = job.id;
});

afterAll(async () => {
  await raw.job.deleteMany({ where: { id: jobId } });
  await raw.$disconnect();
});

describe("createJob — validation đầu vào", () => {
  it("url sai / adapter rỗng / chaptersPerBook ngoài range → ValidationError, không tạo row", async () => {
    const before = await raw.job.count();
    await expect(createJob({ sourceUrl: "ftp://khong", adapter: "webnovel-vn" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createJob({ sourceUrl: "https://ok.invalid", adapter: "  " } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(createJob({ sourceUrl: "https://ok.invalid", adapter: "a", chaptersPerBook: 0 })).rejects.toBeInstanceOf(ValidationError);
    expect(await raw.job.count()).toBe(before);
  });
});

describe("appendJobEvent — idempotent theo (job_id, seq)", () => {
  it("lưu event; replay cùng seq → {event:'seq_taken'} và giữ nội dung lần đầu", async () => {
    const first = await appendJobEvent({ jobId, seq: 0, eventType: "stage_started", message: "extract bắt đầu" });
    expect((first as { id: string }).id).toBeTruthy();

    const replay = await appendJobEvent({ jobId, seq: 0, eventType: "error", message: "đùa" });
    expect(replay).toEqual({ event: "seq_taken" });

    const row = await raw.jobEvent.findFirstOrThrow({ where: { jobId, seq: 0 } });
    expect(row.eventType).toBe("stage_started");
    expect(row.message).toBe("extract bắt đầu");
  });

  it("input sai → ValidationError; job lạ → NotFoundError", async () => {
    await expect(
      appendJobEvent({ jobId, seq: 1, eventType: "banana" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      appendJobEvent({ jobId, seq: -5, eventType: "progress" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      appendJobEvent({ jobId: "không-có-job-này", seq: 1, eventType: "progress" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("setChapterStage / setJobState — đường ghi atomic (T2.4)", () => {
  beforeAll(async () => {
    await raw.chapter.create({
      data: { jobId, index: 2, title: "C2", sourceUrl: "https://example.invalid/t24/2" },
    });
  });

  it("stage hợp lệ: chuyển discovered → downloaded, trả from/to", async () => {
    const r = await setChapterStage({
      jobId,
      chapterIndex: 2,
      stage: "downloaded",
      message: "xong crawl",
    });
    expect(r).toMatchObject({ from: "discovered", to: "downloaded" });
  });

  it("idempotent khi set lại cùng stage (from === to)", async () => {
    const r = await setChapterStage({ jobId, chapterIndex: 2, stage: "downloaded" });
    expect(r).toMatchObject({ from: "downloaded", to: "downloaded" });
  });

  it("stage lạ → ValidationError, DB không đổi", async () => {
    const before = await raw.chapter.findUniqueOrThrow({
      where: { jobId_index: { jobId, index: 2 } },
    });
    await expect(
      setChapterStage({ jobId, chapterIndex: 2, stage: "basketball" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    const after = await raw.chapter.findUniqueOrThrow({
      where: { jobId_index: { jobId, index: 2 } },
    });
    expect(after.stageState).toBe(before.stageState);
  });

  it("setJobState: queued → running đánh dấu startedAt, endedAt vẫn null", async () => {
    const r = await setJobState({ jobId, state: "running" });
    expect(r.from).toBe("queued");
    expect(r.to).toBe("running");
    const job = (await raw.job.findUniqueOrThrow({ where: { id: jobId } })) as {
      startedAt: Date | null;
      endedAt: Date | null;
    };
    expect(job.startedAt).toBeTruthy();
    expect(job.endedAt).toBeNull();
  });

  it("setJobState state lạ → ValidationError; job lạ → NotFoundError", async () => {
    await expect(setJobState({ jobId, state: "hovering" as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(setJobState({ jobId: "nope-404", state: "running" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("getJob — luôn job-scoped", () => {
  it("đọc được job; job lạ → null", async () => {
    const job = (await getJob(jobId)) as { sourceUrl: string };
    expect(job.sourceUrl).toBe("https://example.invalid/t24/truyen");
    expect(await getJob("không-tồn-tại")).toBeNull();
  });
});

describe("createChapterAsset — transaction: asset + con trỏ, rollback khi conflict", () => {
  beforeAll(async () => {
    await raw.chapter.create({
      data: {
        jobId,
        index: 1,
        title: "C1",
        sourceUrl: "https://example.invalid/t24/1",
      },
    });
  });

  it("tạo asset + gắn con trỏ active theo kind", async () => {
    const r = await createChapterAsset({
      jobId,
      chapterIndex: 1,
      kind: "rewritten_text",
      objectKey: "t24/0001/rewritten.txt",
      contentType: "text/plain; charset=utf-8",
      size: 11,
      sha256: "a".repeat(64),
    });
    const ch = (await raw.chapter.findUniqueOrThrow({
      where: { jobId_index: { jobId, index: 1 } },
      include: { asset: true },
    })) as { textAssetId: string | null };
    expect(ch.textAssetId).toBe(r.assetId);
  });

  it("trùng (chapter, kind) → ConflictError và tx rollback: không tạo asset rác, con trỏ không đổi", async () => {
    const countBefore = await raw.asset.count({ where: { jobId } });
    const chBefore = await raw.chapter.findUniqueOrThrow({
      where: { jobId_index: { jobId, index: 1 } },
    });
    await expect(
      createChapterAsset({
        jobId,
        chapterIndex: 1,
        kind: "rewritten_text",
        objectKey: "t24/0001/OTHER.txt",
        contentType: "text/plain",
        size: 3,
        sha256: "b".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await raw.asset.count({ where: { jobId } })).toBe(countBefore);
    const chAfter = await raw.chapter.findUniqueOrThrow({
      where: { jobId_index: { jobId, index: 1 } },
    });
    expect(chAfter.textAssetId).toBe(chBefore.textAssetId);
  });

  it("chapter lạ → NotFoundError + rollback; objectKey chứa '..' → ValidationError", async () => {
    await expect(
      createChapterAsset({
        jobId,
        chapterIndex: 999,
        kind: "rewritten_text",
        objectKey: "x.txt",
        contentType: "text/plain",
        size: 1,
        sha256: "c".repeat(64),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createChapterAsset({
        jobId,
        chapterIndex: 1,
        kind: "rewritten_text",
        objectKey: "t24/../../evil.txt",
        contentType: "text/plain",
        size: 1,
        sha256: "d".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
