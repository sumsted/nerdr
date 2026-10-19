# Nerdr

A [Herdr](https://herdr.dev)-style awareness layer for **OpenCode** agents running
inside **VSCodium**. Nerdr answers four questions at a glance:

1. **Which VSCodium terminals host OpenCode agents?**
2. **What state is each agent in?** — `working`, `blocked`, `idle`, `done`, `error`
3. **Which agent needs me right now?** — bell tones for attention (and for
   `build`/`plan` completions)
4. **Show me the roster** — an Agents list in a Nerdr panel

It is two cooperating pieces: a small **OpenCode plugin** that streams lifecycle
state, and a **VSCodium extension** that aggregates it, renders the list, locates
the owning terminal, and rings the bell.

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

Package the extension:

```bash
npm run package -w nerdr
# -> packages/extension/nerdr-0.1.1.vsix
```

Then install the VSIX, either from the VSCodium UI
(**Extensions → "..." → Install from VSIX...**) or from a terminal:

```bash
# macOS (bundled CLI path)
"/Applications/VSCodium.app/Contents/Resources/app/bin/codium" \
  --install-extension packages/extension/nerdr-0.1.1.vsix

# Linux
codium --install-extension packages/extension/nerdr-0.1.1.vsix

# Windows (PowerShell)
& "$env:LOCALAPPDATA\Programs\VSCodium\bin\codium.cmd" `
  --install-extension packages\extension\nerdr-0.1.1.vsix
```

If `codium` is not on your `PATH`, run **"Shell Command: Install 'codium'
command in PATH"** from the Command Palette (macOS/Linux), or use the bundled path
shown above.

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

## Verify it works

1. Reload the VSCodium window (**Developer: Reload Window**).
2. Open an integrated terminal and run `opencode`.
3. The Nerdr icon appears in the activity bar, and a **Nerdr** container in the
   bottom panel, listing the agent.
4. Run **Nerdr: Test Bell** once to confirm audio.
5. Send a prompt (state goes `working`); ask something that needs your input
   (`needs input` + attention bell); let it finish (`done`, plus a completion bell
   for `build`/`plan`).

## State model

OpenCode 2.0 event → Nerdr status:

| Nerdr status | Triggered by |
| --- | --- |
| `working` | `session.hook("prompt")`, `tool.hook("execute.before")`, `session.status = busy/retry`, `session.retry.scheduled`, `permission.replied` |
| `blocked` | `permission.asked`, interactive tools (`question`/`ask`) via `tool.hook("execute.before")` |
| `done` | `session.idle` (turn finished, ready for review) |
| `idle` | `session.status = idle` |
| `error` | `session.execution.failed` |

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

## Webhooks

Nerdr can POST a one-line notification to any HTTP endpoint when an agent changes
state — handy for relaying to Telegram, email, SMS, or a dashboard. Nerdr does
**not** talk to those services directly; point it at your own relay and let that
fan out.

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
- **Driving agents from the UI/API.** No send-keys, prompt, rename, or
  wait-until-blocked. The bridge is plugin → extension only.
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
