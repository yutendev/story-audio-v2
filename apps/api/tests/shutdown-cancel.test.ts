// T3.6 tests — cancellation signals + graceful shutdown; canceled vs failed vs orphan.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

import { buildApp } from "../src/app";
import { JobRunner } from "../src/queue";
import { gracefulShutdown } from "../src/shutdown";
import { createJob } from "../src/job-repository";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t36Prefix = "https://example.invalid/t36";
const createdIds: string[] = [];

async function newJob(tag: string): Promise<string> {
  const job = await createJob({
    sourceUrl: `https://example.invalid/t36/${tag}`,
    adapter: "webnovel-vn",
  });
  createdIds.push(job.id);
  return job.id;
}

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t36Prefix } } });
});

afterAll(async () => {
  await raw.job.deleteMany({ where: { id: { in: createdIds } } });
  await raw.$disconnect();
});

describe("cancel job đang chạy qua runner — signal abort", () => {
  it("cancel giữa chừng: handler nhận aborted, state canceled, job khác chạy tiếp", async () => {
    const running = await newJob("cancel-run");
    const other = await newJob("other");

    let aborted = false;
    const runner = new JobRunner(
      async (_jobId, signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject("canceled"); // handler chủ động dừng công việc
          });
        });
      },
      { pollMs: 20 },
    );
    runner.start();

    // đợi runner claim job đầu (created_at asc → running)
    for (let i = 0; i < 100; i++) {
      const j = await raw.job.findUnique({ where: { id: running } });
      if (j?.state === "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // cancel qua HTTP thật
    const app = buildApp({ logger: false });
    const res = await app.inject({ method: "POST", url: `/api/jobs/${running}/cancel` });
    await app.close();
    expect(res.statusCode).toBe(200);

    for (let i = 0; i < 100; i++) {
      if (aborted) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(aborted).toBe(true);
    expect((await raw.job.findUniqueOrThrow({ where: { id: running } })).state).toBe("canceled");

    // runner tiếp tục claim job khỏi canceled
    for (let i = 0; i < 100; i++) {
      const j = await raw.job.findUnique({ where: { id: other } });
      if (j?.state === "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    runner.stop();
    expect((await raw.job.findUniqueOrThrow({ where: { id: other } })).state).toBe("running");
  });
});

describe("gracefulShutdown — ngừng claim, hoàn tất handler hiện tại, không mất job queued", () => {
  it("shutdown trong lúc handler chạy: job hoàn tất; job queued còn nguyên chờ boot sau", async () => {
    await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t36Prefix } } });
    const a = await newJob("sh-1");
    const b = await newJob("sh-2");
    const executed: string[] = [];
    const runner = new JobRunner(
      async (jobId) => {
        await new Promise((r) => setTimeout(r, 200)); // công việc 200ms
        executed.push(jobId);
        await raw.job.update({ where: { id: jobId }, data: { state: "completed" } });
      },
      { pollMs: 20 },
    );
    runner.start();
    for (let i = 0; i < 100; i++) {
      const j = await raw.job.findUnique({ where: { id: a } });
      if (j?.state === "running") break;
      await new Promise((r) => setTimeout(r, 40));
    }
    await gracefulShutdown({ runner, graceMs: 2000 });
    expect(executed).toEqual([a]); // handler hiện tại được hoàn tất
    expect((await raw.job.findUniqueOrThrow({ where: { id: a } })).state).toBe("completed");
    // b chưa bị claim — để lại nguyên vẹn cho lần boot sau (requeueOrphans chạy lúc start())
    expect((await raw.job.findUniqueOrThrow({ where: { id: b } })).state).toBe("queued");
  });
});

describe("canceled vs failed vs orphan — semant khác nhau", () => {
  it("canceled KHÔNG được requeue từ orphan recovery; running thì requeue", async () => {
    const done = await newJob("semantics");
    await raw.job.update({ where: { id: done }, data: { state: "canceled" } });
    const orphan = await newJob("semantics-orphan");
    await raw.job.update({ where: { id: orphan }, data: { state: "running" } });

    // recovery của runner boot đang chạy trong start() — mô phỏng: gọi lạiBOOT mới qua JobRunner
    const runner = new JobRunner(async () => {}, { pollMs: 30 });
    runner.start();
    await new Promise((r) => setTimeout(r, 120));
    runner.stop();
    // canceled terminal: đứng yên dù recovery còn chạy
    expect((await raw.job.findUniqueOrThrow({ where: { id: done } })).state).toBe("canceled");
    // orphan running: requeue về queued (hoặc claim lại ngay = running) — KHÔNG mất
    const orphanState = (await raw.job.findUniqueOrThrow({ where: { id: orphan } })).state;
    expect(["queued", "running"]).toContain(orphanState);
  });
});
