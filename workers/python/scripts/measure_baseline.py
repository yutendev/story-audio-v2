"""Script đo đạc Baseline cho Phase 0 — Story Audio v2.
Chạy offline hoàn toàn trên nguyên liệu Audio/nguon và Audio/viet_lai.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Đảm bảo UTF-8 cho stdout/stderr
for s in (sys.stdout, sys.stderr):
    s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "workers" / "python" / "src"))

from story_audio import actions
from story_audio.exit_codes import ExitCode
from story_audio.normalize import load_replacements, normalize_brackets, normalize_text, split_raw
from story_audio.qa import qa_check
from story_audio.rewrite import chunk_text, validate
from story_audio.tts import concat_mp3, tts_chunk_hash

SAMPLE_CH = "2845"
SRC_FILE = ROOT / "Audio" / "nguon" / "xich-tam-tuan-thien" / f"{SAMPLE_CH}.txt"
REWRITTEN_FILE = ROOT / "Audio" / "viet_lai" / "xich-tam-tuan-thien" / f"{SAMPLE_CH}.txt"
GLOSSARY_FILE = ROOT / "data" / "glossary.json"
REPLACE_FILE = ROOT / "data" / "replace.json"

def measure_chapter_2845():
    stats = {}
    print(f"=== ĐO BASELINE CHƯƠNG {SAMPLE_CH} ===")
    raw_text = SRC_FILE.read_text(encoding="utf-8")
    rewritten_text = REWRITTEN_FILE.read_text(encoding="utf-8")
    glossary = json.loads(GLOSSARY_FILE.read_text(encoding="utf-8")) if GLOSSARY_FILE.exists() else {}
    replacements = load_replacements(REPLACE_FILE) if REPLACE_FILE.exists() else {}

    # 1. Normalize
    t0 = time.perf_counter()
    title, paragraphs = split_raw(raw_text)
    cleaned = [normalize_text(normalize_brackets(p), replacements) for p in paragraphs]
    norm_text = "\n".join(cleaned) + "\n"
    t_norm = time.perf_counter() - t0
    stats["normalize_s"] = t_norm
    print(f"1. Normalize: {t_norm*1000:.3f} ms ({len(paragraphs)} đoạn)")

    # 2. Chunking (Rewrite chunking)
    t0 = time.perf_counter()
    chunks = chunk_text([title] + cleaned, max_chars=1500)
    t_chunk = time.perf_counter() - t0
    stats["chunking_s"] = t_chunk
    stats["chunk_count"] = len(chunks)
    print(f"2. Chunking (max 1500): {t_chunk*1000:.3f} ms ({len(chunks)} chunks)")

    # 3. Validate từng chunk (trên văn bản đã viết lại)
    t0 = time.perf_counter()
    rewritten_title, rewritten_paras = split_raw(rewritten_text)
    rw_chunks = chunk_text([rewritten_title] + rewritten_paras, max_chars=1500)
    val_fails = 0
    for i, (orig_c, rw_c) in enumerate(zip(chunks, rw_chunks)):
        subset = {k: v for k, v in glossary.items() if k in orig_c}
        probs = validate(orig_c, rw_c, subset)
        if probs:
            val_fails += 1
    t_val = time.perf_counter() - t0
    stats["validate_s"] = t_val
    stats["validate_failed_chunks"] = val_fails
    print(f"3. Validate {len(chunks)} chunks: {t_val*1000:.3f} ms (trượt: {val_fails})")

    # 4. QA Gate toàn chương
    t0 = time.perf_counter()
    qa_probs = qa_check(rewritten_text, raw_text, glossary)
    t_qa = time.perf_counter() - t0
    stats["qa_s"] = t_qa
    stats["qa_failed"] = len(qa_probs)
    stats["qa_problems"] = qa_probs
    print(f"4. QA Gate toàn chương: {t_qa*1000:.3f} ms (lỗi: {len(qa_probs)} - {qa_probs})")

    # 5. TTS Chunking & Mock Synthesis
    t0 = time.perf_counter()
    tts_chunks = chunk_text([rewritten_title] + rewritten_paras, max_chars=1500)
    stats["tts_chunk_count"] = len(tts_chunks)
    t_tts_chunk = time.perf_counter() - t0
    print(f"5. TTS Chunking: {t_tts_chunk*1000:.3f} ms ({len(tts_chunks)} TTS chunks)")

    # 6. Đoạn mẫu TTS Live thật (1 chunk để lấy độ trễ mạng thật)
    t0 = time.perf_counter()
    import edge_tts
    async def sample_tts():
        comm = edge_tts.Communicate(tts_chunks[0][:200], "vi-VN-HoaiMyNeural", rate="-10%")
        tmp_mp3 = Path("temp_bench.mp3")
        await comm.save(str(tmp_mp3))
        dur = 0.0
        if shutil.which("ffprobe"):
            res = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "json", str(tmp_mp3)], capture_output=True, text=True)
            dur = float(json.loads(res.stdout)["format"]["duration"])
        tmp_mp3.unlink(missing_ok=True)
        return dur
    
    try:
        audio_dur = asyncio.run(sample_tts())
        t_tts_live_sample = time.perf_counter() - t0
        stats["live_tts_sample_s"] = t_tts_live_sample
        stats["live_tts_sample_audio_dur"] = audio_dur
        print(f"6. Edge-TTS Network Latency (1 chunk 200 ký tự): {t_tts_live_sample:.2f} s (audio length: {audio_dur:.2f} s)")
    except Exception as e:
        stats["live_tts_sample_s"] = 0
        print(f"6. Edge-TTS Network Test skipped/failed: {e}")

    return stats

def measure_book_packaging():
    print("\n=== ĐO BASELINE ĐÓNG GÓI M4B 1 CUỐN MẪU (6 CHƯƠNG: 2845-2850) ===")
    # Dùng ffprobe và ffmpeg để tạo và đóng gói M4B từ 6 file dummy/sample
    tmp_pkg = Path("temp_pkg_bench")
    tmp_pkg.mkdir(exist_ok=True)
    parts_dir = tmp_pkg / "parts"
    parts_dir.mkdir(exist_ok=True)
    
    # Tạo 6 dummy audio files (1s mỗi file hoặc dùng mp3 thật)
    for i in range(1, 7):
        p = parts_dir / f"audio-{i:04d}.mp3"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "quiet", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "5", "-c:a", "libmp3lame", "-b:a", "48k", str(p)], check=True)

    from story_audio.package import build_concat_list, build_ffmetadata
    
    # 1. Đo duration ffprobe từng chương
    t0 = time.perf_counter()
    chapters_meta = []
    curr_ms = 0
    for i in range(1, 7):
        p = parts_dir / f"audio-{i:04d}.mp3"
        res = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(p)], capture_output=True, text=True, check=True)
        dur = float(json.loads(res.stdout)["format"]["duration"])
        end_ms = curr_ms + int(dur * 1000)
        chapters_meta.append({"title": f"Chương {2844+i}", "startMs": curr_ms, "endMs": end_ms})
        curr_ms = end_ms
    t_probe = time.perf_counter() - t0
    print(f"1. ffprobe 6 chương: {t_probe*1000:.2f} ms (tổng duration: {curr_ms/1000:.2f} s)")

    # 2. Concat list & FFMETADATA1
    t0 = time.perf_counter()
    meta_txt = build_ffmetadata("Xích Tâm Tuần Thiên - Tập Mẫu", chapters_meta)
    (tmp_pkg / "ffmetadata.txt").write_text(meta_txt, encoding="utf-8")
    
    lines = ["ffconcat version 1.0\n"]
    for i in range(1, 7):
        lines.append(f"file 'parts/audio-{i:04d}.mp3'\n")
    (tmp_pkg / "concat.txt").write_text("".join(lines), encoding="utf-8")
    t_meta = time.perf_counter() - t0
    print(f"2. Sinh metadata & concat list: {t_meta*1000:.3f} ms")

    # 3. ffmpeg muxing book.m4b (aac 96k, -f ipod)
    t0 = time.perf_counter()
    out_m4b = tmp_pkg / "book.m4b"
    cmd = [
        "ffmpeg", "-y", "-loglevel", "quiet",
        "-f", "concat", "-safe", "0", "-i", str(tmp_pkg / "concat.txt"),
        "-i", str(tmp_pkg / "ffmetadata.txt"),
        "-map_metadata", "1",
        "-c:a", "aac", "-b:a", "96k",
        "-f", "ipod", str(out_m4b)
    ]
    subprocess.run(cmd, check=True)
    t_mux = time.perf_counter() - t0
    print(f"3. ffmpeg muxing book.m4b: {t_mux*1000:.2f} ms (size: {out_m4b.stat().st_size} bytes)")

    # 4. ffprobe verification
    t0 = time.perf_counter()
    res = subprocess.run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_chapters", "-show_format", str(out_m4b)], capture_output=True, text=True, check=True)
    probe_out = json.loads(res.stdout)
    ch_count = len(probe_out.get("chapters", []))
    total_dur = float(probe_out["format"]["duration"])
    t_verify = time.perf_counter() - t0
    print(f"4. ffprobe verify book.m4b: {t_verify*1000:.2f} ms ({ch_count} chapters, {total_dur:.2f} s)")

    # Dọn dẹp
    shutil.rmtree(tmp_pkg, ignore_errors=True)

    return {
        "probe_s": t_probe,
        "meta_s": t_meta,
        "mux_s": t_mux,
        "verify_s": t_verify,
        "total_m4b_s": t_probe + t_meta + t_mux + t_verify
    }

if __name__ == "__main__":
    ch_stats = measure_chapter_2845()
    pkg_stats = measure_book_packaging()
    print("\nHoàn tất đo đạc baseline thành công!")
