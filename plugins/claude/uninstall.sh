#!/bin/bash
# Removes the Cat Herdr Claude Code model reporter and its hooks.
set -euo pipefail

PLUGIN_DIR="$HOME/.claude/plugins/cat-herdr"
SETTINGS_JSON="$HOME/.claude/settings.json"

if ! command -v jq >/dev/null 2>&1; then
	echo "Error: jq not found on PATH" >&2
	exit 1
fi

if [ -f "$SETTINGS_JSON" ]; then
	TMP="$(mktemp)"
	trap 'rm -f "$TMP"' EXIT
	if ! jq '
		def strip_ours:
			map(.hooks |= map(select((.command // "") | test("cat-herdr-model-reporter") | not)))
			| map(select((.hooks | length) > 0));

		if .hooks then
			.hooks |= with_entries(.value |= strip_ours)
			| .hooks |= with_entries(select((.value | length) > 0))
		else . end
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
	trap - EXIT
	echo "Removed hooks from $SETTINGS_JSON (backup at $SETTINGS_JSON.bak)"
fi

rm -f "$PLUGIN_DIR/cat-herdr-model-reporter.mjs" "$PLUGIN_DIR/cat-herdr-model-reporter.js"
rmdir "$PLUGIN_DIR" 2>/dev/null || true
echo "Removed $PLUGIN_DIR"
echo "Done. Restart Claude Code."
