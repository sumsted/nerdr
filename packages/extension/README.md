# Nerdr

Herdr-like agent awareness for OpenCode agents running in VSCodium terminals.

See the repository root `README.md` for full architecture, installation, settings,
and limitations.

## Features

- `nerdr.agents` view — roster of agents and their state (left activity bar)
- `nerdr.agentsPanel` view — the same roster in the bottom panel
- States: `working`, `blocked`, `idle`, `done`, `error`
- Bell tones when an agent needs attention (`blocked`/`error`), and on completion
  (`done`) for the `build`/`plan` agents
- Click an agent (or run **Nerdr: Focus Agent Terminal**) to jump to its terminal
- **Nerdr: Rename Agent** to set an agent's name (updates the real OpenCode session)

Requires the matching OpenCode plugin: copy `nerdr.js` into
`~/.config/opencode/plugins/` (see the root README).
