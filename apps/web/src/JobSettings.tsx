// T8.1 — Cấu hình job ĐÃ LƯU: giá trị hiển thị luôn lấy TỪ API (GET lại sau mỗi lần
// PATCH); remount theo snapshot để form khởi tạo từ cấu hình persist chứ không từ
// state cũ. PATCH lỏng: gửi đủ các trường người dùng sửa; server merge cục bộ.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { fetchJob, updateJobSettings } from "./api";
import type { ExportOptions, JobRow } from "./api";
import { extractStoryTitle, VI_JOB_STATES } from "./JobsList";

interface SettingsProps {
  job: JobRow;
  onSaved: () => Promise<void>;
}

export function SettingsForm({ job, onSaved }: SettingsProps) {
  const snapshot = (job.configSnapshot ?? {}) as { export?: ExportOptions };
  const [perBook, setPerBook] = useState(job.chaptersPerBook);
  const [exportOptions, setExportOptions] = useState<ExportOptions>(snapshot.export ?? {});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!Number.isInteger(perBook) || perBook < 1 || perBook > 1000) {
      setError("chaptersPerBook phải nguyên trong [1..1000]");
      return;
    }
    setBusy(true);
    try {
      await updateJobSettings(job.id, { chaptersPerBook: perBook, export: exportOptions });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate style={{ marginTop: 10 }}>
      <fieldset style={{ margin: "10px 0" }}>
        <legend>Quy cách đóng gói tập</legend>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: "100%" }}>
            <label htmlFor="settings-per-book" style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
              Số chương gom thành một tập sách nói M4B:
            </label>
            <input
              id="settings-per-book"
              aria-label="Chương mỗi sách (đã lưu)"
              type="number"
              min={1}
              max={1000}
              value={perBook}
              onChange={(e) => setPerBook(Number(e.target.value))}
              style={{ width: 120, padding: "8px 12px" }}
            />
          </div>
        </div>
      </fieldset>

      <fieldset style={{ margin: "10px 0" }}>
        <legend>Tùy chọn giọng đọc & AI</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label htmlFor="settings-title" style={{ fontSize: 12, marginBottom: 4 }}>
              Tựa sách
            </label>
            <input
              id="settings-title"
              aria-label="Tựa sách"
              value={exportOptions.bookTitle ?? ""}
              onChange={(e) => setExportOptions({ ...exportOptions, bookTitle: e.target.value })}
              placeholder="Tên sách hiển thị"
              style={{ padding: "8px 12px" }}
            />
          </div>
          <div>
            <label htmlFor="settings-voice" style={{ fontSize: 12, marginBottom: 4 }}>
              Giọng đọc TTS
            </label>
            <input
              id="settings-voice"
              aria-label="Giọng đọc TTS"
              value={exportOptions.ttsVoice ?? ""}
              onChange={(e) => setExportOptions({ ...exportOptions, ttsVoice: e.target.value })}
              placeholder="vi-VN-HoaiMyNeural"
              style={{ padding: "8px 12px" }}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 20, marginTop: 12 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, margin: 0, cursor: "pointer", fontSize: 12.5 }}>
            <input
              type="checkbox"
              aria-label="Bật rewrite AI"
              checked={exportOptions.rewriteAi === true}
              onChange={(e) => setExportOptions({ ...exportOptions, rewriteAi: e.target.checked })}
            />{" "}
            Bật rewrite AI (Chuốt câu cú)
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, margin: 0, cursor: "pointer", fontSize: 12.5, color: "var(--text-muted)" }}>
            <input
              type="checkbox"
              aria-label="Nội dung 18+"
              checked={exportOptions.isAdultContent === true}
              onChange={(e) =>
                setExportOptions({ ...exportOptions, isAdultContent: e.target.checked })
              }
            />{" "}
            Nội dung 18+
          </label>
        </div>
      </fieldset>

      {error ? <p role="alert">Lỗi: {error}</p> : null}
      <button type="submit" disabled={busy} style={{ marginTop: 8, fontSize: 12 }}>
        {busy ? "Đang lưu cấu hình…" : "Lưu cấu hình"}
      </button>
    </form>
  );
}

export function JobDetail({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobRow | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function refresh(): Promise<void> {
    setError("");
    setSaved("");
    try {
      setJob(await fetchJob(jobId));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
  }, [jobId]);

  if (error) return <p role="alert">{error}</p>;
  if (!job) return <p style={{ color: "var(--ink-muted)", fontSize: 13 }}>Đang tải thông tin…</p>;
  return (
    <section aria-label="Chi tiết job" className="card-modern" style={{ padding: "22px 26px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 18 }}>⚙️</span>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: 0 }}>
              Cài đặt tác phẩm: {extractStoryTitle(job.sourceUrl)}
            </h2>
            <span className={`tag tag-${job.state}`} title={job.state}>
              {VI_JOB_STATES[job.state] || job.state}
            </span>
          </div>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
            💡 Bạn có thể điều chỉnh lại quy cách đóng gói hoặc đổi giọng đọc cho các chương tiếp theo mà không cần nạp lại truyện từ đầu.
          </p>
        </div>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--text-subtle)", margin: "8px 0 14px", wordBreak: "break-all" }}>
        Trạng thái: {job.state} · URL: {job.sourceUrl}
      </p>
      <SettingsForm
        key={`${job.chaptersPerBook}|${JSON.stringify(job.configSnapshot ?? {})}`}
        job={job}
        onSaved={async () => {
          await refresh();
          setSaved("Đã lưu — giá trị hiển thị lấy từ API sau khi GET lại.");
        }}
      />
      {saved ? <p role="status">{saved}</p> : null}
    </section>
  );
}
