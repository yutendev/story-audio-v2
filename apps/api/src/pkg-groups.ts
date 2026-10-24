// T7.2 — chia chương vào các gói sách THEO CẤU HÌNH (chaptersPerBook, T7.1).
// PRINCIPLE: deterministic (sort + dedupe), gap cắt ranh giới gói và được BÁO ra
// (`missing`) — NEVER silently skip missing chapters. Policy gói cuối: gói dư
// (partial) vẫn tạo với số chương ít hơn — không nuốt, không lấp số giả.
import { ConflictError, NotFoundError, ValidationError, getDb } from "./db";
import { readPackagingSettings } from "./pkg-settings";

export interface PackagePlanItem {
  /** 1-based, đánh số chặt (không có lỗ) → khớp unique (jobId, sequence). */
  sequence: number;
  startChapter: number;
  endChapter: number;
  chapterIndices: number[];
}

export interface PackagePlan {
  chaptersPerBook: number;
  packages: PackagePlanItem[];
  /** Số chương "lủng" BÊN TRONG dải được bao quanh bởi chương khác. */
  missing: number[];
}

/** Thuần (offline/kiểm được độc lập): [1,2,5] perBook 4 → 2 gói [1-2], [5-5] + missing [3,4]. */
export function groupChapters(indices: number[], chaptersPerBook: number): PackagePlan {
  if (!Number.isInteger(chaptersPerBook) || chaptersPerBook < 1) {
    throw new ValidationError(`chaptersPerBook phải nguyên ≥ 1: ${String(chaptersPerBook)}`);
  }
  for (const n of indices) {
    if (!Number.isInteger(n) || n < 1) {
      throw new ValidationError(`chapter index phải nguyên ≥ 1: ${String(n)}`);
    }
  }
  const sorted = Array.from(new Set(indices)).sort((a, b) => a - b);

  const missing: number[] = [];
  const packages: PackagePlanItem[] = [];
  let run: number[] = [];

  const flushRun = (): void => {
    for (let i = 0; i < run.length; i += chaptersPerBook) {
      const slice = run.slice(i, i + chaptersPerBook);
      packages.push({
        sequence: packages.length + 1,
        startChapter: slice[0],
        endChapter: slice[slice.length - 1],
        chapterIndices: slice,
      });
    }
    run = [];
  };

  for (const n of sorted) {
    if (run.length && n !== run[run.length - 1] + 1) {
      for (let g = run[run.length - 1] + 1; g < n; g++) missing.push(g);
      flushRun(); // gap chặn ranh giới: gói không bao giờ ôm lún qua số chương thiếu
    }
    run.push(n);
  }
  flushRun();

  return { chaptersPerBook, packages, missing };
}

/** Lên (lại) kế hoạch gói cho job theo settings hiện tại; idempotent:
 * gói không đổi → giữ nguyên cả state; gói mà nội dung đổi → về `pending`
 * (đây chính là "chỉ vô hiệu gói bị ảnh hưởng"); gói thừa pending/failed bị xóa,
 * gói thừa building/ready → ConflictError (không âm thầm xóa kết quả đã xây). */
export async function planJobPackages(jobId: string): Promise<PackagePlan> {
  if (!jobId.trim()) throw new ValidationError("jobId rỗng");
  const db = getDb();
  const settings = await readPackagingSettings(jobId);
  const rows = await db.chapter.findMany({
    where: { jobId },
    orderBy: { index: "asc" },
    select: { index: true },
  });
  const plan = groupChapters(
    rows.map((r) => r.index),
    settings.chaptersPerBook,
  );

  await db.$transaction(async (tx) => {
    for (const p of plan.packages) {
      const groupingSnapshot = {
        chaptersPerBook: plan.chaptersPerBook,
        chapterIndices: p.chapterIndices,
      };
      const existing = await tx.bookPackage.findUnique({
        where: { jobId_sequence: { jobId, sequence: p.sequence } },
      });
      if (!existing) {
        await tx.bookPackage.create({
          data: {
            jobId,
            sequence: p.sequence,
            startChapter: p.startChapter,
            endChapter: p.endChapter,
            chapterCount: p.chapterIndices.length,
            groupingSnapshot,
            state: "pending",
          },
        });
      } else if (
        existing.startChapter !== p.startChapter ||
        existing.endChapter !== p.endChapter ||
        existing.chapterCount !== p.chapterIndices.length
      ) {
        await tx.bookPackage.update({
          where: { id: existing.id },
          data: {
            startChapter: p.startChapter,
            endChapter: p.endChapter,
            chapterCount: p.chapterIndices.length,
            groupingSnapshot,
            state: "pending", // nội dung đổi → phải xây lại (affected only)
          },
        });
      }
    }

    const stale = await tx.bookPackage.findMany({
      where: { jobId, sequence: { gt: plan.packages.length } },
      select: { id: true, state: true, sequence: true },
    });
    const deletable = stale.filter((s) => s.state === "pending" || s.state === "failed");
    const keep = stale.filter((s) => s.state === "building" || s.state === "ready");
    if (keep.length) {
      throw new ConflictError(
        `grouping mới bỏ gói cũ nhưng gói vẫn sống: sequence ${keep
          .map((k) => k.sequence)
          .join(", ")} (building/ready) — cần policy rõ trước khi xóa`,
      );
    }
    if (deletable.length) {
      await tx.bookPackage.deleteMany({ where: { jobId, sequence: { gt: plan.packages.length } } });
    }
  });

  return plan;
}

/** Đọc kế hoạch đã lưu (BookPackage rows) của job — cho builder T7.3/UI. */
export async function getJobPackages(jobId: string) {
  if (!jobId.trim()) throw new ValidationError("jobId rỗng");
  const job = await getDb().job.findUnique({ where: { id: jobId }, select: { id: true } });
  if (!job) throw new NotFoundError("job không tồn tại");
  return getDb().bookPackage.findMany({
    where: { jobId },
    orderBy: { sequence: "asc" },
  });
}
