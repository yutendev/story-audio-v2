// Protocol v1 validator (T3.5) — chiều TS của packages/contracts/worker-protocol.md
// (song song với workers/python/src/story_audio/events.py). Dùng cho Node trước khi persist.
export const EVENT_TYPES = [
  "stage_started",
  "progress",
  "chapter_status",
  "artifact_ready",
  "quota_wait",
  "needs_review",
  "error",
  "final",
] as const;

export const FINAL_STATUSES = ["success", "failed", "needs_review", "quota_wait"] as const;

export const ARTIFACT_KINDS = [
  "chapter_text",
  "normalized_text",
  "rewritten_text",
  "chapter_audio",
  "m4b",
  "mp4",
  "thumbnail",
  "description",
] as const;

const REQUIRED: Record<string, readonly string[]> = {
  stage_started: ["stage"],
  progress: ["stage", "done", "total"],
  chapter_status: ["chapter_no", "state"],
  artifact_ready: ["path", "kind", "checksum"],
  quota_wait: ["backend", "not_before"],
  needs_review: ["chapter_no", "reason"],
  error: ["message", "retryable"],
  final: ["status", "summary"],
};

const INT_MIN: Record<string, number> = { done: 0, total: 1, chapter_no: 1 };

export type WorkerEvent = Record<string, unknown> & {
  type: (typeof EVENT_TYPES)[number];
  seq: number;
  job_id: string;
};

export function validateWorkerEvent(ev: unknown): { ok: boolean; error?: string } {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return err("event phải là object");
  const e = ev as Record<string, unknown>;
  for (const key of ["protocol", "type", "seq", "job_id"]) {
    if (!(key in e)) return err(`thiếu trường bắt buộc: ${key}`);
  }
  if (e.protocol !== "1") return err(`protocol không hỗ trợ: ${String(e.protocol)}`);
  if (!(EVENT_TYPES as readonly string[]).includes(String(e.type))) {
    return err(`event type lạ: ${String(e.type)}`);
  }
  const seq = e.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq >= 2 ** 63) {
    return err("seq phải là integer trong [0, 2^63)");
  }
  if (typeof e.job_id !== "string" || !e.job_id) return err("job_id phải là chuỗi khác rỗng");

  const req = REQUIRED[String(e.type)];
  const missing = req.filter((k) => !(k in e));
  if (missing.length) return err(`event ${String(e.type)} thiếu: ${missing.join(", ")}`);

  for (const k of req) {
    if (k in INT_MIN) {
      const v = e[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < INT_MIN[k]) {
        return err(`${k} phải là integer ≥ ${INT_MIN[k]}`);
      }
    }
  }

  if (e.type === "progress" && Number(e.done) > Number(e.total)) {
    return err("progress: done > total");
  }
  if (e.type === "error" && typeof e.retryable !== "boolean") {
    return err("error.retryable phải là boolean");
  }
  if (e.type === "final" && !(FINAL_STATUSES as readonly string[]).includes(String(e.status))) {
    return err(`final.status lạ: ${String(e.status)}`);
  }
  if (e.type === "artifact_ready") {
    if (!/^[0-9a-f]{64}$/.test(String(e.checksum))) return err("checksum phải SHA-256 hex 64");
    if (!(ARTIFACT_KINDS as readonly string[]).includes(String(e.kind))) {
      return err(`kind lạ: ${String(e.kind)}`);
    }
    const path = String(e.path);
    if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      return err("path phải tương đối, dùng '/', không '..'");
    }
  }
  return { ok: true };
}

const err = (error: string): { ok: boolean; error: string } => ({ ok: false, error });
