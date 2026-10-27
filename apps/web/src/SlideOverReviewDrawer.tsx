// SlideOverReviewDrawer — Ngăn kéo soi lỗi & duyệt chất lượng QA (Zero-Context-Switching)
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  AlertTriangle,
  CheckCircle2,
  FileText,
  Edit3,
  Eye,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { fetchChapterContent } from "./api";
import type { ChapterRow, ChapterContentResponse, ChapterChunkMeta } from "./api";

export function SlideOverReviewDrawer({
  isOpen,
  onClose,
  jobId,
  chapterIndex,
  chapters,
  onSelectChapterIndex,
  onApproveAndResume,
}: {
  isOpen: boolean;
  onClose: () => void;
  jobId?: string;
  chapterIndex: number;
  chapters: ChapterRow[];
  onSelectChapterIndex: (idx: number) => void;
  onApproveAndResume: () => Promise<void>;
}) {
  const [content, setContent] = useState<ChapterContentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"visual" | "edit">("visual");
  const [editedText, setEditedText] = useState("");
  const [isApproving, setIsApproving] = useState(false);

  const reviewNeededChapters = chapters.filter((c) => c.reviewState === "needs_review");
  const currentChapter = chapters.find((c) => c.index === chapterIndex) || chapters[0];

  useEffect(() => {
    if (!isOpen || !jobId || !chapterIndex) return;

    let unmounted = false;
    setLoading(true);
    setError(null);

    fetchChapterContent(jobId, chapterIndex)
      .then((res) => {
        if (!unmounted) {
          setContent(res);
          setEditedText(res.text || "");
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!unmounted) {
          setError((err as Error).message);
          setLoading(false);
        }
      });

    return () => {
      unmounted = true;
    };
  }, [isOpen, jobId, chapterIndex]);

  async function handleApprove() {
    setIsApproving(true);
    try {
      await onApproveAndResume();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsApproving(false);
    }
  }

  // Đếm các chunk có lỗi hoặc warning
  const warningChunks = content?.chunks?.filter(
    (c) => c.tier === "fallback" || c.severity !== "ok" || (c.remaining_errors && c.remaining_errors.length > 0)
  ) || [];

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="studio-drawer-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
        >
          <motion.aside
            className="studio-slideover-drawer"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 280 }}
            onClick={(e) => e.stopPropagation()}
            aria-label="Xưởng soi lỗi và duyệt QA"
          >
        {/* Header Drawer */}
        <div className="studio-drawer-header">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span className="studio-drawer-badge-warning">
                <AlertTriangle size={13} className="shrink-0" />
                <span>SOAT LỖI & DUYỆT QA</span>
              </span>
              <span style={{ fontSize: 12, color: "var(--studio-text-sub)" }}>
                Chương {chapterIndex} / {chapters.length}
              </span>
            </div>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: "var(--studio-text-main)", margin: 0 }}>
              {currentChapter?.title || `Chương ${chapterIndex}`}
            </h3>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className="studio-icon-btn"
              onClick={onClose}
              title="Đóng ngăn kéo"
              style={{ width: 32, height: 32 }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Chuyển chương nhanh nếu có nhiều chương cần duyệt */}
        {reviewNeededChapters.length > 1 && (
          <div className="studio-drawer-chapter-selector">
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--studio-text-sub)" }}>
              Các chương cần duyệt ({reviewNeededChapters.length}):
            </span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              {reviewNeededChapters.map((c) => (
                <button
                  key={c.index}
                  type="button"
                  onClick={() => onSelectChapterIndex(c.index)}
                  className={`studio-drawer-chip ${c.index === chapterIndex ? "active" : ""}`}
                >
                  Chương {c.index}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Warning Summary bar */}
        <div className="studio-drawer-summary">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: "var(--amber-dark)" }}>
              <AlertTriangle size={15} />
              <span>
                {warningChunks.length > 0
                  ? `Phát hiện ${warningChunks.length} phân đoạn cần kiểm tra`
                  : "Chương này không có đoạn fallback nghiêm trọng"}
              </span>
            </div>
            <span style={{ fontSize: 11, color: "var(--amber-text)", fontWeight: 600 }}>
              {content?.hasRewritten ? "Bản AI Rewrite mới nhất" : "Bản văn bản nguồn"}
            </span>
          </div>

          {/* Các tags lỗi tổng hợp */}
          {warningChunks.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {Array.from(
                new Set(warningChunks.flatMap((c) => c.remaining_errors || []))
              ).map((err, i) => (
                <span key={i} className="studio-review-tag">
                  {err}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* View Switcher Tabs (Soi trực quan / Biên tập nhanh) */}
        <div className="studio-drawer-tabs">
          <button
            type="button"
            className={`studio-drawer-tab ${activeTab === "visual" ? "active" : ""}`}
            onClick={() => setActiveTab("visual")}
          >
            <Eye size={14} />
            <span>Soi trực quan ({warningChunks.length} đoạn)</span>
          </button>
          <button
            type="button"
            className={`studio-drawer-tab ${activeTab === "edit" ? "active" : ""}`}
            onClick={() => setActiveTab("edit")}
          >
            <Edit3 size={14} />
            <span>Xem văn bản thô & Sửa</span>
          </button>
        </div>

        {/* Body Container */}
        <div className="studio-drawer-body">
          {loading && (
            <div style={{ padding: "40px", textAlign: "center", color: "var(--studio-text-sub)" }}>
              <RefreshCw size={24} className="spin text-slate-400" style={{ margin: "0 auto 12px" }} />
              <div>Đang nạp phân đoạn và đối chiếu chất lượng…</div>
            </div>
          )}

          {error && (
            <div style={{ padding: "16px", background: "var(--red-subtle)", border: "1px solid var(--red-border)", borderRadius: 10, color: "var(--red-text)", fontSize: 12.5 }}>
              Lỗi nạp dữ liệu chương: {error}
            </div>
          )}

          {!loading && !error && activeTab === "visual" && (
            <div className="studio-drawer-visual-content">
              {content?.chunks && content.chunks.length > 0 ? (
                content.chunks.map((chunk, idx) => {
                  const chunkText = content.text?.slice(chunk.char_start, chunk.char_end) || "";
                  const isErr =
                    chunk.tier === "fallback" ||
                    chunk.severity !== "ok" ||
                    (chunk.remaining_errors && chunk.remaining_errors.length > 0);

                  if (isErr) {
                    return (
                      <div key={idx} className="studio-drawer-chunk-highlight">
                        <div className="studio-drawer-chunk-meta">
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--amber-text)", fontWeight: 700 }}>
                            <AlertTriangle size={12} />
                            <span>Đoạn #{chunk.index + 1} ({chunk.severity.toUpperCase()})</span>
                          </span>
                          <div style={{ display: "flex", gap: 4 }}>
                            {chunk.remaining_errors?.map((err, ei) => (
                              <span key={ei} className="studio-review-tag">
                                {err}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div style={{ fontSize: 14, lineHeight: 1.8, color: "var(--studio-text-main)", fontWeight: 600 }}>
                          {chunkText}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <p key={idx} style={{ fontSize: 13.5, lineHeight: 1.75, color: "var(--studio-text-sub)", marginBottom: 12 }}>
                      {chunkText}
                    </p>
                  );
                })
              ) : (
                <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.8, color: "var(--studio-text-main)" }}>
                  {content?.text || "Chưa có nội dung văn bản."}
                </div>
              )}
            </div>
          )}

          {!loading && !error && activeTab === "edit" && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ fontSize: 11.5, color: "var(--studio-text-sub)", marginBottom: 8 }}>
                Nội dung toàn văn bản chương (bạn có thể đọc lướt hoặc kiểm tra các câu):
              </div>
              <textarea
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                style={{
                  width: "100%",
                  flex: 1,
                  minHeight: "360px",
                  padding: "14px",
                  borderRadius: 10,
                  border: "1px solid var(--studio-border)",
                  fontFamily: "inherit",
                  fontSize: 13,
                  lineHeight: 1.7,
                  color: "var(--studio-text-main)",
                  resize: "vertical",
                  outline: "none",
                }}
              />
            </div>
          )}
        </div>

        {/* Footer Drawer */}
        <div className="studio-drawer-footer">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className="studio-btn-subtle"
              onClick={onClose}
              style={{ fontSize: 12.5, padding: "8px 16px" }}
            >
              Đóng
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              onClick={handleApprove}
              disabled={isApproving}
              className="studio-btn-primary"
              style={{
                fontSize: 13,
                fontWeight: 700,
                padding: "9px 20px",
                background: "var(--primary)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <CheckCircle2 size={16} />
              <span>{isApproving ? "Đang xác nhận…" : "Duyệt xong — Cho phép tiếp tục TTS"}</span>
            </button>
          </div>
        </div>
      </motion.aside>
    </motion.div>
  )}
</AnimatePresence>
  );
}
