import * as vscode from "vscode";
import type { AgentSnapshot, AgentStatus } from "@nerdr/protocol";

const TIMEOUT_MS = 5000;
const MAX_QUEUE = 50;
const RETRY_DELAYS_MS = [0, 1000, 5000];
const FAILURE_ALERT_THRESHOLD = 5;

export interface WebhookSettings {
  enabled: boolean;
  url: string;
  states: AgentStatus[];
  cooldownMs: number;
  notifyOffline: boolean;
  includeDetail: boolean;
}

export interface WebhookResult {
  ok: boolean;
  status?: number;
  error?: string;
}

interface QueueItem {
  message: string;
}

/** Local time as HH:MM (24h). */
function clock(): string {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** The exact bare-text body used by `Nerdr: Test Webhook`. */
export function webhookTestMessage(): string {
  return `Ping! Nerdr webhook online at ${clock()} — there's no place like 127.0.0.1.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST a single notification to a webhook. The body is JSON of the form
 * `{ "message": "..." }`; the bearer token (if any) travels only in the
 * Authorization header.
 */
export async function postWebhook(options: {
  url: string;
  token?: string;
  message: string;
  timeoutMs?: number;
}): Promise<WebhookResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "nerdr",
  };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: options.message }),
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "AbortError"
          ? "timed out"
          : error.message
        : String(error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function phrase(agent: AgentSnapshot): string {
  switch (agent.status) {
    case "blocked": {
      const event = agent.lastEvent ?? "";
      if (event.startsWith("question")) return "is asking a question";
      if (event.includes("permission")) return "needs permission";
      return "needs input";
    }
    case "error":
      return "errored";
    case "done":
      return "is done";
    case "idle":
      return "is idle";
    case "working":
      return "is working";
    default:
      return "status unknown";
  }
}

/**
 * Watches agent status transitions and POSTs one-line notifications. Sends are
 * serialized to preserve ordering, with a small retry budget; the UI is never
 * blocked and failures are logged rather than surfaced per message.
 */
export class WebhookNotifier implements vscode.Disposable {
  private readonly lastStatus = new Map<string, AgentStatus>();
  private readonly lastOnline = new Map<string, boolean>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly queue: QueueItem[] = [];
  private sending = false;
  private consecutiveFailures = 0;
  private warned = false;
  private disposed = false;

  constructor(
    private readonly getAgents: () => AgentSnapshot[],
    private readonly getSettings: () => WebhookSettings,
    private readonly getToken: () => Thenable<string | undefined>,
    private readonly log: (message: string) => void,
    private readonly warn: (message: string) => void,
  ) {}

  /** Recompute transitions across every known agent and enqueue what changed. */
  evaluate(): void {
    const settings = this.getSettings();
    const now = Date.now();
    const live = new Set<string>();

    for (const agent of this.getAgents()) {
      const id = agent.identity.id;
      live.add(id);
      const previousStatus = this.lastStatus.get(id);
      const previousOnline = this.lastOnline.get(id);
      this.lastStatus.set(id, agent.status);
      this.lastOnline.set(id, agent.online);

      if (!settings.enabled || !settings.url) continue;

      if (previousOnline === true && !agent.online && settings.notifyOffline) {
        this.maybeEnqueue(id, now, settings, {
          message: `${agent.identity.title} went offline at ${clock()}`,
        });
        continue;
      }
      if (!agent.online) continue;
      if (previousStatus === undefined || previousStatus === agent.status) continue;
      if (!settings.states.includes(agent.status)) continue;
      this.maybeEnqueue(id, now, settings, {
        message: this.format(agent, settings),
      });
    }

    for (const id of [...this.lastStatus.keys()]) {
      if (!live.has(id)) {
        this.lastStatus.delete(id);
        this.lastOnline.delete(id);
        this.lastSentAt.delete(id);
      }
    }
  }

  private format(agent: AgentSnapshot, settings: WebhookSettings): string {
    const detail = settings.includeDetail && agent.message ? ` — ${agent.message}` : "";
    return `${agent.identity.title} ${phrase(agent)} at ${clock()}${detail}`;
  }

  private maybeEnqueue(
    id: string,
    now: number,
    settings: WebhookSettings,
    item: QueueItem,
  ): void {
    const last = this.lastSentAt.get(id) ?? 0;
    if (now - last < settings.cooldownMs) return;
    this.lastSentAt.set(id, now);
    this.enqueue(item);
  }

  private enqueue(item: QueueItem): void {
    if (this.disposed) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      this.log("webhook: queue full, dropped oldest message");
    }
    this.queue.push(item);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (item) await this.deliver(item);
      }
    } finally {
      this.sending = false;
    }
  }

  private async deliver(item: QueueItem): Promise<void> {
    const settings = this.getSettings();
    if (!settings.enabled || !settings.url) return;
    const token = await this.getToken();

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay) await sleep(delay);
      const result = await postWebhook({
        url: settings.url,
        token,
        message: item.message,
      });
      if (result.ok) {
        this.consecutiveFailures = 0;
        this.warned = false;
        this.log(`webhook: sent ${item.message} (${result.status})`);
        return;
      }
      this.log(
        `webhook: attempt ${attempt + 1} failed: ${result.error ?? `HTTP ${result.status}`}`,
      );
      if (result.status && result.status >= 400 && result.status < 500 && result.status !== 429) {
        break;
      }
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= FAILURE_ALERT_THRESHOLD && !this.warned) {
      this.warned = true;
      this.warn(
        `Nerdr: webhook has failed ${this.consecutiveFailures} times. Check nerdr.webhook.url and the token.`,
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.lastStatus.clear();
    this.lastOnline.clear();
    this.lastSentAt.clear();
  }
}
