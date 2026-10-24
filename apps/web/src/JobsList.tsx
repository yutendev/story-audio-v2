// T8.2 — Job list: nhóm theo state (queued/running/waiting_quota/needs_review/failed/
// canceled/completed) + bảng job; chọn job để xem chi tiết. Dữ liệu CHỈ từ API.
import { useEffect, useState } from "react";
import { fetchJobs, deleteJob } from "./api";
import type { JobListResult, JobRow } from "./api";

export const JOB_STATES = [
  "queued",
  "running",
  "waiting_quota",
  "needs_review",
  "failed",
  "canceled",
  "completed",
] as const;

export const VI_JOB_STATES: Record<string, string> = {
  queued: "Đang xếp hàng",
  running: "Đang chuyển thể",
  waiting_quota: "Chờ hạn ngạch AI",
  needs_review: "Cần duyệt đoạn khó",
  failed: "Gặp sự cố",
  canceled: "Đã hủy bỏ",
  completed: "Hoàn tất viên mãn",
};

/** Tự động trích xuất tên tác phẩm từ URL đọc truyện */
export function extractStoryTitle(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    for (const part of parts) {
      if (
        !part.startsWith("chuong-") &&
        !["doc-truyen", "truyen", "convert", "dich", "truyen-chu"].includes(part)
      ) {
        return part
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
      }
    }
    return u.hostname;
  } catch {
    return "Tác phẩm";
  }
}

interface Props {
  refreshKey: number;
  onSelectJob: (jobId: string) => void;
  selectedJobId?: string;
}

export function JobsList({ refreshKey, onSelectJob, selectedJobId }: Props) {
  const [result, setResult] = useState<JobListResult | null>(null);
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState("");

  async function handleDelete(jobId: string, title: string) {
    if (!window.confirm(`Bạn có chắc chắn muốn xóa bộ truyện "${title}" khỏi tủ sách?`)) {
      return;
    }
    setDeletingId(jobId);
    try {
      await deleteJob(jobId);
      const got = await fetchJobs(50);
      setResult(got);
      if (selectedJobId === jobId) {
        onSelectJob("");
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("Route DELETE") || msg.includes("không tồn tại")) {
        alert(
          "Server API hiện đang chạy bản code cũ trong bộ nhớ nên chưa nạp lệnh Xóa mới.\n\n" +
          "👉 Bạn hãy chuyển sang cửa sổ Terminal đang chạy Server API, nhấn Ctrl + C rồi gõ lại:\n" +
          "npm --prefix apps/api run dev\n" +
          "để máy chủ kích hoạt tính năng Xóa nhé!"
        );
      } else {
        alert("Lỗi khi xóa: " + msg);
      }
    } finally {
      setDeletingId("");
    }
  }

  useEffect(() => {
    let stale = false;
    (async () => {
      setError("");
      try {
        const got = await fetchJobs(50);
        if (!stale) setResult(got);
      } catch (err) {
        if (!stale) setError((err as Error).message);
      }
    })();
    return () => {
      stale = true;
    };
  }, [refreshKey]);

  if (error) return <p role="alert">Lỗi: {error}</p>;
  if (!result) return <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Đang tải danh sách tác phẩm…</p>;

  const byState = new Map<string, JobRow[]>();
  for (const job of result.items) {
    const list = byState.get(job.state) ?? [];
    list.push(job);
    byState.set(job.state, list);
  }

  return (
    <section aria-label="Danh sách job" className="card-modern" style={{ padding: "22px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 20 }}>📚</span>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: 0 }}>
            Job ({result.total})
          </h2>
          <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-muted)" }}>
            — Tủ sách tác phẩm đã nạp
          </span>
        </div>
        <span style={{ fontSize: 11.5, color: "var(--text-subtle)" }}>
          Nhấn "Xem" để mở dây chuyền theo dõi
        </span>
      </div>

      <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 14, wordBreak: "break-word" }}>
        {JOB_STATES.map((s) => (
          <span key={s} data-state={s} style={{ marginRight: 8 }}>
            {s}: {byState.get(s)?.length ?? 0} ·{" "}
          </span>
        ))}
      </p>

      <div style={{ overflowX: "auto" }}>
        <table>
          <caption>Job gần nhất</caption>
          <thead>
            <tr>
              <th scope="col">Tác phẩm</th>
              <th scope="col">Trạng thái xử lý</th>
              <th scope="col">Đường dẫn nguồn</th>
              <th scope="col">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((job) => {
              const stateText = VI_JOB_STATES[job.state] || job.state;
              return (
                <tr key={job.id}>
                  <td style={{ minWidth: 160 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, color: "#0f172a" }}>
                      📖 {extractStoryTitle(job.sourceUrl)}
                    </div>
                  </td>
                  <td>
                    <span className={`tag tag-${job.state}`} title={job.state}>
                      {stateText}
                    </span>
                  </td>
                  <td style={{ color: "var(--text-muted)", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
                    {job.sourceUrl}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => onSelectJob(job.id)}
                        style={{ fontSize: 12, padding: "6px 14px", borderRadius: 8, position: "relative" }}
                      >
                        <span>Xem tiến độ</span>
                        <span
                          style={{
                            position: "absolute",
                            width: 1,
                            height: 1,
                            padding: 0,
                            margin: -1,
                            overflow: "hidden",
                            clip: "rect(0, 0, 0, 0)",
                            whiteSpace: "nowrap",
                            border: 0,
                          }}
                        >
                          Xem {job.id}
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={deletingId === job.id}
                        onClick={() => void handleDelete(job.id, extractStoryTitle(job.sourceUrl))}
                        style={{
                          fontSize: 12,
                          padding: "6px 10px",
                          borderRadius: 8,
                          color: "#dc2626",
                          borderColor: "#fecaca",
                          background: "#ffffff",
                        }}
                        title="Xóa bộ truyện này khỏi tủ sách"
                      >
                        {deletingId === job.id ? "Đang xóa…" : "🗑️ Xóa"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {result.items.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", color: "var(--text-muted)", padding: "28px 0" }}>
                  Chưa có tác phẩm nào trong tủ sách. Hãy dán liên kết ở Bước 1 phía trên để bắt đầu!
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
