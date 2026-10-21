import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentStatus } from "@nerdr/protocol";
import { telegramStatePath } from "./paths.js";
import { errorMessage, telegramLog } from "./log.js";

export type TelegramFormValue = string | number | boolean | string[];

export interface TelegramSessionInfo {
  id: string;
  title: string;
  directory?: string;
  parentID?: string;
  agent?: string;
  status?: AgentStatus;
  lastEvent?: string;
  updatedAt: number;
}

export interface TelegramMessageRef {
  sessionID: string;
  title: string;
  kind: "status" | "final" | "permission" | "question";
  token?: string;
  createdAt: number;
}

export interface TelegramPermissionRef {
  token: string;
  sessionID: string;
  requestID: string;
  chatId: number;
  messageId: number;
  createdAt: number;
}

export interface TelegramQuestionField {
  key: string;
  type: string;
  title: string;
  description?: string;
  options: Array<{ value: string; label: string; description?: string }>;
  custom: boolean;
  required: boolean;
  minItems?: number;
  maxItems?: number;
  defaultValue?: TelegramFormValue;
}

export interface TelegramQuestionRef {
  token: string;
  sessionID: string;
  formID: string;
  chatId: number;
  title: string;
  fields: TelegramQuestionField[];
  index: number;
  answers: Record<string, TelegramFormValue>;
  messageIds: number[];
  awaitingText: boolean;
  createdAt: number;
}

export interface TelegramAgentList {
  sessionIDs: string[];
  at: number;
}

export interface TelegramStateData {
  version: 1;
  updateOffset: number;
  activeByChat: Record<string, string>;
  sessions: Record<string, TelegramSessionInfo>;
  messages: Record<string, TelegramMessageRef>;
  permissions: Record<string, TelegramPermissionRef>;
  permissionByRequest: Record<string, string>;
  questions: Record<string, TelegramQuestionRef>;
  questionByForm: Record<string, string>;
  questionByChat: Record<string, string>;
  agentLists: Record<string, TelegramAgentList>;
  processedUpdates: number[];
  unauthorized: Record<string, number>;
  updatedAt: number;
}

const MAX_MESSAGES = 2000;
const MAX_SESSIONS = 500;
const MAX_AGENT_LISTS = 50;
const MAX_PROCESSED_UPDATES = 200;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UNAUTHORIZED_COOLDOWN_MS = 60_000;

function emptyState(): TelegramStateData {
  return {
    version: 1,
    updateOffset: 0,
    activeByChat: {},
    sessions: {},
    messages: {},
    permissions: {},
    permissionByRequest: {},
    questions: {},
    questionByForm: {},
    questionByChat: {},
    agentLists: {},
    processedUpdates: [],
    unauthorized: {},
    updatedAt: Date.now(),
  };
}

function asRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

function loadState(file: string): TelegramStateData {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      telegramLog(`cannot read ${file}: ${errorMessage(error)}`);
    }
    return emptyState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TelegramStateData> | undefined;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
    const state = emptyState();
    state.updateOffset =
      Number.isFinite(Number(parsed.updateOffset)) && Number(parsed.updateOffset) >= 0
        ? Math.floor(Number(parsed.updateOffset))
        : 0;
    state.activeByChat = asRecord<string>(parsed.activeByChat);
    state.sessions = asRecord<TelegramSessionInfo>(parsed.sessions);
    state.messages = asRecord<TelegramMessageRef>(parsed.messages);
    state.permissions = asRecord<TelegramPermissionRef>(parsed.permissions);
    state.permissionByRequest = asRecord<string>(parsed.permissionByRequest);
    state.questions = asRecord<TelegramQuestionRef>(parsed.questions);
    state.questionByForm = asRecord<string>(parsed.questionByForm);
    state.questionByChat = asRecord<string>(parsed.questionByChat);
    state.agentLists = asRecord<TelegramAgentList>(parsed.agentLists);
    state.processedUpdates = Array.isArray(parsed.processedUpdates)
      ? parsed.processedUpdates.filter((id): id is number => Number.isInteger(id))
      : [];
    state.unauthorized = asRecord<number>(parsed.unauthorized);
    state.updatedAt = Date.now();
    return state;
  } catch (error) {
    telegramLog(`cannot parse ${file}: ${errorMessage(error)}; starting fresh`);
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // ignore
    }
    return emptyState();
  }
}

/**
 * Small, debounced JSON state store. Kept deliberately synchronous at flush
 * time so a shutdown cannot lose the Telegram update offset or pending ids.
 */
export class TelegramStateStore {
  data: TelegramStateData;
  private timer?: NodeJS.Timeout;
  private dirty = false;

  constructor(private readonly file = telegramStatePath()) {
    this.data = loadState(file);
    this.prune();
  }

  /**
   * Reload state from disk before a location becomes the leader. Non-leaders
   * start with a snapshot from their own launch; by the time they acquire the
   * leader port, the previous leader may have advanced the update offset and
   * recorded pending permission/question tokens.
   */
  reload(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.data = loadState(this.file);
    this.prune();
    this.dirty = false;
  }

  get updateOffset(): number {
    return this.data.updateOffset;
  }

  setUpdateOffset(offset: number): void {
    if (!Number.isFinite(offset) || offset < this.data.updateOffset) return;
    this.data.updateOffset = Math.floor(offset);
    this.save();
  }

  hasProcessed(updateId: number): boolean {
    return this.data.processedUpdates.includes(updateId);
  }

  markProcessed(updateId: number): void {
    if (this.hasProcessed(updateId)) return;
    this.data.processedUpdates.push(updateId);
    if (this.data.processedUpdates.length > MAX_PROCESSED_UPDATES) {
      this.data.processedUpdates.splice(
        0,
        this.data.processedUpdates.length - MAX_PROCESSED_UPDATES,
      );
    }
    this.save();
  }

  setActive(chatId: number, sessionID: string): void {
    this.data.activeByChat[String(chatId)] = sessionID;
    this.save();
  }

  getActive(chatId: number): string | undefined {
    return this.data.activeByChat[String(chatId)];
  }

  clearActive(chatId: number): void {
    delete this.data.activeByChat[String(chatId)];
    this.save();
  }

  upsertSession(info: Partial<TelegramSessionInfo> & { id: string }): TelegramSessionInfo {
    const previous = this.data.sessions[info.id];
    const next: TelegramSessionInfo = {
      id: info.id,
      title: info.title ?? previous?.title ?? info.id,
      directory: info.directory ?? previous?.directory,
      parentID: info.parentID ?? previous?.parentID,
      agent: info.agent ?? previous?.agent,
      status: info.status ?? previous?.status,
      lastEvent: info.lastEvent ?? previous?.lastEvent,
      updatedAt: Date.now(),
    };
    this.data.sessions[info.id] = next;
    this.save();
    return next;
  }

  getSession(id: string): TelegramSessionInfo | undefined {
    return this.data.sessions[id];
  }

  setSessionStatus(id: string, status: AgentStatus, lastEvent?: string): AgentStatus | undefined {
    const previous = this.data.sessions[id];
    if (!previous) return undefined;
    const old = previous.status;
    previous.status = status;
    previous.lastEvent = lastEvent ?? previous.lastEvent;
    previous.updatedAt = Date.now();
    this.save();
    return old;
  }

  rememberMessage(
    chatId: number,
    messageId: number,
    ref: Omit<TelegramMessageRef, "createdAt">,
  ): void {
    this.data.messages[`${chatId}:${messageId}`] = { ...ref, createdAt: Date.now() };
    if (Object.keys(this.data.messages).length > MAX_MESSAGES) this.prune();
    this.save();
  }

  lookupMessage(chatId: number, messageId: number): TelegramMessageRef | undefined {
    return this.data.messages[`${chatId}:${messageId}`];
  }

  forgetMessage(chatId: number, messageId: number): void {
    delete this.data.messages[`${chatId}:${messageId}`];
    this.save();
  }

  addPermission(ref: TelegramPermissionRef): void {
    this.data.permissions[ref.token] = ref;
    this.data.permissionByRequest[ref.requestID] = ref.token;
    this.rememberMessage(ref.chatId, ref.messageId, {
      sessionID: ref.sessionID,
      title: ref.sessionID,
      kind: "permission",
      token: ref.token,
    });
    this.save();
  }

  getPermission(token: string): TelegramPermissionRef | undefined {
    return this.data.permissions[token];
  }

  findPermissionByRequest(requestID: string): TelegramPermissionRef | undefined {
    const token = this.data.permissionByRequest[requestID];
    return token ? this.data.permissions[token] : undefined;
  }

  removePermission(token: string): TelegramPermissionRef | undefined {
    const ref = this.data.permissions[token];
    if (!ref) return undefined;
    delete this.data.permissions[token];
    if (this.data.permissionByRequest[ref.requestID] === token) {
      delete this.data.permissionByRequest[ref.requestID];
    }
    this.forgetMessage(ref.chatId, ref.messageId);
    this.save();
    return ref;
  }

  addQuestion(ref: TelegramQuestionRef): void {
    this.data.questions[ref.token] = ref;
    this.data.questionByForm[ref.formID] = ref.token;
    this.save();
  }

  getQuestion(token: string): TelegramQuestionRef | undefined {
    return this.data.questions[token];
  }

  findQuestionByForm(formID: string): TelegramQuestionRef | undefined {
    const token = this.data.questionByForm[formID];
    return token ? this.data.questions[token] : undefined;
  }

  removeQuestion(token: string): TelegramQuestionRef | undefined {
    const ref = this.data.questions[token];
    if (!ref) return undefined;
    delete this.data.questions[token];
    if (this.data.questionByForm[ref.formID] === token) {
      delete this.data.questionByForm[ref.formID];
    }
    if (this.data.questionByChat[String(ref.chatId)] === token) {
      delete this.data.questionByChat[String(ref.chatId)];
    }
    for (const messageId of ref.messageIds) {
      this.forgetMessage(ref.chatId, messageId);
    }
    this.save();
    return ref;
  }

  setQuestionByChat(chatId: number, token: string | undefined): void {
    if (token) this.data.questionByChat[String(chatId)] = token;
    else delete this.data.questionByChat[String(chatId)];
    this.save();
  }

  getQuestionByChat(chatId: number): string | undefined {
    return this.data.questionByChat[String(chatId)];
  }

  setAgentList(chatId: number, sessionIDs: string[]): void {
    this.data.agentLists[String(chatId)] = { sessionIDs, at: Date.now() };
    this.save();
  }

  getAgentList(chatId: number): TelegramAgentList | undefined {
    return this.data.agentLists[String(chatId)];
  }

  shouldNotifyUnauthorized(chatId: number): boolean {
    const key = String(chatId);
    const last = this.data.unauthorized[key] ?? 0;
    if (Date.now() - last < UNAUTHORIZED_COOLDOWN_MS) return false;
    this.data.unauthorized[key] = Date.now();
    this.save();
    return true;
  }

  /** Drop stale message mappings and cap the state file. */
  prune(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [key, ref] of Object.entries(this.data.messages)) {
      if (ref.createdAt < cutoff) delete this.data.messages[key];
    }
    const entries = Object.entries(this.data.messages);
    if (entries.length > MAX_MESSAGES) {
      entries
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
        .slice(0, entries.length - MAX_MESSAGES)
        .forEach(([key]) => delete this.data.messages[key]);
    }
    for (const [token, ref] of Object.entries(this.data.permissions)) {
      if (ref.createdAt < cutoff) {
        delete this.data.permissions[token];
        if (this.data.permissionByRequest[ref.requestID] === token) {
          delete this.data.permissionByRequest[ref.requestID];
        }
      }
    }
    for (const [token, ref] of Object.entries(this.data.questions)) {
      if (ref.createdAt < cutoff) {
        delete this.data.questions[token];
        if (this.data.questionByForm[ref.formID] === token) {
          delete this.data.questionByForm[ref.formID];
        }
        if (this.data.questionByChat[String(ref.chatId)] === token) {
          delete this.data.questionByChat[String(ref.chatId)];
        }
      }
    }
    for (const [key, at] of Object.entries(this.data.unauthorized)) {
      if (Date.now() - at > MAX_AGE_MS) delete this.data.unauthorized[key];
    }
    const sessions = Object.entries(this.data.sessions);
    if (sessions.length > MAX_SESSIONS) {
      sessions
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
        .slice(0, sessions.length - MAX_SESSIONS)
        .forEach(([key]) => delete this.data.sessions[key]);
    }
    const agentLists = Object.entries(this.data.agentLists);
    if (agentLists.length > MAX_AGENT_LISTS) {
      agentLists
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, agentLists.length - MAX_AGENT_LISTS)
        .forEach(([key]) => delete this.data.agentLists[key]);
    }
  }

  save(immediate = false): void {
    this.dirty = true;
    if (immediate) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 250);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.data.updatedAt = Date.now();
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        fs.renameSync(tmp, this.file);
      } catch {
        fs.rmSync(this.file, { force: true });
        fs.renameSync(tmp, this.file);
      }
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        // Best effort on platforms without POSIX modes.
      }
    } catch (error) {
      telegramLog(`cannot write ${this.file}: ${errorMessage(error)}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
    }
  }
}
