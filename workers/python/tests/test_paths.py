import os
from pathlib import Path

import pytest

from story_audio.paths import PathEscape, atomic_write, chapter_dir, safe_path, safe_rel


@pytest.fixture
def workdir(tmp_path):
    wd = tmp_path / "work"
    wd.mkdir()
    return wd


@pytest.mark.parametrize("rel", [
    "chapters/0001/rewritten.txt",
    "chapters/0001/audio/part-000.mp3",
    "a/b/c.txt",
])
def test_safe_path_stays_inside_workdir(workdir, rel):
    p = safe_path(workdir, rel)
    assert str(p).startswith(str(workdir))


@pytest.mark.parametrize("rel", [
    "/etc/passwd",           # absolute
    "../outside.txt",        # traverse
    "a/../../b.txt",
    "a/../..",               # traverse về gốc
    "C:/Windows/system32",   # drive
    "a\\b.txt",              # backslash
    "", " ", " .",
])
def test_safe_path_rejects_escapes(workdir, rel):
    with pytest.raises(PathEscape):
        safe_path(workdir, rel)


def test_safe_rel_strict():
    assert str(safe_rel("x/y.txt")) == "x/y.txt"
    with pytest.raises(PathEscape):
        safe_rel("./hidden/../up")
    with pytest.raises(PathEscape):
        safe_rel("C:\\x")


def test_chapter_dir_layout(workdir):
    d = chapter_dir(workdir, 12)
    assert d == workdir / "chapters" / "0012"
    with pytest.raises(PathEscape):
        chapter_dir(workdir, 0)
    with pytest.raises(PathEscape):
        chapter_dir(workdir, True)


def test_atomic_write_text_and_bytes(workdir):
    p = atomic_write(workdir / "out" / "a.txt", "nội dung tiếng Việt")
    assert p.read_text(encoding="utf-8") == "nội dung tiếng Việt"
    assert not list((workdir / "out").glob("*.tmp"))

    # overwrite: nội dung mới thắng, không file rác
    atomic_write(p, "bản mới")
    assert p.read_text(encoding="utf-8") == "bản mới"
    assert not list((workdir / "out").glob("*.tmp"))

    pb = atomic_write(workdir / "b.bin", b"\x00\x01")
    assert pb.read_bytes() == b"\x00\x01"


def test_atomic_write_keeps_old_content_case(workdir):
    p = workdir / "x.txt"
    p.write_text("cũ", encoding="utf-8")
    # khối in-between: tmp tên ngẫu nhiên, replace success — không biến mất file
    atomic_write(p, "mới")
    assert p.read_text(encoding="utf-8") == "mới"


@pytest.mark.parametrize("cwd_sub", ["a", "b_làm_cho_rối"])
def test_outputs_independent_of_cwd(workdir, tmp_path, monkeypatch, cwd_sub):
    # chạy từ 2 CWD khác nhau, output luôn vào workdir cấp sẵn
    alt = tmp_path / cwd_sub
    alt.mkdir(exist_ok=True)
    monkeypatch.chdir(alt)
    p = atomic_write(workdir / "out" / f"{cwd_sub}.txt", "x")
    assert p == workdir / "out" / f"{cwd_sub}.txt"
    assert p.exists()
