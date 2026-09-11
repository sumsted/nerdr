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
    this.processes.clear();
    if (process.platform === "win32") {
      this.log("terminal matching is not implemented on win32 yet");
      return;
    }
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
        if (Number.isFinite(pid)) this.processes.set(pid, { ppid, tty });
      }
    } catch (error) {
      this.log(`failed to read process table: ${String(error)}`);
    }
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
