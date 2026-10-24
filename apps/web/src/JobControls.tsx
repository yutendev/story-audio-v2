// T8.3 — điều khiển lifecycle THEO MÁY TRẠNG THÁI (JOB_TRANSITIONS, T2.5/T5.6/T5.7):
// mỗi state chỉ hiện nút hợp lệ (canceled/completed: không nút); nút bấm sai
// vẫn nhận 409 từ API và hiển thị NGUYÊN VĂN. KHÔNG có nút "tự sửa tự động" nào
// không được hỗ trợ bởi pipeline.
import { useState } from "react";
import { postJobAction } from "./api";
import type { JobAction, JobRow } from "./api";

const CONTROLS: Record<string, Array<{ action: JobAction; label: string }>> = {
  queued: [{ action: "cancel", label: "Hủy job" }],
  running: [{ action: "cancel", label: "Hủy job" }],
  waiting_quota: [
    { action: "resume", label: "Cho chạy lại ngay (bỏ chờ quota)" },
    { action: "cancel", label: "Hủy job" },
  ],
  needs_review: [
    { action: "resume", label: "Duyệt xong — tiếp tục" },
    { action: "cancel", label: "Hủy job" },
  ],
  failed: [
    { action: "retry", label: "Thử lại (về hàng đợi)" },
    { action: "cancel", label: "Hủy job" },
  ],
  canceled: [],
  completed: [],
};

/** waiting_quota: chờ quota là hành vi designed của pipeline — không tự chạy model trả phí. */
export function quotaExplain(job: JobRow): string {
  if (job.state !== "waiting_quota") return "";
  const when = job.notBefore
    ? ` — sẽ tự chạy lại sau ${new Date(job.notBefore).toLocaleString()}`
    : "";
  return `Đang chờ hết hạn quota của provider (không chuyển sang model trả phí).${when} Nếu biết quota đã đủ, bấm "Cho chạy lại ngay".`;
}

export function JobControls({ job, onRefresh }: { job: JobRow; onRefresh: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const controls = CONTROLS[job.state] ?? [];

  async function run(action: JobAction): Promise<void> {
    setError("");
    setBusy(action);
    try {
      await postJobAction(job.id, action);
      onRefresh();
    } catch (err) {
      setError((err as Error).message); // nguyên văn từ API (409/404) — safe actionable
    } finally {
      setBusy("");
    }
  }

  if (controls.length === 0) return null;
  return (
    <section aria-label="Điều khiển job" style={{ margin: "14px 0 8px" }}>
      {job.state === "waiting_quota" ? <p role="status">{quotaExplain(job)}</p> : null}
      {job.state === "failed" && job.lastError ? (
        <p style={{ color: "var(--red)", fontSize: 12, margin: "6px 0", fontWeight: 600 }}>
          Sự cố gần nhất: {job.lastError}
        </p>
      ) : null}
      {error ? <p role="alert">Lỗi: {error}</p> : null}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
        {controls.map((c) => (
          <button
            key={c.action}
            type="button"
            disabled={busy !== ""}
            onClick={() => void run(c.action)}
            style={{
              fontSize: 12,
              padding: "7px 14px",
              background: c.action === "cancel" ? "var(--red-light)" : "var(--jade-light)",
              color: c.action === "cancel" ? "var(--red)" : "var(--jade)",
              borderColor: c.action === "cancel" ? "#fecaca" : "var(--jade-border)",
            }}
          >
            {busy === c.action ? "Đang xử lý…" : c.label}
          </button>
        ))}
      </div>
    </section>
  );
}
