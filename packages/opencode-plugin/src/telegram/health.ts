import type { OpencodeServiceHealth, OpencodeServiceState } from "@nerdr/protocol";
import { DEFAULT_OPENCODE_API_URL } from "@nerdr/protocol";
import { OpencodeClient, OpencodeError, readServiceMeta } from "./opencode.js";
import { errorMessage, telegramLog } from "./log.js";

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 5_000;
/** Avoid noisy flapping on a single lost request. */
const FAILURE_THRESHOLD = 2;

type TransitionListener = (
  current: OpencodeServiceHealth,
  previous: OpencodeServiceHealth,
) => void;

function errorCode(error: unknown): string | undefined {
  const record = error as
    | { code?: string; cause?: { code?: string; errors?: Array<{ code?: string }> } }
    | undefined;
  return (
    record?.code ??
    record?.cause?.code ??
    record?.cause?.errors?.find((entry) => entry.code)?.code
  );
}

function classify(error: unknown): { state: OpencodeServiceState; message: string } {
  if (error instanceof OpencodeError) {
    if (error.status === 401 || error.status === 403) {
      return { state: "unauthorized", message: error.message };
    }
    if (error.status !== undefined && error.status >= 500) {
      return { state: "degraded", message: error.message };
    }
    return { state: "degraded", message: error.message };
  }

  const name = (error as { name?: string } | undefined)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return {
      state: "timeout",
      message: "OpenCode did not respond within the probe timeout",
    };
  }

  const code = errorCode(error);
  if (code === "ECONNREFUSED") {
    return {
      state: "unreachable",
      message: "connection refused (the OpenCode service is not running)",
    };
  }
  if (code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ECONNRESET" || code === "EPIPE") {
    return { state: "unreachable", message: `connection failed (${code})` };
  }

  return { state: "degraded", message: errorMessage(error) };
}

export function describeOpencodeState(health: OpencodeServiceHealth): string {
  const detail = health.lastError ? ` — ${health.lastError}` : "";
  switch (health.state) {
    case "ok":
      return health.latencyMs === undefined
        ? "reachable"
        : `reachable (${health.latencyMs}ms)`;
    case "unreachable":
      return `unreachable${detail}`;
    case "timeout":
      return `not responding${detail}`;
    case "unauthorized":
      return `rejected the bridge credentials${detail}`;
    case "degraded":
      return `degraded${detail}`;
    default:
      return "not checked yet";
  }
}

/**
 * Background liveness probe for the local OpenCode HTTP service.
 *
 * The daemon runs independently of OpenCode, so this is what lets the bot say
 * "OpenCode is unreachable" instead of going silent. A service that is merely
 * slow to answer is reported separately from one whose process is gone.
 */
export class ServiceHealth {
  private current: OpencodeServiceHealth;
  private timer?: NodeJS.Timeout;
  private client?: OpencodeClient;
  private clientUrl?: string;
  private readonly listeners = new Set<TransitionListener>();
  private probing = false;
  private stopped = true;

  constructor(
    private readonly getUrl: () => string = () => DEFAULT_OPENCODE_API_URL,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.current = {
      state: "unknown",
      url: getUrl(),
      consecutiveFailures: 0,
    };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.probeNow();
    this.timer = setInterval(() => void this.probeNow(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): OpencodeServiceHealth {
    const meta = readServiceMeta();
    const url = this.getUrl();
    return {
      ...this.current,
      url,
      servicePid: meta.pid,
      serviceVersion: meta.version,
    };
  }

  onTransition(listener: TransitionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async probeNow(): Promise<void> {
    if (this.probing || this.stopped) return;
    this.probing = true;
    const url = this.getUrl();
    this.current = { ...this.current, url };
    try {
      if (!this.client || this.clientUrl !== url) {
        this.client = new OpencodeClient(url);
        this.clientUrl = url;
      }
      const latencyMs = await this.client.probe(this.timeoutMs);
      this.apply({
        state: "ok",
        url,
        lastProbeAt: Date.now(),
        lastOkAt: Date.now(),
        latencyMs,
        consecutiveFailures: 0,
        lastError: undefined,
      });
    } catch (error) {
      const { state, message } = classify(error);
      const consecutiveFailures = this.current.consecutiveFailures + 1;
      const nextState =
        consecutiveFailures >= FAILURE_THRESHOLD ? state : this.current.state;
      if (nextState !== "ok" && nextState !== this.current.state) {
        telegramLog(`OpenCode health: ${state} (${message})`);
      }
      this.apply({
        state: nextState,
        url,
        lastProbeAt: Date.now(),
        consecutiveFailures,
        lastError: message,
      });
    } finally {
      this.probing = false;
    }
  }

  private apply(patch: Partial<OpencodeServiceHealth>): void {
    const previous = this.current;
    this.current = { ...this.current, ...patch };
    if (previous.state === this.current.state) return;
    for (const listener of this.listeners) {
      try {
        listener(this.current, previous);
      } catch (error) {
        telegramLog(`health listener failed: ${errorMessage(error)}`);
      }
    }
  }
}
