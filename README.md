# Nerdr

A [Herdr](https://herdr.dev)-style awareness layer for **OpenCode** agents running
inside **VSCodium**. Nerdr answers four questions at a glance:

1. **Which VSCodium terminals host OpenCode agents?**
2. **What state is each agent in?** — `working`, `blocked`, `idle`, `done`, `error`
3. **Which agent needs me right now?** — bell tones for attention (and for
   `build`/`plan` completions)
4. **Show me the roster** — an Agents list in a Nerdr panel

The core is two cooperating pieces: a small **OpenCode plugin** that streams
lifecycle state, and a **VSCodium extension** that aggregates it, renders the
list, locates the owning terminal, and rings the bell. An optional **standalone
Telegram daemon** adds remote control without living inside either one.

Nerdr targets **OpenCode 2.x** (the shared `opencode serve` service and its
per-workspace *locations*). OpenCode 1.x is not supported.

```
┌─────────────────────────┐   loopback TCP (newline JSON)   ┌───────────────────────────┐
│ OpenCode 2.x service    │ ──────────────────────────────▶ │ Nerdr VSCodium extension  │
│ @nerdr/opencode-plugin  │ ◀────────────────────────────── │  • BridgeServer (:27182)  │
│  • session/status hooks │     welcome / pong               │  • AgentStore             │
│  • permission + question│                                 │  • Agents TreeView        │
└─────────────────────────┘                                 │  • TerminalLocator (ps)   │
             ▲                                               │  • Bell                   │
             └───────── ~/.nerdr/bridge.json (port+token) ───┘                           │
                                                             └───────────────────────────┘
```

The tracked unit is the **OpenCode workspace/location** (one project directory).
OpenCode 2.x serves every workspace from a single shared `opencode serve`
process, so Nerdr identifies agents by workspace directory rather than by OS
process.

A standalone local daemon can also bridge a private Telegram chat to those
agents. Reply to a notification to prompt that agent, answer permissions and
questions with buttons, switch Plan/Build with `/mode`, and get the final
assistant text when a turn finishes. The daemon runs independently of OpenCode
and VSCodium, so it keeps answering when the plugin stops; it needs no VPS,
public URL, tunnel, or inbound port. See [Telegram](#telegram-native).

## Requirements

- **Node.js 18+** and npm (the build uses npm workspaces)
- **VSCodium 1.85+**
- **OpenCode 2.0+** CLI; the plugin loads inside the shared `opencode serve` service

## Repository layout

```
packages/
  protocol/         Shared wire types + constants (no runtime deps)
  opencode-plugin/  OpenCode plugin, bundled to dist/nerdr.js
  extension/        VSCodium extension, bundled to dist/extension.js
```

## Build from source

```bash
git clone <repository-url> nerdr
cd nerdr
npm install
npm run build       # protocol -> plugin -> extension
npm run typecheck
```

## Install the extension

Package the extension (the build must run first so the daemon bundle exists):

```bash
npm run build
npm run package -w nerdr
# -> packages/extension/nerdr-0.2.0.vsix
```

If you run only `npm run package -w nerdr`, the build output and
`packages/extension/bin/nerdr-telegram.mjs` may be missing and the VSIX will not
contain the Telegram daemon.

Then install the VSIX, either from the VSCodium UI
(**Extensions → "..." → Install from VSIX...**) or from a terminal:

```bash
# macOS (bundled CLI path)
"/Applications/VSCodium.app/Contents/Resources/app/bin/codium" \
  --install-extension packages/extension/nerdr-0.2.0.vsix

# Linux
codium --install-extension packages/extension/nerdr-0.2.0.vsix

# Windows (PowerShell)
& "$env:LOCALAPPDATA\Programs\VSCodium\bin\codium.cmd" `
  --install-extension packages\extension\nerdr-0.2.0.vsix
```

If `codium` is not on your `PATH`, run **"Shell Command: Install 'codium'
command in PATH"** from the Command Palette (macOS/Linux), or use the bundled path
shown above.

The VSIX includes `bin/nerdr-telegram.mjs`. The extension deploys it to
`~/.nerdr/nerdr-telegram.mjs` the first time you start the Telegram bridge, then
runs it with VSCodium's bundled Node runtime (`ELECTRON_RUN_AS_NODE`). No system
Node install or system service is required.

On activation the extension listens on `127.0.0.1:27182` (falling back to the next
free port) and writes `~/.nerdr/bridge.json` with the real port and a per-run token.

For development, open the repository root in VSCodium and press `F5`
(the included `.vscode/launch.json` launches an Extension Development Host).

## Install the OpenCode plugin

Requires **OpenCode 2.0+**. The plugin is a standalone bundle with no runtime
dependencies; copy it into your OpenCode plugins directory (auto-discovered in
both V2 global and project layouts):

```bash
# macOS / Linux
mkdir -p ~/.config/opencode/plugins
cp packages/opencode-plugin/dist/nerdr.js ~/.config/opencode/plugins/nerdr.js
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force "$HOME\.config\opencode\plugins" | Out-Null
Copy-Item packages\opencode-plugin\dist\nerdr.js "$HOME\.config\opencode\plugins\nerdr.js"
```

Or reference it directly in `opencode.json(c)` under the V2 `plugins` key:

```json
{ "plugins": ["./.opencode/plugins/nerdr.js"] }
```

Order does not matter: the plugin discovers the bridge file on every reconnect.
OpenCode 2.0 hot-reloads many changes, but if a running session keeps the old copy
in memory, `opencode service restart` (or restart the session) picks up the new one.

## Install checklist

For a fresh machine, run these in order. The new plugin intentionally does **not**
start Telegram; the daemon is a separate process managed from VSCodium.

1. Build and package:
   ```bash
   npm install
   npm run build
   npm run package -w nerdr
   ```
   `npm run build` must run before packaging. It produces
   `packages/opencode-plugin/dist/nerdr.js` and copies the daemon bundle to
   `packages/extension/bin/nerdr-telegram.mjs`.
2. Install `packages/extension/nerdr-0.2.0.vsix` (see above).
3. Copy the plugin bundle:
   ```bash
   mkdir -p ~/.config/opencode/plugins
   cp packages/opencode-plugin/dist/nerdr.js ~/.config/opencode/plugins/nerdr.js
   ```
4. Reload VSCodium: **Developer: Reload Window**. If OpenCode keeps the old
   plugin loaded, restart it once (`opencode service restart`, which interrupts
   running agents, or restart the session). After reload, the Command Palette
   should list **Nerdr: Start Telegram Bridge**; if it does not, the old
   extension is still active.
5. Configure and start Telegram. **Nerdr: Configure Telegram** writes the config,
   deploys the daemon to `~/.nerdr/nerdr-telegram.mjs`, and starts it. If it is
   already configured, run **Nerdr: Start Telegram Bridge**.
6. Verify the daemon:
   ```bash
   curl -s http://127.0.0.1:49377/health | python3 -m json.tool
   ```
   Expect `"managedBy": "daemon"`, `"daemonVersion": "0.2.0"`, and
   `"opencode": { "state": "ok", ... }`.
7. In Telegram, send `/help`, `/agents`, `/status`, and `/health`.

## Upgrade from 0.1.x

The Telegram poller moved out of the OpenCode plugin and into a standalone
daemon. Installing the new VSIX and copying the plugin is **not enough**: the
new plugin no longer starts Telegram, so the bot stays silent until the daemon is
started.

1. Install the 0.2.0 VSIX.
2. Copy the new `nerdr.js` to `~/.config/opencode/plugins/nerdr.js`.
3. Reload VSCodium.
4. Run **Nerdr: Start Telegram Bridge** (or **Nerdr: Configure Telegram**).
   Start may report that port `49377` is held until the old plugin releases it;
   the daemon is already running and waiting.
5. If the old plugin still owns `127.0.0.1:49377`, the new daemon waits and
   retries. Let OpenCode hot-reload the new plugin; if it does not, run
   `opencode service restart` once. The daemon binds automatically when the port
   frees.
6. Confirm with `curl -s http://127.0.0.1:49377/health` and `/agents` in Telegram.

If the status bar shows `Nerdr Telegram` as stopped, the daemon is not running.
Open **Nerdr: Manage Telegram Bridge** and choose **Start**.

## Verify it works

1. Reload the VSCodium window (**Developer: Reload Window**).
2. Open an integrated terminal and run `opencode`.
3. The Nerdr icon appears in the activity bar, and a **Nerdr** container in the
   bottom panel, listing the agent.
4. Run **Nerdr: Test Bell** once to confirm audio.
5. Send a prompt (state goes `working`); ask something that needs your input
   (`needs input` + attention bell); let it finish (`done`, plus a completion bell
   for `build`/`plan`).
6. If Telegram is configured, run **Nerdr: Start Telegram Bridge**. The status
   bar should show `Nerdr Telegram`, and `/agents` and `/health` should reply in
   the chat. The bot does not require the OpenCode plugin to be alive.

## State model

OpenCode 2.0 event → Nerdr status:

| Nerdr status | Triggered by |
| --- | --- |
| `working` | `session.step.started`, tool/reasoning activity, `session.status = busy/retry`, `session.retry.scheduled` |
| `blocked` | `permission.asked`, OpenCode question/input forms |
| `done` | `session.step.ended` with `finish = stop/length/unknown` (turn finished, ready for review) |
| `idle` | `session.status = idle` (not treated as turn completion) |
| `error` | `session.step.failed`, `session.execution.failed` |

Identity (session id) is captured from event payloads; agent naming comes from the
workspace directory (see below).

## Agent naming

Agents are named after the **workspace directory they were started in** — e.g. an
agent launched in `~/code/nerdr` appears as `nerdr`. Nerdr deliberately does not
use OpenCode's session title, because OpenCode auto-generates (and can regenerate)
that title, for example when the first task completes. When two agents share a
directory name, the OpenCode session slug is appended for disambiguation
(`nerdr · tidy-falcon`).

Because OpenCode 2.x runs all workspaces inside one long-lived service, the
service's own root location (your home directory when it was launched) is
ignored, and each workspace is tracked under its directory.

## Commands

| Command | Purpose |
| --- | --- |
| `Nerdr: Focus Agent Terminal` | Reveal the terminal hosting an agent |
| `Nerdr: Refresh Agents` | Re-scan terminals and re-render |
| `Nerdr: Clear Finished Agents` | Drop `done`/`idle` rows |
| `Nerdr: Test Bell` | Play the configured tone |
| `Nerdr: Configure Telegram` | Set up the standalone Telegram bridge |
| `Nerdr: Start Telegram Bridge` | Start the daemon |
| `Nerdr: Stop Telegram Bridge` | Stop the daemon |
| `Nerdr: Restart Telegram Bridge` | Restart the daemon |
| `Nerdr: Manage Telegram Bridge` | Start/stop/status/log in one menu |
| `Nerdr: Telegram Status` | Show daemon, Telegram, and OpenCode health |
| `Nerdr: Show Telegram Log` | Open `~/.nerdr/telegram.log` |
| `Nerdr: Test Telegram` | Send a test message to the configured chat |
| `Nerdr: Disable Telegram` | Stop polling, keeping the config |

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `nerdr.port` | `27182` | Bridge port (increments if taken) |
| `nerdr.bell.enabled` | `true` | Master switch for bell tones |
| `nerdr.bell.states` | `["blocked","error","done"]` | Which states ring |
| `nerdr.bell.agents` | `["build","plan"]` | Agent/mode names allowed to ring the completion (`done`) bell; attention bells always ring. Empty = every agent |
| `nerdr.bell.command` | `""` | Override the platform default bell command |
| `nerdr.bell.cooldownMs` | `5000` | Minimum gap between bells per agent |
| `nerdr.showStatusBar` | `true` | Status-bar summary |
| `nerdr.staleTimeoutMs` | `45000` | Mark an agent offline after this silence |
| `nerdr.telegram.autoStart` | `false` | Start the Telegram daemon when VSCodium activates |
| `nerdr.telegram.stopOnExit` | `false` | Stop the daemon when VSCodium exits (off keeps it remotely available) |

The Agents view is contributed to **both** the left activity bar and the bottom
panel (Nerdr container) so it can live wherever you prefer.

### Bell tuning examples

```jsonc
// Ring for every agent's completion, not just build/plan
"nerdr.bell.agents": [],

// Only ring when build finishes (ignore plan)
"nerdr.bell.agents": ["build"],

// Distinguish completion from attention with your own sound
"nerdr.bell.command": "afplay /System/Library/Sounds/Ping.aiff"
```

Platform defaults for `nerdr.bell.command` when left empty: `afplay` on macOS,
`paplay`/terminal bell on Linux, and a PowerShell beep on Windows.

## Telegram (native)

Nerdr can bridge a **private Telegram chat** to the OpenCode agents on this
machine. The bridge is a **standalone local daemon** that runs independently of
OpenCode and VSCodium, so it keeps answering even when the OpenCode plugin stops
or the VSCodium window is closed. It uses Telegram **long polling**, so there is
no public webhook, tunnel, VPS, or inbound port. The local OpenCode API stays
bound to `127.0.0.1`.

VSCodium supervises the daemon: start, stop, restart, status, and logs are all in
the Command Palette. There is no systemd/launchd unit and no automatic start
after a reboot — open VSCodium and run **Nerdr: Start Telegram Bridge** when you
want the bridge available remotely. Closing VSCodium leaves a running daemon
alone (`nerdr.telegram.stopOnExit` defaults to `false`).

Each notification is tied to the agent that produced it. **Reply** to any
notification to send a prompt to that agent. Permission requests arrive with
**Allow once**, **Always allow**, and **Deny** buttons, and OpenCode question
forms arrive with option buttons (typed replies are also accepted). When a turn
finishes, Nerdr sends the final assistant text, truncated to 3,500 characters by
default.

Use one private chat per machine. Do not add the bot to a group: anyone in an
allowed chat can approve permissions and drive agents.

### Create the bot and connect it

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Give it a name and a username ending in `bot` (for example
   `nerdr_scott_bot`).
3. Copy the token BotFather returns. Treat it like a password.
4. Open the new bot's chat and send `/start` (or any message) so the bot is
   allowed to message you.
5. In VSCodium, run **Nerdr: Configure Telegram** from the Command Palette.
   Paste the token, choose the private chat (the command can detect it from your
   recent message), choose notification states, and decide whether to include
   final assistant text.
6. The command sends a test message, writes `~/.nerdr/telegram.json` with mode
   `0600`, deploys the daemon bundle to `~/.nerdr/nerdr-telegram.mjs`, and starts
   it. If it is already running, the config reloads immediately.

If chat detection is unavailable (for example because an old webhook still owns
the bot), enter the chat ID manually. **@userinfobot** can show it. The bot also
replies with the chat ID when an unauthorized chat messages it.

### Chat commands

| Command | Purpose |
| --- | --- |
| `/agents` | List agents, with buttons to select one |
| `/use <name\|number\|session>` | Select an agent by directory name, list number, or session id |
| `/mode [name]` | Show or switch the active session's OpenCode mode (for example Plan or Build) |
| `/status` | Show the active agent and pending permissions/questions |
| `/health` | Show Telegram polling and OpenCode service health |
| `/stop` | Interrupt the active agent |
| `/help` | Show the command list |

Reply to a message to target that message's agent without changing the active
agent. A plain message goes to the active agent, or the one you selected with
`/use`. Prompts are queued with OpenCode's `delivery: "queue"`: if the agent is
busy, wait for it to finish or use `/stop`. Replying with text to a permission
message denies it and passes your text as the denial reason.

Use `/mode` to switch the active session between OpenCode agents such as Plan and
Build. The change applies to the session's next turn, exactly like switching in
the TUI, and buttons mark the current mode.

Default notifications are `blocked`, `done`, and `error`; `working` is available
but intentionally not the default. The final-text notification is sent once per
completed turn.

### Start and stop the daemon

VSCodium manages the process; there is no systemd/launchd unit.

| Action | Command |
| --- | --- |
| Start | **Nerdr: Start Telegram Bridge** |
| Stop | **Nerdr: Stop Telegram Bridge** |
| Restart | **Nerdr: Restart Telegram Bridge** |
| Status | **Nerdr: Telegram Status** |
| Log | **Nerdr: Show Telegram Log** |
| All of the above | **Nerdr: Manage Telegram Bridge** |

- `nerdr.telegram.autoStart` (default `false`) starts the daemon when VSCodium
  activates.
- `nerdr.telegram.stopOnExit` (default `false`) stops it when VSCodium exits.
  Leave it off to keep the bot reachable while the window is closed.
- Closing VSCodium does not stop a running daemon.
- After a reboot, start it manually from VSCodium.

### Runtime files and the daemon

| Path | Purpose |
| --- | --- |
| `~/.nerdr/telegram.json` | Bot token, allowed chat ids, notification states (mode `0600`) |
| `~/.nerdr/telegram-state.json` | Telegram update offset and pending button/question state |
| `~/.nerdr/telegram.log` | Diagnostics (tokens are redacted, one rotated backup) |
| `~/.nerdr/telegram-control-token` | Loopback control token for mutating endpoints (mode `0600`) |
| `~/.nerdr/telegram.pid` | Current daemon pid |
| `~/.nerdr/nerdr-telegram.mjs` | Daemon bundle deployed by the extension |

The daemon binds `127.0.0.1:49377` and exposes:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Daemon, Telegram polling, and OpenCode service health |
| `POST /reload` | Re-read `telegram.json` |
| `POST /test` | Send a test message |
| `POST /shutdown` | Stop the daemon cleanly |

Mutating endpoints require the `X-Nerdr-Token` header from
`~/.nerdr/telegram-control-token`. **Nerdr: Telegram Status** and the status-bar
item use `GET /health`.

Only one daemon can bind the port; a second process retries quietly. After
upgrading from the old plugin-hosted bridge, restart OpenCode once so the old
plugin releases `49377`. The new daemon binds automatically when the port frees,
without a VSCodium reload.

### OpenCode service health

The daemon probes `GET /api/session/active` every 15 seconds with a 5-second
timeout. It reports one of: `ok`, `unreachable` (process gone), `timeout`
(process alive but not answering), `unauthorized` (credentials changed), or
`degraded` (HTTP error). Two consecutive failures are required before the state
changes, to avoid flapping.

When the state changes, the bot sends one message and updates `/status` and
`/health`. While OpenCode is down:

- `/agents` still replies, with cached agents marked stale and a warning.
- Prompts are rejected explicitly instead of being silently queued.
- The message suggests `opencode service restart`; Nerdr never restarts OpenCode
  on its own.

When OpenCode recovers, the bot sends a single recovery message.

### Migrating from a VPS/webhook gateway

A bot token can have only one long poller, and a webhook and `getUpdates` cannot
be active at the same time. Before enabling Nerdr with an existing token:

1. Stop the old VPS gateway/poller.
2. Remove its webhook, or let Nerdr do it: the daemon calls `deleteWebhook` on
   startup and logs `getUpdates` conflicts.
3. Do not run the old gateway and Nerdr with the same token. Use a new bot token
   if you want both to coexist.
4. The existing Nerdr webhook can stay for other services, but disable its
   Telegram relay so you do not get duplicate notifications.

### Telegram limitations

- Final assistant text is truncated in the chat (3,500 characters by default).
- OpenCode question forms are supported, including multiselect and free-text
  answers. Forms with conditional fields or external browser steps may still be
  easier to finish in VSCodium.
- Telegram shows text and buttons, not full diffs, terminal output, or file
  contents.
- The bridge is loopback-only. It is not a remote access service; prompts still
  need the OpenCode service running on this machine. The daemon itself survives
  OpenCode and VSCodium restarts, but after a reboot start it manually from
  VSCodium.

## Webhooks

Nerdr can POST a one-line notification to any HTTP endpoint when an agent changes
state — handy for email, SMS, a dashboard, or another relay. For Telegram, prefer
the native bridge above. Nerdr does **not** talk to those services directly;
point it at your own relay and let that fan out.

**Setup:** run **Nerdr: Configure Webhook** from the Command Palette. It prompts
for the URL, an optional bearer token, and which states to report, then sends a
test message. The webhook is enabled only after a successful test.

| Setting | Default | Purpose |
| --- | --- | --- |
| `nerdr.webhook.enabled` | `false` | Master switch (set by the configure command) |
| `nerdr.webhook.url` | `""` | Endpoint that receives the POST |
| `nerdr.webhook.states` | `["blocked","error","done"]` | Which states notify |
| `nerdr.webhook.cooldownMs` | `5000` | Minimum gap between POSTs per agent |
| `nerdr.webhook.notifyOffline` | `true` | Also notify when an agent goes offline (toggle in the configure wizard) |
| `nerdr.webhook.includeDetail` | `true` | Append the short detail (e.g. permission title) |

The bearer token is stored in VS Code **SecretStorage**, not in `settings.json`.
Use **Nerdr: Set Webhook Token** / **Nerdr: Clear Webhook Token** to change it, and
**Nerdr: Test Webhook** to re-test at any time.

### Request format

The body is a JSON object with a single `message` field, one notification per POST:

```json
{ "message": "nerdr is done at 00:00" }
{ "message": "konspt is asking a question at 00:00 — Allow bash: rm -rf node_modules?" }
{ "message": "markets errored at 00:00 — retrying (attempt 2): rate limit" }
{ "message": "nerdr went offline at 00:00" }
```

Headers: `Content-Type: application/json; charset=utf-8`, `User-Agent: nerdr`, and
`Authorization: Bearer <token>` when a token is set. Sends are serialized to
preserve order and retried on failure; the UI is never blocked, and repeated
failures (5+) surface one warning.

## How terminal matching works

OpenCode 2.x loads the Nerdr plugin inside its shared `opencode serve` service,
so the PID the plugin reports is that daemon, not your terminal. To find the
right pane, `TerminalLocator` reads the OS process table (`ps`) plus each live
`opencode` process's working directory (`lsof -a -d cwd -c opencode`). The TUI
process carries the workspace as its cwd and owns a real tty; the daemon does
not. Nerdr walks up from that TUI PID until it reaches a PID that
`vscode.window.terminals` reports for a terminal. This is how **Focus Agent
Terminal** lands on the right pane.

The same cwd scan drives liveness: when no `opencode` pane is rooted in a
workspace, the agent is marked offline (grey) and then removed on the next pass,
even though the shared service is still running. Windows matching is not
implemented yet; on systems without `lsof`, Nerdr falls back to heartbeat
timeouts and never marks a workspace offline based on process scans.

## Troubleshooting

- **No agents appear.** Confirm the plugin file exists at
  `~/.config/opencode/plugins/nerdr.js`, then restart `opencode`. Check the
  **Nerdr** output channel (View → Output → Nerdr) for connection logs.
- **No bell.** Run **Nerdr: Test Bell**. Then check `nerdr.bell.enabled`,
  `nerdr.bell.states`, and — for completion bells — `nerdr.bell.agents`.
- **Two agents look identical.** Agents are named after their project root
  directory. When two agents share a name, Nerdr appends the OpenCode session slug
  (e.g. `nerdr · tidy-falcon`).
- **Port already in use.** The extension automatically tries the next free port
  and advertises it in `~/.nerdr/bridge.json`; the plugin follows.
- **Bot is silent after upgrading to 0.2.0.** Installing the VSIX and copying
  the plugin does not start Telegram. Run **Nerdr: Start Telegram Bridge** (or
  **Nerdr: Manage Telegram Bridge**). The daemon, not the plugin, owns polling
  now.
- **Telegram bot ignores messages.** Run **Nerdr: Telegram Status**. Confirm the
  daemon is running, the bot is polling, and the configured chat ID matches the
  private chat. Check **Nerdr: Show Telegram Log**. If the status says OpenCode is
  unreachable, restart the OpenCode service; the bot itself does not need a
  VSCodium reload.
- **Telegram bridge will not start / port 49377 is in use.** An old
  plugin-hosted poller still owns the port. Restart the OpenCode service once
  (`opencode service restart`; this interrupts running agents) so the old plugin
  releases `49377`. The daemon binds automatically when the port frees, without
  a VSCodium reload. The status dialog reports the pid when one is available.
- **The extension cannot start the daemon.** Check **Nerdr: Show Telegram Log**
  first. As a manual fallback, run the bundle that ships inside the installed
  extension:
  ```bash
  # macOS: run in the background
  cp ~/.vscode-oss/extensions/nerdr.nerdr-0.2.0/bin/nerdr-telegram.mjs ~/.nerdr/
  chmod 700 ~/.nerdr/nerdr-telegram.mjs
  nohup env NERDR_HOME="$HOME/.nerdr" ELECTRON_RUN_AS_NODE=1 \
    "/Applications/VSCodium.app/Contents/MacOS/VSCodium" \
    ~/.nerdr/nerdr-telegram.mjs >> ~/.nerdr/telegram.log 2>&1 &
  ```
  On Linux, use the same command with your VSCodium binary (for example
  `/usr/share/codium/codium`). The extension can still see, stop, and restart
  that process through `/health` and the pid file.
- **Telegram `getUpdates` conflict (409).** A webhook or another poller still
  owns the token. Stop the old gateway and delete its webhook. Nerdr retries and
  calls `deleteWebhook` on startup, but it cannot win against a poller that keeps
  restarting.
- **Configure command cannot find the chat.** Send `/start` to the bot, then run
  **Nerdr: Configure Telegram** again, or enter the numeric chat ID manually.
  @userinfobot can show your id; the bot also reports the chat ID to unauthorized
  chats.

## Herdr features not covered

The core four requirements are implemented. The following Herdr capabilities are
**not** in this MVP:

- **Detach / persistence.** Herdr keeps agents alive across terminal closes and
  machine restarts. OpenCode 2.x already does much of this via its shared
  `opencode serve` service, but Nerdr only reports a workspace while a live
  terminal pane is rooted in it: closing the pane marks the agent offline (then
  removes it) even though the service stays warm.
- **Live terminal views.** Herdr renders real pane contents. Nerdr shows status
  and focuses the existing terminal; it does not mirror output.
- **Reading pane output.** No `agent read` equivalent (visible/recent/unwrapped).
- **Driving agents from the VSCodium UI.** The Nerdr pane remains read-only: no
  send-keys, prompt, rename, or wait-until-blocked controls there. The optional
  Telegram bridge can send prompts and answer permissions/questions, but it is
  not a terminal mirror or remote-control daemon.
- **Per-pane state rollup.** Herdr rolls status up to tabs/workspaces. Nerdr is a
  flat list (sorted attention-first).
- **Socket API for agent-to-agent orchestration** (spawn panes, prompt each other,
  wait on each other).
- **Session restore** after restart.
- **Remote / SSH attach.**
- **Plugin marketplace.**
- **Richer detection.** Herdr classifies agents via TOML screen manifests even
  without a plugin. Nerdr relies entirely on the plugin's lifecycle reports, so a
  bare `opencode` without the Nerdr plugin will not appear in the list.

## License

MIT — see [LICENSE](LICENSE).
