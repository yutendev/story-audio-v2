// T8.1 tests — OFFLINE: fetch stub toàn cục (tests KHÔNG đụng mạng). RTL + fireEvent:
// validate phía client, POST đúng shape, hiển thị LỖI TỪ API, và JobDetail phản ánh
// cấu hình ĐÃ PERSIST (PATCH ghi vào state giả của "server", GET lại trả về mới).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateJobForm } from "../src/CreateJobForm";
import { JobDetail } from "../src/JobSettings";
import type { JobRow } from "../src/api";

const JOB: JobRow = {
  id: "job-1",
  state: "created",
  sourceUrl: "https://example.com/truyen",
  adapter: "webnovel-vn",
  chaptersPerBook: 20,
  configSnapshot: {
    adapter: "webnovel-vn",
    chaptersPerBook: 20,
    export: {
      bookTitle: "Truyện Chạy Bộ",
      ttsVoice: "vi-VN-NamNeural",
      rewriteAi: true,
      isAdultContent: false,
    },
  },
};

interface Override {
  status: number;
  body: unknown;
}

let calls: Array<{ url: string; method: string; bodyJson: string }> = [];
let overrides: Record<string, Override> = {};
let persisted: JobRow;

function jsonRes(status: number, body: unknown): Response {
  // duck-typing đủ cho api.ts (ok/status/json) — không cần runtime Response
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : String(input);
  const method = init?.method ?? "GET";
  const bodyJson = String(init?.body ?? "");
  calls.push({ url, method, bodyJson });
  const hit = overrides[`${method} ${url}`];
  if (hit) return jsonRes(hit.status, hit.body);
  if (url === "/api/jobs" && method === "POST") return jsonRes(201, { id: "job-1" });
  if (url === "/api/jobs/job-1" && method === "GET") return jsonRes(200, persisted);
  if (url === "/api/jobs/job-1/settings" && method === "PATCH") {
    // "server" ghi qua: PATCH thật sự persist, GET sau đó trả về giá trị mới
    const body = JSON.parse(bodyJson || "{}") as {
      chaptersPerBook?: number;
      export?: Record<string, unknown>;
    };
    persisted = { ...persisted, ...body } as JobRow;
    const snapshot = { ...(persisted.configSnapshot as object) };
    if (body.export !== undefined) {
      snapshot.export = body.export;
      persisted.configSnapshot = snapshot;
    }
    return jsonRes(200, { jobId: "job-1" });
  }
  return jsonRes(404, { error: { code: "NOT_FOUND", message: "job không tồn tại" } });
});

beforeEach(() => {
  calls = [];
  overrides = {};
  persisted = JSON.parse(JSON.stringify(JOB)) as JobRow;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

async function fillValidCreate(): Promise<void> {
  fireEvent.change(screen.getByLabelText("URL nguồn truyện"), {
    target: { value: "https://example.com/truyen" },
  });
  fireEvent.change(screen.getByLabelText("Adapter"), {
    target: { value: "truyendich-space" },
  });
  fireEvent.click(screen.getByLabelText("30"));
  fireEvent.change(screen.getByLabelText("Tựa sách"), { target: { value: "Truyện Chạy Bộ" } });
  fireEvent.change(screen.getByLabelText("Giọng đọc TTS"), {
    target: { value: "vi-VN-NamNeural" },
  });
  fireEvent.click(screen.getByLabelText("Bật rewrite AI"));
}

describe("CreateJobForm", () => {
  it("chặn sourceUrl sai ngay trên client — KHÔNG gọi fetch, hiện lời rõ ràng", async () => {
    render(<CreateJobForm onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("URL nguồn truyện"), {
      target: { value: "khong-phai-url" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tạo job" }));

    expect(screen.getByRole("alert").textContent).toMatch(/http\(s\) URL/);
    expect(calls).toHaveLength(0);
  });

  it("chặn chaptersPerBook ngoài [1..1000] — KHÔNG gọi fetch", async () => {
    render(<CreateJobForm onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("URL nguồn truyện"), {
      target: { value: "https://example.com/truyen" },
    });
    fireEvent.click(screen.getByLabelText("Tuỳ chọn"));
    fireEvent.change(screen.getByLabelText("Chương mỗi sách (tuỳ chọn)"), {
      target: { value: "1001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tạo job" }));

    expect(screen.getByRole("alert").textContent).toMatch(/\[1\.\.1000\]/);
    expect(calls).toHaveLength(0);
  });

  it("POST /api/jobs đúng shape (trim URL, adapter, preset, export chỉ field đã chọn) → onCreated(id)", async () => {
    const onCreated = vi.fn();
    render(<CreateJobForm onCreated={onCreated} />);
    await fillValidCreate();
    fireEvent.click(screen.getByRole("button", { name: "Tạo job" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("job-1"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "/api/jobs", method: "POST" });
    expect(JSON.parse(calls[0].bodyJson)).toEqual({
      sourceUrl: "https://example.com/truyen",
      adapter: "truyendich-space",
      chaptersPerBook: 30,
      export: {
        bookTitle: "Truyện Chạy Bộ",
        ttsVoice: "vi-VN-NamNeural",
        rewriteAi: true,
      },
    });
    // không có lỗi
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lỗi API 400 → hiển thị CHÍNH XÁC message của API, không im lặng", async () => {
    overrides["POST /api/jobs"] = {
      status: 400,
      body: { error: { code: "VALIDATION", message: "adapter chưa được hỗ trợ" } },
    };
    const onCreated = vi.fn();
    render(<CreateJobForm onCreated={onCreated} />);
    await fillValidCreate();
    fireEvent.click(screen.getByRole("button", { name: "Tạo job" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("adapter chưa"));
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("chọn OpenRouter và model → POST /api/jobs gửi aiProvider và aiModel trong export", async () => {
    const onCreated = vi.fn();
    render(<CreateJobForm onCreated={onCreated} />);
    await fillValidCreate();
    // Click OpenRouter provider
    fireEvent.click(screen.getByText("🌐 OpenRouter"));
    // Click Qwen 2.5 72B
    fireEvent.click(screen.getByText("Qwen 2.5 72B"));
    fireEvent.click(screen.getByRole("button", { name: "Tạo job" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("job-1"));
    expect(calls).toHaveLength(1);
    const sentExport = JSON.parse(calls[0].bodyJson).export;
    expect(sentExport.aiProvider).toBe("openrouter");
    expect(sentExport.aiModel).toBe("qwen/qwen-2.5-72b-instruct");
  });

  it("chọn DevKit và model → POST /api/jobs gửi aiProvider và aiModel trong export", async () => {
    const onCreated = vi.fn();
    render(<CreateJobForm onCreated={onCreated} />);
    await fillValidCreate();
    // Click DevKit provider
    fireEvent.click(screen.getByText("🚀 DevKit (OpenAI)"));
    // Click DeepSeek R1 (550B)
    fireEvent.click(screen.getByText("DeepSeek R1 (550B)"));
    fireEvent.click(screen.getByRole("button", { name: "Tạo job" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("job-1"));
    expect(calls).toHaveLength(1);
    const sentExport = JSON.parse(calls[0].bodyJson).export;
    expect(sentExport.aiProvider).toBe("devkit");
    expect(sentExport.aiModel).toBe("deepseek-r1-550b");
  });
});

describe("JobDetail — phản ánh cấu hình ĐÃ PERSIST", () => {
  it("lần đầu GET → hiển thị giá trị đã lưu (perBook + export map)", async () => {
    render(<JobDetail jobId="job-1" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Chương mỗi sách (đã lưu)") as HTMLInputElement).value).toBe(
        "20",
      ),
    );
    expect(screen.getByText(/Trạng thái: created/)).toBeTruthy();
    const titleInput = screen.getByLabelText("Tựa sách") as HTMLInputElement;
    expect(titleInput.value).toBe("Truyện Chạy Bộ");
    expect((screen.getByLabelText("Giọng đọc TTS") as HTMLInputElement).value).toBe(
      "vi-VN-NamNeural",
    );
    expect((screen.getByLabelText("Bật rewrite AI") as HTMLInputElement).checked).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["/api/jobs/job-1"]);
  });

  it("sửa số chương → PATCH đúng shape → GET lại → UI HIỂN THỊ giá trị đã persist", async () => {
    render(<JobDetail jobId="job-1" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Chương mỗi sách (đã lưu)") as HTMLInputElement).value).toBe(
        "20",
      ),
    );
    fireEvent.change(screen.getByLabelText("Chương mỗi sách (đã lưu)"), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Đã lưu/));
    expect(
      calls.some((c) => c.url === "/api/jobs/job-1/settings" && c.method === "PATCH"),
    ).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(patch!.bodyJson).chaptersPerBook).toBe(50);
    // GET lại sau PATCH (persisted reflect): 1 lần GET KHÁC sau PATCH
    expect(calls.filter((c) => c.url === "/api/jobs/job-1" && c.method === "GET")).toHaveLength(2);
    expect(
      (await screen.findByLabelText("Chương mỗi sách (đã lưu)") as HTMLInputElement).value,
    ).toBe("50");
  });

  it("PATCH lỗi 400 → alert là message của API, KHÔNG có thông báo 'Đã lưu'", async () => {
    overrides["PATCH /api/jobs/job-1/settings"] = {
      status: 400,
      body: { error: { code: "VALIDATION", message: "chaptersPerBook phải nguyên" } },
    };
    render(<JobDetail jobId="job-1" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Chương mỗi sách (đã lưu)") as HTMLInputElement).value).toBe(
        "20",
      ),
    );
    fireEvent.change(screen.getByLabelText("Chương mỗi sách (đã lưu)"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("phải nguyên"));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
