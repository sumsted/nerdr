import type { Plugin } from "@opencode/plugin";
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

type Context = Plugin.Context;
type EventEnvelope = {
  type?: string;
  data?: Record<string, unknown>;
  location?: { directory?: string };
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Nerdr OpenCode plugin (OpenCode 2.0).
 *
 * Opens a loopback connection to the Nerdr VSCodium extension and streams
 * lifecycle state for this OpenCode process.
 *
 * The tracked unit is the OpenCode **location** (workspace), not the OS
 * process: OpenCode 2.x runs one long-lived service (`opencode serve
 * --service`) and loads this plugin once per location inside it. A
 * process-based identity would collide across every workspace served by that
 * daemon, so each location registers under its own directory.
 */
export default {
  id: "nerdr",
  async setup(ctx: Context): Promise<() => Promise<void>> {
    const directory = String(ctx.location.directory);
    // Name the agent after the workspace directory it was started in, not
    // OpenCode's auto-generated (and regenerated) session title.
    const canonical = ctx.location.project?.canonical
      ? String(ctx.location.project.canonical)
      : undefined;
    const worktree = canonical && canonical !== "/" && canonical !== directory ? canonical : undefined;

    const pid = process.pid;
    const identity: AgentIdentity = {
      // Unique per location, stable across plugin/daemon restarts.
      id: `loc:${directory}`,
      // PID of the shared OpenCode service, kept for display/debugging only.
      pid,
      title: basename(directory),
      directory,
      worktree,
      version: ctx.app.version,
      host: os.hostname(),
      terminal: collectTerminalHint(),
    };

    const bridge = new BridgeClient(identity);

    // The service keeps a location loaded (and this plugin running) even after
    // its terminal/TUI detaches, so we cannot rely on this process exiting.
    // Skip the service's own root location: it is not an agent workspace and
    // would otherwise surface as a phantom "home" row.
    const isRootLocation = directory === os.homedir() || directory === "/";
    if (!isRootLocation) bridge.start();

    const controller = new AbortController();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      bridge.close();
    };

    let lastStatus: AgentStatus = "idle";
    const setStatus = (status: AgentStatus, message?: string, lastEvent?: string) => {
      if (stopped) return;
      if (status === lastStatus && !message) return;
      lastStatus = status;
      bridge.setState(status, message, lastEvent);
    };

    const patchIdentityIfChanged = (patch: Partial<AgentIdentity>) => {
      if (stopped) return;
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined && (identity as unknown as Record<string, unknown>)[key] !== value) {
          bridge.patchIdentity(patch);
          return;
        }
      }
    };

    const handleEvent = (raw: unknown) => {
      if (stopped) return;
      const event = raw as EventEnvelope;
      // The service streams events for every location it serves; only react to
      // the events that belong to this location.
      const eventDirectory = asString(event.location?.directory);
      if (eventDirectory && eventDirectory !== directory) return;

      const data = (event.data ?? {}) as Record<string, any>;
      const sessionID = asString(data.sessionID);
      if (sessionID) patchIdentityIfChanged({ sessionID });

      switch (event.type) {
        case "session.status": {
          // `busy`/`retry` are authoritative. `idle` is not: OpenCode 2.x
          // emits it between steps while a turn is still running, so the step
          // events below own the working/done transition.
          const status = data.status as { type?: string; attempt?: number; message?: string } | undefined;
          if (status?.type === "busy") setStatus("working", undefined, event.type);
          else if (status?.type === "retry")
            setStatus("working", `retrying (attempt ${status.attempt}): ${status.message}`, event.type);
          break;
        }
        case "session.step.started":
          setStatus("working", undefined, event.type);
          break;
        case "session.step.ended": {
          const finish = asString(data.finish) ?? asString(data.rawFinish);
          if (finish === "tool-calls" || finish === "tool_calls") {
            // The assistant called tools; the turn continues with another step.
            setStatus("working", undefined, event.type);
          } else if (finish === "error") {
            setStatus("error", errorText(data.error), event.type);
          } else {
            setStatus("done", undefined, event.type);
          }
          break;
        }
        case "session.reasoning.started":
        case "session.tool.input.started":
        case "session.tool.called":
        case "session.tool.success":
        case "session.tool.error":
          setStatus("working", undefined, event.type);
          break;
        case "session.idle":
          setStatus("done", undefined, event.type);
          break;
        case "permission.asked": {
          const label = asString(data.message) ?? asString(data.action) ?? "Permission needed";
          setStatus("blocked", label, event.type);
          break;
        }
        case "permission.replied":
          setStatus("working", undefined, event.type);
          break;
        case "session.retry.scheduled":
          setStatus("working", `retrying (attempt ${data.attempt})`, event.type);
          break;
        case "session.execution.failed":
          setStatus("error", errorText(data.error), event.type);
          break;
        case "session.created": {
          const id = asString(data.id) ?? sessionID;
          if (id) patchIdentityIfChanged({ sessionID: id });
          break;
        }
        case "location.shutdown":
          // The workspace was torn down; tell the extension to drop the agent.
          stop();
          break;
        default:
          break;
      }
    };

    if (!isRootLocation) {
      // Hooks: prompt admission, tool execution, and permissions.
      await ctx.session.hook("prompt", () => {
        setStatus("working", undefined, "session.prompt");
      });
      await ctx.tool.hook("execute.before", (event) => {
        if (isInteractiveTool(event.tool)) {
          setStatus("blocked", `Waiting on ${event.tool}`, "tool.execute.before");
        } else {
          setStatus("working", undefined, "tool.execute.before");
        }
      });
      await ctx.tool.hook("execute.after", (event) => {
        if (isInteractiveTool(event.tool)) {
          setStatus("working", undefined, "tool.execute.after");
        }
      });

      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            handleEvent(event);
          }
        } catch {
          // Subscription aborted on cleanup, or the stream ended.
        }
      })();
    }

    return async () => {
      stop();
    };
  },
};
