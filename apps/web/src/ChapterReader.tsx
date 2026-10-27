// ChapterReader — Xưởng duyệt văn & Trình đọc chương (chuẩn E-Reader Babuk & QA Review)
import { useState, useEffect } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Zap,
  Sparkles,
  FileText,
  Play,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { fetchChapterContent } from "./api";
import type { ChapterRow, ChapterContentResponse, ChapterChunkMeta } from "./api";

export function ChapterReader({
  jobId,
  chapters,
  selectedIndex,
  onSelectIndex,
  onPlayAudio,
}: {
  jobId?: string;
  chapters: ChapterRow[];
  selectedIndex: number;
  onSelectIndex: (idx: number) => void;
  onPlayAudio?: (chapter: ChapterRow) => void;
}) {
  const [fontSize, setFontSize] = useState(16);
  const [fontFamily, setFontFamily] = useState<"sans" | "serif">("sans");
  const [content, setContent] = useState<ChapterContentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentChapter = chapters[selectedIndex] || chapters[0];

  useEffect(() => {
    if (!jobId || !currentChapter) {
      setContent(null);
      return;
    }
    let unmounted = false;
    setLoading(true);
    setError(null);

    fetchChapterContent(jobId, currentChapter.index)
      .then((res) => {
        if (!unmounted) {
          setContent(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!unmounted) {
          setError(err.message || "Không thể tải nội dung chương");
          setLoading(false);
        }
      });

    return () => {
      unmounted = true;
    };
  }, [jobId, currentChapter?.index]);

  if (chapters.length === 0) {
    return (
      <div className="studio-reader-card" style={{ padding: "40px 24px", textAlign: "center", color: "var(--studio-text-sub)" }}>
        Đang nạp danh sách chương hoặc chưa trích xuất được chương nào...
      </div>
    );
  }

  const isNeedsReview =
    currentChapter.reviewState === "needs_review" ||
    Boolean(content?.severityCounts?.semantic && content.severityCounts.semantic > 0);
  const hasAudio = !!currentChapter.audioAssetId;

  // Đếm số chunk cần duyệt trong chương
  const warningChunksCount =
    content?.chunks?.filter(
      (c) => c.tier === "fallback" || c.severity !== "ok" || (c.remaining_errors && c.remaining_errors.length > 0)
    ).length ?? 0;

  function scrollToFirstWarning() {
    const el = document.querySelector(".studio-chunk-review-highlight");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  return (
    <div className="studio-reader-card">
      {/* Top Toolbar */}
      <div className="studio-reader-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <select
            value={selectedIndex}
            onChange={(e) => onSelectIndex(Number(e.target.value))}
            style={{
              padding: "6px 12px",
              borderRadius: "10px",
              border: "1px solid var(--studio-border)",
              fontSize: 13,
              fontWeight: 700,
              background: "#fff",
              color: "var(--studio-text-main)",
              cursor: "pointer",
            }}
          >
            {chapters.map((c, i) => (
              <option key={c.id || i} value={i}>
                Chương {c.index}: {c.title || `Chương ${c.index}`}
              </option>
            ))}
          </select>

          <span className={`studio-badge ${isNeedsReview ? "studio-badge-warning" : "studio-badge-success"}`}>
            {isNeedsReview ? (
              <>
                <AlertTriangle size={13} className="shrink-0" />
                <span>{`Cần duyệt QA${warningChunksCount > 0 ? ` (${warningChunksCount} đoạn)` : ""}`}</span>
              </>
            ) : (
              <>
                <CheckCircle2 size={13} className="shrink-0" />
                <span>QA Đạt tiêu chuẩn</span>
              </>
            )}
          </span>

          {warningChunksCount > 0 && (
            <button
              type="button"
              onClick={scrollToFirstWarning}
              className="studio-badge-warning"
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                padding: "4px 10px",
                borderRadius: 8,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
              title="Cuộn tới đoạn đầu tiên cần kiểm định"
            >
              <span>Nhảy tới đoạn cảnh báo</span>
              <Zap size={12} />
            </button>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {hasAudio && onPlayAudio && (
            <button
              type="button"
              onClick={() => onPlayAudio(currentChapter)}
              className="studio-btn-primary"
              style={{ fontSize: 11.5, padding: "5px 12px", background: "var(--studio-gold)", display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              <Play size={12} />
              <span>Nghe chương này</span>
            </button>
          )}

          <button
            type="button"
            className="studio-icon-btn"
            style={{ width: 32, height: 32, fontSize: 12 }}
            onClick={() => setFontFamily((f) => (f === "sans" ? "serif" : "sans"))}
            title="Đổi font chữ (Sans / Serif)"
          >
            {fontFamily === "sans" ? "Aa" : "Tt"}
          </button>
        </div>
      </div>

      {/* Reader Body */}
      <div
        className="studio-reader-body"
        style={{
          fontSize: `${fontSize}px`,
          fontFamily: fontFamily === "serif" ? "Merriweather, Georgia, serif" : "inherit",
          lineHeight: 1.85,
        }}
      >
        <div style={{ marginBottom: 18, borderBottom: "1px solid #f1f5f9", paddingBottom: 12 }}>
          <h3
            style={{
              fontSize: `${fontSize + 4}px`,
              fontWeight: 800,
              marginBottom: 6,
              color: "var(--studio-text-main)",
            }}
          >
            {currentChapter.title || `Chương ${currentChapter.index}`}
          </h3>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--studio-text-sub)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              {content?.hasRewritten ? (
                <>
                  <Sparkles size={13} className="text-amber-500" />
                  <span>Bản chuốt văn AI mới nhất</span>
                </>
              ) : (
                <>
                  <FileText size={13} className="text-slate-400" />
                  <span>Bản văn bản nguồn</span>
                </>
              )}
            </span>
            {content?.chunks && content.chunks.length > 0 && (
              <span>· {content.chunks.length} phân đoạn</span>
            )}
            {warningChunksCount > 0 && (
              <span style={{ color: "#b45309", fontWeight: 700 }}>
                · {warningChunksCount} phân đoạn in đậm cần lưu ý
              </span>
            )}
          </div>
        </div>

        {loading && (
          <div className="studio-reader-skeleton">
            <div className="studio-skeleton-line" style={{ width: "90%" }} />
            <div className="studio-skeleton-line" style={{ width: "100%" }} />
            <div className="studio-skeleton-line" style={{ width: "95%" }} />
            <div className="studio-skeleton-line" style={{ width: "85%" }} />
            <div className="studio-skeleton-line" style={{ width: "92%" }} />
          </div>
        )}

        {error && !loading && (
          <div
            style={{
              padding: "20px",
              background: "var(--red-subtle)",
              border: "1px solid var(--red-border)",
              borderRadius: "12px",
              color: "var(--red-text)",
              fontSize: 13,
            }}
          >
            <p style={{ fontWeight: 700, marginBottom: 8 }}>Không thể nạp nội dung chương:</p>
            <p>{error}</p>
          </div>
        )}

        {!loading && !error && content?.text && (
          <div style={{ color: "var(--studio-text-main)" }}>
            {content.chunks && content.chunks.length > 0 ? (
              renderChunksWithHighlight(content.text, content.chunks)
            ) : (
              content.text.split("\n\n").map((para, i) => (
                <p key={i} style={{ marginBottom: 16 }}>
                  {para}
                </p>
              ))
            )}
          </div>
        )}

        {!loading && !error && !content?.text && (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--studio-text-sub)" }}>
            Chưa có nội dung văn bản cho chương này.
          </div>
        )}
      </div>

      {/* Bottom Floating Bar */}
      <div className="studio-reader-footer">
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "var(--studio-text-sub)" }}>
          <span>Trạng thái: <strong>{currentChapter.stageState}</strong></span>
          {warningChunksCount > 0 && (
            <span style={{ color: "var(--amber-text)", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>
              <AlertTriangle size={13} />
              <span>{warningChunksCount} đoạn in đậm cần duyệt</span>
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            className="studio-icon-btn"
            style={{ width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            disabled={selectedIndex <= 0}
            onClick={() => onSelectIndex(Math.max(0, selectedIndex - 1))}
            title="Chương trước"
          >
            <ChevronLeft size={14} />
          </button>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--studio-text-main)" }}>
            {selectedIndex + 1} / {chapters.length}
          </span>
          <button
            type="button"
            className="studio-icon-btn"
            style={{ width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            disabled={selectedIndex >= chapters.length - 1}
            onClick={() => onSelectIndex(Math.min(chapters.length - 1, selectedIndex + 1))}
            title="Chương kế tiếp"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--studio-text-sub)" }}>Cỡ chữ:</span>
          <input
            type="range"
            min={13}
            max={22}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            style={{ width: 70, cursor: "pointer" }}
          />
          <span style={{ fontSize: 11, fontWeight: 600 }}>{fontSize}px</span>
        </div>
      </div>
    </div>
  );
}

function renderChunksWithHighlight(text: string, chunks: ChapterChunkMeta[]) {
  const elements = [];
  const firstChunkStart = chunks[0]?.char_start ?? 0;

  // Tiêu đề hoặc mở đầu trước chunk 0
  if (firstChunkStart > 0) {
    const preText = text.slice(0, firstChunkStart).trim();
    if (preText) {
      elements.push(
        <div key="preamble" style={{ marginBottom: 16, fontStyle: "italic", color: "#64748b" }}>
          {preText}
        </div>
      );
    }
  }

  for (const chunk of chunks) {
    const hasCharBounds = typeof chunk.char_start === "number" && typeof chunk.char_end === "number";
    const chunkText = hasCharBounds
      ? text.slice(chunk.char_start, chunk.char_end).trim()
      : "";

    if (!chunkText) continue;

    const isWarning =
      chunk.tier === "fallback" ||
      chunk.severity !== "ok" ||
      (chunk.remaining_errors && chunk.remaining_errors.length > 0);

    if (isWarning) {
      elements.push(
        <div key={`chunk-${chunk.index}`} className="studio-chunk-review-highlight">
          <div className="studio-review-badge">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <AlertTriangle size={12} />
              <span>ĐOẠN CẦN DUYỆT (Mức: {chunk.severity.toUpperCase()})</span>
            </span>
            {chunk.remaining_errors?.map((err, ei) => (
              <span key={ei} className="studio-review-tag">
                {err}
              </span>
            ))}
          </div>
          <div style={{ fontWeight: 700, color: "var(--studio-text-main)", whiteSpace: "pre-wrap" }}>
            {chunkText}
          </div>
        </div>
      );
    } else {
      // Chunk chuẩn: hiển thị đoạn văn thanh lịch bình thường
      elements.push(
        <p key={`chunk-${chunk.index}`} style={{ marginBottom: 16, whiteSpace: "pre-wrap" }}>
          {chunkText}
        </p>
      );
    }
  }

  return elements;
}
