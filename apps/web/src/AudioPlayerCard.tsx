// AudioPlayerCard — Trình phát sách nói tương tác cao cấp (chuẩn giao diện Babuk)
import { useState, useRef, useEffect } from "react";

export interface AudioTrack {
  title: string;
  subTitle?: string;
  url: string;
  coverLabel?: string;
}

export function AudioPlayerCard({
  track,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
}: {
  track: AudioTrack | null;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (audioRef.current && track?.url) {
      audioRef.current.load();
      audioRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  }, [track?.url]);

  function togglePlay() {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  }

  function handleTimeUpdate() {
    if (!audioRef.current) return;
    setCurrentTime(audioRef.current.currentTime);
    setDuration(audioRef.current.duration || 0);
  }

  function handleSeek(e: React.MouseEvent<HTMLDivElement>) {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    audioRef.current.currentTime = ratio * duration;
    setCurrentTime(audioRef.current.currentTime);
  }

  function skip(seconds: number) {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, Math.min(duration, audioRef.current.currentTime + seconds));
  }

  function formatTime(sec: number): string {
    if (isNaN(sec) || sec <= 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const remainingTime = duration > currentTime ? duration - currentTime : 0;

  return (
    <div className="studio-player-card">
      {track && (
        <audio
          ref={audioRef}
          src={track.url}
          onTimeUpdate={handleTimeUpdate}
          onEnded={() => {
            setIsPlaying(false);
            if (hasNext && onNext) onNext();
          }}
        />
      )}

      {/* Book Cover with subtle acoustic badge */}
      <div className="studio-player-cover">
        <span style={{ fontSize: 32, marginBottom: 8 }}>🎧</span>
        <div style={{ fontWeight: 800, fontSize: 13, textTransform: "uppercase", letterSpacing: 1, opacity: 0.9 }}>
          {track?.coverLabel || "Story Audio"}
        </div>
        <div style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>Audiobook Edition</div>
      </div>

      {/* Title & Chapter Details */}
      <div className="studio-player-title" title={track?.title || "Chưa phát audio"}>
        {track?.title || "Chưa có audio"}
      </div>
      <div className="studio-player-sub">
        {track?.subTitle || "Chọn một chương đã TTS để bắt đầu nghe"}
      </div>

      {/* Scrubber Bar */}
      <div className="studio-scrubber-wrap">
        <div
          className="studio-scrubber-bar"
          onClick={handleSeek}
          role="slider"
          aria-valuenow={currentTime}
          aria-valuemax={duration}
          tabIndex={0}
        >
          <div className="studio-scrubber-progress" style={{ width: `${progressPercent}%` }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--studio-text-sub)", marginTop: 6, fontWeight: 600 }}>
          <span>{formatTime(currentTime)}</span>
          <span>-{formatTime(remainingTime)}</span>
        </div>
      </div>

      {/* Audio Playback Controls */}
      <div className="studio-player-controls">
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasPrev}
          style={{ background: "none", border: "none", cursor: hasPrev ? "pointer" : "default", opacity: hasPrev ? 1 : 0.4, fontSize: 18 }}
          title="Chương trước"
        >
          ⏮
        </button>

        <button
          type="button"
          onClick={() => skip(-15)}
          disabled={!track}
          style={{ background: "none", border: "none", cursor: track ? "pointer" : "default", opacity: track ? 1 : 0.4, fontSize: 16 }}
          title="Tua lùi 15 giây"
        >
          ↺ 15s
        </button>

        <button
          type="button"
          className="studio-btn-play"
          onClick={togglePlay}
          disabled={!track}
          style={{ opacity: track ? 1 : 0.5 }}
          title={isPlaying ? "Tạm dừng" : "Phát"}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>

        <button
          type="button"
          onClick={() => skip(15)}
          disabled={!track}
          style={{ background: "none", border: "none", cursor: track ? "pointer" : "default", opacity: track ? 1 : 0.4, fontSize: 16 }}
          title="Tua tới 15 giây"
        >
          15s ↻
        </button>

        <button
          type="button"
          onClick={onNext}
          disabled={!hasNext}
          style={{ background: "none", border: "none", cursor: hasNext ? "pointer" : "default", opacity: hasNext ? 1 : 0.4, fontSize: 18 }}
          title="Chương kế tiếp"
        >
          ⏭
        </button>
      </div>
    </div>
  );
}
