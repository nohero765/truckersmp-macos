# TruckersMP for macOS 🚛

A macOS launcher for [TruckersMP](https://truckersmp.com) the ETS2 multiplayer mod built with Electron. Under the hood it wraps [truckersmp-cli](https://github.com/truckersmp-cli/truckersmp-cli) and uses [CrossOvers](https://www.codeweavers.com/crossover) Wine to launch the game and handle everything.
<p align="center">
  <img src="icon.png" width="128" alt="App Icon">
</p>

---

## Features

### Launch & Game Control
- **One-click launch** into TruckersMP multiplayer or ETS2 singleplayer
- **Stop / Force Kill** — correctly terminates all Wine processes
- **Steam control** — start Steam in the bottle with one click, stop it just as easily
### Graphics Translators _(work in progress — standalone wine coming soon)_
- **D3DMetal** (Apple) — Apple's own DX11 → Metal translator bundled with CrossOver | high memory usage ⚠️
- **DXMT** (Community) — DX11 → Metal, actively maintained | recommended | moderate memory usage
- **Auto version detection**

### Path Management
- **Auto-detect** for `truckersmp-cli`, CrossOver Wine, Bottle, Steam directory, and game directory
- **Detection badges** (Found / Not found) with manual override indicators
- **Browse buttons** and **Reveal in Finder** for all paths
- **↻ Re-detect** 
- **Env vars preview** shows the exact environment variables

### Live Log Viewer
- **Real-time log streaming** with colour-coded output (info / warn / error / success / system)
- **Filter bar** to search log output on the fly
- **Timestamps** and **auto-scroll** toggles
- **Clear** button to reset the log

### TruckersMP Server Status
- **Live server list** pulled from the TMP API — shows player count and server status
- **Favourites** — star your main servers; favourites pin to the top of the list
- **Maintenance hint** when all servers are offline
- **Auto-refresh** on a configurable interval, plus manual refresh button

### TMP Info & Events
- **In-game time, latest TMP version, supported ETS2 version** at a glance
- **Upcoming events** list pulled from the TMP API with date, type, and server

### Player Finder _(might be removed)_
- **Look up any TruckersMP player by ID** — shows avatar, ban count, VTC affiliation, and join year
- Lives in the right sidebar — always one click away

### Discord Rich Presence
- **Enable/disable Discord RPC**
- **Custom Discord Application ID** — bring your own Discord app for a personalised status
- **Customisable RPC fields**: login text, in-game text, state line, large image key and tooltip
- **▶ Test it!** button to verify your RPC setup before launching

### Other Settings
- **Singleplayer mode** — bypasses TruckersMP login and launches ETS2 directly
- **Metal HUD overlay** — shows GPU/CPU stats in-game; works with any translator
- **Pause data refresh when unfocused** — saves CPU when the launcher is in the background
- **Show debug bar** — real-time internal diagnostics with full history (⧉ icon opens history overlay)
- **Extra CLI arguments** 
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
| Apple Silicon recommended (required for D3DMetal / DXMT) |
| [CrossOver](https://www.codeweavers.com/crossover) | Wine — free trial available |
| [truckersmp-cli](https://github.com/truckersmp-cli/truckersmp-cli) | Install via `pip3 install truckersmp-cli` |
| Euro Truck Simulator 2 | Must be installed inside a CrossOver bottle via Steam |

---

## Setup

1. Launch the app — it will try to **auto-detect** all paths on first run. Detection badges in the sidebar show what was found.
2. If anything is missing, use the **Browse** buttons in Settings to set paths manually:
   - **truckersmp-cli path** — usually `~/.local/bin/truckersmp-cli`
   - **Wine (CrossOver) path** — inside `/Applications/CrossOver.app/...`
   - **Bottle path** — your CrossOver bottle with Steam + ETS2 installed (usually named "Steam")
   - **Steam directory** — the Steam folder inside the bottle (auto-detected from the bottle path)
   - **Game directory** — the ETS2 folder inside the bottle (auto-detected from the Steam dir)
3. Select your preferred **translator** (DXMT is recommended on Apple Silicon).
4. Hit **Launch**.

### Installing truckersmp-cli (For now Truckersmp-cli is not inculded within the app)

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
Make sure discord is running Use **Test it** button to make sure its displaying correctly


**There is a slight pink shadow all over the truck and steering wheel**
go into settings graphics option and make sure reflection quality is set to high. (Rendering bug sometimes gets fixed by itself either by a Truckersmp update or DXMT update)

---

## Contributing

PRs and issues welcome. If you hit a crash or a path detection failure, please open an issue and include the contents of the log panel and the debug bar output.

---

## Acknowledgements
This project was developed with AI assistance what started as an idea became a reality with its help.
Inspired by [matyash12's unofficial TruckersMP macOS launcher](https://github.com/matyash12/unofficial-truckersmp-macos-launcher).

## License

MIT
