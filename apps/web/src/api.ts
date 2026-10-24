// API client same-origin ("/api/...") — KHÔNG chứa secret: trình duyệt không
// bao giờ thấy key R2/env (mọi secret ở Node API; web chỉ gọi qua proxy dev).
// Lỗi 4xx → message từ error.error.message của API; còn lại → message chung an toàn.
export interface ApiErrorPayload {
  error: { code: string; message: string };
}

export interface ExportOptions {
  bookTitle?: string;
  ttsVoice?: string;
  rewriteAi?: boolean;
  isAdultContent?: boolean;
  aiProvider?: string;
  aiModel?: string;
  openrouterApiKey?: string;
  devkitApiKey?: string;
  devkitBaseUrl?: string;
}

export interface CreateJobInput {
  sourceUrl: string;
  adapter: string;
  chaptersPerBook: number;
  export?: ExportOptions;
}

export interface JobRow {
  id: string;
  state: string;
  sourceUrl: string;
  adapter?: string;
  chaptersPerBook: number;
  notBefore?: string | null;
  lastError?: string | null;
  configSnapshot?: unknown;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorPayload;
    if (body?.error?.message) return body.error.message;
  } catch {
    // body rỗng / không phải JSON → message chung
  }
  return res.status === 400 ? "Dữ liệu gửi lên không hợp lệ" : `Lỗi HTTP ${res.status}`;
}

export async function createJob(input: CreateJobInput): Promise<string> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { id: string };
  if (!body?.id) throw new Error("API không trả về id job");
  return body.id;
}

export async function fetchJob(jobId: string): Promise<JobRow> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as JobRow;
}

export async function updateJobSettings(
  jobId: string,
  payload: { chaptersPerBook?: number; export?: ExportOptions },
): Promise<void> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

// ---------------------------------------------------------------- T8.2 — list + progress

export interface JobListResult {
  items: JobRow[];
  total: number;
}

export async function fetchJobs(limit = 50): Promise<JobListResult> {
  const res = await fetch(`/api/jobs?limit=${limit}`);
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as JobListResult;
}

export interface ChapterRow {
  index: number;
  title: string;
  stageState: string;
  reviewState: string;
  audioAssetId: string | null;
}

export interface ChaptersPage {
  total: number;
  items: ChapterRow[];
}

export async function fetchChapters(jobId: string, limit = 200): Promise<ChaptersPage> {
  const res = await fetch(
    `/api/jobs/${encodeURIComponent(jobId)}/chapters?limit=${Math.min(limit, 200)}`,
  );
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as ChaptersPage;
}

export interface JobEvent {
  seq: number;
  type: string;
  message?: string;
  summary?: string;
  stage?: string;
  done?: number;
  total?: number;
  chapter_no?: number;
  chapter_index?: number;
  part_index?: number;
  total_parts?: number;
  state?: string;
  kind?: string;
  path?: string;
  backend?: string;
  not_before?: string;
  createdAt?: string;
  [k: string]: unknown;
}

/** Poll fallback `format=json&after=<seq>` — dữ liệu event DỀU trong DB job_events. */
export async function fetchEventsAfter(
  jobId: string,
  after: number,
): Promise<{ jobId: string; events: JobEvent[] }> {
  const res = await fetch(
    `/api/jobs/${encodeURIComponent(jobId)}/events?format=json&after=${after}`,
  );
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { jobId: string; events: JobEvent[] };
}

export interface AssetRow {
  id: string;
  kind: string;
  contentType: string;
  size: number;
  verified: boolean;
  chapterId: string | null;
  packageId: string | null;
  createdAt: string;
}

export async function fetchJobAssets(jobId: string): Promise<AssetRow[]> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/assets`);
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { jobId: string; items: AssetRow[] };
  return body.items;
}

export interface PresignedLink {
  url: string;
  objectKey: string;
  expiresIn: number;
}

export async function fetchDownloadLink(
  jobId: string,
  assetId: string,
): Promise<PresignedLink> {
  const res = await fetch(
    `/api/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}/download-url`,
  );
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as PresignedLink;
}

/** T8.3 — điều khiển lifecycle: cancel/retry/resume (state machine chặn, 409 nguyên văn). */
export type JobAction = "cancel" | "retry" | "resume";

export async function postJobAction(jobId: string, action: JobAction): Promise<void> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/${action}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function deleteJob(jobId: string): Promise<void> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await parseError(res));
}
