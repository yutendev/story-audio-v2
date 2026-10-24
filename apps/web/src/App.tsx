// Story Audio Studio v2 — Giao diện 3 cột Hiện đại (Babuk E-Reader & Audio Workspace)
import { useState, useEffect } from "react";
import { CreateJobForm } from "./CreateJobForm";
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
  const [centerTab, setCenterTab] = useState<"reader" | "progress" | "library">("reader");
  const [activeNav, setActiveNav] = useState<"dashboard" | "library" | "settings">("dashboard");

  function chooseJob(next: string): void {
    saveSelectedJob(next);
    setJobId(next);
  }

  // Nạp danh sách jobs cho Carousel & Library
  useEffect(() => {
    let unmounted = false;
    fetchJobs(50)
      .then((res) => {
        if (!unmounted) {
          setJobs(res.items);
          if (!jobId && res.items.length > 0) {
            chooseJob(res.items[0].id);
          }
        }
      })
      .catch(() => {});
    return () => {
      unmounted = true;
    };
  }, [jobsVersion]);

  // Nạp danh sách chương khi jobId thay đổi
  useEffect(() => {
    if (!jobId) {
      setChapters([]);
      return;
    }
    let unmounted = false;
    fetchChapters(jobId, 300)
      .then((res) => {
        if (!unmounted) {
          setChapters(res.items);
          setSelectedChapterIdx(0);
          // Tìm chương đầu tiên có audio để nạp vào player
          const firstWithAudio = res.items.find((c) => c.audioAssetId);
          if (firstWithAudio) {
            const storyName = extractStoryTitle(
              jobs.find((j) => j.id === jobId)?.sourceUrl || ""
            );
            setActiveTrack({
              title: `Chương ${firstWithAudio.index}: ${firstWithAudio.title || `Chương ${firstWithAudio.index}`}`,
              subTitle: storyName || "Sách nói tiếng Việt",
              url: `/api/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(firstWithAudio.audioAssetId!)}/download`,
              coverLabel: storyName || "STORY AUDIO",
            });
          }
        }
      })
      .catch(() => {});
    return () => {
      unmounted = true;
    };
  }, [jobId, jobsVersion]);

  function handlePlayChapter(c: ChapterRow) {
    if (!c.audioAssetId || !jobId) return;
    const storyName = extractStoryTitle(
      jobs.find((j) => j.id === jobId)?.sourceUrl || ""
    );
    setActiveTrack({
      title: `Chương ${c.index}: ${c.title || `Chương ${c.index}`}`,
      subTitle: storyName || "Sách nói tiếng Việt",
      url: `/api/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(c.audioAssetId)}/download`,
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
          <div>
            <a href="#" className="studio-logo" onClick={(e) => { e.preventDefault(); setCenterTab("reader"); }}>
              <div className="studio-logo-icon">🎧</div>
              <span>Story Audio</span>
            </a>

            <nav>
              <ul className="studio-nav-list">
                <li>
                  <button
                    type="button"
                    className={`studio-nav-item ${activeNav === "dashboard" && centerTab === "reader" ? "active" : ""}`}
                    onClick={() => { setActiveNav("dashboard"); setCenterTab("reader"); }}
                  >
                    <span className="studio-nav-icon">🏠</span>
                    <span>Bàn làm việc</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className={`studio-nav-item ${centerTab === "progress" ? "active" : ""}`}
                    onClick={() => setCenterTab("progress")}
                  >
                    <span className="studio-nav-icon">⚡</span>
                    <span>Tiến độ Live</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className={`studio-nav-item ${centerTab === "library" ? "active" : ""}`}
                    onClick={() => { setActiveNav("library"); setCenterTab("library"); }}
                  >
                    <span className="studio-nav-icon">📚</span>
                    <span>Tủ sách</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className="studio-nav-item"
                    onClick={() => setShowNewJobModal(true)}
                  >
                    <span className="studio-nav-icon">➕</span>
                    <span>Thêm truyện</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className={`studio-nav-item ${activeNav === "settings" ? "active" : ""}`}
                    onClick={() => setActiveNav("settings")}
                  >
                    <span className="studio-nav-icon">⚙️</span>
                    <span>Cài đặt</span>
                  </button>
                </li>
              </ul>
            </nav>
          </div>

          <div className="studio-sidebar-footer">
            <div className="studio-system-badge">
              <div style={{ fontWeight: 700, color: "var(--studio-text-main)", marginBottom: 4 }}>
                Cloudflare R2 · Private
              </div>
              <div>Bảo mật $0 · Local Windows</div>
            </div>
          </div>
        </aside>

        {/* 2. KHU VỰC CHÍNH (TOPBAR + CENTER SPLIT + RIGHT RAIL) */}
        <div className="studio-main">
          {/* Topbar */}
          <header className="studio-topbar">
            <div className="studio-topbar-left">
              <div className="studio-pill">
                <span>📍 Windows Local Studio</span>
              </div>
              <div className="studio-pill-badge">
                <span>👑 Gemini Free & Edge-TTS</span>
              </div>
            </div>

            <div className="studio-topbar-right">
              <button
                type="button"
                className="studio-btn-primary"
                onClick={() => setShowNewJobModal(true)}
              >
                <span>➕</span>
                <span>Thêm truyện mới</span>
              </button>

              <button
                type="button"
                className="studio-icon-btn"
                title="Làm mới dữ liệu"
                onClick={() => setJobsVersion((v) => v + 1)}
              >
                🔄
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

          {/* Center Workspace & Right Rail */}
          <div className="studio-center-split">
            {/* Center Area: Carousel + Main Content (Reader / Progress / Library) */}
            <main className="studio-workspace-area">
              {/* Băng chuyền sách Continue Reading */}
              <JobCarousel
                jobs={jobs}
                selectedJobId={jobId}
                onSelectJob={(id) => chooseJob(id)}
              />

              {/* View Switcher Tabs */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--studio-border)", paddingBottom: 10 }}>
                <button
                  type="button"
                  onClick={() => setCenterTab("reader")}
                  style={{
                    padding: "6px 14px",
                    borderRadius: "12px",
                    border: "none",
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: "pointer",
                    background: centerTab === "reader" ? "var(--studio-text-main)" : "transparent",
                    color: centerTab === "reader" ? "#ffffff" : "var(--studio-text-sub)",
                  }}
                >
                  📖 Xưởng Đọc & Duyệt QA
                </button>
                <button
                  type="button"
                  onClick={() => setCenterTab("progress")}
                  style={{
                    padding: "6px 14px",
                    borderRadius: "12px",
                    border: "none",
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: "pointer",
                    background: centerTab === "progress" ? "var(--studio-text-main)" : "transparent",
                    color: centerTab === "progress" ? "#ffffff" : "var(--studio-text-sub)",
                  }}
                >
                  ⚡ Tiến Độ Chi Tiết & Logs
                </button>
                <button
                  type="button"
                  onClick={() => setCenterTab("library")}
                  style={{
                    padding: "6px 14px",
                    borderRadius: "12px",
                    border: "none",
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: "pointer",
                    background: centerTab === "library" ? "var(--studio-text-main)" : "transparent",
                    color: centerTab === "library" ? "#ffffff" : "var(--studio-text-sub)",
                  }}
                >
                  📚 Tủ Sách Đầy Đủ
                </button>
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

              {centerTab === "progress" && jobId && (
                <div>
                  <JobProgress jobId={jobId} />
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
            </main>

            {/* 3. CỘT PHẢI: TRÌNH PHÁT AUDIO & THÀNH PHẨM XUẤT BẢN */}
            <aside className="studio-audio-rail">
              {/* Audio Player Card (Now Playing) */}
              <AudioPlayerCard
                track={activeTrack}
                onPrev={handlePrevTrack}
                onNext={handleNextTrack}
                hasPrev={selectedChapterIdx > 0}
                hasNext={selectedChapterIdx < chapters.length - 1}
              />

              {/* Quick Outputs Library */}
              <div className="studio-quick-library">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <h3 style={{ fontSize: 14.5, fontWeight: 800, color: "var(--studio-text-main)", margin: 0 }}>
                    Thành phẩm xuất bản
                  </h3>
                  <span style={{ fontSize: 11, color: "var(--studio-text-sub)", fontWeight: 600 }}>
                    M4B & MP4
                  </span>
                </div>

                {jobId ? (
                  <JobOutputs jobId={jobId} />
                ) : (
                  <div style={{ fontSize: 12, color: "var(--studio-text-sub)", textAlign: "center", padding: "20px 0" }}>
                    Chọn một tác phẩm để xem kho thành phẩm.
                  </div>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>

      {/* Modal Drawer tạo truyện mới */}
      {showNewJobModal && (
        <div className="studio-modal-overlay" onClick={() => setShowNewJobModal(false)}>
          <div className="studio-modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 800, color: "var(--studio-text-main)", margin: 0 }}>
                  Thêm truyện mới vào dây chuyền
                </h2>
                <p style={{ fontSize: 12, color: "var(--studio-text-sub)", marginTop: 4 }}>
                  Dán URL mục lục truyện (hỗ trợ webnovel.vn, truyendich.space)
                </p>
              </div>
              <button
                type="button"
                className="studio-icon-btn"
                onClick={() => setShowNewJobModal(false)}
                style={{ fontSize: 18 }}
              >
                ✕
              </button>
            </div>

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
      )}
    </div>
  );
}
