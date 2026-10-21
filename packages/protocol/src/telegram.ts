/**
 * Telegram bridge configuration shared by the OpenCode plugin and the VSCodium
 * extension.
 *
 * The bridge runs inside the OpenCode plugin and talks to Telegram directly
 * over long polling, so there is no public ingress, webhook, or relay host.
 * The extension only writes this config file and reads bridge health.
 */

import type { AgentStatus } from "./index.js";

/** Agent states that may be sent to Telegram. */
export type TelegramNotifyState = Extract<AgentStatus, "working" | "blocked" | "done" | "error">;

export const TELEGRAM_NOTIFY_STATES: TelegramNotifyState[] = [
  "blocked",
  "done",
  "error",
  "working",
];

/** Default states that trigger a Telegram notification. */
export const DEFAULT_TELEGRAM_NOTIFY_STATES: TelegramNotifyState[] = [
  "blocked",
  "done",
  "error",
];

/** File name inside ~/.nerdr that stores the Telegram bridge config. */
export const TELEGRAM_CONFIG_FILE = "telegram.json";

/** File name inside ~/.nerdr that stores resumable bridge state. */
export const TELEGRAM_STATE_FILE = "telegram-state.json";

/** File name inside ~/.nerdr that stores bridge diagnostics. */
export const TELEGRAM_LOG_FILE = "telegram.log";

/** Loopback port used to elect a single Telegram poller across OpenCode locations. */
export const DEFAULT_TELEGRAM_LEADER_PORT = 49377;

/** Default loopback URL of the OpenCode API service. */
export const DEFAULT_OPENCODE_API_URL = "http://127.0.0.1:49374";

/** Default maximum number of assistant characters sent with a completion. */
export const DEFAULT_TELEGRAM_MAX_FINAL_CHARS = 3500;

export interface TelegramConfig {
  version: 1;
  /** Master switch. A disabled config still reserves the leader port. */
  enabled: boolean;
  /** Bot token from @BotFather. Stored only in ~/.nerdr/telegram.json (0600). */
  botToken: string;
  /** Private chat ids allowed to talk to the bot. The first receives notifications. */
  allowedChatIds: number[];
  /** Agent states that trigger a notification. */
  notifyStates: TelegramNotifyState[];
  /** Include assistant text in the completion notification. */
  includeFinalText: boolean;
  /** Truncate assistant text to this many characters (500-3900). */
  maxFinalChars: number;
  /** Loopback base URL of the OpenCode API. */
  apiUrl: string;
  /** Loopback port used for leader election and bridge health. */
  leaderPort: number;
}

/** The default config used by the configure command before the user saves one. */
export function defaultTelegramConfig(): TelegramConfig {
  return {
    version: 1,
    enabled: true,
    botToken: "",
    allowedChatIds: [],
    notifyStates: [...DEFAULT_TELEGRAM_NOTIFY_STATES],
    includeFinalText: true,
    maxFinalChars: DEFAULT_TELEGRAM_MAX_FINAL_CHARS,
    apiUrl: DEFAULT_OPENCODE_API_URL,
    leaderPort: DEFAULT_TELEGRAM_LEADER_PORT,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isNotifyState(value: unknown): value is TelegramNotifyState {
  return (
    value === "working" ||
    value === "blocked" ||
    value === "done" ||
    value === "error"
  );
}

/**
 * Parse a JSON config file defensively. Returns `undefined` when the file does
 * not contain a usable bot token, so a half-written file never starts a bot.
 */
export function normalizeTelegramConfig(input: unknown): TelegramConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const botToken = typeof raw.botToken === "string" ? raw.botToken.trim() : "";
  if (!botToken) return undefined;

  const rawChatIds = Array.isArray(raw.allowedChatIds) ? raw.allowedChatIds : [];
  const allowedChatIds = [
    ...new Set(
      rawChatIds
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && Number.isInteger(value)),
    ),
  ];

  const rawStates = Array.isArray(raw.notifyStates) ? raw.notifyStates : undefined;
  const notifyStates =
    rawStates === undefined
      ? [...DEFAULT_TELEGRAM_NOTIFY_STATES]
      : rawStates.filter(isNotifyState);

  const maxFinalChars = Number(raw.maxFinalChars);
  const leaderPort = Number(raw.leaderPort);
  const rawApiUrl = typeof raw.apiUrl === "string" ? raw.apiUrl.trim() : "";

  return {
    version: 1,
    enabled: raw.enabled !== false,
    botToken,
    allowedChatIds,
    notifyStates,
    includeFinalText: raw.includeFinalText !== false,
    maxFinalChars: Number.isFinite(maxFinalChars)
      ? clamp(Math.round(maxFinalChars), 500, 3900)
      : DEFAULT_TELEGRAM_MAX_FINAL_CHARS,
    apiUrl: (rawApiUrl || DEFAULT_OPENCODE_API_URL).replace(/\/+$/, ""),
    leaderPort: Number.isFinite(leaderPort)
      ? clamp(Math.round(leaderPort), 1024, 65535)
      : DEFAULT_TELEGRAM_LEADER_PORT,
  };
}
