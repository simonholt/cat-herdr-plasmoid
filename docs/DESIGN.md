# Cat Herdr — Design

## Overview

Cat Herdr is a KDE Plasma 6 plasmoid that displays a live dashboard of AI coding agents managed by [Herdr](https://github.com/simonholt/herdr). It is read-only apart from click-to-focus, which asks Herdr to bring an agent pane to the foreground.

## Architecture

Three layers are kept separate:

```
Views (Board.qml, BoardRow.qml, main.qml)  <- QML rendering
Observer.qml                               <- subprocess polling and timers
Model.js                                   <- pure data transformations
```

`Observer.qml` runs bounded Herdr and Git subprocesses and exposes state to the views. `Model.js` has no QML dependencies, so its transformations are testable with Node.js. Views only render Observer properties.

The Observer polls `herdr api snapshot` at `refreshMs` (default 3 seconds), refreshes `herdr workspace list` every 15 seconds, and queues `git -C <path> status -sb` per workspace. Subprocesses use an 8-second timeout and `GIT_OPTIONAL_LOCKS=0`. Git failures and optional workspace-metadata failures are nonfatal; snapshot failures are fatal to the live board.

Every restart creates a new generation. Callbacks from an older generation are discarded, so a configuration change cannot leak stale data into the board. Git work is capped at four concurrent jobs and failed jobs use backoff.

## Model and views

`Model.build()` groups panes by workspace, derives status/count summaries, resolves workspace paths, and optionally nests detected subagents under their parents. With multiplex awareness disabled, all panes are shown flat. The data transformations are pure; `reconcile()` is the deliberate impure adapter at the QML boundary.

`reconcile(model, rows)` updates the existing ListModel in place: it inserts, moves, updates, and removes rows without resetting the model. This preserves delegate state, scroll position, and click feedback. The function does not mutate its input row data; “in place” refers to the existing ListModel being updated rather than replaced.

The full board shows workspace headers, agent status, model, terminal title, project, branch, and Git ahead/behind state. The compact representation shows a count and the worst current status.

## Configuration

The KCM exposes three settings:

| Key | Type | Default | Description |
|---|---|---:|---|
| `herdrCmd` | String | `@HERDR_BIN@` | Absolute path to the `herdr` binary |
| `refreshMs` | Int | `3000` | Snapshot polling interval; minimum 500 ms |
| `multiplexAware` | Bool | `true` | Nest detected subagents under their parents |

`@HERDR_BIN@` is replaced by the top-level `install.sh` using `command -v herdr`. A source-tree launch must perform the same substitution in a temporary copy; see the development instructions in `README.md`.

## Plugin integrations

Optional plugins report metadata to Herdr with `pane.report_metadata`. They are not installed by the plasmoid installer and are no-ops outside Herdr-managed panes.

### OpenCode

`plugins/opencode/cat-herdr-tui-attached-metadata.js` is an OpenCode TUI plugin. It reads the active session's messages, preferring the newest assistant `providerID/modelID` and falling back to a user message's selected model before the first assistant response. It reports the canonical value as `tokens.model`.

The plugin also reads `api.app.version` and reports it separately as `tokens.opencode_version`; it never substitutes the app version for the model. Model/session state is refreshed immediately for supported `message.updated`, `message.part.updated`, `session.updated`, `session.status`, and `session.idle` events. Because route changes are not consistently exposed, a low-frequency two-second route fallback remains. Model lookup retries briefly when a new response has not been persisted yet, and requests are serialized.

The plugin is configured through `~/.config/opencode/tui.jsonc` by `plugins/opencode/install.sh`. Automatic editing succeeds only for comment-free JSON. If the existing JSONC file contains comments, install/uninstall fail safely without changing it and print the manual JSONC-aware procedure; the user must preserve comments while adding or removing only the plugin entry. `plugins/opencode/uninstall.sh` removes the copied plugin and only its configuration entry when automatic editing is possible.

### Claude Code

`plugins/claude/cat-herdr-model-reporter.mjs` is a one-shot Node hook registered for `SessionStart` and `Stop` in `~/.claude/settings.json`. `SessionStart` supplies the model; `Stop` identifies the current assistant transcript entry using `last_assistant_message`, retrying briefly for the transcript flush. It skips subagents and fails open on missing data or socket errors.

### Cursor Agent

`plugins/cursor/cat-herdr-model-reporter.mjs` is registered in `~/.cursor/hooks.json` for `sessionStart`, `beforeSubmitPrompt`, and `stop`. It prefers `model_id` over `model`, skips subagent hooks and stand-in `nemotron`/`*-free` values, resolves the pane by session, and reports `tokens.model`. Resume and mid-session model changes are observed on the next prompt/stop event; there is no poller.

### GitHub Copilot CLI

`plugins/copilot/cat-herdr-model-reporter.mjs` is registered for `sessionStart` and `agentStop` under `$COPILOT_HOME/hooks` (default `~/.copilot/hooks`). Copilot hook payloads do not contain the resolved model, so the reporter reads the newest `session.model_change` event from the session event log once. It resolves the pane by session and reports `tokens.model`.

## Testing

The intended Node suite is the command run by `tests/package.json`:

```bash
npm --prefix tests test
```

It currently covers `Model.js` plus the Claude, Cursor, Copilot, and OpenCode reporter helpers. The model tests cover parsing/validation, grouping and nesting, status and model precedence, Git/path handling, shell quoting, and deterministic/invariant reconcile behavior.

The separate PySide6 offscreen suite is:

```bash
python3 tests/runtime.py
```

It covers QML loading/delegates, focus navigation, error/recovery/timeout paths, stale generations, linked-worktree geometry, subagent connectors, reconcile scroll stability, and warnings. It requires PySide6.

## Install/uninstall behavior

The top-level installer resolves `herdr`, templates `main.xml` in a temporary package copy, installs/upgrades it with `kpackagetool6`, and copies the SVG icon to the user's hicolor icon directory. The top-level uninstaller removes the package and icon. Both are intended to be idempotent.

## File layout

```
cat-herdr-plasmoid/
├── package/
│   ├── metadata.json
│   └── contents/
│       ├── config/
│       │   ├── config.qml
│       │   └── main.xml
│       ├── icons/catherder.svg
│       └── ui/
│           ├── main.qml
│           ├── Observer.qml
│           ├── Model.js
│           ├── Board.qml
│           ├── BoardRow.qml
│           └── config/ConfigGeneral.qml
├── plugins/
│   ├── opencode/
│   │   ├── cat-herdr-tui-attached-metadata.js
│   │   ├── package.json
│   │   ├── install.sh
│   │   └── uninstall.sh
│   ├── claude/
│   │   ├── cat-herdr-model-reporter.mjs
│   │   ├── install.sh
│   │   └── uninstall.sh
│   ├── cursor/
│   │   ├── cat-herdr-model-reporter.mjs
│   │   ├── install.sh
│   │   └── uninstall.sh
│   └── copilot/
│       ├── cat-herdr-model-reporter.mjs
│       ├── install.sh
│       └── uninstall.sh
├── tests/
│   ├── model.test.cjs
│   ├── claude-reporter.test.mjs
│   ├── cursor-reporter.test.mjs
│   ├── copilot-reporter.test.mjs
│   ├── opencode-reporter.test.mjs
│   ├── runtime.py
│   └── package.json
├── install.sh
├── uninstall.sh
├── .gitignore
├── LICENSE
└── README.md
```
