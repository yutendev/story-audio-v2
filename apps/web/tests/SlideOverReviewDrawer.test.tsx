import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlideOverReviewDrawer } from "../src/SlideOverReviewDrawer";
import type { ChapterRow } from "../src/api";

const mockChapter: ChapterRow = {
  index: 1,
  title: "Chương 1: Khởi Đầu Mới",
  stageState: "rewritten",
  reviewState: "needs_review",
  audioAssetId: null,
};

describe("SlideOverReviewDrawer — QA Review & Editing", () => {
  beforeEach(() => {
    cleanup();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("render Slide-over Drawer với highlight đoạn lỗi và nút duyệt", async () => {
    const mockContent = {
      jobId: "job-1",
      chapterIndex: 1,
      title: "Chương 1: Khởi Đầu Mới",
      stageState: "rewritten",
      reviewState: "needs_review",
      hasRewritten: true,
      text: "Đoạn văn bình thường.\n\nĐoạn văn này bị lỗi ngoặc.",
      chunks: [
        {
          index: 0,
          tier: "tier1",
          severity: "ok",
          char_start: 0,
          char_end: 20,
          remaining_errors: [],
        },
        {
          index: 1,
          tier: "fallback",
          severity: "semantic",
          char_start: 22,
          char_end: 46,
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

    const onApprove = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <SlideOverReviewDrawer
        isOpen={true}
        onClose={onClose}
        jobId="job-1"
        chapterIndex={1}
        chapters={[mockChapter]}
        onSelectChapterIndex={() => {}}
        onApproveAndResume={onApprove}
      />
    );

    // Chờ nạp content
    await waitFor(() => {
      expect(screen.getByText("SOAT LỖI & DUYỆT QA")).toBeTruthy();
    });

    expect(screen.getAllByText(/ngoặc thoại lệch/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/SEMANTIC/i)).toBeTruthy();

    // Bấm nút duyệt
    const approveBtn = screen.getByText(/Duyệt xong — Cho phép tiếp tục TTS/i);
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(onApprove).toHaveBeenCalledTimes(1);
    });
  });
});
