// Events API (T3.5) — SSE stream + JSON polling fallback cho cùng dữ liệu.
// Reconnect: dùng `after=<seq>` hoặc header Last-Event-ID → không mất state (event dừng trong DB).
// Param `until=<seq>` CHỈ cho test/CLI đóng stream deterministic — UI không dùng.
import { FastifyInstance } from "fastify";

import { getDb } from "./db";

const toIntOr = (raw: unknown, def: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};

export function registerEventRoutes(app: FastifyInstance): void {
  app.get("/api/jobs/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const db = getDb();

    const job = await db.job.findUnique({ where: { id }, select: { id: true } });
    if (!job) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "job không tồn tại" } });
    }

    const after = toIntOr(req.headers["last-event-id"] ?? q.after, -1);
    // PostgreSQL Int32 max — cap an toàn cho seq; MAX_SAFE_INTEGER gây lỗi "Value out of range"
    const INT_MAX = 2147483647;
    const until = q.until ? Math.min(toIntOr(q.until, INT_MAX), INT_MAX) : INT_MAX;

    const fetchNew = async (from: number) =>
      db.jobEvent.findMany({
        where: { jobId: id, seq: { gt: from, lte: until } },
        orderBy: { seq: "asc" },
        select: { seq: true, eventType: true, message: true, data: true, createdAt: true },
      });

    // Polling fallback (UI hoặc HTTP client thường): format=json → trả JSON list
    if (q.format === "json") {
      const rows = await fetchNew(after);
      return {
        jobId: id,
        after,
        events: rows.map((r) => {
          const dataObj = r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {};
          return {
            seq: r.seq,
            type: r.eventType,
            message: r.message ?? (dataObj.message as string | undefined) ?? (dataObj.summary as string | undefined),
            createdAt: r.createdAt.toISOString(),
            ...dataObj,
          };
        }),
      };
    }

    // SSE stream
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 2000\n\n");

    let lastSeq = after;
    let done = false;
    const POLL_MS = 250;
    const KEEPALIVE_MS = 10_000;
    const startedAt = Date.now();

    const close = () => {
      done = true;
      clearInterval(keepalive);
      clearInterval(poll);
      reply.raw.end();
    };

    const poll = setInterval(async () => {
      if (done) return;
      try {
        const rows = await fetchNew(lastSeq);
        for (const row of rows) {
          const dataObj = row.data && typeof row.data === "object" ? (row.data as Record<string, unknown>) : {};
          const payload = {
            seq: row.seq,
            type: row.eventType,
            message: row.message ?? (dataObj.message as string | undefined) ?? (dataObj.summary as string | undefined),
            createdAt: row.createdAt.toISOString(),
            ...dataObj,
          };
          reply.raw.write(`id: ${row.seq}\ndata: ${JSON.stringify(payload)}\n\n`);
          lastSeq = Math.max(lastSeq, row.seq);
        }
        if (lastSeq >= until || Date.now() - startedAt > 60_000) close();
      } catch {
        close();
      }
    }, POLL_MS);

    const keepalive = setInterval(() => {
      if (done) return;
      reply.raw.write(": keepalive\n\n");
    }, KEEPALIVE_MS);

    req.raw.on("close", close);
    return reply; // hijacked raw stream
  });
}
