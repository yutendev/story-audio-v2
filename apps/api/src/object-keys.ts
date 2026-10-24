// Object key namespace (T4.2) — chuẩn hoá key R2; chặn key bất an toàn & хоч lẫn job.
// Pattern: jobs/{jobId}/... — mọi key phải nằm trong namespace của job hiện tại.

type ChapterKind = "source_html" | "normalized_text" | "rewritten_text" | "chapter_audio";

export type ChapterKeyKind = ChapterKind;

const CHAPTER_FILES: Record<ChapterKind, string> = {
  source_html: "source.html",
  normalized_text: "normalized.txt",
  rewritten_text: "rewritten.txt",
  chapter_audio: "audio/part-{part}.mp3",
};

type PackageKind = "m4b" | "mp4" | "thumbnail" | "package_description";

const PACKAGE_FILES: Record<PackageKind, string> = {
  m4b: "book.m4b",
  mp4: "book.mp4",
  thumbnail: "thumbnail.jpg",
  package_description: "description.txt",
};

export class UnsafeKeyError extends Error {}

function assertSafeSegment(segment: string, name: string): void {
  if (/[\\/]|\.\.|^$/.test(segment) || segment.includes("\x00")) {
    throw new UnsafeKeyError(`${name} chứa ký tự cấm: ${JSON.stringify(segment)}`);
  }
}

export function assertChapterNo(chapterNo: number): void {
  if (!Number.isInteger(chapterNo) || chapterNo < 1 || chapterNo > 1_000_000) {
    throw new UnsafeKeyError(`chapterNo ngoài [1..1000000]: ${chapterNo}`);
  }
}

export function chapterObjectKey(input: {
  jobId: string;
  chapterNo: number;
  kind: ChapterKind;
  part?: number;
}): string {
  if (!input.jobId.trim()) throw new UnsafeKeyError("jobId rỗng");
  assertSafeSegment(input.jobId, "jobId");
  assertChapterNo(input.chapterNo);
  let file = CHAPTER_FILES[input.kind];
  if (!file) throw new UnsafeKeyError(`kind lạ: ${String(input.kind)}`);
  if (file.includes("{part}")) {
    const part = input.part ?? 0;
    if (!Number.isInteger(part) || part < 0 || part > 999999) {
      throw new UnsafeKeyError(`part ngoài [0..999999]: ${part}`);
    }
    file = file.replace("{part}", String(part).padStart(3, "0"));
  }
  return `jobs/${input.jobId}/chapters/${String(input.chapterNo).padStart(4, "0")}/${file}`;
}

export function packageObjectKey(input: {
  jobId: string;
  packageSequence: number;
  kind: PackageKind;
}): string {
  if (!input.jobId.trim()) throw new UnsafeKeyError("jobId rỗng");
  assertSafeSegment(input.jobId, "jobId");
  if (!Number.isInteger(input.packageSequence) || input.packageSequence < 1) {
    throw new UnsafeKeyError(`packageSequence phải ≥ 1: ${input.packageSequence}`);
  }
  const file = PACKAGE_FILES[input.kind];
  if (!file) throw new UnsafeKeyError(`kind lạ: ${String(input.kind)}`);
  return `jobs/${input.jobId}/packages/${String(input.packageSequence).padStart(4, "0")}/${file}`;
}

/** Chốt cửa: key nhận từ bất kỳ nguồn nào phải nằm BÊN TRONG namespace của job hiện tại. */
export function ensureKeyBelongsToJob(objectKey: string, jobId: string): string {
  const prefix = `jobs/${jobId}/`;
  if (typeof objectKey !== "string" || !objectKey.startsWith(prefix)) {
    throw new UnsafeKeyError(`key không thuộc job này: ${objectKey.slice(0, 40)}`);
  }
  const rest = objectKey.slice(prefix.length);
  if (rest.includes("..") || rest.includes("\\") || rest.includes("\x00")) {
    throw new UnsafeKeyError(`key có dấu hiệu traverse: ${objectKey.slice(0, 40)}`);
  }
  if (objectKey.length > 1024) throw new UnsafeKeyError("key quá dài (>1024)");
  return objectKey;
}
