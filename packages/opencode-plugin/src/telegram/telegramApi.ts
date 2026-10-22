import { telegramLog } from "./log.js";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

export interface SendMessageOptions {
  reply_markup?: TelegramInlineKeyboard;
  disable_web_page_preview?: boolean;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Minimal Telegram Bot API client. Uses long polling; no inbound webhook. */
export class TelegramApi {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  private async request<T>(
    method: string,
    body: Record<string, unknown> | undefined,
    externalSignal?: AbortSignal,
    timeoutMs = 15_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const response = await fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: TelegramResponse<T> | undefined;
      try {
        parsed = text ? (JSON.parse(text) as TelegramResponse<T>) : undefined;
      } catch {
        throw new TelegramApiError(`Telegram returned a non-JSON response (${response.status})`);
      }
      if (!parsed || !parsed.ok) {
        throw new TelegramApiError(
          parsed?.description ?? `Telegram HTTP ${response.status}`,
          parsed?.error_code ?? response.status,
          parsed?.parameters?.retry_after,
        );
      }
      return parsed.result as T;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (controller.signal.aborted) {
        if (externalSignal?.aborted) throw error;
        throw new TelegramApiError(`Telegram ${method} timed out`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }

  async getMe(): Promise<TelegramUser> {
    return this.request<TelegramUser>("getMe", {}, undefined, 15_000);
  }

  async deleteWebhook(): Promise<boolean> {
    return this.request<boolean>("deleteWebhook", { drop_pending_updates: false });
  }

  async setMyCommands(): Promise<boolean> {
    return this.request<boolean>("setMyCommands", {
      commands: [
        { command: "agents", description: "List agents" },
        { command: "use", description: "Select an agent" },
        { command: "mode", description: "Show or change the Plan/Build mode" },
        { command: "status", description: "Show the active agent" },
        { command: "stop", description: "Interrupt the active agent" },
        { command: "help", description: "Show commands" },
      ],
    });
  }

  async getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.request<TelegramUpdate[]>(
      "getUpdates",
      {
        offset,
        limit: 100,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      },
      signal,
      35_000,
    );
  }

  async sendMessage(
    chatId: number,
    text: string,
    options?: SendMessageOptions,
  ): Promise<TelegramMessage> {
    return this.request<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: options?.disable_web_page_preview ?? true,
      ...(options?.reply_markup ? { reply_markup: options.reply_markup } : {}),
    });
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: SendMessageOptions,
  ): Promise<TelegramMessage | boolean> {
    try {
      return await this.request<TelegramMessage | boolean>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: options?.disable_web_page_preview ?? true,
        ...(options?.reply_markup ? { reply_markup: options.reply_markup } : {}),
      });
    } catch (error) {
      // Re-editing with identical text is a normal no-op.
      if (error instanceof TelegramApiError && /not modified/i.test(error.message)) {
        return true;
      }
      throw error;
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.request<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  async setMessageReaction(
    chatId: number,
    messageId: number,
    emoji: string,
  ): Promise<boolean> {
    try {
      return await this.request<boolean>("setMessageReaction", {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      });
    } catch (error) {
      telegramLog(`Telegram reaction failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
