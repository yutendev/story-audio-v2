// T7.2 tests — groupChapters (thuần, offline) + planJobPackages (DB thật, idempotent).
// Acceptance: 0, 1, exact multiple, remainder, gap, reorder, changed chaptersPerBook.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

import { groupChapters, planJobPackages, getJobPackages } from "../src/pkg-groups";
import { ConflictError, ValidationError } from "../src/db";
import { createJob } from "../src/job-repository";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t72Prefix = "https://example.invalid/t72";

describe("groupChapters — unit thuần (offline)", () => {
  it("0 chương → không gói, không missing", () => {
    const p = groupChapters([], 20);
    expect(p.packages).toEqual([]);
    expect(p.missing).toEqual([]);
  });

  it("1 chương → đúng 1 gói [1-1]", () => {
    const p = groupChapters([1], 20);
    expect(p.packages).toEqual([
      { sequence: 1, startChapter: 1, endChapter: 1, chapterIndices: [1] },
    ]);
    expect(p.missing).toEqual([]);
  });

  it("exact multiple: 12 chương / 4 → 3 gói kín, dồn sequence 1..3", () => {
    const p = groupChapters([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 4);
    expect(p.packages.map((x) => [x.sequence, x.startChapter, x.endChapter])).toEqual([
      [1, 1, 4],
      [2, 5, 8],
      [3, 9, 12],
    ]);
    expect(p.packages.every((x) => x.chapterIndices.length === 4)).toBe(true);
    expect(p.missing).toEqual([]);
  });

  it("remainder: 13 chương / 4 → gói cuối chỉ 1 chương (không lấp giả)", () => {
    const p = groupChapters(Array.from({ length: 13 }, (_, i) => i + 1), 4);
    expect(p.packages).toHaveLength(4);
    const last = p.packages[3];
    expect(last).toMatchObject({ sequence: 4, startChapter: 13, endChapter: 13 });
    expect(last.chapterIndices).toEqual([13]);
    expect(p.missing).toEqual([]);
  });

  it("gap: [1,2,5,6] / 4 → gói [1-2] và [5-6], missing [3,4] bị BÁO (không nuốt)", () => {
    const p = groupChapters([1, 2, 5, 6], 4);
    expect(p.packages.map((x) => [x.sequence, x.startChapter, x.endChapter])).toEqual([
      [1, 1, 2],
      [2, 5, 6],
    ]);
    expect(p.packages[0].chapterIndices).toEqual([1, 2]);
    expect(p.missing).toEqual([3, 4]);
  });

  it("reorder + duplicate đầu vào → cùng kết quả như đã sort/dedupe (deterministic)", () => {
    const a = groupChapters([6, 2, 5, 1, 2], 4);
    const b = groupChapters([1, 2, 5, 6], 4);
    expect(a).toEqual(b);
  });

  it("tham số sai: chaptersPerBook 0/1.5, index 0/âm → ValidationError", () => {
    expect(() => groupChapters([1], 0)).toThrow(ValidationError);
    expect(() => groupChapters([1], 1.5)).toThrow(ValidationError);
    expect(() => groupChapters([0], 4)).toThrow(ValidationError);
    expect(() => groupChapters([-2, 1], 4)).toThrow(ValidationError);
  });
});

describe("planJobPackages — DB thật (persist + idempotent + đổi settings)", () => {
  let jobId = "";

  beforeAll(async () => {
    await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t72Prefix } } });
    const job = await createJob({ sourceUrl: `${t72Prefix}/truyen`, adapter: "webnovel-vn" });
    jobId = job.id;
  });

  afterAll(async () => {
    await raw.job.deleteMany({ where: { id: jobId } });
    await raw.$disconnect();
  });

  async function addChapters(indices: number[]): Promise<void> {
    for (const index of indices) {
      await raw.chapter.create({
        data: { jobId, index, title: `C${index}`, sourceUrl: `${t72Prefix}/${index}` },
      });
    }
  }

  it("0 chương (job mới) → plan rỗng, 0 row BookPackage", async () => {
    const plan = await planJobPackages(jobId);
    expect(plan.packages).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(await getJobPackages(jobId)).toEqual([]);
  });

  it("5 chương / 20 (default) → 1 gói [1-5]; plan lần nữa idempotent (không nhân row)", async () => {
    await addChapters([1, 2, 3, 4, 5]);
    const plan = await planJobPackages(jobId);
    expect(plan.packages).toEqual([
      { sequence: 1, startChapter: 1, endChapter: 5, chapterIndices: [1, 2, 3, 4, 5] },
    ]);
    expect(plan.missing).toEqual([]);
    const rows = await getJobPackages(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sequence: 1,
      startChapter: 1,
      endChapter: 5,
      chapterCount: 5,
      state: "pending",
    });
    expect((rows[0].groupingSnapshot as Record<string, unknown>).chapterIndices).toEqual([1, 2, 3, 4, 5]);

    await planJobPackages(jobId); // lần 2 — idempotent
    expect(await getJobPackages(jobId)).toHaveLength(1);
  });

  it("changed chaptersPerBook 30→1 → 5 gói; CÙNG các row (sequence giữ id), về pending", async () => {
    await raw.job.update({ where: { id: jobId }, data: { chaptersPerBook: 1 } });
    const before = await getJobPackages(jobId);
    expect(before[0]).toMatchObject({ sequence: 1, startChapter: 1, endChapter: 5 });

    const plan = await planJobPackages(jobId);
    expect(plan.packages).toHaveLength(5);
    expect(plan.packages.map((p) => [p.sequence, p.startChapter, p.endChapter])).toEqual([
      [1, 1, 1],
      [2, 2, 2],
      [3, 3, 3],
      [4, 4, 4],
      [5, 5, 5],
    ]);

    const rows = await getJobPackages(jobId);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5]); // không row thừa/thiếu
    expect(rows[4]).toMatchObject({ startChapter: 5, endChapter: 5, chapterCount: 1, state: "pending" });
  });

  it("gap phát sinh (xóa chương 3): plan lại → gói [1-2], [4-5], missing [3]; gói thừa bị REMOVED", async () => {
    await raw.job.update({ where: { id: jobId }, data: { chaptersPerBook: 2 } });
    await raw.chapter.delete({ where: { jobId_index: { jobId, index: 3 } } });

    const plan = await planJobPackages(jobId);
    expect(plan.packages.map((p) => [p.startChapter, p.endChapter])).toEqual([
      [1, 2],
      [4, 5],
    ]);
    expect(plan.missing).toEqual([3]); // không im lặng

    const rows = await getJobPackages(jobId);
    expect(rows.map((r) => [r.sequence, r.startChapter, r.endChapter])).toEqual([
      [1, 1, 2],
      [2, 4, 5],
    ]); // seq 3 cũ đã bị dọn (state pending/failed thôi)
  });

  it("gói thừa đang ready → ConflictError, không âm thầm xóa kết quả đã xây", async () => {
    await raw.bookPackage.create({
      data: {
        jobId,
        sequence: 9, // ngoài plan 2 gói
        startChapter: 17,
        endChapter: 18,
        chapterCount: 2,
        groupingSnapshot: {},
        state: "ready",
      },
    });
    await expect(planJobPackages(jobId)).rejects.toThrow(ConflictError);
    const still = await raw.bookPackage.findUnique({
      where: { jobId_sequence: { jobId, sequence: 9 } },
    });
    expect(still?.state).toBe("ready");
    await raw.bookPackage.delete({ where: { jobId_sequence: { jobId, sequence: 9 } } });
  });
});
