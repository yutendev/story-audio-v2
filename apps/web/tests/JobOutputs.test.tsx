// T8.4 tests — OFFLINE: list output (lọc 4 kind), xin link presigned (bucket private),
// hiển thị link + expiresIn, và lỗi 503/404 nguyên văn.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobOutputs, isOutputAsset } from "../src/JobOutputs";
import type { AssetRow } from "../src/api";

function jsonRes(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function asset(kind: string, size = 1024): AssetRow {
  return {
    id: `asset-${kind}`,
    kind,
    contentType: "application/octet-stream",
    size,
    verified: true,
    chapterId: kind === "chapter_audio" ? "ch-1" : null,
    packageId: kind === "chapter_audio" ? null : "pkg-1",
    createdAt: "2026-10-23T00:00:00Z",
  };
}

const ASSETS_PAGE = [
  asset("m4b", 3 * 1024 * 1024),
  asset("mp4", 5 * 1024 * 1024),
  asset("description", 700),
  asset("thumbnail", 40_000),
  asset("chapter_audio", 90_000), // phải bị LỌC khỏi UI
];

let calls: Array<{ url: string; method: string }> = [];
let listResponse = jsonRes(200, { jobId: "job-9", items: ASSETS_PAGE });
let urlResponse = jsonRes(200, {
  url: "https://r2.private/short-lived?X-Amz-Signature=abc",
  objectKey: "jobs/job-9/packages/0001/book.m4b",
  expiresIn: 300,
});

const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : String(input);
  calls.push({ url, method: init?.method ?? "GET" });
  if (url.endsWith("/assets")) return listResponse;
  if (url.endsWith("/download-url")) return urlResponse;
  return jsonRes(404, { error: { code: "NOT_FOUND", message: "job không tồn tại" } });
});

beforeEach(() => {
  calls = [];
  listResponse = jsonRes(200, { jobId: "job-9", items: ASSETS_PAGE });
  urlResponse = jsonRes(200, {
    url: "https://r2.private/short-lived?X-Amz-Signature=abc",
    objectKey: "jobs/job-9/packages/0001/book.m4b",
    expiresIn: 300,
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

it("isOutputAsset — chỉ 4 kind output (chapter_audio bị loại)", () => {
  expect(isOutputAsset(asset("m4b"))).toBe(true);
  expect(isOutputAsset(asset("mp4"))).toBe(true);
  expect(isOutputAsset(asset("description"))).toBe(true);
  expect(isOutputAsset(asset("thumbnail"))).toBe(true);
  expect(isOutputAsset(asset("chapter_audio"))).toBe(false);
  expect(isOutputAsset(asset("source_html"))).toBe(false);
});

describe("JobOutputs", () => {
  it("list: chỉ hiện 4 kind output, size đọc được; KHÔNG hiện chapter_audio", async () => {
    render(<JobOutputs jobId="job-9" />);
    await waitFor(() => expect(screen.getByText(/Sách nói \(M4B\)/)).toBeTruthy());
    expect(screen.getByText("Video YouTube (MP4 16:9)")).toBeTruthy();
    expect(screen.getByText(/3\.0 MB/)).toBeTruthy();
    expect(screen.queryByText("chapter_audio")).toBeNull();
  });

  it("xin link: GET download-url → anchor href presigned + ghi thời hạn 300s", async () => {
    render(<JobOutputs jobId="job-9" />);
    await waitFor(() => expect(screen.getByText(/Sách nói/)).toBeTruthy());
    fireEvent.click(screen.getAllByText("Lấy link tải (5 phút)")[0]);
    await waitFor(() => expect(screen.getByText(/Tải \(300s\)/)).toBeTruthy());
    const anchor = screen.getByText(/Tải \(300s\)/) as HTMLAnchorElement;
    expect(anchor.href).toContain("X-Amz-Signature=abc");
    expect(calls.some((c) => c.url.endsWith("/download-url"))).toBe(true);
  });

  it("503 R2_UNAVAILABLE → alert nguyên văn; 404 job lạ → alert", async () => {
    listResponse = jsonRes(503, {
      error: { code: "R2_UNAVAILABLE", message: "R2 chưa cấu hình trên server này" },
    });
    render(<JobOutputs jobId="job-9" />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("R2 chưa cấu hình"),
    );
    cleanup();

    listResponse = jsonRes(404, { error: { code: "NOT_FOUND", message: "job không tồn tại" } });
    render(<JobOutputs jobId="job-z" />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/không tồn tại/));
  });
});
