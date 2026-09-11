/**
 * Nerdr wire protocol.
 *
 * The OpenCode plugin (running inside an agent process) connects to the Nerdr
 * VSCodium extension over a loopback TCP socket and speaks newline-delimited
 * JSON. The extension is the server; each agent process is a client.
 *
 * This module is intentionally dependency-free so it can be bundled into both
 * the extension and the OpenCode plugin.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Default loopback port used when the bridge file is unavailable. */
export const DEFAULT_PORT = 27182;

/** Directory (relative to the user's home) that holds bridge discovery state. */
export const BRIDGE_DIRNAME = ".nerdr";

/** File name inside {@link BRIDGE_DIRNAME} describing the running bridge. */
export const BRIDGE_FILE = "bridge.json";

/**
 * Lifecycle status of a single agent. Mirrors the vocabulary used by Herdr so
 * the mental model transfers directly.
 *
 * - `working`  the agent is actively running a turn
 * - `blocked`  the agent is waiting on the human (e.g. a permission prompt)
 * - `idle`     the agent is running but has nothing in flight
 * - `done`     the agent just finished a turn and is ready for review
 * - `error`    the agent surfaced an error
 * - `unknown`  state could not be determined
 */
export type AgentStatus =
  | "working"
  | "blocked"
  | "idle"
  | "done"
  | "error"
  | "unknown";

/** Statuses that mean "the human should look at this". */
export const ATTENTION_STATUSES: AgentStatus[] = ["blocked", "error"];

/** Hints the plugin can read from its environment to help locate the terminal. */
export interface TerminalHint {
  /** Value of TERM_PROGRAM, e.g. "vscode". */
  termProgram?: string;
  /** Value of VSCODE_IPC_HOOK_CLI, unique per integrated terminal session. */
  vscodeIpcHook?: string;
  /** Value of TERM_SESSION_ID (macOS Terminal / some VS Code versions). */
  termSessionId?: string;
  /** Value of TERM_PROGRAM_VERSION. */
  termProgramVersion?: string;
}

/** Stable identity for one agent process. */
export interface AgentIdentity {
  /** Stable id, typically `pid:<pid>`. */
  id: string;
  /** OS process id of the OpenCode process. */
  pid: number;
  /** Human-friendly label, e.g. the session title or project folder name. */
  title: string;
  /** OpenCode session id, when known. */
  sessionID?: string;
  /** OpenCode agent/mode name, when known. */
  agent?: string;
  /** Current model as `provider/model`. */
  model?: string;
  /** Working directory the agent was started in. */
  directory: string;
  /** Git worktree root, when known. */
  worktree?: string;
  /** Loopback URL of the OpenCode server for this process. */
  serverUrl?: string;
  /** OpenCode version string. */
  version?: string;
  /** Hostname the agent runs on. */
  host: string;
  /** Environment hints for matching a VSCodium terminal. */
  terminal: TerminalHint;
}

/** A point-in-time view of an agent, as held by the extension. */
export interface AgentSnapshot {
  identity: AgentIdentity;
  status: AgentStatus;
  /** Human-readable detail, e.g. the permission request title. */
  message?: string;
  /** True when the agent wants the human to act. */
  attention: boolean;
  /** Time the agent was first seen (ms epoch). */
  startedAt: number;
  /** Time the agent was last updated (ms epoch). */
  updatedAt: number;
  /** Last raw OpenCode event type that drove a state change. */
  lastEvent?: string;
  /**
   * Whether the bridge currently has a live socket for this agent. Set by the
   * extension; `false` means the process exited or went silent.
   */
  online: boolean;
}

/** A labelled todo, useful for showing progress in the tree. */
export interface AgentTodo {
  content: string;
  status: string;
  priority: string;
}

/**
 * Extension -> plugin command frames. Additive to protocol v1: plugins that
 * predate this simply ignore unknown server frames.
 */
export type RenameCommand = {
  type: "command";
  command: "rename";
  /** Agent to rename. */
  agentId: string;
  /** New session title. */
  title: string;
  /** Correlation id echoed back in the result. */
  requestId: string;
};

export type ServerCommand = RenameCommand;

/** Plugin -> extension result for a command frame. */
export type CommandResultMessage = {
  type: "command.result";
  command: "rename";
  agentId: string;
  requestId: string;
  ok: boolean;
  error?: string;
};

/** Messages sent by the plugin to the extension. */
export type ClientMessage =
  | {
      type: "hello";
      protocol: typeof PROTOCOL_VERSION;
      token?: string;
      agent: AgentIdentity;
      snapshot: SnapshotPayload;
    }
  | {
      type: "state";
      agentId: string;
      status: AgentStatus;
      message?: string;
      attention?: boolean;
      lastEvent?: string;
      at: number;
    }
  | {
      type: "meta";
      agentId: string;
      patch: Partial<
        Pick<
          AgentIdentity,
          "title" | "sessionID" | "agent" | "model" | "worktree" | "serverUrl"
        >
      > & { todos?: AgentTodo[] };
    }
  | { type: "bye"; agentId: string }
  | { type: "ping"; at: number }
  | CommandResultMessage;

/** The mutable part of a snapshot that a `hello` carries. */
export interface SnapshotPayload {
  status: AgentStatus;
  message?: string;
  attention?: boolean;
  lastEvent?: string;
}

/** Messages sent by the extension to the plugin. */
export type ServerMessage =
  | { type: "welcome"; protocol: typeof PROTOCOL_VERSION; at: number }
  | { type: "pong"; at: number }
  | { type: "error"; message: string }
  | ServerCommand;

/** Contents of the bridge discovery file written by the extension. */
export interface BridgeInfo {
  protocol: typeof PROTOCOL_VERSION;
  port: number;
  token: string;
  /** PID of the extension host that owns the bridge. */
  pid: number;
  updatedAt: number;
}

/** Parse a newline-delimited JSON payload, returning `undefined` on garbage. */
export function parseMessage<T = ClientMessage>(line: string): T | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return undefined;
  }
}

/** Serialize a message into a single newline-terminated frame. */
export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}
