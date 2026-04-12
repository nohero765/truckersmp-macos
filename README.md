# 🚛 Unofficial TruckersMP Launcher for macOS
 
An unofficial TruckersMP launcher for macOS, built with Electron, truckersmp-cli, and CrossOver's Wine.
 
---
 
## What is this?
 
This is a macOS GUI launcher that lets you play Euro Truck Simulator 2 **TruckersMP** mod on Apple Silicon Macs without touching the terminal.
 
Under the hood it wraps `truckersmp-cli` and CrossOver's Wine environment to handle all the heavy lifting, while giving you a clean interface to configure and launch the game.
 
---
 
## Features
 
- 🖥️ Clean dark UI with a simple launch/stop control
- 📂 Path configuration with validation for game and Wine prefix (Path are automatically detected)
- 📋 Live log panel to monitor launch output in real time
- 🍎 Built for Apple Silicon (Not tested on non M chips)
 
---
 
## Requirements
 
- [CrossOver](https://www.codeweavers.com/crossover) installed
- [truckersmp-cli](https://github.com/truckersmp-cli/truckersmp-cli) installed via pip
- Euro Truck Simulator 2 installed through CrossOver
- Python 3.x (to install truckersmp-cli)

## Notice! (PLACEHOLDER)

This was tested on a **Macbook Air M4 16 GB RAM** while playing it uses 18 gb in busy area its recommended to have 16 gb ram. if your on intel mac its recommended to have beefy specs
 
---
 
## Installation
 
1. Download the latest release from the [Releases](../../releases) page.
2. Open the `.dmg` and drag the app to your Applications folder.
3. On first launch, configure your paths in the settings panel:
   - Path to your ETS2 game directory (inside CrossOver)
   - Path to your Wine prefix
4. Select your preferred translator and hit **Launch**.
 
---
 
## How It Works **PLACEHOLDER**
 
The launcher acts as a graphical front-end for `truckersmp-cli`. When you hit launch, it:
 
1. Launches a command that was sent in TruckersmpCli discussions bit modified
2. TO BE DONE LATER
---
 
## Known Issues
 
- Reflections may appear pink or washed out on **DXMT** or **D3DMetal** (more worse than dxmt) **Workaround** is to put your reflection quality to High or more less than medium will cause them to appear

  *might get fixed in the future by a DXMT update or D3DMetal update or TruckersMp update*

- VC does not work it does access the microphone but refues to work **keep in mind** minimal testing was done on this part so it might work for you

- The Offical Disocrd RPC by truckersmp does not work due to it being targetted to windows the app incudles a custom made one it shows the game, logging in or in game, Truckersmp logo and name **it does not support** saying exact Truck/Car model or Near: location

 
---
 
## Credits
 
- [**truckersmp-cli**](https://github.com/truckersmp-cli/truckersmp-cli) — The backbone of this launcher. All the actual game launching logic is powered by this tool.
- [**CrossOver** by CodeWeavers](https://www.codeweavers.com/crossover) — Makes running ETS2 on macOS possible via Wine and its Translators.
- **AI assistance** — This project started as a personal idea just to see if TruckersMP could even run on a Mac. It was never really meant to become a full release. AI was used to assist me into bringing that idea to reality — it wasn't something built with the intention of publishing from the start so the assistance helped turn a fun experiment into something actually shareable.
 
---
 
## ⚠️ Disclaimer
 
This project is unofficial and not affiliated with TruckersMP or CodeWeavers in any way Use at your own risk.
