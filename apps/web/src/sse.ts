// T8.2 — stream SSE live: server ghi frame `id: <seq>` nên EventSource native TỰ
// reconnect với Last-Event-ID; đóng 60s của server cũng được retry tự động.
// onopen bắn cho MỌI lần kết nối mới (gồm reconnect) → caller refresh từ API.
// Không có EventSource (nền test/jsdom cũ) → no-op handle, UI vẫn chạy bằng fetch.
export interface SseEvent {
  seq: number;
  type: string;
}

export interface StreamHandle {
  close(): void;
}

export function openEventStream(
  url: string,
  handlers: { onEvent(ev: SseEvent): void; onConnected(): void },
): StreamHandle {
  const ES = globalThis.EventSource;
  if (!ES) return { close: () => undefined };
  const es = new ES(url);
  es.onopen = () => handlers.onConnected();
  es.onmessage = (msg: MessageEvent) => {
    try {
      const ev = JSON.parse(String(msg.data)) as SseEvent;
      if (ev && typeof ev.seq === "number" && typeof ev.type === "string") {
        handlers.onEvent(ev);
      }
    } catch {
      // frame hỏng → bỏ qua, refresh từ API vẫn giữ đúng trạng thái
    }
  };
  return {
    close: () => {
      es.onopen = null;
      es.onmessage = null;
      es.close();
    },
  };
}
