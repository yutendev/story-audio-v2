// Asset download service (T4.4) — đọc bytes cho packager + presigned URL ngắn hạn cho UI.
// LUÔN job-scoped: asset phải thuộc jobId, key phải nằm trong namespace của job;
// vi phạm → NotFoundError (không tiết lộ sự tồn tại của asset cho job khác).
import { NotFoundError, RepositoryError, getDb } from "./db";
import { ensureKeyBelongsToJob, UnsafeKeyError } from "./object-keys";
import { resolveR2 } from "./r2-resolver";
import type { ObjectStoreAdapter } from "./r2-adapter";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export class AssetCorruptError extends RepositoryError {}

export const PRESIGN_MIN_SECONDS = 30;
export const PRESIGN_MAX_SECONDS = 604800; // 7 ngày = max SigV4/R2
export const PRESIGN_DEFAULT_SECONDS = 300;

export function clampPresignTtl(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return PRESIGN_DEFAULT_SECONDS;
  if (raw < PRESIGN_MIN_SECONDS) return PRESIGN_MIN_SECONDS;
  if (raw > PRESIGN_MAX_SECONDS) return PRESIGN_MAX_SECONDS;
  return Math.floor(raw);
}

/** Load asset row thuộc đúng job; trả null-được-mappinghandled ở caller. */
async function loadScopedAsset(assetId: string, jobId: string) {
  const db = getDb();
  const asset = await db.asset.findFirst({ where: { id: assetId, jobId } });
  if (!asset) throw new NotFoundError("asset không tồn tại hoặc không thuộc job này");
  try {
    ensureKeyBelongsToJob(asset.objectKey, jobId);
  } catch (e) {
    if (e instanceof UnsafeKeyError) {
      // key lẫn job khác trong DB — không tiết lộ; coi như không tồn tại
      throw new NotFoundError("asset không tồn tại hoặc không thuộc job này");
    }
    throw e;
  }
  return asset;
}

/** Bytes cho packager (T7): đọc object đã verify từ R2. */
export async function fetchAssetBytes(
  assetId: string,
  jobId: string,
): Promise<{ data: Buffer; contentType?: string; objectKey: string }> {
  const asset = await loadScopedAsset(assetId, jobId);
  const { store } = resolveR2();
  const got = await store.getObject(asset.objectKey);
  if (!got) throw new NotFoundError(`object không tìm thấy trên storage: ${asset.objectKey}`);
  return { data: got.data, contentType: got.contentType ?? asset.contentType, objectKey: asset.objectKey };
}

/** Presigned GET ngắn hạn — không credentials, hết hạn theo expiresIn (clamped). */
export async function presignAssetDownload(
  jobId: string,
  assetId: string,
  expiresIn?: number,
): Promise<{ url: string; objectKey: string; expiresIn: number }> {
  const asset = await loadScopedAsset(assetId, jobId);
  const ttl = clampPresignTtl(expiresIn);
  const { presigner } = resolveR2();
  const url = await presigner.presign(asset.objectKey, ttl);
  return { url, objectKey: asset.objectKey, expiresIn: ttl };
}

export interface DownloadBytesOpts {
  /** Inject cho test/offline; mặc định qua resolveR2() (override được trong test). */
  store?: ObjectStoreAdapter;
}

export interface VerifiedBytes {
  data: Buffer;
  contentType?: string;
  objectKey: string;
  sha256: string;
}

/** T6.3 — tải về CHỈ asset đã verify + đối chiếu sha256: nội dung lệch checksum
 * = hỏng (AssetCorruptError) — không bao giờ phục vụ rác cho tái gói. */
export async function fetchVerifiedAssetBytes(
  assetId: string,
  jobId: string,
  opts: DownloadBytesOpts = {},
): Promise<VerifiedBytes> {
  const asset = await loadScopedAsset(assetId, jobId);
  if (!asset.verified) {
    throw new NotFoundError(`asset chưa verified — không được tái dùng (${asset.objectKey})`);
  }
  const got = await (opts.store ?? (await resolveR2()).store).getObject(asset.objectKey);
  if (!got) throw new NotFoundError(`object không tìm thấy trên storage: ${asset.objectKey}`);
  const sha256 = createHash("sha256").update(got.data).digest("hex");
  if (asset.sha256 && sha256 !== asset.sha256) {
    throw new AssetCorruptError(
      `nội dung tải về lệch checksum: ${sha256} ≠ ${asset.sha256} (${asset.objectKey})`,
    );
  }
  return {
    data: got.data,
    contentType: got.contentType ?? asset.contentType,
    objectKey: asset.objectKey,
    sha256,
  };
}

/** T6.3 — audio chương đã verify → file cục bộ cho tái gói (T7);
 * chapter thiếu audio verified → NotFoundError (gọi lại TTS, không im lặng). */
export async function downloadChapterAudioTo(
  jobId: string,
  chapterIndex: number,
  destDir: string,
  opts: DownloadBytesOpts = {},
): Promise<{ localPath: string; size: number; sha256: string; objectKey: string }> {
  const db = getDb();
  const ch = await db.chapter.findUnique({
    where: { jobId_index: { jobId, index: chapterIndex } },
    select: { audioAssetId: true },
  });
  if (!ch?.audioAssetId) {
    throw new NotFoundError(`chapter ${chapterIndex} chưa có audio asset đã upload`);
  }
  const { data, objectKey, sha256 } = await fetchVerifiedAssetBytes(ch.audioAssetId, jobId, opts);
  await fs.mkdir(destDir, { recursive: true });
  const localPath = path.join(destDir, `audio-${String(chapterIndex).padStart(4, "0")}.mp3`);
  await fs.writeFile(localPath, data);
  return { localPath, size: data.length, sha256, objectKey };
}
