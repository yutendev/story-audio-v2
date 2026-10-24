// T7.1 tests — cài đặt đóng gói theo job: validate settings (unit, offline) +
// persist qua API (PostgreSQL dev thật): create với chaptersPerBook/export, PATCH
// và đọc lại qua app instance MỚI = "persisted across restart".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

import { buildApp } from "../src/app";
import {
  PACKAGING_DEFAULT_CHAPTERS,
  readPackagingSettings,
  validateExportSettings,
  validatePackagingSettings,
} from "../src/pkg-settings";
import { ValidationError } from "../src/db";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

const t71Prefix = "https://example.invalid/t71";

describe("validatePackagingSettings — unit (offline)", () => {
  it("default 20 khi bỏ trống; export bỏ trống = {}", () => {
    const s = validatePackagingSettings({});
    expect(s.chaptersPerBook).toBe(PACKAGING_DEFAULT_CHAPTERS);
    expect(s.export).toEqual({});
  });

  it("10 / 20 / 30 / 1000 hợp lệ (full-story = chọn giá trị lớn, vd 1000)", () => {
    for (const n of [10, 20, 30, 1000]) {
      expect(validatePackagingSettings({ chaptersPerBook: n }).chaptersPerBook).toBe(n);
    }
  });

  it("0 / -1 / 1.5 / '20' (chuỗi) / 1001 → ValidationError", () => {
    // null/undefined = "không truyền" (CREATE default 20; PATCH giữ nguyên) — không thuộc list sai
    for (const bad of [0, -1, 1.5, "20", 1001, Number.NaN]) {
      expect(() => validatePackagingSettings({ chaptersPerBook: bad })).toThrow(ValidationError);
    }
  });

  it("export: flat string | number | boolean hợp lệ", () => {
    const s = validatePackagingSettings({
      chaptersPerBook: 20,
      export: { bookTitle: "Truyện abc", coverBrightness: 0.8, isAdult: true },
    });
    expect(s.export).toEqual({ bookTitle: "Truyện abc", coverBrightness: 0.8, isAdult: true });
  });

  it("export: key sai quy tắc (dấu cách, ký tự lạ, >32 ký tự, bắt đầu bằng số) → ValidationError", () => {
    for (const key of ["weird key", "có-dấu-gạch", "a".repeat(33), "1sốđầu", ""]) {
      expect(() => validateExportSettings({ [key]: "x" })).toThrow(ValidationError);
    }
  });

  it("export: giá trị lồng/null/array/mảng gốc → ValidationError", () => {
    expect(() => validateExportSettings({ cover: { url: "https://x" } })).toThrow(ValidationError);
    expect(() => validateExportSettings({ cover: null })).toThrow(ValidationError);
    expect(() => validateExportSettings({ tags: ["a", "b"] })).toThrow(ValidationError);
    expect(() => validateExportSettings(["không phải object"])).toThrow(ValidationError);
  });

  it("export: chuỗi quá 512 ký tự → ValidationError", () => {
    expect(() => validateExportSettings({ tooLong: "x".repeat(513) })).toThrow(ValidationError);
    expect(validateExportSettings({ ok: "x".repeat(512) }).ok).toBe("x".repeat(512));
  });
});

describe("API settings — persist cài đặt đóng gói (DB thật)", () => {
  let jobId = "";

  async function freshApp() {
    return buildApp({ logger: false }); // instance MỚI mỗi lần = mô phỏng restart
  }

  beforeAll(async () => {
    await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t71Prefix } } });
  });

  afterAll(async () => {
    await raw.job.deleteMany({ where: { sourceUrl: { startsWith: t71Prefix } } });
    await raw.$disconnect();
  });

  it("POST với chaptersPerBook 30 + export settings → 201; GET đọc lại đúng", async () => {
    const app = await freshApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        sourceUrl: `${t71Prefix}/truyen`,
        adapter: "webnovel-vn",
        chaptersPerBook: 30,
        export: { bookTitle: "Truyện A", audioBitrateKbps: 64, isAdult: true },
      },
    });
    expect(res.statusCode).toBe(201);
    jobId = res.json().id;
    await app.close();

    const app2 = await freshApp();
    const got = await app2.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().chaptersPerBook).toBe(30);
    expect(got.json().configSnapshot.export).toEqual({
      bookTitle: "Truyện A",
      audioBitrateKbps: 64,
      isAdult: true,
    });
    await app2.close();

    // đường đọc qua service — cột + snapshot nhất quán
    const s = await readPackagingSettings(jobId);
    expect(s.chaptersPerBook).toBe(30);
    expect(s.export).toEqual({ bookTitle: "Truyện A", audioBitrateKbps: 64, isAdult: true });
  });

  it("POST chaptersPerBook 1000 (full-story) → 201; POST export giá trị lồng → 400", async () => {
    const app = await freshApp();
    const ok = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { sourceUrl: `${t71Prefix}/full`, adapter: "webnovel-vn", chaptersPerBook: 1000 },
    });
    expect(ok.statusCode).toBe(201);

    const bad = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        sourceUrl: `${t71Prefix}/nested`,
        adapter: "webnovel-vn",
        export: { cover: { url: "https://x" } },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION");
    await app.close();
  });

  it("PATCH settings → 200; đọc lại bằng instance MỚI (restart) vẫn thấy giá trị mới", async () => {
    const app = await freshApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/settings`,
      payload: { chaptersPerBook: 10, export: { bookTitle: "Truyện B" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ jobId, chaptersPerBook: 10, export: { bookTitle: "Truyện B" } });
    await app.close();

    const app2 = await freshApp();
    const got = await app2.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    expect(got.json().chaptersPerBook).toBe(10); // persist qua "restart"
    expect((await readPackagingSettings(jobId)).export).toEqual({ bookTitle: "Truyện B" });
    await app2.close();
  });

  it("PATCH chỉ export → giữ nguyên chaptersPerBook trước đó", async () => {
    const app = await freshApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/settings`,
      payload: { export: { onlyExport: 1 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().chaptersPerBook).toBe(10); // giữ từ PATCH trước
    expect(res.json().export).toEqual({ onlyExport: 1 });
    await app.close();

    const gone = await raw.job.findUnique({ where: { id: jobId }, select: { configSnapshot: true } });
    // export cũ bị thay toàn bộ (không merge sâu) — key cũ không sống sót
    expect((gone?.configSnapshot as Record<string, unknown>).export).toEqual({ onlyExport: 1 });
  });

  it("PATCH sai giá trị: 0 / chuỗi '20' / export lồng → 400 + message rõ", async () => {
    const app = await freshApp();
    for (const payload of [{ chaptersPerBook: 0 }, { chaptersPerBook: "20" }, { export: { x: [1] } }]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/jobs/${jobId}/settings`,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION");
    }
    await app.close();
  });

  it("PATCH job không tồn tại → 404", async () => {
    const app = await freshApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/jobs/không-có/settings",
      payload: { chaptersPerBook: 20 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("PATCH body rỗng → 200 giữ nguyên settings (không đổi gì)", async () => {
    const app = await freshApp();
    const res = await app.inject({ method: "PATCH", url: `/api/jobs/${jobId}/settings`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().chaptersPerBook).toBe(10);
    await app.close();
  });
});
