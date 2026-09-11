import * as vscode from "vscode";
import type { AgentStatus } from "@nerdr/protocol";

export interface NerdrConfig {
  port: number;
  bellEnabled: boolean;
  bellStates: AgentStatus[];
  /** Agent/mode names that may trigger non-attention bells (empty = all). */
  bellAgents: string[];
  bellCommand: string;
  bellCooldownMs: number;
  showStatusBar: boolean;
  staleTimeoutMs: number;
}

const VALID_STATES: AgentStatus[] = [
  "working",
  "blocked",
  "idle",
  "done",
  "error",
  "unknown",
];

export function readConfig(): NerdrConfig {
  const cfg = vscode.workspace.getConfiguration("nerdr");
  const rawStates = cfg.get<string[]>("bell.states", ["blocked", "error", "done"]);
  const bellStates = rawStates.filter((state): state is AgentStatus =>
    (VALID_STATES as string[]).includes(state),
  );
  const bellAgents = cfg
    .get<string[]>("bell.agents", ["build", "plan"])
    .map((name) => name.trim())
    .filter(Boolean);
  return {
    port: cfg.get<number>("port", 27182),
    bellEnabled: cfg.get<boolean>("bell.enabled", true),
    bellStates: bellStates.length ? bellStates : ["blocked", "error", "done"],
    bellAgents,
    bellCommand: cfg.get<string>("bell.command", ""),
    bellCooldownMs: Math.max(0, cfg.get<number>("bell.cooldownMs", 5000)),
    showStatusBar: cfg.get<boolean>("showStatusBar", true),
    staleTimeoutMs: Math.max(5000, cfg.get<number>("staleTimeoutMs", 45000)),
  };
}
