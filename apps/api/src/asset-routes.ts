// Download/presign routes (T4.4) — UI lấy URL ngắn hạn, packager lấy bytes qua service.
// Route 503 R2_UNAVAILABLE khi env R2 chưa cấu hình (không crash thân app).
// T8.4: GET :jobId/assets — danh sách asset CỦA JOB (job-scoped, không lộ objectKey).
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { FastifyInstance } from "fastify";

import { R2UnavailableError } from "./r2-resolver";
import { fetchAssetBytes, presignAssetDownload } from "./asset-download";
import { getDb, NotFoundError } from "./db";

export function registerAssetRoutes(app: FastifyInstance): void {
  app.get("/api/jobs/:jobId/assets", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const db = getDb();
    const job = await db.job.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!job) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "job không tồn tại" } });
    }
    const items = await db.asset.findMany({
      where: { jobId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        kind: true,
        contentType: true,
        size: true,
        verified: true,
        chapterId: true,
        packageId: true,
        createdAt: true,
      },
    });
    return { jobId, items };
  });

  app.get("/api/jobs/:jobId/assets/:assetId/download-url", async (req, reply) => {
    const { jobId, assetId } = req.params as { jobId: string; assetId: string };
    const q = (req.query ?? {}) as { expires_in?: string };
    const rawTtl = q.expires_in ? Number(q.expires_in) : undefined;
    try {
      const r = await presignAssetDownload(
        jobId,
        assetId,
        typeof rawTtl === "number" && Number.isFinite(rawTtl) ? rawTtl : undefined,
      );
      return r;
    } catch (e) {
      if (e instanceof R2UnavailableError) {
        return reply
          .status(503)
          .send({ error: { code: "R2_UNAVAILABLE", message: e.message } });
      }
      throw e;
    }
  });

  app.get("/api/jobs/:jobId/assets/:assetId/download", async (req, reply) => {
    const { jobId, assetId } = req.params as { jobId: string; assetId: string };
    const query = (req.query ?? {}) as { download?: string };
    const forceDownload = query.download === "1";
    try {
      const db = getDb();
      const asset = await db.asset.findUnique({
        where: { id: assetId },
        include: { chapter: true, pkg: true },
      });
      if (!asset || asset.jobId !== jobId) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "asset không tồn tại" } });
      }

      let filename = path.basename(asset.objectKey);
      if (asset.kind === "m4b") {
        filename = "sach-noi-xich-tam-tuan-thien.m4b";
      } else if (asset.kind === "chapter_audio" && asset.chapter) {
        filename = `chuong-${asset.chapter.index}.mp3`;
      } else if (asset.kind === "rewritten_text" && asset.chapter) {
        filename = `chuong-${asset.chapter.index}.txt`;
      }

      // Ưu tiên đọc file trực tiếp từ workRoot nếu có sẵn
      const workRoot = process.env.STORY_AUDIO_WORK_ROOT?.trim();
      let localPath: string | null = null;
      if (workRoot) {
        const direct = path.join(workRoot, asset.objectKey);
        if (existsSync(direct)) {
          localPath = direct;
        } else {
          const stripped = path.join(workRoot, "jobs", asset.objectKey.replace(/^jobs[\\/]/, ""));
          if (existsSync(stripped)) localPath = stripped;
        }
        // Fallback: tìm file audio theo index trong thư mục packages
        if (!localPath && asset.kind === "chapter_audio" && asset.chapter) {
          const partsPath = path.join(
            workRoot, "jobs", jobId, "packages", "0001", "parts",
            `audio-${String(asset.chapter.index).padStart(4, "0")}.mp3`,
          );
          if (existsSync(partsPath)) localPath = partsPath;
        }
        // Fallback: tìm book.m4b
        if (!localPath && asset.kind === "m4b") {
          const m4bPath = path.join(workRoot, "jobs", jobId, "packages", "0001", "book.m4b");
          if (existsSync(m4bPath)) localPath = m4bPath;
        }
      }

      const contentType = asset.contentType ?? "application/octet-stream";
      const disposition = forceDownload
        ? `attachment; filename="${filename}"`
        : `inline; filename="${filename}"`;

      if (localPath) {
        const stat = statSync(localPath);
        const fileSize = stat.size;
        const rangeHeader = req.headers.range;

        reply.header("Accept-Ranges", "bytes");

        if (rangeHeader) {
          // HTTP 206 Partial Content — Chrome cần header này để phát audio/video
          const parts = rangeHeader.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          const chunkSize = end - start + 1;

          reply.status(206);
          reply.header("Content-Range", `bytes ${start}-${end}/${fileSize}`);
          reply.header("Content-Length", chunkSize);
          reply.header("Content-Type", contentType);
          reply.header("Content-Disposition", disposition);
          return reply.send(createReadStream(localPath, { start, end }));
        }

        // Full response (không có Range header)
        reply.header("Content-Type", contentType);
        reply.header("Content-Length", fileSize);
        reply.header("Content-Disposition", disposition);
        return reply.send(createReadStream(localPath));
      }

      // Fallback: đọc từ R2
      reply.header("Content-Type", contentType);
      reply.header("Content-Disposition", disposition);
      const { data } = await fetchAssetBytes(assetId, jobId);
      return reply.send(data);
    } catch (e) {
      if (e instanceof R2UnavailableError) {
        return reply
          .status(503)
          .send({ error: { code: "R2_UNAVAILABLE", message: e.message } });
      }
      throw e;
    }
  });
}
