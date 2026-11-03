import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import {
  DEFAULT_OPENCODE_API_URL,
  DEFAULT_TELEGRAM_LEADER_PORT,
  TELEGRAM_CONTROL_HEADER,
  type TelegramHealth,
} from "@nerdr/protocol";
import { loadTelegramConfig, watchTelegramConfig } from "./config.js";
import { telegramConfigPath, telegramPidPath } from "./paths.js";
import { TelegramBot } from "./bridge.js";
import { TelegramStateStore } from "./state.js";
import { TelegramApi } from "./telegramApi.js";
import { ensureControlToken, tokensMatch } from "./control.js";
import { ServiceHealth } from "./health.js";
import { errorMessage, telegramLog } from "./log.js";

const RETRY_MS = 5000;
const BUSY_LOG_MS = 300_000;
const WATCHDOG_MS = 30_000;
const POLL_STALL_MS = 180_000;

export const DAEMON_VERSION = process.env.NERDR_DAEMON_VERSION || "0.2.0";

export interface TelegramLeaderOptions {
  /** Who owns this process. The standalone daemon sets "daemon". */
  managedBy?: "daemon" | "plugin";
  /** Called after a control request stops the leader. */
  onShutdown?: () => void | Promise<void>;
  /** Override the persisted control token (tests). */
  controlToken?: string;
}

export type TelegramLeaderStatus = TelegramHealth;

export interface TelegramLeader {
  stop(): Promise<void>;
  status(): TelegramLeaderStatus;
}

/**
 * Own the single Telegram poller and the loopback control/health server.
 *
 * The standalone daemon is the only caller. The port still elects one poller
 * per machine so a second daemon (or a stale process) cannot double-poll.
 */
export function startTelegramLeader(options: TelegramLeaderOptions = {}): TelegramLeader {
  const state = new TelegramStateStore();
  const startedAt = Date.now();
  const controlToken = options.controlToken ?? ensureControlToken();
  let server: http.Server | undefined;
  let bot: TelegramBot | undefined;
  let stopped = false;
  let lastError: string | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let startRetryTimer: NodeJS.Timeout | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  let unwatch: (() => void) | undefined;
  let lastBusyLog = 0;
  let reloadChain: Promise<void> = Promise.resolve();
  let shuttingDown = false;

  const config = () => loadTelegramConfig();
  const leaderPort = () => config()?.leaderPort ?? DEFAULT_TELEGRAM_LEADER_PORT;

  // Write the pid before binding. A daemon that is waiting for a stale process
  // to release the port is still "the daemon", and the extension must not
  // spawn a second copy.
  writePidFile();

  const health = new ServiceHealth(
    () => config()?.apiUrl ?? DEFAULT_OPENCODE_API_URL,
  );
  health.onTransition((current, previous) => {
    // Do not announce the first successful probe as a recovery.
    if (previous.state === "unknown" && current.state === "ok") return;
    void bot?.notifyServiceState(current, previous);
  });

  const status = (): TelegramLeaderStatus => {
    const current = config();
    return {
      ok: true,
      leader: Boolean(server?.listening),
      pid: process.pid,
      startedAt,
      leaderPort: current?.leaderPort ?? DEFAULT_TELEGRAM_LEADER_PORT,
      configPath: telegramConfigPath(),
      configured: Boolean(current),
      enabled: current?.enabled === true,
      notifyStates: current?.notifyStates ?? [],
      daemonVersion: DAEMON_VERSION,
      managedBy: options.managedBy ?? "plugin",
      bot: bot?.status(),
      opencode: health.status(),
      error: lastError,
    };
  };

  const json = (res: http.ServerResponse, statusCode: number, body: unknown): void => {
    const data = `${JSON.stringify(body)}\n`;
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(data),
      "Cache-Control": "no-store",
    });
    res.end(data);
  };

  const authorized = (req: http.IncomingMessage): boolean => {
    const raw = req.headers[TELEGRAM_CONTROL_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    return tokensMatch(provided, controlToken);
  };

  function writePidFile(): void {
    const file = telegramPidPath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Diagnostics only.
    }
  }

  function removePidFile(): void {
    const file = telegramPidPath();
    try {
      const current = Number(fs.readFileSync(file, "utf8").trim());
      if (current === process.pid) fs.unlinkSync(file);
    } catch {
      // Missing or unreadable is fine.
    }
  }

  const stopBot = async (): Promise<void> => {
    const current = bot;
    bot = undefined;
    if (!current) return;
    try {
      await current.stop();
    } catch (error) {
      telegramLog(`bot stop failed: ${errorMessage(error)}`);
    }
  };

  const clearStartRetry = (): void => {
    if (startRetryTimer) clearTimeout(startRetryTimer);
    startRetryTimer = undefined;
  };

  const reload = (): Promise<void> => {
    reloadChain = reloadChain
      .then(async () => {
        if (stopped) return;
        clearStartRetry();
        await stopBot();
        // Config may have moved the poller between ports.
        state.reload();
        const nextConfig = config();
        if (!nextConfig) {
          lastError = undefined;
          clearStartRetry();
          telegramLog("Telegram config missing; bridge idle");
          return;
        }
        if (!nextConfig.enabled) {
          lastError = undefined;
          clearStartRetry();
          telegramLog("Telegram bridge disabled");
          return;
        }
        if (nextConfig.allowedChatIds.length === 0) {
          telegramLog("Telegram bridge has no allowed chats; bot will report the chat id");
        }
        const next = new TelegramBot(nextConfig, state, health);
        try {
          await next.start();
          if (stopped) {
            await next.stop();
            return;
          }
          bot = next;
          lastError = undefined;
          clearStartRetry();
        } catch (error) {
          lastError = errorMessage(error);
          telegramLog(`Telegram bot failed to start: ${lastError}`);
          await next.stop().catch(() => undefined);
          if (!stopped && !startRetryTimer) {
            startRetryTimer = setTimeout(() => {
              startRetryTimer = undefined;
              void reload();
            }, 30_000);
            startRetryTimer.unref?.();
          }
        }
      })
      .catch((error) => {
        lastError = errorMessage(error);
        telegramLog(`Telegram reload failed: ${lastError}`);
      });
    return reloadChain;
  };

  const startWatchdog = (): void => {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      const current = bot;
      if (!current) return;
      const currentStatus = current.status();
      if (!currentStatus.polling) return;
      const reference = currentStatus.lastPollOkAt ?? currentStatus.startedAt;
      const stalledMs = Date.now() - reference;
      if (stalledMs > POLL_STALL_MS) {
        telegramLog(
          `Telegram poll stalled for ${Math.round(stalledMs / 1000)}s; restarting bot`,
        );
        void reload();
      }
    }, WATCHDOG_MS);
    watchdogTimer.unref?.();
  };

  const stopWatchdog = (): void => {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = undefined;
  };

  async function stopLeader(): Promise<void> {
    if (stopped) return;
    stopped = true;
    stopWatchdog();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    clearStartRetry();
    unwatch?.();
    unwatch = undefined;
    await reloadChain.catch(() => undefined);
    await stopBot();
    health.stop();
    const current = server;
    server = undefined;
    if (current) {
      current.closeAllConnections?.();
      await new Promise<void>((resolve) => current.close(() => resolve()));
    }
    removePidFile();
    state.flush();
    telegramLog("Telegram leader stopped");
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      json(res, 200, status());
      return;
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      if (!authorized(req)) {
        json(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      if (shuttingDown) {
        json(res, 200, { ok: true, stopping: true });
        return;
      }
      shuttingDown = true;
      json(res, 200, { ok: true, stopping: true });
      setTimeout(() => {
        void stopLeader()
          .then(() => options.onShutdown?.())
          .catch((error) => telegramLog(`shutdown failed: ${errorMessage(error)}`));
      }, 25).unref?.();
      return;
    }
    if (req.method === "POST" && url.pathname === "/reload") {
      if (!authorized(req)) {
        json(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      json(res, 200, { ok: true, reloading: true });
      void reload();
      return;
    }
    if (req.method === "POST" && url.pathname === "/test") {
      if (!authorized(req)) {
        json(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      const current = config();
      if (!current) {
        json(res, 400, { ok: false, error: "Telegram is not configured." });
        return;
      }
      const chatId = current.allowedChatIds[0];
      if (chatId === undefined) {
        json(res, 400, { ok: false, error: "No Telegram chat is configured." });
        return;
      }
      try {
        const api = new TelegramApi(current.botToken);
        const me = await api.getMe();
        const message = await api.sendMessage(
          chatId,
          `Ping! Nerdr Telegram bridge online${me.username ? ` as @${me.username}` : ""} at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}.`,
        );
        json(res, 200, { ok: true, messageId: message.message_id, botUsername: me.username });
      } catch (error) {
        json(res, 502, { ok: false, error: errorMessage(error) });
      }
      return;
    }
    json(res, 404, { ok: false, error: "Not found" });
  };

  const scheduleRetry = (): void => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      bind();
    }, RETRY_MS);
    retryTimer.unref?.();
  };

  const bind = (): void => {
    if (stopped || server) return;
    const port = leaderPort();
    const candidate = http.createServer((req, res) => {
      void handle(req, res).catch((error) => {
        telegramLog(`health server error: ${errorMessage(error)}`);
        if (!res.headersSent) json(res, 500, { ok: false, error: errorMessage(error) });
        else res.end();
      });
    });
    candidate.once("error", (error: NodeJS.ErrnoException) => {
      if (server === candidate) server = undefined;
      if (stopped) return;
      if (error.code === "EADDRINUSE") {
        const now = Date.now();
        if (now - lastBusyLog > BUSY_LOG_MS) {
          lastBusyLog = now;
          telegramLog(`leader port ${port} is in use; another Nerdr Telegram process owns the bridge`);
        }
      } else {
        lastError = errorMessage(error);
        telegramLog(`leader port ${port} failed: ${lastError}`);
      }
      scheduleRetry();
    });
    candidate.listen(port, "127.0.0.1", () => {
      if (stopped) {
        candidate.close(() => undefined);
        return;
      }
      server = candidate;
      health.start();
      startWatchdog();
      telegramLog(`Telegram leader listening on 127.0.0.1:${port}`);
      unwatch = watchTelegramConfig(() => {
        telegramLog("Telegram config changed; reloading");
        void reload();
      });
      void reload();
    });
  };

  bind();

  return {
    status,
    stop: stopLeader,
  };
}
