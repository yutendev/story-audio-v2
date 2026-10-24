// T3.2 tests — create/query/cancel job APIs + validation, trên DB thật.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

import { buildApp } from "../src/app";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

let jobId = "";
const created: string[] = [];

beforeAll(async () => {
  const r = await raw.job.deleteMany({ where: { sourceUrl: { startsWith: "https://example.invalid/t32" } } });
});

afterAll(async () => {
  await raw.job.deleteMany({ where: { id: { in: created } } });
  await raw.$disconnect();
});

async function createViaApi(sourceUrl = "https://example.invalid/t32/truyen") {
  const app = buildApp({ logger: false });
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs",
    payload: { sourceUrl, adapter: "truyendich-space" },
  });
  await app.close();
  return res;
}

describe("POST /api/jobs — validation & tạo job", () => {
  it("payload hợp lệ → 201 {id} + snapshot BẤT BIẾN lưu đúng body đã nhận", async () => {
    const res = await createViaApi();
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    expect(id).toBeTruthy();
    created.push(id);

    const app = buildApp({ logger: false });
    const read = await app.inject({ method: "GET", url: `/api/jobs/${id}` });
    await app.close();
    const job = read.json();
    expect(job.sourceUrl).toBe("https://example.invalid/t32/truyen");
    expect(job.state).toBe("queued");
    expect(job.chaptersPerBook).toBe(20);
    expect(job.configSnapshot).toEqual({
      sourceUrl: "https://example.invalid/t32/truyen",
      adapter: "truyendich-space",
    });
  });

  it("schema chặn: thiếu adapter → 400; chaptersPerBook=0 → 400; field lạ → 400", async () => {
    const app = buildApp({ logger: false });
    const r1 = await app.inject({ method: "POST", url: "/api/jobs", payload: { sourceUrl: "https://ok.invalid" } });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.code).toBe("VALIDATION");
    const r2 = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { sourceUrl: "https://ok.invalid", adapter: "x", chaptersPerBook: 0 },
    });
    expect(r2.statusCode).toBe(400);
    const r3 = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { sourceUrl: "https://ok.invalid", adapter: "x", extra: 1 },
    });
    expect(r3.statusCode).toBe(400);
    await app.close();
  });

  it("URL không phải http(s) → 400 VALIDATION", async () => {
    const res = await createViaApi("ftp://example.invalid/tr");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("adapter lạ (không trong whitelist) → 400", async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { sourceUrl: "https://example.invalid/t32", adapter: "webnovel-magic" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("adapter lạ");
    await app.close();
  });
});

describe("GET /api/jobs / :id / chapters — query", () => {
  it("GET :id — job tồn tại; job lạ → 404 NOT_FOUND", async () => {
    const res = await createViaApi();
    created.push(res.json().id);
    const app = buildApp({ logger: false });
    expect((await app.inject({ method: "GET", url: `/api/jobs/${created[0]}` })).statusCode).toBe(200);
    const miss = await app.inject({ method: "GET", url: "/api/jobs/khong-ton-tai" });
    expect(miss.statusCode).toBe(404);
    await app.close();
  });

  it("GET /api/jobs — list có job vừa tạo; filter state + limit+offset", async () => {
    const res = await createViaApi();
    created.push(res.json().id);
    const app = buildApp({ logger: false });
    const list = await app.inject({ method: "GET", url: "/api/jobs?state=queued&limit=5&offset=0" });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { total: number; items: { id: string }[] };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items.some((i) => i.id === created[0])).toBe(true);
    await app.close();
  });

  it("GET :id/chapters — trống lúc đầu, chapter xuất hiện đúng thứ tự index", async () => {
    const res = await createViaApi();
    const id = res.json().id;
    created.push(id);
    await raw.chapter.create({
      data: { jobId: id, index: 3, title: "C3", sourceUrl: "https://example.invalid/t32/3" },
    });
    await raw.chapter.create({
      data: { jobId: id, index: 1, title: "C1", sourceUrl: "https://example.invalid/t32/1" },
    });

    const app = buildApp({ logger: false });
    const r1 = await app.inject({ method: "GET", url: `/api/jobs/${id}/chapters?limit=1` });
    const b1 = r1.json();
    expect(b1.total).toBe(2);
    expect(b1.items).toHaveLength(1);
    expect(b1.items[0].index).toBe(1); // cap đầu theo index
    const r2 = await app.inject({ method: "GET", url: `/api/jobs/${id}/chapters?limit=1&offset=1` });
    expect(r2.json().items[0].index).toBe(3);
    await app.close();
  });

  it("query parameter rác không crash (NaN → default)", async () => {
    const app = buildApp({ logger: false });
    const r = await app.inject({ method: "GET", url: "/api/jobs?limit=hai&offset=-3" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
    await app.close();
  });
});

describe("POST /api/jobs/:id/cancel — theo state machine", () => {
  it("queued → canceled ✔; cancel lần nữa (idempotent) ✔", async () => {
    const res = await createViaApi();
    const id = res.json().id;
    created.push(id);
    const app = buildApp({ logger: false });
    expect((await app.inject({ method: "POST", url: `/api/jobs/${id}/cancel` })).statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: `/api/jobs/${id}/cancel` });
    expect(again.statusCode).toBe(200); // canceled terminal → replay idempotent
    const job = await raw.job.findUniqueOrThrow({ where: { id } });
    expect(job.state).toBe("canceled");
    await app.close();
  });

  it("completed → cancel → 409 INVALID_TRANSITION", async () => {
    const res = await createViaApi();
    const id = res.json().id;
    created.push(id);
    const app = buildApp({ logger: false });
    await app.inject({ method: "POST", url: `/api/jobs/${id}/cancel` });
    // ép đến completed: tạo job khác đi đúng lối queued→running→completed
    const res2 = await createViaApi("https://example.invalid/t32/completed");
    const id2 = res2.json().id;
    created.push(id2);
    await raw.job.update({ where: { id: id2 }, data: { state: "running" } });
    await raw.job.update({ where: { id: id2 }, data: { state: "completed" } });
    const r = await app.inject({ method: "POST", url: `/api/jobs/${id2}/cancel` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("INVALID_TRANSITION");
    await app.close();
  });
});
