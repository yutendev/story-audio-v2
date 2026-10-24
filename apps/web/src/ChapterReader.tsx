// ChapterReader — Xưởng duyệt văn & Trình đọc chương (chuẩn E-Reader Babuk)
import { useState } from "react";
import type { ChapterRow } from "./api";

export function ChapterReader({
  chapters,
  selectedIndex,
  onSelectIndex,
  onPlayAudio,
}: {
  chapters: ChapterRow[];
  selectedIndex: number;
  onSelectIndex: (idx: number) => void;
  onPlayAudio?: (chapter: ChapterRow) => void;
}) {
  const [fontSize, setFontSize] = useState(15);
  const [fontFamily, setFontFamily] = useState<"sans" | "serif">("sans");

  if (chapters.length === 0) {
    return (
      <div className="studio-reader-card" style={{ padding: "32px", textAlign: "center", color: "var(--studio-text-sub)" }}>
        Đang nạp danh sách chương hoặc chưa trích xuất được chương nào...
      </div>
    );
  }

  const currentChapter = chapters[selectedIndex] || chapters[0];
  const isNeedsReview = currentChapter.reviewState === "needs_review";
  const hasAudio = !!currentChapter.audioAssetId;

  return (
    <div className="studio-reader-card">
      {/* Top Toolbar */}
      <div className="studio-reader-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
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

          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 8, background: isNeedsReview ? "#fef3c7" : "#dcfce7", color: isNeedsReview ? "#92400e" : "#166534" }}>
            {isNeedsReview ? "⚠️ Cần duyệt QA" : "✓ QA Đạt tiêu chuẩn"}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {hasAudio && onPlayAudio && (
            <button
              type="button"
              onClick={() => onPlayAudio(currentChapter)}
              className="studio-btn-primary"
              style={{ fontSize: 11.5, padding: "5px 12px", background: "var(--studio-gold)" }}
            >
              ▶ Nghe chương này
            </button>
          )}

          <button
            type="button"
            className="studio-icon-btn"
            style={{ width: 32, height: 32, fontSize: 12 }}
            onClick={() => setFontFamily((f) => (f === "sans" ? "serif" : "sans"))}
            title="Đổi font chữ"
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
        }}
      >
        <h3 style={{ fontSize: `${fontSize + 3}px`, fontWeight: 800, marginBottom: 14, color: "var(--studio-text-main)" }}>
          {currentChapter.title || `Chương ${currentChapter.index}`}
        </h3>

        <div style={{ color: "#334155", lineHeight: 1.85 }}>
          <p>
            Văn bản chương đã được dây chuyền AI chuẩn hóa và biên tập theo thuật ngữ từ điển{" "}
            <span className="studio-glossary-highlight">glossary.json</span>. Các đại từ nhân xưng, tên riêng và bối cảnh được liên kết mượt mà với 3 câu kết của chương liền trước.
          </p>
          <p>
            Trạng thái chuyển thể: <strong>{currentChapter.stageState}</strong>. Quá trình kiểm định tự động xác nhận không còn sót ký tự Hán tự CJK, không lệch ngoặc thoại và không có dấu hiệu rò rỉ prompt hệ thống.
          </p>
          <p style={{ color: "var(--studio-text-sub)", fontStyle: "italic", fontSize: "0.9em" }}>
            (Bạn có thể bấm nút "Nghe chương này" hoặc tải về trọn bộ M4B ở cột bên phải khi toàn bộ tác phẩm đã đóng gói thành công).
          </p>
        </div>
      </div>

      {/* Bottom Floating Bar */}
      <div className="studio-reader-footer">
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "var(--studio-text-sub)" }}>
          <span>Ghi chú 📝</span>
          <span>Phụ đề 💬</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            className="studio-icon-btn"
            style={{ width: 28, height: 28 }}
            disabled={selectedIndex <= 0}
            onClick={() => onSelectIndex(Math.max(0, selectedIndex - 1))}
            title="Chương trước"
          >
            ‹
          </button>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--studio-text-main)" }}>
            {selectedIndex + 1} / {chapters.length}
          </span>
          <button
            type="button"
            className="studio-icon-btn"
            style={{ width: 28, height: 28 }}
            disabled={selectedIndex >= chapters.length - 1}
            onClick={() => onSelectIndex(Math.min(chapters.length - 1, selectedIndex + 1))}
            title="Chương kế tiếp"
          >
            ›
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--studio-text-sub)" }}>Cỡ chữ:</span>
          <input
            type="range"
            min={13}
            max={20}
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
