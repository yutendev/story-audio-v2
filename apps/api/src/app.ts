// Fastify app factory (T3.1) — health/ready + error mapping thống nhất.
// Mọi lỗi JSON theo 1 shape: { error: { code, message } }.
import Fastify, { FastifyInstance } from "fastify";

import { ConflictError, NotFoundError, RepositoryError, ValidationError, getDb } from "./db";
import { InvalidTransitionError } from "./state-machine";
import { registerJobRoutes } from "./job-routes";
import { registerEventRoutes } from "./events-routes";
import { registerAssetRoutes } from "./asset-routes";

const HTTP_CODE: Record<string, number> = {
  NotFoundError: 404,
  ConflictError: 409,
  ValidationError: 400,
  InvalidTransitionError: 409,
};

export interface BuildAppOptions {
  logger?: boolean;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.API_LOG_LEVEL || "info" },
  });

  // Health: process sống, không đụng DB (cheap, cho LB)
  app.get("/healthz", async () => ({ status: "ok" }));

  // Ready: DB thực sự query được
  app.get("/readyz", async () => {
    await getDb().$queryRaw`SELECT 1`;
    return { status: "ready", db: "ok" };
  });

  const shape = (code: string, message: string) => ({ error: { code, message } });

  app.setErrorHandler((err, req, reply) => {
    req.log.warn({ err }, "request error");
    // Schema/validation lỗi của Fastify chuẩn hoá thành VALIDATION 400
    if ((err as { code?: string }).code === "FST_ERR_VALIDATION" || err.validation) {
      return reply.status(400).send(shape("VALIDATION", err.message));
    }
    if (err instanceof RepositoryError) {
      // Lỗi domain từ repo layer: map lỗi theo class
      if (err instanceof InvalidTransitionError) {
        return reply.status(409).send(shape("INVALID_TRANSITION", err.message));
      }
      if (err instanceof ConflictError) {
        return reply.status(409).send(shape("CONFLICT", err.message));
      }
      if (err instanceof NotFoundError) {
        return reply.status(404).send(shape("NOT_FOUND", err.message));
      }
      if (err instanceof ValidationError) {
        return reply.status(400).send(shape("VALIDATION", err.message));
      }
      return reply.status(400).send(shape("REPOSITORY_ERROR", err.message));
    }
    // Lỗi ECONNREFUSED / DB rớt → 503 (không phải lỗi client)
    if (/ECONNREFUSED|connection error|connect/i.test(String(err.message))) {
      return reply.status(503).send(shape("DB_UNAVAILABLE", "DB chưa sẵn sàng"));
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return reply
      .status(status)
      .send(shape(status === 500 ? "INTERNAL" : "REQUEST_ERROR", err.message));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(shape("NOT_FOUND", `Route ${req.method}:${req.url} không tồn tại`));
  });

  registerJobRoutes(app);
  registerEventRoutes(app);
  registerAssetRoutes(app);

  return app;
}
