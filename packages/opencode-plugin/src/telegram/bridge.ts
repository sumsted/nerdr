import { randomBytes } from "node:crypto";
import type { TelegramConfig } from "@nerdr/protocol";
import { TelegramApi, TelegramApiError, type TelegramCallbackQuery, type TelegramInlineKeyboard, type TelegramMessage, type TelegramUpdate } from "./telegramApi.js";
import { OpencodeClient, OpencodeError, type OpencodeAgent, type OpencodeEvent, type OpencodeForm, type OpencodeFormField, type OpencodePermission, type OpencodeSession } from "./opencode.js";
import { TelegramStateStore, type TelegramFormValue, type TelegramQuestionField, type TelegramQuestionRef, type TelegramSessionInfo } from "./state.js";
import {
  agentName,
  chunkText,
  permissionResult,
  renderAgents,
  renderDone,
  renderError,
  renderHelp,
  renderInterrupted,
  renderModes,
  renderPermission,
  renderQuestion,
  renderQuestionAnswered,
  renderStatus,
  renderWorking,
  truncate,
} from "./render.js";
import { errorMessage, telegramLog } from "./log.js";

const EMPTY_KEYBOARD: TelegramInlineKeyboard = { inline_keyboard: [] };
const MAX_AGENTS = 10;

type SessionInfo = TelegramSessionInfo;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorFromUnknown(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return typeof value === "string" ? value : undefined;
  if (typeof record.message === "string") return record.message;
  if (typeof record._tag === "string") return record._tag;
  return undefined;
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error as { code?: string } | undefined)?.code === "ABORT_ERR"
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function normalizeField(field: OpencodeFormField): TelegramQuestionField | undefined {
  if (!field || typeof field.key !== "string" || !field.key) return undefined;
  if (field.hidden) return undefined;
  const type = typeof field.type === "string" ? field.type : "string";
  const options: Array<{ value: string; label: string; description?: string }> = Array.isArray(
    field.options,
  )
    ? field.options
        .filter((option) => option && typeof option.value === "string")
        .map((option) => ({
          value: option.value,
          label: typeof option.label === "string" && option.label ? option.label : option.value,
          description:
            typeof option.description === "string" ? option.description : undefined,
        }))
    : [];
  if (type === "boolean" && options.length === 0) {
    options.push({ value: "true", label: "Yes" }, { value: "false", label: "No" });
  }
  const externalUrl = asString(asRecord(field)?.url);
  if (type === "external" && externalUrl && options.length === 0) {
    options.push({ value: externalUrl, label: externalUrl });
  }
  return {
    key: field.key,
    type,
    title: typeof field.title === "string" && field.title.trim() ? field.title : field.key,
    description: typeof field.description === "string" ? field.description : undefined,
    options,
    custom: field.custom === true,
    required: field.required !== false,
    minItems: typeof field.minItems === "number" ? field.minItems : undefined,
    maxItems: typeof field.maxItems === "number" ? field.maxItems : undefined,
    defaultValue: field.default as TelegramFormValue | undefined,
  };
}

export interface TelegramBotStatus {
  running: boolean;
  botUsername?: string;
  polling: boolean;
  eventsConnected: boolean;
  lastUpdateAt?: number;
  lastError?: string;
  startedAt: number;
  chatId?: number;
  pendingPermissions: number;
  pendingQuestions: number;
}

/**
 * One Telegram poller. At most one exists per machine, elected by the leader
 * server in leader.ts. State is persisted so a leader handoff does not lose
 * pending permission/question tokens.
 */
export class TelegramBot {
  private readonly api: TelegramApi;
  private readonly opencode: OpencodeClient;
  private readonly pollAbort = new AbortController();
  private readonly eventAbort = new AbortController();
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly stepDelta = new Map<string, string>();
  private readonly stepEndedText = new Map<string, string>();
  private readonly sessionPromises = new Map<string, Promise<SessionInfo>>();
  private stopped = false;
  private polling = false;
  private eventsConnected = false;
  private lastUpdateAt?: number;
  private lastError?: string;
  private botUsername?: string;
  private readonly startedAt = Date.now();
  private pollPromise?: Promise<void>;
  private eventPromise?: Promise<void>;
  private reconcilePromise?: Promise<void>;

  constructor(
    private readonly config: TelegramConfig,
    private readonly state: TelegramStateStore,
  ) {
    this.api = new TelegramApi(config.botToken);
    this.opencode = new OpencodeClient(config.apiUrl);
  }

  async start(): Promise<void> {
    const me = await this.api.getMe();
    this.botUsername = me.username;
    try {
      await this.api.deleteWebhook();
    } catch (error) {
      telegramLog(`deleteWebhook failed: ${errorMessage(error)}`);
    }
    try {
      await this.api.setMyCommands();
    } catch (error) {
      telegramLog(`setMyCommands failed: ${errorMessage(error)}`);
    }
    telegramLog(`Telegram bot @${this.botUsername ?? me.id} started`);
    this.pollPromise = this.pollLoop();
    this.eventPromise = this.eventLoop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.pollAbort.abort();
    this.eventAbort.abort();
    await Promise.allSettled([this.pollPromise, this.eventPromise]);
    this.state.flush();
    telegramLog(`Telegram bot @${this.botUsername ?? "unknown"} stopped`);
  }

  status(): TelegramBotStatus {
    return {
      running: !this.stopped,
      botUsername: this.botUsername,
      polling: this.polling,
      eventsConnected: this.eventsConnected,
      lastUpdateAt: this.lastUpdateAt,
      lastError: this.lastError,
      startedAt: this.startedAt,
      chatId: this.primaryChatId(),
      pendingPermissions: Object.keys(this.state.data.permissions).length,
      pendingQuestions: Object.keys(this.state.data.questions).length,
    };
  }

  private primaryChatId(): number | undefined {
    return this.config.allowedChatIds[0];
  }

  private noteError(error: unknown): void {
    this.lastError = errorMessage(error);
    telegramLog(this.lastError);
  }

  private async pollLoop(): Promise<void> {
    this.polling = true;
    try {
      await this.pollLoopInner();
    } finally {
      this.polling = false;
    }
  }

  private async pollLoopInner(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const updates = await this.api.getUpdates(
          this.state.updateOffset,
          this.pollAbort.signal,
        );
        backoff = 1000;
        this.lastError = undefined;
        for (const update of updates) {
          if (this.stopped) break;
          if (update.update_id < this.state.updateOffset) continue;
          if (this.state.hasProcessed(update.update_id)) {
            this.state.setUpdateOffset(update.update_id + 1);
            continue;
          }
          // Persist the offset before processing so a crash cannot replay a
          // prompt or permission decision.
          this.state.setUpdateOffset(update.update_id + 1);
          this.state.markProcessed(update.update_id);
          await this.state.flush();
          this.lastUpdateAt = Date.now();
          try {
            await this.handleUpdate(update);
          } catch (error) {
            this.noteError(error);
          }
        }
      } catch (error) {
        if (this.stopped || isAbort(error)) break;
        if (error instanceof TelegramApiError) {
          if (error.code === 409) {
            telegramLog("getUpdates conflict (webhook or another poller); deleting webhook");
            try {
              await this.api.deleteWebhook();
            } catch {
              // retry below
            }
            await sleep(2000, this.pollAbort.signal);
            continue;
          }
          if (error.code === 401) {
            this.noteError("Telegram rejected the bot token (401)");
            await sleep(30_000, this.pollAbort.signal);
            continue;
          }
          if (error.code === 429) {
            const wait = Math.max(1, Math.min(error.retryAfter ?? 5, 60));
            telegramLog(`Telegram rate-limited; waiting ${wait}s`);
            await sleep(wait * 1000, this.pollAbort.signal);
            continue;
          }
        }
        this.noteError(error);
        await sleep(backoff, this.pollAbort.signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private async eventLoop(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      const wasConnected = this.eventsConnected;
      try {
        await this.opencode.subscribeEvents((event) => this.enqueueEvent(event), this.eventAbort.signal);
      } catch (error) {
        if (this.stopped || isAbort(error)) break;
        this.noteError(error);
      }
      this.eventsConnected = false;
      if (this.stopped) break;
      if (wasConnected) backoff = 1000;
      void this.reconcile();
      await sleep(backoff, this.eventAbort.signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  private enqueueEvent(event: OpencodeEvent): void {
    if (this.stopped) return;
    this.eventQueue = this.eventQueue
      .then(() => this.handleEvent(event))
      .catch((error) => this.noteError(error));
  }

  private async reconcile(): Promise<void> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.doReconcile()
      .catch((error) => this.noteError(error))
      .finally(() => {
        this.reconcilePromise = undefined;
      });
    return this.reconcilePromise;
  }

  private async doReconcile(): Promise<void> {
    let active: string[];
    try {
      active = await this.opencode.activeSessions();
    } catch (error) {
      this.noteError(error);
      return;
    }

    const queriedPermissions = new Set<string>();
    const queriedForms = new Set<string>();
    const seenPermissions = new Set<string>();
    const seenForms = new Set<string>();

    for (const sessionID of active) {
      if (this.stopped) return;
      const info = await this.ensureSession(sessionID);
      if (info.parentID) continue;
      try {
        const permissions = await this.opencode.listPermissions(sessionID);
        queriedPermissions.add(sessionID);
        for (const request of permissions) {
          seenPermissions.add(request.id);
          await this.startPermission(info, request);
        }
      } catch (error) {
        telegramLog(`reconcile permissions ${sessionID}: ${errorMessage(error)}`);
      }
      try {
        const forms = await this.opencode.listForms(sessionID);
        queriedForms.add(sessionID);
        for (const form of forms) {
          seenForms.add(form.id);
          await this.startQuestion(info, form);
        }
      } catch (error) {
        telegramLog(`reconcile forms ${sessionID}: ${errorMessage(error)}`);
      }
    }

    for (const ref of Object.values(this.state.data.permissions)) {
      if (!queriedPermissions.has(ref.sessionID) || seenPermissions.has(ref.requestID)) continue;
      await this.editMessage(ref.chatId, ref.messageId, "⌛ Permission is no longer pending");
      this.state.removePermission(ref.token);
    }
    for (const ref of Object.values(this.state.data.questions)) {
      if (!queriedForms.has(ref.sessionID) || seenForms.has(ref.formID)) continue;
      await this.finishQuestionMessages(ref, "⌛ Question is no longer pending");
      this.state.removeQuestion(ref.token);
    }
  }

  private async ensureSession(sessionID: string, directory?: string): Promise<SessionInfo> {
    const existing = this.state.getSession(sessionID);
    if (existing) {
      if (directory && !existing.directory) {
        return this.state.upsertSession({
          id: sessionID,
          title: existing.title,
          directory,
          parentID: existing.parentID,
          agent: existing.agent,
          status: existing.status,
        });
      }
      return existing;
    }
    const pending = this.sessionPromises.get(sessionID);
    if (pending) return pending;
    const promise = (async () => {
      try {
        const session = await this.opencode.getSession(sessionID);
        return this.upsertFromSession(session, directory);
      } catch (error) {
        telegramLog(`session ${sessionID}: ${errorMessage(error)}`);
        return this.state.upsertSession({
          id: sessionID,
          title: sessionID,
          directory,
          status: "unknown",
        });
      } finally {
        this.sessionPromises.delete(sessionID);
      }
    })();
    this.sessionPromises.set(sessionID, promise);
    return promise;
  }

  private upsertFromSession(session: OpencodeSession, directory?: string): SessionInfo {
    return this.state.upsertSession({
      id: session.id,
      title: session.title ?? session.id,
      directory: session.location?.directory ?? directory,
      parentID: session.parentID,
      agent: session.agent,
    });
  }

  private async handleEvent(event: OpencodeEvent): Promise<void> {
    if (this.stopped) return;
    const type = event.type ?? "";
    const data = (event.data ?? {}) as Record<string, unknown>;
    const directory = event.location?.directory;
    const sessionID = asString(data.sessionID);

    if (type === "server.connected") {
      this.eventsConnected = true;
      this.lastError = undefined;
      void this.reconcile();
      return;
    }
    if (type === "session.created") {
      const id = asString(data.sessionID) ?? asString(data.id);
      if (!id) return;
      const eventLocation = asRecord(data.location);
      const info = this.state.upsertSession({
        id,
        title: asString(data.title) ?? id,
        directory: asString(eventLocation?.directory) ?? directory,
        parentID: asString(data.parentID),
        agent: asString(data.agent),
      });
      if (!info.parentID) telegramLog(`session seen: ${agentName(info)} (${id})`);
      return;
    }
    if (type === "session.renamed" || type === "session.moved") {
      if (!sessionID) return;
      const info = await this.ensureSession(sessionID, directory);
      const movedLocation = asRecord(data.location);
      this.state.upsertSession({
        id: sessionID,
        title: asString(data.title) ?? info.title,
        directory: asString(movedLocation?.directory) ?? info.directory,
        parentID: info.parentID,
        agent: info.agent,
        status: info.status,
      });
      return;
    }
    if (type === "session.agent.selected") {
      if (!sessionID) return;
      const agent = asString(data.agent);
      if (!agent) return;
      await this.ensureSession(sessionID, directory);
      this.state.upsertSession({ id: sessionID, agent });
      return;
    }
    if (type === "location.shutdown") return;
    if (type === "form.created") {
      // The form payload carries its own session id; the envelope does not.
      const form = this.formFromData(data);
      if (form) {
        const info = await this.ensureSession(form.sessionID, directory);
        if (!info.parentID) await this.startQuestion(info, form);
      }
      return;
    }
    if (!sessionID) return;

    const info = await this.ensureSession(sessionID, directory);
    if (info.parentID) return;

    switch (type) {
      case "session.status": {
        const status = asRecord(data.status);
        const statusType = asString(status?.type);
        if (statusType === "busy" || statusType === "retry") {
          await this.markWorking(info, type);
        }
        break;
      }
      case "session.step.started":
        this.stepDelta.delete(sessionID);
        this.stepEndedText.delete(sessionID);
        await this.markWorking(info, type);
        break;
      case "session.text.delta": {
        const delta = asString(data.delta);
        if (delta) this.stepDelta.set(sessionID, `${this.stepDelta.get(sessionID) ?? ""}${delta}`);
        break;
      }
      case "session.text.ended": {
        const text = asString(data.text);
        if (text) {
          const previous = this.stepEndedText.get(sessionID);
          this.stepEndedText.set(sessionID, previous ? `${previous}\n\n${text}` : text);
        }
        break;
      }
      case "session.step.ended": {
        const finish = asString(data.finish) ?? asString(data.rawFinish);
        if (finish === "tool-calls" || finish === "tool_calls") {
          await this.markWorking(info, type);
          break;
        }
        if (finish === "error" || finish === "content-filter" || finish === "content_filter") {
          await this.notifyError(info, errorFromUnknown(data.error), type);
          break;
        }
        const text = this.takeStepText(sessionID);
        await this.notifyDone(info, text, type);
        break;
      }
      case "session.step.failed":
        await this.notifyError(info, errorFromUnknown(data.error), type);
        break;
      case "session.execution.failed":
        await this.notifyError(info, errorFromUnknown(data.error), type);
        break;
      case "session.execution.interrupted":
        this.stepDelta.delete(sessionID);
        this.stepEndedText.delete(sessionID);
        this.state.setSessionStatus(sessionID, "done", type);
        if (this.config.notifyStates.includes("done")) {
          await this.sendSession(info, renderInterrupted(info), "status");
        }
        break;
      case "session.reasoning.started":
      case "session.tool.input.started":
      case "session.tool.called":
      case "session.tool.success":
      case "session.tool.error":
      case "session.tool.failed":
      case "session.retry.scheduled":
        await this.markWorking(info, type);
        break;
      case "permission.asked": {
        const request = this.permissionFromData(data);
        if (request) await this.startPermission(info, request);
        break;
      }
      case "permission.replied":
        await this.onPermissionReplied(asString(data.requestID));
        break;
      case "form.replied":
        await this.onFormSettled(asString(data.id), "replied");
        break;
      case "form.cancelled":
        await this.onFormSettled(asString(data.id), "cancelled");
        break;
      case "session.idle":
        // OpenCode emits idle between steps as well as at the end of a turn.
        // step.ended is the authoritative completion signal.
        break;
      default:
        break;
    }
  }

  private takeStepText(sessionID: string): string | undefined {
    const ended = this.stepEndedText.get(sessionID);
    const delta = this.stepDelta.get(sessionID);
    this.stepEndedText.delete(sessionID);
    this.stepDelta.delete(sessionID);
    return (ended || delta || "").trim() || undefined;
  }

  private async markWorking(info: SessionInfo, eventType: string): Promise<void> {
    const previous = this.state.setSessionStatus(info.id, "working", eventType);
    if (previous === "working") return;
    if (!this.config.notifyStates.includes("working")) return;
    await this.sendSession(info, renderWorking(info), "status");
  }

  private async notifyDone(info: SessionInfo, text: string | undefined, eventType: string): Promise<void> {
    const previous = this.state.setSessionStatus(info.id, "done", eventType);
    if (previous === "done" && !text) return;
    if (!this.config.notifyStates.includes("done")) return;
    const body = this.config.includeFinalText ? text : undefined;
    await this.sendSession(info, renderDone(info, body, this.config.maxFinalChars), "final");
  }

  private async notifyError(
    info: SessionInfo,
    message: string | undefined,
    eventType: string,
  ): Promise<void> {
    const previous = this.state.setSessionStatus(info.id, "error", eventType);
    if (previous === "error") return;
    if (!this.config.notifyStates.includes("error")) return;
    await this.sendSession(info, renderError(info, message), "status");
  }

  private permissionFromData(data: Record<string, unknown>): OpencodePermission | undefined {
    const id = asString(data.id);
    const sessionID = asString(data.sessionID);
    const action = asString(data.action);
    if (!id || !sessionID || !action) return undefined;
    return {
      id,
      sessionID,
      action,
      resources: Array.isArray(data.resources)
        ? data.resources.filter((resource): resource is string => typeof resource === "string")
        : [],
      message: asString(data.message),
      save: Array.isArray(data.save)
        ? data.save.filter((resource): resource is string => typeof resource === "string")
        : undefined,
    };
  }

  private formFromData(data: Record<string, unknown>): OpencodeForm | undefined {
    const raw = asRecord(data.form);
    if (!raw) return undefined;
    const id = asString(raw.id);
    const sessionID = asString(raw.sessionID);
    if (!id || !sessionID) return undefined;
    return {
      id,
      sessionID,
      title: asString(raw.title) ?? "Input needed",
      metadata: asRecord(raw.metadata),
      fields: Array.isArray(raw.fields)
        ? raw.fields.filter((field): field is OpencodeFormField =>
            Boolean(field && typeof field === "object"),
          )
        : [],
    };
  }

  private async startPermission(info: SessionInfo, request: OpencodePermission): Promise<void> {
    if (this.state.findPermissionByRequest(request.id)) return;
    const chatId = this.primaryChatId();
    if (chatId === undefined) return;
    const token = this.newToken("p");
    const rendered = renderPermission(info, request, token);
    const message = await this.api.sendMessage(chatId, rendered.text, {
      reply_markup: rendered.keyboard,
    });
    this.state.addPermission({
      token,
      sessionID: info.id,
      requestID: request.id,
      chatId,
      messageId: message.message_id,
      createdAt: Date.now(),
    });
    this.state.setSessionStatus(info.id, "blocked", "permission.asked");
  }

  private async onPermissionReplied(requestID: string | undefined): Promise<void> {
    if (!requestID) return;
    const ref = this.state.findPermissionByRequest(requestID);
    if (!ref) return;
    await this.editMessage(ref.chatId, ref.messageId, "⌛ Permission resolved");
    this.state.removePermission(ref.token);
    this.state.setSessionStatus(ref.sessionID, "working", "permission.replied");
  }

  private async startQuestion(info: SessionInfo, form: OpencodeForm): Promise<void> {
    if (form.sessionID === "global") return;
    if (this.state.findQuestionByForm(form.id)) return;
    const chatId = this.primaryChatId();
    if (chatId === undefined) return;

    const answers: Record<string, TelegramFormValue> = {};
    for (const field of form.fields) {
      if (!field || typeof field.key !== "string") continue;
      if (field.default !== undefined) answers[field.key] = field.default;
    }
    const fields = form.fields
      .map((field) => normalizeField(field))
      .filter((field): field is TelegramQuestionField => Boolean(field));
    if (fields.length === 0) return;
    for (const field of fields) {
      if (field.defaultValue !== undefined) answers[field.key] = field.defaultValue;
    }

    const question: TelegramQuestionRef = {
      token: this.newToken("q"),
      sessionID: info.id,
      formID: form.id,
      chatId,
      title: form.title,
      fields,
      index: 0,
      answers,
      messageIds: [],
      awaitingText: false,
      createdAt: Date.now(),
    };
    this.state.setSessionStatus(info.id, "blocked", "form.created");
    await this.sendQuestion(info, question);
  }

  private async sendQuestion(info: SessionInfo, question: TelegramQuestionRef): Promise<void> {
    const field = question.fields[question.index];
    if (!field) {
      await this.submitQuestion(info, question);
      return;
    }
    const rendered = renderQuestion(info, question);
    const message = await this.api.sendMessage(question.chatId, rendered.text, {
      reply_markup: rendered.keyboard,
    });
    question.messageIds.push(message.message_id);
    this.state.rememberMessage(question.chatId, message.message_id, {
      sessionID: question.sessionID,
      title: agentName(info),
      kind: "question",
      token: question.token,
    });
    question.awaitingText =
      field.type !== "boolean" &&
      field.type !== "multiselect" &&
      field.type !== "external" &&
      field.options.length === 0;
    this.state.addQuestion(question);
    this.state.setQuestionByChat(question.chatId, question.awaitingText ? question.token : undefined);
    this.state.save();
  }

  private newToken(prefix: string): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const token = `${prefix}${randomBytes(5).toString("hex")}`;
      if (!this.state.getPermission(token) && !this.state.getQuestion(token)) return token;
    }
    return `${prefix}${Date.now().toString(36)}`;
  }

  private async sendSession(
    info: SessionInfo,
    text: string,
    kind: "status" | "final",
  ): Promise<void> {
    const chatId = this.primaryChatId();
    if (chatId === undefined) return;
    for (const chunk of chunkText(text)) {
      const message = await this.api.sendMessage(chatId, chunk);
      this.state.rememberMessage(chatId, message.message_id, {
        sessionID: info.id,
        title: agentName(info),
        kind,
      });
    }
  }

  private async sendRaw(
    chatId: number,
    text: string,
    options?: { reply_markup?: TelegramInlineKeyboard },
  ): Promise<TelegramMessage | undefined> {
    try {
      return await this.api.sendMessage(chatId, text, options);
    } catch (error) {
      this.noteError(error);
      return undefined;
    }
  }

  private async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: TelegramInlineKeyboard,
  ): Promise<void> {
    try {
      await this.api.editMessageText(chatId, messageId, text, {
        reply_markup: keyboard ?? EMPTY_KEYBOARD,
      });
    } catch (error) {
      telegramLog(`edit message ${messageId}: ${errorMessage(error)}`);
    }
  }

  private isAuthorized(chatId: number): boolean {
    return this.config.allowedChatIds.includes(chatId);
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    if (update.message) await this.handleMessage(update.message);
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (message.from?.is_bot) return;
    const chatId = message.chat.id;
    const text = (message.text ?? message.caption ?? "").trim();

    if (!this.isAuthorized(chatId)) {
      if (this.state.shouldNotifyUnauthorized(chatId)) {
        await this.sendRaw(
          chatId,
          [
            "This chat is not authorized to control Nerdr.",
            "",
            `Chat ID: ${chatId}`,
            "Add it with Nerdr: Configure Telegram in VSCodium.",
          ].join("\n"),
        );
      }
      return;
    }

    const command = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text);
    if (command) {
      await this.handleCommand(chatId, command[1] ?? "", (command[2] ?? "").trim());
      return;
    }

    if (!text) {
      await this.sendRaw(chatId, "Send text, or /help for commands.");
      return;
    }

    const reply = message.reply_to_message;
    if (reply) {
      const ref = this.state.lookupMessage(chatId, reply.message_id);
      if (ref?.kind === "permission" && ref.token) {
        await this.replyPermissionWithMessage(chatId, ref.token, text);
        return;
      }
      if (ref?.kind === "question" && ref.token) {
        await this.answerQuestionWithText(chatId, ref.token, text);
        return;
      }
      if (ref?.sessionID) {
        await this.promptSession(chatId, ref.sessionID, text, message.message_id);
        return;
      }
    }

    const awaitingQuestion = this.state.getQuestionByChat(chatId);
    if (awaitingQuestion) {
      await this.answerQuestionWithText(chatId, awaitingQuestion, text);
      return;
    }

    const active = this.state.getActive(chatId);
    if (active) {
      await this.promptSession(chatId, active, text, message.message_id);
      return;
    }

    await this.sendRaw(
      chatId,
      "No active agent. Use /agents to list agents, or reply to a notification.",
    );
  }

  private async handleCommand(chatId: number, command: string, argument: string): Promise<void> {
    switch (command.toLowerCase()) {
      case "start":
      case "help":
        await this.sendRaw(chatId, renderHelp(this.botUsername));
        return;
      case "agents":
        await this.listAgents(chatId);
        return;
      case "use":
        await this.useAgent(chatId, argument);
        return;
      case "mode":
        await this.setMode(chatId, argument);
        return;
      case "status":
        await this.showStatus(chatId);
        return;
      case "stop":
        await this.stopActive(chatId);
        return;
      default:
        await this.sendRaw(chatId, `Unknown command: /${command}\n\n${renderHelp(this.botUsername)}`);
    }
  }

  private async listAgents(chatId: number): Promise<void> {
    let activeIDs: string[] = [];
    let sessions: OpencodeSession[] = [];
    try {
      activeIDs = await this.opencode.activeSessions();
    } catch (error) {
      telegramLog(`list active sessions: ${errorMessage(error)}`);
    }
    try {
      sessions = await this.opencode.listSessions(30);
    } catch (error) {
      telegramLog(`list sessions: ${errorMessage(error)}`);
    }

    const activeSet = new Set(activeIDs);
    const merged = new Map<string, SessionInfo>();
    for (const session of sessions) {
      const info = this.upsertFromSession(session);
      merged.set(info.id, info);
    }
    for (const id of activeIDs) {
      if (merged.has(id)) continue;
      merged.set(id, await this.ensureSession(id));
    }
    for (const info of Object.values(this.state.data.sessions)) {
      if (!merged.has(info.id)) merged.set(info.id, info);
    }

    const entries = [...merged.values()]
      .filter((info) => !info.parentID)
      .sort((a, b) => {
        const aActive = activeSet.has(a.id) ? 0 : 1;
        const bActive = activeSet.has(b.id) ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return b.updatedAt - a.updatedAt;
      })
      .slice(0, MAX_AGENTS);
    const active = this.state.getActive(chatId);
    const rendered = renderAgents(
      entries.map((info) => ({ info, active: info.id === active })),
    );
    this.state.setAgentList(chatId, entries.map((info) => info.id));
    await this.sendRaw(chatId, rendered.text, { reply_markup: rendered.keyboard });
  }

  private async useAgent(chatId: number, argument: string): Promise<void> {
    if (!argument) {
      await this.listAgents(chatId);
      return;
    }
    const sessions = Object.values(this.state.data.sessions).filter((info) => !info.parentID);
    const numeric = /^\d+$/.test(argument) ? Number(argument) : undefined;
    if (numeric !== undefined) {
      const list = this.state.getAgentList(chatId)?.sessionIDs ?? [];
      const id = list[numeric - 1];
      const info = id ? this.state.getSession(id) : undefined;
      if (info) {
        await this.selectAgent(chatId, info);
        return;
      }
    }

    const needle = argument.toLowerCase();
    const exact = sessions.filter((info) => agentName(info).toLowerCase() === needle);
    const matches =
      exact.length > 0
        ? exact
        : sessions.filter((info) => {
            const name = agentName(info).toLowerCase();
            return (
              name.includes(needle) ||
              info.id.toLowerCase().includes(needle) ||
              info.title.toLowerCase().includes(needle) ||
              (info.directory ?? "").toLowerCase().includes(needle)
            );
          });

    if (matches.length === 1 && matches[0]) {
      await this.selectAgent(chatId, matches[0]);
      return;
    }
    if (matches.length > 1) {
      const lines = ["Multiple agents matched. Choose one:", ""];
      const buttons: TelegramInlineKeyboard = { inline_keyboard: [] };
      matches.slice(0, MAX_AGENTS).forEach((info, index) => {
        lines.push(`${index + 1}. ${agentName(info)} (${info.id.slice(-6)})`);
        buttons.inline_keyboard.push([
          { text: `${index + 1}. ${agentName(info)}`, callback_data: `use:${info.id}` },
        ]);
      });
      this.state.setAgentList(chatId, matches.slice(0, MAX_AGENTS).map((info) => info.id));
      await this.sendRaw(chatId, lines.join("\n"), { reply_markup: buttons });
      return;
    }
    await this.sendRaw(chatId, `No agent matched "${argument}". Use /agents.`);
  }

  private async selectAgent(
    chatId: number,
    info: SessionInfo,
    edit?: { messageId: number },
  ): Promise<void> {
    this.state.setActive(chatId, info.id);
    const text = `Active agent: ${agentName(info)}\nSession: ${info.id}`;
    if (edit) await this.editMessage(chatId, edit.messageId, text);
    else await this.sendRaw(chatId, text);
  }

  private async setMode(chatId: number, argument: string): Promise<void> {
    const id = this.state.getActive(chatId);
    if (!id) {
      await this.sendRaw(chatId, "No active agent. Use /agents.");
      return;
    }
    let info = this.state.getSession(id);
    if (!info) info = await this.ensureSession(id);
    info = await this.refreshSessionLocation(info);

    let agents: OpencodeAgent[];
    try {
      agents = await this.availableModes(info);
    } catch (error) {
      await this.sendRaw(chatId, `Could not list modes: ${errorMessage(error)}`);
      return;
    }
    if (agents.length === 0) {
      await this.sendRaw(chatId, `No modes are available for ${agentName(info)}.`);
      return;
    }

    const needle = argument.trim().toLowerCase();
    if (!needle) {
      await this.sendModeList(chatId, info, agents);
      return;
    }

    const exact = agents.filter(
      (agent) =>
        agent.id.toLowerCase() === needle || agent.name.toLowerCase() === needle,
    );
    const matches =
      exact.length > 0
        ? exact
        : agents.filter(
            (agent) =>
              agent.id.toLowerCase().includes(needle) ||
              agent.name.toLowerCase().includes(needle),
          );
    if (matches.length === 0) {
      await this.sendRaw(chatId, `No mode matched "${argument}".`, {
        reply_markup: renderModes(info, agents).keyboard,
      });
      return;
    }
    if (matches.length > 1) {
      await this.sendModeList(chatId, info, matches, "Multiple modes matched.");
      return;
    }
    const target = matches[0];
    if (!target) return;
    await this.switchMode(chatId, info, target, agents);
  }

  private async sendModeList(
    chatId: number,
    info: SessionInfo,
    agents: OpencodeAgent[],
    preface?: string,
  ): Promise<void> {
    const rendered = renderModes(info, agents);
    const text = preface ? `${preface}\n\n${rendered.text}` : rendered.text;
    await this.sendRaw(chatId, text, { reply_markup: rendered.keyboard });
  }

  private async switchMode(
    chatId: number,
    info: SessionInfo,
    target: OpencodeAgent,
    agents: OpencodeAgent[],
    edit?: { messageId: number },
  ): Promise<void> {
    if (info.agent !== target.id) {
      try {
        await this.opencode.switchAgent(info.id, target.id);
      } catch (error) {
        await this.sendRaw(
          chatId,
          `Could not switch to ${target.name}: ${errorMessage(error)}`,
        );
        return;
      }
    }
    const updated = this.state.upsertSession({ id: info.id, agent: target.id });
    const rendered = renderModes(updated, agents);
    if (edit) {
      await this.editMessage(chatId, edit.messageId, rendered.text, rendered.keyboard);
    } else {
      await this.sendRaw(chatId, rendered.text, { reply_markup: rendered.keyboard });
    }
  }

  private async availableModes(info: SessionInfo): Promise<OpencodeAgent[]> {
    const agents = await this.opencode.listAgents(info.directory);
    return agents.filter(
      (agent) =>
        agent &&
        typeof agent.id === "string" &&
        agent.id.length > 0 &&
        agent.mode !== "subagent" &&
        agent.hidden !== true,
    );
  }

  private async refreshSessionLocation(info: SessionInfo): Promise<SessionInfo> {
    if (info.directory) return info;
    try {
      return this.upsertFromSession(await this.opencode.getSession(info.id));
    } catch {
      return info;
    }
  }

  private async showStatus(chatId: number): Promise<void> {
    const id = this.state.getActive(chatId);
    if (!id) {
      await this.sendRaw(chatId, "No active agent. Use /agents.");
      return;
    }
    let info = this.state.getSession(id);
    if (!info) {
      try {
        info = await this.ensureSession(id);
      } catch (error) {
        await this.sendRaw(chatId, `Could not load ${id}: ${errorMessage(error)}`);
        return;
      }
    }
    const pendingPermissions = Object.values(this.state.data.permissions).filter(
      (permission) => permission.sessionID === id,
    ).length;
    const pendingQuestions = Object.values(this.state.data.questions).filter(
      (question) => question.sessionID === id,
    ).length;
    await this.sendRaw(chatId, renderStatus(info, pendingPermissions, pendingQuestions));
  }

  private async stopActive(chatId: number): Promise<void> {
    const id = this.state.getActive(chatId);
    if (!id) {
      await this.sendRaw(chatId, "No active agent. Use /agents.");
      return;
    }
    const info = this.state.getSession(id);
    try {
      await this.opencode.interrupt(id);
      await this.sendRaw(chatId, `Stopping ${info ? agentName(info) : id}…`);
    } catch (error) {
      await this.sendRaw(chatId, `Could not stop ${id}: ${errorMessage(error)}`);
    }
  }

  private async promptSession(
    chatId: number,
    sessionID: string,
    text: string,
    messageId: number,
  ): Promise<void> {
    let info: SessionInfo;
    try {
      info = await this.ensureSession(sessionID);
    } catch (error) {
      await this.sendRaw(chatId, `Could not load ${sessionID}: ${errorMessage(error)}`);
      return;
    }
    if (info.parentID) {
      await this.sendRaw(chatId, "That is a subagent; reply to the parent agent instead.");
      return;
    }
    try {
      await this.opencode.prompt(sessionID, text, "queue");
      this.state.setActive(chatId, sessionID);
      const reacted = await this.api.setMessageReaction(chatId, messageId, "👀");
      if (!reacted) await this.sendRaw(chatId, `Sent to ${agentName(info)}.`);
    } catch (error) {
      const suffix =
        error instanceof OpencodeError && error.status === 409
          ? " The agent is busy; wait for it to finish or use /stop."
          : "";
      await this.sendRaw(chatId, `Could not send to ${agentName(info)}: ${errorMessage(error)}.${suffix}`);
    }
  }

  private async replyPermissionWithMessage(
    chatId: number,
    token: string,
    message: string,
  ): Promise<void> {
    const ref = this.state.getPermission(token);
    if (!ref) {
      await this.sendRaw(chatId, "That permission request is no longer pending.");
      return;
    }
    try {
      await this.opencode.replyPermission(ref.sessionID, ref.requestID, "reject", message);
      await this.editMessage(chatId, ref.messageId, permissionResult("reject", message));
      this.state.removePermission(token);
    } catch (error) {
      await this.sendRaw(chatId, `Could not deny: ${errorMessage(error)}`);
    }
  }

  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id;
    if (chatId === undefined) return;
    if (!this.isAuthorized(chatId)) {
      await this.answerCallback(query.id, "Not authorized");
      return;
    }
    const data = query.data ?? "";
    if (data.startsWith("use:")) {
      const sessionID = data.slice(4);
      const info = this.state.getSession(sessionID);
      if (!info) {
        await this.answerCallback(query.id, "Agent not found");
        return;
      }
      await this.answerCallback(query.id, "Selected");
      if (query.message) {
        await this.selectAgent(chatId, info, { messageId: query.message.message_id });
      }
      return;
    }
    if (data.startsWith("mode:")) {
      const agentID = data.slice(5);
      const active = this.state.getActive(chatId);
      if (!active) {
        await this.answerCallback(query.id, "No active agent");
        return;
      }
      let info = this.state.getSession(active);
      if (!info) info = await this.ensureSession(active);
      info = await this.refreshSessionLocation(info);
      let agents: OpencodeAgent[];
      try {
        agents = await this.availableModes(info);
      } catch (error) {
        await this.answerCallback(query.id, "Could not list modes");
        await this.sendRaw(chatId, `Could not list modes: ${errorMessage(error)}`);
        return;
      }
      const target = agents.find((agent) => agent.id === agentID);
      if (!target) {
        await this.answerCallback(query.id, "Mode unavailable");
        await this.sendRaw(chatId, "That mode is no longer available.", {
          reply_markup: renderModes(info, agents).keyboard,
        });
        return;
      }
      await this.answerCallback(query.id, target.name);
      await this.switchMode(
        chatId,
        info,
        target,
        agents,
        query.message ? { messageId: query.message.message_id } : undefined,
      );
      return;
    }
    if (data.startsWith("perm:")) {
      const [, token = "", decision = ""] = data.split(":");
      const ref = this.state.getPermission(token);
      if (!ref || !["once", "always", "reject"].includes(decision)) {
        await this.answerCallback(query.id, "Expired");
        return;
      }
      await this.answerCallback(query.id);
      try {
        await this.opencode.replyPermission(
          ref.sessionID,
          ref.requestID,
          decision as "once" | "always" | "reject",
        );
        await this.editMessage(chatId, ref.messageId, permissionResult(decision as "once" | "always" | "reject"));
        this.state.removePermission(token);
      } catch (error) {
        await this.sendRaw(chatId, `Permission reply failed: ${errorMessage(error)}`);
      }
      return;
    }
    if (data.startsWith("q:")) {
      const [, token = "", action = ""] = data.split(":");
      const question = this.state.getQuestion(token);
      if (!question) {
        await this.answerCallback(query.id, "Expired");
        return;
      }
      await this.answerCallback(query.id);
      const info = this.state.getSession(question.sessionID) ?? {
        id: question.sessionID,
        title: question.sessionID,
        updatedAt: Date.now(),
      };
      if (action === "submit") {
        await this.submitQuestion(info, question);
        return;
      }
      if (action === "other") {
        await this.setQuestionOther(question);
        return;
      }
      if (action === "skip") {
        await this.skipQuestionField(info, question);
        return;
      }
      const index = Number(action);
      if (!Number.isInteger(index) || index < 0) {
        await this.sendRaw(chatId, "Unknown question action.");
        return;
      }
      await this.chooseQuestionOption(info, question, index);
      return;
    }
    await this.answerCallback(query.id, "Unknown action");
  }

  private async answerCallback(id: string, text?: string): Promise<void> {
    try {
      await this.api.answerCallbackQuery(id, text);
    } catch (error) {
      telegramLog(`answerCallbackQuery: ${errorMessage(error)}`);
    }
  }

  private async chooseQuestionOption(
    info: SessionInfo,
    question: TelegramQuestionRef,
    index: number,
  ): Promise<void> {
    const field = question.fields[question.index];
    if (!field) return;
    const option = field.options[index];
    if (!option) return;

    if (field.type === "multiselect") {
      const current = Array.isArray(question.answers[field.key])
        ? ([...(question.answers[field.key] as string[])] as string[])
        : [];
      const position = current.indexOf(option.value);
      if (position >= 0) current.splice(position, 1);
      else {
        if (field.maxItems !== undefined && current.length >= field.maxItems) {
          await this.sendRaw(question.chatId, `Choose at most ${field.maxItems}.`);
          return;
        }
        current.push(option.value);
      }
      question.answers[field.key] = current;
      const rendered = renderQuestion(info, question);
      const messageId = question.messageIds[question.messageIds.length - 1];
      if (messageId) await this.editMessage(question.chatId, messageId, rendered.text, rendered.keyboard);
      this.state.save();
      return;
    }

    const value: TelegramFormValue =
      field.type === "boolean" ? index === 0 : option.value;
    question.answers[field.key] = value;
    const messageId = question.messageIds[question.messageIds.length - 1];
    if (messageId) {
      await this.editMessage(
        question.chatId,
        messageId,
        `✅ ${field.title}: ${option.label}`,
      );
    }
    await this.advanceQuestion(info, question);
  }

  private async setQuestionOther(question: TelegramQuestionRef): Promise<void> {
    const field = question.fields[question.index];
    if (!field) return;
    question.awaitingText = true;
    this.state.setQuestionByChat(question.chatId, question.token);
    const messageId = question.messageIds[question.messageIds.length - 1];
    if (messageId) {
      const rendered = renderQuestion(
        this.state.getSession(question.sessionID) ?? {
          id: question.sessionID,
          title: question.sessionID,
          updatedAt: Date.now(),
        },
        question,
      );
      await this.editMessage(
        question.chatId,
        messageId,
        `${rendered.text}\n\nReply to this message with your answer.`,
        EMPTY_KEYBOARD,
      );
    }
  }

  private async skipQuestionField(
    info: SessionInfo,
    question: TelegramQuestionRef,
  ): Promise<void> {
    const field = question.fields[question.index];
    if (!field) return;
    if (field.required && field.type !== "external") {
      await this.sendRaw(question.chatId, `"${field.title}" is required.`);
      return;
    }
    delete question.answers[field.key];
    await this.advanceQuestion(info, question);
  }

  private async answerQuestionWithText(
    chatId: number,
    token: string,
    text: string,
  ): Promise<void> {
    const question = this.state.getQuestion(token);
    if (!question) {
      await this.sendRaw(chatId, "That question is no longer pending.");
      return;
    }
    const field = question.fields[question.index];
    if (!field) return;
    const info = this.state.getSession(question.sessionID) ?? {
      id: question.sessionID,
      title: question.sessionID,
      updatedAt: Date.now(),
    };
    const trimmed = text.trim();
    if (!trimmed) return;

    if (
      !question.awaitingText &&
      field.type !== "multiselect" &&
      field.options.length > 0 &&
      !field.custom
    ) {
      const optionIndex = field.options.findIndex(
        (option) =>
          option.label.toLowerCase() === trimmed.toLowerCase() ||
          option.value.toLowerCase() === trimmed.toLowerCase(),
      );
      if (optionIndex >= 0) {
        await this.chooseQuestionOption(info, question, optionIndex);
        return;
      }
      await this.sendRaw(chatId, "Tap one of the options above.");
      return;
    }

    if (field.type === "multiselect") {
      if (!field.custom) {
        await this.sendRaw(chatId, "Tap the options above, then Submit.");
        return;
      }
      const existing = Array.isArray(question.answers[field.key])
        ? ([...(question.answers[field.key] as string[])] as string[])
        : [];
      const additions = trimmed
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      question.answers[field.key] = [...new Set([...existing, ...additions])];
      question.awaitingText = false;
      this.state.setQuestionByChat(chatId, undefined);
      const rendered = renderQuestion(info, question);
      const messageId = question.messageIds[question.messageIds.length - 1];
      if (messageId) await this.editMessage(chatId, messageId, rendered.text, rendered.keyboard);
      this.state.save();
      return;
    }

    if (field.type === "number" || field.type === "integer") {
      const value = Number(trimmed);
      if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) {
        await this.sendRaw(chatId, `Enter a valid ${field.type}.`);
        return;
      }
      question.answers[field.key] = value;
    } else if (field.type === "boolean") {
      const lower = trimmed.toLowerCase();
      if (!["yes", "y", "true", "1", "no", "n", "false", "0"].includes(lower)) {
        await this.sendRaw(chatId, "Answer yes or no.");
        return;
      }
      question.answers[field.key] = ["yes", "y", "true", "1"].includes(lower);
    } else {
      question.answers[field.key] = trimmed;
    }

    const messageId = question.messageIds[question.messageIds.length - 1];
    if (messageId) {
      await this.editMessage(chatId, messageId, `✅ ${field.title}: ${truncate(trimmed, 500)}`);
    }
    await this.advanceQuestion(info, question);
  }

  private async advanceQuestion(info: SessionInfo, question: TelegramQuestionRef): Promise<void> {
    question.awaitingText = false;
    this.state.setQuestionByChat(question.chatId, undefined);
    question.index += 1;
    if (question.index >= question.fields.length) {
      await this.submitQuestion(info, question);
      return;
    }
    await this.sendQuestion(info, question);
  }

  private async submitQuestion(info: SessionInfo, question: TelegramQuestionRef): Promise<void> {
    for (let index = 0; index < question.fields.length; index += 1) {
      const field = question.fields[index];
      if (!field || field.type === "external") continue;
      const value = question.answers[field.key];
      if (field.required && (value === undefined || (Array.isArray(value) && value.length === 0))) {
        question.index = index;
        await this.sendRaw(
          question.chatId,
          `Please answer "${field.title}" before submitting.`,
        );
        await this.sendQuestion(info, question);
        return;
      }
      if (Array.isArray(value)) {
        if (field.minItems !== undefined && value.length < field.minItems) {
          await this.sendRaw(question.chatId, `Choose at least ${field.minItems}.`);
          question.index = index;
          await this.sendQuestion(info, question);
          return;
        }
        if (field.maxItems !== undefined && value.length > field.maxItems) {
          await this.sendRaw(question.chatId, `Choose at most ${field.maxItems}.`);
          question.index = index;
          await this.sendQuestion(info, question);
          return;
        }
      }
    }

    const answer: Record<string, TelegramFormValue> = {};
    for (const field of question.fields) {
      if (field.type === "external") continue;
      const value = question.answers[field.key];
      if (value !== undefined) answer[field.key] = value;
    }

    try {
      await this.opencode.replyForm(question.sessionID, question.formID, answer);
      const summary = renderQuestionAnswered(info, question);
      for (const [index, messageId] of question.messageIds.entries()) {
        const last = index === question.messageIds.length - 1;
        await this.editMessage(
          question.chatId,
          messageId,
          last ? summary : "✅ Answered",
        );
      }
      this.state.removeQuestion(question.token);
      this.state.setSessionStatus(question.sessionID, "working", "form.replied");
    } catch (error) {
      const detail = errorMessage(error);
      if (
        error instanceof OpencodeError &&
        (error.status === 404 || /settled|not found/i.test(detail))
      ) {
        await this.finishQuestionMessages(question, "⌛ Question is no longer pending");
        this.state.removeQuestion(question.token);
      } else {
        await this.sendRaw(question.chatId, `Could not submit the answer: ${detail}`);
      }
    }
  }

  private async finishQuestionMessages(
    question: TelegramQuestionRef,
    text: string,
  ): Promise<void> {
    for (const messageId of question.messageIds) {
      await this.editMessage(question.chatId, messageId, text);
    }
  }

  private async onFormSettled(
    formID: string | undefined,
    result: "replied" | "cancelled",
  ): Promise<void> {
    if (!formID) return;
    const question = this.state.findQuestionByForm(formID);
    if (!question) return;
    await this.finishQuestionMessages(
      question,
      result === "cancelled" ? "⌛ Question cancelled" : "✅ Answered",
    );
    this.state.removeQuestion(question.token);
    this.state.setSessionStatus(
      question.sessionID,
      "working",
      result === "cancelled" ? "form.cancelled" : "form.replied",
    );
  }
}
