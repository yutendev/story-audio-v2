// Durable state machine (T2.5): bảng transition hợp lệ cho Job + Chapter.
// - same→same là idempotent no-op (replay an toàn);
// - transition ngoài bảng → InvalidTransition (KHÔNG im lặng thay đổi);
// - bảng này là nguồn sự thật: job-repository chỉ ghi qua guard này.
import { RepositoryError } from "./db";

export class InvalidTransitionError extends RepositoryError {}

export const JOB_STATES = [
  "queued",
  "running",
  "waiting_quota",
  "needs_review",
  "failed",
  "canceled",
  "completed",
] as const;
export type JobStateValue = (typeof JOB_STATES)[number];

export const CHAPTER_STAGES = [
  "discovered",
  "downloaded",
  "normalized",
  "rewritten",
  "qa_passed",
  "tts_done",
  "verified",
  "failed",
] as const;
export type ChapterStageValue = (typeof CHAPTER_STAGES)[number];

/** Job: vòng đời 1 job. failed có thể retry về queued; canceled/completed terminal. */
export const JOB_TRANSITIONS: Record<JobStateValue, readonly JobStateValue[]> = {
  queued: ["running", "canceled"],
  running: ["waiting_quota", "needs_review", "failed", "completed", "canceled"],
  waiting_quota: ["running", "failed", "canceled"],
  needs_review: ["running", "canceled"], // user duyệt xong tiếp/từ chối
  failed: ["queued", "canceled"], // retry = quay lại hàng đợi
  canceled: [],
  completed: [],
};

/** Chapter: pipeline §7 tuyến tính; failed terminal (retry tạo lại qua repo, không bước lùi). */
export const CHAPTER_TRANSITIONS: Record<ChapterStageValue, readonly ChapterStageValue[]> = {
  discovered: ["downloaded", "failed"],
  downloaded: ["normalized", "failed"],
  normalized: ["rewritten", "failed"],
  rewritten: ["qa_passed", "failed"],
  qa_passed: ["tts_done", "failed"],
  tts_done: ["verified", "failed"],
  verified: [],
  failed: [],
};

function assertTransition(
  table: Record<string, readonly string[]>,
  from: string,
  to: string,
  what: string,
): void {
  // idempotent: replay cùng state — không ghi gì thêm
  if (to === from) return;
  const allowed = table[from];
  if (!allowed?.includes(to)) {
    throw new InvalidTransitionError(`${what}: không được '${from}' → '${to}'`);
  }
}

export function assertJobTransition(from: string, to: string): void {
  assertTransition(JOB_TRANSITIONS, from, to, "job");
}

export function assertChapterTransition(from: string, to: string): void {
  assertTransition(CHAPTER_TRANSITIONS, from, to, "chapter");
}
