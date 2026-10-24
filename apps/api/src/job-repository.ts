// Repository layer (T2.4) — cổng duy nhất vào DB cho business code.
// Rules:
//  - mọi hàm nhận jobId và WHERE luôn scope theo job (không query toàn bảng);
//  - đầu vào kiểm ở trust boundary tại đây (ValidationError);
//  - write nhiều bước luôn trong $transaction để không có state nửa vời.
import { ConflictError, NotFoundError, ValidationError, getDb } from "./db";
import {
  CHAPTER_STAGES,
  JOB_STATES,
  assertChapterTransition,
  assertJobTransition,
} from "./state-machine";
import { validateWorkerEvent } from "./worker-protocol";

const JOB_EVENT_TYPES = [
  "stage_started",
  "progress",
  "chapter_status",
  "artifact_ready",
  "quota_wait",
  "needs_review",
  "error",
  "final",
] as const;

const CHAPTER_POINTER_KINDS: Record<string, "textAssetId" | "audioAssetId"> = {
  chapter_text: "textAssetId",
  normalized_text: "textAssetId",
  rewritten_text: "textAssetId",
  chapter_audio: "audioAssetId",
};

type JobEventTypeValue = (typeof JOB_EVENT_TYPES)[number];

const isUniqueViolation = (e: unknown): boolean => pCode(e) === "P2002";
const isFkViolation = (e: unknown): boolean => pCode(e) === "P2003";

const pCode = (e: unknown): string | null =>
  typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : null;

export async function createJob(input: {
  sourceUrl: string;
  adapter: string;
  chaptersPerBook?: number;
  configSnapshot?: unknown;
}): Promise<{ id: string }> {
  if (typeof input.sourceUrl !== "string" || !/^https?:\/\//.test(input.sourceUrl)) {
    throw new ValidationError(`sourceUrl không hợp lệ: ${String(input.sourceUrl)}`);
  }
  if (typeof input.adapter !== "string" || !input.adapter.trim()) {
    throw new ValidationError("adapter rỗng");
  }
  const chaptersPerBook = input.chaptersPerBook ?? 20;
  if (!Number.isInteger(chaptersPerBook) || chaptersPerBook < 1 || chaptersPerBook > 1000) {
    throw new ValidationError(`chaptersPerBook ngoài [1..1000]: ${chaptersPerBook}`);
  }
  if (input.configSnapshot !== undefined && (typeof input.configSnapshot !== "object" || input.configSnapshot === null || Array.isArray(input.configSnapshot))) {
    throw new ValidationError("configSnapshot phải là object");
  }
  const db = getDb();
  return db.job.create({
    data: {
      sourceUrl: input.sourceUrl,
      adapter: input.adapter,
      chaptersPerBook,
      // snapshot bất biến: chỉ ghi lúc tạo — không hàm nào khác đổi nó
      configSnapshot: input.configSnapshot ?? undefined,
    },
    select: { id: true },
  });
}

const CHAPTER_STAGE_VALUES = CHAPTER_STAGES;
const JOB_STATE_VALUES = JOB_STATES;

type ChapterStageValue = (typeof CHAPTER_STAGES)[number];
type JobStateValue = (typeof JOB_STATES)[number];

/**
 * Chuyển stage của chapter — atomic trong 1 tx.
 * LƯU Ý: hàm này chỉ viết giá trị; bảng transition hợp lệ + chặn transition
 * bất hợp lệ nằm ở state machine (T2.5) — lớp này là đường ghi nguyên thuỷ.
 */
export async function setChapterStage(input: {
  jobId: string;
  chapterIndex: number;
  stage: ChapterStageValue | string;
  message?: string;
}): Promise<{ chapterId: string; from: string; to: string }> {
  const stage = input.stage as ChapterStageValue;
  if (!(CHAPTER_STAGE_VALUES as readonly string[]).includes(stage)) {
    throw new ValidationError(`stage lạ: ${String(input.stage)}`);
  }
  const db = getDb();
  return db.$transaction(async (tx) => {
    const chapter = await tx.chapter.findUnique({
      where: { jobId_index: { jobId: input.jobId, index: input.chapterIndex } },
      select: { id: true, stageState: true },
    });
    if (!chapter) throw new NotFoundError(`chapter ${input.chapterIndex} không thuộc job này`);
    // state machine (T2.5): ngoài bảng → InvalidTransition, không ghi âm thầm
    assertChapterTransition(chapter.stageState, stage);
    if (chapter.stageState === stage) {
      // idempotent replay: không ghi lại, theo nguyên tắc tái gắn kết quả giống hệt
      return { chapterId: chapter.id, from: chapter.stageState, to: chapter.stageState };
    }
    return {
      chapterId: chapter.id,
      from: chapter.stageState,
      to: (
        await tx.chapter.update({
          where: { id: chapter.id },
          data: { stageState: stage },
          select: { stageState: true },
        })
      ).stageState,
    };
  });
}

/**
 * Chuyển state của job — ghi thời điểm mốc (startedAt/endedAt) theo state.
 * Bảng transition hợp lệ (T2.5) nằm ở state-machine; đây là đường ghi.
 */
export async function setJobState(input: {
  jobId: string;
  state: JobStateValue | string;
  lastError?: string;
  /** resume: xóa claimed_at/notBefore cũ để lần claim kế chạy LẬP TỨC (quét chờ). */
  clearClaims?: boolean;
}): Promise<{ from: string; to: string }> {
  const state = input.state as JobStateValue;
  if (!(JOB_STATE_VALUES as readonly string[]).includes(state)) {
    throw new ValidationError(`job state lạ: ${String(input.state)}`);
  }
  const db = getDb();
  return db.$transaction(async (tx) => {
    const job = await tx.job.findUnique({
      where: { id: input.jobId },
      select: { state: true },
    });
    if (!job) throw new NotFoundError("job không tồn tại");
    // state machine (T2.5) — hàm nội bộ
    assertJobTransition(job.state, state);
    if (job.state === state) {
      // idempotent: giữ nguyên timestamp cũ (replay phải cho cùng kết quả)
      return { from: job.state, to: job.state };
    }
    const startedAt = state === "running" ? new Date() : undefined;
    const endedAt =
      state === "failed" || state === "canceled" || state === "completed" ? new Date() : undefined;
    const to = (
      await tx.job.update({
        where: { id: input.jobId },
        data: {
          state,
          lastError: input.lastError,
          startedAt,
          endedAt,
          claimedAt: input.clearClaims === true ? null : undefined,
          notBefore: input.clearClaims === true ? null : undefined,
        },
        select: { state: true },
      })
    ).state;
    return { from: job.state, to };
  });
}

export async function getJob(jobId: string): Promise<Record<string, unknown> | null> {
  if (!jobId.trim()) throw new ValidationError("jobId rỗng");
  const db = getDb();
  return (await db.job.findUnique({ where: { id: jobId } })) as
    | Record<string, unknown>
    | null;
}

/** Upsert chapters theo index (từ artifacts extract của worker; title = dòng đầu text.txt).
 * Idempotent: index đã tồn tại → giữ nguyên (title thay đổi nguồn = dữ liệu khác — báo qua message). */
export async function upsertChapters(
  jobId: string,
  items: { index: number; title: string }[],
): Promise<{ created: number; existing: number }> {
  if (!jobId.trim()) throw new ValidationError("jobId rỗng");
  for (const it of items) {
    if (!Number.isInteger(it.index) || it.index < 1) {
      throw new ValidationError(`chapter index phải nguyên ≥ 1: ${String(it.index)}`);
    }
  }
  const db = getDb();
  // Chapter.sourceUrl BẮT BUỘC — MVP lấy URL nguồn job (worker chưa cấp URL riêng
  // từng chương; adapter thật ngày sau trả URL qua event sẽ nâng chỗ này).
  const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { sourceUrl: true } });
  const sourceUrl = job.sourceUrl;
  let created = 0;
  let existing = 0;
  for (const it of items) {
    const hit = await db.chapter.findFirst({ where: { jobId, index: it.index }, select: { id: true } });
    if (hit) {
      existing++;
      continue;
    }
    await db.chapter.create({
      data: { jobId, index: it.index, title: it.title, sourceUrl, stageState: "discovered" },
      select: { id: true },
    });
    created++;
  }
  return { created, existing };
}

/** Danh sách chapter của job (dùng cho skip-logic stage). */
export async function listChapters(
  jobId: string,
): Promise<{ index: number; stageState: string; title: string }[]> {
  if (!jobId.trim()) throw new ValidationError("jobId rỗng");
  const db = getDb();
  const rows = await db.chapter.findMany({
    where: { jobId },
    orderBy: { index: "asc" },
    select: { index: true, stageState: true, title: true },
  });
  return rows;
}

/** T6.3 — chương CẦN TTS: đã qa_passed mà chưa có audio asset nào.
 * Chạy lại job: chương tts_done (đã có audio verified) bị loại — không hẹn TTS lại. */
export async function chaptersNeedingTts(jobId: string): Promise<number[]> {
  if (!jobId.trim()) throw new ValidationError("jobId rỗng");
  const rows = await getDb().chapter.findMany({
    where: { jobId, stageState: "qa_passed", audioAssetId: null },
    orderBy: { index: "asc" },
    select: { index: true },
  });
  return rows.map((r) => r.index);
}

/**
 * Ghi 1 event vào job_events. seq là unique (job_id, seq) — replay cùng seq
 * KHÔNG ghi đè (at-least-once là an toàn): trả {event:"seq_taken"} để caller
 * biết event này đã persist từ lần trước.
 */
export async function appendJobEvent(input: {
  jobId: string;
  seq: number;
  eventType: JobEventTypeValue;
  chapterId?: string;
  message?: string;
  data?: unknown;
}): Promise<{ id: string } | { event: "seq_taken" }> {
  if (!(JOB_EVENT_TYPES as readonly string[]).includes(input.eventType)) {
    throw new ValidationError(`event type lạ: ${String(input.eventType)}`);
  }
  if (!Number.isInteger(input.seq) || input.seq < 0) {
    throw new ValidationError(`seq phải nguyên ≥ 0: ${input.seq}`);
  }
  const db = getDb();
  try {
    const ev = await db.jobEvent.create({
      data: {
        jobId: input.jobId,
        seq: input.seq,
        eventType: input.eventType,
        chapterId: input.chapterId,
        message: input.message,
        data: input.data === undefined ? undefined : JSON.parse(JSON.stringify(input.data)),
      },
      select: { id: true },
    });
    return { id: ev.id };
  } catch (e) {
    if (isUniqueViolation(e)) return { event: "seq_taken" };
    if (isFkViolation(e)) throw new NotFoundError("job/chapter không tồn tại");
    throw e;
  }
}

/** Tạo asset text/audio cho chapter + cập nhật con trỏ active trong 1 transaction. */
export async function createChapterAsset(input: {
  jobId: string;
  chapterIndex: number;
  kind: keyof typeof CHAPTER_POINTER_KINDS;
  objectKey: string;
  contentType: string;
  size: number;
  sha256: string;
}): Promise<{ assetId: string; chapterId: string; pointer: string | null }> {
  const pointerField = CHAPTER_POINTER_KINDS[input.kind] ?? null;
  if (!input.objectKey || input.objectKey.includes("..")) {
    throw new ValidationError(`objectKey thiếu/lọt '..': ${String(input.objectKey)}`);
  }
  const db = getDb();
  try {
    return await db.$transaction(async (tx) => {
      const chapter = await tx.chapter.findUnique({
        where: { jobId_index: { jobId: input.jobId, index: input.chapterIndex } },
        select: { id: true },
      });
      if (!chapter) throw new NotFoundError(`chapter ${input.chapterIndex} không thuộc job này`);

      const asset = await tx.asset.create({
        data: {
          jobId: input.jobId,
          chapterId: chapter.id,
          kind: input.kind,
          objectKey: input.objectKey,
          contentType: input.contentType,
          size: input.size,
          sha256: input.sha256,
          verified: input.verified ?? true,
        },
        select: { id: true },
      });
      if (pointerField) {
        await tx.chapter.update({
          where: { id: chapter.id },
          data: { [pointerField]: asset.id },
        });
      }
      return { assetId: asset.id, chapterId: chapter.id, pointer: pointerField };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `asset kind '${input.kind}' đã tồn tại cho chapter ${input.chapterIndex}`,
      );
    }
    throw e;
  }
}

/**
 * Persist mảng event thô từ worker stdout (T3.5):
 *  - validate protocol v1 trước; event hỏng → rejected, KHÔNG vào DB;
 *  - idempotent: replay một seq không tạo row mới (queue "seq_taken");
 *  - status updates: final.* → setJobState tương ứng; quota_wait → waiting_quota + notBefore.
 */
export async function persistWorkerEvents(
  jobId: string,
  events: unknown[],
  opts: { completeOnFinalSuccess?: boolean } = {},
): Promise<{
  persisted: number;
  rejected: { seq: unknown; error: string }[];
  duplicate: number;
}> {
  let persisted = 0;
  let duplicate = 0;
  const rejected: { seq: unknown; error: string }[] = [];
  for (const raw of events) {
    const check = validateWorkerEvent(raw);
    if (!check.ok) {
      rejected.push({ seq: (raw as { seq?: unknown })?.seq, error: check.error ?? "không rõ" });
      continue;
    }
    const ev = raw as {
      type: JobEventTypeString;
      seq: number;
      message?: string;
      not_before?: string;
      stage?: string;
    };
    const r = await appendJobEvent({
      jobId,
      seq: ev.seq,
      eventType: ev.type,
      message: "message" in ev ? (ev.message as string) : ("summary" in ev ? (ev.summary as string) : undefined),
      data: ev,
    });
    if ("id" in r) persisted++;
    else duplicate++;

    // status updates — chỉ chạy khi event MỚI (replay không lặp state machine)
    if ("id" in r) {
      if (ev.type === "final") {
        const status = (ev as { status?: string }).status;
        // pipeline orchestrator đặt completionOnFinalSuccess=false: stage giữa chừng
        // final.success KHÔNG được set completed (runner quyết định qua exit codes);
        // các kết cục khác (needs_review/quota_wait/failed) vẫn map tự động.
        const autoComplete =
          opts.completeOnFinalSuccess !== undefined
            ? opts.completeOnFinalSuccess
            : status === "success";
        const statusMap = {
          success: "completed",
          failed: "failed",
          needs_review: "needs_review",
          quota_wait: "waiting_quota",
        } as const;
        if (
          status &&
          status in statusMap &&
          !(status === "success" && !autoComplete)
        ) {
          try {
            await setJobState({
              jobId,
              state: statusMap[status as keyof typeof statusMap],
              lastError:
                status === "failed" ? (ev as { summary?: string }).summary ?? undefined : undefined,
            });
          } catch {
            // state machine chặn (vd job canceled giữa chừng) — event vẫn persist, state giữ nguyên
          }
        }
      }
      if (ev.type === "quota_wait") {
        const nb = (ev as { not_before?: string }).not_before;
        const notBefore = nb ? new Date(nb) : null;
        if (notBefore && !Number.isNaN(notBefore.getTime())) {
          try {
            const job = (await getJob(jobId)) as { state: string } | null;
            if (job && job.state !== "waiting_quota") {
              await setJobState({ jobId, state: "waiting_quota" });
            }
            await getDb().job.update({ where: { id: jobId }, data: { notBefore } });
          } catch {
            // persist event ưu tiên — state update là opportunistic
          }
        }
      }
    }
  }
  return { persisted, rejected, duplicate };
}

type JobEventTypeString =
  | "stage_started"
  | "progress"
  | "chapter_status"
  | "artifact_ready"
  | "quota_wait"
  | "needs_review"
  | "error"
  | "final";
