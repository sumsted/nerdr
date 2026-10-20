import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type * as vscode from "vscode";
import {
  BRIDGE_DIRNAME,
  BRIDGE_FILE,
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
  SnapshotPayload,
} from "@nerdr/protocol";

export interface BridgeHandlers {
  onHello(identity: AgentIdentity, snapshot: SnapshotPayload): void;
  onState(
    agentId: string,
    status: AgentStatus,
    message: string | undefined,
    attention: boolean | undefined,
    lastEvent: string | undefined,
  ): void;
  onMeta(agentId: string, patch: Partial<AgentIdentity>): void;
  onPing(agentId: string | undefined): void;
  onBye(agentId: string): void;
  onDisconnect(agentId: string | undefined): void;
}

interface ClientState {
  socket: net.Socket;
  agentId?: string;
  buffer: string;
}

let socketSeq = 0;

function bridgeFilePath(): string {
  const home = process.env.NERDR_HOME || path.join(os.homedir(), BRIDGE_DIRNAME);
  return path.join(home, BRIDGE_FILE);
}

/**
 * Loopback TCP server that receives state from OpenCode agent processes and
 * publishes bridge discovery info so plugins can find it.
 */
export class BridgeServer implements vscode.Disposable {
  private server?: net.Server;
  private readonly clients = new Map<number, ClientState>();
  /** Live bridge connections per agent (OpenCode may reload a plugin while the old one is still closing). */
  private readonly agentConnections = new Map<string, number>();
  private port = 0;
  private token = "";
  private disposed = false;

  constructor(private readonly handlers: BridgeHandlers) {}

  get currentPort(): number {
    return this.port;
  }

  async start(preferredPort: number): Promise<number> {
    this.token = randomBytes(16).toString("hex");
    this.port = await this.listen(preferredPort);
    this.writeBridgeFile();
    return this.port;
  }

  private listen(preferredPort: number, attempt = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const port = preferredPort + attempt;
      const server = net.createServer((socket) => this.onConnection(socket));
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && attempt < 20) {
          resolve(this.listen(preferredPort, attempt + 1));
          return;
        }
        reject(error);
      });
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        resolve(port);
      });
    });
  }

  private onConnection(socket: net.Socket): void {
    const id = ++socketSeq;
    this.clients.set(id, { socket, buffer: "" });
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.onData(id, chunk));
    socket.on("close", () => {
      const state = this.clients.get(id);
      this.clients.delete(id);
      if (state?.agentId) {
        if (this.releaseAgent(state.agentId)) this.handlers.onDisconnect(state.agentId);
      }
    });
    socket.on("error", () => {
      // The close handler performs cleanup.
    });
  }

  private onData(id: number, chunk: Buffer): void {
    const state = this.clients.get(id);
    if (!state) return;
    state.buffer += chunk.toString("utf8");
    let index: number;
    while ((index = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, index);
      state.buffer = state.buffer.slice(index + 1);
      const message = parseMessage<ClientMessage>(line);
      if (message) this.handleMessage(id, message);
    }
  }

  private handleMessage(id: number, message: ClientMessage): void {
    switch (message.type) {
      case "hello": {
        if (message.token && message.token !== this.token) {
          this.send(id, { type: "error", message: "invalid token" });
          // Close so the client re-discovers the (rotated) token and reconnects.
          const rejected = this.clients.get(id);
          try {
            rejected?.socket.end();
          } catch {
            // ignore
          }
          return;
        }
        const state = this.clients.get(id);
        if (!state) return;
        const firstConnection = this.trackAgent(state, message.agent.id);
        // A plugin hot-reload briefly keeps two sockets for the same location.
        // Only the first hello should replace the snapshot; the second must not
        // reset a working agent back to the plugin's initial `idle` snapshot.
        if (firstConnection) this.handlers.onHello(message.agent, message.snapshot);
        this.send(id, { type: "welcome", protocol: PROTOCOL_VERSION, at: Date.now() });
        break;
      }
      case "state":
        this.handlers.onState(
          message.agentId,
          message.status,
          message.message,
          message.attention,
          message.lastEvent,
        );
        break;
      case "meta":
        this.handlers.onMeta(message.agentId, message.patch);
        break;
      case "ping": {
        const state = this.clients.get(id);
        this.handlers.onPing(state?.agentId);
        this.send(id, { type: "pong", at: Date.now() });
        break;
      }
      case "bye": {
        const state = this.clients.get(id);
        const agentId = state?.agentId;
        if (!state || !agentId) break;
        state.agentId = undefined;
        if (this.releaseAgent(agentId)) this.handlers.onBye(agentId);
        break;
      }
    }
  }

  /**
   * Associate a socket with an agent. Returns true when this is the first live
   * connection for that agent.
   */
  private trackAgent(state: ClientState, agentId: string): boolean {
    if (state.agentId === agentId) return false;
    const previous = state.agentId;
    if (previous) {
      state.agentId = undefined;
      if (this.releaseAgent(previous)) this.handlers.onDisconnect(previous);
    }
    state.agentId = agentId;
    const count = (this.agentConnections.get(agentId) ?? 0) + 1;
    this.agentConnections.set(agentId, count);
    return count === 1;
  }

  /** Returns true when the agent no longer has any live connection. */
  private releaseAgent(agentId: string): boolean {
    const count = this.agentConnections.get(agentId) ?? 0;
    if (count <= 1) {
      this.agentConnections.delete(agentId);
      return count === 1;
    }
    this.agentConnections.set(agentId, count - 1);
    return false;
  }

  private send(id: number, message: ServerMessage): void {
    const state = this.clients.get(id);
    if (!state) return;
    try {
      state.socket.write(encodeMessage(message));
    } catch {
      // Socket is going away; cleanup happens on close.
    }
  }

  private writeBridgeFile(): void {
    const file = bridgeFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const info: BridgeInfo = {
      protocol: PROTOCOL_VERSION,
      port: this.port,
      token: this.token,
      pid: process.pid,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(file, JSON.stringify(info, null, 2));
  }

  private removeBridgeFile(): void {
    const file = bridgeFilePath();
    try {
      const info = JSON.parse(fs.readFileSync(file, "utf8")) as BridgeInfo;
      if (info.pid === process.pid) fs.unlinkSync(file);
    } catch {
      // Nothing to clean up.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeBridgeFile();
    for (const state of this.clients.values()) {
      try {
        state.socket.destroy();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.server?.close();
    this.server = undefined;
  }
}
