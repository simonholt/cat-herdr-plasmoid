#!/bin/bash
# Removes the Cat Herdr Cursor Agent model reporter and its hooks.
set -euo pipefail

HOOKS_DIR="$HOME/.cursor/hooks"
SETTINGS_JSON="$HOME/.cursor/hooks.json"
REPORTER="$HOOKS_DIR/cat-herdr-model-reporter.mjs"

if ! command -v jq >/dev/null 2>&1; then
	echo "Error: jq not found on PATH" >&2
	exit 1
fi

if [ -f "$SETTINGS_JSON" ]; then
	TMP="$(mktemp)"
	trap 'rm -f "$TMP"' EXIT
	if ! jq '
		def strip_ours:
			map(select((.command // "") | test("cat-herdr-model-reporter") | not));

		if .hooks then
			.hooks |= with_entries(.value |= (if type == "array" then strip_ours else . end))
			| .hooks |= with_entries(select((.value | type) != "array" or (.value | length) > 0))
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

rm -f "$REPORTER" "$HOOKS_DIR/cat-herdr-model-reporter.js"
echo "Removed $REPORTER"
echo "Done. Restart Cursor Agent."
