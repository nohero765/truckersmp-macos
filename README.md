# TruckersMP for macOS 

A macOS launcher for [TruckersMP](https://truckersmp.com) — the ETS2 multiplayer mod — built with Electron. Under the hood it wraps [truckersmp-cli](https://github.com/truckersmp-cli/truckersmp-cli) and can either use **CrossOver Wine** or a fully self-contained **Standalone Wine** build to launch the game.

> **Beta release (v2.0 Beta) — things are subject to change.**

<p align="center">
  <img src="icon.png" width="128" alt="App Icon">
</p>

---

## Features

### Launch & Game Control
- **One-click launch** into TruckersMP multiplayer or ETS2 singleplayer
- **Start Steam** independently, then **Launch ETS2 MP** once it's up
- **Stop / Force Kill** — correctly terminates all Wine processes
- **Wine Activity panel** — shows running Wine processes with **Manage** and **Kill All**

### Two Wine Backends
Switch between backends per-game from the sidebar toggle:
- **CrossOver Wine** — uses an existing CrossOver install and bottle
- **Standalone Wine** *(Beta)* — fully self-contained, no CrossOver required. The launcher manages its own Wine builds, bottle, and DXMT install for you

### Path Management
- **Auto-detect** for `truckersmp-cli`, Wine, Bottle, Steam directory, and game directory (works for both backends — **Auto-detect Paths** in Standalone Wine settings)
- **Detection badges** (Found / Not found) in the sidebar
- **Browse buttons** and **Open Bottle in Finder**
- **↻ Re-detect**

### Standalone 
- **Setup Wizard** — installs the latest Wine build and DXMT release automatically.
- **Wine version manager** — install multiple Wine builds side by side, mark one **active**, uninstall old ones
- **Status checklist** — Wine installed / Bottle ready / DXMT version, each with a ✓
- **Bottle Path**, **Steam Directory inside bottle**, and **ETS2 Game Directory inside bottle**, independently configurable
- **Launch winecfg** and **Reinstall DXMT** shortcuts
- **Wine Command runner** — run Wine commands (e.g. `regedit`, `explorer`) directly to the bottle
- **Wine Log** — toggleable debug logging with **Open in Finder**

### Live Log Viewer
- **Real-time log streaming** with colour-coded output (info / warn / error / success / system)
- **Category tabs** — filter between All / Wine / Launcher output
- **Filter bar** to search log output on the fly
- **Timestamps** and **auto-scroll** toggles
- **Clear** button to reset the log

### TruckersMP Server Status
- **Live server list** pulled from the TMP API — shows player count and server status
- **Favourites** — star your main servers; favourites pin to the top of the list
- **Auto-refresh** on a configurable interval (see Launcher Options), plus manual refresh

### TMP Info & Events
- **In-game time, latest TMP version, supported ETS2 version** at a glance, with manual refresh
- **Upcoming events** list pulled from the TMP API with date, type, and server

### Player Finder -Might get removed in a future build- S
- **Look up any TruckersMP player by numeric ID** — shows avatar, ban count, VTC affiliation, and join year
- Lives in the right sidebar — always one click away

### Discord Rich Presence
- **Enable/disable Discord RPC**
- **Custom Discord Application ID** — bring your own Discord app for a personalised status
- **Customise Rich Presence** panel for status text fields
- **Set ETS2MP Logs Folder** + **Force Watch Chat Log** — scans today's `chat_YYYY_MM_DD` log every 5 seconds for "Connected to simulation N" / "Connection established" to auto-detect when you've joined a server
- **Auto-reconnect Discord** — retries every 20s while the game is running
- **Enable Advanced RPC** — shows truck + route (requires an ETS2 telemetry plugin)

### Other Settings
- **Singleplayer mode** — bypasses TruckersMP login and launches ETS2 directly
- **Metal HUD overlay** — shows GPU/CPU stats in-game, works with either backend
- **Retina Mode** toggle
- **Show debug bar** — real-time internal diagnostics
- **Show Wine Activity section** toggle for the log panel
- **Extra CLI arguments**
- **Rebindable keyboard shortcuts** — click a binding, press a new key combo, or reset all to defaults
- **Server status & TMP info refresh interval** — configurable dropdown (default: every 1 minute)
- **Settings persistence** at `~/.config/truckersmp-launcher/settings.json`
- **Reset & Uninstall** — remove launcher settings (permanently deletes `~/.config/truckersmp-launcher/`) without leaving the app
- **About tab** — version info, **Check for Update**, and credits

### Keyboard Shortcuts
Defaults (all rebindable in Settings → Launcher Options):

| Shortcut | Action |
|---|---|
| `⌘L` | Launch game |
| `⌘.` | Stop game |
| `⌘S` | Start / Stop Steam |
| `⌘R` | Refresh servers |
| `⌘K` | Clear log |
| `⌘,` | Open Settings |

---

## Requirements

| Dependency | Notes |
|---|---|
| Apple Silicon Mac | Required for [DXMT](https://github.com/3Shain/dxmt) |
| [truckersmp-cli](https://github.com/truckersmp-cli/truckersmp-cli) | Install via `pip3 install truckersmp-cli` |
| Euro Truck Simulator 2 | Must be installed via Steam inside a Wine bottle |
| **Either:** [CrossOver](https://www.codeweavers.com/crossover) (free trial available) **or nothing else** | Standalone  manages its own Wine build — no CrossOver purchase/trial needed |

> As of DXMT 0.72, experimental Intel Mac support was added — Apple Silicon is still recommended, but Intel Macs may work.

> As of now Standalone Wine mode currently installs **Wine 11.11** and **DXMT 0.80**.
---

## Setup

### Standalone Wine Mode (recommended — no CrossOver needed)
1. Open Settings → **Wine Mode** → select **Standalone Wine**
2. Click **Open Setup Wizard** and follow the prompts — it installs Wine, prepares the bottle, and installs DXMT for you
3. Once the checklist shows **Wine installed ✓ / Bottle ready ✓ / DXMT ✓**, click **Auto-detect Paths** to locate Steam and ETS2 inside the bottle (or set **Bottle Path**, **Steam Directory**, and **ETS2 Game Directory** manually)
4. Click **Start Steam**, wait for it to finish starting up
5. Hit **Launch ETS2 MP**

If you need to install a different Wine build later, use **+ Install New** under Wine Versions, then mark the one you want as active.

### CrossOver Mode
1. Launch the app — it will try to **auto-detect** all paths on first run. Detection badges in the sidebar show what was found.
2. If anything is missing, use the **Browse** buttons in Settings to set paths manually:
   - **truckersmp-cli path** — usually `~/.local/bin/truckersmp-cli`
   - **Wine (CrossOver) path** — inside `/Applications/CrossOver.app/...`
   - **CrossOver Bottle** — your bottle with Steam + ETS2 installed (usually named "Steam")
   - **Steam directory** — the Steam folder inside the bottle (auto-detected from the bottle path)
   - **Game directory** — the ETS2 folder inside the bottle (auto-detected from the Steam dir)
3. Click **Start Steam** and wait for it to start up.
4. Hit **Launch ETS2 MP**.

### Installing truckersmp-cli

```bash
pip3 install truckersmp-cli
```

If `pip3` isn't available, install Python 3 from [python.org](https://www.python.org/downloads/) first. You can also use `pipx install truckersmp-cli`.

---
## Discord Rich Presence Setup

The launcher ships with a default Discord Application ID already configured — Rich Presence works out of the box, no setup required.

1. Make sure **Enable Discord Rich Presence** is checked in Settings
2. Customise the status text via **Customise Rich Presence**
3. Done!

### Using your own Discord Application (optional)
If you'd rather use your own Discord app instead of the built-in one:
1. Create a free app at [discord.com/developers/applications](https://discord.com/developers/applications)
2. Name it "TruckersMP" and add the TruckersMP logo as an image asset named `truckersmp`
3. Paste the Client ID into Settings → Discord Application ID, replacing the default one

### Rich Presence extras

- **Advanced RPC** — shows truck + route, requires an ETS2 telemetry plugin

> [!NOTE]
> Telemetry / Advanced RPC hasn't been tested with **Standalone Wine mode** yet. If you rely on this feature, use **CrossOver mode** for now —  Wine support is planned.
---

## Troubleshooting

**truckersmp-cli not found**
Run `pip3 install truckersmp-cli`, then click **↻ Re-detect** in the sidebar.

**Game launches but crashes immediately**
On CrossOver, try switching translators (DXMT is recommended on Apple Silicon). On Standalone Wine, use **Wine Diagnostics** in Settings to test your setup, or try **Reinstall DXMT**.

**Wine processes linger after stopping**
Use **Kill All** in the Wine Activity panel — it kills every Wine-related process.

**Discord RPC not working**
Make sure Discord is running, and that your Application ID is correct.

**Slight pink shadow on the truck / steering wheel**
Go into ETS2 graphics settings and set reflection quality to High. This is a known rendering quirk that sometimes resolves itself after a TruckersMP or DXMT update.

---

## Contributing

PRs and issues welcome. If you hit a crash or a path detection failure, please open an issue and include the contents of the log panel (and Wine Log, if using Standalone Wine mode).

---

## Acknowledgements

This project was developed with AI assistance — what started as an idea became a reality with its help.
Inspired by [matyash12's unofficial TruckersMP macOS launcher](https://github.com/matyash12/unofficial-truckersmp-macos-launcher).

## License

MIT
