// T4.2 tests — key builder chặn key bất an toàn + đúng pattern namespace.
import { describe, expect, it } from "vitest";

import {
  chapterObjectKey,
  ensureKeyBelongsToJob,
  packageObjectKey,
  UnsafeKeyError,
} from "../src/object-keys";

const jobId = "cmvj-abc123";

describe("chapterObjectKey — pattern chuẩn", () => {
  it("source/normalized/rewritten/audio đúng cấu trúc + zero-pad", () => {
    expect(
      chapterObjectKey({ jobId, chapterNo: 7, kind: "source_html" }),
    ).toBe(`jobs/${jobId}/chapters/0007/source.html`);
    expect(
      chapterObjectKey({ jobId, chapterNo: 123, kind: "rewritten_text" }),
    ).toBe(`jobs/${jobId}/chapters/0123/rewritten.txt`);
    expect(
      chapterObjectKey({ jobId, chapterNo: 42, kind: "chapter_audio", part: 3 }),
    ).toBe(`jobs/${jobId}/chapters/0042/audio/part-003.mp3`);
  });

  it("chặn: segment có /,\\,.., NUL; chapterNo; part", () => {
    expect(() => chapterObjectKey({ jobId: "x/../y", chapterNo: 1, kind: "source_html" })).toThrow(UnsafeKeyError);
    expect(() => chapterObjectKey({ jobId: "a\\b", chapterNo: 1, kind: "source_html" })).toThrow(UnsafeKeyError);
    expect(() => chapterObjectKey({ jobId, chapterNo: 0, kind: "source_html" })).toThrow(UnsafeKeyError);
    expect(() => chapterObjectKey({ jobId, chapterNo: 1, kind: "fifo" as never })).toThrow(UnsafeKeyError);
    expect(() => chapterObjectKey({ jobId, chapterNo: 1, kind: "chapter_audio", part: -1 })).toThrow(UnsafeKeyError);
  });
});

describe("packageObjectKey — pattern chuẩn", () => {
  it("m4b/thumbnail/description đúng cấu trúc", () => {
    expect(packageObjectKey({ jobId, packageSequence: 12, kind: "m4b" })).toBe(
      `jobs/${jobId}/packages/0012/book.m4b`,
    );
    expect(packageObjectKey({ jobId, packageSequence: 1, kind: "thumbnail" })).toBe(
      `jobs/${jobId}/packages/0001/thumbnail.jpg`,
    );
    expect(packageObjectKey({ jobId, packageSequence: 3, kind: "package_description" })).toBe(
      `jobs/${jobId}/packages/0003/description.txt`,
    );
  });
  it("sequence < 1 → chặn", () => {
    expect(() => packageObjectKey({ jobId, packageSequence: 0, kind: "m4b" })).toThrow(UnsafeKeyError);
  });
});

describe("ensureKeyBelongsToJob — chống cross-job path confusion", () => {
  it("key đúng job → pass; key của job khác → chặn", () => {
    const k = `jobs/${jobId}/chapters/0001/rewritten.txt`;
    expect(ensureKeyBelongsToJob(k, jobId)).toBe(k);
    expect(() => ensureKeyBelongsToJob("jobs/OTHER-job/chapters/0001/rewritten.txt", jobId)).toThrow(
      UnsafeKeyError,
    );
  });

  it("traverse trong phần còn lại → chặn; NUL/backslash → chặn", () => {
    expect(() => ensureKeyBelongsToJob(`jobs/${jobId}/../other/x.txt`, jobId)).toThrow(UnsafeKeyError);
    expect(() => ensureKeyBelongsToJob(`jobs/${jobId}/a\\b.txt`, jobId)).toThrow(UnsafeKeyError);
    expect(() => ensureKeyBelongsToJob(`jobs/${jobId}/a\x00b.txt`, jobId)).toThrow(UnsafeKeyError);
  });
});
