// Story Audio Studio v2 — Giao diện 3 cột Hiện đại (Babuk E-Reader & Audio Workspace)
import { useState, useEffect } from "react";
import {
  Headphones,
  LayoutDashboard,
  Activity,
  Library,
  Plus,
  Settings,
  HardDrive,
  Server,
  Cpu,
  RefreshCw,
  FileCheck2,
  X,
  PackageCheck,
} from "lucide-react";
import { CreateJobForm } from "./CreateJobForm";
import { SettingsForm } from "./JobSettings";
import { JobsList, extractStoryTitle } from "./JobsList";
import { JobProgress } from "./JobProgress";
import { JobOutputs } from "./JobOutputs";
import { JobCarousel } from "./JobCarousel";
import { ChapterReader } from "./ChapterReader";
import { AudioPlayerCard } from "./AudioPlayerCard";
import type { AudioTrack } from "./AudioPlayerCard";
import { fetchJobs, fetchChapters } from "./api";
import type { JobRow, ChapterRow } from "./api";

const SELECTED_KEY = "story-audio.selected-job";

function readSelectedJob(): string {
  try {
    return localStorage.getItem(SELECTED_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveSelectedJob(jobId: string): void {
  try {
    if (jobId) localStorage.setItem(SELECTED_KEY, jobId);
    else localStorage.removeItem(SELECTED_KEY);
  } catch {
    // Không có storage — bỏ qua
  }
}

export default function App() {
  const [jobsVersion, setJobsVersion] = useState(1);
  const [jobId, setJobId] = useState<string>(readSelectedJob);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [chapters, setChapters] = useState<ChapterRow[]>([]);
  const [selectedChapterIdx, setSelectedChapterIdx] = useState<number>(0);
  const [activeTrack, setActiveTrack] = useState<AudioTrack | null>(null);
  const [showNewJobModal, setShowNewJobModal] = useState<boolean>(false);
  const [centerTab, setCenterTab] = useState<"reader" | "progress" | "outputs" | "library" | "settings">("reader");

  function chooseJob(next: string): void {
    saveSelectedJob(next);
    setJobId(next);
  }

  const effectiveJobId = jobs.length > 0
    ? (jobs.some((j) => j.id === jobId) ? jobId : jobs[0].id)
    : jobId;

  // Nạp danh sách jobs cho Carousel & Library
  useEffect(() => {
    let unmounted = false;
    fetchJobs(50)
      .then((res) => {
        if (!unmounted) {
          setJobs(res.items);
          const exists = res.items.some((j) => j.id === jobId);
          if ((!jobId || !exists) && res.items.length > 0) {
            chooseJob(res.items[0].id);
          }
        }
      })
      .catch(() => {});
    return () => {
      unmounted = true;
    };
  }, [jobsVersion]);

  // Nạp danh sách chương khi effectiveJobId thay đổi
  useEffect(() => {
    if (!effectiveJobId) {
      setChapters([]);
      return;
    }
    let unmounted = false;
    fetchChapters(effectiveJobId, 300)
      .then((res) => {
        if (!unmounted) {
          setChapters(res.items);
          setSelectedChapterIdx(0);
          // Tìm chương đầu tiên có audio để nạp vào player
          const firstWithAudio = res.items.find((c) => c.audioAssetId);
          if (firstWithAudio) {
            const storyName = extractStoryTitle(
              jobs.find((j) => j.id === effectiveJobId)?.sourceUrl || ""
            );
            setActiveTrack({
              title: `Chương ${firstWithAudio.index}: ${firstWithAudio.title || `Chương ${firstWithAudio.index}`}`,
              subTitle: storyName || "Sách nói tiếng Việt",
              url: `/api/jobs/${encodeURIComponent(effectiveJobId)}/assets/${encodeURIComponent(firstWithAudio.audioAssetId!)}/download`,
              coverLabel: storyName || "STORY AUDIO",
            });
          }
        }
      })
      .catch(() => {});
    return () => {
      unmounted = true;
    };
  }, [effectiveJobId, jobsVersion]);

  function handlePlayChapter(c: ChapterRow) {
    if (!c.audioAssetId || !effectiveJobId) return;
    const storyName = extractStoryTitle(
      jobs.find((j) => j.id === effectiveJobId)?.sourceUrl || ""
    );
    setActiveTrack({
      title: `Chương ${c.index}: ${c.title || `Chương ${c.index}`}`,
      subTitle: storyName || "Sách nói tiếng Việt",
      url: `/api/jobs/${encodeURIComponent(effectiveJobId)}/assets/${encodeURIComponent(c.audioAssetId)}/download`,
      coverLabel: storyName || "STORY AUDIO",
    });
  }

  function handlePrevTrack() {
    const prevIdx = selectedChapterIdx - 1;
    if (prevIdx >= 0 && chapters[prevIdx]) {
      setSelectedChapterIdx(prevIdx);
      if (chapters[prevIdx].audioAssetId) {
        handlePlayChapter(chapters[prevIdx]);
      }
    }
  }

  function handleNextTrack() {
    const nextIdx = selectedChapterIdx + 1;
    if (nextIdx < chapters.length && chapters[nextIdx]) {
      setSelectedChapterIdx(nextIdx);
      if (chapters[nextIdx].audioAssetId) {
        handlePlayChapter(chapters[nextIdx]);
      }
    }
  }

  return (
    <div className="studio-root">
      <div className="studio-frame">
        {/* 1. CỘT TRÁI: SIDEBAR ĐIỀU HƯỚNG */}
        <aside className="studio-sidebar">
          <div className="studio-sidebar-top">
            <a href="#" className="studio-logo" onClick={(e) => { e.preventDefault(); setCenterTab("reader"); }}>
              <div className="studio-logo-icon">
                <Headphones size={18} strokeWidth={2.2} />
              </div>
              <div className="studio-logo-text">
                <span className="studio-logo-title">Story Audio</span>
                <span className="studio-logo-tag">Studio v2</span>
              </div>
            </a>

            {/* Nút hành động chính (Primary CTA) của Sidebar */}
            <div className="studio-sidebar-cta-wrap">
              <button
                type="button"
                className="studio-sidebar-cta"
                onClick={() => setShowNewJobModal(true)}
              >
                <Plus size={16} strokeWidth={2.5} />
                <span>Thêm truyện mới</span>
              </button>
            </div>

            <nav className="studio-nav">
              <div className="studio-nav-group">
                <div className="studio-nav-heading">KHÔNG GIAN LÀM VIỆC</div>
                <ul className="studio-nav-list">
                  <li>
                    <button
                      type="button"
                      className={`studio-nav-item ${centerTab === "reader" ? "active" : ""}`}
                      onClick={() => setCenterTab("reader")}
                    >
                      <span className="studio-nav-icon">
                        <LayoutDashboard size={16} strokeWidth={2} />
                      </span>
                      <span>Bàn làm việc</span>
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      className={`studio-nav-item ${centerTab === "progress" ? "active" : ""}`}
                      onClick={() => setCenterTab("progress")}
                    >
                      <span className="studio-nav-icon">
                        <Activity size={16} strokeWidth={2} />
                      </span>
                      <span>Tiến độ Live</span>
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      className={`studio-nav-item ${centerTab === "outputs" ? "active" : ""}`}
                      onClick={() => setCenterTab("outputs")}
                    >
                      <span className="studio-nav-icon">
                        <PackageCheck size={16} strokeWidth={2} />
                      </span>
                      <span>Kho Thành phẩm</span>
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      className={`studio-nav-item ${centerTab === "library" ? "active" : ""}`}
                      onClick={() => setCenterTab("library")}
                    >
                      <span className="studio-nav-icon">
                        <Library size={16} strokeWidth={2} />
                      </span>
                      <span>Tủ sách</span>
                    </button>
                  </li>
                </ul>
              </div>

              <div className="studio-nav-group" style={{ marginTop: 20 }}>
                <div className="studio-nav-heading">CẤU HÌNH & HỆ THỐNG</div>
                <ul className="studio-nav-list">
                  <li>
                    <button
                      type="button"
                      className={`studio-nav-item ${centerTab === "settings" ? "active" : ""}`}
                      onClick={() => setCenterTab("settings")}
                    >
                      <span className="studio-nav-icon">
                        <Settings size={16} strokeWidth={2} />
                      </span>
                      <span>Cài đặt</span>
                    </button>
                  </li>
                </ul>
              </div>
            </nav>
          </div>

          <div className="studio-sidebar-footer">
            <div className="studio-system-badge">
              <div style={{ fontWeight: 700, color: "var(--studio-text-main)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                <HardDrive size={15} strokeWidth={1.75} />
                <span>Cloudflare R2 · Private</span>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--emerald-solid)", display: "inline-block" }} />
              </div>
              <div>Bảo mật $0 · Local Windows</div>
            </div>
          </div>
        </aside>

        {/* 2. KHU VỰC CHÍNH WORKSPACE TOÀN MÀN HÌNH (ĐÃ BỎ CỘT PHẢI) */}
        <div className="studio-main">
          {/* Topbar */}
          <header className="studio-topbar">
            <div className="studio-topbar-left">
              <div className="studio-pill" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Server size={14} strokeWidth={1.75} className="text-slate-600" />
                <span>Windows Local Studio</span>
              </div>
              <div className="studio-pill-badge" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Cpu size={14} strokeWidth={1.75} className="text-slate-600" />
                <span>Gemini Free & Edge-TTS</span>
              </div>
            </div>

            <div className="studio-topbar-right">
              <button
                type="button"
                className="studio-btn-primary"
                onClick={() => setShowNewJobModal(true)}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <Plus size={15} strokeWidth={2} />
                <span>Thêm truyện mới</span>
              </button>

              <button
                type="button"
                className="studio-icon-btn"
                title="Làm mới dữ liệu"
                onClick={() => setJobsVersion((v) => v + 1)}
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
              >
                <RefreshCw size={15} strokeWidth={1.75} />
              </button>

              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: "50%",
                  background: "#1e293b",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 13,
                }}
                title="Người dùng Studio"
              >
                SA
              </div>
            </div>
          </header>

          {/* Center Workspace Area Toàn Diện */}
          <div className="studio-center-split">
            <main className="studio-workspace-area" style={{ maxWidth: "1280px", margin: "0 auto", width: "100%" }}>
              {/* Băng chuyền sách Continue Reading */}
              <JobCarousel
                jobs={jobs}
                selectedJobId={effectiveJobId}
                onSelectJob={(id) => chooseJob(id)}
              />

              {/* View Switcher Tabs (Segmented Control) */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, borderBottom: "1px solid var(--studio-border)", paddingBottom: 12 }}>
                <div className="studio-segmented-control">
                  <button
                    type="button"
                    onClick={() => setCenterTab("reader")}
                    className={`studio-segmented-btn ${centerTab === "reader" ? "active" : ""}`}
                  >
                    <FileCheck2 size={15} strokeWidth={1.75} />
                    <span>Xưởng Đọc & Duyệt QA</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCenterTab("progress")}
                    className={`studio-segmented-btn ${centerTab === "progress" ? "active" : ""}`}
                  >
                    <Activity size={15} strokeWidth={1.75} />
                    <span>Tiến Độ Live & Logs</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCenterTab("outputs")}
                    className={`studio-segmented-btn ${centerTab === "outputs" ? "active" : ""}`}
                  >
                    <PackageCheck size={15} strokeWidth={1.75} />
                    <span>Kho Thành Phẩm M4B/MP4</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCenterTab("library")}
                    className={`studio-segmented-btn ${centerTab === "library" ? "active" : ""}`}
                  >
                    <Library size={15} strokeWidth={1.75} />
                    <span>Tủ Sách</span>
                  </button>
                </div>
              </div>

              {/* Nội dung tương ứng tab */}
              {centerTab === "reader" && (
                <div>
                  <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h2 className="studio-section-title" style={{ margin: 0 }}>
                      Nội dung chương & Kiểm định văn phong
                    </h2>
                    <span style={{ fontSize: 12, color: "var(--studio-text-sub)" }}>
                      AI Rewrite · Glossary Guard
                    </span>
                  </div>
                  <ChapterReader
                    jobId={effectiveJobId}
                    chapters={chapters}
                    selectedIndex={selectedChapterIdx}
                    onSelectIndex={(idx) => {
                      setSelectedChapterIdx(idx);
                      if (chapters[idx]?.audioAssetId) {
                        handlePlayChapter(chapters[idx]);
                      }
                    }}
                    onPlayAudio={handlePlayChapter}
                  />
                </div>
              )}

              {centerTab === "progress" && effectiveJobId && (
                <div>
                  <JobProgress
                    jobId={effectiveJobId}
                    onPlayAudioTrack={(track) => setActiveTrack(track)}
                  />
                </div>
              )}

              {centerTab === "outputs" && (
                <div className="card-modern" style={{ padding: "24px 28px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                    <div>
                      <h2 style={{ fontSize: 18, fontWeight: 800, color: "var(--studio-text-main)", margin: 0 }}>
                        Kho Thành phẩm Sách nói
                      </h2>
                      <p style={{ fontSize: 12.5, color: "var(--studio-text-sub)", marginTop: 4 }}>
                        Đóng gói audiobook M4B (kèm chapter markers) và Video MP4 hoàn thiện.
                      </p>
                    </div>
                  </div>
                  {effectiveJobId ? (
                    <JobOutputs jobId={effectiveJobId} />
                  ) : (
                    <div style={{ padding: "40px", textAlign: "center", color: "var(--studio-text-sub)" }}>
                      Vui lòng chọn một tác phẩm từ Băng chuyền hoặc Tủ sách để xem kho thành phẩm.
                    </div>
                  )}
                </div>
              )}

              {centerTab === "library" && (
                <div>
                  <JobsList
                    refreshKey={jobsVersion}
                    onSelectJob={(id) => {
                      chooseJob(id);
                      setCenterTab("reader");
                    }}
                    selectedJobId={jobId}
                  />
                </div>
              )}

              {centerTab === "settings" && (
                <div className="card-modern" style={{ padding: "28px 32px" }}>
                  <div style={{ marginBottom: 24, borderBottom: "1px solid var(--studio-border)", paddingBottom: 16 }}>
                    <h2 style={{ fontSize: 20, fontWeight: 800, color: "var(--studio-text-main)", margin: 0 }}>
                      Cài đặt &amp; Tham số Studio
                    </h2>
                    <p style={{ fontSize: 13, color: "var(--studio-text-sub)", marginTop: 4 }}>
                      Quản lý cấu hình đóng gói tập sách nói, giọng đọc TTS và tích hợp hạ tầng Private Cloud
                    </p>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 28 }}>
                    <div style={{ background: "var(--studio-surface)", border: "1px solid var(--studio-border)", borderRadius: 16, padding: 20 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--blue-subtle)", color: "var(--blue-text)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <HardDrive size={18} />
                        </div>
                        <div>
                          <strong style={{ fontSize: 14, color: "var(--studio-text-main)", display: "block" }}>Lưu trữ Cloudflare R2</strong>
                          <span style={{ fontSize: 12, color: "var(--studio-text-sub)" }}>Private S3 Bucket · Zero Egress Fee</span>
                        </div>
                      </div>
                      <p style={{ fontSize: 12.5, color: "var(--studio-text-sub)", lineHeight: 1.6, margin: 0 }}>
                        Kho lưu trữ an toàn cho toàn bộ file audio chapter, M4B và MP4. Link tải có chữ ký điện tử presigned tự hết hạn sau 300 giây.
                      </p>
                    </div>

                    <div style={{ background: "var(--studio-surface)", border: "1px solid var(--studio-border)", borderRadius: 16, padding: 20 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--emerald-subtle)", color: "var(--emerald-text)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <Cpu size={18} />
                        </div>
                        <div>
                          <strong style={{ fontSize: 14, color: "var(--studio-text-main)", display: "block" }}>Động cơ AI &amp; TTS</strong>
                          <span style={{ fontSize: 12, color: "var(--studio-text-sub)" }}>Edge-TTS &amp; Gemini Flash</span>
                        </div>
                      </div>
                      <p style={{ fontSize: 12.5, color: "var(--studio-text-sub)", lineHeight: 1.6, margin: 0 }}>
                        Giọng đọc chuẩn tiếng Việt: <code>vi-VN-HoaiMyNeural</code> và <code>vi-VN-NamMinhNeural</code>. Kết hợp Glossary Guard chống rò rỉ CJK.
                      </p>
                    </div>
                  </div>

                  {jobId && jobs.find((j) => j.id === jobId) ? (
                    <div>
                      <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--studio-text-main)", marginBottom: 12 }}>
                        Cấu hình tập sách đang chọn: {extractStoryTitle(jobs.find((j) => j.id === jobId)?.sourceUrl || "")}
                      </h3>
                      <SettingsForm
                        job={jobs.find((j) => j.id === jobId)!}
                        onSaved={async () => {
                          setJobsVersion((v) => v + 1);
                        }}
                      />
                    </div>
                  ) : (
                    <div style={{ padding: "20px", background: "#f8fafc", borderRadius: 12, color: "var(--studio-text-sub)", fontSize: 13, textAlign: "center" }}>
                      Chọn một tác phẩm từ Băng chuyền để chỉnh sửa cấu hình quy cách đóng gói tập M4B.
                    </div>
                  )}
                </div>
              )}
            </main>
          </div>
        </div>
      </div>

      {/* Persistent Bottom Audio Player ghim cố định ở đáy */}
      <AudioPlayerCard
        track={activeTrack}
        onPrev={handlePrevTrack}
        onNext={handleNextTrack}
        hasPrev={selectedChapterIdx > 0}
        hasNext={selectedChapterIdx < chapters.length - 1}
      />

      {/* Modal tạo truyện mới */}
      {showNewJobModal && (
        <div className="studio-modal-overlay" onClick={() => setShowNewJobModal(false)}>
          <div className="studio-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="studio-modal-header">
              <div>
                <h2 className="studio-modal-title">
                  Thêm truyện mới vào dây chuyền
                </h2>
                <p className="studio-modal-sub">
                  Dán URL mục lục truyện (hỗ trợ webnovel.vn, truyendich.space)
                </p>
              </div>
              <button
                type="button"
                className="studio-modal-close-btn"
                onClick={() => setShowNewJobModal(false)}
                aria-label="Đóng cửa sổ"
                title="Đóng (Esc)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            <div className="studio-modal-body">
              <CreateJobForm
                onCreated={(id) => {
                  chooseJob(id);
                  setJobsVersion((v) => v + 1);
                  setShowNewJobModal(false);
                  setCenterTab("progress");
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
