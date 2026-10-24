// Asset service (T4.3) — upload từ workdir, checksum local, verify R2 trước khi ghi Asset.
// PRINCIPLES:
//  - chỉ upload file NẰM TRONG workdir đã cấp (path validate bắt buộc);
//  - upload xong phải verify (head: size + etag-md5 nếu khả dụng) MỚI được ghi Asset;
//  - retry idempotent: cùng (chapter, kind) + cùng sha → trả lại asset cũ, không trùng "logical asset";
//  - đổi nội dung rồi retry → giữ nguyên asset id (kế pointer), chỉ update metadata.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ConflictError, NotFoundError, RepositoryError, ValidationError } from "./db";
import { getDb } from "./db";
import { createChapterAsset } from "./job-repository";
import {
  chapterObjectKey,
  ensureKeyBelongsToJob,
  packageObjectKey,
  UnsafeKeyError,
  type ChapterKeyKind,
} from "./object-keys";
import type { ObjectStoreAdapter } from "./r2-adapter";
import {
  StorageBudgetExceededError,
  allowsUploadDelta,
  maybeWarnBudget,
  readBudget,
} from "./storage-budget";

export class UploadVerifyError extends RepositoryError {}

const CHAPTER_KINDS = ["source_html", "normalized_text", "rewritten_text", "chapter_audio"] as const;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".m4b": "audio/mp4",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
};

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

const PHASE_OF: Record<string, ChapterKeyKind> = {
  source_html: "source_html",
  normalized_text: "normalized_text",
  rewritten_text: "rewritten_text",
  chapter_audio: "chapter_audio",
};

/** Đường local nằm THẬT SỰ trong workdir (chặn ../, backslash, absolute, empty) — trả absolute path. */
export function resolveInsideWorkdir(workdir: string, relativePath: string): string | null {
  if (typeof relativePath !== "string" || !relativePath.trim()) return null;
  if (relativePath.includes("\\") || relativePath.includes("\x00") || path.isAbsolute(relativePath)) {
    return null;
  }
  const segments = relativePath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const workRoot = path.resolve(workdir);
  const localPath = path.resolve(workRoot, relativePath);
  if (localPath === workRoot || localPath.startsWith(workRoot + path.sep)) return localPath;
  return null;
}

/** Đọc + checksum local; trả null nếu file không tồn tại trong workdir. */
async function readFromWorkdir(
  workdir: string,
  relativePath: string,
): Promise<{ buf: Buffer; sha256: string; localPath: string } | null> {
  const localPath = resolveInsideWorkdir(workdir, relativePath);
  if (!localPath) return null;
  try {
    const buf = await fs.readFile(localPath);
    return { buf, sha256: createHash("sha256").update(buf).digest("hex"), localPath };
  } catch {
    return null;
  }
}

export async function recordChapterArtifact(opts: {
  jobId: string;
  chapterIndex: number;
  kind: (typeof CHAPTER_KINDS)[number];
  workdir: string;
  relativePath: string;
  store: ObjectStoreAdapter;
  part?: number;
  /** T4.5: xóa file local SAU khi remote verified; unlink lỗi không làm rớti upload. */
  cleanupLocalAfterVerify?: boolean;
}): Promise<{ assetId: string; objectKey: string; sha256: string; size: number }> {
  if (!(CHAPTER_KINDS as readonly string[]).includes(opts.kind)) {
    throw new ValidationError(`kind lạ: ${String(opts.kind)}`);
  }
  const content = await readFromWorkdir(opts.workdir, opts.relativePath);
  if (!content) {
    throw new ValidationError(
      `relativePath không hợp lệ/không đọc được từ workdir: ${String(opts.relativePath)}`,
    );
  }
  const { buf, sha256 } = content;
  const size = buf.length;

  // Idempotent fast path: existing asset cùng kind trên chapter + cùng sha + verified
  const db = getDb();
  const chapter = await db.chapter.findUnique({
    where: { jobId_index: { jobId: opts.jobId, index: opts.chapterIndex } },
    select: { id: true },
  });
  if (!chapter) {
    // pre-check trước khi upload — tránh orphan remote khi chapter sai
    throw new NotFoundError(`chapter ${opts.chapterIndex} không thuộc job này`);
  }
  // Existing duy nhất cho (chapter,kind) — dùng cho fast path + budget delta + conflict path
  const existing = await db.asset.findUnique({
    where: { chapterId_kind: { chapterId: chapter.id, kind: opts.kind as never } },
    select: { id: true, sha256: true, verified: true, size: true },
  });

  if (existing && existing.verified && existing.sha256 === sha256) {
    // fast path: nội dung đã verified từ lần trước — khỏi upload lại
    await maybeCleanupLocal(opts);
    return { assetId: existing.id, objectKey: keyForInput(opts), sha256, size };
  }

  // T4.5: kiểm ngân sách TRƯỚC upload (delta có thể âm khi thay nội dung)
  const decide = await allowsUploadDelta(size - (existing?.size ?? 0));
  if (!decide.ok) {
    throw new StorageBudgetExceededError(
      `vượt budget: cần thêm ${decide.overBytes}B trên tổng ${decide.budgetBytes}B (đang dùng ${decide.usedBytes}B)`,
    );
  }

  let objectKey: string;
  try {
    objectKey = chapterObjectKey({
      jobId: opts.jobId,
      chapterNo: opts.chapterIndex,
      kind: PHASE_OF[opts.kind],
      part: opts.part ?? extractAudioPart(opts),
    });
  } catch (e) {
    throw new ValidationError(`object key không hợp lệ: ${(e as Error).message}`);
  }
  ensureKeyBelongsToJob(objectKey, opts.jobId);

  const contentType = contentTypeFor(opts.relativePath);

  // UPLOAD chỉ sau khi mọi validate pass — store là điểm duy nhất tiếp xúc remote
  try {
    await opts.store.putObject({ key: objectKey, body: buf, contentType });
  } catch (e) {
    throw new UploadVerifyError(`upload thất bại (asset KHÔNG được ghi): ${(e as Error).message}`);
  }

  // VERIFY trước khi record — failed upload không được coi là hoàn thành
  const md5Hex = createHash("md5").update(buf).digest("hex");
  let verified:
    | { ok: true }
    | { ok: false; reason: string } = { ok: true };
  try {
    const head = await opts.store.headObject(objectKey);
    if (!head) verified = { ok: false, reason: "head trả null" };
    else if (head.size !== size) verified = { ok: false, reason: `size lệch (${head.size}≠${size})` };
    else if (head.etag) {
      const etag = head.etag.replace(/"/g, "").toLowerCase();
      // ETag single-part = md5 nội dung; multipart (≥8MB) của R2 là composite
      // dạng "…-N" — không so được md5 toàn file: adapter đã verify md5 từng phần
      const composite = etag.includes("-");
      if (!composite && etag !== md5Hex) {
        verified = { ok: false, reason: "etag ≠ md5 nội dung" };
      }
    }
  } catch (e) {
    verified = { ok: false, reason: `head lỗi: ${(e as Error).message}` };
  }
  if (!verified.ok) {
    // best-effort xóa orphan; xóa lỗi không cản trở lỗi verify chính
    try {
      await opts.store.deleteObject(objectKey);
    } catch {
      // ignore — orphan nhỏ, budget task (T4.5) sẽ báo cáo
    }
    throw new UploadVerifyError(`verify thất bại: ${verified.reason} (asset không được ghi)`);
  }

  // RECORD — idempotent với conflict path (re-upload thay nội dung giữ nguyên asset id)
  try {
    const r = await createChapterAsset({
      jobId: opts.jobId,
      chapterIndex: opts.chapterIndex,
      kind: opts.kind,
      objectKey,
      contentType,
      size,
      sha256,
    });
    await maybeCleanupLocal(opts);
    maybeWarnBudget(decide.usedPercent, readBudget().warnPercent);
    return { assetId: r.assetId, objectKey, sha256, size };
  } catch (e) {
    if (e instanceof ConflictError && existing) {
      // giữ nguyên id (pointer ổn định), update metadata + sha mới
      await db.$transaction([
        db.asset.update({
          where: { id: existing.id },
          data: { objectKey, contentType, size, sha256, verified: true },
        }),
        ...(pointerFor(opts.kind)
          ? [
              db.chapter.update({
                where: { id: chapter.id },
                data: { [pointerFor(opts.kind) as string]: existing.id },
              }),
            ]
          : []),
      ]);
      await maybeCleanupLocal(opts);
      return { assetId: existing.id, objectKey, sha256, size };
    }
    throw e;
  }
}

// chapter_audio: part lấy từ tên file part-NNN.mp3 nếu caller không truyền
function extractAudioPart(opts: { kind: string; relativePath: string }): number | undefined {
  if (opts.kind !== "chapter_audio") return undefined;
  const m = /part-(\d+)\.mp3$/.exec(opts.relativePath);
  return m ? Number(m[1]) : 0;
}

function pointerFor(kind: string): "textAssetId" | "audioAssetId" | null {
  return kind === "chapter_audio" ? "audioAssetId" : kind === "source_html" ? null : "textAssetId";
}

// key theo quy tắc namespace — dùng bởi fast path (object đã tồn tại thật sự)
function keyForInput(opts: {
  jobId: string;
  chapterIndex: number;
  kind: string;
  part?: number;
  relativePath: string;
}): string {
  return chapterObjectKey({
    jobId: opts.jobId,
    chapterNo: opts.chapterIndex,
    kind: PHASE_OF[opts.kind],
    part: opts.part ?? extractAudioPart(opts),
  });
}

/** T4.5: xóa file local sau verify; unlink lỗi → log warn, KHÔNG bao giờ đụng remote để "dọn". */
async function maybeCleanupLocal(opts: {
  workdir: string;
  relativePath: string;
  cleanupLocalAfterVerify?: boolean;
}): Promise<void> {
  if (!opts.cleanupLocalAfterVerify) return;
  const localPath = resolveInsideWorkdir(opts.workdir, opts.relativePath);
  if (!localPath) return;
  try {
    await fs.unlink(localPath);
  } catch (e) {
    console.warn(
      JSON.stringify({ warn: "local_cleanup_failed", message: String(e).slice(0, 120) }),
    );
  }
}

// re-export để caller chỉ nhìn thấy loại hình dựng sẵn (không kéo UnsafeKeyError từ object-keys)
export { UnsafeKeyError };

// ---------------------------------------------------------------------------
// T7.3 — package assets (m4b/mp4/thumbnail/description): mirror recordChapterArtifact
// nhưng gắn BookPackage (packageId), key qua packageObjectKey, không pointer cột.
const PACKAGE_KINDS = ["m4b", "mp4", "thumbnail", "description"] as const;

// AssetKind → PackageKind của object-keys (key file mô tả khác tên kind)
const PACKAGE_KEY_OF: Record<(typeof PACKAGE_KINDS)[number], string> = {
  m4b: "m4b",
  mp4: "mp4",
  thumbnail: "thumbnail",
  description: "package_description",
};

export async function recordPackageArtifact(opts: {
  jobId: string;
  packageSequence: number;
  kind: (typeof PACKAGE_KINDS)[number];
  workdir: string;
  relativePath: string;
  store: ObjectStoreAdapter;
  /** T4.5-style: m4b/mp4 sau verify không phục vụ gì cục bộ nữa — mặc định xóa. */
  cleanupLocalAfterVerify?: boolean;
}): Promise<{ assetId: string; objectKey: string; sha256: string; size: number }> {
  if (!(PACKAGE_KINDS as readonly string[]).includes(opts.kind)) {
    throw new ValidationError(`kind lạ: ${String(opts.kind)}`);
  }
  const content = await readFromWorkdir(opts.workdir, opts.relativePath);
  if (!content) {
    throw new ValidationError(
      `relativePath không hợp lệ/không đọc được từ workdir: ${String(opts.relativePath)}`,
    );
  }
  const { buf, sha256 } = content;
  const size = buf.length;

  const db = getDb();
  const pkg = await db.bookPackage.findUnique({
    where: { jobId_sequence: { jobId: opts.jobId, sequence: opts.packageSequence } },
    select: { id: true },
  });
  if (!pkg) {
    throw new NotFoundError(`package ${opts.packageSequence} không thuộc job này`);
  }
  // "asset hiện thời" cho (package, kind) = row sớm nhất — nội dung đổi giữ nguyên id
  const existing = await db.asset.findFirst({
    where: { jobId: opts.jobId, packageId: pkg.id, kind: opts.kind as never },
    orderBy: { createdAt: "asc" },
    select: { id: true, sha256: true, verified: true, size: true },
  });

  if (existing && existing.verified && existing.sha256 === sha256) {
    await maybeCleanupLocal(opts);
    return { assetId: existing.id, objectKey: keyForPackageInput(opts), sha256, size };
  }

  const decide = await allowsUploadDelta(size - (existing?.size ?? 0));
  if (!decide.ok) {
    throw new StorageBudgetExceededError(
      `vượt budget: cần thêm ${decide.overBytes}B trên tổng ${decide.budgetBytes}B (đang dùng ${decide.usedBytes}B)`,
    );
  }

  let objectKey: string;
  try {
    objectKey = packageObjectKey({
      jobId: opts.jobId,
      packageSequence: opts.packageSequence,
      kind: PACKAGE_KEY_OF[opts.kind] as never,
    });
  } catch (e) {
    throw new ValidationError(`object key không hợp lệ: ${(e as Error).message}`);
  }
  ensureKeyBelongsToJob(objectKey, opts.jobId);

  const contentType = contentTypeFor(opts.relativePath);

  try {
    await opts.store.putObject({ key: objectKey, body: buf, contentType });
  } catch (e) {
    throw new UploadVerifyError(`upload thất bại (asset KHÔNG được ghi): ${(e as Error).message}`);
  }

  const md5Hex = createHash("md5").update(buf).digest("hex");
  let verified: { ok: true } | { ok: false; reason: string } = { ok: true };
  try {
    const head = await opts.store.headObject(objectKey);
    if (!head) verified = { ok: false, reason: "head trả null" };
    else if (head.size !== size) verified = { ok: false, reason: `size lệch (${head.size}≠${size})` };
    else if (head.etag) {
      const etag = head.etag.replace(/"/g, "").toLowerCase();
      // composite multipart "…-N" — adapter đã verify md5 từng phần khi upload
      if (!etag.includes("-") && etag !== md5Hex) {
        verified = { ok: false, reason: "etag ≠ md5 nội dung" };
      }
    }
  } catch (e) {
    verified = { ok: false, reason: `head lỗi: ${(e as Error).message}` };
  }
  if (!verified.ok) {
    try {
      await opts.store.deleteObject(objectKey);
    } catch {
      // ignore — orphan nhỏ, budget task (T4.5) sẽ báo cáo
    }
    throw new UploadVerifyError(`verify thất bại: ${verified.reason} (asset không được ghi)`);
  }

  let assetId: string;
  if (!existing) {
    const created = await db.asset.create({
      data: {
        jobId: opts.jobId,
        packageId: pkg.id,
        kind: opts.kind as never,
        objectKey,
        contentType,
        size,
        sha256,
        verified: true,
      },
      select: { id: true },
    });
    assetId = created.id;
  } else {
    await db.asset.update({
      where: { id: existing.id },
      data: { objectKey, contentType, size, sha256, verified: true },
    });
    assetId = existing.id;
  }
  await maybeCleanupLocal(opts);
  maybeWarnBudget(decide.usedPercent, readBudget().warnPercent);
  return { assetId, objectKey, sha256, size };
}

function keyForPackageInput(opts: {
  jobId: string;
  packageSequence: number;
  kind: (typeof PACKAGE_KINDS)[number];
}): string {
  return packageObjectKey({
    jobId: opts.jobId,
    packageSequence: opts.packageSequence,
    kind: PACKAGE_KEY_OF[opts.kind] as never,
  });
}
