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

/** Actual wire format: { channel: "killmail"|"killlist"|"status", data: { event, ... } } */
type ServerMessage = {
  channel?: string;
  data?: {
    event?: string;
    killmail_id?: number;
    solar_system_id?: number;
    total_value?: number;
    is_npc?: boolean;
    is_solo?: boolean;
    killmail?: KilllistWsItem;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type KilllistWsItem = {
  killmail_id: number;
  killmail_time?: string;
  solar_system_id?: number;
  solar_system_name?: string;
  solar_system_security?: number;
  region_id?: number;
  region_name?: string;
  total_value?: number;
  is_npc?: boolean;
  is_solo?: boolean;
  attacker_count?: number;
  ship_name?: string;
  victim_character_name?: string;
  victim_corporation_name?: string;
  victim_alliance_name?: string;
  [key: string]: unknown;
};

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

      // Always subscribe to "all" for global killmail feed
      if (!this.activeTopics.has('all')) {
        this.activeTopics.add('all');
      }

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

    this.ws.onmessage = (event) => {
      this.handleRawMessage(event.data);
    };

    this.ws.onclose = (event) => {
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

    this.ws.onerror = () => {
      // The close event will follow; just log here
      console.error(`${LOG} WebSocket error`);
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

  private handleRawMessage(data: string | ArrayBuffer | Blob): void {
    let msg: ServerMessage;
    try {
      const raw = typeof data === 'string' ? data : String(data);
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      console.warn(`${LOG} failed to parse message`);
      return;
    }

    const channel = msg.channel;
    const payload = msg.data;

    if (channel === 'killlist' && payload?.killmail) {
      this.handleKilllistItem(payload.killmail);
    } else if (channel === 'killmail' && payload?.killmail_id) {
      this.handleCompactKillmail(payload);
    }
    // channel === 'status' — ignore silently
  }

  private handleKilllistItem(km: KilllistWsItem): void {
    if (!km || !km.killmail_id) return;

    // Convert to EveKillKillmail shape for buffer
    const normalized: EveKillKillmail = {
      killmail_id: km.killmail_id,
      kill_time: km.killmail_time,
      system_id: km.solar_system_id,
      system_name: km.solar_system_name,
      system_security: km.solar_system_security,
      region_id: km.region_id,
      region_name: km.region_name,
      total_value: km.total_value,
      is_npc: km.is_npc,
      is_solo: km.is_solo,
      victim: {
        character_name: km.victim_character_name,
        corporation_name: km.victim_corporation_name,
        alliance_name: km.victim_alliance_name,
        ship_name: km.ship_name,
      },
    };

    this.bufferKillmail(normalized);
  }

  private handleCompactKillmail(data: NonNullable<ServerMessage['data']>): void {
    const km: EveKillKillmail = {
      killmail_id: data.killmail_id!,
      system_id: data.solar_system_id as number | undefined,
      total_value: data.total_value,
      is_npc: data.is_npc,
      is_solo: data.is_solo,
    };

    this.bufferKillmail(km);
  }

  private wsKillCount = 0;

  private bufferKillmail(km: EveKillKillmail): void {
    this.wsKillCount++;
    // Log first kill and then every 100
    if (this.wsKillCount === 1 || this.wsKillCount % 100 === 0) {
      console.log(`${LOG} buffered ${this.wsKillCount} killmails (latest: ${km.killmail_id})`);
    }

    // Add to global buffer
    this.globalBuffer.push(km);

    // Index by system_id
    const systemId = km.system_id;
    if (systemId) {
      let buf = this.systemIndex.get(systemId);
      if (!buf) {
        buf = new RingBuffer(this.bufferSize);
        this.systemIndex.set(systemId, buf);
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
      const msg = JSON.stringify({ action: 'subscribe', topics });
      console.log(`${LOG} sending subscribe: ${topics.join(', ')}`);
      this.ws.send(msg);
    } catch (err) {
      console.error(`${LOG} failed to send subscribe:`, err);
    }
  }

  private sendUnsubscribe(topics: string[]): void {
    if (!this.ws || !this.connected) return;
    try {
      this.ws.send(JSON.stringify({ action: 'unsubscribe', topics }));
    } catch (err) {
      console.error(`${LOG} failed to send unsubscribe:`, err);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;

    const delay = this.reconnectDelay;
    // Only log at increasing intervals to avoid spamming
    if (delay <= 4_000 || delay >= 300_000) {
      console.log(`${LOG} reconnecting in ${Math.round(delay / 1000)}s`);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 300_000); // max 5 min
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
