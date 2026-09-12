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
      this.handlers.onDisconnect(state?.agentId);
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
          return;
        }
        const state = this.clients.get(id);
        if (state) state.agentId = message.agent.id;
        this.handlers.onHello(message.agent, message.snapshot);
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
      case "bye":
        this.handlers.onBye(message.agentId);
        break;
    }
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
