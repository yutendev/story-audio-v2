import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Rocket,
  Zap,
  FileText,
  HardDriveDownload,
  AlertTriangle,
  AlertOctagon,
  CheckCircle2,
  Clock,
  Bot,
  Mic,
  Package,
  Settings,
  ArrowDownToLine,
  Copy,
  Maximize2,
  Minimize2,
  Play,
  Download,
  Headphones,
  X,
  Info,
  Eye,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { fetchChapters, fetchEventsAfter, fetchJob, postJobAction } from "./api";
import { SlideOverReviewDrawer } from "./SlideOverReviewDrawer";
import type { ChapterRow, JobEvent, JobRow } from "./api";
import { openEventStream } from "./sse";
import type { StreamHandle } from "./sse";
import { JobControls } from "./JobControls";
import { extractStoryTitle, VI_JOB_STATES } from "./JobsList";


const STAGE_ORDER = [
  "discovered",
  "downloaded",
  "normalized",
  "rewritten",
  "qa_passed",
  "tts_done",
  "verified",
  "failed",
] as const;

/** Bản đồ dịch giai đoạn sang tiếng Việt */
export const VI_STAGES: Record<string, string> = {
  discovered: "Đã tìm thấy",
  downloaded: "Đã tải văn bản",
  normalized: "Đã chuẩn hóa",
  rewritten: "AI đã chuốt văn",
  qa_passed: "Đạt chuẩn chất lượng",
  tts_done: "Đã thu âm xong",
  verified: "Đã kiểm định",
  failed: "Gặp sự cố",
};

const VI_STAGE_NAMES: Record<string, string> = {
  extract: "Tải chương truyện",
  normalize: "Chuẩn hóa & làm sạch",
  rewrite: "Chuốt văn bản AI",
  tts: "Thu âm giọng đọc AI",
  package: "Đóng gói sách nói M4B",
};

const VI_ARTIFACT_NAMES: Record<string, string> = {
  source_html: "HTML nguồn",
  chapter_text: "Văn bản chương gốc",
  normalized_text: "Văn bản chuẩn hóa",
  rewritten_text: "Văn bản đã chuốt AI",
  chapter_audio: "Audio chương (mp3/wav)",
  m4b: "Audiobook M4B",
  mp4: "Video MP4",
  thumbnail: "Ảnh bìa thumbnail",
  description: "Mô tả sách",
};

export const VI_EVENT_TYPES: Record<
  string,
  { label: string; icon: LucideIcon; level: "info" | "progress" | "warning" | "error" | "success" }
> = {
  stage_started: { label: "GIAI ĐOẠN", icon: Rocket, level: "info" },
  progress: { label: "TIẾN ĐỘ", icon: Zap, level: "progress" },
  chapter_status: { label: "CHƯƠNG", icon: FileText, level: "info" },
  artifact_ready: { label: "XUẤT FILE", icon: HardDriveDownload, level: "success" },
  quota_wait: { label: "HẠN MỨC AI", icon: AlertTriangle, level: "warning" },
  needs_review: { label: "CẦN DUYỆT", icon: AlertOctagon, level: "warning" },
  error: { label: "CẢNH BÁO", icon: AlertOctagon, level: "error" },
  final: { label: "KẾT QUẢ", icon: CheckCircle2, level: "success" },
};

const EVENT_FEED_LIMIT = 100;

function stageCounts(items: ChapterRow[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const c of items) counts.set(c.stageState, (counts.get(c.stageState) ?? 0) + 1);
  return STAGE_ORDER.filter((s) => counts.has(s)).map((s) => [s, counts.get(s) ?? 0]);
}

function formatEventTime(isoString?: string): string {
  if (!isoString) return new Date().toLocaleTimeString("vi-VN", { hour12: false });
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return new Date().toLocaleTimeString("vi-VN", { hour12: false });
    return d.toLocaleTimeString("vi-VN", { hour12: false });
  } catch {
    return new Date().toLocaleTimeString("vi-VN", { hour12: false });
  }
}

function formatEventText(ev: JobEvent): string {
  if (ev.type === "stage_started") {
    const stage = (ev.stage as string) || "";
    return `Bắt đầu bước: ${VI_STAGE_NAMES[stage] || stage}`;
  }
  if (ev.type === "progress") {
    const stage = (ev.stage as string) || "";
    const done = typeof ev.done === "number" ? ev.done : 0;
    const total = typeof ev.total === "number" ? ev.total : 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const stageName = VI_STAGE_NAMES[stage] || stage;
    return `${stageName}: đã xử lý ${done}/${total} (${pct}%)`;
  }
  if (ev.type === "chapter_status") {
    const chapterNo = ev.chapter_no ?? ev.chapter_index ?? "?";
    const state = (ev.state as string) || "";
    const stateName = VI_STAGES[state] || state;
    return `Chương ${chapterNo}: chuyển sang trạng thái "${stateName}" (${state})`;
  }
  if (ev.type === "artifact_ready") {
    const kind = (ev.kind as string) || "";
    const kindName = VI_ARTIFACT_NAMES[kind] || kind;
    const path = ev.path ? ` (${ev.path})` : "";
    return `Đã xuất file thành công: ${kindName}${path}`;
  }
  if (ev.type === "quota_wait") {
    const backend = (ev.backend as string) || "AI Provider";
    const notBefore = ev.not_before
      ? `Tự động thử lại lúc: ${new Date(ev.not_before as string).toLocaleTimeString("vi-VN")}`
      : "Đang chờ hồi hạn mức...";
    return `Model AI (${backend}) đạt giới hạn lượt gọi (Rate Limit / Quota). ${notBefore}`;
  }
  if (ev.type === "needs_review") {
    const chapterNo = ev.chapter_no ?? "?";
    const reason = (ev.reason as string) || (ev.message as string) || "Cần duyệt chất lượng";
    return `Chương ${chapterNo} cần kiểm tra: ${reason}`;
  }
  if (ev.type === "error") {
    return ev.message || (ev.summary as string) || "Gặp lỗi trong quá trình xử lý";
  }
  if (ev.type === "final") {
    const summary = ev.summary || ev.message;
    const status = ev.status as string;
    if (status === "success") return summary ? `Hoàn tất: ${summary}` : "Toàn bộ giai đoạn đã hoàn tất thành công!";
    if (status === "quota_wait") return `Tạm dừng chờ quota AI: ${summary || "Đạt giới hạn gọi API"}`;
    if (status === "needs_review") return `Cần duyệt lại trước khi tiếp tục: ${summary || ""}`;
    return summary ? `Kết thúc: ${summary}` : `Kết thúc với trạng thái: ${status}`;
  }
  return ev.message || ev.summary || `${ev.type}`;
}

export function JobProgress({
  jobId,
  onPlayAudioTrack,
}: {
  jobId: string;
  onPlayAudioTrack?: (track: { title: string; subTitle?: string; url: string; coverLabel?: string }) => void;
}) {
  const [job, setJob] = useState<JobRow | null>(null);
  const [chapters, setChapters] = useState<{ total: number; items: ChapterRow[] } | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState("");
  const streamRef = useRef<StreamHandle | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Live Terminal state
  const [autoScroll, setAutoScroll] = useState(true);
  const [isConsoleExpanded, setIsConsoleExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string>("");
  const [reviewDrawerOpen, setReviewDrawerOpen] = useState<boolean>(false);
  const [reviewChapterIdx, setReviewChapterIdx] = useState<number>(1);
  const consoleBodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let stale = false;
    let lastSeq = -1;
    setJob(null);
    setChapters(null);
    setEvents([]);
    setError("");

    const debounceRef = { timer: 0 as unknown as ReturnType<typeof setTimeout> | undefined };
    const refresh = async (): Promise<void> => {
      try {
        const [j, c] = await Promise.all([fetchJob(jobId), fetchChapters(jobId, 200)]);
        if (!stale) {
          setJob(j);
          setChapters(c);
        }
        setError("");
      } catch (err) {
        if (!stale) setError((err as Error).message);
      }
    };
    const scheduleRefresh = (): void => {
      if (debounceRef.timer) clearTimeout(debounceRef.timer);
      debounceRef.timer = setTimeout(() => {
        void refresh();
      }, 300);
    };

    (async () => {
      try {
        const [j, c] = await Promise.all([fetchJob(jobId), fetchChapters(jobId, 200)]);
        if (stale) return;
        setJob(j);
        setChapters(c);
        // bootstrap: history event ĐÃ NẰM TRONG DB (after=-1) → tail limit; stream sau lastSeq
        const evs = await fetchEventsAfter(jobId, -1);
        if (stale) return;
        const rows = evs.events.slice(-EVENT_FEED_LIMIT);
        setEvents(rows);
        lastSeq = rows.length > 0 ? Math.max(...rows.map((r) => r.seq)) : -1;
        // stream live từ sau lastSeq; onopen bắn cả khi RECONNECT → refresh bù gap
        streamRef.current = openEventStream(
          `/api/jobs/${encodeURIComponent(jobId)}/events?after=${lastSeq}`,
          {
            onEvent: (ev) => {
              setEvents((prev) => [...prev, ev].slice(-EVENT_FEED_LIMIT));
              scheduleRefresh();
            },
            onConnected: scheduleRefresh,
          },
        );
      } catch (err) {
        if (!stale) setError((err as Error).message);
      }
    })();

    return () => {
      stale = true;
      if (debounceRef.timer) clearTimeout(debounceRef.timer);
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [jobId, reloadKey]);

  // Auto-scroll terminal when new events arrive
  useEffect(() => {
    if (autoScroll && consoleBodyRef.current) {
      consoleBodyRef.current.scrollTop = consoleBodyRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  if (error) return <p role="alert">{error}</p>;
  if (!job || !chapters) return <p style={{ color: "var(--ink-muted)", fontSize: 13 }}>Đang tải tiến độ…</p>;

  const counts = stageCounts(chapters.items);
  const doneCount = chapters.items.filter(
    (c) => c.stageState === "verified" || c.stageState === "tts_done",
  ).length;
  const percent = chapters.total > 0 ? Math.round((doneCount / chapters.total) * 100) : 0;

  // Tính toán Active Task Banner
  const computeActiveTask = (): {
    type: string;
    icon: string;
    title: string;
    detail: string;
    percent?: number;
  } => {
    if (job.state === "waiting_quota") {
      const waitTime = job.notBefore
        ? `Tự động tiếp tục lúc: ${new Date(job.notBefore).toLocaleTimeString("vi-VN")}`
        : "Đang chờ đến lượt hạn ngạch tiếp theo...";
      return {
        type: "waiting_quota",
        icon: <Clock size={20} className="text-amber-500 shrink-0" />,
        title: "Tạm dừng đợi hồi hạn ngạch AI (Rate Limit)",
        detail: `Nhà cung cấp AI báo vượt quá quota miễn phí. Hệ thống sẽ tự động gửi lại yêu cầu khi hết thời gian đợi. ${waitTime}`,
      };
    }
    if (job.state === "needs_review") {
      return {
        type: "needs_review",
        icon: <AlertTriangle size={20} className="text-amber-500 shrink-0" />,
        title: "Có chương cần bạn duyệt chất lượng",
        detail: "Hệ thống phát hiện đoạn văn bản cần người kiểm tra trước khi chuyển sang bước thu âm audio.",
      };
    }
    if (job.state === "failed") {
      return {
        type: "failed",
        icon: <AlertOctagon size={20} className="text-rose-500 shrink-0" />,
        title: "Quá trình chuyển thể gặp sự cố",
        detail: job.lastError || "Vui lòng xem log bên dưới hoặc bấm nút 'Thử lại' để tiếp tục.",
      };
    }
    if (job.state === "completed") {
      return {
        type: "completed",
        icon: <CheckCircle2 size={20} className="text-emerald-500 shrink-0" />,
        title: "Toàn bộ sách nói đã hoàn thành xuất sắc!",
        detail: "Tất cả các chương đã được chuốt văn, thu âm TTS và đóng gói thành phẩm hoàn chỉnh.",
      };
    }
    if (job.state === "queued") {
      return {
        type: "queued",
        icon: <Clock size={20} className="text-slate-400 shrink-0" />,
        title: "Đang trong hàng đợi hệ thống",
        detail: "Đang chuẩn bị điều phối worker để khởi chạy tiến trình.",
      };
    }

    // job.state === "running"
    // Tìm sự kiện có ích gần nhất từ cuối lên
    const lastProgress = [...events].reverse().find((e) => e.type === "progress");
    const lastEvent = events[events.length - 1];

    if (lastProgress) {
      const stage = (lastProgress.stage as string) || "";
      const stageName = VI_STAGE_NAMES[stage] || stage;
      const done = typeof lastProgress.done === "number" ? lastProgress.done : 0;
      const total = typeof lastProgress.total === "number" ? lastProgress.total : 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      let stageIcon = <Zap size={20} className="text-amber-500 shrink-0" />;
      if (stage === "rewrite") stageIcon = <Bot size={20} className="text-blue-500 shrink-0" />;
      else if (stage === "tts") stageIcon = <Mic size={20} className="text-purple-500 shrink-0" />;
      else if (stage === "package") stageIcon = <Package size={20} className="text-emerald-500 shrink-0" />;

      return {
        type: "running",
        icon: stageIcon,
        title: `Đang thực hiện: ${stageName}`,
        detail: `Đã hoàn thành ${done}/${total} phần (${pct}%) · Hệ thống đang tiếp tục xử lý các phần tiếp theo...`,
        percent: pct,
      };
    }

    if (lastEvent) {
      return {
        type: "running",
        icon: <Settings size={20} className="text-blue-500 shrink-0" />,
        title: "Đang xử lý pipeline chuyển thể",
        detail: formatEventText(lastEvent),
      };
    }

    return {
      type: "running",
      icon: <Zap size={20} className="text-amber-500 shrink-0" />,
      title: "Dây chuyền đang chạy",
      detail: "Đang kết nối worker và điều phối các tác vụ chuyển thể...",
    };
  };

  const activeTask = computeActiveTask();

  const handleCopyLogs = () => {
    if (events.length === 0) return;
    const lines = events
      .map((ev) => {
        const time = formatEventTime(ev.createdAt);
        const meta = VI_EVENT_TYPES[ev.type] || { label: ev.type.toUpperCase() };
        const text = formatEventText(ev);
        return `[${time}] [${meta.label}] #${ev.seq} ${text}`;
      })
      .join("\n");
    navigator.clipboard
      .writeText(lines)
      .then(() => {
        setCopyStatus("Đã sao chép!");
        setTimeout(() => setCopyStatus(""), 2000);
      })
      .catch(() => {
        setCopyStatus("Lỗi chép");
        setTimeout(() => setCopyStatus(""), 2000);
      });
  };

  return (
    <section aria-label="Tiến độ job" className="card-modern" style={{ padding: "20px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: 0 }}>
          Tiến độ: {extractStoryTitle(job.sourceUrl)}
        </h3>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--primary)" }}>
          {percent}% Hoàn tất
        </span>
      </div>

      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 10px" }}>
        Trạng thái: {VI_JOB_STATES[job.state] || job.state} ({job.state}) · chương: {chapters.items.length}/{chapters.total}
      </p>

      {/* CÂY TIẾN TRÌNH RÀNG BUỘC (4 GIAI ĐOẠN LIÊN KẾT BẰNG ĐƯỜNG LINE) */}
      <div style={{ margin: "14px 0 16px", padding: "14px 16px", background: "#f8fafc", borderRadius: 12, border: "1px solid #e2e8f0" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--primary)", textTransform: "uppercase", marginBottom: 10, letterSpacing: "0.5px" }}>
          Dây chuyền chuyển thể theo thời gian thực:
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, overflowX: "auto" }}>
          {/* Cột mốc 1 */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
            <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--primary)", color: "white", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700 }}>1</span>
            <span style={{ fontWeight: 600, color: "#0f172a" }}>Tải chương</span>
          </div>
          <div style={{ flex: 1, height: 2, background: "var(--primary)", minWidth: 16 }} />

          {/* Cột mốc 2 */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
            <span style={{ width: 22, height: 22, borderRadius: "50%", background: chapters.items.some(c => c.stageState === "rewritten" || c.stageState === "qa_passed" || c.stageState === "tts_done") ? "var(--primary)" : "#ffffff", color: chapters.items.some(c => c.stageState === "rewritten" || c.stageState === "qa_passed" || c.stageState === "tts_done") ? "white" : "#94a3b8", border: chapters.items.some(c => c.stageState === "rewritten" || c.stageState === "qa_passed" || c.stageState === "tts_done") ? "none" : "1.5px solid #cbd5e1", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700 }}>2</span>
            <span style={{ fontWeight: 600, color: "#0f172a" }}>Chuốt văn AI</span>
          </div>
          <div style={{ flex: 1, height: 2, background: chapters.items.some(c => c.stageState === "rewritten" || c.stageState === "qa_passed" || c.stageState === "tts_done") ? "var(--primary)" : "#e2e8f0", minWidth: 16 }} />

          {/* Cột mốc 3 */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
            <span style={{ width: 22, height: 22, borderRadius: "50%", background: chapters.items.some(c => c.stageState === "tts_done" || c.stageState === "verified") ? "var(--primary)" : "#ffffff", color: chapters.items.some(c => c.stageState === "tts_done" || c.stageState === "verified") ? "white" : "#94a3b8", border: chapters.items.some(c => c.stageState === "tts_done" || c.stageState === "verified") ? "none" : "1.5px solid #cbd5e1", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700 }}>3</span>
            <span style={{ fontWeight: 600, color: "#0f172a" }}>Thu âm TTS</span>
          </div>
          <div style={{ flex: 1, height: 2, background: chapters.items.some(c => c.stageState === "tts_done" || c.stageState === "verified") ? "var(--primary)" : "#e2e8f0", minWidth: 16 }} />

          {/* Cột mốc 4 */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
            <span style={{ width: 22, height: 22, borderRadius: "50%", background: percent === 100 ? "var(--primary)" : "#ffffff", color: percent === 100 ? "white" : "#94a3b8", border: percent === 100 ? "none" : "1.5px solid #cbd5e1", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700 }}>4</span>
            <span style={{ fontWeight: 600, color: "#0f172a" }}>Đóng gói M4B</span>
          </div>
        </div>

        {/* Thanh % chạy */}
        <div style={{ width: "100%", height: 6, borderRadius: 6, background: "#e2e8f0", overflow: "hidden", marginTop: 12 }}>
          <div style={{ width: `${percent}%`, height: "100%", background: "var(--primary)", transition: "width 0.4s ease" }}></div>
        </div>
      </div>

      {/* ACTIVE TASK BANNER: CÔNG VIỆC HIỆN TẠI ĐANG THỰC HIỆN */}
      <div className={`active-task-banner ${activeTask.type}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
          <span style={{ display: "inline-flex", alignItems: "center" }}>{activeTask.icon}</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              {activeTask.title}
            </div>
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>
              {activeTask.detail}
            </div>
          </div>
        </div>
      </div>

      {/* LIVE TERMINAL CONSOLE (NHẬT KÝ THỰC THI THỜI GIAN THỰC) */}
      <div className="live-terminal">
        <div className="live-terminal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span className="terminal-pulse-dot" title="SSE Stream đang kết nối trực tiếp" />
            <span style={{ color: "#f8fafc", fontWeight: 700, fontSize: 12, letterSpacing: "0.5px" }}>
              LIVE EXECUTION CONSOLE
            </span>
            <span style={{ color: "#64748b", fontSize: 11, fontFamily: "monospace" }}>
              ({events.length} sự kiện)
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              className={`live-terminal-btn ${autoScroll ? "active" : ""}`}
              onClick={() => setAutoScroll((prev) => !prev)}
              title={autoScroll ? "Bấm để tắt tự động cuộn" : "Bấm để bật tự động cuộn"}
            >
              <ArrowDownToLine size={13} style={{ marginRight: 4 }} />
              <span>{autoScroll ? "Cuộn: BẬT" : "Cuộn: TẮT"}</span>
            </button>
            <button
              type="button"
              className="live-terminal-btn"
              onClick={handleCopyLogs}
              title="Sao chép toàn bộ log ra clipboard"
            >
              <Copy size={13} style={{ marginRight: 4 }} />
              <span>{copyStatus || "Sao chép"}</span>
            </button>
            <button
              type="button"
              className="live-terminal-btn"
              onClick={() => setIsConsoleExpanded((prev) => !prev)}
              title={isConsoleExpanded ? "Thu gọn console" : "Mở rộng console"}
            >
              {isConsoleExpanded ? (
                <Minimize2 size={13} style={{ marginRight: 4 }} />
              ) : (
                <Maximize2 size={13} style={{ marginRight: 4 }} />
              )}
              <span>{isConsoleExpanded ? "Thu nhỏ" : "Mở rộng"}</span>
            </button>
          </div>
        </div>

        <div
          ref={consoleBodyRef}
          className="live-terminal-body"
          style={{ maxHeight: isConsoleExpanded ? 380 : 190 }}
        >
          {events.length === 0 ? (
            <div style={{ color: "#64748b", fontStyle: "italic", padding: "12px 0", textAlign: "center" }}>
              Đang đợi tín hiệu sự kiện từ máy chủ…
            </div>
          ) : (
            events.map((ev) => {
              const meta = VI_EVENT_TYPES[ev.type] || {
                label: ev.type.toUpperCase(),
                icon: Info,
                level: "info" as const,
              };
              const timeStr = formatEventTime(ev.createdAt);
              const text = formatEventText(ev);

              let badgeBg = "#1e293b";
              let badgeColor = "#94a3b8";
              let textColor = "#cbd5e1";

              if (meta.level === "progress") {
                badgeBg = "rgba(14, 165, 233, 0.25)";
                badgeColor = "#38bdf8";
                textColor = "#e0f2fe";
              } else if (meta.level === "success") {
                badgeBg = "rgba(34, 197, 94, 0.25)";
                badgeColor = "#4ade80";
                textColor = "#dcfce7";
              } else if (meta.level === "warning") {
                badgeBg = "rgba(234, 179, 8, 0.25)";
                badgeColor = "#facc15";
                textColor = "#fef08a";
              } else if (meta.level === "error") {
                badgeBg = "rgba(239, 68, 68, 0.25)";
                badgeColor = "#f87171";
                textColor = "#fecaca";
              }

              return (
                <div key={ev.seq} className="live-log-row">
                  <span className="live-log-time">[{timeStr}]</span>
                  <span className="live-log-seq">#{ev.seq}</span>
                  <span
                    className="live-log-badge"
                    style={{ background: badgeBg, color: badgeColor, display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    <meta.icon size={11} strokeWidth={2.2} />
                    <span>{meta.label}</span>
                  </span>
                  <span className="live-log-text" style={{ color: textColor }}>
                    {text}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Dòng tóm tắt giai đoạn (giữ nguyên token chính xác cho test) */}
      <p style={{ fontSize: 11, color: "var(--ink-muted)", margin: "8px 0", wordBreak: "break-word" }}>
        {counts.map(([stage, count]) => (
          <span key={stage} data-stage={stage} style={{ marginRight: 6 }}>
            {stage}: {count} ·{" "}
          </span>
        ))}
      </p>

      {(() => {
        const pending = chapters.items
          .filter((c) => c.reviewState === "needs_review")
          .map((c) => c.index);

        if (pending.length === 0 && job.state !== "needs_review") return null;

        return (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25 }}
            className="studio-qa-banner qa-action-banner"
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: "var(--amber-subtle)",
                  color: "var(--amber-text)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <AlertTriangle size={22} strokeWidth={2} />
              </div>
              <div>
                <p role="status" className="studio-qa-banner-title" style={{ margin: 0 }}>
                  Chương chờ duyệt: {pending.length > 0 ? pending.join(", ") : "Cần kiểm định chất lượng"}
                </p>
                <div className="studio-qa-banner-sub">
                  Phát hiện phân đoạn cần kiểm tra trước khi chuyển sang thu âm TTS. Bấm &quot;Soi lỗi &amp; Sửa&quot; để xem từng câu bị cảnh báo và duyệt tại chỗ.
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                type="button"
                onClick={() => {
                  if (pending.length > 0) setReviewChapterIdx(pending[0]);
                  setReviewDrawerOpen(true);
                }}
                className="studio-btn-warning"
              >
                <Eye size={15} />
                <span>Soi lỗi &amp; Sửa nội dung</span>
              </button>
            </div>
          </motion.div>
        );
      })()}

      {/* Nút điều khiển */}
      <JobControls job={job} onRefresh={() => setReloadKey((k) => k + 1)} />

      {/* Bảng chi tiết từng chương */}
      <div style={{ overflowX: "auto", marginTop: 14 }}>
        <table>
          <caption>Từng chương</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Chương</th>
              <th scope="col">Giai đoạn</th>
              <th scope="col">Review</th>
              <th scope="col">Audio</th>
            </tr>
          </thead>
          <tbody>
            {chapters.items.map((c) => {
              const isNeedsReview = c.reviewState === "needs_review";
              const stageLabel = VI_STAGES[c.stageState] || c.stageState;
              return (
                <tr
                  key={c.index}
                  style={{
                    background: isNeedsReview ? "rgba(255, 237, 213, 0.4)" : undefined,
                  }}
                >
                  <td style={{ color: "var(--ink-subtle)", width: 40, fontFamily: "monospace" }}>
                    {c.index}
                  </td>
                  <td style={{ fontWeight: 600 }}>{c.title}</td>
                  <td>
                    <span className={`tag tag-${c.stageState}`} title={c.stageState}>
                      {stageLabel} ({c.stageState})
                    </span>
                  </td>
                  <td style={{ color: isNeedsReview ? "var(--amber)" : "var(--ink-subtle)", fontWeight: isNeedsReview ? 700 : 400 }}>
                    {isNeedsReview ? (
                      <button
                        type="button"
                        onClick={() => {
                          setReviewChapterIdx(c.index);
                          setReviewDrawerOpen(true);
                        }}
                        className="studio-badge studio-badge-warning"
                        style={{ cursor: "pointer", border: "none" }}
                        title="Bấm để mở ngăn kéo soi lỗi chương này"
                      >
                        <AlertTriangle size={11} />
                        <span>Cần duyệt ({c.reviewState})</span>
                      </button>
                    ) : (
                      c.reviewState
                    )}
                  </td>
                  <td>
                    {c.audioAssetId ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--primary)", background: "var(--primary-light)", padding: "2px 6px", borderRadius: 4 }}>có</span>
                        <button
                          type="button"
                          onClick={() => {
                            if (onPlayAudioTrack) {
                              onPlayAudioTrack({
                                title: `Chương ${c.index}: ${c.title || `Chương ${c.index}`}`,
                                subTitle: job ? extractStoryTitle(job.sourceUrl) : "Sách nói tiếng Việt",
                                url: `/api/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(c.audioAssetId!)}/download`,
                                coverLabel: job ? extractStoryTitle(job.sourceUrl) : "STORY AUDIO",
                              });
                            }
                          }}
                          className="studio-btn-primary"
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            padding: "4px 10px",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <Play size={12} strokeWidth={2} />
                          <span>Nghe</span>
                        </button>
                        <a
                          href={`/api/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(c.audioAssetId!)}/download?download=1`}
                          download
                          style={{
                            fontSize: 11, fontWeight: 600, padding: "4px 10px",
                            background: "var(--jade)", color: "#fff", borderRadius: 6,
                            textDecoration: "none", display: "inline-flex",
                            alignItems: "center", gap: 4,
                          }}
                        >
                          <Download size={12} strokeWidth={2} />
                          <span>MP3</span>
                        </a>
                      </div>
                    ) : (
                      <span style={{ color: "var(--ink-subtle)" }}>chưa</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Slide-over QA Review Drawer */}
      <SlideOverReviewDrawer
        isOpen={reviewDrawerOpen}
        onClose={() => setReviewDrawerOpen(false)}
        jobId={jobId}
        chapterIndex={reviewChapterIdx}
        chapters={chapters.items}
        onSelectChapterIndex={(idx) => setReviewChapterIdx(idx)}
        onApproveAndResume={async () => {
          await postJobAction(jobId, "resume");
          setReloadKey((k) => k + 1);
        }}
      />
    </section>
  );
}
