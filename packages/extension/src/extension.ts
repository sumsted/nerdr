import * as vscode from "vscode";
import type { AgentSnapshot, AgentStatus } from "@nerdr/protocol";
import { ATTENTION_STATUSES } from "@nerdr/protocol";
import { readConfig, type NerdrConfig } from "./config.js";
import { AgentStore } from "./store.js";
import { BridgeServer } from "./server.js";
import { TerminalLocator } from "./terminalLocator.js";
import { playBell } from "./bell.js";
import { AgentTreeItem, AgentsProvider } from "./agentsProvider.js";

const VIEW_IDS = ["nerdr.agents", "nerdr.agentsPanel"];
const STALE_CHECK_MS = 10_000;

let output: vscode.OutputChannel;

function log(message: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Nerdr");
  context.subscriptions.push(output);

  let config = readConfig();
  const store = new AgentStore();
  const provider = new AgentsProvider(() => store.list());
  const locator = new TerminalLocator(log);
  locator.watch();

  const treeViews: vscode.TreeView<AgentTreeItem>[] = [];
  for (const viewId of VIEW_IDS) {
    const view = vscode.window.createTreeView(viewId, {
      treeDataProvider: provider,
      showCollapseAll: false,
    });
    treeViews.push(view);
    context.subscriptions.push(view);
  }

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "workbench.view.extension.nerdr";
  context.subscriptions.push(statusBar);

  const lastStatus = new Map<string, AgentStatus>();
  const lastBellAt = new Map<string, number>();

  let server: BridgeServer | undefined;

  async function startServer(preferredPort: number): Promise<void> {
    server?.dispose();
    server = new BridgeServer({
      onHello: (identity, snapshot) => {
        log(`agent online: ${identity.title} (${identity.id}) in ${identity.directory}`);
        store.hello(identity, snapshot);
        void locator.refresh();
      },
      onState: (agentId, status, message, attention, lastEvent) =>
        store.setState(agentId, status, message, attention, lastEvent),
      onMeta: (agentId, patch) => store.patchMeta(agentId, patch),
      onPing: (agentId) => {
        if (agentId) store.touch(agentId);
      },
      onBye: (agentId) => {
        log(`agent said goodbye: ${agentId}`);
        store.remove(agentId);
      },
      onDisconnect: (agentId) => {
        if (agentId) {
          log(`agent disconnected: ${agentId}`);
          store.markOffline(agentId);
        }
      },
      onCommandResult: (result) => {
        if (result.ok) {
          log(`command ${result.command} ok for ${result.agentId} (${result.requestId})`);
          return;
        }
        log(`command ${result.command} failed for ${result.agentId}: ${result.error}`);
        void vscode.window.showWarningMessage(
          `Nerdr: ${result.command} failed: ${result.error ?? "unknown error"}`,
        );
      },
    });
    context.subscriptions.push(server);
    try {
      const port = await server.start(preferredPort);
      log(`bridge listening on 127.0.0.1:${port}`);
    } catch (error) {
      log(`failed to start bridge: ${String(error)}`);
      void vscode.window.showErrorMessage(`Nerdr: failed to start agent bridge: ${String(error)}`);
    }
  }

  function renderStatusBar(): void {
    const agents = store.list();
    const online = agents.filter((agent) => agent.online);
    const attention = online.filter((agent) => agent.attention).length;
    const working = online.filter((agent) => agent.status === "working").length;

    if (!config.showStatusBar) {
      statusBar.hide();
      return;
    }
    if (agents.length === 0) {
      statusBar.text = "$(radio-tower) Nerdr";
      statusBar.tooltip = "Nerdr: waiting for OpenCode agents";
      statusBar.backgroundColor = undefined;
      statusBar.show();
      return;
    }
    statusBar.text = `$(radio-tower) ${agents.length} agent${agents.length === 1 ? "" : "s"}${attention ? ` $(bell) ${attention}` : ""}`;
    statusBar.tooltip = `${attention} need input · ${working} working · ${online.length} online`;
    statusBar.backgroundColor =
      attention > 0 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    statusBar.show();
  }

  function evaluateBells(): void {
    for (const agent of store.list()) {
      const previous = lastStatus.get(agent.identity.id);
      lastStatus.set(agent.identity.id, agent.status);
      if (!config.bellEnabled || !agent.online) continue;
      if (previous === agent.status) continue;
      if (!config.bellStates.includes(agent.status)) continue;
      const isAttention = ATTENTION_STATUSES.includes(agent.status);
      if (config.bellAgents.length > 0 && !isAttention) {
        const name = agent.identity.agent;
        if (!name || !config.bellAgents.includes(name)) continue;
      }
      const last = lastBellAt.get(agent.identity.id) ?? 0;
      if (Date.now() - last < config.bellCooldownMs) continue;
      lastBellAt.set(agent.identity.id, Date.now());
      log(`bell: ${agent.identity.title} -> ${agent.status}${agent.identity.agent ? ` (${agent.identity.agent})` : ""}`);
      playBell(config.bellCommand, log);
    }
    const live = new Set(store.list().map((agent) => agent.identity.id));
    for (const id of [...lastStatus.keys()]) if (!live.has(id)) lastStatus.delete(id);
    for (const id of [...lastBellAt.keys()]) if (!live.has(id)) lastBellAt.delete(id);
  }

  function updateEmptyMessage(): void {
    const message =
      store.list().length === 0
        ? "No OpenCode agents connected. Run `opencode` in a VSCodium terminal with the Nerdr plugin installed."
        : undefined;
    for (const view of treeViews) view.message = message;
  }

  context.subscriptions.push(
    store.onDidChange(() => {
      provider.refresh();
      renderStatusBar();
      updateEmptyMessage();
      evaluateBells();
    }),
  );

  const staleTimer = setInterval(() => {
    const now = Date.now();
    for (const agent of store.list()) {
      if (agent.online && now - agent.updatedAt > config.staleTimeoutMs) {
        log(`agent went stale: ${agent.identity.id}`);
        store.markOffline(agent.identity.id);
      }
    }
  }, STALE_CHECK_MS);
  context.subscriptions.push({ dispose: () => clearInterval(staleTimer) });

  context.subscriptions.push(
    vscode.commands.registerCommand("nerdr.refresh", async () => {
      await locator.refresh();
      provider.refresh();
      renderStatusBar();
      updateEmptyMessage();
    }),

    vscode.commands.registerCommand("nerdr.focusAgent", async (item?: AgentTreeItem) => {
      const agent: AgentSnapshot | undefined =
        item instanceof AgentTreeItem ? item.snapshot : undefined;
      if (!agent) {
        void vscode.window.showInformationMessage("Nerdr: select an agent from the Nerdr view.");
        return;
      }
      await locator.refresh();
      const terminal = locator.findTerminal(agent.identity.pid);
      if (terminal) {
        terminal.show();
      } else {
        void vscode.window.showWarningMessage(
          `Nerdr: could not find a terminal for "${agent.identity.title}" (pid ${agent.identity.pid}).`,
        );
      }
    }),

    vscode.commands.registerCommand("nerdr.testBell", () => {
      playBell(config.bellCommand, log);
    }),

    vscode.commands.registerCommand("nerdr.renameAgent", async (item?: AgentTreeItem) => {
      const agent = item instanceof AgentTreeItem ? item.snapshot : undefined;
      if (!agent) {
        void vscode.window.showInformationMessage("Nerdr: select an agent to rename.");
        return;
      }
      const title = await vscode.window.showInputBox({
        prompt: `Rename agent "${agent.identity.title}"`,
        value: agent.identity.title,
        placeHolder: "New agent name",
        validateInput: (value) => (value.trim() ? undefined : "Name cannot be empty"),
      });
      if (title === undefined) return;
      const trimmed = title.trim();
      if (!trimmed) return;
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sent = server?.sendToAgent(agent.identity.id, {
        type: "command",
        command: "rename",
        agentId: agent.identity.id,
        title: trimmed,
        requestId,
      });
      if (!sent) {
        void vscode.window.showWarningMessage(
          `Nerdr: agent "${agent.identity.title}" is not connected.`,
        );
        return;
      }
      store.patchMeta(agent.identity.id, { title: trimmed });
    }),

    vscode.commands.registerCommand("nerdr.clearFinished", () => {
      const removed = store.clearFinished();
      log(`cleared ${removed} finished agent(s)`);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("nerdr")) return;
      const next = readConfig();
      const portChanged = next.port !== config.port;
      config = next;
      renderStatusBar();
      evaluateBells();
      if (portChanged) await startServer(config.port);
    }),
  );

  context.subscriptions.push(store, provider, locator);
  context.subscriptions.push({ dispose: () => server?.dispose() });

  renderStatusBar();
  updateEmptyMessage();
  void startServer(config.port).then(() => locator.refresh());
  log("Nerdr activated");
}

export function deactivate(): void {
  // Disposables registered in context handle teardown.
}
