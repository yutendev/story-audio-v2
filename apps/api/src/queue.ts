// Job-queue (T3.3) — PostgreSQL là hàng đợi; 1 worker chạy MỘT job tại một thời điểm.
// MVP theo plan: không thêm queue framework bên ngoài.
import { getDb } from "./db";
import { appendJobEvent, setJobState } from "./job-repository";
import { assertJobTransition } from "./state-machine";
import { registerActiveRun, signalCancel } from "./active-runs";

/**
 * Claim 1 job từ hàng đợi — atomic qua SELECT FOR UPDATE SKIP LOCKED:
 * 2 claim chạy đồng thời chỉ 1 hạ được job (chống schedule trùng).
 * Claimable: queued / waiting_quota (qua notBefore) / running-CHƯA-CÓ-CLAIM
 * (claimAt IS NULL = job vừa được user resume — claim gán claimed_at ngay nên
 * không claim trùng 2 lần job đang chạy; orphan running bị boot requeue).
 */
export async function claimNextJob(): Promise<{ id: string } | null> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "jobs"
      WHERE (
          "state" IN ('queued', 'waiting_quota')
          OR ("state" = 'running' AND "claimed_at" IS NULL)
        )
        AND ("not_before" IS NULL OR "not_before" <= NOW())
      ORDER BY "created_at" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return null;
    const { id } = rows[0];
    const job = await tx.job.findUniqueOrThrow({
      where: { id },
      select: { state: true },
    });
    assertJobTransition(job.state, "running");
    await tx.job.update({
      where: { id },
      data: {
        state: "running",
        claimedAt: new Date(),
        startedAt: job.state === "queued" ? new Date() : undefined,
      },
    });
    return { id };
  });
}

// shortcut: orphan recovery bỏ qua bảng transition (updateMany trực tiếp),
// chỉ được runner boot gọi — khi multi-runner/lease thật xuất hiện, phải thay bằng cơ chế lease.
export async function requeueOrphanedJobs(): Promise<number> {
  const db = getDb();
  const r = await db.job.updateMany({
    where: { state: "running" },
    data: { state: "queued", claimedAt: null },
  });
  return r.count;
}

export interface RunnerOptions {
  pollMs?: number;
}

/** Handler nhận AbortSignal — T3.6: cancel qua POST /api/jobs/:id/cancel sẽ trigger signal. */
export type ActiveHandler = (jobId: string, signal: AbortSignal) => Promise<void>;

/**
 * Runner đơn (một process = một runner — plan T3.3). start() bo cần:
 * requeueOrphans() → vòng claim→handler tuần tự; job lỗi → failed + event error.
 * Idempotent: gọi start() lần nữa không tạo vòng lặp thứ hai.
 */
export class JobRunner {
  private stopped = true;
  private booted = false;

  constructor(
    private readonly handler: ActiveHandler,
    private readonly opts: RunnerOptions = {},
  ) {}

  start(): void {
    if (this.booted) return;
    this.booted = true;
    this.stopped = false;
    void this.finalizeBoot();
  }

  private async finalizeBoot(): Promise<void> {
    try {
      await requeueOrphanedJobs();
    } catch (e) {
      console.error(JSON.stringify({ error: { code: "RECOVER_FAILED", message: String(e) } }));
    }
    await this.loop();
  }

  private async loop(): Promise<void> {
    const pollMs = this.opts.pollMs ?? 500;
    while (!this.stopped) {
      let claimed: { id: string } | null = null;
      try {
        claimed = await claimNextJob();
      } catch (e) {
        console.error(JSON.stringify({ error: { code: "CLAIM_FAILED", message: String(e) } }));
      }
      if (!claimed) {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      try {
        const controller = new AbortController();
        const unregister = registerActiveRun(claimed.id, (reason) => {
          controller.abort(reason as never);
        });
        try {
          await this.handler(claimed.id, controller.signal);
        } finally {
          unregister();
        }
      } catch (e) {
        console.error(
          JSON.stringify({ error: { code: "JOB_FAILED", jobId: claimed.id, message: String(e) } }),
        );
        try {
          await setJobState({ jobId: claimed.id, state: "failed", lastError: String(e) });
          await appendJobErrorEvent(claimed.id, String(e));
        } catch (e2) {
          console.error(
            JSON.stringify({ error: { code: "FAIL_MARK_FAILED", message: String(e2) } }),
          );
        }
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

/** Ghi event error với seq = MAX(seq)+1 per job (an toàn vì runner đơn, tuần tự). */
async function appendJobErrorEvent(jobId: string, message: string): Promise<void> {
  const db = getDb();
  const agg = await db.jobEvent.aggregate({ where: { jobId }, _max: { seq: true } });
  await appendJobEvent({
    jobId,
    seq: (agg._max.seq ?? -1) + 1,
    eventType: "error",
    message,
  });
}
