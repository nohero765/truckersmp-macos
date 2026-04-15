# TruckersMP for macOS 🚛

A native macOS GUI launcher for [TruckersMP](https://truckersmp.com) — the Euro Truck Simulator 2 multiplayer mod — built with Electron. Wraps [truckersmp-cli](https://github.com/truckersmp-cli/truckersmp-cli) and [CrossOver](https://www.codeweavers.com/crossover) Wine into a clean, dark interface so you can get into the game without touching a terminal.

![App Icon](icon.png)

---

## Features

### Launch & Game Control
- **One-click launch** into TruckersMP multiplayer or ETS2 singleplayer
- **macOS / Official mode toggle** — switch between the macOS-optimised launch path and the official Wine path
- **Stop / Force Kill** — correctly terminates Wine processes via `wineserver -k`; Force Kill kills all Wine-related processes (`wine64`, `wineserver`, `wine-preloader`, `eurotrucks2.exe`)

### Graphics Translators (DOES NOT WORK WILL BE REPLACED LATER!!! PLACEHOLDER!)
- **D3DMetal** (Apple) — Apple's own DX11 → Metal translator bundled with CrossOver | HIGH MEMORY USAGE ⚠️
- **DXMT** (Community) — DX11 → Metal, actively maintained | RECOMMENDED | MODERATE RAM USAGE 
- **DXVK** (Community) — DX9/10/11 → Vulkan → Metal
- **Auto version detection** reads translator versions directly from the CrossOver binary — no Xcode Command Line Tools required
- **Env vars preview** shows the exact environment variables that will be set for the selected translator

### Path Management
- **Auto-detect** for `truckersmp-cli`, CrossOver Wine, Bottle, Steam directory, and game directory
- **Detection badges** (Found / Not found) with manual override indicators
- **Browse buttons** and **Reveal in Finder** for all paths
- **↻ Re-detect** and **⚕ Diagnose CLI** buttons for troubleshooting

### Live Log Viewer
- **Real-time log streaming** with colour-coded output (info / warn / error / success / system)
- **Filter bar** to search log output on the fly
- **Timestamps** toggle and **auto-scroll** toggle
- **Clear** button to reset the log

### TruckersMP Server Status
- **Live server list** pulled from the TMP API — shows player count and server status
- **Auto-refreshes every 60 seconds**, with a manual Refresh button

### Discord Rich Presence
- **Enable/disable Discord RPC** with a checkbox
- **Custom Discord Application ID** — bring your own Discord app for a personalised status
- **Customisable RPC fields**: login text, in-game text, state line, large image key and tooltip
- **▶ Test it!** button to verify your RPC setup before launching

### Other Settings
- **Singleplayer mode** — bypasses TruckersMP login and launches ETS2 directly
- **Metal HUD overlay** — shows GPU/CPU stats in-game; works with any translator
- **Animated background** — subtle colour blob animations with frosted glass; auto-pauses while the game is running
- **Extra CLI arguments** field for power users
- **Command preview** panel — shows the exact command that will be run, with a Copy button
- **Settings persistence** at `~/.config/truckersmp-launcher/settings.json`
- **Uninstall section** — remove `truckersmp-cli` or wipe launcher settings without leaving the app
- **About tab** with version info and dependency credits
- **Debug bar** for real-time internal diagnostics

### Keyboard Shortcuts
| Shortcut | Action |
|---|---|
| `⌘L` | Launch game |
| `⌘.` | Stop game |
| `⌘K` | Clear log |

---

## Requirements

| Dependency | Notes |
|---|---|
| macOS | Apple Silicon recommended (required for D3DMetal / GPTK) |
| [CrossOver](https://www.codeweavers.com/crossover) | Wine runtime — free trial available |
| [truckersmp-cli](https://github.com/truckersmp-cli/truckersmp-cli) | Install via `pip3 install truckersmp-cli` |
| Euro Truck Simulator 2 | Must be installed inside a CrossOver bottle via Steam |

---

## Setup

1. Launch the app — it will try to **auto-detect** all paths on first run. Detection badges in the sidebar show what was found.
2. If anything is missing, use the **Browse** buttons in Settings to set paths manually:
   - **truckersmp-cli path** — usually `/opt/homebrew/bin/truckersmp-cli` or `~/.local/bin/truckersmp-cli`
   - **Wine (CrossOver) path** — inside `/Applications/CrossOver.app/...`; use `wine64` if available
   - **Bottle path** — your CrossOver bottle with Steam + ETS2 installed (usually named "Steam")
   - **Steam directory** — the Steam folder inside the bottle (auto-detected from the bottle path)
   - **Game directory** — the ETS2 folder inside the bottle (auto-detected from the Steam dir)
3. Select your preferred **translator** (D3DMetal is recommended on Apple Silicon).
4. Hit **Launch**.

### Installing truckersmp-cli

```bash
pip3 install truckersmp-cli
```

If `pip3` isn't available, install Python 3 from [python.org](https://www.python.org/downloads/) first, then reinstall. You can also use `pipx install truckersmp-cli`.

---

## Discord Rich Presence Setup

1. Create a free app at [discord.com/developers/applications](https://discord.com/developers/applications)
2. Name it "TruckersMP" and add the TruckersMP logo as an image asset named `truckersmp`
3. Paste the **Client ID** into Settings → Discord Application ID
4. Customise the status text fields as desired
5. Hit **▶ Test it!** to verify before launching

---

## Troubleshooting

**truckersmp-cli not found**
Run `pip3 install truckersmp-cli`, then click **↻ Re-detect** in the sidebar. You can also click **⚕ Diagnose CLI** for a detailed diagnostic report.

**Game launches but crashes immediately**
Try switching translators (e.g. D3DMetal → DXVK). The live log highlights known errors with suggested fixes inline.

**Wine processes linger after stopping**
Use **Force Kill** from the sidebar. As a last resort.

**Discord RPC not working**
Make sure Discord is running before launching the game. Use **▶ Test it!** to verify. Check that your Application ID is correct and the `truckersmp` image asset exists in your Discord app.

---


## Contributing

PRs and issues welcome. If you hit a crash or a path detection failure, please open an issue and include the contents of the log panel and the debug bar output.

---

## License

MIT
