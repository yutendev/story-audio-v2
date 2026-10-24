// T8.3 tests — OFFLINE: nút HIỆN/ẨN theo state-machine; bấm → POST đúng endpoint;
// 409 → hiển thị message API nguyên văn; canceled/completed/state lạ → không nút.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobControls, quotaExplain } from "../src/JobControls";
import type { JobRow } from "../src/api";

function jsonRes(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function jobOf(state: string, extra: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-9",
    state,
    sourceUrl: "https://example.com/x",
    chaptersPerBook: 20,
    configSnapshot: {},
    ...extra,
  };
}

let calls: Array<{ url: string; method: string }> = [];
let failMode: Override | null = null;

interface Override {
  status: number;
  body: unknown;
}

const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : String(input);
  const method = init?.method ?? "GET";
  calls.push({ url, method });
  if (failMode) return jsonRes(failMode.status, failMode.body);
  return jsonRes(200, { jobId: "job-9" });
});

beforeEach(() => {
  calls = [];
  failMode = null;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("JobControls — NÚT THEO MÁY TRẠNG THÁI", () => {
  it("failed → Thử lại + Hủy; retry gọi POST /retry; refresh callback chạy", async () => {
    const onRefresh = vi.fn();
    render(<JobControls job={jobOf("failed")} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText("Thử lại (về hàng đợi)"));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(calls).toEqual([{ url: "/api/jobs/job-9/retry", method: "POST" }]);
    expect(screen.getByText("Hủy job")).toBeTruthy();
  });

  it("needs_review → Duyệt xong — tiếp tục (resume) + Hủy; waiting_quota → resume + giải thích quota", () => {
    const { rerender } = render(<JobControls job={jobOf("needs_review")} onRefresh={vi.fn()} />);
    expect(screen.getByText("Duyệt xong — tiếp tục")).toBeTruthy();
    expect(screen.queryByText("Thử lại (về hàng đợi)")).toBeNull();

    rerender(<JobControls job={jobOf("waiting_quota", { notBefore: "2026-10-24T10:00:00Z" })} onRefresh={vi.fn()} />);
    expect(screen.getByText("Cho chạy lại ngay (bỏ chờ quota)")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/sẽ tự chạy lại sau/);
    expect(quotaExplain(jobOf("waiting_quota"))).toMatch(/không chuyển sang model trả phí/);
  });

  it("queued/running chỉ có Hủy; canceled/completed → KHÔNG nút nào", () => {
    for (const state of ["canceled", "completed", "state-lạ"]) {
      const { unmount } = render(<JobControls job={jobOf(state)} onRefresh={vi.fn()} />);
      expect(screen.queryByRole("button")).toBeNull();
      unmount();
    }
    // thẻ section không render khi không có nút — assert nhanh bằng container trống
    for (const state of ["queued", "running"]) {
      const { unmount } = render(<JobControls job={jobOf(state)} onRefresh={vi.fn()} />);
      expect(screen.queryByText("Thử lại (về hàng đợi)")).toBeNull();
      expect(screen.queryByText("Duyệt xong — tiếp tục")).toBeNull();
      expect(screen.getByText("Hủy job")).toBeTruthy();
      unmount();
    }
  });

  it("bấm sai state vẫn cho POST (API là nguồn sự thật) → 409 + lời nguyên văn", async () => {
    failMode = {
      status: 409,
      body: {
        error: { code: "INVALID_TRANSITION", message: "API từ chối transition từ state này" },
      },
    };
    render(<JobControls job={jobOf("running")} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByText("Hủy job"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("API từ chối"));
    expect(calls).toEqual([{ url: "/api/jobs/job-9/cancel", method: "POST" }]);
  });
});
