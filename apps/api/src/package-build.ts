// T7.3 — Node glue cho đóng gói: CHUẨN BỊ build (tải audio chương VERIFIED từ R2
// vào workdir + ghi manifest.json) và HOÀN TẤT (upload/verify/record m4b → ready).
// Worker chỉ chạy ffmpeg CỤC BỘ trong workdir; R2/DB thuộc Node (pattern T6.2).
// Contract của manifest (Node ghi, worker đọc): packages/{seq:04d}/manifest.json
//   { sequence, chapters: [{ no, title, audio: "packages/0001/parts/audio-0001.mp3" }] }
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  ConflictError,
  NotFoundError,
  RepositoryError,
  ValidationError,
  getDb,
} from "./db";
import { downloadChapterAudioTo, fetchVerifiedAssetBytes } from "./asset-download";
import { recordPackageArtifact, resolveInsideWorkdir } from "./asset-service";
import { readPackagingSettings } from "./pkg-settings";
import type { ObjectStoreAdapter } from "./r2-adapter";

export interface ManifestChapter {
  no: number;
  title: string;
  /** relative-to-workdir POSIX — đúng protocol artifact (T3.5). */
  audio: string;
}

export interface PreparedPackage {
  sequence: number;
  manifestRelPath: string;
  bookRelPath: string;
  chapters: ManifestChapter[];
}

export interface PackageBuildOpts {
  store: ObjectStoreAdapter;
}

const seq4 = (n: number): string => String(n).padStart(4, "0");
const bookRelPathOf = (sequence: number): string => `packages/${seq4(sequence)}/book.m4b`;
const partsDirOf = (workdir: string, sequence: number): string =>
  path.join(workdir, "packages", seq4(sequence), "parts");

/** Chuẩn bị build gói: claim state (pending/failed → building), tải CHỈ audio của
 * gói này (verified, gap/thiếu → NotFound NEVER silent) + ghi manifest atomic. */
export async function preparePackageBuild(
  jobId: string,
  packageSequence: number,
  workdir: string,
  opts: PackageBuildOpts,
): Promise<PreparedPackage> {
  if (!workdir.trim()) throw new ValidationError("workdir rỗng");
  const db = getDb();
  const pkg = await db.bookPackage.findUnique({
    where: { jobId_sequence: { jobId, sequence: packageSequence } },
    select: { id: true, state: true, groupingSnapshot: true },
  });
  if (!pkg) throw new NotFoundError(`package ${packageSequence} không thuộc job này`);
  const snap = pkg.groupingSnapshot as { chapterIndices?: unknown };
  const indices = Array.isArray(snap.chapterIndices) ? (snap.chapterIndices as number[]) : null;
  if (!indices || !indices.length) {
    throw new RepositoryError(
      `package ${packageSequence} thiếu groupingSnapshot.chapterIndices — chạy planJobPackages (T7.2) trước`,
    );
  }

  // claim optimistic: pending/failed → building; building/ready → ConflictError
  const claimed = await db.bookPackage.updateMany({
    where: { id: pkg.id, state: { in: ["pending", "failed"] } },
    data: { state: "building" },
  });
  if (claimed.count === 0) {
    const cur = await db.bookPackage.findUnique({
      where: { id: pkg.id },
      select: { state: true },
    });
    throw new ConflictError(
      `package đang ở state ${cur?.state ?? "?"} — không claim được để xây (ready → dùng lại, T7.4 lo tái dùng)`,
    );
  }

  // chương hiện tại trong DB — thiếu/khớp phải RÕ RÀNG, không nuốt im lặng
  const rows = await db.chapter.findMany({
    where: { jobId },
    select: { index: true, title: true },
  });
  const byIndex = new Map(rows.map((r) => [r.index, r.title]));
  const missing = indices.filter((n) => !byIndex.has(n));
  if (missing.length) {
    await db.bookPackage.update({ where: { id: pkg.id }, data: { state: "failed" } });
    throw new NotFoundError(
      `chapters thiếu so với gói ${packageSequence}: ${missing.join(", ")}`,
    );
  }

  const partsDir = partsDirOf(workdir, packageSequence);
  const chapters: ManifestChapter[] = [];
  try {
    for (const no of indices) {
      // audio CHƯA verified → NotFoundError (không đóng gói audio không rõ nguồn)
      const r = await downloadChapterAudioTo(jobId, no, partsDir, opts);
      chapters.push({
        no,
        title: byIndex.get(no) ?? `Chương ${no}`,
        audio: path.relative(workdir, r.localPath).split(path.sep).join("/"),
      });
    }
  } catch (e) {
    await db.bookPackage.update({ where: { id: pkg.id }, data: { state: "failed" } });
    throw e;
  }

  const pkgLocalDir = path.join(workdir, "packages", seq4(packageSequence));
  const manifestLocal = path.join(pkgLocalDir, "manifest.json");
  const tmp = `${manifestLocal}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify({ sequence: packageSequence, chapters }, null, 2) + "\n",
    "utf-8",
  );
  await fs.rename(tmp, manifestLocal); // atomic: đứt máy không có manifest dở

  return {
    sequence: packageSequence,
    manifestRelPath: `packages/${seq4(packageSequence)}/manifest.json`,
    bookRelPath: bookRelPathOf(packageSequence),
    chapters,
  };
}

/** Worker báo artifact xong: file cục bộ book.m4b → upload → verify → record → ready.
 * Thiếu/0 byte/upload hỏng → state failed, KHÔNG BAO GIỜ ready; audio nguồn trên R2 giữ nguyên. */
export async function finishPackageBuild(
  jobId: string,
  packageSequence: number,
  workdir: string,
  opts: PackageBuildOpts & { cleanupLocal?: boolean },
): Promise<{ assetId: string; objectKey: string; sha256: string; size: number }> {
  const db = getDb();
  const pkg = await db.bookPackage.findUnique({
    where: { jobId_sequence: { jobId, sequence: packageSequence } },
    select: { id: true, state: true },
  });
  if (!pkg) throw new NotFoundError(`package ${packageSequence} không thuộc job này`);
  if (pkg.state !== "building") {
    throw new ConflictError(
      `package đang ở state ${pkg.state} — chỉ package đang building được hoàn tất`,
    );
  }

  const relativePath = bookRelPathOf(packageSequence);
  const localPath = resolveInsideWorkdir(workdir, relativePath);
  if (!localPath) {
    await db.bookPackage.update({ where: { id: pkg.id }, data: { state: "failed" } });
    throw new ValidationError(`path m4b sai (trốn workdir): ${relativePath}`);
  }
  const stat = await fs.stat(localPath).catch(() => null);
  if (!stat || stat.size <= 0) {
    await db.bookPackage.update({ where: { id: pkg.id }, data: { state: "failed" } });
    throw new ValidationError(
      `book.m4b 0 byte/không tồn tại (${relativePath}) — worker không xuất được, không đánh dấu hoàn thành`,
    );
  }

  try {
    const r = await recordPackageArtifact({
      jobId,
      packageSequence,
      kind: "m4b",
      workdir,
      relativePath,
      store: opts.store,
      cleanupLocalAfterVerify: opts.cleanupLocal ?? true,
    });
    await db.bookPackage.update({ where: { id: pkg.id }, data: { state: "ready" } });
    return r;
  } catch (e) {
    await db.bookPackage
      .update({ where: { id: pkg.id }, data: { state: "failed" } })
      .catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// T7.5 — Export YouTube: MP4 16:9 từ audio + cover + description timestamp.
// Worker chạy ffmpeg CỤC BỘ trong workdir (stage "yt_export"); Node tải book.m4b VERIFIED
// + cover người dùng vào workdir, rồi upload PRIVATE mp4 + description lên R2.
// KHÔNG có bước upload YouTube tự động ở bất kỳ đâu.
const COVER_EXTS = [".jpg", ".jpeg", ".png"];
const ytRelPathsOf = (sequence: number) => {
  const base = `packages/${seq4(sequence)}`;
  return {
    book: `${base}/book.m4b`,
    cover: `${base}/cover.jpg`,
    mp4: `${base}/book.mp4`,
    description: `${base}/description.txt`,
  };
};

export interface RecordedArtifact {
  assetId: string;
  objectKey: string;
  sha256: string;
  size: number;
}

export interface PreparedYtExport {
  sequence: number;
  /** Tiêu đề sách/description — override qua export setting bookTitle (T7.1). */
  title: string;
  relPaths: { book: string; cover: string; mp4: string; description: string };
}

/** Chuẩn bị yt export: tải book.m4b VERIFIED (asset kind m4b — bắt buộc đã build theo
 * T7.3) + copy cover người dùng vào workdir gói. Không đụng state (m4b ready đứng yên). */
export async function prepareYtExport(
  jobId: string,
  packageSequence: number,
  workdir: string,
  opts: PackageBuildOpts & { coverAbsPath: string; title?: string },
): Promise<PreparedYtExport> {
  if (!workdir.trim()) throw new ValidationError("workdir rỗng");
  const db = getDb();
  const pkg = await db.bookPackage.findUnique({
    where: { jobId_sequence: { jobId, sequence: packageSequence } },
    select: { id: true },
  });
  if (!pkg) throw new NotFoundError(`package ${packageSequence} không thuộc job này`);

  const m4bAsset = await db.asset.findFirst({
    where: { jobId, packageId: pkg.id, kind: "m4b", verified: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!m4bAsset) {
    throw new NotFoundError(
      `package ${packageSequence} chưa có book.m4b verified — build M4B (T7.3) trước`,
    );
  }
  // chỉ phục vụ bytes ĐÃ verify (đối chiếu sha) — bản m4b hỏng không được export
  const verified = await fetchVerifiedAssetBytes(m4bAsset.id, jobId, opts);

  const coverSource = opts.coverAbsPath;
  const sourceExt = path.extname(coverSource).toLowerCase();
  if (!COVER_EXTS.includes(sourceExt)) {
    throw new ValidationError(
      `cover phải là .jpg/.jpeg/.png nhận được '${sourceExt || "(không đuôi)"}'`,
    );
  }
  const coverStat = await fs.stat(coverSource).catch(() => null);
  if (!coverStat || coverStat.size <= 0) {
    throw new NotFoundError(`cover không tồn tại/0 byte: ${coverSource}`);
  }

  let title = opts.title;
  if (title === undefined) {
    const settings = await readPackagingSettings(jobId); // cài đặt đóng gói theo job (T7.1)
    const fromExport = settings.export.bookTitle;
    if (typeof fromExport === "string" && fromExport.trim()) title = fromExport;
  }

  const rel = ytRelPathsOf(packageSequence);
  const pkgDir = path.join(workdir, "packages", seq4(packageSequence));
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(path.join(workdir, ...rel.book.split("/")), verified.data);
  await fs.copyFile(coverSource, path.join(workdir, ...rel.cover.split("/")));

  return {
    sequence: packageSequence,
    title: title ?? `Gói ${packageSequence}`,
    relPaths: rel,
  };
}

/** Sau khi worker báo mp4 + description: upload PRIVATE cả hai lên R2 (verify từng
 * file); KHÔNG đụng package state — book.m4b vẫn ready, lỗi mp4/description chỉ
 * throw để orchestrator thử lại (record idempotent theo sha fast path). */
export async function finishYtExport(
  jobId: string,
  packageSequence: number,
  workdir: string,
  opts: PackageBuildOpts & { cleanupLocal?: boolean },
): Promise<{ mp4: RecordedArtifact; description: RecordedArtifact }> {
  const rel = ytRelPathsOf(packageSequence);
  const localFor = (relative: string): string => {
    const local = resolveInsideWorkdir(workdir, relative);
    if (!local) throw new ValidationError(`path sai (trốn workdir): ${relative}`);
    return local;
  };

  // file 0 byte/không có → ValidationError, KHÔNG record (khác null trạng thái ready)
  for (const relative of [rel.mp4, rel.description]) {
    const stat = await fs.stat(localFor(relative)).catch(() => null);
    if (!stat || stat.size <= 0) {
      throw new ValidationError(
        `${relative} 0 byte/không tồn tại — worker không xuất được, không upload rác`,
      );
    }
  }

  const common = {
    jobId,
    packageSequence,
    workdir,
    store: opts.store,
    cleanupLocalAfterVerify: opts.cleanupLocal ?? true,
  };
  const mp4 = await recordPackageArtifact({ ...common, kind: "mp4", relativePath: rel.mp4 });
  const description = await recordPackageArtifact({
    ...common,
    kind: "description",
    relativePath: rel.description,
  });
  return { mp4, description };
}
