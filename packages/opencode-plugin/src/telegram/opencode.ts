import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TelegramFormValue } from "./state.js";

export class OpencodeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "OpencodeError";
  }
}

export interface OpencodeSession {
  id: string;
  title?: string;
  parentID?: string;
  agent?: string;
  slug?: string;
  location?: { directory?: string };
  time?: { created?: number; updated?: number };
}

export interface OpencodeAgent {
  id: string;
  name: string;
  mode?: string;
  hidden?: boolean;
  description?: string;
}

export interface OpencodePermission {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  message?: string;
  save?: string[];
}

export interface OpencodeFormField {
  key: string;
  type: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  options?: Array<{ value: string; label: string; description?: string }>;
  custom?: boolean;
  minItems?: number;
  maxItems?: number;
  default?: TelegramFormValue;
}

export interface OpencodeForm {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: OpencodeFormField[];
}

export type OpencodeEvent = {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
  location?: { directory?: string };
};

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

function serviceFileCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.OPENCODE_SERVICE_FILE) candidates.push(process.env.OPENCODE_SERVICE_FILE);
  candidates.push(path.join(os.homedir(), ".config", "opencode", "service.json"));
  return candidates;
}

function readServicePassword(): string | undefined {
  for (const file of serviceFileCandidates()) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { password?: unknown };
      if (typeof raw.password === "string" && raw.password) return raw.password;
    } catch {
      // Try the next location.
    }
  }
  const env = process.env.OPENCODE_PASSWORD;
  return env && env.trim() ? env.trim() : undefined;
}

/**
 * Client for the local OpenCode API. The API is loopback-only and protected by
 * the Basic-auth password in ~/.config/opencode/service.json.
 */
export class OpencodeClient {
  private password?: string;
  private readonly baseUrl: string;

  constructor(apiUrl: string) {
    this.baseUrl = apiUrl.replace(/\/+$/, "");
  }

  private getPassword(): string {
    if (!this.password) {
      this.password = readServicePassword();
    }
    if (!this.password) {
      throw new OpencodeError(
        "OpenCode API password not found (expected ~/.config/opencode/service.json)",
      );
    }
    return this.password;
  }

  private async request<T>(
    pathname: string,
    init: RequestInit = {},
    retryAuth = true,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    timer.unref?.();
    const external = init.signal;
    const onAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", basicAuth(this.getPassword()));
      if (init.body) headers.set("Content-Type", "application/json");
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }

      if (response.status === 401 && retryAuth) {
        this.password = undefined;
        return this.request<T>(pathname, init, false);
      }
      if (!response.ok) {
        const record =
          body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
        const message =
          (typeof record?.message === "string" && record.message) ||
          (typeof record?._tag === "string" && record._tag) ||
          `OpenCode HTTP ${response.status}`;
        throw new OpencodeError(
          message,
          response.status,
          typeof record?._tag === "string" ? record._tag : undefined,
        );
      }
      return body as T;
    } catch (error) {
      if (error instanceof OpencodeError) throw error;
      if (controller.signal.aborted) {
        if (external?.aborted) throw error;
        throw new OpencodeError(`OpenCode request timed out: ${pathname}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    }
  }

  private sessionPath(sessionID: string, suffix = ""): string {
    return `/api/session/${encodeURIComponent(sessionID)}${suffix}`;
  }

  async activeSessions(signal?: AbortSignal): Promise<string[]> {
    const body = await this.request<{ data?: Record<string, unknown> }>(
      "/api/session/active",
      { signal },
    );
    return Object.keys(body.data ?? {});
  }

  async listSessions(limit = 30, signal?: AbortSignal): Promise<OpencodeSession[]> {
    const body = await this.request<{ data?: OpencodeSession[] }>(
      `/api/session?order=desc&limit=${encodeURIComponent(String(limit))}`,
      { signal },
    );
    return Array.isArray(body.data) ? body.data : [];
  }

  async getSession(sessionID: string, signal?: AbortSignal): Promise<OpencodeSession> {
    const body = await this.request<{ data?: OpencodeSession }>(this.sessionPath(sessionID), {
      signal,
    });
    if (!body.data) throw new OpencodeError(`Session not found: ${sessionID}`, 404);
    return body.data;
  }

  async listAgents(directory?: string, signal?: AbortSignal): Promise<OpencodeAgent[]> {
    const query = directory
      ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
      : "";
    const body = await this.request<{ data?: OpencodeAgent[] }>(`/api/agent${query}`, {
      signal,
    });
    return Array.isArray(body.data) ? body.data : [];
  }

  async switchAgent(sessionID: string, agentID: string): Promise<void> {
    await this.request<unknown>(this.sessionPath(sessionID, "/agent"), {
      method: "POST",
      body: JSON.stringify({ agent: agentID }),
    });
  }

  async prompt(sessionID: string, text: string, delivery: "queue" | "steer" = "queue"): Promise<void> {
    await this.request<unknown>(this.sessionPath(sessionID, "/prompt"), {
      method: "POST",
      body: JSON.stringify({ text, delivery }),
    });
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.request<unknown>(this.sessionPath(sessionID, "/interrupt"), {
      method: "POST",
    });
  }

  async listPermissions(sessionID: string, signal?: AbortSignal): Promise<OpencodePermission[]> {
    const body = await this.request<{ data?: OpencodePermission[] }>(
      this.sessionPath(sessionID, "/permission"),
      { signal },
    );
    return Array.isArray(body.data) ? body.data : [];
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: "once" | "always" | "reject",
    message?: string,
  ): Promise<void> {
    await this.request<unknown>(
      this.sessionPath(
        sessionID,
        `/permission/${encodeURIComponent(requestID)}/reply`,
      ),
      {
        method: "POST",
        body: JSON.stringify({ decision, ...(message ? { message } : {}) }),
      },
    );
  }

  async listForms(sessionID: string, signal?: AbortSignal): Promise<OpencodeForm[]> {
    const body = await this.request<{ data?: OpencodeForm[] }>(
      this.sessionPath(sessionID, "/form"),
      { signal },
    );
    return Array.isArray(body.data) ? body.data : [];
  }

  async replyForm(
    sessionID: string,
    formID: string,
    answer: Record<string, TelegramFormValue>,
  ): Promise<void> {
    await this.request<unknown>(
      this.sessionPath(sessionID, `/form/${encodeURIComponent(formID)}/reply`),
      {
        method: "POST",
        body: JSON.stringify({ answer }),
      },
    );
  }

  /**
   * Consume the server-sent event stream. The stream is shared by every
   * OpenCode location; callers filter by session id. Returns when the stream
   * closes or the signal aborts.
   */
  async subscribeEvents(
    onEvent: (event: OpencodeEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/event`, {
      method: "GET",
      headers: {
        Authorization: basicAuth(this.getPassword()),
        Accept: "text/event-stream",
      },
      signal,
    });
    if (response.status === 401) {
      this.password = undefined;
      throw new OpencodeError("OpenCode API unauthorized", 401, "UnauthorizedError");
    }
    if (!response.ok || !response.body) {
      throw new OpencodeError(`OpenCode event stream HTTP ${response.status}`, response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data) {
            try {
              onEvent(JSON.parse(data) as OpencodeEvent);
            } catch {
              // Ignore malformed frames; the stream continues.
            }
          }
          index = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
