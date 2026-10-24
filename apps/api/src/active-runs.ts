// Active runs registry (T3.6) — cầu nối giữa cancel API và handler đang chạy của runner.
import { getDb } from "./db";

    const handlers = new Map<string, (reason: string) => void>();

/** Runner gọi khi bắt đầu chạy 1 job; trả hàm unregister. onAbort thường = controller.abort(). */
export function registerActiveRun(jobId: string, onAbort: (reason: string) => void): () => void {
  handlers.set(jobId, onAbort);
  return () => handlers.delete(jobId);
}

/** Cancel API gọi sau khi state chuyển đủ — handler nhận signal và tự kết thúc đàng hoàng. */
export function signalCancel(jobId: string): void {
  handlers.get(jobId)?.("canceled");
}

/** Shutdown: abort TẤT CẢ handler đang chạy (chúng dừng giữa stage, worker bị kill). */
export function abortActiveRuns(): void {
  for (const abort of handlers.values()) abort("shutdown");
}

/** Đợi mọi active run kết thúc (graceful shutdown); timeout → trả false nhưng không kill. */
export async function waitForIdle(graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (handlers.size > 0) {
    await new Promise((r) => setTimeout(r, 50));
    if (Date.now() > deadline) return false;
  }
  return true;
}
