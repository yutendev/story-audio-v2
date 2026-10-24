"""Source adapters (T5.1) — MỘT interface chuẩn, bọc behavior đã kiểm của bản cũ.

Port nguyên tắc từ Audio/truyen_audio.py + Audio/tai_nguon.py (READ-ONLY):
- webnovel.vn       → #chapter-c, .reader__chapter, link "Chương sau",
                      marker khoá ("Đăng nhập để đọc ngay", "Click để xem"),
                      nội dung < 200 ký tự = khoá, lọc "nhóm dịch:"/URL-chính.
- truyendich.space  → section.prose-novel, lọc dòng "?…"/"Cảm tạ thư hữu",
                      < 3 đoạn = quá ngắn, title là "Chương N" (tổng hợp như cũ).

Quy tắc T5.1: KHÔNG thêm website mới; không vượt paywall — chương khoá phải
fail rõ ràng (LockedChapter), nguồn lạ → UnsupportedSource.
ChapterRecord: no (ID ổn định theo truyện), url nguồn gốc, title, paragraphs.
"""

from __future__ import annotations

import re
import subprocess
import time
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup
from bs4.element import Tag

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "vi,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

FETCH_TIMEOUT = 30
FETCH_RETRIES = 3

# webnovel: ngưỡng "quá ngắn" coi như khoá (bản cũ dùng 200 ký tự)
MIN_CHAPTER_CHARS = 200
LOCKED_MARKERS = ("Đăng nhập để đọc ngay", "Click để xem")


class UnsupportedSource(ValueError):
    """URL không thuộc adapter nào được hỗ trợ."""


class LockedChapter(RuntimeError):
    """Chương khoá/paywall — KHÔNG bypass; caller phải dừng hoặc bỏ qua."""


class BlockedPage(ValueError):
    """Trang trả về LẠ CẤU TRÚC (challenge Cloudflare, veil anti-scrape) — LỖI TẠM THỜI:
    fetch lại sau một khoảng nghỉ thường qua. Subclass ValueError để mọi chỗ cũ
    bắt ValueError vẫn hoạt động."""


class FetchError(RuntimeError):
    """Tải trang thất bại sau các lần thử."""


@dataclass
class ChapterRecord:
    no: int  # ID ổn định = số chương trong truyện
    url: str  # URL nguồn đúng của chương này
    title: str
    paragraphs: list[str]
    next_url: str | None = None  # chỉ webnovel có; truyendich đi theo số chương


Fetcher = Callable[[str], str]


def fetch_with_retries(get: Callable[[str], str], url: str, retries: int = FETCH_RETRIES,
                       sleep: Callable[[float], None] = time.sleep) -> str:
    """Vòng retry của bản cũ: 3 lần, backoff 2s/4s; hết → FetchError."""
    last: Exception | None = None
    for attempt in range(retries):
        try:
            return get(url)
        except requests.RequestException as e:  # HTTPError/Timeout/Connection... từ requests
            last = e
            if attempt < retries - 1:
                sleep(2 * (attempt + 1))
    raise FetchError(f"tải {url} thất bại sau {retries} lần: {last}")


def _curl_fetch(url: str) -> str:
    """Curl thật: nhiều site chặn fingerprint TLS của python-requests
    (truyendich.space: 307 /verify-human → 403) nhưng chấp nhận curl."""
    out = subprocess.run(
        ["curl", "-sS", "-L", "--compressed", "-A", HEADERS["User-Agent"], url],
        capture_output=True,
        timeout=FETCH_TIMEOUT + 5,
    )
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f"curl exit {out.returncode}: {out.stderr[:120]!r}")
    return out.stdout.decode("utf-8", errors="replace")


def requests_fetcher(session: requests.Session | None = None,
                     sleep: Callable[[float], None] = time.sleep) -> Fetcher:
    """Fetcher thật: session + HEADERS + timeout 30 + ép UTF-8 (trang không khai báo)."""
    sess = session or requests.Session()
    sess.headers.update(HEADERS)

    def get(url: str) -> str:
        try:
            r = sess.get(url, timeout=FETCH_TIMEOUT)
            r.raise_for_status()
        except requests.RequestException as e:
            try:
                return _curl_fetch(url)  # site chặn fingerprint TLS của requests → curl
            except Exception:
                raise e  # curl cũng hỏng → giữ lỗi gốc cho vòng retry ngoài
        r.encoding = "utf-8"  # requests đoán sai với trang không khai báo; site là UTF-8
        return r.text

    return lambda url: fetch_with_retries(get, url, sleep=sleep)


def _clean_url(url: str) -> str:
    return url.split("#")[0].split("?")[0].rstrip("/")


class SourceAdapter:
    """Interface thống nhất cho mọi nguồn. Con khai báo HOSTS + URL pattern + extract."""

    name: str = "?"
    HOSTS: tuple[str, ...] = ()
    # Chuỗi URL chương kế tính thuận (không cần nội dung chương trước)?
    # truyendich: đúng (+1 số chương); webnovel: sai (phải đọc link "Chương sau")
    # → extract chỉ resume-skip khi True.
    ARITHMETIC_CHAIN: bool = False

    name: str = "?"
    HOSTS: tuple[str, ...] = ()

    def parse_chapter_url(self, url: str) -> tuple[str, int]:
        """URL chương → (base để dựng URL chương khác, số chương). Lệch dạng → ValueError."""
        raise NotImplementedError

    def chapter_url(self, base: str, no: int) -> str:
        raise NotImplementedError

    def extract(self, html: str, url: str, chapter_no: int) -> ChapterRecord:
        """HTML chương → ChapterRecord. Khoá/nội dung hỏng → LockedChapter/ValueError."""
        raise NotImplementedError


class WebnovelVnAdapter(SourceAdapter):
    name = "webnovel-vn"
    HOSTS = ("webnovel.vn",)
    CH_RE = re.compile(r"^(https?://[^/]+/.+)/chuong-(\d+)$")

    def parse_chapter_url(self, url: str) -> tuple[str, int]:
        clean = _clean_url(url)
        m = self.CH_RE.match(clean)
        if not m:
            raise ValueError(f"không phải URL chương dạng .../chuong-N/: {url}")
        return m.group(1) + "/", int(m.group(2))

    def chapter_url(self, base: str, no: int) -> str:
        return f"{base}chuong-{no}/"

    def extract(self, html: str, url: str, chapter_no: int) -> ChapterRecord:
        soup = BeautifulSoup(html, "html.parser")
        container = soup.find(id="chapter-c")
        if container is None or not isinstance(container, Tag):
            raise ValueError("không tìm thấy khối nội dung (#chapter-c) trong trang")
        # Nhận diện marker khoá TRƯỚC khi dọn rác (giữ đúng behavior bản cũ)
        raw_text = container.get_text(" ", strip=True)

        title_el = soup.find(class_="reader__chapter")
        if title_el:
            title = title_el.get_text(" ", strip=True)
        elif soup.title:
            title = soup.title.get_text(strip=True).split(" - ")[0]
        else:
            title = ""

        next_url: str | None = None
        for a in soup.find_all("a", href=True):
            if a.get_text(" ", strip=True) == "Chương sau" and not a["href"].startswith("javascript:"):
                next_url = urljoin(url, a["href"])
                break

        # Khối chứa link/ảnh (banner truyện khác) bị bỏ cả khối
        for el in container.find_all(["p", "div"]):
            if not el.decomposed and el.find(["a", "img"]):
                el.decompose()
        for el in container.find_all(["script", "style", "a", "img", "iframe",
                                      "noscript", "ins", "aside", "button", "svg"]):
            if not el.decomposed:
                el.decompose()
        for br in container.find_all("br"):
            br.replace_with("\n")

        paragraphs: list[str] = []
        for line in container.get_text("\n").splitlines():
            line = line.strip()
            if not line:
                continue
            if re.match(r"^nhóm dịch\s*:", line, re.IGNORECASE):
                continue
            if line.startswith(("http://", "https://")):
                continue
            paragraphs.append(line)

        joined = " ".join(paragraphs)
        found = [mk for mk in LOCKED_MARKERS if mk in raw_text]
        locked = bool(found) or len(joined) < MIN_CHAPTER_CHARS
        if locked:
            reason = ", ".join(found) if found else "nội dung quá ngắn"
            raise LockedChapter(f"chương {chapter_no} bị khoá ({reason})")
        return ChapterRecord(no=chapter_no, url=url, title=title,
                             paragraphs=paragraphs, next_url=next_url)


class TruyendichAdapter(SourceAdapter):
    name = "truyendich"
    HOSTS = ("truyendich.space",)
    ARITHMETIC_CHAIN = True  # chương kế = số hiện tại + 1, không cần nội dung trang trước
    # Site thật chấp nhận CẢ hai dạng: /doc-truyen/<loại>/<slug>/chuong-N (cũ, có
    # segment "convert/...") lẫn /doc-truyen/<slug>/chuong-N (URL hiện thời thiếu loại).
    CH_RE = re.compile(r"^(https?://[^/]+/doc-truyen/(?:[^/]+/)?([^/]+))/chuong-(\d+)$")

    def parse_chapter_url(self, url: str) -> tuple[str, int]:
        clean = _clean_url(url)
        m = self.CH_RE.match(clean)
        if not m:
            raise ValueError(
                f"không phải URL chương truyendich.space dạng "
                f".../doc-truyen/[<loại>/]<slug>/chuong-N: {url}"
            )
        return m.group(1), int(m.group(3))

    def chapter_url(self, base: str, no: int) -> str:
        return f"{base}/chuong-{no}"

    def extract(self, html: str, url: str, chapter_no: int) -> ChapterRecord:
        soup = BeautifulSoup(html, "html.parser")
        section = soup.find("section", class_="prose-novel")
        if section is None or not isinstance(section, Tag):
            raise BlockedPage("không tìm thấy nội dung (section.prose-novel) — trang lạ hoặc bị chặn")
        paragraphs: list[str] = []
        for p in section.find_all("p"):
            line = p.get_text(" ", strip=True)
            if not line:
                continue
            if re.fullmatch(r"[?\.…\s]+", line):
                continue
            if line.startswith("Cảm tạ thư hữu"):
                continue
            paragraphs.append(re.sub(r"\s+", " ", line))
        if len(paragraphs) < 3:
            if len(paragraphs) == 0:
                raise BlockedPage(f"chương {chapter_no} không có nội dung (bị chặn/rate-limit tạm thời)")
            raise LockedChapter(f"chương {chapter_no} nội dung quá ngắn ({len(paragraphs)} đoạn)")
        # Bản cũ không lấy title từ trang — tổng hợp "Chương N"
        return ChapterRecord(no=chapter_no, url=url, title=f"Chương {chapter_no}",
                             paragraphs=paragraphs, next_url=None)


ADAPTERS: tuple[SourceAdapter, ...] = (WebnovelVnAdapter(), TruyendichAdapter())

_SUPPORT_LINE = ", ".join(a.name for a in ADAPTERS)


def resolve_adapter(url: str) -> SourceAdapter:
    host = (urlsplit(url).hostname or "").removeprefix("www.").lower()
    if not host:
        raise UnsupportedSource(f"URL không có hostname hợp lệ: {url}")
    for a in ADAPTERS:
        # Chọn adapter theo HOSTNAME (pattern webnovel phủ chung mọi đường chuong-N —
        # chọn theo pattern sẽ nhầm URL của truyendich); sai dạng → ValueError rõ ràng.
        if host in a.HOSTS:
            a.parse_chapter_url(url)
            return a
    raise UnsupportedSource(f"nguồn không được hỗ trợ (chỉ {_SUPPORT_LINE}): {url}")


def fetch_chapter(url: str, fetch: Fetcher | None = None) -> ChapterRecord:
    """1 chương về ChapterRecord (adapter tự nhận qua hostname)."""
    fetch = fetch or requests_fetcher()
    clean = _clean_url(url)
    adapter = resolve_adapter(clean)
    _, no = adapter.parse_chapter_url(clean)
    return adapter.extract(fetch(clean), clean, no)


def fetch_sequence(start_url: str, count: int, fetch: Fetcher | None = None) -> list[ChapterRecord]:
    """Duyệt `count` chương LIÊN TIẾP từ start_url → list (tiện gọi 1 phát)."""
    return list(iter_sequence(start_url, count, fetch=fetch))


def iter_sequence(start_url: str, count: int, fetch: Fetcher | None = None):
    """Generator: yield ChapterRecord TỪNG CHƯƠNG theo đúng thứ tự số chương.

    webnovel: đi theo link "Chương sau"; truyendich: +1 số chương.
    Khoá giữa chừng / fetch hỏng → LockedChapter/FetchError nhô lên SAU các
    record đã yield (caller giữ được phần đã tải, phần sau fail rõ ràng).
    """
    if count < 1:
        return
    fetch = fetch or requests_fetcher()
    clean = _clean_url(start_url)
    adapter = resolve_adapter(clean)
    base, cur = adapter.parse_chapter_url(clean)
    url = clean
    emitted = 0
    while emitted < count:
        html = fetch(url)
        rec = adapter.extract(html, url, cur)
        yield rec
        emitted += 1
        nxt = rec.next_url or adapter.chapter_url(base, cur + 1)
        url = _clean_url(nxt)
        # bản cũ: n = max(next_n, n + 1) — link lạ không được tua ngược
        _, cur = adapter.parse_chapter_url(url)
        cur = max(cur, rec.no + 1)
