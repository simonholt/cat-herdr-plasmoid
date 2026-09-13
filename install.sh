#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$SCRIPT_DIR/package"

if [ ! -f "$PACKAGE_DIR/metadata.json" ]; then
	echo "Error: package/metadata.json not found"
	exit 1
fi

echo "Installing Cat Herdr plasmoid..."
kpackagetool6 --type Plasma/Applet --upgrade "$PACKAGE_DIR" 2>/dev/null ||
	kpackagetool6 --type Plasma/Applet --install "$PACKAGE_DIR"

echo "Installing icon..."
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
mkdir -p "$ICON_DIR"
cp "$PACKAGE_DIR/contents/icons/catherder.svg" "$ICON_DIR/catherder.svg"

echo ""
echo "Installed successfully."
echo "Restart plasmashell to load: systemctl --user restart plasma-plasmashell.service"
