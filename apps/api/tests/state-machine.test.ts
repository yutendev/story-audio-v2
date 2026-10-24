// State machine tests (T2.5): bảng transition + guard trong repo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  CHAPTER_STAGES,
  CHAPTER_TRANSITIONS,
  JOB_STATES,
  JOB_TRANSITIONS,
  InvalidTransitionError,
  assertChapterTransition,
  assertJobTransition,
} from "../src/state-machine";
import { setChapterStage, setJobState } from "../src/job-repository";
import { PrismaClient } from "../src/generated/client";
import { createJob } from "../src/job-repository";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});
const t25Prefix = "https://example.invalid/t25";
let jobId = "";

beforeAll(async () => {
  const job = await createJob({
    sourceUrl: "https://example.invalid/t25/truyen",
    adapter: "webnovel-vn",
  });
  jobId = job.id;
});

afterAll(async () => {
  await raw.job.deleteMany({
    where: { sourceUrl: { startsWith: t25Prefix } },
  });
  await raw.$disconnect();
});

describe("bảng transition — hợp lệ & hoàn chỉnh", () => {
  it("mọi state đều có entry, terminal không có đường ra", () => {
    for (const s of JOB_STATES) expect(JOB_TRANSITIONS[s]).toBeDefined();
    for (const s of CHAPTER_STAGES) expect(CHAPTER_TRANSITIONS[s]).toBeDefined();
    expect(JOB_TRANSITIONS.canceled).toEqual([]);
    expect(JOB_TRANSITIONS.completed).toEqual([]);
    expect(CHAPTER_TRANSITIONS.verified).toEqual([]);
    expect(CHAPTER_TRANSITIONS.failed).toEqual([]);
  });

  it("assertJobTransition: đường hợp lệ được nhận", () => {
    expect(() => assertJobTransition("queued", "running")).not.toThrow();
    expect(() => assertJobTransition("running", "waiting_quota")).not.toThrow();
    expect(() => assertJobTransition("waiting_quota", "running")).not.toThrow();
    expect(() => assertJobTransition("needs_review", "running")).not.toThrow();
    expect(() => assertJobTransition("running", "failed")).not.toThrow();
    expect(() => assertJobTransition("failed", "queued")).not.toThrow(); // retry
    expect(() => assertJobTransition("running", "completed")).not.toThrow();
  });

  it("assertJobTransition: chuyển bất hợp lệ bị CHẶN (kể cả terminal)", () => {
    expect(() => assertJobTransition("queued", "completed")).toThrow(InvalidTransitionError);
    expect(() => assertJobTransition("queued", "failed")).toThrow(InvalidTransitionError);
    expect(() => assertJobTransition("canceled", "running")).toThrow(InvalidTransitionError);
    expect(() => assertJobTransition("completed", "running")).toThrow(InvalidTransitionError);
    expect(() => assertJobTransition("hovering" as never, "running")).toThrow(
      InvalidTransitionError,
    );
  });

  it("assertChapterTransition: pipeline tuyến tính, bỏ qua được chặn", () => {
    expect(() => assertChapterTransition("discovered", "downloaded")).not.toThrow();
    expect(() => assertChapterTransition("tts_done", "verified")).not.toThrow();
    expect(() => assertChapterTransition("discovered", "qa_passed")).toThrow(InvalidTransitionError);
    expect(() => assertChapterTransition("verified", "verified")).not.toThrow(); // idempotent
    expect(() => assertChapterTransition("downloaded", "verified")).toThrow(InvalidTransitionError);
  });
});

describe("guard trong repo — transition bất hợp lệ KHÔNG âm thầm ghi", () => {
  it("queued → completed bị chặn, state giữ nguyên", async () => {
    await expect(setJobState({ jobId, state: "completed" })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    const job = await raw.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.state).toBe("queued");
  });

  it("chapter: discovered → qa_passed bị chặn; discovered → downloaded được", async () => {
    await raw.chapter.create({
      data: { jobId, index: 7, title: "C7", sourceUrl: "https://example.invalid/t25/7" },
    });
    await expect(
      setChapterStage({ jobId, chapterIndex: 7, stage: "qa_passed" }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    const r = await setChapterStage({ jobId, chapterIndex: 7, stage: "downloaded" });
    expect(r.to).toBe("downloaded");
  });

  it("canceled terminal: canceled → running bị chặn", async () => {
    const job = await createJob({
      sourceUrl: "https://example.invalid/t25/other",
      adapter: "x",
    });
    await setJobState({ jobId: job.id, state: "running" });
    await setJobState({ jobId: job.id, state: "canceled" });
    await expect(setJobState({ jobId: job.id, state: "running" })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it("idempotent replay qua setJobState: running → running không đổi timestamp", async () => {
    const first = await setJobState({ jobId, state: "running" });
    const job1 = await raw.job.findUniqueOrThrow({ where: { id: jobId } });
    const replay = await setJobState({ jobId, state: "running" });
    const job2 = await raw.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(first.to).toBe("running");
    expect(replay).toEqual({ from: "running", to: "running" });
    expect((job2.startedAt as Date).getTime()).toBe((job1.startedAt as Date).getTime());
  });
});
