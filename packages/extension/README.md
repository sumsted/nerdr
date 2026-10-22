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
- **Nerdr: Telegram Status** — show polling, event-stream, and pending-input
  health
- **Nerdr: Test Telegram** — send another test message
- **Nerdr: Disable Telegram** — stop polling while keeping the configuration

Chat commands: `/agents`, `/use`, `/mode`, `/status`, `/stop`, and `/help`.
`/mode` switches the active session between OpenCode agents such as Plan and
Build.

The Telegram bridge uses long polling inside the OpenCode plugin, so it needs no
VPS, tunnel, or public webhook. Only the OpenCode instance that binds
`127.0.0.1:49377` polls; all other locations retry quietly. Configuration lives
in `~/.nerdr/telegram.json` with mode `0600`.

Requires the matching OpenCode plugin: copy `nerdr.js` into
`~/.config/opencode/plugins/` (see the root README).
