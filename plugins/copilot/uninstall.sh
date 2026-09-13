#!/bin/bash
# Removes the Cat Herdr Copilot CLI model reporter and its hook config.
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
	echo "Error: jq not found on PATH" >&2
	exit 1
fi

COPILOT_HOME="${COPILOT_HOME:-$HOME/.copilot}"
HOOKS_DIR="$COPILOT_HOME/hooks"
REPORTER="$HOOKS_DIR/cat-herdr-model-reporter.mjs"
HOOK_CONFIG="$HOOKS_DIR/cat-herdr-model-reporter.json"

if [ -f "$HOOK_CONFIG" ]; then
	TMP="$(mktemp "${HOOK_CONFIG}.tmp.XXXXXX")"
	trap 'rm -f "$TMP"' EXIT
	if ! jq '
    def strip_ours: map(select((.bash // .command // "") | test("cat-herdr-model-reporter") | not));
    if .hooks then
      .hooks |= with_entries(.value |= (if type == "array" then strip_ours else . end))
      | .hooks |= with_entries(select((.value | type) != "array" or (.value | length) > 0))
    else . end
  ' "$HOOK_CONFIG" >"$TMP"; then
		echo "Error: refusing to edit $HOOK_CONFIG (comments in JSON are not supported)." >&2
		exit 1
	fi
	cp "$HOOK_CONFIG" "$HOOK_CONFIG.bak"
	if jq -e '((.hooks // {}) | length) == 0 and ((keys - ["version", "hooks"]) | length) == 0' "$TMP" >/dev/null; then
		rm -f "$HOOK_CONFIG" "$TMP"
		echo "Removed empty dedicated hook config $HOOK_CONFIG (backup at $HOOK_CONFIG.bak)"
	else
		mv "$TMP" "$HOOK_CONFIG"
		echo "Removed Cat Herdr hooks; retained unrelated hooks in $HOOK_CONFIG"
	fi
	trap - EXIT
fi
rm -f "$REPORTER" "$HOOKS_DIR/cat-herdr-model-reporter.js"
echo "Removed $REPORTER"
echo "Done. Restart Copilot CLI."
