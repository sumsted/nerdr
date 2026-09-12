import * as vscode from "vscode";
import type { AgentSnapshot, AgentStatus } from "@nerdr/protocol";

const STATUS_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  error: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  blocked: "needs input",
  error: "error",
  working: "working",
  done: "done",
  idle: "idle",
  unknown: "unknown",
};

function statusIcon(agent: AgentSnapshot): vscode.ThemeIcon {
  if (!agent.online) {
    return new vscode.ThemeIcon("debug-disconnect", new vscode.ThemeColor("disabledForeground"));
  }
  switch (agent.status) {
    case "blocked":
      return new vscode.ThemeIcon("bell", new vscode.ThemeColor("list.warningForeground"));
    case "error":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
    case "working":
      return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.green"));
    case "done":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.blue"));
    case "idle":
      return new vscode.ThemeIcon("circle-outline");
    default:
      return new vscode.ThemeIcon("question");
  }
}

export class AgentTreeItem extends vscode.TreeItem {
  constructor(readonly snapshot: AgentSnapshot, label: string = snapshot.identity.title) {
    super(label, vscode.TreeItemCollapsibleState.None);
    const detail = snapshot.online ? STATUS_LABEL[snapshot.status] : "offline";
    const message = snapshot.message ? ` · ${snapshot.message}` : "";
    this.description = `${detail}${message}`;
    this.id = snapshot.identity.id;
    this.contextValue = "nerdr.agent";
    this.iconPath = statusIcon(snapshot);
    this.tooltip = this.buildTooltip(snapshot);
    this.command = {
      command: "nerdr.focusAgent",
      title: "Focus Agent Terminal",
      arguments: [this],
    };
  }

  private buildTooltip(agent: AgentSnapshot): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${agent.identity.title}**\n\n`);
    md.appendMarkdown(`- Status: \`${agent.status}\`${agent.online ? "" : " (offline)"}\n`);
    if (agent.message) md.appendMarkdown(`- Detail: ${agent.message}\n`);
    md.appendMarkdown(`- Directory: \`${agent.identity.directory}\`\n`);
    if (agent.identity.worktree) md.appendMarkdown(`- Worktree: \`${agent.identity.worktree}\`\n`);
    if (agent.identity.sessionID) md.appendMarkdown(`- Session: \`${agent.identity.sessionID}\`\n`);
    if (agent.identity.slug) md.appendMarkdown(`- Slug: \`${agent.identity.slug}\`\n`);
    if (agent.identity.agent) md.appendMarkdown(`- Agent: \`${agent.identity.agent}\`\n`);
    if (agent.identity.model) md.appendMarkdown(`- Model: \`${agent.identity.model}\`\n`);
    md.appendMarkdown(`- PID: \`${agent.identity.pid}\`\n`);
    if (agent.lastEvent) md.appendMarkdown(`- Last event: \`${agent.lastEvent}\`\n`);
    md.appendMarkdown(`- Updated: ${new Date(agent.updatedAt).toLocaleTimeString()}\n`);
    return md;
  }
}

/** Tree data provider backing both the activity-bar and panel Nerdr views. */
export class AgentsProvider implements vscode.TreeDataProvider<AgentTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly getAgents: () => AgentSnapshot[]) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AgentTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AgentTreeItem): AgentTreeItem[] {
    if (element) return [];
    const agents = [...this.getAgents()].sort(compareAgents);
    const counts = new Map<string, number>();
    for (const agent of agents) {
      const key = agent.identity.title;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return agents.map((agent) => new AgentTreeItem(agent, disambiguate(agent, counts)));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

/** Append the session slug when two agents share the same directory name. */
function disambiguate(agent: AgentSnapshot, counts: Map<string, number>): string {
  const title = agent.identity.title;
  if ((counts.get(title) ?? 0) <= 1) return title;
  const suffix = agent.identity.slug || `#${agent.identity.pid}`;
  return `${title} · ${suffix}`;
}

function compareAgents(a: AgentSnapshot, b: AgentSnapshot): number {
  if (a.online !== b.online) return a.online ? -1 : 1;
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  return a.identity.title.localeCompare(b.identity.title);
}
