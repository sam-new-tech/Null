import { decode, encode, Payload, type WireMessage } from './protocol';

export type ConnectionState = 'closed' | 'connecting' | 'open';

interface Pending {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 15000;
const HEARTBEAT_MS = 10000;

/**
 * Single WebSocket connection to a cTrader JSON endpoint.
 * One message in flight at a time is enforced by the server contract,
 * so sends are queued; responses correlate by clientMsgId.
 * Works on iOS, Android and web (no native modules).
 */
export class CTraderClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private handlers = new Map<number, Set<(payload: Record<string, unknown>) => void>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private url = '';
  private wantOpen = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  state: ConnectionState = 'closed';
  /** Timestamp of the last inbound frame (any type). */
  lastMessageAt = 0;

  onStateChange: ((state: ConnectionState) => void) | null = null;

  connect(url: string): void {
    this.url = url;
    this.wantOpen = true;
    this.backoffMs = 1000;
    this.open();
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.onStateChange?.(state);
  }

  private open(): void {
    if (!this.wantOpen) return;
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.setState('open');
      this.lastMessageAt = Date.now();
      this.backoffMs = 1000;
      this.startHeartbeat();
    };

    ws.onmessage = (event) => {
      try {
        const msg = decode(String(event.data));
        this.dispatch(msg);
      } catch {
        // Ignore malformed frames; the stream stays usable.
      }
    };

    const scheduleReconnect = () => {
      this.stopHeartbeat();
      this.failPending(new Error('Connection lost'));
      if (!this.wantOpen) {
        this.setState('closed');
        return;
      }
      this.setState('connecting');
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    };

    ws.onerror = () => {
      ws.close();
    };
    ws.onclose = () => {
      if (this.ws === ws) scheduleReconnect();
    };
  }

  close(): void {
    this.wantOpen = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.failPending(new Error('Connection closed'));
    this.ws?.close();
    this.ws = null;
    this.setState('closed');
  }

  /** Send a request and resolve with the matching response payload. */
  request(payloadType: number, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    // The server handles one message at a time: serialize all requests so
    // event bursts (fills + reconcile + closes) never stampede into timeouts.
    const run = this.chain.then(() => this.doRequest(payloadType, payload));
    this.chain = run.catch(() => {});
    return run;
  }

  private chain: Promise<unknown> = Promise.resolve();

  private doRequest(payloadType: number, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const raw = encode(payloadType, payload);
    const { clientMsgId } = JSON.parse(raw) as { clientMsgId: string };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new Error('Request timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(clientMsgId, { resolve, reject, timer });
      const fail = (err: Error) => {
        this.pending.delete(clientMsgId);
        clearTimeout(timer);
        reject(err);
      };
      const sendNow = () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          fail(new Error('Not connected'));
          return;
        }
        try {
          this.ws.send(raw);
        } catch (err) {
          fail(err instanceof Error ? err : new Error('Send failed'));
        }
      };
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        // Brief grace for an in-flight (re)connect instead of instant reject.
        const waited = Date.now();
        const iv = setInterval(() => {
          if (!this.ws || this.ws.readyState !== WebSocket.CONNECTING || Date.now() - waited > 5000) {
            clearInterval(iv);
            sendNow();
          }
        }, 100);
        return;
      }
      sendNow();
    });
  }

  /** Fire-and-forget (heartbeats, subscriptions responses are handled via on()). */
  send(payloadType: number, payload: Record<string, unknown> = {}): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(payloadType, payload));
    } catch {
      // Reconnect loop owns recovery.
    }
  }

  on(payloadType: number, handler: (payload: Record<string, unknown>) => void): () => void {
    let set = this.handlers.get(payloadType);
    if (!set) {
      set = new Set();
      this.handlers.set(payloadType, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  private dispatch(msg: WireMessage): void {
    this.lastMessageAt = Date.now();
    if (msg.clientMsgId && this.pending.has(msg.clientMsgId)) {
      const { resolve, reject, timer } = this.pending.get(msg.clientMsgId)!;
      this.pending.delete(msg.clientMsgId);
      clearTimeout(timer);
      if (msg.payloadType === Payload.ErrorRes) {
        const payload = (msg.payload ?? {}) as { errorCode?: string; description?: string };
        reject(new Error(payload.description ?? payload.errorCode ?? 'Request failed'));
        return;
      }
      resolve((msg.payload ?? {}) as Record<string, unknown>);
      return;
    }
    const set = this.handlers.get(msg.payloadType);
    set?.forEach((handler) => handler((msg.payload ?? {}) as Record<string, unknown>));
  }

  private failPending(err: Error): void {
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(err);
    });
    this.pending.clear();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.send(Payload.HeartbeatEvent, {});
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
