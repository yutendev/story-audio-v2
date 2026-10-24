"""Path/config helpers (T1.4): không phụ thuộc cwd, chống escape, atomic write."""

import os
import tempfile
from pathlib import Path, PurePosixPath


class PathEscape(ValueError):
    """Path vi phạm rule của job: absolute, .., backslash, drive — từ chối luôn."""


def safe_rel(rel):
    """Chuẩn hoá đường dẫn tương đối (POSIX '/'-style) → PurePosixPath, hoặc PathEscape."""
    if not isinstance(rel, str) or not rel.strip():
        raise PathEscape(f"path rỗng: {rel!r}")
    if "\\" in rel or "\x00" in rel:
        raise PathEscape(f"path chứa backslash/NUL: {rel!r}")
    p = PurePosixPath(rel)
    if p.is_absolute() or p.root or (len(p.parts) and p.parts[0].endswith(":")):
        raise PathEscape(f"path tuyệt đối: {rel!r}")
    if ".." in p.parts:
        raise PathEscape(f"path chứa '..': {rel!r}")
    # Win32 hazard: part kết thúc dấu . hoặc khoảng trắng (hoặc chỉ gồm dấu .) là bất hợp lệ
    for pt in p.parts:
        if pt == "." or pt.endswith(".") or pt.endswith(" "):
            raise PathEscape(f"path element không hợp lệ trên Windows: {pt!r}")
    # shortcut: chưa chặn reserved device names (CON, NUL, COM1...) — Windows tự từ chối khi tạo file, bổ sung nếu cần
    if not p.parts:
        raise PathEscape("path phải có ít nhất 1 phần")
    return p


def safe_path(workdir, rel):
    """Workdir (đã abs) + rel → đường dẫn tuyệt đối nằm BÊN TRONG workdir."""
    workdir = Path(workdir).resolve()
    if not workdir.is_dir():
        raise PathEscape(f"workdir không tồn tại: {workdir}")
    relp = safe_rel(rel)
    target = workdir.joinpath(*relp.parts)
    resolved = target.resolve()
    # resolve() xử lý cả symlink; kiểm tra nằm trong workdir sau khi resolve
    if not (resolved == workdir or workdir in resolved.parents):
        raise PathEscape(f"path thoát khỏi workdir: {rel!r}")
    return target


def chapter_dir(workdir, chapter_no):
    """Quy ước layout trong workdir: chapters/NNNN/ — mọi stage dùng đúng 1 quy chuẩn.
    NNNN là VỊ TRÍ của chương trong job (1..N) — KHÔNG phải số chương gốc trên site."""
    if not isinstance(chapter_no, int) or isinstance(chapter_no, bool) or chapter_no < 1:
        raise PathEscape(f"chapter_no phải nguyên ≥ 1: {chapter_no!r}")
    return safe_path(workdir, f"chapters/{chapter_no:04d}")


def atomic_write(path, data):
    """Ghi file an toàn: tmp cùng thư mục → os.replace. Text: str→utf-8; bytes: ghi trực tiếp."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return path
