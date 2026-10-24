// Storage budget (T4.5) — ngân sách R2 ở cấp app (không thay thế hard quota của cloud).
// Ngân sách tính theo TỔNG assets.size trong DB (proxy cho bytes đã upload — free-tier R2 10GB);
// vượt → CHẶN upload mới (không ghi asset), không bao giờ tự xóa remote/DB như "cleanup".
import { RepositoryError, getDb } from "./db";

export class StorageBudgetExceededError extends RepositoryError {}

const DEFAULT_BUDGET_MB = 1024; // 1GB — free-tier R2 10GB nhưng để dư biên cho tests/dev
const DEFAULT_WARN_PERCENT = 80;

export function readBudget(): { bytes: number | null; warnPercent: number } {
  const rawMb = Number(process.env.STORAGE_BUDGET_MB);
  const warn = Number(process.env.STORAGE_BUDGET_WARN_PERCENT);
  const bytes =
    Number.isFinite(rawMb) && rawMb > 0 ? Math.floor(rawMb * 1024 * 1024) : DEFAULT_BUDGET_MB * 1024 * 1024;
  const warnPercent = Number.isFinite(warn) && warn > 0 && warn <= 100 ? Math.floor(warn) : DEFAULT_WARN_PERCENT;
  return { bytes, warnPercent };
}

/** Tổng bytes tất cả asset recorded (cả unverified) — không đếm orphan remote. */
export async function getUsedBytes(): Promise<number> {
  const db = getDb();
  const agg = await db.asset.aggregate({ _sum: { size: true } });
  return agg._sum.size ?? 0;
}

export interface BudgetDecision {
  ok: boolean;
  usedBytes: number;
  budgetBytes: number;
  usedPercent: number;
  overBytes: number;
}

/** Kiểm trước khi upload: used + delta (có thể âm khi re-upload thay content) vs budget. */
export async function allowsUploadDelta(deltaBytes: number, budgetOverride?: { bytes: number; warnPercent: number }): Promise<BudgetDecision> {
  const budget = budgetOverride ?? readBudget();
  const usedBytes = await getUsedBytes();
  const after = usedBytes + deltaBytes;
  const budgetBytes = budget.bytes;
  return {
    ok: after <= budgetBytes,
    usedBytes,
    budgetBytes,
    usedPercent: Math.round(((usedBytes + deltaBytes) / budgetBytes) * 100), // so cảnh báo ở caller
    overBytes: Math.max(after - budgetBytes, 0),
  };
}

// debounce warn: mỗi 60s một lần mỗi process — không spam per-artifact
let lastWarnAt = 0;

export function maybeWarnBudget(usedPercent: number, warnPercent: number): void {
  if (usedPercent >= warnPercent && Date.now() - lastWarnAt > 60_000) {
    lastWarnAt = Date.now();
    console.warn(
      JSON.stringify({
        warn: "storage_budget_threshold",
        usedPercent,
        thresholdPercent: warnPercent,
      }),
    );
  }
}
