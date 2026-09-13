#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$SCRIPT_DIR/package"

if [ ! -f "$PACKAGE_DIR/metadata.json" ]; then
	echo "Error: package/metadata.json not found"
	exit 1
fi

# Resolve herdr path and template main.xml
HERDR_CMD=$(command -v herdr 2>/dev/null) || {
	echo "Error: herdr not found on PATH"
	exit 1
}

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT
cp -r "$PACKAGE_DIR"/* "$TMPDIR/"
ESCAPED=$(printf '%s\n' "$HERDR_CMD" | sed 's/[&\\/]/\\&/g')
sed -i "s|@HERDR_BIN@|$ESCAPED|g" "$TMPDIR/contents/config/main.xml"

echo "Installing Cat Herdr plasmoid..."
kpackagetool6 --type Plasma/Applet --upgrade "$TMPDIR" 2>/dev/null ||
	kpackagetool6 --type Plasma/Applet --install "$TMPDIR"

echo "Installing icon..."
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
mkdir -p "$ICON_DIR"
cp "$PACKAGE_DIR/contents/icons/catherder.svg" "$ICON_DIR/catherder.svg"

echo ""
echo "Installed successfully."
echo "Restart plasmashell to load: systemctl --user restart plasma-plasmashell.service"
