#!/bin/bash
# Installs the Cat Herdr OpenCode TUI metadata plugin.
# OpenCode's tui.jsonc is JSONC, but this installer deliberately uses only jq:
# it never rewrites a file it cannot parse safely.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/cat-herdr-tui-attached-metadata.js"
DEST_DIR="$HOME/.config/opencode"
DEST="$DEST_DIR/cat-herdr-tui-attached-metadata.js"
TUI_JSONC="$DEST_DIR/tui.jsonc"
ENTRY="./cat-herdr-tui-attached-metadata.js"

if ! command -v jq >/dev/null 2>&1; then
	echo "Error: jq not found on PATH" >&2
	exit 1
fi
if [ ! -f "$SRC" ]; then
	echo "Error: plugin source not found: $SRC" >&2
	exit 1
fi
if [ ! -d "$DEST_DIR" ]; then
	echo "OpenCode config directory absent: $DEST_DIR" >&2
	echo "OpenCode does not appear to be installed; no files were changed." >&2
	exit 0
fi

# Validate and build the replacement before copying the plugin. A JSONC file
# with comments must never be silently converted to JSON or partially edited.
CONFIG_TMP="$(mktemp "$DEST_DIR/.tui.jsonc.tmp.XXXXXX")"
REPORTER_TMP="$(mktemp "$DEST_DIR/.herdr-tui-attached-metadata.js.tmp.XXXXXX")"
trap 'rm -f "$CONFIG_TMP" "$REPORTER_TMP"' EXIT
if [ -f "$TUI_JSONC" ]; then
	if ! jq --arg e "$ENTRY" \
		'.plugin //= [] | .plugin |= (if index($e) then . else . + [$e] end)' \
		"$TUI_JSONC" >"$CONFIG_TMP"; then
		echo "Error: refusing to modify $TUI_JSONC because it is not plain JSON." >&2
		echo "A JSONC-aware editor is not available, so comments cannot be preserved safely." >&2
		echo "Manual instructions:" >&2
		echo "  1. Open $TUI_JSONC in an editor that supports JSONC comments." >&2
		echo "  2. Add \"$ENTRY\" to the existing \"plugin\" array (create that array if needed)." >&2
		echo "  3. Preserve all existing settings and comments, then save the file." >&2
		echo "  4. Copy $SRC to $DEST and restart OpenCode." >&2
		exit 1
	fi
else
	jq -n --arg e "$ENTRY" '{plugin:[$e]}' >"$CONFIG_TMP"
fi

if ! jq -e . "$CONFIG_TMP" >/dev/null 2>&1; then
	echo "Error: refusing to write invalid JSON to $TUI_JSONC" >&2
	exit 1
fi

cp "$SRC" "$REPORTER_TMP"
if [ -f "$TUI_JSONC" ]; then
	cp "$TUI_JSONC" "$TUI_JSONC.bak"
fi
mv "$CONFIG_TMP" "$TUI_JSONC"
mv "$REPORTER_TMP" "$DEST"
trap - EXIT
echo "Copied plugin to $DEST"
echo "Registered $ENTRY in $TUI_JSONC"
echo "Done. Restart opencode inside a Herdr pane."
