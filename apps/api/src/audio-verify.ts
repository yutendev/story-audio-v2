// T6.2 — audio chương: chặn 0-byte/hỏng, probe ffprobe (nếu CÓ trên máy),
// upload + verify + record (T4.3) → CHỈ SAU KHI asset remote verified mới
// chuyển chapter stage → tts_done. Upload hỏng = KHÔNG bao giờ ghi thành tts_done,
// chạy lại (upload đứt giữa chừng) ăn fast path sha trùng của T4.3 — không tái synth.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import { getDb, NotFoundError, ValidationError } from "./db";
import { recordChapterArtifact, resolveInsideWorkdir } from "./asset-service";
import type { ObjectStoreAdapter } from "./r2-adapter";
import { assertChapterTransition } from "./state-machine";

export class AudioInvalidError extends ValidationError {}

export interface AudioProbe {
  durationSec: number;
  format: string;
}

/** Seam cho test/offline: ffprobe thật chỉ chạy qua defaultFfprobeRunner. */
export type ProbeRun =
  | { status: "ran"; code: number; stdout: string; stderr: string }
  | { status: "missing" } // ffprobe không cài — probe bị bỏ qua, upload vẫn đi tiếp
  | { status: "error"; message: string }; // spawn/timeout lỗi khác → audio coi như không kiểm được

export type FfprobeRunner = (localPath: string) => Promise<ProbeRun>;

export const defaultFfprobeRunner: FfprobeRunner = async (localPath) => {
  try {
    const { stdout } = await promisify(execFile)(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration,format_name", "-of", "json", localPath],
      { timeout: 30_000 },
    );
    return { status: "ran", code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    if (err.code === "ENOENT") return { status: "missing" };
    return {
      status: "ran",
      code: typeof err.code === "number" ? err.code : 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? ""),
    };
  }
};

/** ffprobe có trên máy → đòi đọc được duration > 0 (audio hỏng/lạ = từ chối);
 * ffprobe vắng → null (môi trường không có ffprobe — acceptance "where available"). */
export async function probeAudio(
  localPath: string,
  runner: FfprobeRunner = defaultFfprobeRunner,
): Promise<AudioProbe | null> {
  const r = await runner(localPath);
  if (r.status === "missing") return null;
  if (r.status === "error") {
    throw new AudioInvalidError(`ffprobe không chạy được: ${r.message}`);
  }
  if (r.code !== 0) {
    throw new AudioInvalidError(`audio bị hỏng (ffprobe rc=${r.code}): ${r.stderr.slice(0, 200)}`);
  }
  let parsed: { format?: { duration?: string; format_name?: string } };
  try {
    parsed = JSON.parse(r.stdout) as { format?: { duration?: string; format_name?: string } };
  } catch {
    throw new AudioInvalidError("ffprobe stdout không phải JSON (ffprobe lạ?)");
  }
  const durationSec = Number(parsed.format?.duration ?? NaN);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new AudioInvalidError("ffprobe không đọc được duration > 0 (audio hỏng?)");
  }
  return { durationSec, format: parsed.format?.format_name ?? "" };
}

export interface ChapterAudioOpts {
  jobId: string;
  chapterIndex: number;
  workdir: string;
  relativePath: string;
  store: ObjectStoreAdapter;
  /** Inject cho test; mặc định gọi ffprobe thật (thiếu trên máy → bỏ qua probe). */
  ffprobe?: FfprobeRunner;
  /** T6.3: sau khi remote verified — xóa file local, workdir không tích lũy
   * mỗi chương (các stage sau tái tải từ R2 qua downloadChapterAudioTo). */
  cleanupLocal?: boolean;
}

export interface StoredChapterAudio {
  assetId: string;
  objectKey: string;
  sha256: string;
  size: number;
  probe: AudioProbe | null;
}

/** Glue T6.2: file >0 byte → probe → upload+verify+record → chapter tts_done.
 * Probe/0-byte/corrupt đều chặn TRƯỚC upload — không ship rác lên R2. */
export async function storeChapterAudio(opts: ChapterAudioOpts): Promise<StoredChapterAudio> {
  const localPath = resolveInsideWorkdir(opts.workdir, opts.relativePath);
  if (!localPath) {
    throw new AudioInvalidError(
      `relativePath không hợp lệ/không đọc được từ workdir: ${String(opts.relativePath)}`,
    );
  }
  const stat = await fs.stat(localPath).catch(() => null);
  if (!stat || stat.size <= 0) {
    throw new AudioInvalidError(
      `audio 0 byte hoặc không truy cập được (${opts.relativePath}) — từ chối upload`,
    );
  }
  const probe = await probeAudio(localPath, opts.ffprobe ?? defaultFfprobeRunner);
  const r = await recordChapterArtifact({
    jobId: opts.jobId,
    chapterIndex: opts.chapterIndex,
    kind: "chapter_audio",
    workdir: opts.workdir,
    relativePath: opts.relativePath,
    store: opts.store,
    cleanupLocalAfterVerify: opts.cleanupLocal ?? true,
  });
  await markChapterAudioDone(opts.jobId, opts.chapterIndex);
  return { ...r, probe };
}

/** Chapter chỉ được tts_done SAU khi asset đã verified (record thành công trước đó);
 * sai stage hiện tại → InvalidTransition NGAY — không ghi đè im lặng. */
export async function markChapterAudioDone(jobId: string, chapterIndex: number): Promise<void> {
  const db = getDb();
  const chapter = await db.chapter.findUnique({
    where: { jobId_index: { jobId, index: chapterIndex } },
    select: { id: true, stageState: true },
  });
  if (!chapter) {
    throw new NotFoundError(`chapter ${chapterIndex} không thuộc job này`);
  }
  assertChapterTransition(chapter.stageState, "tts_done");
  await db.chapter.update({
    where: { id: chapter.id },
    data: { stageState: "tts_done" },
  });
}
