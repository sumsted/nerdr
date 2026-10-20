import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ProcInfo {
  ppid: number;
  tty: string;
}

/**
 * Maps the numeric process id reported by an OpenCode agent to the VSCodium
 * integrated terminal that hosts it.
 *
 * VS Code exposes `terminal.processId` for the terminal's shell process. The
 * agent process is a descendant of that shell, so we walk the OS process tree
 * from the agent upwards until we hit a known terminal shell pid.
 */
export class TerminalLocator implements vscode.Disposable {
  private readonly terminalsByPid = new Map<number, vscode.Terminal>();
  private readonly processes = new Map<number, ProcInfo>();
  private readonly workdirs = new Map<number, string>();
  private workdirsAvailable = false;
  private refreshPromise?: Promise<void>;

  constructor(private readonly log: (message: string) => void) {}

  private readonly disposables: vscode.Disposable[] = [];

  watch(): void {
    this.disposables.push(
      vscode.window.onDidOpenTerminal(() => void this.refresh()),
      vscode.window.onDidCloseTerminal(() => void this.refresh()),
    );
  }

  refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<void> {
    await this.readProcessTable();
    await this.readWorkdirs();
    const next = new Map<number, vscode.Terminal>();
    for (const terminal of vscode.window.terminals) {
      let pid: number | undefined;
      try {
        pid = await terminal.processId;
      } catch {
        pid = undefined;
      }
      if (typeof pid === "number") next.set(pid, terminal);
    }
    this.terminalsByPid.clear();
    for (const [pid, terminal] of next) this.terminalsByPid.set(pid, terminal);
  }

  private async readProcessTable(): Promise<void> {
    if (process.platform === "win32") {
      this.log("terminal matching is not implemented on win32 yet");
      return;
    }
    // Build into a local map and swap at the end so a concurrent liveness
    // check never observes a half-cleared table.
    const next = new Map<number, ProcInfo>();
    try {
      const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,tty="], {
        maxBuffer: 8 * 1024 * 1024,
      });
      for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
        if (!match) continue;
        const pid = Number(match[1]);
        const ppid = Number(match[2]);
        const tty = match[3] ?? "??";
        if (Number.isFinite(pid)) next.set(pid, { ppid, tty });
      }
    } catch (error) {
      this.log(`failed to read process table: ${String(error)}`);
      return;
    }
    this.processes.clear();
    for (const [pid, info] of next) this.processes.set(pid, info);
  }

  private async readWorkdirs(): Promise<void> {
    if (process.platform === "win32") {
      this.workdirsAvailable = false;
      return;
    }
    // OpenCode 2.x serves every workspace from one shared `opencode serve`
    // process, so the plugin runs inside the daemon rather than the terminal.
    // Map each live `opencode` process to its working directory: the TUI
    // process carries the workspace as its cwd and a real tty, whereas the
    // daemon has no tty. This is what lets us tell whether a workspace still
    // has a live pane.
    const next = new Map<number, string>();
    try {
      const { stdout } = await execFileAsync(
        "lsof",
        ["-nP", "-a", "-d", "cwd", "-c", "opencode", "-F", "pn"],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      let pid: number | undefined;
      for (const line of stdout.split("\n")) {
        if (line.startsWith("p")) {
          const value = Number(line.slice(1));
          pid = Number.isFinite(value) ? value : undefined;
        } else if (line.startsWith("n") && pid !== undefined) {
          next.set(pid, line.slice(1));
        }
      }
    } catch (error) {
      this.log(`failed to read OpenCode working directories (lsof): ${String(error)}`);
      this.workdirsAvailable = false;
      return;
    }
    // Only mark the scan as authoritative once it has actually completed.
    this.workdirs.clear();
    for (const [pid, cwd] of next) this.workdirs.set(pid, cwd);
    this.workdirsAvailable = true;
  }

  private hasTty(info: ProcInfo | undefined): boolean {
    return !!info && info.tty !== "??" && info.tty !== "-";
  }

  /**
   * Whether a live OpenCode pane exists for the given workspace directory.
   * Returns `undefined` when liveness could not be determined (e.g. `lsof` is
   * unavailable), so callers do not mistake "unknown" for "gone".
   */
  hasLivePane(directory: string): boolean | undefined {
    if (!this.workdirsAvailable) return undefined;
    return this.findAgentPid(directory) !== undefined;
  }

  /** PID of a live OpenCode TUI process rooted in the given directory, if any. */
  findAgentPid(directory: string): number | undefined {
    if (!this.workdirsAvailable) return undefined;
    for (const [pid, cwd] of this.workdirs) {
      if (cwd === directory && this.hasTty(this.processes.get(pid))) return pid;
    }
    return undefined;
  }

  findTerminal(agentPid: number): vscode.Terminal | undefined {
    let pid = agentPid;
    for (let depth = 0; depth < 40 && pid > 0; depth += 1) {
      const terminal = this.terminalsByPid.get(pid);
      if (terminal) return terminal;
      const info = this.processes.get(pid);
      if (!info || info.ppid === pid) break;
      pid = info.ppid;
    }
    return undefined;
  }

  /** Terminals that currently host an agent process, by terminal object. */
  matchAll(agentPids: number[]): Map<number, vscode.Terminal> {
    const result = new Map<number, vscode.Terminal>();
    for (const pid of agentPids) {
      const terminal = this.findTerminal(pid);
      if (terminal) result.set(pid, terminal);
    }
    return result;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }
}
