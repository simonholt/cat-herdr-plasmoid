#!/bin/bash
# Installs the Cat Herdr Claude Code model reporter.
# Copies cat-herdr-model-reporter.mjs to ~/.claude/plugins/cat-herdr/ and
# registers SessionStart + Stop hooks in settings.json (idempotent).
#
# Stop is what catches a mid-session /model switch: it fires when a turn
# completes, by which point the transcript records the new model.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$HOME/.claude/plugins/cat-herdr"
SETTINGS_JSON="$HOME/.claude/settings.json"
REPORTER="$PLUGIN_DIR/cat-herdr-model-reporter.mjs"
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
	echo "Error: $SETTINGS_JSON not found -- is Claude Code installed?" >&2
	exit 1
fi

mkdir -p "$PLUGIN_DIR"
TMP="$(mktemp "${SETTINGS_JSON}.tmp.XXXXXX")"
REPORTER_TMP="$(mktemp "${REPORTER}.tmp.XXXXXX")"
trap 'rm -f "$TMP" "$REPORTER_TMP"' EXIT

# Drop any prior cat-herdr hook entries (including the old backgrounded
# variant) before re-adding, so repeat installs do not stack duplicates.
if ! jq --arg cmd "$HOOK_COMMAND" '
	def strip_ours:
		map(.hooks |= map(select((.command // "") | test("cat-herdr-model-reporter") | not)))
		| map(select((.hooks | length) > 0));

	.hooks //= {}
	| .hooks.SessionStart = ((.hooks.SessionStart // []) | strip_ours)
		+ [{matcher: "*", hooks: [{type: "command", command: $cmd, timeout: 10}]}]
	| .hooks.Stop = ((.hooks.Stop // []) | strip_ours)
		+ [{hooks: [{type: "command", command: $cmd, timeout: 10}]}]
' "$SETTINGS_JSON" >"$TMP"; then
	echo "Error: failed to update $SETTINGS_JSON" >&2
	exit 1
fi

# Refuse to install a settings.json that is not valid JSON.
if ! jq -e . "$TMP" >/dev/null 2>&1; then
	echo "Error: refusing to write invalid JSON to $SETTINGS_JSON" >&2
	exit 1
fi

cp "$SETTINGS_JSON" "$SETTINGS_JSON.bak"
mv "$TMP" "$SETTINGS_JSON"
cp "$SCRIPT_DIR/cat-herdr-model-reporter.mjs" "$REPORTER_TMP"
mv "$REPORTER_TMP" "$REPORTER"
rm -f "$PLUGIN_DIR/cat-herdr-model-reporter.js"
trap - EXIT
echo "Copied reporter to $REPORTER"
echo "Registered SessionStart + Stop hooks in $SETTINGS_JSON"
echo "Backup written to $SETTINGS_JSON.bak"

echo "Done. Restart Claude Code inside a Herdr pane."
