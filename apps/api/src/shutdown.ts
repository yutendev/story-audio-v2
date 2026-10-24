// Graceful shutdown (T3.6): SIGINT/SIGTERM — chấm dứt claim mới, hoàn tất job đang chạy
// trong grace period; quá hạn → thoát, job còn running sẽ được requeue ở lần boot sau.
import type { JobRunner } from "./queue";
import { abortActiveRuns, waitForIdle } from "./active-runs";

export interface ShutdownOptions {
  runner?: JobRunner;
  graceMs?: number;
  /** gọi sau khi sạch — test dùng hàm này thay vì exit process thật */
  onExit?: (code: number) => void;
}

/** Gọi khi SIGINT/SIGTERM hoặc shutdown test. Idempotent: lần nữa không lặp. */
export async function gracefulShutdown(opts: ShutdownOptions = {}): Promise<void> {
  const graceMs = opts.graceMs ?? 5_000;
  opts.runner?.stop();
  // handler đang chạy nhận abort → pipeline dừng giữa stage, worker bị kill,
  // job còn running sẽ được requeue ở lần boot sau (T9.2)
  abortActiveRuns();
  await waitForIdle(graceMs);
  opts.onExit?.(0);
}

export function installShutdownSignals(opts: ShutdownOptions): () => void {
  let shuttingDown = false;
  const handle = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void gracefulShutdown(opts).then(() => opts.onExit?.(0));
  };
  process.on("SIGINT", handle);
  process.on("SIGTERM", handle);
  return () => {
    process.off("SIGINT", handle);
    process.off("SIGTERM", handle);
  };
}
