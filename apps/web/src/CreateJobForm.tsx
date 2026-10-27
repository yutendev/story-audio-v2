import { useState, useEffect } from "react";
import type { FormEvent } from "react";
import {
  Check,
  Link2,
  Zap,
  Lightbulb,
  Bot,
  ShieldAlert,
  Settings,
  Globe,
  Rocket,
  RefreshCw,
  Cpu,
  AlertTriangle,
} from "lucide-react";
import { createJob } from "./api";
import type { ExportOptions } from "./api";

export const ADAPTERS = ["webnovel-vn", "truyendich-space"] as const;

export const CHAPTER_PRESETS = [10, 20, 30, 100] as const;

export const VOICE_PRESETS = [
  {
    id: "vi-VN-HoaiMyNeural",
    name: "Hoài My (Nữ miền Bắc)",
    badge: "Khuyên dùng",
    genre: "Tiên hiệp, Ngôn tình",
  },
  {
    id: "vi-VN-NamMinhNeural",
    name: "Nam Minh (Nam miền Bắc)",
    badge: "Trầm ấm",
    genre: "Kiếm hiệp, Lịch sử, Đô thị",
  },
  {
    id: "vi-VN-MaiNgocNeural",
    name: "Mai Ngọc (Nữ miền Nam)",
    badge: "Ngọt ngào",
    genre: "Tâm lý, Đời thường",
  },
] as const;

export const OPENROUTER_MODELS = [
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3",
    badge: "Khuyên dùng #1",
    desc: "Văn phong tiếng Việt mượt mà nhất, giàu cảm xúc, giá siêu rẻ (~0.14$/1M token).",
    isFree: false,
  },
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    name: "Nemotron 3.5 (Free)",
    badge: "Miễn phí 100%",
    desc: "Bản miễn phí hoạt động tức thì trên OpenRouter, tốc độ cao.",
    isFree: true,
  },
  {
    id: "google/gemma-4-31b-it:free",
    name: "Gemma 4 31B (Free)",
    badge: "Miễn phí 100%",
    desc: "Mô hình mã nguồn mở của Google trên OpenRouter.",
    isFree: true,
  },
  {
    id: "qwen/qwen-2.5-72b-instruct",
    name: "Qwen 2.5 72B",
    badge: "Chuyên Tiên Hiệp",
    desc: "Rất giỏi thuật ngữ Hán Việt, tông môn, công pháp kiếm hiệp.",
    isFree: false,
  },
  {
    id: "deepseek/deepseek-r1",
    name: "DeepSeek R1",
    badge: "Suy luận cao cấp",
    desc: "Mô hình suy luận sâu, bám sát nội dung gốc và thuật ngữ tuyệt đối.",
    isFree: false,
  },
] as const;

export const DEVKIT_MODELS = [
  {
    id: "deepseek-r1-550b",
    name: "DeepSeek R1 (550B)",
    badge: "Siêu mô hình",
    desc: "Mô hình suy luận lớn 550B qua cổng chuẩn OpenAI (https://agent.devkit.vn/v1).",
  },
] as const;

export const GEMINI_MODELS = [
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    badge: "Khuyên dùng",
    desc: "Cực nhanh, tiết kiệm hạn mức tối đa, tối ưu cho dịch & chuốt tiểu thuyết.",
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    badge: "Mới nhất",
    desc: "Mô hình thế hệ mới của Google, độ mượt văn bản cao.",
  },
  {
    id: "gemini-flash-lite-latest",
    name: "Gemini Flash Lite (Latest)",
    badge: "Tự cập nhật",
    desc: "Luôn tự động trỏ đến phiên bản Flash Lite mới nhất của Google.",
  },
] as const;

export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Tự động trích xuất mã nguồn truyện từ URL */
export function detectAdapterFromUrl(url: string): { slug: string; name: string; isOfficial: boolean } {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("webnovel.vn")) {
      return { slug: "webnovel-vn", name: "Webnovel VN (webnovel.vn)", isOfficial: true };
    }
    if (hostname.includes("truyendich.space")) {
      return { slug: "truyendich-space", name: "Truyện Dịch Space (truyendich.space)", isOfficial: true };
    }
    const clean = hostname.replace(/^(www\.)?/, "");
    const slug = clean.replace(/\./g, "-");
    return { slug, name: `${clean}`, isOfficial: false };
  } catch {
    return { slug: "webnovel-vn", name: "Webnovel VN (webnovel.vn)", isOfficial: true };
  }
}

interface Props {
  onCreated: (jobId: string) => void;
}

export function CreateJobForm({ onCreated }: Props) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [adapter, setAdapter] = useState<string>(ADAPTERS[0]);
  const [sourceInfo, setSourceInfo] = useState<{ slug: string; name: string; isOfficial: boolean } | null>(null);
  const [perBook, setPerBook] = useState(20);
  const [customPerBook, setCustomPerBook] = useState(false);
  const [exportOptions, setExportOptions] = useState<ExportOptions>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Cấu hình linh hoạt AI Provider & Models
  const [hasCustomAiConfig, setHasCustomAiConfig] = useState(false);
  const [aiProvider, setAiProvider] = useState<string>("openrouter");
  const [selectedOrModel, setSelectedOrModel] = useState<string>("deepseek/deepseek-chat");
  const [customOrModel, setCustomOrModel] = useState("");
  const [selectedGeminiModel, setSelectedGeminiModel] = useState<string>("gemini-3.5-flash-lite");
  const [selectedDkModel, setSelectedDkModel] = useState<string>("deepseek-r1-550b");
  const [customDkModel, setCustomDkModel] = useState("");
  const [openrouterApiKey, setOpenrouterApiKey] = useState(() => {
    try {
      return localStorage.getItem("story_audio_openrouter_api_key") || "";
    } catch {
      return "";
    }
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [devkitApiKey, setDevkitApiKey] = useState(() => {
    try {
      return localStorage.getItem("story_audio_devkit_api_key") || "";
    } catch {
      return "";
    }
  });
  const [showDkApiKey, setShowDkApiKey] = useState(false);

  // Tự động nhận diện nguồn khi dán hoặc gõ URL
  useEffect(() => {
    if (isHttpUrl(sourceUrl)) {
      const info = detectAdapterFromUrl(sourceUrl);
      setAdapter(info.slug);
      setSourceInfo(info);
    } else {
      setSourceInfo(null);
    }
  }, [sourceUrl]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!isHttpUrl(sourceUrl)) {
      setError("sourceUrl phải là http(s) URL hợp lệ");
      return;
    }
    if (!Number.isInteger(perBook) || perBook < 1 || perBook > 1000) {
      setError("chaptersPerBook phải nguyên trong [1..1000]");
      return;
    }

    const chosen: ExportOptions = {};
    const bookTitle = exportOptions.bookTitle?.trim();
    if (bookTitle) chosen.bookTitle = bookTitle;
    const ttsVoice = exportOptions.ttsVoice?.trim();
    if (ttsVoice) chosen.ttsVoice = ttsVoice;
    if (exportOptions.rewriteAi !== undefined) chosen.rewriteAi = exportOptions.rewriteAi;
    if (exportOptions.isAdultContent !== undefined) {
      chosen.isAdultContent = exportOptions.isAdultContent;
    }

    // Chỉ gán cấu hình nâng cao khi người dùng chủ động tương tác với phần AI settings
    if (exportOptions.rewriteAi && hasCustomAiConfig) {
      chosen.aiProvider = aiProvider;
      if (aiProvider.includes("devkit")) {
        chosen.aiModel = customDkModel.trim() || selectedDkModel;
        if (devkitApiKey.trim()) {
          chosen.devkitApiKey = devkitApiKey.trim();
        }
      } else if (aiProvider.includes("openrouter")) {
        chosen.aiModel = customOrModel.trim() || selectedOrModel;
        if (openrouterApiKey.trim()) {
          chosen.openrouterApiKey = openrouterApiKey.trim();
        }
      } else {
        chosen.aiModel = selectedGeminiModel;
      }
    }

    setBusy(true);
    try {
      const id = await createJob({
        sourceUrl: sourceUrl.trim(),
        adapter,
        chaptersPerBook: perBook,
        export: Object.keys(chosen).length > 0 ? chosen : undefined,
      });
      onCreated(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isStep1Done = isHttpUrl(sourceUrl);

  return (
    <form onSubmit={onSubmit} noValidate className="pipeline-track">
      <h2 style={{ display: "none" }}>Tạo job mới</h2>

      {/* ================= BƯỚC 1: NẠP TRUYỆN ================= */}
      <div className={`pipeline-node ${isStep1Done ? "completed" : "active"}`}>
        <div className="node-icon">{isStep1Done ? <Check size={14} strokeWidth={2.5} /> : "1"}</div>
        <div className="node-body card-modern" style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: 0 }}>
              Bước 1: Nạp đường dẫn truyện chữ
            </h3>
            {sourceInfo ? (
              <span
                style={{
                  fontSize: 11.5,
                  padding: "3px 10px",
                  borderRadius: 20,
                  background: sourceInfo.isOfficial ? "var(--primary-light)" : "#f1f5f9",
                  color: sourceInfo.isOfficial ? "var(--primary)" : "#475569",
                  border: `1px solid ${sourceInfo.isOfficial ? "var(--primary-border)" : "#cbd5e1"}`,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: sourceInfo.isOfficial ? "var(--primary)" : "#64748b" }}></span>
                Nguồn: {sourceInfo.name}
              </span>
            ) : null}
          </div>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 14 }}>
            Dán liên kết mục lục tác phẩm, hệ thống sẽ tự động quét và bóc tách các chương.
          </p>

          <div>
            <label htmlFor="source-url-input">
              URL nguồn truyện
            </label>
            <div style={{ position: "relative" }}>
              <input
                id="source-url-input"
                aria-label="URL nguồn truyện"
                type="url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="Dán link truyện (ví dụ: https://truyendich.space/truyen/kiem-lai hoặc webnovel.vn...)"
                style={{ paddingLeft: 38 }}
              />
              <span
                style={{
                  position: "absolute",
                  left: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "#94a3b8",
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                <Link2 size={16} />
              </span>
            </div>
          </div>

          {/* Chọn nguồn / Adapter */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <label style={{ fontSize: 12, color: "#64748b", fontWeight: 600, margin: 0 }}>
                Nguồn (adapter)
              </label>
              <span style={{ fontSize: 11, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Zap size={12} className="text-amber-500" />
                <span>Tự động nhận diện từ URL (hoặc chọn thủ công nếu cần)</span>
              </span>
            </div>
            <select
              aria-label="Adapter"
              value={adapter}
              onChange={(e) => setAdapter(e.target.value)}
              style={{ fontSize: 12.5, padding: "8px 12px" }}
            >
              {ADAPTERS.map((a) => (
                <option key={a} value={a}>
                  {a === "webnovel-vn" ? "Webnovel VN (webnovel.vn)" : a === "truyendich-space" ? "Truyện Dịch Space (truyendich.space)" : a}
                </option>
              ))}
              {!ADAPTERS.includes(adapter as never) && adapter ? (
                <option value={adapter}>Tự động theo tên miền ({adapter})</option>
              ) : null}
            </select>
          </div>
        </div>
      </div>

      {/* ================= BƯỚC 2: CẤU HÌNH & QUY CÁCH ================= */}
      <div className={`pipeline-node ${isStep1Done ? "active" : ""}`} style={{ opacity: isStep1Done ? 1 : 0.88 }}>
        <div className="node-icon">2</div>
        <div className="node-body card-modern" style={{ padding: "24px 26px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: 0 }}>
              Bước 2: Cấu hình giọng đọc & Đóng gói sách nói
            </h3>
            <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
              Quy cách file .M4B và giọng đọc
            </span>
          </div>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 18 }}>
            Hệ thống sẽ gom các chương thành từng tập Audiobook riêng biệt và thu âm bằng giọng đọc AI truyền cảm.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {/* Phân quyển / Chia tập */}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <fieldset style={{ margin: 0, height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                <legend>Chương mỗi sách</legend>
                <div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
                    Mỗi tập sách nói (.m4b) sẽ gom bao nhiêu chương?
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {CHAPTER_PRESETS.map((n) => (
                      <label
                        key={n}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          margin: 0,
                          fontSize: 12.5,
                          cursor: "pointer",
                          padding: "6px 12px",
                          borderRadius: 8,
                          border: `1px solid ${!customPerBook && perBook === n ? "var(--primary)" : "#e2e8f0"}`,
                          background: !customPerBook && perBook === n ? "var(--primary-light)" : "#ffffff",
                          fontWeight: !customPerBook && perBook === n ? 700 : 500,
                          color: !customPerBook && perBook === n ? "var(--primary)" : "#334155",
                          transition: "all 0.15s ease",
                        }}
                      >
                        <input
                          type="radio"
                          name="perBook"
                          checked={!customPerBook && perBook === n}
                          onChange={() => {
                            setCustomPerBook(false);
                            setPerBook(n);
                          }}
                        />{" "}
                        {n}
                      </label>
                    ))}
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        margin: 0,
                        fontSize: 12.5,
                        cursor: "pointer",
                        padding: "6px 12px",
                        borderRadius: 8,
                        border: `1px solid ${customPerBook ? "var(--primary)" : "#e2e8f0"}`,
                        background: customPerBook ? "var(--primary-light)" : "#ffffff",
                        fontWeight: customPerBook ? 700 : 500,
                        color: customPerBook ? "var(--primary)" : "#334155",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <input
                        type="radio"
                        name="perBook"
                        checked={customPerBook}
                        onChange={() => setCustomPerBook(true)}
                      />{" "}
                      Tuỳ chọn
                    </label>
                  </div>

                  {customPerBook ? (
                    <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12, color: "#64748b" }}>Số chương mỗi tập:</span>
                      <input
                        aria-label="Chương mỗi sách (tuỳ chọn)"
                        type="number"
                        min={1}
                        max={1000}
                        value={perBook}
                        onChange={(e) => setPerBook(Number(e.target.value))}
                        style={{
                          width: 90,
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid #cbd5e1",
                          background: "#ffffff",
                          fontSize: 12.5,
                        }}
                      />
                      <span style={{ fontSize: 11.5, color: "#94a3b8" }}>(1 đến 1000)</span>
                    </div>
                  ) : null}
                </div>

                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 12, borderTop: "1px dashed #e2e8f0", paddingTop: 8, display: "flex", alignItems: "center", gap: 5 }}>
                  <Lightbulb size={13} className="text-amber-500 shrink-0" />
                  <span>{perBook <= 10 ? "Tập ngắn — Tiện nghe nhanh khi di chuyển hoặc chạy bộ" : perBook <= 30 ? "Chuẩn cân bằng — Tối ưu dung lượng và thời lượng pin điện thoại" : "Tập dài — Thích hợp nghe liên tục qua đêm"}</span>
                </div>
              </fieldset>
            </div>

            {/* Giọng đọc & Tựa sách */}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <fieldset style={{ margin: 0, height: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
                <legend>Tuỳ chọn rewrite / TTS</legend>

                {/* Tựa sách */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <label htmlFor="book-title-input" style={{ fontSize: 12, fontWeight: 600, color: "#334155", margin: 0 }}>
                      Tựa sách
                    </label>
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>Để trống = Lấy từ web</span>
                  </div>
                  <input
                    id="book-title-input"
                    type="text"
                    aria-label="Tựa sách"
                    value={exportOptions.bookTitle ?? ""}
                    onChange={(e) =>
                      setExportOptions({ ...exportOptions, bookTitle: e.target.value })
                    }
                    placeholder="Tên tác phẩm hiển thị trên ứng dụng nghe nhạc"
                    style={{
                      width: "100%",
                      padding: "9px 13px",
                      borderRadius: 10,
                      border: "1px solid #cbd5e1",
                      background: "#ffffff",
                      fontSize: 13,
                      boxSizing: "border-box",
                    }}
                  />
                </div>

                {/* Giọng đọc TTS */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <label htmlFor="tts-voice-input" style={{ fontSize: 12, fontWeight: 600, color: "#334155", margin: 0 }}>
                      Giọng đọc TTS
                    </label>
                    <span style={{ fontSize: 11, color: "var(--primary)", fontWeight: 600 }}>
                      {VOICE_PRESETS.find((v) => v.id === (exportOptions.ttsVoice || "vi-VN-HoaiMyNeural"))?.name || "Giọng tùy chỉnh"}
                    </span>
                  </div>

                  {/* Danh sách chọn nhanh giọng đọc thân thiện */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                    {VOICE_PRESETS.map((v) => {
                      const isSelected = (exportOptions.ttsVoice || "vi-VN-HoaiMyNeural") === v.id;
                      return (
                        <div
                          key={v.id}
                          onClick={() => setExportOptions({ ...exportOptions, ttsVoice: v.id })}
                          style={{
                            padding: "7px 12px",
                            borderRadius: 10,
                            border: `1.5px solid ${isSelected ? "var(--primary)" : "#e2e8f0"}`,
                            background: isSelected ? "var(--primary-light)" : "#ffffff",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            fontSize: 12,
                            transition: "all 0.15s ease",
                            boxShadow: isSelected ? "0 1px 3px rgba(5, 150, 105, 0.1)" : "none",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontWeight: isSelected ? 700 : 500, color: isSelected ? "var(--primary)" : "#1e293b" }}>
                              {v.name}
                            </span>
                            <span style={{ fontSize: 10.5, padding: "1px 7px", borderRadius: 10, background: isSelected ? "#ffffff" : "#f1f5f9", color: "#64748b" }}>
                              {v.genre}
                            </span>
                          </div>
                          <span style={{ display: "inline-flex", alignItems: "center" }}>
                            <Check size={14} strokeWidth={2.5} style={{ color: isSelected ? "var(--primary)" : "transparent" }} />
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Input mã giọng kỹ thuật */}
                  <div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                      Mã giọng đọc (Azure/Edge TTS):
                    </div>
                    <input
                      id="tts-voice-input"
                      type="text"
                      aria-label="Giọng đọc TTS"
                      value={exportOptions.ttsVoice ?? ""}
                      onChange={(e) =>
                        setExportOptions({ ...exportOptions, ttsVoice: e.target.value })
                      }
                      placeholder="vi-VN-HoaiMyNeural"
                      style={{
                        width: "100%",
                        padding: "8px 12px",
                        borderRadius: 10,
                        border: "1px solid #cbd5e1",
                        background: "#ffffff",
                        fontSize: 12,
                        fontFamily: "monospace",
                        color: "#475569",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                </div>
              </fieldset>
            </div>
          </div>

          {/* AI Checkbox & 18+ — Chuyển thành 2 Feature Cards hiện đại */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
            {/* Card Rewrite AI */}
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                margin: 0,
                padding: "12px 14px",
                borderRadius: 12,
                border: `1px solid ${exportOptions.rewriteAi ? "var(--primary)" : "#e2e8f0"}`,
                background: exportOptions.rewriteAi ? "var(--primary-light)" : "#f8fafc",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              <input
                type="checkbox"
                aria-label="Bật rewrite AI"
                checked={exportOptions.rewriteAi === true}
                onChange={(e) =>
                  setExportOptions({ ...exportOptions, rewriteAi: e.target.checked })
                }
                style={{ marginTop: 2 }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: exportOptions.rewriteAi ? "var(--primary)" : "#0f172a", display: "flex", alignItems: "center", gap: 6 }}>
                  <Bot size={15} className="text-indigo-500" />
                  <span>Bật rewrite AI (Chuốt văn thông minh)</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>
                  Tự động biên tập lại câu cú từ bản dịch convert thô, ngắt nhịp tự nhiên như dịch giả người thật.
                </div>
              </div>
            </label>

            {/* Card 18+ */}
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                margin: 0,
                padding: "12px 14px",
                borderRadius: 12,
                border: `1px solid ${exportOptions.isAdultContent ? "#f59e0b" : "#e2e8f0"}`,
                background: exportOptions.isAdultContent ? "#fffbeb" : "#f8fafc",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              <input
                type="checkbox"
                aria-label="Nội dung 18+"
                checked={exportOptions.isAdultContent === true}
                onChange={(e) =>
                  setExportOptions({ ...exportOptions, isAdultContent: e.target.checked })
                }
                style={{ marginTop: 2, accentColor: "#f59e0b" }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: exportOptions.isAdultContent ? "#b45309" : "#0f172a", display: "flex", alignItems: "center", gap: 6 }}>
                  <ShieldAlert size={15} className="text-amber-600" />
                  <span>Nội dung 18+ (Cảnh báo nhạy cảm)</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>
                  Tối ưu hóa các đoạn văn nhạy cảm để hệ thống sinh âm thanh AI không bị chặn hoặc từ chối tạo file.
                </div>
              </div>
            </label>
          </div>

          {/* Cấu hình nâng cao AI: OpenRouter / Gemini khi bật Rewrite AI */}
          {exportOptions.rewriteAi && (
            <div
              style={{
                marginTop: 14,
                padding: "16px 18px",
                borderRadius: 14,
                border: "1px solid #e2e8f0",
                background: "#f8fafc",
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#1e293b", display: "flex", alignItems: "center", gap: 6 }}>
                    <Settings size={15} className="text-slate-700" />
                    <span>Nhà cung cấp & Mô hình AI Chuốt văn</span>
                  </span>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                    Tích hợp linh hoạt OpenRouter (DeepSeek / Qwen / Llama) để tránh nghẽn hạn mức Gemini Free.
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: "3px 9px",
                    borderRadius: 20,
                    background: "#ecfdf5",
                    color: "#059669",
                    fontWeight: 600,
                    border: "1px solid #a7f3d0",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Zap size={12} />
                  <span>Đa nền tảng linh hoạt</span>
                </span>
              </div>

              {/* Bộ chọn Provider */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 6 }}>
                  Chọn nguồn AI:
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8 }}>
                  {[
                    { id: "openrouter", name: "OpenRouter", icon: Globe, desc: "DeepSeek, Llama, Qwen (Khuyên dùng)" },
                    { id: "devkit", name: "DevKit (OpenAI)", icon: Rocket, desc: "DeepSeek R1 550B (agent.devkit.vn)" },
                    { id: "gemini", name: "Google Gemini", icon: Cpu, desc: "Gemini 2.0 / 1.5 Flash" },
                    { id: "openrouter,gemini", name: "Dự phòng OpenRouter ⇄ Gemini", icon: RefreshCw, desc: "Tự động đổi khi nghẽn" },
                    { id: "devkit,gemini", name: "Dự phòng DevKit ⇄ Gemini", icon: RefreshCw, desc: "Tự động đổi khi nghẽn" },
                  ].map((p) => {
                    const isSelected = aiProvider === p.id;
                    const ProviderIcon = p.icon;
                    return (
                      <div
                        key={p.id}
                        onClick={() => {
                          setAiProvider(p.id as never);
                          setHasCustomAiConfig(true);
                        }}
                        style={{
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: `1.5px solid ${isSelected ? "var(--primary)" : "#cbd5e1"}`,
                          background: isSelected ? "var(--primary-light)" : "#ffffff",
                          cursor: "pointer",
                          transition: "all 0.15s ease",
                        }}
                      >
                        <div style={{ fontSize: 12.5, fontWeight: isSelected ? 700 : 600, color: isSelected ? "var(--primary)" : "#1e293b", display: "flex", alignItems: "center", gap: 5 }}>
                          <ProviderIcon size={14} className={isSelected ? "text-emerald-600" : "text-slate-500"} />
                          <span>{p.name}</span>
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                          {p.desc}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Khi chọn OpenRouter hoặc Auto: danh sách models gợi ý + key */}
              {(aiProvider === "openrouter" || aiProvider === "openrouter,gemini") && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px dashed #cbd5e1", paddingTop: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#475569", margin: 0 }}>
                      Mô hình OpenRouter tối ưu cho tiểu thuyết tiếng Việt:
                    </label>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      Đang chọn: <strong style={{ color: "var(--primary)" }}>{customOrModel.trim() || selectedOrModel}</strong>
                    </span>
                  </div>

                  {/* Model chips */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {OPENROUTER_MODELS.map((m) => {
                      const isSelected = !customOrModel.trim() && selectedOrModel === m.id;
                      return (
                        <div
                          key={m.id}
                          onClick={() => {
                            setSelectedOrModel(m.id);
                            setCustomOrModel("");
                            setHasCustomAiConfig(true);
                          }}
                          style={{
                            padding: "8px 12px",
                            borderRadius: 10,
                            border: `1.5px solid ${isSelected ? "var(--primary)" : "#e2e8f0"}`,
                            background: isSelected ? "var(--primary-light)" : "#ffffff",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 12.5, fontWeight: isSelected ? 700 : 600, color: isSelected ? "var(--primary)" : "#0f172a" }}>
                              {m.name}
                            </span>
                            <span
                              style={{
                                fontSize: 10,
                                padding: "1px 6px",
                                borderRadius: 6,
                                background: m.isFree ? "#ecfdf5" : "#eff6ff",
                                color: m.isFree ? "#059669" : "#2563eb",
                                fontWeight: 600,
                              }}
                            >
                              {m.badge}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.3 }}>
                            {m.desc}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Tùy chỉnh model ID khác */}
                  <div style={{ marginTop: 2 }}>
                    <div style={{ fontSize: 11.5, color: "#64748b", marginBottom: 3 }}>
                      Hoặc nhập mã model OpenRouter tùy chọn khác:
                    </div>
                    <input
                      type="text"
                      value={customOrModel}
                      onChange={(e) => {
                        setCustomOrModel(e.target.value);
                        setHasCustomAiConfig(true);
                      }}
                      placeholder="Ví dụ: meta-llama/llama-3.1-8b-instruct:free, anthropic/claude-3.5-haiku..."
                      style={{
                        width: "100%",
                        padding: "7px 12px",
                        borderRadius: 8,
                        border: "1px solid #cbd5e1",
                        fontSize: 12,
                        fontFamily: "monospace",
                        background: "#ffffff",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>

                  {/* OpenRouter API Key input */}
                  <div style={{ marginTop: 4, background: "#ffffff", padding: "10px 14px", borderRadius: 10, border: "1px solid #e2e8f0" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#334155", margin: 0 }}>
                        OpenRouter API Key (Tùy chọn nếu đã có trong file .env):
                      </label>
                      <span style={{ fontSize: 11, color: "#64748b" }}>
                        <a
                          href="https://openrouter.ai/keys"
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "var(--primary)", textDecoration: "underline" }}
                        >
                          Lấy key tại openrouter.ai/keys ↗
                        </a>
                      </span>
                    </div>
                    <div style={{ position: "relative" }}>
                      <input
                        type={showApiKey ? "text" : "password"}
                        value={openrouterApiKey}
                        onChange={(e) => {
                          const val = e.target.value;
                          setOpenrouterApiKey(val);
                          setHasCustomAiConfig(true);
                          try {
                            localStorage.setItem("story_audio_openrouter_api_key", val);
                          } catch {}
                        }}
                        placeholder="sk-or-v1-..."
                        style={{
                          width: "100%",
                          padding: "7px 12px",
                          paddingRight: 60,
                          borderRadius: 8,
                          border: "1px solid #cbd5e1",
                          fontSize: 12,
                          fontFamily: "monospace",
                          boxSizing: "border-box",
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        style={{
                          position: "absolute",
                          right: 6,
                          top: "50%",
                          transform: "translateY(-50%)",
                          background: "transparent",
                          border: "none",
                          fontSize: 11,
                          color: "#64748b",
                          cursor: "pointer",
                          padding: "2px 6px",
                        }}
                      >
                        {showApiKey ? "Ẩn" : "Hiện"}
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                      <Lightbulb size={12} className="text-amber-500 shrink-0" />
                      <span>Key được lưu tự động trên trình duyệt này (hoặc có thể khai báo vĩnh viễn trong file <code>.env</code> ở máy chủ).</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Khi chọn DevKit hoặc Dự phòng DevKit + Gemini: danh sách models gợi ý + key */}
              {(aiProvider === "devkit" || aiProvider === "devkit,gemini") && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px dashed #cbd5e1", paddingTop: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#475569", margin: 0 }}>
                      Mô hình DevKit (Cổng chuẩn OpenAI):
                    </label>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      Đang chọn: <strong style={{ color: "var(--primary)" }}>{customDkModel.trim() || selectedDkModel}</strong>
                    </span>
                  </div>

                  {/* Model chips */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
                    {DEVKIT_MODELS.map((m) => {
                      const isSelected = !customDkModel.trim() && selectedDkModel === m.id;
                      return (
                        <div
                          key={m.id}
                          onClick={() => {
                            setSelectedDkModel(m.id);
                            setCustomDkModel("");
                            setHasCustomAiConfig(true);
                          }}
                          style={{
                            padding: "8px 12px",
                            borderRadius: 10,
                            border: `1.5px solid ${isSelected ? "var(--primary)" : "#e2e8f0"}`,
                            background: isSelected ? "var(--primary-light)" : "#ffffff",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 12.5, fontWeight: isSelected ? 700 : 600, color: isSelected ? "var(--primary)" : "#0f172a" }}>
                              {m.name} <code>({m.id})</code>
                            </span>
                            <span
                              style={{
                                fontSize: 10,
                                padding: "1px 6px",
                                borderRadius: 6,
                                background: "#ecfdf5",
                                color: "#059669",
                                fontWeight: 600,
                              }}
                            >
                              {m.badge}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.3 }}>
                            {m.desc}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Tùy chỉnh model ID khác */}
                  <div style={{ marginTop: 2 }}>
                    <div style={{ fontSize: 11.5, color: "#64748b", marginBottom: 3 }}>
                      Hoặc nhập mã Model ID tùy chọn khác:
                    </div>
                    <input
                      type="text"
                      value={customDkModel}
                      onChange={(e) => {
                        setCustomDkModel(e.target.value);
                        setHasCustomAiConfig(true);
                      }}
                      placeholder="deepseek-r1-550b"
                      style={{
                        width: "100%",
                        padding: "7px 12px",
                        borderRadius: 8,
                        border: "1px solid #cbd5e1",
                        fontSize: 12,
                        fontFamily: "monospace",
                        background: "#ffffff",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>

                  {/* DevKit API Key input */}
                  <div style={{ marginTop: 4, background: "#ffffff", padding: "10px 14px", borderRadius: 10, border: "1px solid #e2e8f0" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#334155", margin: 0 }}>
                        DevKit API Key (Tùy chọn nếu đã có trong file .env):
                      </label>
                      <span style={{ fontSize: 11, color: "#059669", fontWeight: 600 }}>
                        Base URL: https://agent.devkit.vn/v1
                      </span>
                    </div>
                    <div style={{ position: "relative" }}>
                      <input
                        type={showDkApiKey ? "text" : "password"}
                        value={devkitApiKey}
                        onChange={(e) => {
                          const val = e.target.value;
                          setDevkitApiKey(val);
                          setHasCustomAiConfig(true);
                          try {
                            localStorage.setItem("story_audio_devkit_api_key", val);
                          } catch {}
                        }}
                        placeholder="sk-..."
                        style={{
                          width: "100%",
                          padding: "7px 12px",
                          paddingRight: 60,
                          borderRadius: 8,
                          border: "1px solid #cbd5e1",
                          fontSize: 12,
                          fontFamily: "monospace",
                          boxSizing: "border-box",
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowDkApiKey(!showDkApiKey)}
                        style={{
                          position: "absolute",
                          right: 6,
                          top: "50%",
                          transform: "translateY(-50%)",
                          background: "transparent",
                          border: "none",
                          fontSize: 11,
                          color: "#64748b",
                          cursor: "pointer",
                          padding: "2px 6px",
                        }}
                      >
                        {showDkApiKey ? "Ẩn" : "Hiện"}
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                      <Lightbulb size={12} className="text-amber-500 shrink-0" />
                      <span>Key được lưu tự động trên trình duyệt này (hoặc có thể khai báo biến <code>DEVKIT_API_KEY</code> trong file <code>.env</code> ở máy chủ).</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Khi chọn Gemini: model selector */}
              {aiProvider === "gemini" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px dashed #cbd5e1", paddingTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>
                    Phiên bản Google Gemini:
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {GEMINI_MODELS.map((m) => {
                      const isSelected = selectedGeminiModel === m.id;
                      return (
                        <div
                          key={m.id}
                          onClick={() => {
                            setSelectedGeminiModel(m.id);
                            setHasCustomAiConfig(true);
                          }}
                          style={{
                            padding: "8px 12px",
                            borderRadius: 10,
                            border: `1.5px solid ${isSelected ? "var(--primary)" : "#e2e8f0"}`,
                            background: isSelected ? "var(--primary-light)" : "#ffffff",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 12.5, fontWeight: isSelected ? 700 : 600, color: isSelected ? "var(--primary)" : "#0f172a" }}>
                              {m.name}
                            </span>
                            <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 6, background: "#ecfdf5", color: "#059669", fontWeight: 600 }}>
                              {m.badge}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                            {m.desc}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
                    <Zap size={12} className="text-amber-500 shrink-0" />
                    <span>Gemini sử dụng <code>GEMINI_API_KEY</code> đã khai báo trong <code>.env</code>.</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {error ? (
            <p role="alert" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <AlertTriangle size={14} className="text-rose-500 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}

          {/* Submit Button */}
          <div style={{ marginTop: 18 }}>
            <button
              type="submit"
              disabled={busy}
              aria-label="Tạo job"
              style={{
                width: "100%",
                padding: "13px 20px",
                fontSize: 15,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {busy ? (
                "Đang khởi tạo dây chuyền chuyển thể…"
              ) : (
                <>
                  <Rocket size={16} strokeWidth={2} />
                  <span>Bắt đầu chuyển thể thành Sách nói (Tạo job)</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
