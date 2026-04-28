# TruckersMP for macOS 🚛

A native macOS GUI launcher for [TruckersMP](https://truckersmp.com) — the Euro Truck Simulator 2 multiplayer mod — built with Electron. Wraps [truckersmp-cli](https://github.com/truckersmp-cli/truckersmp-cli) and [CrossOver](https://www.codeweavers.com/crossover) Wine into a clean, dark interface so you can get into the game without touching a terminal.

<p align="center">
  <img src="icon.png" width="128" alt="App Icon">
</p>

---

## Features

### Launch & Game Control
- **One-click launch** into TruckersMP multiplayer or ETS2 singleplayer
- **macOS / Official mode toggle** — switch between the macOS-optimised launch path and the official Wine path
- **Stop / Force Kill** — correctly terminates Wine processes via `wineserver -k`; Force Kill nukes all Wine-related processes (`wine64`, `wineserver`, `wine-preloader`, `eurotrucks2.exe`)
- **Steam control** — start Steam in the bottle with one click, stop it just as easily; live status indicator turns the button red while Steam is running

### Graphics Translators _(work in progress — placeholder UI, real switching coming later)_
- **D3DMetal** (Apple) — Apple's own DX11 → Metal translator bundled with CrossOver | high memory usage ⚠️
- **DXMT** (Community) — DX11 → Metal, actively maintained | recommended | moderate memory usage
- **DXVK** (Community) — DX9/10/11 → Vulkan → Metal
- **Auto version detection** reads translator versions directly from the CrossOver binary — no Xcode Command Line Tools required

### Path Management
- **Auto-detect** for `truckersmp-cli`, CrossOver Wine, Bottle, Steam directory, and game directory
- **Detection badges** (Found / Not found) with manual override indicators
- **Browse buttons** and **Reveal in Finder** for all paths
- **↻ Re-detect** and **⚕ Diagnose CLI** buttons for troubleshooting
- **Env vars preview** shows the exact environment variables that will be set for the selected translator

### Live Log Viewer
- **Real-time log streaming** with colour-coded output (info / warn / error / success / system)
- **Filter bar** to search log output on the fly
- **Timestamps** and **auto-scroll** toggles
- **Clear** button to reset the log

### TruckersMP Server Status
- **Live server list** pulled from the TMP API — shows player count, queue size, and online status
- **Favourites** — star your main servers; favourites pin to the top of the list
- **Maintenance hint** when all servers are offline
- **Auto-refresh** on a configurable interval, plus manual refresh button

### TMP Info & Events
- **In-game time, latest TMP version, supported ETS2 version** at a glance
- **Upcoming events** list pulled from the TMP API with date, type, and server

### Player Finder
- **Look up any TruckersMP player by ID** — shows avatar, ban count, VTC affiliation, and join year
- Lives in the right sidebar — always one click away

### Discord Rich Presence
- **Enable/disable Discord RPC** with a checkbox
- **Custom Discord Application ID** — bring your own Discord app for a personalised status
- **Customisable RPC fields**: login text, in-game text, state line, large image key and tooltip
- **▶ Test it!** button to verify your RPC setup before launching

### Other Settings
- **Singleplayer mode** — bypasses TruckersMP login and launches ETS2 directly
- **Metal HUD overlay** — shows GPU/CPU stats in-game; works with any translator
- **Cool UI** — frosted-glass dark theme with a soft red glow; toggle off if you prefer a plain look
- **Pause data refresh when unfocused** — saves CPU when the launcher is in the background
- **Show debug bar** — real-time internal diagnostics with full history (⧉ icon opens history overlay)
- **Extra CLI arguments** field for power users
- **Command preview** panel — shows the exact command that will be run, with a Copy button
- **Settings persistence** at `~/.config/truckersmp-launcher/settings.json`
- **Uninstall section** — remove `truckersmp-cli` or wipe launcher settings without leaving the app
- **About tab** with version info and dependency credits

### Keyboard Shortcuts
| Shortcut | Action |
|---|---|
| `⌘L` | Launch game |
| `⌘.` | Stop game |
| `⌘S` | Start / Stop Steam |
| `⌘R` | Refresh server status |
| `⌘K` | Clear log |
| `⌘,` | Open Settings tab |

---

## Requirements

| Dependency | Notes |
|---|---|
| macOS 12+ | Apple Silicon recommended (required for D3DMetal / GPTK) |
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
Try switching translators (e.g. DXMT → DXVK → D3DMetal) in crossover. The live log highlights known errors with suggested fixes inline.

**Wine processes linger after stopping**
Use **Force Kill** from the sidebar it kills every Wine-related process. As a last resort.

**Discord RPC not working**
Make sure Discord is running before launching the game. Use **▶ Test it!** to verify. Check that your Application ID is correct.
---

## Contributing

PRs and issues welcome. If you hit a crash or a path detection failure, please open an issue and include the contents of the log panel and the debug bar output.

---

## License

MIT
