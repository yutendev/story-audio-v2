"""T5.3 — provider interface cho LLM rewrite: port các phần hữu ích của Audio/viet_lai.py.

- Provider = lớp bọc 1 backend free (gemini mặc định, openrouter dự phòng).
  Chỉ DÙNG mock/fake trong test; thật chỉ chạy khi có API key trong env.
- Policy: chỉ cho phép backend FREE trong whitelist; chuyển provider phải khai
  báo tường minh (env/payload) — gốc định nghĩa "explicit and policy-checked".
- Retry classification (T5.7): RateLimited (429) → QUOTA_WAIT; AuthError
  (401/403/thiếu key) → PERMANENT; ProviderError khác (timeout, 5xx, JSON lạ)
  → transient: backoff bounded + jitter, slide provider; đầu ra rỗng = lỗi.
"""

from __future__ import annotations

import os
import random
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, Protocol

import requests

TEMPERATURE = 0.3  # giống bản cũ — cùng cấu hình model settings

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEVKIT_BASE_URL = os.environ.get("DEVKIT_BASE_URL", "https://agent.devkit.vn/v1")

DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"      # Google Generative Language v1beta model
DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-chat-v3-0324:free"  # env VIETLAI_OPENROUTER_MODEL
DEFAULT_DEVKIT_MODEL = "deepseek-r1-550b"          # env VIETLAI_DEVKIT_MODEL

GEMINI_MODEL_ALIASES = {
    "gemini-1.5-flash": "gemini-3.5-flash-lite",
    "gemini-1.5-pro": "gemini-3.5-flash",
    "gemini-2.0-flash": "gemini-3.5-flash-lite",
    "gemini-2.5-flash": "gemini-3.5-flash-lite",
    "gemini-2.5-flash-lite": "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite": "gemini-3.5-flash-lite",
}

# Policy: whitelist backend được phép dùng.
PROVIDER_POLICY = frozenset({"gemini", "openrouter", "devkit"})

# T5.7 — phân loại lỗi (encoded trong hệ exception, ai dùng biết ngay cách xử lý):
# - RateLimited (429)                       → stage phát quota_wait, Node lưu notBefore
#   + keyword hàng ngày/day → not_before trôi tới nửa đêm UTC (chờ bền vững);
#     không có keyword → rate-limit thường, not_before ngắn (chờ ~1 phút)
# - AuthError (401/403/thiếu key)           → PERMANENT, ném ngay không retry-spin
# - ProviderError khác (timeout, HTTP 5xx, JSON lạ) → backoff luỹ thừa BỊ CHẶN
#   + jitter (transient) rồi slide provider kế; cạn vòng → RETRYABLE ở tầng stage
# - đầu ra rỗng/nát                         → validate() đếm là attempt (bounded) → trượt QA

QUOTA_RETRY_AFTER_SECONDS = 60  # chờ tối thiểu cho rate-limit thường


class ProviderError(RuntimeError):
    """Lỗi backend/network — có thể thử lại hoặc đổi provider."""


class RateLimited(ProviderError):
    """429 — hết quota free. Node phải lưu notBefore và đợi, không retry spin."""


class AuthError(ProviderError):
    """Xác thực/cấu hình sai (401/403/thiếu key) — retry vô ích, dừng PERMANENT."""


class Provider(Protocol):
    name: str

    def complete(self, prompt: str) -> str: ...


_DAILY_KEYWORDS = ("daily", "per-day", "per_day", "hàng ngày", "hạn mức",
                   "resource_exhausted", "quota exceeded")


def quota_not_before(message: str) -> tuple[str, str]:
    """Phân loại lỗi quota từ message RateLimited đã wrap: (kind, not_before ISO Z).
    daily → nửa đêm UTC sau (chờ bền vững); rate → sau QUOTA_RETRY_AFTER_SECONDS."""
    t = message.lower()
    kind = "daily" if any(k in t for k in _DAILY_KEYWORDS) else "rate"
    now = datetime.now(timezone.utc)
    if kind == "daily":
        nb = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        nb = now + timedelta(seconds=QUOTA_RETRY_AFTER_SECONDS)
    return kind, nb.strftime("%Y-%m-%dT%H:%M:%SZ")


class GeminiProvider:
    name = "gemini"

    def __init__(self, model: str | None = None, api_key: str | None = None):
        self.model = model
        self.api_key = api_key

    def complete(self, prompt: str) -> str:
        key = self.api_key or os.environ.get("GEMINI_API_KEY")
        if not key:
            raise AuthError("thiếu GEMINI_API_KEY")
        model_raw = self.model or os.environ.get("VIETLAI_GEMINI_MODEL", DEFAULT_GEMINI_MODEL)
        model = GEMINI_MODEL_ALIASES.get(model_raw, model_raw)
        body = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": TEMPERATURE},
        }
        r = requests.post(GEMINI_URL.format(model=model),
                          headers={"x-goog-api-key": key}, json=body, timeout=180)
        if r.status_code == 429:
            raise RateLimited(f"gemini 429: {r.text[:120]}")
        if r.status_code in (401, 403, 404):
            raise AuthError(f"gemini HTTP {r.status_code} (key sai/hết hạn hoặc model không tồn tại): {r.text[:200]}")
        if r.status_code >= 400:
            raise ProviderError(f"gemini HTTP {r.status_code}: {r.text[:200]}")
        data = r.json()
        try:
            text = data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError):
            raise ProviderError(f"gemini trả về lạ: {str(data)[:200]}") from None
        return text


class OpenRouterProvider:
    name = "openrouter"

    def __init__(self, model: str | None = None, api_key: str | None = None):
        self.model = model
        self.api_key = api_key

    def complete(self, prompt: str) -> str:
        key = self.api_key or os.environ.get("OPENROUTER_API_KEY")
        if not key:
            raise AuthError("thiếu OPENROUTER_API_KEY")
        model = self.model or os.environ.get("VIETLAI_OPENROUTER_MODEL", DEFAULT_OPENROUTER_MODEL)
        r = requests.post(
            OPENROUTER_URL,
            headers={
                "Authorization": f"Bearer {key}",
                "HTTP-Referer": "https://storyaudio.local",
                "X-Title": "Story Audio",
            },
            json={"model": model, "temperature": TEMPERATURE,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=180,
        )
        if r.status_code == 429:
            raise RateLimited(f"openrouter 429: {r.text[:120]}")
        if r.status_code in (401, 403):
            raise AuthError(f"openrouter HTTP {r.status_code} (key sai/hết hạn): {r.text[:200]}")
        if r.status_code >= 400:
            raise ProviderError(f"openrouter HTTP {r.status_code}: {r.text[:200]}")
        data = r.json()
        try:
            text = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError):
            raise ProviderError(f"openrouter trả về lạ: {str(data)[:200]}") from None
        return text


class DevKitProvider:
    """DevKit AI provider — cổng kết nối chuẩn OpenAI (Base URL https://agent.devkit.vn/v1)."""

    name = "devkit"

    def __init__(self, model: str | None = None, api_key: str | None = None, base_url: str | None = None):
        self.model = model
        self.api_key = api_key
        self.base_url = base_url

    def complete(self, prompt: str) -> str:
        key = self.api_key or os.environ.get("DEVKIT_API_KEY")
        if not key:
            raise AuthError("thiếu DEVKIT_API_KEY")
        model = self.model or os.environ.get("VIETLAI_DEVKIT_MODEL", DEFAULT_DEVKIT_MODEL)
        base = (self.base_url or os.environ.get("DEVKIT_BASE_URL") or DEVKIT_BASE_URL).rstrip("/")
        url = f"{base}/chat/completions"
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "temperature": TEMPERATURE,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=180,
        )
        if r.status_code == 429:
            raise RateLimited(f"devkit 429: {r.text[:120]}")
        if r.status_code in (401, 403):
            raise AuthError(f"devkit HTTP {r.status_code} (key sai/hết hạn): {r.text[:200]}")
        if r.status_code >= 400:
            raise ProviderError(f"devkit HTTP {r.status_code}: {r.text[:200]}")
        data = r.json()
        try:
            message = data["choices"][0]["message"]
            text = message.get("content") or ""
            if not text and message.get("reasoning_content"):
                text = message["reasoning_content"]
        except (KeyError, IndexError, TypeError):
            raise ProviderError(f"devkit trả về lạ: {str(data)[:200]}") from None

        # DeepSeek R1 có thể sinh thẻ <think>...</think>, loại bỏ để văn bản không dính chuỗi suy luận
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
        return text


_PROVIDERS = {
    "gemini": GeminiProvider,
    "openrouter": OpenRouterProvider,
    "devkit": DevKitProvider,
}


def resolve_providers(
    explicit: str | None = None,
    ai_model: str | None = None,
    openrouter_api_key: str | None = None,
    gemini_api_key: str | None = None,
    devkit_api_key: str | None = None,
    devkit_base_url: str | None = None,
) -> list[Provider]:
    """Danh sách provider theo thứ tự thử. Mặc định: gemini → openrouter → devkit
    (chỉ nhận backend nào CÓ key). `explicit` (vd "gemini,openrouter,devkit") phải nằm trong
    whitelist policy, bất kể key — thiếu key thì provider đó sẽ lỗi rõ khi chạy."""

    def make(name: str) -> Provider:
        cls = _PROVIDERS.get(name)
        if cls is None:
            raise ValueError(
                f"provider '{name}' không nằm trong policy free-tier "
                f"(chỉ {', '.join(sorted(PROVIDER_POLICY))})"
            )
        if name == "openrouter":
            return cls(model=ai_model, api_key=openrouter_api_key)
        if name == "gemini":
            gem_model = ai_model if (ai_model and "gemini" in ai_model) else None
            return cls(model=gem_model, api_key=gemini_api_key)
        if name == "devkit":
            dk_model = ai_model if (ai_model and "gemini" not in ai_model) else None
            return cls(model=dk_model, api_key=devkit_api_key, base_url=devkit_base_url)
        return cls()

    if explicit is not None:
        names = [n.strip() for n in explicit.split(",") if n.strip()]
        if not names:
            raise ValueError("payload.providers rỗng")
        return [make(n) for n in names]

    order: list[Provider] = []
    if gemini_api_key or os.environ.get("GEMINI_API_KEY"):
        order.append(make("gemini"))
    if openrouter_api_key or os.environ.get("OPENROUTER_API_KEY"):
        order.append(make("openrouter"))
    if devkit_api_key or os.environ.get("DEVKIT_API_KEY"):
        order.append(make("devkit"))
    return order


# jitter mặc định: ±≤20% và ≤5s — chống thundering herd; test inject hằng số
def _default_jitter(d: float) -> float:
    return random.uniform(0, min(5.0, d * 0.2))


class LLMClient:
    """Port LLMClient của bản cũ: quay vòng backends, backoff luỹ thừa BỊ CHẶN
    (max_rounds) kèm jitter, tổng thời gian chờ chật vật nhưng không vô hạn.
    Phân loại: RateLimited → ném lên (stage phát quota_wait);
    AuthError → ném NGAY (retry vô ích, tầng stage trả PERMANENT);
    ProviderError khác / trả rỗng → slide sang provider kế; cạn vòng → ProviderError."""

    def __init__(self, providers: list[Provider], sleep: Callable[[float], None] = time.sleep,
                 backoff_base: float = 10, max_rounds: int = 4,
                 jitter: Callable[[float], float] | None = None):
        if not providers:
            raise ProviderError("không có provider nào cấu hình")
        self.providers = providers
        self.sleep = sleep
        self.backoff_base = backoff_base
        self.max_rounds = max_rounds
        self.jitter = jitter if jitter is not None else _default_jitter

    def complete(self, prompt: str) -> tuple[str, str, int]:
        """Trả (text, provider_name, số lần gọi). Cạn vòng mà không có đầu ra → ProviderError."""
        calls = 0
        backoff = self.backoff_base
        last: str | None = None
        for _ in range(self.max_rounds):
            for p in self.providers:
                calls += 1
                try:
                    text = p.complete(prompt)
                except RateLimited as e:
                    # giữ tên provider để Node biết backend nào hết quota
                    raise RateLimited(f"{p.name}: {e}") from e
                except AuthError as e:
                    # sai key/cấu hình là tĩnh — chuyển provider/backoff vô ích
                    raise AuthError(f"{p.name}: {e}") from e
                except Exception as e:  # noqa — trust boundary: mọi lỗi network/HTTP ở đây
                    last = f"{p.name}: {e}"
                    self.sleep(backoff + self.jitter(backoff))
                    backoff *= 2
                    continue
                if text and text.strip():
                    return text.strip(), p.name, calls
                last = f"{p.name}: trả về rỗng"
                self.sleep(backoff + self.jitter(backoff))
                backoff *= 2
        raise ProviderError(f"thử {calls} lần đều thất bại — lỗi cuối: {last}")
