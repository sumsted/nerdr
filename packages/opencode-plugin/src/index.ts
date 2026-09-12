import type { Plugin } from "@opencode-ai/plugin";
import * as os from "node:os";
import * as path from "node:path";
import { BridgeClient } from "./bridge.js";
import type { AgentIdentity, AgentStatus, TerminalHint } from "@nerdr/protocol";

function collectTerminalHint(): TerminalHint {
  const hint: TerminalHint = {};
  if (process.env.TERM_PROGRAM) hint.termProgram = process.env.TERM_PROGRAM;
  if (process.env.TERM_PROGRAM_VERSION) hint.termProgramVersion = process.env.TERM_PROGRAM_VERSION;
  if (process.env.VSCODE_IPC_HOOK_CLI) hint.vscodeIpcHook = process.env.VSCODE_IPC_HOOK_CLI;
  if (process.env.TERM_SESSION_ID) hint.termSessionId = process.env.TERM_SESSION_ID;
  return hint;
}

function basename(value: string | undefined): string {
  if (!value) return "agent";
  const normalized = value.replace(/[/\\]+$/, "");
  return path.basename(normalized) || normalized || "agent";
}

function errorText(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const data = record.data as Record<string, unknown> | undefined;
    if (data && typeof data.message === "string") return data.message;
    if (typeof record.message === "string") return record.message;
    if (typeof record.name === "string") return record.name;
  }
  return undefined;
}

/** Tools that hand control to the human until they answer. */
function isInteractiveTool(tool: string | undefined): boolean {
  return tool === "question" || tool === "ask";
}

/** First readable label from the `question.asked` payload. */
function questionLabel(properties: unknown): string {
  const record = properties as { questions?: unknown } | undefined;
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  const first = questions[0] as { header?: unknown; question?: unknown } | undefined;
  if (first && typeof first.header === "string" && first.header) return first.header;
  if (first && typeof first.question === "string" && first.question) return first.question;
  return "Waiting for your answer";
}

/**
 * OpenCode plugin entry point.
 *
 * It opens a loopback connection to the Nerdr VSCodium extension and streams
 * lifecycle state for this OpenCode process. The unit of tracking is the
 * process (one terminal pane), matching Herdr's pane-oriented model.
 */
export const NerdrPlugin: Plugin = async ({ directory, serverUrl, project }) => {
  const pid = process.pid;
  // Name the agent after the workspace directory it was started in. This is not
  // OpenCode's session title, which is auto-generated and can change once the
  // first task completes.
  const repoRoot = project?.worktree;
  const worktree =
    repoRoot && repoRoot !== "/" && repoRoot !== directory ? repoRoot : undefined;
  const identity: AgentIdentity = {
    id: `pid:${pid}`,
    pid,
    title: basename(directory),
    directory,
    worktree,
    serverUrl: serverUrl?.toString(),
    version: process.env.OPENCODE_VERSION,
    host: os.hostname(),
    terminal: collectTerminalHint(),
  };

  const bridge = new BridgeClient(identity);
  bridge.start();

  let lastStatus: AgentStatus = "idle";
  const setStatus = (status: AgentStatus, message?: string, lastEvent?: string) => {
    if (status === lastStatus && !message) return;
    lastStatus = status;
    bridge.setState(status, message, lastEvent);
  };

  /** Patch identity only when a value actually changed, to avoid meta chatter. */
  const patchIdentityIfChanged = (patch: Partial<AgentIdentity>) => {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && (identity as unknown as Record<string, unknown>)[key] !== value) {
        changed = true;
        break;
      }
    }
    if (changed) bridge.patchIdentity(patch);
  };

  /**
   * Handles events whose names drifted between the SDK types we compile against
   * (1.18.21) and the runtime (1.18.30+). Returns true when the event was
   * consumed. Kept separate so the typed switch below stays type-safe.
   */
  const handleDriftedEvent = (event: unknown): boolean => {
    const e = event as { type?: string; properties?: any };
    switch (e?.type) {
      case "question.asked":
        setStatus("blocked", questionLabel(e.properties), "question.asked");
        return true;
      case "question.replied":
      case "question.rejected":
        setStatus("working", undefined, e.type);
        return true;
      case "permission.asked": {
        const title = e.properties?.title;
        setStatus("blocked", typeof title === "string" ? title : "Permission needed", "permission.asked");
        return true;
      }
      default:
        return false;
    }
  };

  return {
    event: async ({ event }) => {
      if (handleDriftedEvent(event)) return;
      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const info = event.properties.info;
          const slug = (info as { slug?: unknown }).slug;
          setStatus(lastStatus, undefined, event.type);
          bridge.patchIdentity({
            sessionID: info.id,
            slug: typeof slug === "string" ? slug : undefined,
          });
          break;
        }
        case "session.status": {
          const status = event.properties.status;
          if (status.type === "busy") {
            setStatus("working", undefined, event.type);
          } else if (status.type === "retry") {
            setStatus("working", `retrying (attempt ${status.attempt}): ${status.message}`, event.type);
          } else {
            setStatus("idle", undefined, event.type);
          }
          break;
        }
        case "session.idle":
          setStatus("done", undefined, event.type);
          break;
        case "permission.updated":
          setStatus("blocked", event.properties.title, event.type);
          break;
        case "permission.replied":
          setStatus("working", undefined, event.type);
          break;
        case "session.error": {
          setStatus("error", errorText(event.properties.error), event.type);
          break;
        }
        case "message.updated": {
          const info = event.properties.info;
          if (info.role === "assistant") {
            patchIdentityIfChanged({
              agent: info.mode,
              model: `${info.providerID}/${info.modelID}`,
            });
            if (!info.time.completed) {
              setStatus("working", undefined, event.type);
            }
          }
          break;
        }
        case "todo.updated":
          bridge.patchIdentity({});
          break;
        default:
          break;
      }
    },
    "chat.message": async (input) => {
      patchIdentityIfChanged({
        agent: input.agent,
        model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
      });
      setStatus("working", undefined, "chat.message");
    },
    "tool.execute.before": async (input) => {
      if (isInteractiveTool(input.tool)) {
        setStatus("blocked", `Waiting on ${input.tool}`, "tool.execute.before");
      } else {
        setStatus("working", undefined, "tool.execute.before");
      }
    },
    "tool.execute.after": async (input) => {
      if (isInteractiveTool(input.tool)) {
        setStatus("working", undefined, "tool.execute.after");
      }
    },
    "permission.ask": async (input) => {
      setStatus("blocked", input.title, "permission.ask");
    },
    dispose: async () => {
      bridge.close();
    },
  };
};

export default NerdrPlugin;
