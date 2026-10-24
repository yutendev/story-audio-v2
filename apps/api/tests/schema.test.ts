// Integration test schema (T2.3) — chạy trên DB dev thật (DATABASE_URL từ root .env).
// Không mock client: kiểm chứng constraint thật trong PostgreSQL.
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  ChapterStage,
  JobState,
  JobEventType,
  PrismaClient,
  ReviewState,
} from "../src/generated/client";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const PREFIX = "t23-"; // dữ liệu test đều mang prefix — sauAll dọn bằng job.deleteMany
let jobId = "";
let jobId2 = "";

beforeAll(async () => {
  const job = await prisma.job.create({
    data: {
      sourceUrl: "https://example.invalid/truyen/t23",
      adapter: "truyendich-space",
      state: JobState.queued,
    },
  });
  jobId = job.id;
});

afterAll(async () => {
  await prisma.job.deleteMany({ where: { id: { in: [jobId, jobId2] } } });
  await prisma.$disconnect();
});

const chapterData = (index: number) => ({
  jobId,
  index,
  title: `Ch ${index}`,
  sourceUrl: `https://example.invalid/truyen/t23/${index}`,
  stageState: ChapterStage.discovered,
  reviewState: ReviewState.none,
});

describe("schema constraints (trên PostgreSQL thật)", () => {
  it("chapters: UNIQUE (job_id, index) chặn trùng index", async () => {
    await prisma.chapter.create({ data: chapterData(1) });
    await expect(prisma.chapter.create({ data: chapterData(1) })).rejects.toThrow(
      /chapters_job_id_index_key|Unique constraint/i,
    );
  });

  it("defaults: job mới có chapters_per_book=20, state=queued; chapter mới ở stage đầu", async () => {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.chaptersPerBook).toBe(20);
    expect(job.state).toBe("queued");
    expect(job.configSnapshot).toEqual({});

    const ch = await prisma.chapter.findFirstOrThrow({ where: { jobId } });
    expect(ch.stageState).toBe("discovered");
    expect(ch.reviewState).toBe("none");
  });

  it("job_events: UNIQUE (job_id, seq) chặn seq trùng", async () => {
    await prisma.jobEvent.create({
      data: { jobId, seq: 0, eventType: JobEventType.stage_started },
    });
    await expect(
      prisma.jobEvent.create({ data: { jobId, seq: 0, eventType: JobEventType.progress } }),
    ).rejects.toThrow(/job_events_job_id_seq_key|Unique constraint/i);
  });

  it("assets: UNIQUE (chapter_id, kind) chặn 2 asset cùng kind cho 1 chapter", async () => {
    const ch = await prisma.chapter.findFirstOrThrow({ where: { jobId } });
    const asset = await prisma.asset.create({
      data: {
        jobId,
        chapterId: ch.id,
        kind: "rewritten_text",
        objectKey: "t23/0001/rewritten.txt",
        contentType: "text/plain; charset=utf-8",
        size: 10,
        sha256: "a".repeat(64),
      },
    });
    await expect(
      prisma.asset.create({
        data: {
          jobId,
          chapterId: ch.id,
          kind: "rewritten_text",
          objectKey: "t23/0001/rewritten-dup.txt",
          contentType: "text/plain; charset=utf-8",
        },
      }),
    ).rejects.toThrow(/assets_chapter_id_kind_key|Unique constraint/i);

    // chapter "active" trỏ tới asset text — đọc lại bằng back-relation
    await prisma.chapter.update({ where: { id: ch.id }, data: { textAssetId: asset.id } });
    const reloaded = await prisma.chapter.findUniqueOrThrow({
      where: { id: ch.id },
      include: { asset: true },
    });
    expect(reloaded.asset?.objectKey).toBe("t23/0001/rewritten.txt");
  });

  it("book_packages: UNIQUE (job_id, sequence) + snapshot jsonb default {}", async () => {
    await prisma.bookPackage.create({
      data: { jobId, sequence: 1, startChapter: 1, endChapter: 20, chapterCount: 20 },
    });
    await expect(
      prisma.bookPackage.create({
        data: { jobId, sequence: 1, startChapter: 1, endChapter: 20, chapterCount: 20 },
      }),
    ).rejects.toThrow(/book_packages_job_id_sequence_key|Unique constraint/i);
    const pkg = await prisma.bookPackage.findFirstOrThrow({ where: { jobId } });
    expect(pkg.groupingSnapshot).toEqual({});
    expect(pkg.state).toBe("pending");
  });

  it("cascade: xoá job xoá sạch chapters/assets/packages/events", async () => {
    const job = await prisma.job.create({
      data: { sourceUrl: "https://example.invalid/truyen/t23-del", adapter: "webnovel-vn" },
    });
    jobId2 = job.id;
    await prisma.chapter.create({ data: { ...chapterData(99), jobId: jobId2 } });
    await prisma.asset.create({
      data: { jobId: jobId2, kind: "description", objectKey: "d/m.txt", contentType: "text/plain" },
    });
    await prisma.bookPackage.create({
      data: { jobId: jobId2, sequence: 1, startChapter: 1, endChapter: 20, chapterCount: 20 },
    });
    await prisma.jobEvent.create({
      data: { jobId: jobId2, seq: 5, eventType: JobEventType.error },
    });
    expect(await prisma.chapter.count({ where: { jobId: jobId2 } })).toBe(1);
    await prisma.job.delete({ where: { id: jobId2 } });
    expect(await prisma.chapter.count({ where: { jobId: jobId2 } })).toBe(0);
    expect(await prisma.asset.count({ where: { jobId: jobId2 } })).toBe(0);
    expect(await prisma.bookPackage.count({ where: { jobId: jobId2 } })).toBe(0);
    expect(await prisma.jobEvent.count({ where: { jobId: jobId2 } })).toBe(0);
  });
});
