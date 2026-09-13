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

```
┌─────────────────────────┐   loopback TCP (newline JSON)   ┌───────────────────────────┐
│ OpenCode process        │ ──────────────────────────────▶ │ Nerdr VSCodium extension  │
│ @nerdr/opencode-plugin  │ ◀────────────────────────────── │  • BridgeServer (:27182)  │
│  • session/status hooks │     welcome / pong               │  • AgentStore             │
│  • permission + question│                                 │  • Agents TreeView        │
└─────────────────────────┘                                 │  • TerminalLocator (ps)   │
             ▲                                               │  • Bell                   │
             └───────── ~/.nerdr/bridge.json (port+token) ───┘                           │
                                                             └───────────────────────────┘
```

The tracked unit is the **OpenCode process** (one terminal pane), matching Herdr's
pane-oriented model.

## Requirements

- **Node.js 18+** and npm (the build uses npm workspaces)
- **VSCodium 1.85+**
- The **OpenCode CLI**; the plugin is loaded by each `opencode` process

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

The plugin bundle is standalone and has no runtime dependencies. Copy it into your
OpenCode plugins directory:

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

Or reference it directly in `opencode.json`:

```json
{ "plugin": ["./.opencode/plugins/nerdr.js"] }
```

Order does not matter: the plugin discovers the bridge file on every reconnect.
**Restart any running `opencode` processes** after installing or updating the
plugin — plugins load at process startup, so an already-running session keeps the
old copy in memory.

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

| Nerdr status | Triggered by |
| --- | --- |
| `working` | `chat.message`, `tool.execute.before`, `session.status = busy/retry`, `question.replied` |
| `blocked` | `permission.ask` / `permission.asked` / `permission.updated`, `question.asked` |
| `done` | `session.idle` (turn finished, ready for review) |
| `idle` | `session.status = idle` |
| `error` | `session.error` |

The agent/mode (`build`, `plan`, …) and model are captured from `chat.message` and
assistant messages, and shown in the item tooltip.

## Agent naming

Agents are named after the **workspace directory they were started in** — e.g. an
agent launched in `~/code/nerdr` appears as `nerdr`. Nerdr deliberately does not
use OpenCode's session title, because OpenCode auto-generates (and can regenerate)
that title, for example when the first task completes. When two agents share a
directory name, the OpenCode session slug is appended for disambiguation
(`nerdr · tidy-falcon`).

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

## How terminal matching works

`TerminalLocator` reads the OS process table (`ps -Ao pid=,ppid=,tty=`) and walks
up from the agent's reported PID until it reaches a PID that
`vscode.window.terminals` reports for a terminal. This is how **Focus Agent
Terminal** lands on the right pane. Windows matching is not implemented yet.

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
  machine restarts. Nerdr observes OpenCode processes owned by VSCodium terminals;
  closing the terminal or VSCodium ends them. Could be addressed by driving a
  long-lived `opencode serve` and attaching the UI to it.
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
