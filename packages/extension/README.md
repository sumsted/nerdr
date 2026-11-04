# Nerdr

Herdr-like agent awareness for OpenCode agents running in VSCodium terminals.

Requires **OpenCode 2.x** (the shared `opencode serve` service and its
per-workspace locations).

See the repository root `README.md` for full architecture, installation, settings,
and limitations.

## Features

- `nerdr.agents` view — roster of agents and their state (left activity bar)
- `nerdr.agentsPanel` view — the same roster in the bottom panel
- States: `working`, `blocked`, `idle`, `done`, `error`
- Bell tones when an agent needs attention (`blocked`/`error`), and on completion
  (`done`) for the `build`/`plan` agents
- Click an agent (or run **Nerdr: Focus Agent Terminal**) to jump to its terminal
- Agents are named after the workspace directory they were started in
  (duplicates get a session slug suffix)
- Optional private Telegram chat bridge: reply to notifications to prompt agents,
  and answer permission/question requests with buttons

Telegram commands:

- **Nerdr: Configure Telegram** — paste a @BotFather token, choose the private
  chat and notification states, and send a test message
- **Nerdr: Start Telegram Bridge** — start the standalone daemon
- **Nerdr: Stop Telegram Bridge** / **Restart Telegram Bridge**
- **Nerdr: Manage Telegram Bridge** — one menu for start/stop/status/log
- **Nerdr: Telegram Status** — show daemon, polling, OpenCode, and pending-input
  health
- **Nerdr: Show Telegram Log** — open `~/.nerdr/telegram.log`
- **Nerdr: Test Telegram** — send another test message
- **Nerdr: Disable Telegram** — stop polling while keeping the configuration

Chat commands: `/agents`, `/use`, `/mode`, `/status`, `/health`, `/stop`, and
`/help`. `/mode` switches the active session between OpenCode agents such as
Plan and Build.

The Telegram bridge is a standalone local daemon managed by this extension. It
uses long polling, so it needs no VPS, tunnel, or public webhook, and it keeps
running when the OpenCode plugin stops or the VSCodium window closes. There is no
boot service: after a reboot, run **Nerdr: Start Telegram Bridge**.
`nerdr.telegram.autoStart` (default `false`) can start it automatically when
VSCodium activates; `nerdr.telegram.stopOnExit` (default `false`) keeps it
running when the window closes. Configuration lives in
`~/.nerdr/telegram.json` with mode `0600`; the control token is in
`~/.nerdr/telegram-control-token`.

The daemon also probes the local OpenCode API. When OpenCode is unreachable or
unresponsive, `/status` and `/health` say so, `/agents` shows cached agents marked
stale, and prompts are rejected explicitly rather than silently queued.

Requires the matching OpenCode plugin for the agent roster. The Telegram daemon
talks to the OpenCode HTTP API directly and does not require the plugin to be
running; see the root README.
