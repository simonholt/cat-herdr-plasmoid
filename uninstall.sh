#!/bin/bash
set -e

echo "Uninstalling Cat Herdr plasmoid..."
kpackagetool6 --type Plasma/Applet --remove com.github.simonholt.catherder || true

echo "Removing icon..."
rm -f "$HOME/.local/share/icons/hicolor/scalable/apps/catherder.svg"

echo ""
echo "Uninstalled successfully."
echo "Restart plasmashell to apply: systemctl --user restart plasma-plasmashell.service"
