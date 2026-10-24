// JobCarousel — Băng chuyền sách & công việc đang chạy (chuẩn "Continue Reading" Babuk)
import { extractStoryTitle } from "./JobsList";
import type { JobRow } from "./api";

const ADAPTER_TAGS: Record<string, string> = {
  "webnovel-vn-#chapter-c": "Webnovel.vn",
  "truyendich-space": "Truyendich.space",
};

export function JobCarousel({
  jobs,
  selectedJobId,
  onSelectJob,
}: {
  jobs: JobRow[];
  selectedJobId: string;
  onSelectJob: (id: string) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div style={{ marginBottom: 20 }}>
        <div className="studio-section-title">Tiếp tục đọc & nghe</div>
        <div style={{ background: "#f8fafc", padding: "24px", borderRadius: "16px", border: "1px dashed #cbd5e1", textAlign: "center", color: "var(--studio-text-sub)", fontSize: 13 }}>
          Chưa có tác phẩm nào trong thư viện. Bấm "+ Thêm truyện mới" để bắt đầu nạp truyện!
        </div>
      </div>
    );
  }

  const activeJob = jobs.find((j) => j.id === selectedJobId) || jobs[0];
  const otherJobs = jobs.filter((j) => j.id !== activeJob.id);
  const activeTitle = extractStoryTitle(activeJob.sourceUrl);
  const adapterName = ADAPTER_TAGS[activeJob.adapter] || activeJob.adapter;

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 className="studio-section-title" style={{ margin: 0 }}>
          Tiếp tục theo dõi & đọc sách
        </h2>
        <span style={{ fontSize: 12, color: "var(--studio-text-sub)", fontWeight: 600 }}>
          Tổng cộng: {jobs.length} tác phẩm
        </span>
      </div>

      <div className="studio-carousel">
        {/* Active Featured Card */}
        <div className="studio-featured-card">
          <div className="studio-cover-art">
            <span style={{ fontSize: 26, marginBottom: 4 }}>📖</span>
            <div style={{ fontSize: 10, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
              {activeTitle}
            </div>
            <div style={{ fontSize: 8.5, opacity: 0.75, marginTop: 4 }}>STORY AUDIO</div>
          </div>

          <div className="studio-featured-info">
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                <span className="studio-rating-pill">
                  ★ 4.8
                </span>
                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: activeJob.state === "completed" ? "#dcfce7" : "#eff6ff", color: activeJob.state === "completed" ? "#166534" : "#1e40af", fontWeight: 700 }}>
                  {activeJob.state}
                </span>
              </div>

              <h3 style={{ fontSize: 15, fontWeight: 800, color: "var(--studio-text-main)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={activeTitle}>
                {activeTitle}
              </h3>
              <p style={{ fontSize: 11.5, color: "var(--studio-text-sub)", margin: 0 }}>
                Nguồn: {adapterName} · Gói: {activeJob.chaptersPerBook}c/book
              </p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--studio-border)", fontSize: 11 }}>
              <div>
                <span style={{ color: "var(--studio-text-sub)", display: "block", fontSize: 10 }}>ĐỊNH DẠNG</span>
                <strong style={{ color: "var(--studio-text-main)" }}>M4B Audiobook</strong>
              </div>
              <div>
                <span style={{ color: "var(--studio-text-sub)", display: "block", fontSize: 10 }}>GIỌNG ĐỌC</span>
                <strong style={{ color: "var(--studio-text-main)" }}>Edge-TTS VN</strong>
              </div>
            </div>
          </div>
        </div>

        {/* Other books mini covers */}
        {otherJobs.slice(0, 4).map((j) => {
          const title = extractStoryTitle(j.sourceUrl);
          return (
            <div
              key={j.id}
              className={`studio-mini-book ${j.id === selectedJobId ? "selected" : ""}`}
              onClick={() => onSelectJob(j.id)}
              title={title}
            >
              <span style={{ fontSize: 24, marginBottom: 6 }}>📚</span>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--studio-text-main)", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", width: "100%" }}>
                {title}
              </div>
              <span style={{ fontSize: 9, color: "var(--studio-text-sub)", marginTop: 4 }}>
                {j.state}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
