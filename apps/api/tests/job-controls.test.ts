// T8.3 — route retry/resume: chặn đúng bởi state machine (409 nguyên văn), 404 job lạ,
// state thực sự đổi. Semantics: retry failed→queued (claimable), resume waiting_quota/
// needs_review→running (bảng JOB_TRANSITIONS T5.6/T5.7).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

import { buildApp } from "../src/app";
import { createJob } from "../src/job-repository";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t83Prefix = "https://example.invalid/t83";
let app: Awaited<ReturnType<typeof buildApp>>;
const createdIds: string[] = [];

async function newJob(tag: string, state?: string): Promise<string> {
  const job = await createJob({
    sourceUrl: `${t83Prefix}/${tag}`,
    adapter: "webnovel-vn",
  });
  createdIds.push(job.id);
  if (state) {
    await raw.job.update({ where: { id: job.id }, data: { state: state as never } });
  }
  return job.id;
}

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t83Prefix } } });
  app = await buildApp();
});

afterAll(async () => {
  await raw.job.deleteMany({ where: { id: { in: createdIds } } });
  await raw.$disconnect();
});

async function stateOf(id: string): Promise<string> {
  const job = await raw.job.findUniqueOrThrow({ where: { id }, select: { state: true } });
  return job.state;
}

describe("POST /api/jobs/:id/retry", () => {
  it("failed → queued (claimable), body rõ ràng", async () => {
    const id = await newJob("retry-ok", "failed");
    const res = await app.inject({ method: "POST", url: `/api/jobs/${id}/retry` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobId: id, retried: true });
    expect(await stateOf(id)).toBe("queued");
  });

  it("running → 409 INVALID_TRANSITION với message cụ thể; KHÔNG đổi state", async () => {
    const id = await newJob("retry-running", "running");
    const res = await app.inject({ method: "POST", url: `/api/jobs/${id}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INVALID_TRANSITION");
    expect(res.json().error.message).toMatch(/running/);
    expect(await stateOf(id)).toBe("running");
  });

  it("completed (terminal) → 409", async () => {
    const id = await newJob("retry-terminal", "completed");
    const res = await app.inject({ method: "POST", url: `/api/jobs/${id}/retry` });
    expect(res.statusCode).toBe(409);
  });

  it("job lạ → 404", async () => {
    const res = await app.inject({ method: "POST", url: "/api/jobs/khong-co/retry" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/jobs/:id/resume", () => {
  it("waiting_quota → running", async () => {
    const id = await newJob("resume-quota", "waiting_quota");
    const res = await app.inject({ method: "POST", url: `/api/jobs/${id}/resume` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobId: id, resumed: true });
    expect(await stateOf(id)).toBe("running");
  });

  it("needs_review → running (duyệt xong tiếp tục)", async () => {
    const id = await newJob("resume-review", "needs_review");
    const res = await app.inject({ method: "POST", url: `/api/jobs/${id}/resume` });
    expect(res.statusCode).toBe(200);
    expect(await stateOf(id)).toBe("running");
  });

  it("queued → running là transition HỢP LỆ theo máy trạng thái → 200 (UI không hiện nút resume cho queued, nhưng API vẫn đúng luật)", async () => {
    const id = await newJob("resume-queued", "queued");
    const res = await app.inject({ method: "POST", url: `/api/jobs/${id}/resume` });
    expect(res.statusCode).toBe(200);
    expect(await stateOf(id)).toBe("running");
  });

  it("canceled (terminal) → 409", async () => {
    const id = await newJob("resume-canceled", "canceled");
    const res = await app.inject({ method: "POST", url: `/api/jobs/${id}/resume` });
    expect(res.statusCode).toBe(409);
  });
});
