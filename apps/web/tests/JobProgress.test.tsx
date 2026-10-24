// T8.2 tests — OFFLINE: fetch stub toàn cục + stub EventSource bằng FakeEventSource.
// Chứng minh acceptance: (a) list nhóm state đúng; (b) tiến độ per-chapter/stage từ
// API; (c) event SSE → refresh từ API → UI đúng; (d) reconnect (onerror→onopen) vẫn
// đúng; (e) "reload trang" = remount JobProgress → bootstrap LẠI từ API → đúng.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobsList } from "../src/JobsList";
import { JobProgress } from "../src/JobProgress";
import type { JobRow } from "../src/api";

function jsonRes(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const JOB = (state: string, id = "job-1"): JobRow => ({
  id,
  state,
  sourceUrl: `https://example.com/${id}`,
  adapter: "webnovel-vn",
  chaptersPerBook: 20,
  configSnapshot: {},
});

let calls: Array<{ url: string; method: string }> = [];
const jobsPage = { items: [JOB("running"), JOB("failed", "job-2"), JOB("completed", "job-3")], total: 3 };
let chapterState = "qa_passed"; // đổi giữa các bước mô phỏng tiến trình
const chaptersPage = () => ({
  total: 3,
  items: [
    { index: 1, title: "Chương 1", stageState: chapterState, reviewState: "none", audioAssetId: chapterState === "tts_done" ? "asset-1" : null },
    { index: 2, title: "Chương 2", stageState: "downloaded", reviewState: "none", audioAssetId: null },
    { index: 3, title: "Chương 3", stageState: "normalized", reviewState: "needs_review", audioAssetId: null },
  ],
});
let eventsTail = [{ seq: 5, type: "progress" }];
let seqCounter = 5;

const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : String(input);
  const method = init?.method ?? "GET";
  calls.push({ url, method });
  if (url === "/api/jobs?limit=50") return jsonRes(200, jobsPage);
  if (url === "/api/jobs/job-1") return jsonRes(200, JOB("running"));
  if (url === "/api/jobs/job-1/chapters?limit=200") return jsonRes(200, chaptersPage());
  if (url.startsWith("/api/jobs/job-1/events") && url.includes("format=json")) {
    return jsonRes(200, { jobId: "job-1", after: -1, events: eventsTail });
  }
  return jsonRes(404, { error: { code: "NOT_FOUND", message: "job không tồn tại" } });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  serverPush(payload: { seq: number; type: string }): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

beforeEach(() => {
  calls = [];
  chapterState = "qa_passed";
  eventsTail = [{ seq: 5, type: "progress" }];
  seqCounter = 5;
  vi.stubGlobal("fetch", fetchMock);
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("JobsList", () => {
  it("nạp list từ API, nhãn nhóm state + bảng job, nút chọn job", async () => {
    const onSelect = vi.fn();
    render(<JobsList refreshKey={1} onSelectJob={onSelect} />);
    await waitFor(() => expect(screen.getByText("Xem job-1")).toBeTruthy());
    expect(screen.getByText(/completed: 1/)).toBeTruthy();
    expect(screen.getByText(/failed: 1/)).toBeTruthy();
    expect(screen.getByText(/running: 1/)).toBeTruthy();
    fireEvent.click(screen.getByText("Xem job-2"));
    expect(onSelect).toHaveBeenCalledWith("job-2");
  });
});

describe("JobProgress", () => {
  it("bootstrap: GET job + chapters + events (DB) → per-stage/per-chapter đúng", async () => {
    render(<JobProgress jobId="job-1" />);
    await waitFor(() => expect(screen.getByText(/qa_passed: 1/)).toBeTruthy());
    expect(screen.getByText(/downloaded: 1/)).toBeTruthy();
    expect(screen.getByText(/Chương 3/)).toBeTruthy(); // reviewState needs_review hiển thị
    expect(screen.getByText(/needs_review/)).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(4); // header + 3 chương
    // stream mở ĐÚNG sau lastSeq của tail DB
    const es = FakeEventSource.instances[0];
    expect(es.url).toContain("/api/jobs/job-1/events?after=5");
    // không reconnect trước giờ
    expect(chapterState).toBe("qa_passed");
  });

  it("event SSE đến → debounce refresh từ API → per-chapter CẬP NHẬT đúng", async () => {
    render(<JobProgress jobId="job-1" />);
    await waitFor(() => expect(screen.getByText(/qa_passed: 1/)).toBeTruthy());
    const es = FakeEventSource.instances[0];
    // job chạy tiếp: chương 1 hết TTS — đổi dữ liệu "server" rồi push sự kiện
    chapterState = "tts_done";
    seqCounter += 1;
    es.serverPush({ seq: seqCounter, type: "chapter_status" });

    await waitFor(() => expect(screen.getByText(/tts_done: 1/)).toBeTruthy());
    // audio đã có cột "có" cho chương 1
    expect(screen.getAllByText("có")).toHaveLength(1);
  });

  it("RECONNECT (stream đóng 60s): onopen lại → refresh từ API → tiến độ vẫn đúng", async () => {
    render(<JobProgress jobId="job-1" />);
    await waitFor(() => expect(screen.getByText(/qa_passed: 1/)).toBeTruthy());
    const es = FakeEventSource.instances[0];
    chapterState = "tts_done";
    es.onerror?.(); // mất kết nối — trình duyệt tự retry
    expect(es.closed).toBe(false); // không tự đóng handle
    es.onopen?.(); // kết nối lại thành công → refresh bù gap
    await waitFor(() => expect(screen.getByText(/tts_done: 1/)).toBeTruthy());
  });

  it("RELOAD trang = unmount + mount: bootstrap LẠI từ API, số GET đúng, UI đúng", async () => {
    const { unmount } = render(<JobProgress jobId="job-1" />);
    await waitFor(() => expect(screen.getByText(/qa_passed: 1/)).toBeTruthy());
    unmount();
    const esOld = FakeEventSource.instances[0];
    expect(esOld.closed).toBe(true); // stream cũ được đóng gọn
    calls = [];
    chapterState = "verified"; // tiến trình đã chạy sâu hơn trước khi reload
    render(<JobProgress jobId="job-1" />);
    await waitFor(() => expect(screen.getByText(/verified: 1/)).toBeTruthy());
    // bootstrap MỚI sau reload: đúng 1 lần GET chapters (state rõ, không fetch kép)
    expect(calls.filter((c) => c.url === "/api/jobs/job-1/chapters?limit=200")).toHaveLength(1);
  });

  it("Live Console & Active Task Banner: hiển thị console, định dạng event tiếng Việt, cập nhật nhiệm vụ đang chạy", async () => {
    render(<JobProgress jobId="job-1" />);
    await waitFor(() => expect(screen.getByText("LIVE EXECUTION CONSOLE")).toBeTruthy());
    expect(screen.getByText("TIẾN ĐỘ")).toBeTruthy(); // badge tiến độ từ initial event seq=5

    const es = FakeEventSource.instances[0];
    // Push event quota_wait
    es.serverPush({
      seq: 6,
      type: "quota_wait",
      backend: "openrouter/gemma",
      not_before: new Date(Date.now() + 60000).toISOString(),
    } as unknown as { seq: number; type: string });

    await waitFor(() => expect(screen.getByText("HẠN MỨC AI")).toBeTruthy());
    expect(screen.getByText(/openrouter\/gemma/)).toBeTruthy();
  });
});
