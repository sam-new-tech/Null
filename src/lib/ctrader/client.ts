import { decode, encode, Payload, type WireMessage } from './protocol';

export type ConnectionState = 'closed' | 'connecting' | 'open';

interface Pending {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  graceTimer: ReturnType<typeof setInterval> | null;
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

  private stateListeners = new Set<(state: ConnectionState) => void>();
  private legacyStateHandler: ((state: ConnectionState) => void) | null = null;

  /** Backward-compat single handler (used by older call sites). */
  get onStateChange(): ((state: ConnectionState) => void) | null {
    return this.legacyStateHandler;
  }

  set onStateChange(fn: ((state: ConnectionState) => void) | null) {
    if (this.legacyStateHandler) this.stateListeners.delete(this.legacyStateHandler);
    this.legacyStateHandler = fn;
    if (fn) this.stateListeners.add(fn);
  }

  /** Production-safe multi-subscriber state listener. Never clobbers others. */
  onState(handler: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
      if (this.legacyStateHandler === handler) this.legacyStateHandler = null;
    };
  }

  /** True only when the socket can send right now. */
  get isOpen(): boolean {
    return this.state === 'open' && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(url: string): void {
    this.url = url;
    this.wantOpen = true;
    this.backoffMs = 1000;
    // A stale reconnect timer would open() a second socket after this one.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Drop any half-open socket from a previous generation first.
    try {
      this.ws?.close();
    } catch {
      // Ignore — a fresh socket replaces it below.
    }
    this.ws = null;
    this.open();
  }

  /**
   * Recycle a silent socket WITHOUT standing down the reconnect loop.
   * Unlike close(), the watcher re-opens and re-auths after this.
   */
  recycle(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.failPending(new Error('Connection recycled'));
    try {
      this.ws?.close();
    } catch {
      // Ignore — onclose schedules the reconnect below.
    }
    this.ws = null;
    if (this.wantOpen) {
      this.setState('connecting');
      this.reconnectTimer = setTimeout(() => this.open(), 1000);
    } else {
      this.setState('closed');
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.stateListeners.forEach((fn) => {
      try {
        fn(state);
      } catch {
        // One bad listener must not break the connection loop.
      }
    });
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
      const entry: Pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (entry.graceTimer) clearInterval(entry.graceTimer);
          this.pending.delete(clientMsgId);
          reject(new Error('Request timed out'));
        }, REQUEST_TIMEOUT_MS),
        graceTimer: null,
      };
      this.pending.set(clientMsgId, entry);
      const fail = (err: Error) => {
        this.pending.delete(clientMsgId);
        clearTimeout(entry.timer);
        if (entry.graceTimer) clearInterval(entry.graceTimer);
        reject(err);
      };
      const sendNow = () => {
        if (entry.graceTimer) {
          clearInterval(entry.graceTimer);
          entry.graceTimer = null;
        }
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
        entry.graceTimer = setInterval(() => {
          if (!this.ws || this.ws.readyState !== WebSocket.CONNECTING || Date.now() - waited > 5000) {
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
      const entry = this.pending.get(msg.clientMsgId)!;
      this.pending.delete(msg.clientMsgId);
      clearTimeout(entry.timer);
      if (entry.graceTimer) clearInterval(entry.graceTimer);
      if (msg.payloadType === Payload.ErrorRes) {
        const payload = (msg.payload ?? {}) as { errorCode?: string; description?: string };
        entry.reject(new Error(payload.description ?? payload.errorCode ?? 'Request failed'));
        return;
      }
      entry.resolve((msg.payload ?? {}) as Record<string, unknown>);
      return;
    }
    const set = this.handlers.get(msg.payloadType);
    // One throwing subscriber must not silence the rest of the frame.
    set?.forEach((handler) => {
      try {
        handler((msg.payload ?? {}) as Record<string, unknown>);
      } catch {
        // Engine handlers are fail-open; the stream stays usable.
      }
    });
  }

  private failPending(err: Error): void {
    this.pending.forEach((entry) => {
      clearTimeout(entry.timer);
      if (entry.graceTimer) clearInterval(entry.graceTimer);
      entry.reject(err);
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
