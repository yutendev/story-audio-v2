// T7.1 — cài đặt đóng gói theo job: chaptersPerBook + export settings.
// PRINCIPLE: builder grouping KHÔNG hard-code số chương — mọi nơi đọc qua module này.
// Schema T2.2 đã có: Job.chaptersPerBook (default 20) + Job.configSnapshot (Json).
// PATCH là CẬP NHẬT CỤC BỘ: thiếu field = giữ nguyên hiện trạng (khác CREATE khử default).
import { NotFoundError, ValidationError, getDb } from "./db";

export const PACKAGING_DEFAULT_CHAPTERS = 20;
export const PACKAGING_MIN_CHAPTERS = 1;
export const PACKAGING_MAX_CHAPTERS = 1000; // trùng [1..1000] của CREATE_BODY + createJob

export interface PackagingSettings {
  chaptersPerBook: number;
  // flat map key→primitive: cài đặt xuất (title/cover/tùy chỉnh T7.5 định thêm)
  // — generic KHÔNG đoán trước shape của từng setting.
  export: Record<string, string | number | boolean>;
}

/** Chặn giá trị ngoài [MIN..MAX] — dùng chung CREATE (default 20) và PATCH (giữ nguyên). */
function assertChaptersRange(n: unknown): void {
  if (
    !Number.isInteger(n) ||
    (n as number) < PACKAGING_MIN_CHAPTERS ||
    (n as number) > PACKAGING_MAX_CHAPTERS
  ) {
    throw new ValidationError(
      `chaptersPerBook ngoài [${PACKAGING_MIN_CHAPTERS}..${PACKAGING_MAX_CHAPTERS}]: ${String(n)}`,
    );
  }
}

export function validateExportSettings(raw: unknown): PackagingSettings["export"] {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("export settings phải là object (key → string|number|boolean)");
  }
  const out: PackagingSettings["export"] = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)) {
      throw new ValidationError(`export key không hợp lệ: '${k}' (chữ/số/_, ≤32 ký tự)`);
    }
    if (typeof v === "string") {
      if (v.length > 512) throw new ValidationError(`export '${k}' quá dài (>512 ký tự)`);
      out[k] = v;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v;
    } else {
      throw new ValidationError(`export '${k}' phải là string|number|boolean`);
    }
  }
  return out;
}

/** CREATE: default 20 khi bỏ trống; chặn ngoài [1..1000]. Full-story = chọn giá trị lớn
 * (vd 1000) — chặn kích thước thuộc budget T4.5/T7.2, không thuộc settings. */
export function validatePackagingSettings(raw: {
  chaptersPerBook?: unknown;
  export?: unknown;
}): PackagingSettings {
  const chaptersPerBook = raw.chaptersPerBook ?? PACKAGING_DEFAULT_CHAPTERS;
  if (raw.chaptersPerBook !== undefined) {
    assertChaptersRange(chaptersPerBook);
  }
  return { chaptersPerBook, export: validateExportSettings(raw.export) };
}

/** PATCH cài đặt theo job: CẬP NHẬT CỤC BỘ (thiếu field = giữ nguyên) — merge vào
 * configSnapshot + cập nhật cột chaptersPerBook. Được phép ở mọi trạng thái
 * (T7.4 lo vô hiệu các gói bị ảnh hưởng khi đổi chaptersPerBook). */
export async function updatePackagingSettings(
  jobId: string,
  raw: unknown,
): Promise<PackagingSettings> {
  if (!jobId.trim()) throw new ValidationError("jobId rỗng");
  const input = (raw ?? {}) as { chaptersPerBook?: unknown; export?: unknown };
  if (input.chaptersPerBook !== undefined) {
    assertChaptersRange(input.chaptersPerBook);
  }
  const nextExport = input.export === undefined ? null : validateExportSettings(input.export);

  const db = getDb();
  return db.$transaction(async (tx) => {
    const job = await tx.job.findUnique({
      where: { id: jobId },
      select: { id: true, chaptersPerBook: true, configSnapshot: true },
    });
    if (!job) throw new NotFoundError("job không tồn tại");
    const snap = (job.configSnapshot ?? {}) as Record<string, unknown>;

    const chaptersPerBook =
      input.chaptersPerBook === undefined ? job.chaptersPerBook : (input.chaptersPerBook as number);
    const exportSettings =
      nextExport === null ? validateExportSettings(snap.export) : nextExport;

    await tx.job.update({
      where: { id: jobId },
      data: {
        chaptersPerBook,
        configSnapshot: { ...snap, chaptersPerBook, export: exportSettings },
      },
    });
    return { chaptersPerBook, export: exportSettings };
  });
}

/** Đọc cài đặt hiện tại của job: cột chaptersPerBook + export từ snapshot. */
export async function readPackagingSettings(jobId: string): Promise<PackagingSettings> {
  if (!jobId.trim()) throw new ValidationError("jobId rỗng");
  const job = await getDb().job.findUnique({
    where: { id: jobId },
    select: { chaptersPerBook: true, configSnapshot: true },
  });
  if (!job) throw new NotFoundError("job không tồn tại");
  const snap = (job.configSnapshot ?? {}) as { export?: unknown };
  return { chaptersPerBook: job.chaptersPerBook, export: validateExportSettings(snap.export) };
}
