// T8.4 — GET /api/jobs/:jobId/assets: job-scoped (asset của job khác KHÔNG thấy),
// 404 job lạ, đúng các trường phục vụ UI (không rò objectKey).
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

const t84Prefix = "https://example.invalid/t84";
let app: Awaited<ReturnType<typeof buildApp>>;
let jobId = "";
let otherJobId = "";

beforeAll(async () => {
  await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t84Prefix } } });
  app = await buildApp();
  jobId = (await createJob({ sourceUrl: `${t84Prefix}/chinh`, adapter: "webnovel-vn" })).id;
  otherJobId = (await createJob({ sourceUrl: `${t84Prefix}/kia`, adapter: "webnovel-vn" })).id;
});

afterAll(async () => {
  await raw.job.deleteMany({ where: { id: { in: [jobId, otherJobId] } } });
  await raw.$disconnect();
});

async function seedAsset(job: string, kind: string, size: number): Promise<string> {
  // verified: true — đúng bất biến production (asset chỉ tồn tại ghi được sau verify)
  const row = await raw.asset.create({
    data: {
      jobId: job,
      kind: kind as never,
      objectKey: `jobs/${job}/x-${kind}`,
      contentType: "application/octet-stream",
      size,
      sha256: "a".repeat(64),
      verified: true,
    },
    select: { id: true },
  });
  return row.id;
}

describe("GET /api/jobs/:jobId/assets (T8.4)", () => {
  it("list đúng job: 5 kind gồm 4 output; asset job khác KHÔNG lọt; không rò objectKey", async () => {
    const aM4b = await seedAsset(jobId, "m4b", 2048);
    const aMp4 = await seedAsset(jobId, "mp4", 4096);
    await seedAsset(jobId, "description", 700);
    await seedAsset(jobId, "chapter_audio", 999); // kind chương — API trả đủ, UI tự lọc
    await seedAsset(jobId, "thumbnail", 150);
    const leaked = await seedAsset(otherJobId, "m4b", 1); // của job khác — KHÔNG được thấy

    const res = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/assets` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { jobId: string; items: Array<Record<string, unknown>> };
    expect(body.jobId).toBe(jobId);
    const ids = body.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([aM4b, aMp4]));
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain(leaked); // job-scoped đúng nghĩa
    expect(body.items.every((i) => i.objectKey === undefined)).toBe(true);
    const m4b = body.items.find((i) => i.id === aM4b) as Record<string, unknown>;
    expect(m4b.size).toBe(2048);
    expect(m4b.verified).toBe(true);
  });

  it("job lạ → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/jobs/khong-co/assets" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
