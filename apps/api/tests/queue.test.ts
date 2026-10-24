// T3.3 tests — PostgreSQL queue + single runner: tuần tự, chống duplicate, restart recovery.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

import { JobRunner, claimNextJob } from "../src/queue";
import { createJob } from "../src/job-repository";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

let jobIds: string[] = [];

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: "https://example.invalid/t33" } } });
});

afterAll(async () => {
  await raw.job.deleteMany({ where: { id: { in: jobIds } } });
  await raw.$disconnect();
});

async function newJob(tag: string): Promise<string> {
  const job = await createJob({
    sourceUrl: `https://example.invalid/t33/${tag}`,
    adapter: "webnovel-vn",
  });
  jobIds.push(job.id);
  return job.id;
}

describe("claimNextJob — atomic qua SKIP LOCKED", () => {
  it("2 claim đồng thời → job khác nhau, không chung một job", async () => {
    await newJob("c1");
    await newJob("c2");
    const [a, b] = await Promise.all([claimNextJob(), claimNextJob()]);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a!.id).not.toBe(b!.id);
    for (const { id } of [a!, b!]) {
      const job = await raw.job.findUniqueOrThrow({ where: { id } });
      expect(job.state).toBe("running");
      expect(job.claimedAt).toBeTruthy();
    }
  });

  it("hết hàng → null", async () => {
    await raw.job.deleteMany({ where: { sourceUrl: { startsWith: "https://example.invalid/t33" } } });
    expect(await claimNextJob()).toBeNull();
  });
});

describe("JobRunner — tuần tự + restart recovery", () => {
  it("2 job với nhau chạy TUẦN TỰ theo created_at, mỗi job đúng 1 lần", async () => {
    const order: string[] = [];
    const executed: string[] = [];
    const runner = new JobRunner(
      async (id) => {
        order.push(id);
        // hoàn thành job để runner chuyển sang job kế
        await raw.job.update({ where: { id }, data: { state: "completed" } });
        executed.push(id);
      },
      { pollMs: 20 },
    );
    const a = await newJob("r1");
    const b = await newJob("r2");
    runner.start();

    for (let i = 0; i < 100; i++) {
      const states = await raw.job.findMany({ where: { id: { in: [a, b] } }, select: { state: true } });
      if (states.every((j) => j.state === "completed")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    runner.stop();
    expect(order).toEqual([a, b]); // created_at asc
    expect(executed).toEqual([a, b]); // mỗi job đúng 1 lần
  });

  it("restart mô phỏng: job orphan running được requeue, KHÔNG mất & KHÔNG chạy 2 lần", async () => {
    // old runner "chết" khi đang giữ A (running) — B vẫn queued
    const a = await newJob("restart");
    const b = await newJob("restart");
    await raw.job.update({ where: { id: a }, data: { state: "running", claimedAt: new Date() } });

    const executed: string[] = [];
    const runner = new JobRunner(
      async (id) => {
        executed.push(id);
        await raw.job.update({ where: { id }, data: { state: "completed" } });
      },
      { pollMs: 20 },
    );
    runner.start();
    for (let i = 0; i < 100; i++) {
      const states = await raw.job.findMany({ where: { id: { in: [a, b] } }, select: { state: true } });
      if (states.every((j) => j.state === "completed")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    runner.stop();

    expect(executed).toEqual([a, b]); // A requeue (không mất) rồi B
    expect(executed.filter((x) => x === a)).toHaveLength(1); // không chạy 2 lần
    const jobs = await raw.job.findMany({ where: { id: { in: [a, b] } } });
    expect(jobs.every((j) => j.state === "completed")).toBe(true);
  });

  it("handler ném exception → job failed + event error được ghi", async () => {
    const a = await newJob("boom");
    const runner = new JobRunner(
      async () => {
        throw new Error("chết nho");
      },
      { pollMs: 20 },
    );
    runner.start();
    for (let i = 0; i < 100; i++) {
      const j = await raw.job.findUnique({ where: { id: a } });
      if (j?.state === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    runner.stop();
    const job = await raw.job.findUniqueOrThrow({ where: { id: a } });
    expect(job.state).toBe("failed");
    expect(job.lastError).toContain("chết nho");
    const ev = await raw.jobEvent.findFirst({ where: { jobId: a, eventType: "error" } });
    expect(ev).toBeTruthy();
  });
});

describe("waiting_quota — hết notBefore thì claim lại được", () => {
  it("notBefore quá khứ → waiting_quota job được claim về running", async () => {
    const id = await newJob("quota");
    await raw.job.update({
      where: { id },
      data: { state: "waiting_quota", notBefore: new Date(Date.now() - 1000) },
    });
    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(id);
    const job = await raw.job.findUniqueOrThrow({ where: { id } });
    expect(job.state).toBe("running");
  });
});
