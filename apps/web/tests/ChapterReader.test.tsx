import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChapterReader } from "../src/ChapterReader";
import type { ChapterRow } from "../src/api";

const mockChapter: ChapterRow = {
  index: 1,
  title: "Chương 1: Khởi Đầu Mới",
  stageState: "rewritten",
  reviewState: "needs_review",
  audioAssetId: null,
};

describe("ChapterReader component", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders rewritten text and bolds/highlights review fallback chunks", async () => {
    const mockContent = {
      jobId: "test-job-123",
      chapterIndex: 1,
      title: "Chương 1: Khởi Đầu Mới",
      stageState: "rewritten",
      reviewState: "needs_review",
      hasRewritten: true,
      text: "Khương Vô Ưu bước vào bóng đêm sâu thẳm.\n\nĐây là đoạn bị fallback cần duyệt vì lệch ngoặc.",
      chunks: [
        {
          index: 0,
          tier: "tier1",
          severity: "ok",
          char_start: 0,
          char_end: 40,
          remaining_errors: [],
        },
        {
          index: 1,
          tier: "fallback",
          severity: "semantic",
          char_start: 42,
          char_end: 93,
          remaining_errors: ["ngoặc thoại lệch"],
        },
      ],
      chapterStatus: "ok",
      severityCounts: { ok: 1, semantic: 1 },
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockContent,
    });

    render(
      <ChapterReader
        jobId="test-job-123"
        chapters={[mockChapter]}
        selectedIndex={0}
        onSelectIndex={() => {}}
      />
    );

    // Kiểm tra render text chuẩn
    await waitFor(() => {
      expect(screen.getByText(/Khương Vô Ưu bước vào bóng đêm/i)).toBeTruthy();
    });

    // Kiểm tra đoạn cần duyệt có badge cảnh báo và hiển thị nổi bật
    expect(screen.getByText(/ĐOẠN CẦN DUYỆT/i)).toBeTruthy();
    expect(screen.getByText(/ngoặc thoại lệch/i)).toBeTruthy();
    expect(screen.getByText(/Đây là đoạn bị fallback cần duyệt vì lệch ngoặc./i)).toBeTruthy();
  });
});
