import { useEffect, useState } from "react";
import { Headphones, Video, FileText, Image, File, PackageCheck, Download, Play } from "lucide-react";
import { fetchDownloadLink, fetchJobAssets } from "./api";
import type { AssetRow, PresignedLink } from "./api";

const OUTPUT_KINDS: Record<string, string> = {
  m4b: "Sách nói (M4B)",
  mp4: "Video YouTube (MP4 16:9)",
  description: "Mô tả YouTube (description.txt)",
  thumbnail: "Ảnh bìa (thumbnail.jpg)",
};

const OUTPUT_DESCRIPTIONS: Record<string, string> = {
  m4b: "Audiobook hoàn chỉnh có chia mục lục từng chương để nghe trên app điện thoại",
  mp4: "Video chuẩn 16:9 kèm âm thanh & ảnh bìa",
  description: "Mốc thời gian (Timestamps) tương ứng từng chương",
  thumbnail: "Ảnh bìa kích thước 1280x720",
};

export function renderOutputIcon(kind: string) {
  const props = { size: 16, strokeWidth: 1.75, style: { marginRight: 6, verticalAlign: "middle" } };
  switch (kind) {
    case "m4b":
      return <Headphones {...props} className="text-emerald-600" />;
    case "mp4":
      return <Video {...props} className="text-blue-600" />;
    case "description":
      return <FileText {...props} className="text-slate-600" />;
    case "thumbnail":
      return <Image {...props} className="text-amber-600" />;
    default:
      return <File {...props} className="text-slate-500" />;
  }
}

export function isOutputAsset(asset: AssetRow): boolean {
  return asset.kind in OUTPUT_KINDS;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function JobOutputs({ jobId }: { jobId: string }) {
  const [items, setItems] = useState<AssetRow[] | null>(null);
  const [error, setError] = useState("");
  const [links, setLinks] = useState<Record<string, PresignedLink>>({});
  const [busy, setBusy] = useState("");

  async function refresh(): Promise<void> {
    setError("");
    try {
      setItems((await fetchJobAssets(jobId)).filter(isOutputAsset));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    setItems(null);
    setLinks({});
    void refresh();
  }, [jobId]);

  async function requestLink(assetId: string): Promise<void> {
    setError("");
    setBusy(assetId);
    try {
      const link = await fetchDownloadLink(jobId, assetId);
      setLinks((prev) => ({ ...prev, [assetId]: link }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (error && items === null) return <p role="alert">{error}</p>;
  if (items === null) return <p style={{ color: "var(--ink-muted)", fontSize: 13 }}>Đang nạp kho thành phẩm…</p>;
  return (
    <section aria-label="Thư viện output" className="card-modern" style={{ padding: "20px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <PackageCheck size={18} className="text-emerald-600" />
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: 0 }}>
              Thư viện output
            </h3>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
              — Thành phẩm sách nói đã hoàn thành
            </span>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            Nhấn "Lấy link tải" để tạo liên kết tải an toàn (liên kết bảo mật có hiệu lực trong 5 phút).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          style={{ fontSize: 11, padding: "5px 12px" }}
        >
          Làm mới
        </button>
      </div>

      {items.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "16px 0", textAlign: "center", padding: "16px", background: "#f8fafc", borderRadius: 12, border: "1px solid #e2e8f0" }}>
          Chưa có output nào (M4B/MP4 tạo sau khi đóng gói).
        </p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Tệp thành phẩm</th>
                <th scope="col">Mô tả tác dụng</th>
                <th scope="col">Dung lượng</th>
                <th scope="col">Tải về</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>
                    {renderOutputIcon(a.kind)}
                    {OUTPUT_KINDS[a.kind] ?? a.kind}
                  </td>
                  <td style={{ color: "var(--ink-muted)", fontSize: 11 }}>
                    {OUTPUT_DESCRIPTIONS[a.kind] ?? ""}
                  </td>
                  <td style={{ color: "var(--ink-muted)", fontFamily: "monospace" }}>
                    {fmtSize(a.size)}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <a
                        href={`/api/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(a.id)}/download?download=1`}
                        download
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          padding: "6px 14px",
                          background: "var(--jade)",
                          color: "#fff",
                          borderRadius: 6,
                          textDecoration: "none",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <Download size={14} /> Tải về máy
                      </a>
                      {(a.kind === "m4b" || a.kind === "chapter_audio") && (
                        <a
                          href={`/api/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(a.id)}/download`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            padding: "5px 12px",
                            background: "var(--primary)",
                            color: "#fff",
                            borderRadius: 6,
                            textDecoration: "none",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <Play size={14} /> Nghe online
                        </a>
                      )}
                      {links[a.id] ? (
                        <a
                          href={links[a.id].url}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: "var(--ink-muted)",
                            textDecoration: "underline",
                          }}
                        >
                          Tải ({links[a.id].expiresIn}s)
                        </a>
                      ) : (
                        <button
                          type="button"
                          disabled={busy !== ""}
                          onClick={() => void requestLink(a.id)}
                          style={{ fontSize: 10, padding: "4px 8px", background: "transparent", border: "1px dashed #cbd5e1", color: "var(--text-muted)" }}
                        >
                          {busy === a.id ? "…" : "Lấy link tải (5 phút)"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
