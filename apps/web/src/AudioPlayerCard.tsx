// AudioPlayerCard — Persistent Bottom Audio Player chuẩn Modern Dev Studio & Spotify
import { useState, useRef, useEffect, useCallback } from "react";
import {
  Headphones,
  SkipBack,
  RotateCcw,
  Play,
  Pause,
  RotateCw,
  SkipForward,
  Volume2,
  VolumeX,
  Download,
} from "lucide-react";

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
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState(false);

  // Tự động nạp và phát khi đổi track url
  useEffect(() => {
    if (audioRef.current && track?.url) {
      audioRef.current.load();
      audioRef.current.playbackRate = playbackSpeed;
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  }, [track?.url]);

  // Đồng bộ playbackRate khi speed đổi
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  // Đồng bộ volume & mute
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  const togglePlay = useCallback(() => {
    if (!audioRef.current || !track) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => {});
    }
  }, [isPlaying, track]);

  const skip = useCallback(
    (seconds: number) => {
      if (!audioRef.current) return;
      audioRef.current.currentTime = Math.max(
        0,
        Math.min(duration, audioRef.current.currentTime + seconds)
      );
    },
    [duration]
  );

  // Bắt phím tắt Space, ArrowLeft, ArrowRight
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      if (
        activeTag === "input" ||
        activeTag === "textarea" ||
        activeTag === "select" ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        skip(-15);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        skip(15);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlay, skip]);

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

  function toggleSpeed() {
    const speeds = [1, 1.25, 1.5, 2];
    const nextIdx = (speeds.indexOf(playbackSpeed) + 1) % speeds.length;
    setPlaybackSpeed(speeds[nextIdx]);
  }

  function toggleMute() {
    setIsMuted((prev) => !prev);
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (v > 0 && isMuted) {
      setIsMuted(false);
    }
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
    <div className="studio-bottom-player">
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

      {/* 1. Track Info (Cột trái) */}
      <div className="studio-player-track-info">
        <div className="studio-player-thumb">
          <Headphones size={22} strokeWidth={2} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="studio-player-title" title={track?.title || "Chưa phát audio"}>
            {track?.title || "Chưa chọn audio"}
          </div>
          <div className="studio-player-sub" title={track?.subTitle}>
            {track?.subTitle || "Chọn chương đã TTS để bắt đầu nghe"}
          </div>
        </div>
      </div>

      {/* 2. Controls & Scrubber (Trung tâm) */}
      <div className="studio-player-center">
        <div className="studio-player-btns">
          <button
            type="button"
            onClick={onPrev}
            disabled={!hasPrev}
            className="studio-player-ctrl-btn"
            title="Chương trước"
            aria-label="Chương trước"
          >
            <SkipBack size={18} strokeWidth={1.8} />
          </button>

          <button
            type="button"
            onClick={() => skip(-15)}
            disabled={!track}
            className="studio-player-ctrl-btn"
            title="Lùi 15 giây (Phím mũi tên trái)"
            aria-label="Lùi 15 giây"
          >
            <RotateCcw size={16} strokeWidth={1.8} />
            <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 2 }}>15s</span>
          </button>

          <button
            type="button"
            onClick={togglePlay}
            disabled={!track}
            className="studio-btn-play-circle"
            title={isPlaying ? "Tạm dừng (Phím Space)" : "Phát (Phím Space)"}
            aria-label={isPlaying ? "Tạm dừng" : "Phát"}
          >
            {isPlaying ? (
              <Pause size={19} strokeWidth={2.4} />
            ) : (
              <Play size={19} strokeWidth={2.4} style={{ marginLeft: 2 }} />
            )}
          </button>

          <button
            type="button"
            onClick={() => skip(15)}
            disabled={!track}
            className="studio-player-ctrl-btn"
            title="Tiến 15 giây (Phím mũi tên phải)"
            aria-label="Tiến 15 giây"
          >
            <span style={{ fontSize: 11, fontWeight: 700, marginRight: 2 }}>15s</span>
            <RotateCw size={16} strokeWidth={1.8} />
          </button>

          <button
            type="button"
            onClick={onNext}
            disabled={!hasNext}
            className="studio-player-ctrl-btn"
            title="Chương kế tiếp"
            aria-label="Chương kế tiếp"
          >
            <SkipForward size={18} strokeWidth={1.8} />
          </button>
        </div>

        {/* Scrubber timeline */}
        <div className="studio-player-scrubber">
          <span className="studio-player-time">{formatTime(currentTime)}</span>
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
          <span className="studio-player-time">-{formatTime(remainingTime)}</span>
        </div>
      </div>

      {/* 3. Extra Utilities (Cột phải) */}
      <div className="studio-player-extra">
        {/* Speed toggle */}
        <button
          type="button"
          onClick={toggleSpeed}
          disabled={!track}
          className="studio-player-speed-btn"
          title="Tốc độ phát audio"
        >
          {playbackSpeed}x
        </button>

        {/* Volume slider & mute */}
        <div className="studio-player-volume-wrap">
          <button
            type="button"
            onClick={toggleMute}
            disabled={!track}
            className="studio-player-ctrl-btn"
            title={isMuted ? "Bật âm thanh" : "Tắt tiếng"}
          >
            {isMuted || volume === 0 ? (
              <VolumeX size={17} strokeWidth={1.8} />
            ) : (
              <Volume2 size={17} strokeWidth={1.8} />
            )}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={isMuted ? 0 : volume}
            onChange={handleVolumeChange}
            className="studio-player-volume-slider"
            disabled={!track}
            title={`Âm lượng: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
          />
        </div>

        {/* Quick Download */}
        {track?.url && (
          <a
            href={track.url}
            download
            className="studio-player-ctrl-btn"
            title="Tải audio chương này về máy"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Download size={17} strokeWidth={1.8} />
          </a>
        )}
      </div>
    </div>
  );
}

export const BottomAudioPlayer = AudioPlayerCard;

