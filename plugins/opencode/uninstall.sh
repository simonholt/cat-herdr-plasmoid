#!/bin/bash
# Removes the Cat Herdr OpenCode TUI metadata plugin and only its config entry.
set -euo pipefail

DEST_DIR="$HOME/.config/opencode"
DEST="$DEST_DIR/herdr-tui-attached-metadata.js"
TUI_JSONC="$DEST_DIR/tui.jsonc"
ENTRY="./herdr-tui-attached-metadata.js"

if ! command -v jq >/dev/null 2>&1; then
	echo "Error: jq not found on PATH" >&2
	exit 1
fi

if [ -f "$TUI_JSONC" ]; then
	TMP="$(mktemp "$DEST_DIR/.tui.jsonc.tmp.XXXXXX")"
	trap 'rm -f "$TMP"' EXIT
	if ! jq --arg e "$ENTRY" '.plugin = ((.plugin // []) | map(select(. != $e)))' "$TUI_JSONC" >"$TMP"; then
		echo "Error: refusing to modify $TUI_JSONC because it is not plain JSON." >&2
		echo "A JSONC-aware editor is not available; remove \"$ENTRY\" from its \"plugin\" array manually." >&2
		exit 1
	fi
	if ! jq -e . "$TMP" >/dev/null 2>&1; then
		echo "Error: refusing to write invalid JSON to $TUI_JSONC" >&2
		exit 1
	fi
	cp "$TUI_JSONC" "$TUI_JSONC.bak"
	mv "$TMP" "$TUI_JSONC"
	trap - EXIT
	echo "Removed $ENTRY from $TUI_JSONC"
fi

rm -f "$DEST"
echo "Removed $DEST"
echo "Done. Restart opencode."
