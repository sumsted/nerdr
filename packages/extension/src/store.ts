import * as vscode from "vscode";
import type { AgentIdentity, AgentSnapshot, AgentStatus, SnapshotPayload } from "@nerdr/protocol";

function isFinished(status: AgentStatus): boolean {
  return status === "done" || status === "idle";
}

/** In-memory, observable registry of every agent the bridge has seen. */
export class AgentStore implements vscode.Disposable {
  private readonly agents = new Map<string, AgentSnapshot>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  hello(identity: AgentIdentity, snapshot: SnapshotPayload): void {
    const existing = this.agents.get(identity.id);
    const now = Date.now();
    this.agents.set(identity.id, {
      identity,
      status: snapshot.status,
      message: snapshot.message,
      attention:
        snapshot.attention ?? (snapshot.status === "blocked" || snapshot.status === "error"),
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      lastEvent: snapshot.lastEvent,
      online: true,
    });
    this.fire();
  }

  setState(
    agentId: string,
    status: AgentStatus,
    message?: string,
    attention?: boolean,
    lastEvent?: string,
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.status = status;
    agent.message = message;
    agent.attention = attention ?? (status === "blocked" || status === "error");
    agent.lastEvent = lastEvent;
    agent.updatedAt = Date.now();
    agent.online = true;
    this.fire();
  }

  patchMeta(agentId: string, patch: Partial<AgentIdentity>): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    Object.assign(agent.identity, patch);
    agent.updatedAt = Date.now();
    this.fire();
  }

  touch(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.online = true;
    agent.updatedAt = Date.now();
  }

  markOffline(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.online = false;
    agent.updatedAt = Date.now();
    this.fire();
  }

  remove(agentId: string): void {
    if (this.agents.delete(agentId)) this.fire();
  }

  clearFinished(): number {
    let removed = 0;
    for (const [id, agent] of this.agents) {
      if (isFinished(agent.status)) {
        this.agents.delete(id);
        removed += 1;
      }
    }
    if (removed) this.fire();
    return removed;
  }

  clearOffline(): number {
    let removed = 0;
    for (const [id, agent] of this.agents) {
      if (!agent.online) {
        this.agents.delete(id);
        removed += 1;
      }
    }
    if (removed) this.fire();
    return removed;
  }

  get(agentId: string): AgentSnapshot | undefined {
    return this.agents.get(agentId);
  }

  list(): AgentSnapshot[] {
    return [...this.agents.values()];
  }

  private fire(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
