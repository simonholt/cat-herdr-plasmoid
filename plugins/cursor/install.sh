#!/bin/bash
# Installs the Cat Herdr Cursor Agent model reporter.
# Copies cat-herdr-model-reporter.mjs to ~/.cursor/hooks/ and registers
# sessionStart, beforeSubmitPrompt, and stop hooks in hooks.json (idempotent).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$HOME/.cursor/hooks"
SETTINGS_JSON="$HOME/.cursor/hooks.json"
REPORTER="$HOOKS_DIR/cat-herdr-model-reporter.mjs"
HOOK_COMMAND="node '$REPORTER'"

if ! command -v jq >/dev/null 2>&1; then
	echo "Error: jq not found on PATH" >&2
	exit 1
fi

if [ ! -f "$SCRIPT_DIR/cat-herdr-model-reporter.mjs" ]; then
	echo "Error: plugin source not found in $SCRIPT_DIR" >&2
	exit 1
fi

if [ ! -f "$SETTINGS_JSON" ]; then
	mkdir -p "$(dirname "$SETTINGS_JSON")"
	printf '%s\n' '{"version":1,"hooks":{}}' >"$SETTINGS_JSON"
	echo "Created $SETTINGS_JSON"
fi

mkdir -p "$HOOKS_DIR"
TMP="$(mktemp "${SETTINGS_JSON}.tmp.XXXXXX")"
REPORTER_TMP="$(mktemp "${REPORTER}.tmp.XXXXXX")"
trap 'rm -f "$TMP" "$REPORTER_TMP"' EXIT

if ! jq --arg cmd "$HOOK_COMMAND" '
	def strip_ours:
		map(select((.command // "") | test("cat-herdr-model-reporter") | not));

	def ensure_event($name):
		.[$name] = ((.[$name] // []) | strip_ours) + [{command: $cmd, timeout: 5}];

	.version = (.version // 1)
	| .hooks = ((.hooks // {})
		| ensure_event("sessionStart")
		| ensure_event("beforeSubmitPrompt")
		| ensure_event("stop"))
' "$SETTINGS_JSON" >"$TMP"; then
	echo "Error: failed to update $SETTINGS_JSON" >&2
	exit 1
fi

if ! jq -e . "$TMP" >/dev/null 2>&1; then
	echo "Error: refusing to write invalid JSON to $SETTINGS_JSON" >&2
	exit 1
fi

cp "$SETTINGS_JSON" "$SETTINGS_JSON.bak"
mv "$TMP" "$SETTINGS_JSON"
cp "$SCRIPT_DIR/cat-herdr-model-reporter.mjs" "$REPORTER_TMP"
mv "$REPORTER_TMP" "$REPORTER"
rm -f "$HOOKS_DIR/cat-herdr-model-reporter.js"
trap - EXIT
echo "Copied reporter to $REPORTER"
echo "Registered sessionStart, beforeSubmitPrompt, and stop in $SETTINGS_JSON"
echo "Backup written to $SETTINGS_JSON.bak"
echo "Done. Restart Cursor Agent inside a Herdr pane."
