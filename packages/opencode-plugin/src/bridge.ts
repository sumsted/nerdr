import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BRIDGE_DIRNAME,
  BRIDGE_FILE,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  encodeMessage,
  parseMessage,
} from "@nerdr/protocol";
import type {
  AgentIdentity,
  AgentStatus,
  BridgeInfo,
  ClientMessage,
  ServerMessage,
} from "@nerdr/protocol";

const HEARTBEAT_MS = 15_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 20_000;

function nerdrHome(): string {
  return process.env.NERDR_HOME || path.join(os.homedir(), BRIDGE_DIRNAME);
}

/**
 * Best-effort discovery of the extension's bridge. Prefers a live bridge file
 * written by the extension, falling back to `NERDR_PORT` or the default port.
 */
export function discoverBridge(): { port: number; token?: string } {
  const envPort = Number(process.env.NERDR_PORT);
  if (Number.isFinite(envPort) && envPort > 0) {
    return { port: envPort, token: process.env.NERDR_TOKEN };
  }
  try {
    const file = path.join(nerdrHome(), BRIDGE_FILE);
    const info = JSON.parse(fs.readFileSync(file, "utf8")) as BridgeInfo;
    if (info && Number.isFinite(info.port) && info.port > 0) {
      return { port: info.port, token: info.token };
    }
  } catch {
    // No bridge file yet; caller will retry.
  }
  return { port: DEFAULT_PORT };
}

/**
 * A resilient, non-blocking connection from one OpenCode process to the Nerdr
 * bridge. Messages sent while disconnected are queued (latest state wins).
 */
export class BridgeClient {
  private socket?: net.Socket;
  private buffer = "";
  private connected = false;
  private closed = false;
  private token?: string;
  private reconnectDelay = RECONNECT_MIN_MS;
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private pending = new Map<string, ClientMessage>();

  constructor(private readonly identity: AgentIdentity) {}

  start(): void {
    this.token = discoverBridge().token;
    this.connect();
    this.heartbeat = setInterval(() => this.send({ type: "ping", at: Date.now() }), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  setState(status: AgentStatus, message?: string, lastEvent?: string): void {
    this.send({
      type: "state",
      agentId: this.identity.id,
      status,
      message,
      attention: status === "blocked" || status === "error",
      lastEvent,
      at: Date.now(),
    });
  }

  patchIdentity(patch: Partial<AgentIdentity>): void {
    Object.assign(this.identity, patch);
    this.send({ type: "meta", agentId: this.identity.id, patch });
  }

  ping(): void {
    this.send({ type: "ping", at: Date.now() });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.write({ type: "bye", agentId: this.identity.id });
    try {
      this.socket?.end();
    } catch {
      // ignore
    }
  }

  private connect(): void {
    if (this.closed) return;
    const { port } = discoverBridge();
    const socket = net.connect({ host: "127.0.0.1", port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.unref();

    socket.on("connect", () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.buffer = "";
      this.write({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        token: this.token,
        agent: this.identity,
        snapshot: { status: "idle", lastEvent: "plugin.init" },
      });
      this.flush();
    });

    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        const message = parseMessage<ServerMessage>(line);
        if (message?.type === "error") {
          // Extension rejected us; nothing actionable beyond logging.
          console.error("[nerdr] bridge error:", message.message);
        }
      }
    });

    socket.on("error", (error) => {
      console.error("[nerdr] bridge socket error:", error.message);
    });

    socket.on("close", () => {
      this.connected = false;
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  private send(message: ClientMessage): void {
    if (this.connected) {
      this.write(message);
      return;
    }
    // Coalesce: state updates supersede earlier ones for the same agent.
    const key = message.type === "state" || message.type === "meta" ? message.type : JSON.stringify(message);
    this.pending.set(key, message);
  }

  private flush(): void {
    for (const message of this.pending.values()) this.write(message);
    this.pending.clear();
  }

  private write(message: ClientMessage): void {
    if (!this.socket || !this.connected) return;
    try {
      this.socket.write(encodeMessage(message));
    } catch {
      // Socket died between check and write; reconnect handles it.
    }
  }
}
