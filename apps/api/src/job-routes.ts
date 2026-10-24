// Job API routes (T3.2) — POST /api/jobs, GET :id, GET :id/chapters, GET /api/jobs, POST :id/cancel.
// Cứng theo state machine (T2.5): hành động không hợp lệ → 409 INVALID_TRANSITION.
import { FastifyInstance } from "fastify";

import { NotFoundError, ValidationError, getDb } from "./db";
import {
  createJob,
  getJob,
  setJobState,
} from "./job-repository";
import {
  updatePackagingSettings,
  validatePackagingSettings,
} from "./pkg-settings";
import { InvalidTransitionError } from "./state-machine";
import { signalCancel } from "./active-runs";

const CREATE_BODY = {
  type: "object",
  required: ["sourceUrl", "adapter"],
  additionalProperties: false,
  properties: {
    sourceUrl: { type: "string", minLength: 8, maxLength: 2048 },
    adapter: { type: "string", minLength: 1, maxLength: 64 },
    chaptersPerBook: { type: "integer", minimum: 1, maximum: 1000 },
    export: { type: "object" }, // chi tiết validate ở pkg-settings (messages tốt hơn)
  },
} as const;

const ADAPTERS = new Set(["webnovel-vn", "truyendich-space"]); // source-audit §3

// query int an toàn: NaN/khiểu → default
const toInt = (raw: string | undefined, def: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};

export function registerJobRoutes(app: FastifyInstance): void {
  app.post("/api/jobs", { schema: { body: CREATE_BODY } }, async (req, reply) => {
    const body = req.body as {
      sourceUrl: string;
      adapter: string;
      chaptersPerBook?: number;
      export?: Record<string, unknown>;
    };
    if (!ADAPTERS.has(body.adapter)) {
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION", message: `adapter lạ: '${body.adapter}'` } });
    }
    if (!/^https?:\/\//.test(body.sourceUrl)) {
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION", message: "sourceUrl phải là http(s) URL" } });
    }
    // T7.1: validate packaging settings trước khi tạo; snapshot giữ export settings
    let settings;
    try {
      settings = validatePackagingSettings({
        chaptersPerBook: body.chaptersPerBook,
        export: body.export,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: e.message } });
      }
      throw e;
    }
    const job = await createJob({
      sourceUrl: body.sourceUrl,
      adapter: body.adapter,
      chaptersPerBook: settings.chaptersPerBook,
      // contract T3.2: snapshot = đúng body đã nhận; chỉ bổ sung export khi caller truyền
      configSnapshot: body.export === undefined ? body : { ...body, export: settings.export },
    });
    return reply.status(201).send({ id: job.id });
  });

  app.get("/api/jobs", async (req) => {
    const q = (req.query ?? {}) as { state?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(toInt(q.limit, 20), 1), 100);
    const offset = Math.max(toInt(q.offset, 0), 0);
    const state = q.state ? { state: q.state as never } : {};
    const db = getDb();
    const [items, total] = await Promise.all([
      db.job.findMany({ where: state, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
      db.job.count({ where: state }),
    ]);
    return { total, limit, offset, items: items.map((j) => ({ id: j.id, state: j.state, sourceUrl: j.sourceUrl, createdAt: j.createdAt })) };
  });

  app.get("/api/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await getJob(id);
    if (!job) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "job không tồn tại" } });
    }
    return job;
  });

  app.get("/api/jobs/:id/chapters", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = (req.query ?? {}) as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(toInt(q.limit, 50), 1), 200);
    const offset = Math.max(toInt(q.offset, 0), 0);
    const db = getDb();
    const job = await db.job.findUnique({ where: { id }, select: { id: true } });
    if (!job) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "job không tồn tại" } });
    }
    const chapters = await db.chapter.findMany({
      where: { jobId: id },
      orderBy: { index: "asc" },
      take: limit,
      skip: offset,
      select: {
        index: true,
        title: true,
        stageState: true,
        reviewState: true,
        textAssetId: true,
        audioAssetId: true,
      },
    });
    const total = await db.chapter.count({ where: { jobId: id } });
    return { total, limit, offset, items: chapters };
  });

  app.patch("/api/jobs/:id/settings", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const settings = await updatePackagingSettings(id, req.body);
      return { jobId: id, chaptersPerBook: settings.chaptersPerBook, export: settings.export };
    } catch (e) {
      if (e instanceof NotFoundError) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "job không tồn tại" } });
      }
      if (e instanceof ValidationError) {
        return reply.status(400).send({ error: { code: "VALIDATION", message: e.message } });
      }
      throw e;
    }
  });

  app.post("/api/jobs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await setJobState({ jobId: id, state: "canceled" });
      // T3.6: nếu job đang chạy trong runner — signal để handler tự kết thúc đàng hoàng
      signalCancel(id);
    } catch (e) {
      if (e instanceof InvalidTransitionError) {
        return reply.status(409).send({ error: { code: "INVALID_TRANSITION", message: e.message } });
      }
      if (e instanceof NotFoundError) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "job không tồn tại" } });
      }
      throw e;
    }
    return { canceled: true };
  });

  // T8.3 — retry (failed → queued) + resume (waiting_quota/needs_review → running,
  // theo bảng JOB_TRANSITIONS T5.6/T5.7). Cùng mapping lỗi như cancel: UI không tự
  // cấm nút — nhấn sai vẫn nhận 409 từng chữ để hiển thị nguyên văn.
  for (const action of [
    { path: "retry", state: "queued" as const, key: "retried" },
    { path: "resume", state: "running" as const, key: "resumed" },
  ]) {
    app.post(`/api/jobs/:id/${action.path}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        // clearClaims: resume/retry là hành động NGƯỜI DÙNG chủ động chạy lại —
        // quét mọi điều kiện chờ cũ (claimed_at/notBefore) để lần claim kế lập tức nhặt
        await setJobState({ jobId: id, state: action.state, clearClaims: true });
      } catch (e) {
        if (e instanceof InvalidTransitionError) {
          return reply
            .status(409)
            .send({ error: { code: "INVALID_TRANSITION", message: e.message } });
        }
        if (e instanceof NotFoundError) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "job không tồn tại" } });
        }
        throw e;
      }
      return { jobId: id, [action.key]: true };
    });
  }

  // DELETE /api/jobs/:id — Xóa vĩnh viễn job và toàn bộ dữ liệu phụ thuộc (cascade)
  app.delete("/api/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const job = await db.job.findUnique({ where: { id } });
    if (!job) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "job không tồn tại" } });
    }
    // Hủy active process nếu đang chạy
    signalCancel(id);
    await db.job.delete({ where: { id } });
    return { id, deleted: true };
  });
}
