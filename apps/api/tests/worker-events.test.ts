// T3.5 tests — protocol validator, persist events (idempotent), SSE ordered + reconnect.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

import { buildApp } from "../src/app";
import { persistWorkerEvents } from "../src/job-repository";
import { validateWorkerEvent } from "../src/worker-protocol";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t35Prefix = "https://example.invalid/t35";
let jobId = "";

async function newJob(tag: string): Promise<string> {
  const r = await raw.job.create({
    data: { sourceUrl: `https://example.invalid/t35/${tag}`, adapter: "webnovel-vn" },
  });
  return r.id;
}

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t35Prefix } } });
  jobId = await newJob("main");
  await raw.job.update({ where: { id: jobId }, data: { state: "running" } });
});

afterAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t35Prefix } } });
  await raw.$disconnect();
});

describe("validateWorkerEvent — protocol v1", () => {
  it("event hợp lệ các loại pass", () => {
    expect(validateWorkerEvent({
      protocol: "1", type: "stage_started", seq: 0, job_id: "j", stage: "extract",
    }).ok).toBe(true);
    expect(validateWorkerEvent({
      protocol: "1", type: "final", seq: 3, job_id: "j", status: "success", summary: "ok",
    }).ok).toBe(true);
    expect(validateWorkerEvent({
      protocol: "1", type: "artifact_ready", seq: 2, job_id: "j",
      path: "chapters/0001/audio/001.mp3", kind: "chapter_audio", checksum: "a".repeat(64),
    }).ok).toBe(true);
  });

  it("event hỏng bị chặn đúng lý do", () => {
    expect(validateWorkerEvent({ type: "final", seq: 1, job_id: "j" }).error).toContain("protocol");
    expect(validateWorkerEvent({ protocol: "2", type: "final", seq: 1, job_id: "j" }).error).toContain("protocol");
    expect(validateWorkerEvent({ protocol: "1", type: "alien", seq: 1, job_id: "j" }).error).toContain("type lạ");
    expect(validateWorkerEvent({ protocol: "1", type: "progress", seq: -1, job_id: "j", stage: "s", done: 1, total: 2 }).error).toContain("seq");
    expect(validateWorkerEvent({ protocol: "1", type: "final", seq: 1, job_id: "j", status: "magic", summary: "" }).error).toContain("status lạ");
    expect(validateWorkerEvent({ protocol: "1", type: "artifact_ready", seq: 1, job_id: "j", path: "../x", kind: "mp4", checksum: "a".repeat(64) }).error).toContain("path");
    expect(validateWorkerEvent({
      protocol: "1", type: "artifact_ready", seq: 1, job_id: "j", path: "a.mp3", kind: "mp4",
      checksum: "khong",
    }).error).toContain("checksum");
  });
});

describe("persistWorkerEvents — idempotent + status update", () => {
  it("persist 3 event theo thứ tự, job → completed khi final.success", async () => {
    const events = [
      { protocol: "1", type: "stage_started", seq: 0, job_id: jobId, stage: "extract" },
      { protocol: "1", type: "progress", seq: 1, job_id: jobId, stage: "extract", done: 5, total: 10 },
      { protocol: "1", type: "final", seq: 2, job_id: jobId, status: "success", summary: "hoàn tất" },
    ];
    const r = await persistWorkerEvents(jobId, events);
    expect(r).toMatchObject({ persisted: 3, duplicate: 0 });
    expect(r.rejected).toHaveLength(0);
    expect((await raw.job.findUniqueOrThrow({ where: { id: jobId } })).state).toBe("completed");

    // replay: không ghi lại (idempotent)
    const r2 = await persistWorkerEvents(jobId, events);
    expect(r2).toMatchObject({ persisted: 0, duplicate: 3 });
    expect(await raw.jobEvent.count({ where: { jobId } })).toBe(3);
  });

  it("event hỏng → rejected, không viết DB", async () => {
    const r = await persistWorkerEvents(jobId, [
      { protocol: "1", type: "final", seq: 99, job_id: jobId, status: "magic", summary: "" },
    ]);
    expect(r.rejected).toHaveLength(1);
    expect(await raw.jobEvent.count({ where: { jobId: jobId, seq: 99 } })).toBe(0);
  });

  it("final.failed → failed + lastError; quota_wait → waiting_quota + notBefore", async () => {
    const jF = await newJob("fail");
    await raw.job.update({ where: { id: jF }, data: { state: "running" } });
    await persistWorkerEvents(jF, [
      { protocol: "1", type: "final", seq: 4, job_id: jF, status: "failed", summary: "R2 upload lỗi" },
    ]);
    const f = await raw.job.findUniqueOrThrow({ where: { id: jF } });
    expect(f.state).toBe("failed");
    expect(f.lastError).toBe("R2 upload lỗi");

    const jQ = await newJob("quota");
    await raw.job.update({ where: { id: jQ }, data: { state: "running" } });
    const later = new Date(Date.now() + 60_000).toISOString();
    await persistWorkerEvents(jQ, [
      { protocol: "1", type: "quota_wait", seq: 4, job_id: jQ, backend: "gemini", not_before: later },
    ]);
    const q = await raw.job.findUniqueOrThrow({ where: { id: jQ } });
    expect(q.state).toBe("waiting_quota");
    expect(q.notBefore?.toISOString().slice(0, 19)).toBe(new Date(later).toISOString().slice(0, 19));
  });
});

describe("GET /api/jobs/:id/events — SSE ordered + reconnect + polling fallback", () => {
  it("stream nhận đủ event theo seq; until đóng stream", async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/events?after=-1&until=2`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    const i0 = body.indexOf("id: 0");
    const i1 = body.indexOf("id: 1");
    const i2 = body.indexOf("id: 2");
    expect(i0).toBeGreaterThanOrEqual(0);
    expect(i1).toBeGreaterThan(i0);
    expect(i2).toBeGreaterThan(i1);
    await app.close();
  });

  it("reconnect với Last-Event-ID=0 → nhận tiếp seq 1..2, không lặp 0", async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/events?until=2`,
      headers: { "last-event-id": "0" },
    });
    const body = res.body;
    expect(body).not.toContain("id: 0");
    expect(body).toContain("id: 1");
    expect(body).toContain("id: 2");
    await app.close();
  });

  it("polling fallback format=json → mảng theo seq", async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/events?format=json&after=1`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: { seq: number }[] };
    expect(body.events.map((e) => e.seq)).toEqual([2]);
    await app.close();
  });

  it("job lạ → 404 NOT_FOUND", async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: "/api/jobs/khong-có/events" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
