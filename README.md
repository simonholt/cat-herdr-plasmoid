# Cat Herdr

A KDE Plasma 6 plasmoid for monitoring AI coding agents managed by [Herdr](https://github.com/simonholt/herdr).

See who's working, who's blocked, and who needs you — at a glance.

## Status

Early development.

## Installation

```bash
./install.sh
systemctl --user restart plasma-plasmashell.service
```

## Uninstallation

```bash
./uninstall.sh
systemctl --user restart plasma-plasmashell.service
```

## Development

Test interactively without installing:

```bash
plasmoidviewer -a package
```

## License

MIT
