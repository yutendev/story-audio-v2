// T3.1 tests — health, ready (DB thật), structured error shape, env validation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

import { buildApp } from "../src/app";
import { validateEnv } from "../src/env";
import { NotFoundError, ValidationError } from "../src/db";
import { InvalidTransitionError } from "../src/state-machine";
import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

describe("health/ready", () => {
  it("/healthz không cần DB", async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("/readyz với DB dev thật → ready", async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", db: "ok" });
    await app.close();
  });
});

describe("structured error shape — { error: { code, message } }", () => {
  it("route lạ → 404 NOT_FOUND", async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: "/khong-ton-tai" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.message).toBe("string");
    await app.close();
  });

  const cases: [
    string,
    { method: string; url: string } | never,
    Error,
    number,
    string,
  ][] = [
    ["ValidationError → 400", { method: "GET", url: "/b/validation" }, new ValidationError("bad input"), 400, "VALIDATION"],
    ["NotFoundError → 404", { method: "GET", url: "/b/notfound" }, new NotFoundError("tk"), 404, "NOT_FOUND"],
    ["InvalidTransition → 409", { method: "GET", url: "/b/transition" }, new InvalidTransitionError("nope"), 409, "INVALID_TRANSITION"],
    ["lỗi lạ → 500 INTERNAL", { method: "GET", url: "/b/boom" }, new Error("nổ"), 500, "INTERNAL"],
  ];

  for (const [name, injectOpts, thrown, expectedStatus, expectedCode] of cases) {
    it(`mapping: ${name}`, async () => {
      const app = buildApp({ logger: false });
      app.get("/b/:which", async (req) => {
        throw thrown;
      });
      const res = await app.inject(injectOpts as { method: string; url: string });
      expect(res.statusCode).toBe(expectedStatus);
      const body = res.json();
      expect(body.error.code).toBe(expectedCode);
      expect(typeof body.error.message).toBe("string");
      await app.close();
    });
  }
});

describe("validateEnv — environment validation", () => {
  it("thiếu DATABASE_URL → trả problems", () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const problems = validateEnv();
      expect(problems).toEqual([{ field: "DATABASE_URL", reason: "thiếu" }]);
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  it("DATABASE_URL không phải postgres → problemas rõ", () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "mysql://x";
    try {
      const problems = validateEnv();
      expect(problems![0].reason).toContain("postgres");
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  it("env đúng → null", () => {
    expect(validateEnv()).toBeNull();
  });
});
