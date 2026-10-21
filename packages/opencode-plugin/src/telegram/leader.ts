import * as http from "node:http";
import { DEFAULT_TELEGRAM_LEADER_PORT } from "@nerdr/protocol";
import { loadTelegramConfig, watchTelegramConfig } from "./config.js";
import { telegramConfigPath } from "./paths.js";
import { TelegramBot, type TelegramBotStatus } from "./bridge.js";
import { TelegramStateStore } from "./state.js";
import { TelegramApi } from "./telegramApi.js";
import { errorMessage, telegramLog } from "./log.js";

const RETRY_MS = 5000;
const BUSY_LOG_MS = 60_000;

export interface TelegramLeaderStatus {
  ok: boolean;
  leader: boolean;
  pid: number;
  startedAt: number;
  leaderPort: number;
  configPath: string;
  configured: boolean;
  enabled: boolean;
  notifyStates: string[];
  bot?: TelegramBotStatus;
  error?: string;
}

export interface TelegramLeader {
  stop(): Promise<void>;
  status(): TelegramLeaderStatus;
}

/**
 * Elect a single Telegram poller across every OpenCode location by binding a
 * loopback port. The same tiny HTTP server exposes health and reload endpoints
 * to the Nerdr extension. Non-leaders retry quietly.
 */
export function startTelegramLeader(): TelegramLeader {
  const state = new TelegramStateStore();
  const startedAt = Date.now();
  let server: http.Server | undefined;
  let bot: TelegramBot | undefined;
  let stopped = false;
  let lastError: string | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let startRetryTimer: NodeJS.Timeout | undefined;
  let unwatch: (() => void) | undefined;
  let lastBusyLog = 0;
  let reloadChain: Promise<void> = Promise.resolve();

  const config = () => loadTelegramConfig();
  const leaderPort = () => config()?.leaderPort ?? DEFAULT_TELEGRAM_LEADER_PORT;

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
      bot: bot?.status(),
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
        // Another location may have owned the bridge until a moment ago.
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
        const next = new TelegramBot(nextConfig, state);
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

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      json(res, 200, status());
      return;
    }
    if (req.method === "POST" && url.pathname === "/reload") {
      json(res, 200, { ok: true, reloading: true });
      void reload();
      return;
    }
    if (req.method === "POST" && url.pathname === "/test") {
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
          telegramLog(`leader port ${port} is in use; another Nerdr location owns the bridge`);
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
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      clearStartRetry();
      unwatch?.();
      unwatch = undefined;
      await reloadChain.catch(() => undefined);
      await stopBot();
      const current = server;
      server = undefined;
      if (current) {
        current.closeAllConnections?.();
        await new Promise<void>((resolve) => current.close(() => resolve()));
      }
      state.flush();
      telegramLog("Telegram leader stopped");
    },
  };
}
