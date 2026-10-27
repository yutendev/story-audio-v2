import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AudioPlayerCard } from "../src/AudioPlayerCard";

describe("AudioPlayerCard — Persistent Bottom Player", () => {
  beforeEach(() => {
    cleanup();
    // Mock HTMLMediaElement methods
    window.HTMLMediaElement.prototype.load = vi.fn();
    window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    window.HTMLMediaElement.prototype.pause = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const mockTrack = {
    title: "Chương 1: Khởi Đầu Mới",
    subTitle: "Kiếm Lai · Quyền 1",
    url: "/api/jobs/test-job/assets/audio-1/download",
    coverLabel: "KIẾM LAI",
  };

  it("render thông tin track audio và thanh scrubber đầy đủ", () => {
    render(<AudioPlayerCard track={mockTrack} hasPrev={true} hasNext={true} />);

    expect(screen.getByText("Chương 1: Khởi Đầu Mới")).toBeTruthy();
    expect(screen.getByText("Kiếm Lai · Quyền 1")).toBeTruthy();
    expect(screen.getAllByRole("slider").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("1x")).toBeTruthy();
  });

  it("chuyển đổi tốc độ phát playback speed khi bấm nút speed", () => {
    render(<AudioPlayerCard track={mockTrack} />);

    const speedBtn = screen.getByText("1x");
    fireEvent.click(speedBtn);
    expect(screen.getByText("1.25x")).toBeTruthy();

    fireEvent.click(screen.getByText("1.25x"));
    expect(screen.getByText("1.5x")).toBeTruthy();

    fireEvent.click(screen.getByText("1.5x"));
    expect(screen.getByText("2x")).toBeTruthy();

    fireEvent.click(screen.getByText("2x"));
    expect(screen.getByText("1x")).toBeTruthy();
  });

  it("gọi onPrev và onNext khi bấm nút điều hướng chương", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <AudioPlayerCard
        track={mockTrack}
        hasPrev={true}
        hasNext={true}
        onPrev={onPrev}
        onNext={onNext}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Chương trước" }));
    expect(onPrev).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Chương kế tiếp" }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("nhận phím tắt Space để Play/Pause", () => {
    render(<AudioPlayerCard track={mockTrack} />);

    // Bấm Space trên window
    fireEvent.keyDown(window, { code: "Space" });
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});
