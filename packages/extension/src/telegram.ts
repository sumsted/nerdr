import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  BRIDGE_DIRNAME,
  DEFAULT_OPENCODE_API_URL,
  DEFAULT_TELEGRAM_LEADER_PORT,
  DEFAULT_TELEGRAM_MAX_FINAL_CHARS,
  DEFAULT_TELEGRAM_NOTIFY_STATES,
  TELEGRAM_CONFIG_FILE,
  TELEGRAM_NOTIFY_STATES,
  normalizeTelegramConfig,
  type TelegramConfig,
  type TelegramNotifyState,
} from "@nerdr/protocol";

const TIMEOUT_MS = 10_000;

interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

interface TelegramUpdate {
  update_id: number;
  message?: { chat?: TelegramChat };
  callback_query?: { message?: { chat?: TelegramChat } };
}

interface BridgeHealth {
  ok?: boolean;
  leader?: boolean;
  pid?: number;
  leaderPort?: number;
  configured?: boolean;
  enabled?: boolean;
  notifyStates?: string[];
  error?: string;
  bot?: {
    running?: boolean;
    botUsername?: string;
    polling?: boolean;
    eventsConnected?: boolean;
    lastUpdateAt?: number;
    lastError?: string;
    chatId?: number;
    pendingPermissions?: number;
    pendingQuestions?: number;
  };
}

function nerdrHome(): string {
  return process.env.NERDR_HOME || path.join(os.homedir(), BRIDGE_DIRNAME);
}

export function telegramConfigPath(): string {
  return path.join(nerdrHome(), TELEGRAM_CONFIG_FILE);
}

export function readTelegramConfig(): TelegramConfig | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(telegramConfigPath(), "utf8")) as unknown;
    return normalizeTelegramConfig(raw);
  } catch {
    return undefined;
  }
}

function writeTelegramConfig(config: TelegramConfig): void {
  const file = telegramConfigPath();
  const dir = path.dirname(file);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Best effort.
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
}

async function telegramRequest<T>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: TelegramResponse<T> | undefined;
    try {
      parsed = text ? (JSON.parse(text) as TelegramResponse<T>) : undefined;
    } catch {
      throw new Error(`Telegram returned a non-JSON response (HTTP ${response.status}).`);
    }
    if (!parsed?.ok) {
      throw new Error(parsed?.description ?? `Telegram HTTP ${response.status}`);
    }
    return parsed.result as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Telegram request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getMe(token: string): Promise<TelegramUser> {
  return telegramRequest<TelegramUser>(token, "getMe");
}

async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<TelegramMessage> {
  return telegramRequest<TelegramMessage>(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function recentChats(
  token: string,
): Promise<{ chats: TelegramChat[]; error?: string }> {
  try {
    const updates = await telegramRequest<TelegramUpdate[]>(token, "getUpdates", {
      timeout: 0,
      limit: 100,
      allowed_updates: ["message", "callback_query"],
    });
    const chats = new Map<number, TelegramChat>();
    for (const update of updates) {
      const chat = update.message?.chat ?? update.callback_query?.message?.chat;
      if (chat && !chats.has(chat.id)) chats.set(chat.id, chat);
    }
    return { chats: [...chats.values()] };
  } catch (error) {
    return { chats: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function chatLabel(chat: TelegramChat): string {
  if (chat.type === "private") {
    return chat.username ? `@${chat.username}` : chat.first_name || `Chat ${chat.id}`;
  }
  return chat.title || chat.username || `Chat ${chat.id}`;
}

async function bridgeHealth(port: number): Promise<BridgeHealth | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return (await response.json()) as BridgeHealth;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function reloadBridge(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/reload`, {
      method: "POST",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function describeNotifyStates(states: TelegramNotifyState[]): string {
  return states.length > 0 ? states.join(", ") : "none";
}

async function promptManualChatId(
  existing: TelegramConfig | undefined,
): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    title: "Nerdr Telegram",
    prompt: "Telegram chat ID (digits only; private chat ids are positive)",
    value: existing?.allowedChatIds[0]?.toString() ?? "",
    placeHolder: "123456789",
    ignoreFocusOut: true,
    validateInput: (input) => {
      const normalized = input.trim().replace(/[\s,]/g, "");
      if (!normalized) return "A chat ID is required.";
      if (!/^-?\d+$/.test(normalized)) {
        return "Enter digits only, for example 123456789 (no @, spaces, or commas).";
      }
      if (!Number.isSafeInteger(Number(normalized))) {
        return "That chat ID is too large.";
      }
      return undefined;
    },
  });
  if (value === undefined) return undefined;
  return Number(value.trim().replace(/[\s,]/g, ""));
}

async function promptChatId(
  token: string,
  existing: TelegramConfig | undefined,
  log: (message: string) => void,
): Promise<number | undefined> {
  const found = await recentChats(token);
  if (found.error) {
    log(`telegram: chat detection unavailable: ${found.error}`);
  }
  if (found.chats.length === 0) {
    // Avoid a one-item QuickPick: typing into its filter swallows the chat ID
    // and Enter has nothing to select. Go straight to the input box.
    return promptManualChatId(existing);
  }

  const manualLabel = "Enter chat ID manually…";
  const items: Array<{ label: string; description?: string; chatId?: number }> = found.chats.map(
    (chat) => ({
      label: chatLabel(chat),
      description: `Chat ID ${chat.id} (${chat.type})`,
      chatId: chat.id,
    }),
  );
  items.push({ label: manualLabel, description: "Use @userinfobot or copy the id shown by the bot" });

  const picked = await vscode.window.showQuickPick(items, {
    title: "Nerdr Telegram",
    placeHolder: existing?.allowedChatIds[0]
      ? `Chat ${existing.allowedChatIds[0]} (choose or enter another)`
      : "Choose the chat, or select “Enter chat ID manually…”",
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  if (picked.chatId !== undefined) return picked.chatId;
  return promptManualChatId(existing);
}

export async function configureTelegram(log: (message: string) => void): Promise<void> {
  const existing = readTelegramConfig();
  const tokenInput = await vscode.window.showInputBox({
    title: "Nerdr Telegram",
    prompt: existing
      ? "Bot token from @BotFather (leave blank to keep the current token)"
      : "Bot token from @BotFather",
    password: true,
    placeHolder: existing ? "Leave blank to keep the existing token" : "123456789:AA…",
    ignoreFocusOut: true,
  });
  if (tokenInput === undefined) return;
  const token = tokenInput.trim() || existing?.botToken || "";
  if (!token) {
    void vscode.window.showWarningMessage("Nerdr: a Telegram bot token is required.");
    return;
  }

  let me: TelegramUser;
  try {
    me = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Nerdr: checking Telegram bot…",
      },
      () => getMe(token),
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Nerdr: Telegram rejected the bot token — ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const chatId = await promptChatId(token, existing, log);
  if (chatId === undefined) return;

  const stateItems: Array<{ label: string; description: string; picked: boolean }> = [
    { label: "blocked", description: "Permission requests and questions", picked: true },
    { label: "done", description: "Completed turns (with the assistant text)", picked: true },
    { label: "error", description: "Failed turns", picked: true },
    { label: "working", description: "Turn started (noisy)", picked: false },
  ].map((item) => {
    const state = item.label as TelegramNotifyState;
    const selected = existing?.notifyStates ?? DEFAULT_TELEGRAM_NOTIFY_STATES;
    return { ...item, picked: selected.includes(state) };
  });
  const statePicks = await vscode.window.showQuickPick(stateItems, {
    title: "Nerdr Telegram",
    placeHolder: "Notifications to send",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!statePicks) return;
  const notifyStates = statePicks
    .map((pick) => pick.label)
    .filter((label): label is TelegramNotifyState =>
      (TELEGRAM_NOTIFY_STATES as string[]).includes(label),
    );
  if (notifyStates.length === 0) {
    void vscode.window.showWarningMessage("Nerdr: choose at least one Telegram notification.");
    return;
  }

  const finalTextPick = await vscode.window.showQuickPick(
    [
      { label: "Yes", description: "Include the assistant's final text", value: true },
      { label: "No", description: "Send only the status line", value: false },
    ],
    {
      title: "Nerdr Telegram",
      placeHolder: "Include the final assistant message?",
      ignoreFocusOut: true,
    },
  );
  if (!finalTextPick) return;

  const config: TelegramConfig = {
    version: 1,
    enabled: true,
    botToken: token,
    allowedChatIds: [chatId],
    notifyStates,
    includeFinalText: finalTextPick.value,
    maxFinalChars: existing?.maxFinalChars ?? DEFAULT_TELEGRAM_MAX_FINAL_CHARS,
    apiUrl: existing?.apiUrl ?? DEFAULT_OPENCODE_API_URL,
    leaderPort: existing?.leaderPort ?? DEFAULT_TELEGRAM_LEADER_PORT,
  };

  try {
    await sendTelegramMessage(
      token,
      chatId,
      `✅ Nerdr Telegram configured for ${me.username ? `@${me.username}` : "this bot"}. Send /help here.`,
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Nerdr: could not message chat ${chatId} — ${error instanceof Error ? error.message : String(error)}. Config not saved.`,
    );
    return;
  }

  try {
    writeTelegramConfig(config);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Nerdr: could not save ${telegramConfigPath()} — ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const reloaded = await reloadBridge(config.leaderPort);
  log(
    `telegram: configured @${me.username ?? me.id} chat ${chatId}; states ${describeNotifyStates(notifyStates)}; bridge ${reloaded ? "reloaded" : "not running"}`,
  );
  void vscode.window.showInformationMessage(
    `Nerdr: Telegram configured${me.username ? ` for @${me.username}` : ""}. ${reloaded ? "The bridge is live." : "The bridge starts with the OpenCode plugin."}`,
  );
}

export async function showTelegramStatus(log: (message: string) => void): Promise<void> {
  const config = readTelegramConfig();
  if (!config) {
    void vscode.window.showInformationMessage(
      "Nerdr: Telegram is not configured. Run “Nerdr: Configure Telegram”.",
    );
    return;
  }
  const health = await bridgeHealth(config.leaderPort);
  if (!health) {
    log(`telegram: no health response on 127.0.0.1:${config.leaderPort}`);
    void vscode.window.showWarningMessage(
      "Nerdr: Telegram is configured, but the bridge is not running. Ensure the Nerdr OpenCode plugin is deployed and OpenCode is running.",
    );
    return;
  }
  const lines = [
    `Configured: yes (${config.enabled ? "enabled" : "disabled"})`,
    `Bot: ${health.bot?.botUsername ? `@${health.bot.botUsername}` : "unknown"}`,
    `Chat: ${config.allowedChatIds[0] ?? "none"}`,
    `Notifications: ${describeNotifyStates(config.notifyStates)}`,
    `Final text: ${config.includeFinalText ? `yes (${config.maxFinalChars} chars)` : "no"}`,
    `Polling: ${health.bot?.polling ? "yes" : "no"}`,
    `Events connected: ${health.bot?.eventsConnected ? "yes" : "no"}`,
    `Pending permissions: ${health.bot?.pendingPermissions ?? 0}`,
    `Pending questions: ${health.bot?.pendingQuestions ?? 0}`,
    `Leader: pid ${health.pid ?? "?"} on 127.0.0.1:${health.leaderPort ?? config.leaderPort}`,
  ];
  if (health.bot?.lastError || health.error) {
    lines.push(`Last error: ${health.bot?.lastError ?? health.error}`);
  }
  log(`telegram health: ${JSON.stringify(health)}`);
  void vscode.window.showInformationMessage(`Nerdr Telegram\n\n${lines.join("\n")}`, {
    modal: true,
  });
}

export async function testTelegram(log: (message: string) => void): Promise<void> {
  const config = readTelegramConfig();
  if (!config) {
    void vscode.window.showWarningMessage(
      "Nerdr: configure Telegram first (Nerdr: Configure Telegram).",
    );
    return;
  }
  const chatId = config.allowedChatIds[0];
  if (chatId === undefined) {
    void vscode.window.showWarningMessage("Nerdr: no Telegram chat is configured.");
    return;
  }
  try {
    const message = await sendTelegramMessage(
      config.botToken,
      chatId,
      "Ping! Nerdr Telegram is online. Send /help here.",
    );
    log(`telegram: test delivered to chat ${chatId} (message ${message.message_id})`);
    void vscode.window.showInformationMessage("Nerdr: Telegram test delivered.");
  } catch (error) {
    log(`telegram: test failed: ${error instanceof Error ? error.message : String(error)}`);
    void vscode.window.showErrorMessage(
      `Nerdr: Telegram test failed — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function disableTelegram(log: (message: string) => void): Promise<void> {
  const config = readTelegramConfig();
  if (!config) {
    void vscode.window.showInformationMessage("Nerdr: Telegram is not configured.");
    return;
  }
  const next: TelegramConfig = { ...config, enabled: false };
  try {
    writeTelegramConfig(next);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Nerdr: could not save ${telegramConfigPath()} — ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const reloaded = await reloadBridge(next.leaderPort);
  log(`telegram: disabled; bridge ${reloaded ? "reloaded" : "not running"}`);
  void vscode.window.showInformationMessage(
    `Nerdr: Telegram disabled.${reloaded ? " The running bridge has stopped polling." : ""}`,
  );
}
