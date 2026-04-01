/**
 * EVE-KILL WebSocket client for real-time killmail streaming.
 *
 * Protocol:
 *   connect → info → subscribe → subscribed → killmail stream
 *   server sends ping every ~30s, client must reply pong within 5s
 *
 * Endpoint: wss://ws.eve-kill.com/killmails
 */

import { config } from '../config.js';
import type { EveKillKillmail } from './types.js';

const LOG = '[eve-kill-ws]';
const MAX_TOPICS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServerMessage =
  | { type: 'info'; validTopics: string[] }
  | { type: 'subscribed'; topics: string[] }
  | { type: 'unsubscribed'; topics: string[] }
  | { type: 'killmail'; data: EveKillKillmail }
  | { type: 'ping'; timestamp: number }
  | { type: 'error'; message?: string };

type KillmailHandler = (kill: EveKillKillmail) => void;

// ---------------------------------------------------------------------------
// Ring buffer helper
// ---------------------------------------------------------------------------

class RingBuffer<T> {
  private readonly items: T[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(item: T): void {
    if (this.items.length >= this.maxSize) {
      this.items.shift();
    }
    this.items.push(item);
  }

  getAll(): T[] {
    return [...this.items];
  }

  clear(): void {
    this.items.length = 0;
  }

  get length(): number {
    return this.items.length;
  }
}

// ---------------------------------------------------------------------------
// EveKillWS
// ---------------------------------------------------------------------------

export class EveKillWS {
  private ws: WebSocket | null = null;
  private activeTopics = new Set<string>();
  private pendingTopics = new Set<string>();
  private pendingUnsubscribes = new Set<string>();
  private handlers: KillmailHandler[] = [];

  /** Ring buffer per system_id for getRecentForSystem() */
  private systemIndex = new Map<number, RingBuffer<EveKillKillmail>>();

  /** Flat global buffer of all received killmails */
  private globalBuffer: RingBuffer<EveKillKillmail>;

  private reconnectDelay = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private connected = false;

  private readonly bufferSize: number;
  private readonly wsUrl: string;

  constructor() {
    this.bufferSize = config.eveKill.wsBufferSize;
    this.wsUrl = config.eveKill.wsUrl;
    this.globalBuffer = new RingBuffer(this.bufferSize);
  }

  // ── Lifecycle ──

  connect(): void {
    if (this.closed) return;
    if (this.ws) return;

    console.log(`${LOG} connecting to ${this.wsUrl}`);

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (err) {
      console.error(`${LOG} WebSocket constructor failed:`, err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log(`${LOG} connected`);
      this.connected = true;
      this.reconnectDelay = 1_000;

      // Re-subscribe active topics after reconnect
      if (this.activeTopics.size > 0) {
        this.sendSubscribe([...this.activeTopics]);
      }
      // Subscribe any topics queued while disconnected
      if (this.pendingTopics.size > 0) {
        this.sendSubscribe([...this.pendingTopics]);
        this.pendingTopics.clear();
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.connected = false;
      this.ws = null;
      const reason = event.reason || 'no reason';
      console.log(`${LOG} disconnected: code=${event.code} reason=${reason}`);

      // Policy violation or unsupported data — don't reconnect
      if (event.code === 1003 || event.code === 1008) {
        console.error(`${LOG} server rejected connection (code ${event.code}), not reconnecting`);
        return;
      }

      if (!this.closed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event: Event) => {
      // The close event will follow; just log here
      console.error(`${LOG} WebSocket error:`, (event as ErrorEvent).message ?? 'unknown');
    };
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      console.log(`${LOG} closing connection`);
      try {
        this.ws.close(1000, 'shutdown');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
  }

  // ── Topics ──

  subscribe(topics: string[]): void {
    if (topics.length === 0) return;

    const newTopics = topics.filter((t) => !this.activeTopics.has(t));
    if (newTopics.length === 0) return;

    // Enforce max topics
    const available = MAX_TOPICS - this.activeTopics.size;
    const toAdd = newTopics.slice(0, available);
    if (toAdd.length < newTopics.length) {
      console.warn(`${LOG} topic limit reached (${MAX_TOPICS}), dropped ${newTopics.length - toAdd.length} topics`);
    }

    if (this.connected && this.ws) {
      this.sendSubscribe(toAdd);
    } else {
      for (const t of toAdd) this.pendingTopics.add(t);
    }
    for (const t of toAdd) this.activeTopics.add(t);
    console.log(`${LOG} subscribe: ${toAdd.join(', ')} (total: ${this.activeTopics.size})`);
  }

  unsubscribe(topics: string[]): void {
    const toRemove = topics.filter((t) => this.activeTopics.has(t));
    if (toRemove.length === 0) return;

    for (const t of toRemove) {
      this.activeTopics.delete(t);
      this.pendingTopics.delete(t);
    }

    if (this.connected && this.ws) {
      this.sendUnsubscribe(toRemove);
    } else {
      for (const t of toRemove) this.pendingUnsubscribes.add(t);
    }
    console.log(`${LOG} unsubscribe: ${toRemove.join(', ')} (total: ${this.activeTopics.size})`);
  }

  getActiveTopics(): string[] {
    return [...this.activeTopics];
  }

  // ── Data access ──

  onKillmail(handler: KillmailHandler): void {
    this.handlers.push(handler);
  }

  getRecentForSystem(systemId: number): EveKillKillmail[] {
    const buf = this.systemIndex.get(systemId);
    return buf ? buf.getAll() : [];
  }

  /**
   * Get recent killmails involving a character (as victim or attacker).
   * Scans the global buffer.
   */
  getRecentForCharacter(characterId: number): EveKillKillmail[] {
    return this.globalBuffer.getAll().filter((km) => {
      if (km.victim?.character_id === characterId) return true;
      if (km.attackers?.some((a) => a.character_id === characterId)) return true;
      return false;
    });
  }

  // ── State ──

  isConnected(): boolean {
    return this.connected;
  }

  // ── Internal ──

  private handleMessage(event: MessageEvent): void {
    let msg: ServerMessage;
    try {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      console.warn(`${LOG} failed to parse message`);
      return;
    }

    switch (msg.type) {
      case 'info':
        console.log(`${LOG} server info: ${msg.validTopics?.length ?? 0} valid topics`);
        break;

      case 'subscribed':
        console.log(`${LOG} subscribed: ${msg.topics?.join(', ') ?? '?'}`);
        break;

      case 'unsubscribed':
        console.log(`${LOG} unsubscribed: ${msg.topics?.join(', ') ?? '?'}`);
        break;

      case 'ping':
        this.handlePing(msg.timestamp);
        break;

      case 'killmail':
        this.handleKillmail(msg.data);
        break;

      case 'error':
        console.error(`${LOG} server error: ${msg.message ?? 'unknown'}`);
        break;

      default:
        // Unknown message type — ignore
        break;
    }
  }

  private handlePing(timestamp: number): void {
    if (!this.ws || !this.connected) return;

    try {
      this.ws.send(JSON.stringify({ type: 'pong', timestamp }));
    } catch (err) {
      console.error(`${LOG} failed to send pong:`, err);
    }
  }

  private handleKillmail(km: EveKillKillmail): void {
    if (!km || !km.killmail_id) return;

    // Add to global buffer
    this.globalBuffer.push(km);

    // Index by system_id
    if (km.system_id) {
      let buf = this.systemIndex.get(km.system_id);
      if (!buf) {
        buf = new RingBuffer(this.bufferSize);
        this.systemIndex.set(km.system_id, buf);
      }
      buf.push(km);
    }

    // Clean stale system entries (keep at most 500 system keys)
    if (this.systemIndex.size > 500) {
      this.pruneSystemIndex();
    }

    // Notify handlers
    for (const handler of this.handlers) {
      try {
        handler(km);
      } catch (err) {
        console.error(`${LOG} killmail handler error:`, err);
      }
    }
  }

  private sendSubscribe(topics: string[]): void {
    if (!this.ws || !this.connected) return;
    try {
      this.ws.send(JSON.stringify({ type: 'subscribe', topics }));
    } catch (err) {
      console.error(`${LOG} failed to send subscribe:`, err);
    }
  }

  private sendUnsubscribe(topics: string[]): void {
    if (!this.ws || !this.connected) return;
    try {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', topics }));
    } catch (err) {
      console.error(`${LOG} failed to send unsubscribe:`, err);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;

    const delay = this.reconnectDelay;
    console.log(`${LOG} reconnecting in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
      this.connect();
    }, delay);
  }

  /**
   * Remove system index entries that have no recent kills,
   * keeping the most recently active systems.
   */
  private pruneSystemIndex(): void {
    // Simple approach: remove entries with smallest buffers
    const entries = [...this.systemIndex.entries()]
      .sort((a, b) => a[1].length - b[1].length);

    const toRemove = entries.slice(0, entries.length - 400);
    for (const [key] of toRemove) {
      this.systemIndex.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton instance — created on import, connect() called by app.ts
// ---------------------------------------------------------------------------

export const eveKillWs = new EveKillWS();
