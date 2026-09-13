#!/bin/bash
# Installs the Cat Herdr Copilot CLI model reporter.
# Copies cat-herdr-model-reporter.mjs to ~/.copilot/hooks/ and registers a
# standalone hook config file (cat-herdr-model-reporter.json) for
# sessionStart + agentStop (idempotent -- both files are simply overwritten).
#
# agentStop is what catches a mid-session /model switch: it fires when a
# turn completes, by which point the session's event log records the model
# that served it.
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
	echo "Error: jq not found on PATH" >&2
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COPILOT_HOME="${COPILOT_HOME:-$HOME/.copilot}"
HOOKS_DIR="$COPILOT_HOME/hooks"
REPORTER="$HOOKS_DIR/cat-herdr-model-reporter.mjs"
HOOK_CONFIG="$HOOKS_DIR/cat-herdr-model-reporter.json"
HOOK_COMMAND="node '$REPORTER'"

if [ ! -f "$SCRIPT_DIR/cat-herdr-model-reporter.mjs" ]; then
	echo "Error: plugin source not found in $SCRIPT_DIR" >&2
	exit 1
fi

mkdir -p "$HOOKS_DIR"
TMP="$(mktemp "${HOOK_CONFIG}.tmp.XXXXXX")"
REPORTER_TMP="$(mktemp "${REPORTER}.tmp.XXXXXX")"
trap 'rm -f "$TMP" "$REPORTER_TMP"' EXIT
if [ -f "$HOOK_CONFIG" ]; then
	if ! jq --arg cmd "$HOOK_COMMAND" '
    def strip_ours: map(select((.bash // .command // "") | test("cat-herdr-model-reporter") | not));
    .version = (.version // 1)
    | .hooks = ((.hooks // {})
      | .sessionStart = ((.sessionStart // []) | strip_ours) + [{type:"command", bash:$cmd, powershell:$cmd, timeoutSec:10}]
      | .agentStop = ((.agentStop // []) | strip_ours) + [{type:"command", bash:$cmd, powershell:$cmd, timeoutSec:10}])
  ' "$HOOK_CONFIG" >"$TMP"; then
		echo "Error: failed to update $HOOK_CONFIG (comments in JSON are not supported)." >&2
		exit 1
	fi
else
	jq -n --arg cmd "$HOOK_COMMAND" '{version:1,hooks:{sessionStart:[{type:"command",bash:$cmd,powershell:$cmd,timeoutSec:10}],agentStop:[{type:"command",bash:$cmd,powershell:$cmd,timeoutSec:10}]}}' >"$TMP"
fi
if ! jq -e . "$TMP" >/dev/null 2>&1; then
	echo "Error: refusing to write invalid JSON to $HOOK_CONFIG" >&2
	exit 1
fi
if [ -f "$HOOK_CONFIG" ]; then cp "$HOOK_CONFIG" "$HOOK_CONFIG.bak"; fi
mv "$TMP" "$HOOK_CONFIG"
cp "$SCRIPT_DIR/cat-herdr-model-reporter.mjs" "$REPORTER_TMP"
mv "$REPORTER_TMP" "$REPORTER"
rm -f "$HOOKS_DIR/cat-herdr-model-reporter.js"
trap - EXIT
echo "Copied reporter to $REPORTER"

echo "Registered sessionStart + agentStop hooks in $HOOK_CONFIG"
echo "Done. Restart Copilot CLI inside a Herdr pane."
