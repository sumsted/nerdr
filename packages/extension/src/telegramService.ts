import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import {
  BRIDGE_DIRNAME,
  DEFAULT_TELEGRAM_LEADER_PORT,
  TELEGRAM_CONTROL_HEADER,
  TELEGRAM_CONTROL_TOKEN_FILE,
  TELEGRAM_CONFIG_FILE,
  TELEGRAM_LOG_FILE,
  TELEGRAM_PID_FILE,
  normalizeTelegramConfig,
  type TelegramConfig,
  type TelegramHealth,
} from "@nerdr/protocol";

const HEALTH_TIMEOUT_MS = 1500;
const execFileAsync = promisify(execFile);

function nerdrHome(): string {
  return process.env.NERDR_HOME || path.join(os.homedir(), BRIDGE_DIRNAME);
}

export function telegramDaemonPath(): string {
  return path.join(nerdrHome(), "nerdr-telegram.mjs");
}

function controlTokenPath(): string {
  return path.join(nerdrHome(), TELEGRAM_CONTROL_TOKEN_FILE);
}

function pidPath(): string {
  return path.join(nerdrHome(), TELEGRAM_PID_FILE);
}

function logPath(): string {
  return path.join(nerdrHome(), TELEGRAM_LOG_FILE);
}

function readConfig(): TelegramConfig | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(nerdrHome(), TELEGRAM_CONFIG_FILE), "utf8"),
    ) as unknown;
    return normalizeTelegramConfig(raw);
  } catch {
    return undefined;
  }
}

function readControlToken(): string | undefined {
  try {
    const token = fs.readFileSync(controlTokenPath(), "utf8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function readPid(): number | undefined {
  try {
    const pid = Number(fs.readFileSync(pidPath(), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Guard against killing an unrelated process after pid reuse. */
async function isDaemonProcess(pid: number): Promise<boolean> {
  if (process.platform === "win32") return true;
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "command="],
      { timeout: 1500 },
    );
    return /nerdr-telegram/.test(stdout);
  } catch {
    return false;
  }
}

function clearStalePid(): void {
  try {
    fs.rmSync(pidPath(), { force: true });
  } catch {
    // Best effort.
  }
}

/** True when something is listening on the loopback port, even if unhealthy. */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(800, () => done(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function telegramLeaderPort(config?: TelegramConfig): number {
  return config?.leaderPort ?? DEFAULT_TELEGRAM_LEADER_PORT;
}

export async function telegramDaemonHealth(
  port?: number,
): Promise<TelegramHealth | undefined> {
  const target = port ?? telegramLeaderPort(readConfig());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${target}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<TelegramHealth> | undefined;
    // The legacy plugin-hosted bridge answers /health with a different shape.
    // Treat it as "not the daemon" so Start can report the held port instead of
    // pretending the new daemon is running.
    if (!body || typeof body !== "object" || !body.daemonVersion || !body.opencode) {
      return undefined;
    }
    return body as TelegramHealth;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function controlRequest(
  port: number,
  pathname: string,
  token: string | undefined,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: token ? { [TELEGRAM_CONTROL_HEADER]: token } : {},
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask a running daemon to reload its config after the extension writes it. */
export async function reloadTelegramDaemon(port: number): Promise<boolean> {
  return controlRequest(port, "/reload", readControlToken());
}

/**
 * Copy the bundled daemon into ~/.nerdr. Overwriting is safe: a running
 * process has already loaded the module. The rename keeps the target atomic.
 */
function deployDaemon(log: (message: string) => void): string {
  const source = path.join(__dirname, "..", "bin", "nerdr-telegram.mjs");
  const target = telegramDaemonPath();
  if (!fs.existsSync(source)) {
    throw new Error(
      `the daemon bundle is missing (${source}); run "npm run build" before starting it`,
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.copyFileSync(source, tmp);
  fs.chmodSync(tmp, 0o700);
  try {
    fs.renameSync(tmp, target);
  } catch {
    fs.rmSync(target, { force: true });
    fs.renameSync(tmp, target);
  }
  log(`telegram: deployed daemon to ${target}`);
  return target;
}

function spawnDaemon(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): void {
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true, mode: 0o700 });
    fd = fs.openSync(logPath(), "a", 0o600);
  } catch {
    // Fall back to discarding stdio.
  }
  const child = spawn(command, args, {
    env,
    detached: true,
    stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"],
  });
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch {
      // Best effort.
    }
  }
  child.on("error", (error) => {
    log(`telegram: daemon spawn failed (${command}): ${error.message}`);
  });
  child.unref();
  log(`telegram: daemon spawned (${command}, pid ${child.pid ?? "?"})`);
}

/** Start the standalone daemon and wait for its health endpoint. */
export async function startTelegramDaemon(
  log: (message: string) => void,
  options: { port?: number; force?: boolean } = {},
): Promise<TelegramHealth | undefined> {
  const config = readConfig();
  if (!config) {
    throw new Error("Telegram is not configured; run “Nerdr: Configure Telegram” first");
  }
  const port = options.port ?? telegramLeaderPort(config);
  const existing = await telegramDaemonHealth(port);
  if (existing && !options.force) {
    log(`telegram: daemon already running on 127.0.0.1:${port}`);
    return existing;
  }
  if (existing && options.force) {
    await stopTelegramDaemon(log, port);
  }

  const existingPid = readPid();
  if (existingPid && isAlive(existingPid) && (await isDaemonProcess(existingPid))) {
    log(`telegram: daemon pid ${existingPid} is already running; waiting for health`);
    const health = await waitForHealth(port, 8000);
    if (health) return health;
    if (await portOpen(port)) {
      throw new Error(
        `port ${port} is held by another process (likely the old plugin); restart OpenCode once to release it`,
      );
    }
    throw new Error(
      `daemon pid ${existingPid} is alive but did not answer on 127.0.0.1:${port}; see ${logPath()}`,
    );
  }
  if (existingPid) clearStalePid();

  deployDaemon(log);
  const env = {
    ...process.env,
    NERDR_HOME: nerdrHome(),
    ELECTRON_RUN_AS_NODE: "1",
  };
  spawnDaemon(process.execPath, [telegramDaemonPath()], env, log);

  let health = await waitForHealth(port, 6000);
  if (health) return health;

  // VSCodium's Electron normally runs as Node with ELECTRON_RUN_AS_NODE. Fall
  // back to a system node if that path is unavailable.
  log("telegram: Electron runtime did not start the daemon; trying system node");
  spawnDaemon("node", [telegramDaemonPath()], { ...process.env, NERDR_HOME: nerdrHome() }, log);
  health = await waitForHealth(port, 6000);
  if (health) return health;

  if (await portOpen(port)) {
    throw new Error(
      `port ${port} is held by another process (likely the old plugin); restart OpenCode once to release it`,
    );
  }
  throw new Error(
    `the daemon did not answer on 127.0.0.1:${port}; see ${logPath()}`,
  );
}

async function waitForHealth(
  port: number,
  timeoutMs: number,
): Promise<TelegramHealth | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(250);
    const health = await telegramDaemonHealth(port);
    if (health) return health;
  }
  return undefined;
}

/** Stop the daemon cleanly, falling back to signals when it is unresponsive. */
export async function stopTelegramDaemon(
  log: (message: string) => void,
  port?: number,
): Promise<boolean> {
  const target = port ?? telegramLeaderPort(readConfig());
  const health = await telegramDaemonHealth(target);
  const pid = health?.pid ?? readPid();
  const token = readControlToken();

  if (health && token) {
    const accepted = await controlRequest(target, "/shutdown", token);
    if (accepted) {
      const stopped = await waitForStopped(target, 5000);
      if (stopped) {
        log(`telegram: daemon stopped (pid ${health.pid})`);
        return true;
      }
    }
  }

  if (!pid || !isAlive(pid)) {
    log("telegram: daemon is not running");
    return false;
  }
  if (!health && !(await isDaemonProcess(pid))) {
    log(`telegram: ignoring stale pid file (${pid} is not the daemon)`);
    clearStalePid();
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  if (await waitForStopped(target, 4000)) {
    log(`telegram: daemon stopped (pid ${pid}, SIGTERM)`);
    return true;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  await waitForStopped(target, 1500);
  log(`telegram: daemon killed (pid ${pid})`);
  return true;
}

async function waitForStopped(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(150);
    if (!(await telegramDaemonHealth(port))) return true;
  }
  return false;
}

export async function restartTelegramDaemon(
  log: (message: string) => void,
): Promise<TelegramHealth | undefined> {
  await stopTelegramDaemon(log);
  return startTelegramDaemon(log, { force: true });
}

export async function openTelegramLog(): Promise<void> {
  const file = logPath();
  if (!fs.existsSync(file)) {
    void vscode.window.showInformationMessage(`Nerdr: no Telegram log yet (${file}).`);
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, { preview: false });
}

export function formatTelegramHealth(health: TelegramHealth, config?: TelegramConfig): string {
  const time = (value: number | undefined): string =>
    value
      ? new Date(value).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "never";
  const opencode = health.opencode;
  const lines = [
    `Configured: ${health.configured ? (health.enabled ? "enabled" : "disabled") : "no"}`,
    `Bridge: ${health.leader ? "running" : "starting"} (pid ${health.pid})`,
    `Daemon: v${health.daemonVersion} (${health.managedBy})`,
    `Bot: ${health.bot?.botUsername ? `@${health.bot.botUsername}` : "unknown"}`,
    `Polling: ${health.bot?.polling ? "yes" : "no"}; last poll OK ${time(health.bot?.lastPollOkAt)}`,
    `Last update: ${time(health.bot?.lastUpdateAt)}`,
    `OpenCode: ${opencode ? `${opencode.state}${opencode.latencyMs !== undefined ? ` (${opencode.latencyMs}ms)` : ""}` : "unknown"}`,
    `OpenCode last OK: ${time(opencode?.lastOkAt)}`,
  ];
  if (opencode?.servicePid) {
    lines.push(
      `OpenCode service: pid ${opencode.servicePid}${opencode.serviceVersion ? `, v${opencode.serviceVersion}` : ""}`,
    );
  }
  if (opencode?.lastError) lines.push(`OpenCode error: ${opencode.lastError}`);
  if (config?.allowedChatIds[0] !== undefined) {
    lines.push(`Chat: ${config.allowedChatIds[0]}`);
  }
  if (health.bot?.lastError || health.error) {
    lines.push(`Last error: ${health.bot?.lastError ?? health.error}`);
  }
  return lines.join("\n");
}

/** Create the status-bar item and keep it in sync with the daemon. */
export function initTelegramStatus(
  context: vscode.ExtensionContext,
  log: (message: string) => void,
): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  item.command = "nerdr.telegram.manage";
  context.subscriptions.push(item);

  let running = false;
  const update = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const config = readConfig();
      if (!config) {
        item.hide();
        return;
      }
      const health = await telegramDaemonHealth(config.leaderPort);
      if (!health) {
        item.text = "$(circle-slash) Nerdr Telegram";
        item.tooltip = "Telegram bridge stopped — click to start or manage";
        item.backgroundColor = undefined;
      } else if (!config.enabled) {
        item.text = "$(circle-slash) Nerdr Telegram";
        item.tooltip = "Telegram bridge running, polling disabled — click to manage";
        item.backgroundColor = undefined;
      } else if (health.opencode.state !== "ok") {
        item.text = "$(warning) Nerdr Telegram";
        item.tooltip = `Telegram is running, but OpenCode is ${health.opencode.state}. Click to manage.`;
        item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      } else {
        item.text = "$(paper-plane) Nerdr Telegram";
        item.tooltip = "Telegram bridge running — click to manage";
        item.backgroundColor = undefined;
      }
      item.show();
    } finally {
      running = false;
    }
  };

  void update();
  const timer = setInterval(() => void update(), 15_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nerdr.telegram")) void update();
    }),
  );
  log("telegram: status bar initialized");
}

export async function manageTelegram(log: (message: string) => void): Promise<void> {
  const config = readConfig();
  const health = config ? await telegramDaemonHealth(config.leaderPort) : undefined;
  const items: Array<{ label: string; description?: string; action: string }> = [];
  if (!health) {
    items.push({
      label: "$(play) Start Telegram bridge",
      description: "spawn the standalone daemon",
      action: "start",
    });
  } else {
    items.push(
      {
        label: "$(debug-restart) Restart Telegram bridge",
        description: `pid ${health.pid}`,
        action: "restart",
      },
      {
        label: "$(debug-stop) Stop Telegram bridge",
        description: `pid ${health.pid}`,
        action: "stop",
      },
      {
        label: "$(pulse) Show status",
        action: "status",
      },
      {
        label: "$(output) Show log",
        action: "log",
      },
    );
  }
  items.push(
    { label: "$(gear) Configure Telegram", action: "configure" },
    { label: "$(send) Send test message", action: "test" },
    { label: "$(circle-slash) Disable Telegram", action: "disable" },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: "Nerdr Telegram",
    placeHolder: health
      ? `Running on 127.0.0.1:${config?.leaderPort ?? DEFAULT_TELEGRAM_LEADER_PORT}`
      : "Stopped",
    ignoreFocusOut: true,
  });
  if (!picked) return;

  switch (picked.action) {
    case "start":
      await startTelegramDaemon(log);
      void vscode.window.showInformationMessage("Nerdr: Telegram bridge started.");
      break;
    case "restart":
      await restartTelegramDaemon(log);
      void vscode.window.showInformationMessage("Nerdr: Telegram bridge restarted.");
      break;
    case "stop":
      await stopTelegramDaemon(log);
      void vscode.window.showInformationMessage("Nerdr: Telegram bridge stopped.");
      break;
    case "log":
      await openTelegramLog();
      break;
    case "status":
      await vscode.commands.executeCommand("nerdr.telegram.status");
      break;
    case "configure":
      await vscode.commands.executeCommand("nerdr.telegram.configure");
      break;
    case "test":
      await vscode.commands.executeCommand("nerdr.telegram.test");
      break;
    case "disable":
      await vscode.commands.executeCommand("nerdr.telegram.disable");
      break;
    default:
      break;
  }
}

export function telegramAutoStart(): boolean {
  return vscode.workspace.getConfiguration("nerdr").get<boolean>("telegram.autoStart", false);
}

export function telegramStopOnExit(): boolean {
  return vscode.workspace.getConfiguration("nerdr").get<boolean>("telegram.stopOnExit", false);
}
