const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path  = require('path')
const fs    = require('fs')
const os    = require('os')
const net   = require('net')
const https = require('https')
const { spawn, execFileSync, execSync, execFile } = require('child_process')

let mainWindow  = null
let gameProcess = null
let steamPid    = null
let _steamPollActive    = false   // set true by beginSteamReadyPoll; cleared when poll ends
let _steamStopRequested = false   // set true by stopSteam so the exit watchdog skips restart check
let currentLaunchSettings = null   // saved so stop/forceStop can access bottle/wine paths

// ── Settings ──────────────────────────────────────────────────────────────────
const settingsPath = path.join(os.homedir(), '.config', 'truckersmp-launcher', 'settings.json')

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      // Migrate: remove legacy --verbose / -v from extraArgs since it's now always added internally
      if (s.extraArgs) {
        s.extraArgs = s.extraArgs.replace(/--verbose|-v\b/g, '').replace(/\s+/g, ' ').trim()
      }
      return s
    }
  } catch {}
  return { cliPath:'', winePath:'', bottlePath:'', steamDir:'', gameDir:'',
           ets2mpLogsDir:'',
           extraArgs:'', discordIPC:true, singlePlayer:false,
           launchMode:'macos',
           wineMode:'crossover',
           standalonBottlePath: path.join(os.homedir(), 'Library', 'Application Support', 'TruckersMP-Launcher', 'TruckersmpBottle'),
           standalonSteamDir:'', standalonGameDir:'', standalonDxmtDir:'', standalonDxmtVersion:'',
           standalonWineSlug: '',
           standaloneWizardDone: false,
           standalonWineDebugLog: true,
           standalonRetinaMode: false,
           }
}

function saveSettings(s) {
  const dir = path.dirname(settingsPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2))
}

const CX_APP  = '/Applications/CrossOver.app'

// ── Resolve Python interpreter for a CLI script ───────────────────────────────
// Node's spawn() can fail with ENOEXEC (-8) when trying to execute a Python
// script directly if the shebang interpreter is not in the expected location.
// We read the shebang and try each candidate interpreter ourselves so Node
// always spawns a real binary, not a script.
function resolveInterpreter(cliPath) {
  // Read shebang line (#! /usr/bin/env python3  or  #!/opt/homebrew/bin/python3 etc.)
  let shebangInterp = null
  try {
    const firstLine = fs.readFileSync(cliPath, { encoding: 'utf8', flag: 'r' })
      .split('\n')[0] || ''
    if (firstLine.startsWith('#!')) {
      // Strip #! and split on whitespace; handle "#!/usr/bin/env python3"
      const parts = firstLine.replace('#!', '').trim().split(/\s+/)
      if (parts[0] === '/usr/bin/env') {
        shebangInterp = parts[1] || null   // e.g. "python3"
      } else {
        shebangInterp = parts[0] || null   // e.g. "/opt/homebrew/bin/python3"
      }
    }
  } catch {}

  // Candidate Python interpreters to try, in priority order
  const candidates = [
    shebangInterp,                           // whatever the script's shebang says
    '/opt/homebrew/bin/python3',             // Homebrew (Apple Silicon default)
    '/usr/local/bin/python3',                // Homebrew (Intel)
    '/usr/bin/python3',                      // macOS system Python
    'python3',                               // whatever is in PATH
    'python',
  ].filter(Boolean)

  // Also scan ~/Library/Python/ for any version's python3 binary
  const libPy = path.join(os.homedir(), 'Library', 'Python')
  if (fs.existsSync(libPy)) {
    let vers = []
    try { vers = fs.readdirSync(libPy) } catch {}
    vers.sort((a, b) => {
      const [,ai] = a.split('.').map(Number)
      const [,bi] = b.split('.').map(Number)
      return (bi||0) - (ai||0)
    })
    for (const v of vers) {
      candidates.push(path.join(libPy, v, 'bin', 'python3'))
    }
  }

  for (const c of candidates) {
    if (!c) continue
    // Absolute paths: check existence + executable bit
    if (c.startsWith('/')) {
      try { fs.accessSync(c, fs.constants.X_OK); return c } catch {}
    } else {
      // Name only — use `which` to resolve it
      try {
        const w = execFileSync('which', [c], { timeout: 2000 }).toString().trim()
        if (w && fs.existsSync(w)) return w
      } catch {}
    }
  }

  // No interpreter found — return null and let spawn() try directly
  return null
}

// ── Detection ─────────────────────────────────────────────────────────────────
const HOME = os.homedir()

const CX_WINE = [
  '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine64',
  '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'
]
// Static candidate list — covers all common macOS Python install locations.
const CLI_PATHS_STATIC = [
  '/opt/homebrew/bin/truckersmp-cli',
  '/usr/local/bin/truckersmp-cli',
  '/usr/bin/truckersmp-cli',
  `${HOME}/.local/bin/truckersmp-cli`,
  `${HOME}/bin/truckersmp-cli`,
  // pipx installs
  `${HOME}/.local/pipx/venvs/truckersmp-cli/bin/truckersmp-cli`,
  // python.org user installs in ~/Library/Python/3.x — 3.8 through 3.15 covered
  ...[8,9,10,11,12,13,14,15].map(v => `${HOME}/Library/Python/3.${v}/bin/truckersmp-cli`),
  // python.org system-level installs in /Library/Frameworks/Python.framework
  ...[8,9,10,11,12,13,14,15].map(v => `/Library/Frameworks/Python.framework/Versions/3.${v}/bin/truckersmp-cli`),
]
const CX_BOTTLES = `${HOME}/Library/Application Support/CrossOver/Bottles`

// ── Dynamic CLI scanner ───────────────────────────────────────────────────────
// Scans ~/Library/Python/ and /Library/Frameworks/Python.framework/ for any
// installed Python version and checks for truckersmp-cli. Also tries `which`.
function sortVersionsDesc(versions) {
  return versions.slice().sort((a, b) => {
    const parse = s => s.split('.').map(Number)
    const av = parse(a), bv = parse(b)
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      const diff = (bv[i] || 0) - (av[i] || 0)
      if (diff !== 0) return diff
    }
    return 0
  })
}

function findCLIPath() {
  // 1. Static candidates first
  for (const p of CLI_PATHS_STATIC) {
    if (fs.existsSync(p)) return p
  }

  // 2. Dynamically scan ~/Library/Python/ (pip3 --user installs)
  const libraryPython = path.join(HOME, 'Library', 'Python')
  if (fs.existsSync(libraryPython)) {
    let versions = []
    try { versions = fs.readdirSync(libraryPython) } catch {}
    for (const ver of sortVersionsDesc(versions)) {
      const p = path.join(libraryPython, ver, 'bin', 'truckersmp-cli')
      if (fs.existsSync(p)) return p
    }
  }

  // 3. Dynamically scan /Library/Frameworks/Python.framework/ (python.org installer)
  const frameworkPython = '/Library/Frameworks/Python.framework/Versions'
  if (fs.existsSync(frameworkPython)) {
    let versions = []
    try { versions = fs.readdirSync(frameworkPython) } catch {}
    for (const ver of sortVersionsDesc(versions)) {
      const p = path.join(frameworkPython, ver, 'bin', 'truckersmp-cli')
      if (fs.existsSync(p)) return p
    }
  }

  // 4. `which truckersmp-cli` — picks up any PATH-installed version
  try {
    const out = execFileSync('which', ['truckersmp-cli'], { timeout: 3000 }).toString().trim()
    if (out && fs.existsSync(out)) return out
  } catch {}

  // 4. Try common pip3 --user install output paths from `pip3 show`
  try {
    const pip = execFileSync('pip3', ['show', '-f', 'truckersmp-cli'], { timeout: 5000 }).toString()
    const locM  = pip.match(/^Location:\s*(.+)$/m)
    const fileM = pip.match(/^\s+(bin\/truckersmp-cli)\s*$/m)
    if (locM && fileM) {
      // Location is the site-packages dir; bin is one level up
      const candidate = path.resolve(locM[1].trim(), '..', fileM[1].trim())
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {}

  return null
}

function runAutoDetect() {
  const r = {
    cliPath:'', winePath:'', bottlePath:'', steamDir:'', gameDir:'',
    crossoverFound:false, cliFound:false, bottleFound:false, steamFound:false, gameFound:false
  }

  for (const p of CX_WINE) {
    if (fs.existsSync(p)) { r.winePath = p; r.crossoverFound = true; break }
  }
  const cli = findCLIPath()
  if (cli) { r.cliPath = cli; r.cliFound = true }
  if (fs.existsSync(CX_BOTTLES)) {
    r.bottleFound = true
    try {
      const bottles = fs.readdirSync(CX_BOTTLES)
      for (const b of bottles) {
        const full   = path.join(CX_BOTTLES, b)
        const steam1 = path.join(full, 'drive_c', 'Program Files (x86)', 'Steam')
        const steam2 = path.join(full, 'drive_c', 'Program Files', 'Steam')
        const steam  = fs.existsSync(steam1) ? steam1 : fs.existsSync(steam2) ? steam2 : null
        if (steam) {
          r.bottlePath  = full
          r.steamDir    = steam
          r.steamFound  = true
          const ets2 = path.join(steam, 'steamapps', 'common', 'Euro Truck Simulator 2')
          if (fs.existsSync(ets2)) { r.gameDir = ets2; r.gameFound = true }
          break
        }
      }
      if (!r.bottlePath && bottles.length > 0)
        r.bottlePath = path.join(CX_BOTTLES, bottles[0])
    } catch(e) { console.error(e) }
  }
  return r
}

// ── Build Args ────────────────────────────────────────────────────────────────
// Both modes require -w because we are always using Wine (CrossOver), not Proton.
// Without -w, truckersmp-cli attempts to use the Steam/Proton runtime which does
// not exist on macOS and causes Wine error 193 (Bad EXE format).
//
// The wine binary is set via the WINE environment variable before spawn —
// truckersmp-cli has no --wine flag. effectiveWinePath (wine64 when available)
// is passed through env so truckersmp-cli uses the 64-bit loader. Error 193 fix.
function buildArgs(s) {
  // Extra args provided by the user (from Settings → Extra Arguments)
  const userExtra = s.extraArgs ? s.extraArgs.trim().split(/\s+/).filter(Boolean) : []
  // Always ensure -v (verbose) is included for diagnostic output.
  // truckersmp-cli uses -v (short form) — there is no --wine flag;
  // the wine binary is set via the WINE environment variable.
  if (!userExtra.includes('-v') && !userExtra.includes('--verbose')) userExtra.push('-v')

  if (s.launchMode === 'official') {
    // Official Wine mode: use the truckersmp-cli flags exactly as documented.
    // -w          → use Wine (not Proton/Steam runtime)
    // -x DIR      → Wine prefix / CrossOver bottle
    // -g DIR      → game directory
    // --wine-steam-dir DIR → Steam directory inside the bottle
    // -r dx11     → force DirectX 11 renderer (avoids OpenGL fallback)
    // Wine binary is controlled via WINE env var (no --wine flag in truckersmp-cli)
    const a = ['-w']
    if (s.bottlePath) a.push('-x', s.bottlePath)
    if (s.gameDir)    a.push('-g', s.gameDir)
    if (s.steamDir)   a.push('--wine-steam-dir', s.steamDir)
    if (!s.discordIPC) a.push('--without-wine-discord-ipc-bridge')
    a.push('-r', 'dx11')
    a.push('start', 'ets2mp')
    a.push(...userExtra)
    return a
  }
  // macOS community mode — wine binary is set via WINE env var (see game:launch handler).
  // effectiveWinePath (wine64) is set in the env before spawn so truckersmp-cli
  // picks it up automatically and uses the 64-bit loader required by ETS2.
  const a = ['-w']
  if (s.gameDir)    a.push('-g', s.gameDir)
  if (s.bottlePath) a.push('-x', s.bottlePath)
  if (s.steamDir)   a.push('--wine-steam-dir', s.steamDir)
  if (!s.discordIPC) a.push('--without-wine-discord-ipc-bridge')
  a.push('-r', 'dx11')
  a.push('start', 'ets2mp')
  a.push(...userExtra)
  return a
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:1100, height:680, minWidth:800, minHeight:520,
    title:'TruckersMP for macOS',
    titleBarStyle:'hiddenInset',
    trafficLightPosition:{ x:14, y:18 },
    backgroundColor:'#0e0e0f',
    webPreferences:{
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))
  mainWindow.on('closed', () => { mainWindow = null })

  // ── Pause data refresh when window is blurred ──────────────────────────────
  // Mirrors settings.refreshOnFocus (default true). When the window loses
  // focus we pause ALL background watchers (chat-log scanner, AFK detector,
  // telemetry poller). On focus we resume whichever were running. Saves CPU
  // / network when the launcher is in the background.
  mainWindow.on('blur',  () => { try { _onWindowBlur()  } catch {} })
  mainWindow.on('focus', () => { try { _onWindowFocus() } catch {} })

  // ── ETS2MP logs folder bootstrap ────────────────────────────────────────────
  // On every startup, make sure we know where ETS2MP writes its logs.
  // - If the user has already saved a path and it still exists, do nothing.
  // - If not, try to auto-detect under ~/Documents/ETS2MP/logs and friends,
  //   and silently save the discovered path.
  // - If we still can't find it, ask the renderer to prompt the user.
  mainWindow.webContents.once('did-finish-load', () => {
    try {
      const s = loadSettings()
      const saved = s.ets2mpLogsDir
      const stillValid = saved && (() => {
        try { return fs.existsSync(saved) && fs.statSync(saved).isDirectory() }
        catch { return false }
      })()
      if (stillValid) return
      const found = _autoDetectEts2mpLogsDir()
      if (found) {
        s.ets2mpLogsDir = found
        saveSettings(s)
        try { mainWindow.webContents.send('log:line',
          { kind:'info', text:`ETS2MP logs folder auto-detected: ${found}`, ts:Date.now() }) } catch {}
      } else {
        try { mainWindow.webContents.send('ets2mp:needsLogsDir') } catch {}
      }
    } catch {}
  })
  if (process.platform === 'darwin') {
    try { app.dock.setIcon(path.join(__dirname, 'icon.png')) } catch {}
  }
}

app.setPath('userData', path.join(os.homedir(), 'Library', 'Application Support', 'TruckersMP-Launcher'))
app.setName('TruckersMP for macOS')
app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!mainWindow) createWindow() })

// ── Cleanup on quit ───────────────────────────────────────────────────────────
// When the launcher exits, kill any Wine/game processes it started so they
// don't linger in the background after the user closes the app.
// We attempt a graceful wineserver -k first (cleans up the bottle's Wine
// server + all child processes), then SIGKILL any tracked PIDs.
// This is best-effort — we never block the quit waiting for processes to die.
app.on('before-quit', () => {
  try {
    // 1. Determine which wine binary + bottle path to use
    //    Priority: settings that were active at last launch, then saved settings.
    const s = currentLaunchSettings || loadSettings()
    const isStandalone = s.wineMode === 'standalone'

    let winePath, bottlePath
    if (isStandalone) {
      winePath   = standaloneWineBin()
      bottlePath = s.standalonBottlePath
    } else {
      winePath   = s.winePath
      bottlePath = s.bottlePath
    }

    // 2. Graceful shutdown: wineserver -k for the bottle
    if (winePath && bottlePath && fs.existsSync(bottlePath)) {
      try { killWineserver(winePath, bottlePath) } catch {}
    }

    // 3. SIGKILL the tracked game process
    if (gameProcess) {
      try { gameProcess.kill('SIGKILL') } catch {}
      gameProcess = null
    }

    // 4. SIGKILL the tracked Steam process
    if (steamPid) {
      try { process.kill(steamPid, 'SIGKILL') } catch {}
      steamPid = null
    }

    // 5. Kill any remaining wine/steam child processes so they don't
    //    keep file handles open that prevent Electron from exiting cleanly.
    try { execSync('pkill -9 -f "wineserver|wine64|wine-preloader|steamwebhelper|winedevice"', { stdio:'ignore', timeout:3000 }) } catch {}
  } catch {}
})

// ── Discord RPC (native Electron implementation — bypasses Wine bridge) ────────
// Implements the Discord IPC protocol directly using Node's net module.
// This avoids the wine-discord-ipc-bridge entirely, which is unreliable on
// CrossOver / macOS. The protocol is: connect to Discord's Unix socket,
// send a handshake frame, wait for READY, then send SET_ACTIVITY.
//
// Frame layout: [opcode: uint32LE][length: uint32LE][json payload]
// Opcodes: 0 = Handshake, 1 = Frame, 2 = Close

const DISCORD_CLIENT_ID = '759681901585498113'

let _rpcSocket    = null
let _rpcInterval  = null
let _rpcStartTime = null
let _rpcState     = 'logging_in'   // 'logging_in' | 'in_game'
let _rpcPid       = 0
let _rpcCustom    = {}             // user-defined RPC text overrides
let _rpcRelayServers = []          // Unix socket relay servers
let _rpcSimulation = null          // detected simulation number (e.g. "1") or null
let _chatWatchTimer = null         // interval handle for chat-log polling
let _chatWatchOffset = 0           // byte offset already read in current chat log
let _chatWatchPath  = null         // path to the chat log being watched
let _chatWatchMinTimeMs = null     // ms-since-midnight cutoff: ignore older lines

// ── Reconnect / AFK / Telemetry state ────────────────────────────────────────
// Reconnect retries every 20s indefinitely while the game is still running and
// the user has the toggle on. The "give up after N tries" behaviour was
// removed because in practice Discord recovers within a few attempts but the
// game session may legitimately last hours.
const RPC_RECONNECT_INTERVAL_MS = 20000   // 20s between reconnect attempts
let _rpcReconnectEnabled  = true          // mirror of settings.rpcAutoReconnect
let _rpcReconnectAttempts = 0             // pure counter, no upper bound
let _rpcReconnectTimer    = null
let _rpcConnArgs          = null          // saved args for retrying connect
let _rpcStatus            = { connection:'disconnected', reconnect:{ attempt:0 }, afk:false, telemetry:{ ok:false, reason:'off' } }
let _watchersPaused       = false         // set true while window is blurred + pauseRefreshOnFocus is on

let _afkEnabled    = true
let _afkMinutes    = 5
let _afkTimer      = null
let _lastChatMtimeMs = 0
let _lastChatMtimeSeenAt = 0

let _telemetryEnabled = false
let _telemetryPath    = ''           // file path or http URL
let _telemetryTimer   = null
let _telemetryData    = null          // last parsed { truck, city, cargo }
let _rpcAdvanced      = false         // master switch for Driving/Near/route overlay

// ── Helpers ───────────────────────────────────────────────────────────────────

function _discordSocketPath() {
  // IMPORTANT: do NOT look in /tmp — that's where our relay proxies live.
  // We must find Discord's real socket in the macOS user temp hierarchy.
  const dirs = [os.tmpdir(), process.env.TMPDIR].filter(Boolean)
  const seen = new Set()
  for (const d of dirs) {
    if (d === '/tmp') continue   // skip /tmp — that's our relay layer
    if (seen.has(d)) continue
    seen.add(d)
    for (let i = 0; i < 10; i++) {
      const p = path.join(d, `discord-ipc-${i}`)
      try { if (fs.existsSync(p)) return p } catch {}
    }
  }
  // Broad fallback — search /var/folders (macOS user temp hierarchy)
  try {
    const { execSync: ex } = require('child_process')
    const r = ex('find /var/folders -maxdepth 4 -name "discord-ipc-0" 2>/dev/null',
                 { encoding:'utf8', timeout:3000 }).trim()
    if (r) return r.split('\n')[0]
  } catch {}
  return null
}

function _writeFrame(socket, opcode, payload) {
  const json = JSON.stringify(payload)
  const len  = Buffer.byteLength(json)
  const buf  = Buffer.alloc(8 + len)
  buf.writeUInt32LE(opcode, 0)
  buf.writeUInt32LE(len,    4)
  buf.write(json, 8)
  try { socket.write(buf) } catch {}
}

function _buildActivity(pid) {
  const c = _rpcCustom || {}
  let details = _rpcState === 'logging_in'
    ? (c.detailsLogin || 'Logging in')
    : (c.detailsGame  || 'In Game')
  // When in-game and we have detected a simulation number from the chat log,
  // surface it as the state line (e.g. "Simulation 1"). Otherwise use the
  // user-customised state, falling back to "Euro Truck Simulator 2".
  let state = c.state || 'Euro Truck Simulator 2'
  if (_rpcState === 'in_game' && _rpcSimulation) {
    state = `Simulation ${_rpcSimulation}`
  }

  // ── Telemetry overlay (truck/city/cargo) ─────────────────────────────────
  // Only applied when "Enable Advanced RPC" is on. With it off, the activity
  // stays on the existing "In Game" / "Simulation N" lines even if a
  // telemetry source happens to be reachable.
  // The state line is RESERVED for "Simulation N" (when detected) so that
  // the simulation number stays visible in the big outside text. Any
  // telemetry location/cargo info gets moved to the large image tooltip.
  let largeTextOverride = null
  if (_rpcAdvanced && _rpcState === 'in_game' && _telemetryData) {
    const t = _telemetryData
    if (t.truck) details = `Driving ${t.truck}`
    if (t.sourceCity && t.destCity) {
      largeTextOverride = `${t.sourceCity} → ${t.destCity}`
      if (t.cargo) largeTextOverride += ` · ${t.cargo}`
    } else if (t.city) {
      largeTextOverride = `Near ${t.city}`
    }
    // If no simulation was detected yet, fall back to showing the location
    // info on the state line so it isn't lost.
    if (!_rpcSimulation && largeTextOverride) {
      state = largeTextOverride
      largeTextOverride = null
    }
  }

  // ── AFK overlay ──────────────────────────────────────────────────────────
  // When the chat log has been silent for too long, show an AFK indicator.
  if (_rpcState === 'in_game' && _rpcStatus.afk) {
    details = '💤 AFK in cab'
  }

  return {
    cmd:   'SET_ACTIVITY',
    nonce: Date.now().toString(),
    args: {
      pid,
      activity: {
        details,
        state,
        assets: {
          large_image: c.largeImage || 'truckersmp',
          large_text:  largeTextOverride || c.largeText || 'TruckersMP',
          // Small circular badge in the bottom-right of the large image.
          // The asset key must match an art asset uploaded to the Discord
          // application (Rich Presence → Art Assets). Default 'ets2' — users
          // should upload an Euro Truck Simulator 2 logo with that key.
          small_image: c.smallImage || 'ets2',
          small_text:  c.smallText  || 'Playing Euro Truck Simulator 2'
        },
        timestamps: { start: _rpcStartTime }
      }
    }
  }
}

// Push the current RPC subsystem status to the renderer so the Settings
// panel can show live indicators (Connected / Reconnecting 1/3 / AFK / etc).
function _pushRpcStatus(patch) {
  if (patch) {
    if (patch.connection !== undefined) _rpcStatus.connection = patch.connection
    if (patch.reconnect)                _rpcStatus.reconnect  = { ..._rpcStatus.reconnect, ...patch.reconnect }
    if (patch.afk !== undefined)        _rpcStatus.afk        = patch.afk
    if (patch.telemetry)                _rpcStatus.telemetry  = { ..._rpcStatus.telemetry, ...patch.telemetry }
  }
  try { mainWindow?.webContents.send('rpc:status', _rpcStatus) } catch {}
}

// Re-send current activity to Discord immediately (used after AFK/telemetry
// state changes so the user doesn't have to wait up to 15s for the next
// keep-alive frame).
function _refreshDiscordActivity() {
  if (_rpcSocket) {
    try { _writeFrame(_rpcSocket, 1, _buildActivity(_rpcPid)) } catch {}
  }
}

// ── ETS2MP chat-log watcher ───────────────────────────────────────────────────
// Locates the newest chat log inside the CrossOver bottle's
// Documents/ETS2MP/logs/ directory and polls it for a "Connected to
// simulation N" line. As soon as that line is seen, the RPC state is
// flipped to "in_game" with "Simulation N" as the state line, and the
// watcher shuts itself down — it is a one-shot detector by design so it
// doesn't keep re-reading the file as it grows.

// Resolve the ETS2MP logs directory.
//   1. Honour an explicit user-set path (settings.ets2mpLogsDir) first.
//   2. Otherwise scan the standard macOS Documents locations — ETS2MP on
//      macOS writes its logs to the host's Documents folder, NOT inside
//      the CrossOver bottle (the mod talks to the host filesystem via
//      Wine's Z: drive mapping).
function _autoDetectEts2mpLogsDir() {
  const home = os.homedir()
  const candidates = [
    path.join(home, 'Documents', 'ETS2MP', 'logs'),
    path.join(home, 'Documents', 'ETS2MP'),                 // logs may live at root
    path.join(home, 'Documents', 'Euro Truck Simulator 2', 'ETS2MP', 'logs'),
    // iCloud Drive Documents, in case the user has Desktop & Documents synced
    path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents', 'ETS2MP', 'logs'),
  ]
  for (const p of candidates) {
    try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p } catch {}
  }
  return null
}

function _resolveEts2mpLogsDir(userPath) {
  if (userPath) {
    try { if (fs.existsSync(userPath) && fs.statSync(userPath).isDirectory()) return userPath } catch {}
  }
  return _autoDetectEts2mpLogsDir()
}

// Build today's expected chat-log filename stem.
// ETS2MP names its chat logs like:  chat_2026_04_23.log  (or similar variants)
// We match anything that contains the YYYY_MM_DD or YYYY-MM-DD stamp for today.
function _todaysChatLogPatterns() {
  const d = new Date()
  const y  = d.getFullYear()
  const m  = String(d.getMonth() + 1).padStart(2, '0')
  const dy = String(d.getDate()).padStart(2, '0')
  // Accept underscores OR dashes between the date parts, just in case.
  return [
    new RegExp(`chat[_-]?${y}[_-]${m}[_-]${dy}`, 'i'),
    new RegExp(`chat.*${y}.${m}.${dy}`, 'i'),
  ]
}

function _findTodaysChatLog(logsDir) {
  const pats = _todaysChatLogPatterns()
  try {
    const files = fs.readdirSync(logsDir)
      .filter(f => /chat/i.test(f))
      .filter(f => pats.some(p => p.test(f)))
      .map(f => {
        const full = path.join(logsDir, f)
        try { return { full, mtime: fs.statSync(full).mtimeMs } }
        catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
    return files.length ? files[0].full : null
  } catch { return null }
}

function _findNewestChatLog(logsDir) {
  try {
    const files = fs.readdirSync(logsDir)
      .filter(f => /chat/i.test(f) && /\.log$/i.test(f))
      .map(f => {
        const full = path.join(logsDir, f)
        try { return { full, mtime: fs.statSync(full).mtimeMs } }
        catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
    return files.length ? files[0].full : null
  } catch { return null }
}

function _stopChatLogWatcher() {
  if (_chatWatchTimer) { clearInterval(_chatWatchTimer); _chatWatchTimer = null }
  _chatWatchPath = null
  _chatWatchOffset = 0
}

// Scan a chat log for the relevant connection markers.
// Returns the simulation number if found, otherwise null.
//   • "Connected to simulation N"
//   • "Connection established" + nearby "Simulation N"
// Scan a chat log for a "Connected to simulation N" marker.
// `minTimeMs` (optional) is a wall-clock cutoff in ms-since-midnight; lines
// whose in-file `[HH:MM:SS]` timestamp is older than the cutoff are ignored.
// This stops the watcher from picking up old session lines that just happen
// to be in today's log file because we polled it earlier in the day.
// Scan a chat log for a successful TruckersMP connection.
//
// Real ETS2MP chat-log sequence looks like:
//   [Global] [19:55:20] Connecting to Simulation 1 server...
//   [Global] [19:55:22] Connection established (position in queue: 11).
//   [Global] [19:55:25] Connection established!         ← actually in-game
//
// We trigger on the bare "Connection established!" line (the one WITHOUT
// the "(position in queue: …)" suffix — that one means we're past the
// queue and actually in the world), then walk backwards to find the most
// recent "Connecting to Simulation N server" line for the sim number.
//
// `minTimeMs` is a wall-clock cutoff (ms-since-midnight); the
// established-line must be at or after it. This keeps old session lines
// in today's log from being matched.
//
// Returns { simulation, established, connecting } on success, or a
// diagnostic object describing what was / wasn't seen.
function _scanChatLogForSimulation(filePath, minTimeMs) {
  let text = ''
  try { text = fs.readFileSync(filePath, 'utf8') }
  catch (e) { return { ok:false, reason:'read-error', error:e.message } }

  const lineTimeMs = (line) => {
    const m = line.match(/\[(\d{2}):(\d{2}):(\d{2})\]/)
    if (!m) return null
    return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000
  }

  const lines = text.split(/\r?\n/)

  // Find the most recent fresh "Connection established!" (no "queue") line.
  let estIdx = -1, estLine = null, estTime = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!/connection established\s*!/i.test(line)) continue
    if (/queue/i.test(line)) continue            // skip the queue-position one
    const t = lineTimeMs(line)
    if (t == null) continue
    if (minTimeMs != null && t < minTimeMs) break  // older → and lines above
                                                   // are even older, give up
    estIdx = i; estLine = line; estTime = t
    break
  }
  if (estIdx === -1) {
    return { ok:false, reason:'no-established', lineCount: lines.length }
  }

  // Walk backwards from the established line to find "Connecting to
  // Simulation N server".
  for (let j = estIdx; j >= 0; j--) {
    const m = lines[j].match(/connecting to simulation\s+(\d+)\s+server/i)
    if (m) {
      return {
        ok:true,
        simulation: m[1],
        established: estLine.trim(),
        connecting:  lines[j].trim(),
      }
    }
  }
  return { ok:false, reason:'no-connecting', established: estLine.trim() }
}

// Wall-clock ms-since-midnight for "now" (local time).
function _msSinceMidnightNow() {
  const d = new Date()
  return ((d.getHours() * 3600) + (d.getMinutes() * 60) + d.getSeconds()) * 1000
}

// ── Force-watch (manual) ─────────────────────────────────────────────────────
// Triggered by the "Force Watch Chat Log" button in the UI. Polls every 5s
// for today's chat log file (chat_YYYY_MM_DD…) inside the resolved logs dir.
// On match, scans the file for "Connected to simulation N" or
// "Connection established" + "Simulation N", updates the Discord activity
// once, then stops itself.
let _forceWatchTimer = null

function _stopForceWatch() {
  if (_forceWatchTimer) { clearInterval(_forceWatchTimer); _forceWatchTimer = null }
}

// One-shot immediate scan triggered by the "Force Watch Chat Log" button.
// Scans NOW. The regular 5s background watcher keeps running independently
// so the user doesn't have to click again — this is purely a "scan right now"
// shortcut. Returns a result object the renderer can show to the user.
function _runForceScan(userLogsDir, logFn) {
  const logsDir = _resolveEts2mpLogsDir(userLogsDir)
  if (!logsDir) {
    logFn('warn', 'Force scan: ETS2MP logs folder not set — open Settings and pick it.')
    return { state:'no-folder' }
  }
  const todays = _findTodaysChatLog(logsDir)
  if (!todays) {
    logFn('info', `Force scan: today's chat log not found in ${logsDir} (auto-scanner will keep retrying every 5s).`)
    return { state:'no-file', logsDir }
  }
  // Manual scan: no time cutoff — user explicitly asked us to look NOW.
  const r = _scanChatLogForSimulation(todays, null)
  const fname = path.basename(todays)
  if (!r.ok) {
    if (r.reason === 'no-established') {
      logFn('info', `Force scan: ${fname} has no "Connection established!" line at all yet (${r.lineCount} lines scanned).`)
    } else if (r.reason === 'no-connecting') {
      logFn('warn', `Force scan: ${fname} has "${r.established}" but no "Connecting to Simulation N server" line above — sim number unknown.`)
    } else {
      logFn('warn', `Force scan: ${fname} read error: ${r.error}`)
    }
    return { state:'no-marker', file: fname }
  }
  _rpcSimulation = r.simulation
  _rpcState = 'in_game'
  logFn('success', `Force scan: detected Simulation ${r.simulation} in ${fname}`)
  logFn('success', `  → ${r.connecting}`)
  logFn('success', `  → ${r.established}`)
  if (_rpcSocket) _writeFrame(_rpcSocket, 1, _buildActivity(_rpcPid))
  _stopChatLogWatcher()   // we're done — stop the background auto-scanner
  return { state:'found', simulation: r.simulation, file: fname }
}

function _startChatLogWatcher(userLogsDir, logFn) {
  _stopChatLogWatcher()
  // If we already detected a simulation in this session, don't start a fresh
  // watcher — there's nothing left to find. Prevents the watcher from polling
  // for hours after the user is already in-game.
  if (_rpcSimulation) {
    logFn('info', `Chat watcher: Simulation ${_rpcSimulation} already detected — watcher not started.`)
    return
  }
  const logsDir = _resolveEts2mpLogsDir(userLogsDir)
  if (!logsDir) {
    logFn('warn', 'Chat-log watcher: ETS2MP logs folder not found in Documents.')
    logFn('warn', '  → Set the path in Settings → ETS2MP Logs Folder, then relaunch.')
    // Ask the renderer to prompt the user to pick the folder.
    try { mainWindow?.webContents.send('ets2mp:needsLogsDir') } catch {}
    return
  }
  _chatWatchMinTimeMs = _msSinceMidnightNow()
  const startClock = new Date().toLocaleTimeString()
  logFn('info', `Chat watcher: starting in ${logsDir}`)
  logFn('info', `Chat watcher: looking for "Connection established!" lines newer than ${startClock} (and "Connecting to Simulation N server" above each one for the sim number).`)
  logFn('info', `Chat watcher: ticking every 5s — will stop on first match.`)

  _chatWatchTimer = setInterval(() => {
    if (!_rpcSocket) { _stopChatLogWatcher(); return }

    const file = _findTodaysChatLog(logsDir) || _findNewestChatLog(logsDir)
    if (!file) {
      logFn('info', `Chat watcher: tick → cutoff=${startClock}, no chat_*.log file in ${logsDir} yet.`)
      return
    }
    const fname = path.basename(file)
    const r = _scanChatLogForSimulation(file, _chatWatchMinTimeMs)
    if (r.ok) {
      _rpcSimulation = r.simulation
      _rpcState = 'in_game'
      logFn('success', `Chat watcher: MATCH in ${fname}`)
      logFn('success', `  → ${r.connecting}`)
      logFn('success', `  → ${r.established}`)
      logFn('success', `Switching Discord RPC to "In Game · Simulation ${r.simulation}" and stopping watcher.`)
      if (_rpcSocket) _writeFrame(_rpcSocket, 1, _buildActivity(_rpcPid))
      _stopChatLogWatcher()
      return
    }
    // Not matched — explain WHY in plain English so the user can see what
    // the watcher is actually doing each tick.
    if (r.reason === 'read-error') {
      logFn('warn', `Chat watcher: tick → file=${fname}, cutoff=${startClock}, READ ERROR: ${r.error}`)
    } else if (r.reason === 'no-established') {
      logFn('info', `Chat watcher: tick → file=${fname}, cutoff=${startClock}, scanned ${r.lineCount} lines, no fresh "Connection established!" line yet.`)
    } else if (r.reason === 'no-connecting') {
      logFn('warn', `Chat watcher: tick → file=${fname}, cutoff=${startClock}, saw "${r.established}" but no "Connecting to Simulation N server" line above it — sim number unknown.`)
    } else {
      logFn('info', `Chat watcher: tick → file=${fname}, cutoff=${startClock}, no match.`)
    }
  }, 5000)
}

// ── Relay proxy ───────────────────────────────────────────────────────────────
// Creates a Unix socket server at /tmp/discord-ipc-N that the wine-discord-ipc-
// bridge (running inside CrossOver) can connect to. Each incoming Wine connection
// is bridged to Discord's real socket in $TMPDIR, forwarding all bytes verbatim.
// This gives the game full dynamic RPC (location, truck name, etc.) because the
// TruckersMP mod's own data flows straight through to Discord.

function _startRelayProxies(logFn) {
  const realSocket = _discordSocketPath()
  if (!realSocket) return

  for (let i = 0; i < 10; i++) {
    const proxyPath = `/tmp/discord-ipc-${i}`
    // Remove stale file/symlink at that path
    try { fs.unlinkSync(proxyPath) } catch {}

    const server = require('net').createServer(wineConn => {
      // A Wine process connected — open a matching connection to real Discord
      const discordConn = net.createConnection(realSocket)
      wineConn.pipe(discordConn)
      discordConn.pipe(wineConn)
      wineConn.on('error', () => discordConn.destroy())
      discordConn.on('error', () => wineConn.destroy())
    })

    server.on('error', () => {})   // ignore EADDRINUSE etc silently
    server.listen(proxyPath, () => {
      logFn('info', `Discord RPC: Relay proxy listening on /tmp/discord-ipc-${i}`)
    })
    _rpcRelayServers.push(server)
  }
}

function _stopRelayProxies() {
  for (const s of _rpcRelayServers) {
    try { s.close() } catch {}
  }
  _rpcRelayServers = []
  for (let i = 0; i < 10; i++) {
    try { fs.unlinkSync(`/tmp/discord-ipc-${i}`) } catch {}
  }
}

// ── Electron-native fallback RPC ─────────────────────────────────────────────
// Used when the Wine bridge doesn't send any data (e.g. single-player or bridge
// failure). Shows "Logging in" → "In Game" transitions driven by elapsed time.

// Returns true while the launched truckersmp-cli process is still alive.
// Used to decide whether to keep retrying Discord reconnects.
function _gameStillRunning() { return !!gameProcess }

// Open the Unix socket to Discord. Extracted from startDiscordRPC so the
// reconnect timer can re-enter without re-running one-time setup (relay
// proxies, start time, etc).
function _connectDiscordSocket() {
  if (_rpcSocket || !_rpcConnArgs) return
  const { logFn, clientId, ets2mpLogsDir } = _rpcConnArgs

  const socketPath = _discordSocketPath()
  if (!socketPath) {
    logFn('warn', 'Discord RPC: Discord not found — make sure Discord is open.')
    _pushRpcStatus({ connection:'disconnected' })
    if (_rpcReconnectEnabled && _gameStillRunning()) _scheduleReconnect('discord-not-found')
    return
  }

  logFn('info', `Discord RPC: Using Client ID ${clientId}`)
  _pushRpcStatus({ connection:'connecting' })
  const socket = net.createConnection(socketPath)
  _rpcSocket = socket

  socket.on('connect', () => {
    logFn('info', 'Discord RPC: Connected to Discord.')
    _writeFrame(socket, 0, { v: 1, client_id: clientId })
  })

  let buf = Buffer.alloc(0)
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 8) {
      const op  = buf.readUInt32LE(0)
      const len = buf.readUInt32LE(4)
      if (buf.length < 8 + len) break
      const raw = buf.slice(8, 8 + len).toString()
      buf = buf.slice(8 + len)

      let payload = {}
      try { payload = JSON.parse(raw) } catch (e) {
        logFn('warn', `Discord RPC: JSON parse error — ${e.message}`)
        continue
      }

      // Log meaningful frames only. Discord echoes back a SET_ACTIVITY
      // frame after every keep-alive (every 15s) — those are noise and were
      // spamming the log viewer, so we suppress them.
      if (payload.cmd !== 'SET_ACTIVITY') {
        logFn('info', `Discord RPC: frame op=${op} cmd=${payload.cmd} evt=${payload.evt || '-'}`)
      }

      if (payload.evt === 'READY') {
        logFn('info', 'Discord RPC: Ready — showing "Logging in".')
        // Successful handshake → reset the reconnect counter and clear any
        // pending retry timer. From the user's perspective we're back online.
        _rpcReconnectAttempts = 0
        if (_rpcReconnectTimer) { clearTimeout(_rpcReconnectTimer); _rpcReconnectTimer = null }
        _pushRpcStatus({ connection:'connected', reconnect:{ attempt:0 } })

        _writeFrame(socket, 1, _buildActivity(_rpcPid))

        // Instead of a dumb 90s timer, watch the ETS2MP chat log for
        // "Connected to simulation N". Until then, RPC stays on "Logging in".
        // Once detected, the watcher flips state to "In Game" and stops itself.
        _startChatLogWatcher(ets2mpLogsDir, logFn)

        // Defensive: clear any prior keep-alive in case READY fires twice
        if (_rpcInterval) { clearInterval(_rpcInterval); _rpcInterval = null }
        _rpcInterval = setInterval(() => {
          if (!_rpcSocket) { clearInterval(_rpcInterval); _rpcInterval = null; return }
          _writeFrame(socket, 1, _buildActivity(_rpcPid))
        }, 15000)
      }
      if (payload.evt === 'ERROR') {
        logFn('warn', `Discord RPC: Discord error — code=${payload.data?.code} msg=${payload.data?.message}`)
      }
    }
  })

  socket.on('error', e => {
    logFn('warn', `Discord RPC: socket error — ${e.message}`)
    _rpcSocket = null
  })
  socket.on('close', hadErr => {
    logFn('info', `Discord RPC: socket closed (hadError=${hadErr})`)
    _rpcSocket = null
    if (_rpcInterval) { clearInterval(_rpcInterval); _rpcInterval = null }
    _stopChatLogWatcher()
    _pushRpcStatus({ connection:'disconnected' })
    if (_rpcReconnectEnabled && _gameStillRunning()) _scheduleReconnect('socket-close')
  })
}

// Schedule a reconnect attempt 20s in the future. Retries indefinitely while
// the game is still running and the user has auto-reconnect enabled — the
// previous "give up after 3 tries" cap was removed per user request.
function _scheduleReconnect(reason) {
  if (_rpcReconnectTimer || !_rpcConnArgs) return
  _rpcReconnectAttempts += 1
  const n = _rpcReconnectAttempts
  _rpcConnArgs.logFn('info',
    `Discord RPC: reconnecting in ${RPC_RECONNECT_INTERVAL_MS/1000}s ` +
    `(attempt ${n}, reason=${reason})…`)
  _pushRpcStatus({ connection:'reconnecting', reconnect:{ attempt:n } })
  _rpcReconnectTimer = setTimeout(() => {
    _rpcReconnectTimer = null
    if (!_gameStillRunning() || !_rpcReconnectEnabled) return
    _connectDiscordSocket()
  }, RPC_RECONNECT_INTERVAL_MS)
}

function startDiscordRPC(pid, logFn, clientId, rpcCustom, ets2mpLogsDir, opts) {
  if (_rpcSocket) return
  _rpcCustom = rpcCustom || {}
  _rpcSimulation = null
  _telemetryData = null
  _rpcStatus.afk = false
  _rpcAdvanced          = !!opts?.advanced
  _rpcReconnectEnabled  = opts?.autoReconnect !== false
  _rpcReconnectAttempts = 0
  if (_rpcReconnectTimer) { clearTimeout(_rpcReconnectTimer); _rpcReconnectTimer = null }

  if (!clientId || clientId.length < 10) {
    logFn('warn', 'Discord RPC: No valid Client ID set.')
    logFn('warn', '  → Go to Settings → Discord Application ID and enter your Discord app\'s Client ID.')
    logFn('warn', '  → Create one free at https://discord.com/developers/applications')
    _startRelayProxies(logFn)   // still start relay so Wine bridge works if it connects
    return
  }
  _rpcState     = 'logging_in'
  _rpcStartTime = Math.floor(Date.now() / 1000)
  _rpcPid       = pid || process.pid
  _rpcConnArgs  = { logFn, clientId, ets2mpLogsDir }
  // Remember the args so we can re-spin the watchers when the user refocuses
  // the launcher window (after pausing on blur).
  _watcherArgs  = { ets2mpLogsDir, opts, logFn }

  // Start relay proxies first so the Wine bridge can connect immediately
  _startRelayProxies(logFn)

  // Kick off the optional AFK + telemetry watchers (they self-skip when
  // disabled in opts). They're independent of the Discord socket so they
  // can keep running across reconnects.
  _startAfkWatcher(opts, logFn)
  _startTelemetryWatcher(opts, logFn)

  _connectDiscordSocket()
}

// ── Watcher pause / resume (driven by window focus) ─────────────────────────
// Stops the chat-log scanner, AFK detector and telemetry poller when the
// launcher window is blurred (and the user opted in via Settings → "Pause
// data refresh when app is not focused"). Restarts whichever were live as
// soon as the window regains focus. Discord RPC itself stays connected.
let _watcherArgs       = null    // saved (ets2mpLogsDir, opts, logFn) for resume
let _pauseOnBlurEnabled = true   // mirror of settings.refreshOnFocus

function _pauseWatchers(reason) {
  if (_watchersPaused) return
  _watchersPaused = true
  // NOTE: the chat-log watcher is intentionally NOT paused on blur. It is a
  // one-shot detector that stops itself the moment it finds the simulation
  // number, so leaving it alive in the background while the launcher window
  // is hidden lets the RPC pick up "Simulation N" the first time the user
  // reaches it, even if they tab away from the launcher right after launch.
  _stopAfkWatcher()
  _stopTelemetryWatcher()
  if (_watcherArgs?.logFn) _watcherArgs.logFn('info', `Watchers paused (${reason}) — chat watcher kept alive.`)
}

function _resumeWatchers(reason) {
  if (!_watchersPaused) return
  _watchersPaused = false
  if (!_watcherArgs || !_gameStillRunning()) return
  const { opts, logFn } = _watcherArgs
  logFn('info', `Watchers resumed (${reason}).`)
  // Chat watcher was never stopped — nothing to restart for it.
  _startAfkWatcher(opts, logFn)
  _startTelemetryWatcher(opts, logFn)
}

function _onWindowBlur()  { if (_pauseOnBlurEnabled) _pauseWatchers('window blurred') }
function _onWindowFocus() { if (_pauseOnBlurEnabled) _resumeWatchers('window focused') }

// ── AFK watcher ─────────────────────────────────────────────────────────────
// Polls the today's chat log file's mtime once per minute. If the mtime
// hasn't changed in `afkMinutes` minutes, flip the AFK overlay on; flip
// it off again as soon as activity returns. Cheap — only one stat() call
// per tick, no full file read.
function _stopAfkWatcher() {
  if (_afkTimer) { clearInterval(_afkTimer); _afkTimer = null }
}

function _startAfkWatcher(opts, logFn) {
  _stopAfkWatcher()
  _afkEnabled = opts?.afkEnabled !== false
  _afkMinutes = Math.max(1, Number(opts?.afkMinutes) || 5)
  if (!_afkEnabled) return

  const ets2mpLogsDir = opts?.ets2mpLogsDir
  _lastChatMtimeMs     = 0
  _lastChatMtimeSeenAt = Date.now()

  _afkTimer = setInterval(() => {
    if (!_rpcSocket) return
    const dir = _resolveEts2mpLogsDir(ets2mpLogsDir)
    if (!dir) return
    const file = _findTodaysChatLog(dir) || _findNewestChatLog(dir)
    if (!file) return
    let mtime = 0
    try { mtime = fs.statSync(file).mtimeMs } catch { return }
    const now = Date.now()
    if (mtime !== _lastChatMtimeMs) {
      _lastChatMtimeMs     = mtime
      _lastChatMtimeSeenAt = now
      if (_rpcStatus.afk) {
        _rpcStatus.afk = false
        logFn('info', `AFK watcher: chat activity returned — clearing AFK status.`)
        _pushRpcStatus({ afk:false })
        _refreshDiscordActivity()
      }
      return
    }
    const idleMin = (now - _lastChatMtimeSeenAt) / 60000
    if (!_rpcStatus.afk && idleMin >= _afkMinutes && _rpcState === 'in_game') {
      _rpcStatus.afk = true
      logFn('info', `AFK watcher: ${idleMin.toFixed(1)} min of chat silence — flipping to AFK.`)
      _pushRpcStatus({ afk:true })
      _refreshDiscordActivity()
    }
  }, 60000)
}

// ── Telemetry watcher (truck / city / cargo) ────────────────────────────────
// Reads truck and route info from a user-supplied source every 10s. The
// source can be either a local JSON file path or an http(s) URL — pretty
// much any ETS2 telemetry plugin can be pointed here (e.g. Funbit's
// telemetry-server returns JSON at http://localhost:25555/api/ets2/telemetry).
//
// Schema we look for (we are forgiving — only the fields we recognise are
// used, everything else is ignored):
//   truck: { make / brandName, model / name }            → "Driving X Y"
//   job:   { sourceCity, destinationCity, cargo }        → "City A → City B · Cargo"
//   placement / navigation.city                          → fallback "Near X"
function _stopTelemetryWatcher() {
  if (_telemetryTimer) { clearInterval(_telemetryTimer); _telemetryTimer = null }
}

function _normaliseTelemetry(json) {
  if (!json || typeof json !== 'object') return null
  const t = {}
  const truck = json.truck || json.Truck || {}
  const make  = truck.make || truck.brandName || truck.brand || truck.Brand
  const model = truck.model || truck.name || truck.Name
  if (make || model) t.truck = [make, model].filter(Boolean).join(' ').trim()

  const job = json.job || json.Job || {}
  const src = job.sourceCity || job.SourceCity || job.source_city
  const dst = job.destinationCity || job.DestinationCity || job.destination_city
  const cargo = job.cargo || job.Cargo
  if (src) t.sourceCity = String(src)
  if (dst) t.destCity   = String(dst)
  if (cargo) t.cargo    = String(cargo)

  const nav = json.navigation || json.Navigation || {}
  const city = nav.city || json.city || json.City
  if (city) t.city = String(city)
  return Object.keys(t).length ? t : null
}

function _readTelemetrySource(src, cb) {
  if (!src) return cb({ ok:false, reason:'no-source' })
  if (/^https?:\/\//i.test(src)) {
    const lib = src.startsWith('https') ? https : require('http')
    try {
      const req = lib.get(src, { timeout:4000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return cb({ ok:false, reason:`http-${res.statusCode}` }) }
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try { cb({ ok:true, data: JSON.parse(data) }) }
          catch (e) { cb({ ok:false, reason:'parse-error', error:e.message }) }
        })
      })
      req.on('error',   e => cb({ ok:false, reason:'http-error', error:e.message }))
      req.on('timeout', () => { try { req.destroy() } catch {}; cb({ ok:false, reason:'timeout' }) })
    } catch (e) { cb({ ok:false, reason:'http-error', error:e.message }) }
  } else {
    try {
      if (!fs.existsSync(src)) return cb({ ok:false, reason:'file-missing' })
      const raw = fs.readFileSync(src, 'utf8')
      cb({ ok:true, data: JSON.parse(raw) })
    } catch (e) { cb({ ok:false, reason:'read-error', error:e.message }) }
  }
}

function _startTelemetryWatcher(opts, logFn) {
  _stopTelemetryWatcher()
  _telemetryEnabled = !!opts?.telemetryEnabled
  _telemetryPath    = (opts?.telemetryPath || '').trim()
  _telemetryData    = null

  // The truck/route overlay only renders when "Enable Advanced RPC" is on,
  // so don't bother polling a network endpoint otherwise.
  if (!_rpcAdvanced || !_telemetryEnabled) {
    _pushRpcStatus({ telemetry:{ ok:false, reason:'off' } })
    return
  }
  if (!_telemetryPath) {
    logFn('warn', 'Telemetry: enabled but no source path/URL set in Settings.')
    _pushRpcStatus({ telemetry:{ ok:false, reason:'no-source' } })
    return
  }

  let lastErrorReason = null
  const tick = () => {
    if (!_rpcSocket) return
    _readTelemetrySource(_telemetryPath, (res) => {
      if (!res.ok) {
        // Only log a given error reason once until it changes/recovers, so
        // we don't spam the log every 10s when a telemetry plugin is offline.
        if (res.reason !== lastErrorReason) {
          logFn('warn', `Telemetry: ${res.reason}${res.error ? ` (${res.error})` : ''}`)
          lastErrorReason = res.reason
        }
        if (_telemetryData) {
          _telemetryData = null
          _refreshDiscordActivity()
        }
        _pushRpcStatus({ telemetry:{ ok:false, reason: res.reason } })
        return
      }
      const t = _normaliseTelemetry(res.data)
      if (lastErrorReason) {
        logFn('success', `Telemetry: source recovered (${_telemetryPath}).`)
        lastErrorReason = null
      }
      // Only push to Discord when something we care about actually changed.
      const before = JSON.stringify(_telemetryData)
      _telemetryData = t
      _pushRpcStatus({ telemetry:{ ok:!!t, reason: t ? 'ok' : 'empty' } })
      if (JSON.stringify(_telemetryData) !== before) _refreshDiscordActivity()
    })
  }
  tick()                                // first poll immediately
  _telemetryTimer = setInterval(tick, 10000)
}

// Called when the game stops — tear down RPC and relay proxies
function stopDiscordRPC() {
  clearInterval(_rpcInterval)
  _rpcInterval = null
  _watcherArgs = null
  _watchersPaused = false
  _stopChatLogWatcher()
  _stopForceWatch()
  _stopAfkWatcher()
  _stopTelemetryWatcher()
  if (_rpcReconnectTimer) { clearTimeout(_rpcReconnectTimer); _rpcReconnectTimer = null }
  _rpcReconnectAttempts = 0
  _rpcConnArgs = null
  _rpcSimulation = null
  _telemetryData = null
  _rpcStatus.afk = false
  if (_rpcSocket) {
    const sock = _rpcSocket
    _rpcSocket = null
    // Send SET_ACTIVITY null to clear presence in Discord, then close after brief delay
    try {
      _writeFrame(sock, 1, {
        cmd: 'SET_ACTIVITY',
        args: { pid: _rpcPid, activity: null },
        nonce: Date.now().toString()
      })
    } catch {}
    setTimeout(() => {
      try { _writeFrame(sock, 2, {}); sock.destroy() } catch {}
    }, 400)
  }
  _stopRelayProxies()
  _pushRpcStatus({ connection:'disconnected', reconnect:{ attempt:0 }, afk:false, telemetry:{ ok:false, reason:'off' } })
}

// ── Discord RPC test (preview without launching game) ─────────────────────────
// Builds a *complete* preview activity including everything the live RPC
// would show: simulation number, truck, route, cargo and AFK overlay. Uses
// realistic placeholder data ("Volvo FH16 750", "Berlin → Hamburg · Furniture")
// so the user sees exactly what the production RPC will look like with all
// extras enabled. Duration is selectable (10 s / 20 s) via Settings.
// Pre-baked sample payloads used by the Test RPC button. Each one mirrors a
// real situation the live builder in `_buildActivity` can produce, so what the
// user sees in Discord during a test is what they'll see while playing.
//
// `smallText` doubles as the place we surface the server number — the live
// RPC also stuffs "Simulation N" into the badge so all three pieces (truck,
// server, route/near) are visible at once: details + state + badge tooltip.
const RPC_TEST_PRESETS = {
  driving_route: {
    label: 'Driving — full route',
    details: 'Driving Volvo FH16 750',
    state:   'Berlin → Hamburg · Furniture',
    smallText: 'Simulation 1 · Euro Truck Simulator 2'
  },
  driving_near: {
    label: 'Driving — near city',
    details: 'Driving Scania R730',
    state:   'Near Calais',
    smallText: 'Simulation 2 · Euro Truck Simulator 2'
  },
  in_game_idle: {
    label: 'In Game — no telemetry',
    details: 'In Game',
    state:   'Simulation 1',
    smallText: 'Playing Euro Truck Simulator 2'
  },
  afk_cab: {
    label: 'AFK in cab',
    details: '💤 AFK in cab',
    state:   'Near Rotterdam',
    smallText: 'Simulation 3 · Euro Truck Simulator 2'
  },
  logging_in: {
    label: 'Logging in',
    details: 'Logging in',
    state:   'Connecting to TruckersMP',
    smallText: 'Euro Truck Simulator 2'
  }
}

function testDiscordRPC(clientId, rpcCustom, durationSec, presetKey) {
  return new Promise(resolve => {
    if (!clientId || clientId.length < 10) {
      return resolve({ ok:false, error:'No Discord Application ID set. Add one in Settings first.' })
    }
    const socketPath = _discordSocketPath()
    if (!socketPath) {
      return resolve({ ok:false, error:'Discord not found — make sure Discord is open.' })
    }
    const c = rpcCustom || {}
    const dur = Math.max(5, Math.min(60, Number(durationSec) || 10))
    const pid = process.pid
    const startTime = Math.floor(Date.now() / 1000)

    // Pick the requested sample payload. Falls back to the full driving route
    // preset if the renderer sends an unknown key (forward-compat).
    const preset = RPC_TEST_PRESETS[presetKey] || RPC_TEST_PRESETS.driving_route
    const detailsLine = preset.details
    const stateLine   = preset.state
    const smallTextLn = preset.smallText

    let sock
    try { sock = net.createConnection(socketPath) } catch (e) {
      return resolve({ ok:false, error: e.message })
    }
    let done = false
    const finish = (result) => {
      if (done) return; done = true
      try { _writeFrame(sock, 2, {}); sock.destroy() } catch {}
      resolve(result)
    }
    const timeout = setTimeout(() => finish({ ok:false, error:'Timed out connecting to Discord.' }), 6000)
    sock.on('connect', () => {
      _writeFrame(sock, 0, { v:1, client_id: clientId })
    })
    let buf = Buffer.alloc(0)
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 8) {
        const op  = buf.readUInt32LE(0)
        const len = buf.readUInt32LE(4)
        if (buf.length < 8 + len) break
        const raw = buf.slice(8, 8 + len).toString()
        buf = buf.slice(8 + len)
        let payload = {}
        try { payload = JSON.parse(raw) } catch {}
        if (payload.evt === 'READY') {
          clearTimeout(timeout)
          _writeFrame(sock, 1, {
            cmd: 'SET_ACTIVITY', nonce: Date.now().toString(),
            args: { pid, activity: {
              details: detailsLine,
              state:   stateLine,
              assets: {
                large_image: c.largeImage || 'truckersmp',
                large_text:  c.largeText  || 'TruckersMP — preview',
                small_image: c.smallImage || 'ets2',
                small_text:  smallTextLn
              },
              timestamps: { start: startTime }
            }}
          })
          setTimeout(() => {
            try { _writeFrame(sock, 1, { cmd:'SET_ACTIVITY', nonce: Date.now().toString(), args:{ pid, activity:null } }) } catch {}
            setTimeout(() => finish({ ok:true, duration: dur }), 400)
          }, dur * 1000)
        }
        if (op === 2 || payload.evt === 'ERROR') {
          clearTimeout(timeout)
          finish({ ok:false, error:`Discord rejected the request (code=${payload.data?.code}, msg=${payload.data?.message})` })
        }
      }
    })
    sock.on('error', e => { clearTimeout(timeout); finish({ ok:false, error: e.message }) })
    sock.on('close', ()  => { clearTimeout(timeout); finish({ ok:false, error:'Connection closed.' }) })
  })
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('settings:load',    () => loadSettings())
ipcMain.handle('settings:save',    (_, s) => { saveSettings(s); return true })

ipcMain.handle('settings:delete', async () => {
  try {
    const dir = path.dirname(settingsPath)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  } catch(e) {
    return { ok: false, error: e.message }
  }
})
ipcMain.handle('settings:detect',  () => runAutoDetect())

// Auto-detect ETS2MP logs folder on demand. Returns the detected path or null.
ipcMain.handle('ets2mp:detectLogsDir', () => _autoDetectEts2mpLogsDir())

// Run an immediate one-shot scan for today's chat log. The background
// watcher independently scans every 5 seconds, so the user only needs
// this when they want a result NOW without waiting for the next tick.
ipcMain.handle('ets2mp:forceWatch', () => {
  const s = loadSettings()
  const sendLog = (kind, text) => {
    try { mainWindow?.webContents.send('log:line', { kind, text, cat:'launcher', ts:Date.now() }) } catch {}
  }
  const result = _runForceScan(s.ets2mpLogsDir, sendLog)
  return { ok:true, ...result }
})

// Open a folder picker for the user to point us at their ETS2MP logs folder.
// Persists the choice to settings.ets2mpLogsDir and returns the chosen path.
ipcMain.handle('ets2mp:pickLogsDir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your ETS2MP logs folder',
    defaultPath: path.join(os.homedir(), 'Documents'),
    properties: ['openDirectory']
  })
  if (canceled || !filePaths?.[0]) return { ok:false }
  const chosen = filePaths[0]
  try {
    const s = loadSettings()
    s.ets2mpLogsDir = chosen
    saveSettings(s)
  } catch {}
  return { ok:true, path: chosen }
})
ipcMain.handle('dialog:browse', async (_, opts={}) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: opts.folder ? ['openDirectory'] : ['openFile'],
    message: opts.message || 'Select',
    buttonLabel: 'Select',
    defaultPath: HOME
  })
  return canceled ? null : filePaths[0]
})

ipcMain.handle('fs:exists', (_, p) => fs.existsSync(p))

ipcMain.handle('shell:reveal', (_, p) => {
  if (p && fs.existsSync(p)) {
    require('electron').shell.showItemInFolder(p)
    return true
  }
  return false
})

// ── CLI Diagnostics ───────────────────────────────────────────────────────────

// ── Known runtime error patterns ─────────────────────────────────────────────
// Matched against each stderr line (lowercase). First match wins.
const RUNTIME_HINTS = [
  // ── Wine error 193 (Bad EXE format) ───────────────────────────────────────
  // On CrossOver 26 ARM the only wine binary is "wine" (no wine64).
  // Error 193 is caused by a win32 (32-bit) CrossOver bottle. ETS2 and
  // truckersmp-cli.exe are 64-bit — they require a win64 bottle.
  {
    pat:/bad exe format|0xc000007b|error.*193|193.*bad exe|exe format|module not found.*wine/i,
    hint:'Error 193 (Bad EXE format) — the CrossOver bottle is 32-bit (win32).\n' +
         'ETS2 and truckersmp-cli.exe are 64-bit programs and need a 64-bit bottle.\n\n' +
         'FIX:\n' +
         '  1. Open CrossOver → click the + button to create a new bottle\n' +
         '  2. Name it "ETS2" (or anything you like)\n' +
         '  3. Set Windows version to "Windows 10" — this creates a 64-bit (win64) bottle\n' +
         '  4. Inside the new bottle, install Steam (search CrossOver\'s app library for Steam)\n' +
         '  5. Open Steam inside CrossOver → install Euro Truck Simulator 2\n' +
         '  6. In this launcher → Settings → update Bottle, Steam Dir, and Game Dir\n' +
         '     to point to the new bottle\n\n' +
         'You can verify the bottle architecture: a win64 bottle has\n' +
         '  drive_c/windows/syswow64/   inside it. A win32 bottle does not.'
  },
  // Python / CLI issues
  { pat:/no module named/,           hint:'A required Python module is missing. Try: pip3 install truckersmp-cli --upgrade' },
  { pat:/importerror|modulenotfound/, hint:'Python dependency missing. Try: pip3 install truckersmp-cli --upgrade' },
  { pat:/permission denied/,         hint:'Permission error. Try: chmod +x "$(which truckersmp-cli)"' },
  { pat:/command not found/,         hint:'A required command was not found. Verify your PATH and CLI path in Settings.' },
  // Wine / mode-aware hints
  { pat:/wine.*not found|no wine/,   hint:'Wine binary not found. Check the Wine path in Settings.' },
  { pat:/wineserver/,                hint:'wineserver error — try restarting your Wine session or running Force Kill.' },
  { pat:/err:.*d3d|dxgi.*failed/,    hint:'DirectX/D3D error. Try switching the Graphics Translator in Settings.' },
  { pat:/err:.*opengl|vulkan/,       hint:'OpenGL/Vulkan error. Try a different Graphics Translator (D3DMetal or DXVK).' },
  // TruckersMP auth / network
  { pat:/authentication failed|auth error/, hint:'TruckersMP authentication failed. Make sure you are logged into Steam and your game is up to date.' },
  { pat:/connection refused|etimedout|econnreset/, hint:'Cannot reach TruckersMP servers. Check your internet connection and firewall.' },
  { pat:/ssl.*error|certificate/,    hint:'SSL/TLS error. Your system clock may be wrong, or a firewall is blocking the connection.' },
  { pat:/outdated|update required/,  hint:'Your TruckersMP client or game version is outdated. Update ETS2 and truckersmp-cli.' },
  // Steam
  { pat:/steam.*not found|steamclient/, hint:'Steam not found inside the bottle. Make sure Steam is installed and the Steam Directory is correct in Settings.' },
  // ETS2
  { pat:/game.*not found|ets2.*missing/, hint:'ETS2 not found. Verify the Game Directory path in Settings.' },
]

// ── Known exit codes ─────────────────────────────────────────────────────────
const EXIT_HINTS = {
  1:   'Generic error — see the log above for details.',
  2:   'Incorrect usage of the CLI — an argument may be wrong.',
  126: 'Permission denied — truckersmp-cli is not executable. Try: chmod +x <path>',
  127: 'Command not found — the truckersmp-cli path is wrong or the file was deleted.',
}

ipcMain.handle('game:launch', async (_, s) => {
  if (gameProcess) return { ok:false, error:'Game is already running.\n\nClick Stop Game first, or wait for the current session to end.' }

  // ── Pre-launch validation ──────────────────────────────────────────────────

  if (!s.cliPath) return { ok:false, error:
    'truckersmp-cli path is not set.\n\n' +
    'Fix: Open Settings → truckersmp-cli and set the path.\n\n' +
    'Install truckersmp-cli:\n' +
    '  pip3 install truckersmp-cli\n' +
    'Then click Re-detect in the sidebar.' }

  if (!fs.existsSync(s.cliPath)) return { ok:false, error:
    `truckersmp-cli not found at:\n  ${s.cliPath}\n\n` +
    'Why this happens:\n' +
    '  • truckersmp-cli was uninstalled or moved\n' +
    '  • The path in Settings is wrong\n' +
    '  • Python environment changed\n\n' +
    'Fix:\n' +
    '  pip3 install truckersmp-cli\n' +
    'Then click Re-detect in the sidebar, or browse to the correct path.' }

  try { fs.accessSync(s.cliPath, fs.constants.X_OK) } catch {
    return { ok:false, error:
      `truckersmp-cli exists but is not executable:\n  ${s.cliPath}\n\n` +
      'Fix — run this in Terminal:\n' +
      `  chmod +x "${s.cliPath}"` }
  }

  // ── Wine mode: standalone vs CrossOver ───────────────────────────────────────
  const isStandalone = s.wineMode === 'standalone'

  if (isStandalone) {
    // Standalone wine checks
    const swBin = standaloneWineBin()
    if (!swBin) return { ok:false, error:
      'Standalone Wine is not installed.\n\n' +
      'Fix: Open Settings → Wine Mode → Standalone Wine Setup Wizard and complete Step 1.' }
    const swBottle = s.standalonBottlePath
    if (!swBottle || !fs.existsSync(path.join(swBottle, 'drive_c'))) return { ok:false, error:
      'Standalone Wine bottle not found.\n\n' +
      'Fix: Complete the Standalone Wine Setup Wizard (Step 2 — Create Bottle).' }
    // Override wine + bottle paths for launch
    if (!s.standalonSteamDir) return { ok:false, error:
      'Standalone Steam Directory is not set.\n\n' +
      'Fix: Open Settings → Wine Mode → standalone paths, set the Steam folder inside your bottle.\n' +
      'Or complete the Setup Wizard Step 4.' }
    if (!s.standalonGameDir) return { ok:false, error:
      'Standalone ETS2 Game Directory is not set.\n\n' +
      'Fix: Open Settings → Wine Mode → standalone paths, set the ETS2 folder inside your bottle.\n' +
      'Or complete the Setup Wizard Step 4.' }
    s = { ...s, winePath: swBin, bottlePath: swBottle,
          steamDir: s.standalonSteamDir,
          gameDir:  s.standalonGameDir }
  } else {
    if (!s.winePath) return { ok:false, error:
      'CrossOver Wine path is not set.\n\n' +
      'Fix: Open Settings → Wine (CrossOver) and set the Wine binary path,\n' +
      'or click "Use detected CrossOver Wine" if CrossOver is installed.' }

    if (!fs.existsSync(s.winePath)) return { ok:false, error:
      `CrossOver Wine binary not found at:\n  ${s.winePath}\n\n` +
      'Why this happens:\n' +
      '  • CrossOver is not installed\n' +
      '  • CrossOver was updated and the binary moved\n' +
      '  • The path in Settings is wrong\n\n' +
      'Fix:\n' +
      '  1. Make sure CrossOver is installed in /Applications/CrossOver.app\n' +
      '  2. Click Re-detect in the sidebar\n' +
      '  3. Or browse to the wine binary manually in Settings → Wine.\n' +
      '     Typical CrossOver location: /Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine' }

    if (!s.bottlePath) return { ok:false, error:
      'CrossOver Bottle path is not set.\n\n' +
      'Fix: Open Settings → Wine (CrossOver) → CrossOver Bottle\n' +
      'and browse to your bottle folder.\n\n' +
      'Typical location:\n' +
      '  ~/Library/Application Support/CrossOver/Bottles/Steam' }

    if (!fs.existsSync(s.bottlePath)) return { ok:false, error:
      `CrossOver Bottle not found at:\n  ${s.bottlePath}\n\n` +
      'Why this happens:\n' +
      '  • The bottle was deleted or renamed in CrossOver\n' +
      '  • The path in Settings is wrong\n\n' +
      'Fix: Open CrossOver, check your bottles list, then update the path in Settings.' }
  }

  const bottleDriveC = path.join(s.bottlePath, 'drive_c')
  if (!isStandalone && !fs.existsSync(bottleDriveC)) return { ok:false, error:
    `The folder at:\n  ${s.bottlePath}\n` +
    'does not look like a valid Wine bottle (missing drive_c).\n\n' +
    'Fix: Browse to the correct bottle folder in Settings → Wine (CrossOver).\n' +
    'A valid CrossOver bottle has a "drive_c" folder inside it.' }

  if (!s.gameDir) return { ok:false, error:
    'ETS2 Game Directory is not set.\n\n' +
    'Fix: Open Settings → Game Directory and browse to your\n' +
    'Euro Truck Simulator 2 folder inside the CrossOver bottle.\n\n' +
    'Typical location inside the bottle:\n' +
    '  drive_c/Program Files (x86)/Steam/steamapps/common/Euro Truck Simulator 2' }

  if (!fs.existsSync(s.gameDir)) return { ok:false, error:
    `ETS2 Game Directory not found at:\n  ${s.gameDir}\n\n` +
    'Why this happens:\n' +
    '  • ETS2 is not installed in your CrossOver bottle\n' +
    '  • The path in Settings is wrong\n\n' +
    'Fix:\n' +
    '  1. Open CrossOver → Steam → install Euro Truck Simulator 2\n' +
    '  2. Then update the Game Directory path in Settings.' }

  // ── CLI sanity check — make sure it is NOT a wine binary ───────────────────
  // If the user accidentally sets the CLI path to a wine binary (e.g. wine64, wine,
  // wineserver) Python will try to execute the binary as a Python script and crash
  // with "SyntaxError: Non-UTF-8 code starting with '\xcf'".
  const cliBn = path.basename(s.cliPath).toLowerCase()
  if (['wine','wine64','wine-preloader','wineserver','wineloader','wineloader64'].includes(cliBn)) {
    return { ok:false, error:
      `The CLI Path points to a Wine binary (${path.basename(s.cliPath)}), not truckersmp-cli.\n\n` +
      'The "CLI Path" field must point to the truckersmp-cli Python script, not to Wine.\n\n' +
      'How to find truckersmp-cli:\n' +
      '  Run in Terminal:  which truckersmp-cli\n' +
      '  Or:               pip3 show -f truckersmp-cli | grep truckersmp-cli\n\n' +
      'Typical locations:\n' +
      '  ~/Library/Python/3.x/bin/truckersmp-cli\n' +
      '  /Library/Frameworks/Python.framework/Versions/3.x/bin/truckersmp-cli\n' +
      '  /usr/local/bin/truckersmp-cli\n\n' +
      'The Wine path (wine64) goes in Settings → Wine Path, not CLI Path.' }
  }

  // ── Wine binary check ─────────────────────────────────────────────────────
  // CrossOver 26 on Apple Silicon ships a single universal "wine" binary that
  // handles all Windows architectures internally — there is no separate wine64.
  // The wine binary itself is NOT the cause of error 193 on CrossOver 26.
  const effectiveWinePath = s.winePath
  // ── Bottle architecture check (CrossOver mode only) ───────────────────────
  // ERROR 193 (Bad EXE format) on CrossOver 26 ARM is caused by a WIN32 bottle.
  // Only meaningful for CrossOver mode — standalone bottles are always win64.
  if (!isStandalone && s.bottlePath) {
    const syswow64 = path.join(s.bottlePath, 'drive_c', 'windows', 'syswow64')
    const isWin64  = fs.existsSync(syswow64)
    if (!isWin64) {
      sendLog('warn', '══════════════════════════════════════')
      sendLog('warn', '⚠ BOTTLE IS 32-BIT (win32) — THIS IS THE CAUSE OF ERROR 193.')
      sendLog('warn', '  ETS2 and truckersmp-cli.exe are 64-bit Windows programs.')
      sendLog('warn', '  A win32 CrossOver bottle cannot run 64-bit executables.')
      sendLog('warn', '')
      sendLog('warn', '  FIX (required):')
      sendLog('warn', '  1. Open CrossOver → Create a new bottle')
      sendLog('warn', '  2. Set Windows version to "Windows 10" (64-bit)')
      sendLog('warn', '  3. Install Steam in the new bottle')
      sendLog('warn', '  4. Install Euro Truck Simulator 2 via Steam')
      sendLog('warn', '  5. Update Settings in this launcher to point to the new bottle')
      sendLog('warn', '══════════════════════════════════════')
    }
  }

  // Soft warning: check ETS2 executable exists
  const ets2exe = path.join(s.gameDir, 'bin', 'win_x64', 'eurotrucks2.exe')
  if (!fs.existsSync(ets2exe)) {
    sendLog('warn', `ETS2 executable not found at: ${ets2exe}`)
    sendLog('warn', isStandalone
      ? '  The game may not start. Make sure ETS2 is fully installed inside the bottle.'
      : '  The game may not start. Make sure ETS2 is fully installed inside your CrossOver bottle.')
  }

  // ── Build environment and args ─────────────────────────────────────────────
  const args = buildArgs(s)

  // For standalone wine, use standaloneWineEnv() so DYLD_FALLBACK_LIBRARY_PATH,
  // PATH (wine bin dir), and WINEESYNC are correctly set. Without these,
  // macOS cannot find winemetal.dylib and DXMT falls back to WGL/OpenGL.
  // All other wine spawns in this file already use standaloneWineEnv correctly.
  const env = isStandalone
    ? standaloneWineEnv(effectiveWinePath, s.bottlePath)
    : { ...process.env }
  env['WINE'] = effectiveWinePath
  if (!isStandalone && s.bottlePath) env['WINEPREFIX'] = s.bottlePath
  // standaloneWineEnv sets WINEPREFIX, WINEMSYNC, and WINEESYNC for standalone.
  // WINEESYNC stays in the game (Stage 2) env — it is only deleted for Steam (Stage 1).

  if (isStandalone) {
    // WINEMSYNC already set by standaloneWineEnv; only override WINEDEBUG.
    // NOTE: WINEESYNC is intentionally NOT set here — it is only safe in Stage 1
    // for Wine boot services. For the game process it is not needed (WINEMSYNC
    // handles sync on Apple Silicon) and can cause fd exhaustion if enabled.
    env['WINEDEBUG'] = '-all'
    const swDxmtDir = s.standalonDxmtDir
    if (swDxmtDir && fs.existsSync(path.join(swDxmtDir, 'dxgi.dll'))) {
      // Copy DLLs into the bottle's system32, and deploy winemetal if the archive
      // included one, so Wine's native-DLL lookup and Metal backend both work.
      ensureDxmtInBottle(s.bottlePath, swDxmtDir, null, effectiveWinePath)
      // Per DXMT guide (non-builtin): override dxgi, d3d11, d3d10core as native first
      env['WINEDLLOVERRIDES'] = 'dxgi=n,b;d3d11=n,b;d3d10core=n,b;d3d9=n,b;d3d10=n,b;d3d10_1=n,b'
      // DXMT active (DLLs deployed, overrides set)
    }
    // ── Stage 2 (game) extras — safe and correct here, NOT in Stage 1 (Steam) ──
    // Reduces wineserver CPU on Apple Silicon by disabling kernel write-watch emulation.
    // V8 is not present in ETS2, so the GetWriteWatch breakage does not apply here.
    env['WINE_DISABLE_KERNEL_WRITEWATCH'] = '1'
    // MoltenVK tuning for the game's Vulkan renderer.
    env['MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS'] = '1'
    env['MVK_CONFIG_USE_METAL_PRIVATE_API']      = '1'
  } else {
    // CrossOver: needs the bottle NAME via CX_BOTTLE
    if (s.bottlePath) env['CX_BOTTLE'] = path.basename(s.bottlePath)
  }

  // Metal HUD: user toggle wins
  env['MTL_HUD_ENABLED'] = s.metalHud ? '1' : '0'

  sendLog('system', '══════════════════════════════════════')
  sendLog('system', '  TruckersMP for macOS — ETS2 MP     ')
  sendLog('system', '══════════════════════════════════════')
  sendLog('system', `CLI:        ${s.cliPath}`)
  sendLog('system', `Wine:       ${effectiveWinePath}`)
  sendLog('system', `Bottle:     ${isStandalone ? (s.standalonBottlePath || '(not set)') : (s.bottlePath || '(not set)')}`)
  sendLog('system', `Game:       ${s.gameDir}`)
  sendLog('system', `Mode:       ${(s.launchMode||'macos').toUpperCase()}`)
  if (isStandalone) {
    const dxmtActive = !!(s.standalonDxmtDir && fs.existsSync(path.join(s.standalonDxmtDir, 'dxgi.dll')))
    sendLog('system', `Translator: DXMT (standalone WINEDLLOVERRIDES)${dxmtActive ? ' ✓' : ' — DXMT not installed, using Wine default'}`)
  }
  // Resolve Python interpreter — avoids ENOEXEC (-8) when Node can't exec the
  // Python script directly (shebang interpreter missing from expected path, etc.)
  const interp = resolveInterpreter(s.cliPath)
  let spawnCmd, spawnArgs
  if (interp) {
    spawnCmd  = interp
    spawnArgs = [s.cliPath, ...args]
    sendLog('system', `Python:     ${interp}`)
  } else {
    spawnCmd  = s.cliPath
    spawnArgs = args
    sendLog('system', 'Python:     (direct exec — no interpreter resolved)')
  }
  sendLog('system', `Args:       ${args.join(' ')}`)
  sendLog('system', '──────────────────────────────────────')

  try {
    gameProcess = spawn(spawnCmd, spawnArgs, { env })

    gameProcess.stdout.on('data', d =>
      String(d).split('\n').filter(l => l.trim()).forEach(l => sendLog('info', l, 'wine')))

    gameProcess.stderr.on('data', d =>
      String(d).split('\n').filter(l => l.trim()).forEach(l => {
        const low = l.toLowerCase()
        let kind = 'info'
        if (low.includes('error') || low.includes('fatal') || low.includes('exception')) kind = 'error'
        else if (low.includes('warn')) kind = 'warn'
        else if (low.includes('success') || low.includes('done') || low.includes('started')) kind = 'success'
        sendLog(kind, l, 'wine')
        // Append a contextual hint if we recognise the error
        if (kind === 'error' || kind === 'warn') {
          const match = RUNTIME_HINTS.find(h => h.pat.test(low))
          if (match) sendLog('warn', '  → ' + match.hint, 'wine')
        }
      }))

    gameProcess.on('close', code => {
      stopDiscordRPC()
      if (code === 0) {
        sendLog('success', 'Session ended normally.', 'wine')
      } else {
        sendLog('error', `Process exited with code ${code}.`, 'wine')
        const hint = EXIT_HINTS[code]
        if (hint) sendLog('warn', '  → ' + hint, 'wine')
        else sendLog('warn', '  → Scroll up for error details, or check the truckersmp-cli documentation.', 'wine')
      }
      sendLog('system', '══════════════════════════════════════', 'wine')
      mainWindow?.webContents.send('game:stopped', { code })
      gameProcess = null
      currentLaunchSettings = null
    })

    gameProcess.on('error', err => {
      stopDiscordRPC()
      let msg = `Failed to start process: ${err.message}`
      if (err.code === 'ENOENT') msg =
        `Command not found: ${spawnCmd}\n` +
        `  → The Python interpreter or truckersmp-cli script could not be found.\n` +
        `  → Reinstall: pip3 install truckersmp-cli\n` +
        `  → Then click Re-detect in the sidebar.`
      if (err.code === 'EACCES') msg =
        `Permission denied: ${s.cliPath}\n` +
        `  → Fix with: chmod +x "${s.cliPath}"`
      if (err.code === 'ENOEXEC' || err.errno === -8) msg =
        `Cannot execute truckersmp-cli (system error -8 / ENOEXEC).\n` +
        `  → This means the OS cannot run the script.\n` +
        `  → Most likely the Python interpreter in the script's shebang is missing.\n` +
        `  → Resolved interpreter tried: ${interp || '(none found)'}\n` +
        `  → Fix: Install Python 3 via https://python.org/downloads or brew install python3\n` +
        `  → Then reinstall: pip3 install truckersmp-cli\n` +
        `  → If truckersmp-cli is already installed, try: chmod +x "${s.cliPath}"`
      sendLog('error', msg)
      mainWindow?.webContents.send('game:stopped', { code: -1 })
      gameProcess = null
      currentLaunchSettings = null
    })

    sendLog('success', `Process started — PID ${gameProcess.pid}`)
    // ── Start Discord RPC after process is confirmed running ─────────────────
    if (s.discordIPC !== false) startDiscordRPC(
      gameProcess.pid,
      (kind, text) => sendLog(kind, text, 'launcher'),
      s.discordClientId || DISCORD_CLIENT_ID,
      s.rpcCustom || {},
      s.ets2mpLogsDir,
      {
        advanced:         !!s.rpcAdvanced,
        autoReconnect:    s.rpcAutoReconnect !== false,
        afkEnabled:       s.afkEnabled       !== false,
        afkMinutes:       s.afkMinutes       || 5,
        telemetryEnabled: !!s.telemetryEnabled,
        telemetryPath:    s.telemetryPath    || '',
        ets2mpLogsDir:    s.ets2mpLogsDir,
      }
    )
    currentLaunchSettings = s
    return { ok:true, pid:gameProcess.pid }
  } catch(err) {
    gameProcess = null
    currentLaunchSettings = null
    return { ok:false, error:`Unexpected launch error: ${err.message}` }
  }
})

// ── Stop helpers ──────────────────────────────────────────────────────────────
// Wine on macOS does NOT respond to SIGINT or SIGTERM — the game process (wine)
// is a child of wineserver, which is a daemon separate from the Python process.
// The correct way to kill a Wine bottle's processes is:
//   WINEPREFIX=/bottle wineserver -k
// We also SIGKILL the Python process to stop the launcher script itself.
function killWineserver(winePath, bottlePath) {
  if (!bottlePath) return
  // Derive wineserver path from the wine binary path (same directory)
  const wineDir = winePath ? path.dirname(winePath) : null
  const candidates = [
    wineDir ? path.join(wineDir, 'wineserver') : null,
    '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wineserver',
    '/usr/local/bin/wineserver',
    '/opt/homebrew/bin/wineserver',
  ].filter(Boolean)

  for (const ws of candidates) {
    if (fs.existsSync(ws)) {
      try {
        spawn(ws, ['-k'], {
          env: { ...process.env, WINEPREFIX: bottlePath },
          detached: true, stdio: 'ignore'
        }).unref()
        return ws
      } catch {}
    }
  }
  // Last resort: kill wineserver system-wide (only affects user's processes)
  try { spawn('pkill', ['-9', 'wineserver'], { stdio:'ignore' }).unref() } catch {}
  return null
}

// ── Wine registry pre-launch patch ────────────────────────────────────────────
// Patches two keys in [Software\\Wine\\Mac Driver] directly in user.reg:
//
//  MaxVersionGL=4.1
//    Steam's CEF renderer requests OpenGL 4.4 by default. macOS CGL caps at 4.1;
//    context creation fails silently → black window. Capping to 4.1 lets CEF get
//    a valid context.
//
//  MultiThreadedGL=N
//    When CGL's multithreaded rendering engine (kCGLCEMPEngine) is active, GL
//    commands run on a background driver thread. That thread completes renders but
//    they are never flushed/presented to Wine's window surface because the flush
//    happens on the wrong thread. Result: CEF renders perfectly into an off-screen
//    buffer that never appears on screen → black window. Disabling multithreading
//    forces all GL commands to execute synchronously on Wine's message-pump thread,
//    so every rendered frame is immediately presented.
//
// Both are written to user.reg directly (no wineserver spawn needed).
function patchWineMaxGL(bottlePath) {
  try {
    const userReg = path.join(bottlePath, 'user.reg')
    if (!fs.existsSync(userReg)) return
    let content = fs.readFileSync(userReg, 'utf8')
    let changed = false

    // Fix: a previous version of this function incorrectly wrote a bare Unix
    // timestamp on its own line after the section header. Wine does not use a
    // separate timestamp line in user.reg — the number is not valid as a value
    // name and causes Wine to fail to parse the section, making it exit
    // immediately. Detect and remove that line so the section is valid again.
    const fixed = content.replace(
      /(\[Software\\\\Wine\\\\Mac Driver\])\r?\n\d{9,}\r?\n/g,
      '$1\n'
    )
    if (fixed !== content) {
      content = fixed
      changed = true
      console.log('[WineGL] Removed malformed timestamp line from user.reg →', userReg)
    }

    const sectionHeader = '[Software\\\\Wine\\\\Mac Driver]'
    // Scope key-presence check to only the Mac Driver section so a matching
    // key in an unrelated section doesn't produce a false positive.
    const macDriverBlock = content.split(/(?=\[)/g)
      .find(s => s.startsWith('[Software\\\\Wine\\\\Mac Driver]')) || ''
    const hasMaxGL   = /MaxVersionGL/i.test(macDriverBlock)
    const hasMultiGL = /MultiThreadedGL/i.test(macDriverBlock)

    if (hasMaxGL && hasMultiGL) {
      // Both already present — ensure correct values
      let patched = content.replace(
        /"MultiThreadedGL"\s*=\s*"[^"]*"/i,
        '"MultiThreadedGL"="N"'
      )
      if (patched !== content) {
        content = patched
        changed = true
        console.log('[WineGL] Corrected MultiThreadedGL → N in user.reg')
      }
      // Also correct MaxVersionGL if it's not 4.1 (e.g. someone set 4.4 which fails on macOS)
      patched = content.replace(
        /"MaxVersionGL"\s*=\s*"(?!4\.1")[^"]*"/i,
        '"MaxVersionGL"="4.1"'
      )
      if (patched !== content) {
        content = patched
        changed = true
        console.log('[WineGL] Corrected MaxVersionGL → 4.1 in user.reg')
      }
      if (changed) fs.writeFileSync(userReg, content, 'utf8')
      return
    }

    // Build the entries to inject
    let entries = ''
    if (!hasMaxGL)   entries += '"MaxVersionGL"="4.1"\n'
    if (!hasMultiGL) entries += '"MultiThreadedGL"="N"\n'

    if (content.includes(sectionHeader)) {
      content = content.replace(sectionHeader, sectionHeader + '\n' + entries)
    } else {
      content += `\n${sectionHeader}\n${entries}\n`
    }
    fs.writeFileSync(userReg, content, 'utf8')
    console.log('[WineGL] Patched Mac Driver registry →', userReg,
                '| MaxVersionGL=4.1, MultiThreadedGL=N')
  } catch (e) {
    console.warn('[WineGL] Could not patch user.reg:', e.message)
  }
}

function patchRetinaMode(bottlePath, enabled) {
  try {
    const userReg = path.join(bottlePath, 'user.reg')
    if (!fs.existsSync(userReg)) return
    let content = fs.readFileSync(userReg, 'utf8')
    const retVal = enabled ? 'y' : 'n'

    // 1. Set RetinaMode in [Software\\Wine\\Mac Driver]
    const macSection = '[Software\\\\Wine\\\\Mac Driver]'
    const macBlock = content.split(/(?=\[)/g).find(s => s.startsWith('[Software\\\\Wine\\\\Mac Driver]')) || ''
    if (/"RetinaMode"/i.test(macBlock)) {
      content = content.replace(/"RetinaMode"\s*=\s*"[^"]*"/i, `"RetinaMode"="${retVal}"`)
    } else if (content.includes(macSection)) {
      content = content.replace(macSection, macSection + `\n"RetinaMode"="${retVal}"`)
    } else {
      content += `\n${macSection}\n"RetinaMode"="${retVal}"\n`
    }

    // 2. Set LogPixels DPI in [Software\\Fonts]
    // 192 DPI (0xc0) for Retina, 96 DPI (0x60) for standard — must match RetinaMode
    // or Windows apps will render at full 4K density with tiny UI elements.
    const dpiHex  = enabled ? '000000c0' : '00000060'
    const dpiVal  = `dword:${dpiHex}`
    const fontsSection = '[Software\\\\Fonts]'
    const fontsBlock = content.split(/(?=\[)/g).find(s => s.startsWith('[Software\\\\Fonts]')) || ''
    if (/"LogPixels"/i.test(fontsBlock)) {
      content = content.replace(/"LogPixels"\s*=\s*dword:[0-9a-fA-F]+/i, `"LogPixels"=${dpiVal}`)
    } else if (content.includes(fontsSection)) {
      content = content.replace(fontsSection, fontsSection + `\n"LogPixels"=${dpiVal}`)
    } else {
      content += `\n${fontsSection}\n"LogPixels"=${dpiVal}\n`
    }

    fs.writeFileSync(userReg, content, 'utf8')
    console.log(`[Retina] RetinaMode=${retVal} LogPixels=${dpiHex} written to`, userReg)
  } catch (e) {
    console.warn('[Retina] Could not patch user.reg:', e.message)
  }
}

// ── CEF Local State patch ──────────────────────────────────────────────────────
// Chrome/CEF reads its "Local State" file before spawning the GPU process and
// consults gpu.hardware_acceleration_mode.enabled. Setting it to false prevents
// the GPU process from ever starting, avoiding the STATUS_BREAKPOINT crash loop
// (Wine's D3D11/ANGLE crashes 3-6 times before CEF falls back to software).
//
// IMPORTANT: Steam's CEF does NOT use <steamDir>/config/cef_cache/Local State.
// The real location is the -cachedir passed on the steamwebhelper command line:
//   C:\users\<winuser>\AppData\Local\Steam\htmlcache\Local State
// which maps on disk to:
//   <bottlePath>/drive_c/users/<winuser>/AppData/Local/Steam/htmlcache/Local State
//
// We patch ALL candidate paths so the fix works regardless of Wine username.
// We merge only the one key so we don't disturb any other CEF preferences.
// Returns an array of log strings for the caller to forward to the UI.
//
// IMPORTANT: After writing we chmod the file 0o444 (read-only).
// Steam's main process re-writes Local State during its own startup, resetting
// hardware_acceleration_mode.enabled back to true before steamwebhelper ever
// reads it — making the patch appear to work but have no effect. Locking the
// file prevents that overwrite. We chmod back to 0o644 at the start of each
// patch cycle so we can update it ourselves on subsequent launches.
function patchCEFLocalState(steamDir, bottlePath) {
  const pathsToTry = []
  const log = []

  // Legacy / fallback: <steamDir>/config/cef_cache/Local State
  if (steamDir) pathsToTry.push(path.join(steamDir, 'config', 'cef_cache', 'Local State'))

  // Correct path: <bottle>/drive_c/users/<winuser>/AppData/Local/Steam/htmlcache/Local State
  // Steam passes this directory via -cachedir to steamwebhelper.exe.
  if (bottlePath) {
    const usersDir = path.join(bottlePath, 'drive_c', 'users')
    if (fs.existsSync(usersDir)) {
      const systemAccounts = new Set(['Public', 'All Users', 'Default', 'Default User', 'Default User.DEFAULT'])
      try {
        // Use withFileTypes so we can skip macOS metadata files (.DS_Store, etc.)
        // that are not directories — treating them as usernames produces ENOTDIR errors.
        const entries = fs.readdirSync(usersDir, { withFileTypes: true })
        const userEntries = entries.filter(e => e.isDirectory() && !systemAccounts.has(e.name))
        log.push(`[CEF] Bottle users found: ${userEntries.length ? userEntries.map(e => e.name).join(', ') : '(none)'}`)
        for (const entry of userEntries) {
          pathsToTry.push(
            path.join(usersDir, entry.name, 'AppData', 'Local', 'Steam', 'htmlcache', 'Local State')
          )
        }
      } catch(e) { log.push(`[CEF] Could not scan users dir: ${e.message}`) }
    } else {
      log.push(`[CEF] ⚠ Bottle users dir not found: ${path.join(bottlePath, 'drive_c', 'users')}`)
    }
  }

  log.push(`[CEF] Patching ${pathsToTry.length} Local State path(s)…`)

  for (const localStatePath of pathsToTry) {
    // Un-lock in case we made it read-only on a previous launch
    try { fs.chmodSync(localStatePath, 0o644) } catch {}

    let state = {}
    const exists = fs.existsSync(localStatePath)
    if (exists) {
      try { state = JSON.parse(fs.readFileSync(localStatePath, 'utf8')) } catch {}
    } else {
      try { fs.mkdirSync(path.dirname(localStatePath), { recursive: true }) } catch {}
    }

    // Root-level key — this is what Chromium/CEF actually reads to decide
    // whether to launch the GPU subprocess (hardware_acceleration_mode.enabled).
    // The gpu-nested path is kept for compatibility with older CEF builds that
    // may also check under gpu.hardware_acceleration_mode.enabled.
    if (!state.hardware_acceleration_mode) state.hardware_acceleration_mode = {}
    state.hardware_acceleration_mode.enabled = false
    if (!state.gpu) state.gpu = {}
    if (!state.gpu.hardware_acceleration_mode) state.gpu.hardware_acceleration_mode = {}
    state.gpu.hardware_acceleration_mode.enabled = false
    try {
      fs.writeFileSync(localStatePath, JSON.stringify(state, null, 2), 'utf8')
      // Lock read-only: prevents Steam from resetting hw-accel back to true
      // during its own startup before steamwebhelper reads this file.
      try { fs.chmodSync(localStatePath, 0o444) } catch {}
      log.push(`[CEF] ✓ hw-accel disabled + locked: …/${path.relative(bottlePath || steamDir || '', localStatePath)}`)
      console.log('[CEF] Patched + locked Local State →', localStatePath)
    } catch(e) {
      log.push(`[CEF] ✗ Failed to patch ${path.basename(path.dirname(localStatePath))}: ${e.message}`)
    }
  }

  return log
}

// ── CEF GPU cache cleaner ──────────────────────────────────────────────────────
// CEF persists GPU probe results in a GPUCache directory inside htmlcache.
// Stale cache from a previous crash can cause CEF to re-attempt hardware
// rendering even after a software fallback. Deleting it before each Steam
// launch forces a fresh probe (which will again fail and fall back, but
// patchCEFLocalState above now stops the GPU process from starting at all).
// Returns an array of log strings for the caller to forward to the UI.
function clearCEFGpuCache(bottlePath) {
  const log = []
  if (!bottlePath) return log
  const usersDir = path.join(bottlePath, 'drive_c', 'users')
  if (!fs.existsSync(usersDir)) return log
  const systemAccounts = new Set(['Public', 'All Users', 'Default', 'Default User', 'Default User.DEFAULT'])
  try {
    for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || systemAccounts.has(entry.name)) continue
      const uname = entry.name
      const gpuCache = path.join(usersDir, uname, 'AppData', 'Local', 'Steam', 'htmlcache', 'GPUCache')
      if (fs.existsSync(gpuCache)) {
        try {
          fs.rmSync(gpuCache, { recursive: true, force: true })
          log.push(`[CEF] ✓ GPUCache cleared for user: ${uname}`)
          console.log('[CEF] Cleared GPUCache →', gpuCache)
        } catch(e) { log.push(`[CEF] ✗ Failed to clear GPUCache for ${uname}: ${e.message}`) }
      }
    }
    if (!log.length) log.push('[CEF] GPUCache: nothing to clear')
  } catch(e) { log.push(`[CEF] GPUCache scan error: ${e.message}`) }
  return log
}

// ── Start Steam via Wine ───────────────────────────────────────────────────────
// ── Steam launch helpers ───────────────────────────────────────────────────────

// Check for files that Steam creates in AppData/Local/Steam when its UI is ready.
function checkSteamIpcSocket(bottlePath) {
  const usersDir = path.join(bottlePath, 'drive_c', 'users')
  if (!fs.existsSync(usersDir)) return false
  try {
    for (const user of fs.readdirSync(usersDir)) {
      if (user === 'Public') continue
      const steamLocal = path.join(usersDir, user, 'AppData', 'Local', 'Steam')
      if (!fs.existsSync(steamLocal)) continue
      // Steam writes registry.vdf and *.tmp socket markers when the UI is running
      if (fs.readdirSync(steamLocal).some(f => f === 'registry.vdf' || f.endsWith('.tmp')))
        return true
    }
  } catch {}
  return false
}

// Polls every 2 s for Steam's IPC socket.
// Guarded by _steamPollActive so beginSteamReadyPoll can be called again on self-restart
// without needing a live steamPid (the restarted process is detached with a new PID).
function beginSteamReadyPoll(bottlePath) {
  _steamPollActive = true
  const started = Date.now()
  const TIMEOUT = 120_000
  const timer = setInterval(() => {
    if (!_steamPollActive || Date.now() - started > TIMEOUT) { clearInterval(timer); return }
    if (checkSteamIpcSocket(bottlePath)) {
      clearInterval(timer)
      _steamPollActive = false
      sendLog('success', '[Steam] Ready — IPC socket detected.')
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('steam:ready') } catch {}
    }
  }, 2000)
}

ipcMain.handle('game:startSteam', async (_, s) => {
  const isStandalone = s.wineMode === 'standalone'
  sendLog('info', `› Starting Steam via ${isStandalone ? 'standalone' : 'CrossOver'} Wine…`)

  let winePath, bottlePath, steamDir

  if (isStandalone) {
    winePath   = standaloneWineBin()
    bottlePath = s.standalonBottlePath
    steamDir   = s.standalonSteamDir
    if (!winePath)   return { ok:false, error:'Standalone Wine not installed. Complete the Setup Wizard (Step 1).' }
    if (!bottlePath || !fs.existsSync(path.join(bottlePath, 'drive_c')))
      return { ok:false, error:'Standalone bottle not found. Complete the Setup Wizard (Step 2).' }
    if (!steamDir)   return { ok:false, error:'Standalone Steam directory not set. Set it in Settings → Wine Mode → standalone paths.' }
  } else {
    winePath   = s.winePath
    bottlePath = s.bottlePath
    steamDir   = s.steamDir
    if (!winePath)   return { ok:false, error:'Wine path not set. Configure it in Settings.' }
    if (!bottlePath) return { ok:false, error:'CrossOver Bottle not set. Configure it in Settings.' }
    if (!steamDir)   return { ok:false, error:'Steam Directory not set. Configure it in Settings.' }
    if (!fs.existsSync(winePath))   return { ok:false, error:`Wine not found at: ${winePath}` }
    if (!fs.existsSync(bottlePath)) return { ok:false, error:`Bottle not found at: ${bottlePath}` }
  }

  const steamExe = path.join(steamDir, 'steam.exe')
  if (!fs.existsSync(steamExe)) return { ok:false, error:`steam.exe not found at: ${steamExe}\n\nMake sure Steam is installed inside the bottle.` }

  let env
  if (isStandalone) {
    env = standaloneWineEnv(winePath, bottlePath)

    // Copy DXMT DLLs into the bottle's system32 so Wine's native-DLL lookup works.
    // WINEDLLOVERRIDES=dxgi=n,b tells Wine to try native dxgi.dll first, but Wine
    // only searches drive_c/windows/system32 — it has no concept of DXMT_DLL_DIR.
    // Without the physical files present, "n" fails silently and Wine falls back to
    // builtin wined3d which requests OpenGL 4.4 and causes the black window.
    if (s.standalonDxmtDir) {
      // Sync DXMT DLLs into system32 so they are present for game launches
      // that run inside the same bottle. We deliberately do NOT activate DXMT
      // for Steam itself (no dxgi=n,b;d3d11=n,b here) because Steam's CEF GPU
      // subprocess uses ANGLE→D3D11 internally, and routing ANGLE through DXMT
      // (a game renderer) causes STATUS_BREAKPOINT crashes in the GPU process,
      // making steamwebhelper hang after 3 crash-restart cycles.
      ensureDxmtInBottle(bottlePath, s.standalonDxmtDir)
      // DXMT DLLs synced (no log — technical detail)
    }
    // dcomp=d: disable Wine's DirectComposition. Without this, Steam's CEF login
    // window renders as a solid black rectangle on upstream Wine builds.
    // We use ONLY this override — no dxgi/d3d11 — so CEF's ANGLE GPU backend
    // uses Wine's builtin d3d11 (which ANGLE supports) rather than DXMT.
    env.WINEDLLOVERRIDES = 'dcomp=d'

    // ── Stage 1 (Steam) env isolation — CRITICAL for steamwebhelper stability ──
    // WINEESYNC=1 floods macOS with eventfd emulation files per Wine process.
    // Steam's CEF architecture spawns dozens of browser helpers; each one adds
    // more eventfds, instantly exhausting the default macOS fd limit (~256-4800).
    // CEF then cannot open any new IPC sockets → steamwebhelper crash loop.
    delete env.WINEESYNC
    // WINE_DISABLE_KERNEL_WRITEWATCH disables the Win32 GetWriteWatch API.
    // Chromium's V8 GC relies on GetWriteWatch for memory page tracking during
    // concurrent garbage collection. Disabling it causes an instant memory panic
    // in steamwebhelper.exe, which is the crash Steam reports as "not responding".
    delete env.WINE_DISABLE_KERNEL_WRITEWATCH
    // MVK_CONFIG_* vars are only needed by the game renderer (Stage 2 — ETS2/truckersmp).
    // They have no benefit for Steam's CEF UI and add unnecessary env noise.
    delete env.MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS
    delete env.MVK_CONFIG_USE_METAL_PRIVATE_API
    // LC_ALL: prevents chrome_elf.dll locale-initialisation failures on Wine.
    env.LC_ALL = 'en_US.UTF-8'

  } else {
    // CrossOver mode — replicate what CrossOver's own cxstart sets so that
    // CrossOver-patched wine can find its own support libraries and configs.
    const cxSupport = '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver'
    const cxLibPath = `${cxSupport}/lib`
    const existingDyld = process.env.DYLD_FALLBACK_LIBRARY_PATH || ''
    env = {
      ...process.env,
      WINE:        winePath,
      WINEPREFIX:  bottlePath,
      WINEDEBUG:   '-all',
      WINEMSYNC:   '1',
      CX_BOTTLE:   path.basename(bottlePath),
      CX_ROOT:     cxSupport,
      DYLD_FALLBACK_LIBRARY_PATH: existingDyld ? `${cxLibPath}:${existingDyld}` : cxLibPath,
    }
  }

  // (Full launch config logged to console for debugging, not surfaced to the user)

  // Kill any stale wineserver from a previous session before spawning.
  // Fire-and-forget spawn (not execFileSync) so we don't block the main thread
  // for 4 s on timeout. We do NOT pkill Wine child processes here — doing so
  // would kill Wine's own boot services (winedevice, services.exe, plugplay)
  // on a freshly created bottle, making every launch after first setup fail.
  // wineserver -k already handles child cleanup cleanly.
  if (isStandalone) {
    try {
      const wsPath = path.join(path.dirname(winePath), 'wineserver')
      if (fs.existsSync(wsPath)) {
        try {
          spawn(wsPath, ['-k'], { env: { ...env, WINEPREFIX: bottlePath }, stdio: 'ignore', detached: true }).unref()
        } catch {}
        // Give wineserver 1.5s to shut down gracefully (increased from 800ms — Wine 11.x
        // can take >1s to release its socket file after a Steam session ends)
        await new Promise(r => setTimeout(r, 1500))
        // Nuclear fallback: force-kill any wineserver from this specific Wine install that
        // didn't respond to -k. Scoped to this Wine binary's directory so we don't kill
        // wineservers from other installations (e.g. CrossOver).
        // spawn+unref so we never block the Electron main thread. The path is escaped
        // for regex so special characters (spaces, dots, parens) don't alter the pattern.
        try {
          const wineInstallDir = path.dirname(wsPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          spawn('pkill', ['-9', '-f', `${wineInstallDir}/wineserver`], { stdio: 'ignore', detached: true }).unref()
        } catch {}
        // Final 500ms for the OS to release socket file handles
        await new Promise(r => setTimeout(r, 500))
      }
    } catch {}
    for (const lf of [path.join(steamDir, 'steam.pid'), path.join(steamDir, '.steam', 'steam.pid')]) {
      try { if (fs.existsSync(lf)) { fs.unlinkSync(lf); console.log('[Steam] Cleaned lockfile:', lf) } } catch {}
    }
  }

  // ── Pre-launch CEF / OpenGL patches ───────────────────────────────────────
  // These must run on EVERY Steam launch, not just the first, because Steam's
  // own startup overwrites Local State (resetting hw-accel back to enabled) on
  // each run — so locking the file here is what actually prevents CEF from
  // starting a GPU subprocess.
  //
  // Order matters:
  //  1. patchWineMaxGL   — caps OpenGL to 4.1 so macOS CGL can satisfy the
  //                        context request; disables MT-GL so frames are flushed.
  //  2. patchCEFLocalState — sets hardware_acceleration_mode.enabled=false and
  //                        locks the file read-only before Steam can reset it.
  //  3. clearCEFGpuCache — deletes stale GPU-probe cache that would override the
  //                        Local State patch and re-enable hardware acceleration.
  if (isStandalone) {
    patchWineMaxGL(bottlePath)
    const cefLogs = patchCEFLocalState(steamDir, bottlePath)
    for (const msg of cefLogs) console.log('[CEF]', msg)
    const gpuLogs = clearCEFGpuCache(bottlePath)
    for (const msg of gpuLogs) console.log('[CEF-GPU]', msg)
  }

  // Open a log file when the Wine debug log toggle is enabled.
  // Only log in standalone mode — CrossOver already manages its own logs.
  let logFd = null
  if (s.standalonWineDebugLog && isStandalone) {
    try {
      fs.mkdirSync(SW_DIR, { recursive: true })
      logFd = fs.openSync(path.join(SW_DIR, isStandalone ? 'steam-wine.log' : 'crossover-steam.log'), 'w')
      env.WINEDEBUG = 'warn+wgl,warn+d3d11,warn+dxgi,err+loader,err+module'
    } catch {}
  }

  try {
    // Spawn via bash so we can raise the open-file limit with ulimit before exec'ing Wine.
    // ulimit is a shell built-in — it cannot be called as a standalone executable.
    // exec "$0" "$@" replaces the bash shell with Wine so no extra process is left behind.
    // -cef-disable-gpu  : prevents ANGLE from trying D3D11 acceleration (hits DXMT → GPU crash loop)
    // -cef-disable-d3d11: forces CEF to software rendering path, bypassing the STATUS_BREAKPOINT loop
    const cefGpuFlags = ['-cef-disable-gpu', '-cef-disable-d3d11']

    const proc = spawn('/bin/bash', [
      '-c', 'ulimit -n 10240; exec "$0" "$@"',
      winePath, steamExe, '-no-cef-sandbox', ...cefGpuFlags,
    ], {
      env,
      stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
      detached: true,
    })
    if (logFd !== null) try { fs.closeSync(logFd) } catch {}
    steamPid = proc.pid
    proc.on('exit', () => {
      steamPid = null
      // If the user explicitly requested a stop, send steam:stopped immediately.
      if (_steamStopRequested) {
        _steamStopRequested = false
        _steamPollActive = false
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('steam:stopped') } catch {}
        return
      }
      // Natural exit — Steam may be self-restarting (e.g. during an update).
      // Poll for up to 2.5 s for a surviving steam.exe Wine process before declaring stopped.
      let checks = 0
      const watchdog = setInterval(() => {
        checks++
        let alive = false
        try { execSync("pgrep -f 'steam\\.exe'", { timeout: 1500, stdio: 'pipe' }); alive = true } catch {}
        if (alive) {
          clearInterval(watchdog)
          try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('steam:restarting') } catch {}
          // Stop any prior ready-poll (its detected files are stale from session 1).
          // Wait 4 s for session 2 to initialise before starting a fresh poll.
          _steamPollActive = false
          setTimeout(() => beginSteamReadyPoll(bottlePath), 4000)
        } else if (checks >= 5) {
          clearInterval(watchdog)
          _steamPollActive = false
          try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('steam:stopped') } catch {}
        }
      }, 500)
    })
    proc.unref()
    sendLog('success', `Steam launched (PID ${proc.pid})`)
    // Wine debug log path available in Settings → Wine Log
    if (isStandalone) beginSteamReadyPoll(bottlePath)
    return { ok:true, pid: proc.pid }
  } catch(e) {
    if (logFd !== null) try { fs.closeSync(logFd) } catch {}
    return { ok:false, error: e.message }
  }
})

// ── Launch winecfg ─────────────────────────────────────────────────────────────
ipcMain.handle('game:launchWinecfg', async (_, s) => {
  const isStandalone = s.wineMode === 'standalone'
  let winePath, bottlePath

  if (isStandalone) {
    winePath   = standaloneWineBin()
    bottlePath = s.standalonBottlePath
    if (!winePath)   return { ok:false, error:'Standalone Wine not installed. Complete the Setup Wizard first.' }
    if (!bottlePath) return { ok:false, error:'Standalone bottle path not set.' }
    if (!fs.existsSync(path.join(bottlePath, 'drive_c')))
      return { ok:false, error:'Standalone bottle not fully created. Complete Setup Wizard Step 2.' }
  } else {
    winePath   = s.winePath
    bottlePath = s.bottlePath
    if (!winePath)   return { ok:false, error:'Wine path not set. Configure it in Settings.' }
    if (!bottlePath) return { ok:false, error:'Bottle path not set. Configure it in Settings.' }
    if (!fs.existsSync(winePath)) return { ok:false, error:`Wine not found at: ${winePath}` }
  }

  const env = isStandalone
    ? standaloneWineEnv(winePath, bottlePath)
    : { ...process.env, WINEPREFIX: bottlePath, WINEMSYNC: '1', WINEDEBUG: 'err+all', CX_BOTTLE: path.basename(bottlePath), WINE: winePath }

  try {
    spawn(winePath, ['winecfg'], { env, stdio:'ignore', detached:true }).unref()
    return { ok:true }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})


ipcMain.handle('wine:runCommand', async (_, { cmd, s }) => {
  const winePath   = standaloneWineBin()
  const bottlePath = s.standalonBottlePath
  if (!winePath)   return { ok:false, error:'Standalone Wine not installed. Complete the Setup Wizard (Step 1).' }
  if (!bottlePath || !fs.existsSync(path.join(bottlePath, 'drive_c')))
    return { ok:false, error:'Bottle not found. Complete Setup Wizard Step 2 first.' }
  const args = cmd.trim().split(/\s+/).filter(Boolean)
  if (!args.length) return { ok:false, error:'Empty command.' }
  const env = standaloneWineEnv(winePath, bottlePath)
  try {
    spawn(winePath, args, { env, stdio:'ignore', detached:true }).unref()
    return { ok:true }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// ── Diagnose standalone Wine ───────────────────────────────────────────────────
// Runs a series of checks and returns { ok, checks[] } where each check is
// { label, ok, detail }. Never throws — every failure is captured as a check.
ipcMain.handle('wine:diagnose', async (_, s) => {
  const checks = []
  function chk(label, pass, detail = '') { checks.push({ label, ok: pass, detail }); return pass }

  // 1. Wine binary
  const winePath = standaloneWineBin()
  if (!chk('Wine binary found', !!winePath, winePath || `Not found in ${SW_WINE_DIR}`)) {
    return { ok: false, checks }
  }
  chk('Wine binary executable', (() => { try { fs.accessSync(winePath, fs.constants.X_OK); return true } catch { return false } })(),
    winePath)

  // 2. wine --version
  let wineVersion = ''
  try {
    wineVersion = execSync(`"${winePath}" --version`, {
      env: standaloneWineEnv(winePath, s.standalonBottlePath || '/tmp/nope'),
      timeout: 5000, encoding: 'utf8'
    }).trim()
    chk('wine --version succeeds', true, wineVersion)
  } catch(e) {
    chk('wine --version succeeds', false, e.message.split('\n')[0].slice(0, 120))
  }

  // 3. wineserver binary exists alongside wine
  const wineDir = path.dirname(winePath)
  const wineserverBin = path.join(wineDir, 'wineserver')
  chk('wineserver binary found', fs.existsSync(wineserverBin), wineserverBin)

  // 4. Bottle
  const bottlePath = s.standalonBottlePath
  const bottleOk = !!bottlePath && fs.existsSync(path.join(bottlePath, 'drive_c'))
  chk('Bottle path set & drive_c exists', bottleOk, bottlePath || 'Not set')

  // 5. Steam exe
  const steamDir = s.standalonSteamDir
  const steamExe = steamDir ? path.join(steamDir, 'steam.exe') : null
  chk('Steam directory set', !!steamDir, steamDir || 'Not set')
  if (steamDir) chk('steam.exe exists', steamExe ? fs.existsSync(steamExe) : false, steamExe || '')

  // 6. Game dir
  const gameDir = s.standalonGameDir
  chk('Game directory set', !!gameDir, gameDir || 'Not set')
  if (gameDir) chk('Game directory exists', fs.existsSync(gameDir), gameDir)

  const allOk = checks.every(c => c.ok)
  return { ok: allOk, checks }
})

// ── Kill all Wine processes for the current standalone bottle ─────────────────
ipcMain.handle('wine:killAll', async (_, s) => {
  try {
    const winePath   = standaloneWineBin()
    const bottlePath = s ? s.standalonBottlePath : null
    // 1. Graceful wineserver shutdown for the bottle
    if (winePath && bottlePath && fs.existsSync(bottlePath)) {
      try { killWineserver(winePath, bottlePath) } catch {}
    }
    // 2. SIGKILL all wine-related processes.
    // killall is macOS-native and matches by display name (more reliable than pkill -x on ARM).
    // pgrep | xargs kill -9 is a belt-and-suspenders fallback via direct PID.
    try { execSync('killall -9 wine 2>/dev/null; true',                                        { shell:true, stdio:'ignore', timeout:3000 }) } catch {}
    try { execSync('pgrep -x wine | xargs kill -9 2>/dev/null; true',                         { shell:true, stdio:'ignore', timeout:3000 }) } catch {}
    try { execSync('pkill -9 -f "wine64|wine32|wineserver|wineloader|winedevice|wineboot"',   { stdio:'ignore', timeout:3000 }) } catch {}
    // Second pass after 400 ms to catch anything that respawned
    await new Promise(r => setTimeout(r, 400))
    try { execSync('killall -9 wine 2>/dev/null; true',                                        { shell:true, stdio:'ignore', timeout:3000 }) } catch {}
    try { execSync('pgrep -x wine | xargs kill -9 2>/dev/null; true',                         { shell:true, stdio:'ignore', timeout:3000 }) } catch {}
    try { execSync('pkill -9 -f "wine64|wine32|wineserver|wineloader|winedevice|wineboot"',   { stdio:'ignore', timeout:2000 }) } catch {}
    // 3. Clear tracked PIDs
    if (gameProcess) { try { gameProcess.kill('SIGKILL') } catch {}; gameProcess = null }
    if (steamPid)    { try { process.kill(steamPid, 'SIGKILL') } catch {}; steamPid = null }
    _steamPollActive = false
    sendLog('info', 'Killed all Wine processes.')
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('game:stopped', { code: null }) } catch {}
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('steam:stopped') } catch {}
    return { ok:true }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// ── Kill a specific Wine process by PID ────────────────────────────────────────
ipcMain.handle('wine:killProcess', async (_, pid) => {
  try {
    process.kill(parseInt(pid), 'SIGKILL')
    return { ok: true }
  } catch(e) {
    return { ok: false, error: e.message }
  }
})

// ── List active Wine processes ─────────────────────────────────────────────────
ipcMain.handle('wine:listProcesses', async () => {
  try {
    const out = execSync(
      'ps -eo pid,comm,args | grep -E "(wine64|wine|wineserver|wineloader|eurotrucks2\\.exe|steam\\.exe|truckersmp)" | grep -v grep',
      { timeout: 3000, encoding: 'utf8' }
    ).trim()
    if (!out) return { ok:true, processes:[] }
    const lines = out.split('\n').map(l => {
      const parts = l.trimStart().split(/\s+/)
      const pid  = parts[0]
      const comm = parts[1] || ''
      const args = parts.slice(2).join(' ')
      return { pid, comm, args: args.length > 80 ? args.slice(0, 80) + '…' : args }
    })
    return { ok:true, processes: lines }
  } catch {
    return { ok:true, processes:[] }
  }
})

// ── Stop Steam ─────────────────────────────────────────────────────────────────
ipcMain.handle('game:stopSteam', async (_, s) => {
  if (!steamPid) return { ok:false, error:'Steam is not currently running.' }
  const pid = steamPid
  // Signal the exit watchdog to not attempt restart detection — this is an intentional stop.
  _steamStopRequested = true
  _steamPollActive    = false
  steamPid = null  // clear immediately so ready-poll stops

  // Step 1 — SIGTERM the tracked Steam PID
  try { process.kill(pid, 'SIGTERM') } catch {}

  // Step 2 — give Steam 1 s to flush state
  await new Promise(r => setTimeout(r, 1000))

  // Step 3 — wineserver -k (synchronous — must complete before pkill so that
  // wineserver has a chance to cleanly terminate its child processes first).
  if (s) {
    const isStandalone = s.wineMode === 'standalone'
    const winePath   = isStandalone ? standaloneWineBin() : s.winePath
    const bottlePath = isStandalone ? s.standalonBottlePath : s.bottlePath
    if (winePath && bottlePath) {
      const wsPath = path.join(path.dirname(winePath), 'wineserver')
      const wsEnv  = { ...process.env, WINEPREFIX: bottlePath }
      if (fs.existsSync(wsPath)) {
        try { execFileSync(wsPath, ['-k'], { env: wsEnv, stdio: 'ignore', timeout: 5000 }) } catch {}
      } else {
        try { killWineserver(winePath, bottlePath) } catch {}
      }
      // Give wineserver 800 ms to clean up its child processes
      await new Promise(r => setTimeout(r, 800))
    }
  }

  // Step 4 — SIGKILL anything remaining. We use separate pkill calls so that
  // a pattern-match failure on one doesn't abort the others.
  // '-x wine' matches the exact process name "wine" (catches YAAGL/Gcenx builds).
  try { execSync('pkill -9 -f "wineserver|wine-preloader|wine64|wine32"', { stdio:'ignore', timeout:3000 }) } catch {}
  try { execSync('pkill -x wine', { stdio:'ignore', timeout:2000 }) } catch {}
  try { execSync('pkill -9 -f "steamwebhelper|winedevice|plugplay|services\\.exe|rpcss"', { stdio:'ignore', timeout:3000 }) } catch {}

  return { ok:true }
})

ipcMain.handle('game:stop', () => {
  stopDiscordRPC()
  const s = currentLaunchSettings || {}

  sendLog('system', 'Stopping game…')

  // 1. Kill the Python/truckersmp-cli process if tracked
  if (gameProcess) {
    try { gameProcess.kill('SIGKILL') } catch {}
    gameProcess = null
  }

  // 2. Kill Wine processes via wineserver -k
  const wsUsed = killWineserver(s.winePath, s.bottlePath)
  if (wsUsed) {
    sendLog('system', `Sent wineserver -k (bottle: ${path.basename(s.bottlePath || 'unknown')})`)
  }

  // 3. Broad kill sweep — catches any wine process regardless of whether we had a tracked PID
  try { execSync('killall -9 wine 2>/dev/null; true',                                        { shell:true, stdio:'ignore', timeout:3000 }) } catch {}
  try { execSync('pgrep -x wine | xargs kill -9 2>/dev/null; true',                         { shell:true, stdio:'ignore', timeout:3000 }) } catch {}
  try { execSync('pkill -9 -f "wine64|wine32|wine-preloader|wineloader"',                   { stdio:'ignore', timeout:3000 }) } catch {}
  try { execSync('pkill -9 -f "wineserver|winedevice|wineboot"',                            { stdio:'ignore', timeout:3000 }) } catch {}
  try { execSync('pkill -9 -f "eurotrucks2\\.exe|steamwebhelper"',                          { stdio:'ignore', timeout:2000 }) } catch {}

  return { ok:true }
})


ipcMain.handle('game:forceStop', () => {
  stopDiscordRPC()
  sendLog('warn', 'Force Kill: terminating all Wine processes for this user…')

  // Kill the Python/cli process first
  if (gameProcess) { try { gameProcess.kill('SIGKILL') } catch {} }

  // SIGKILL — covers ALL process name variants seen in Activity Monitor.
  // killall is macOS-native and matches by display name (reliable on ARM where pkill -x can miss).
  try { execSync('killall -9 wine 2>/dev/null; true',                                                        { shell:true, stdio:'ignore', timeout:3000 }) } catch {}
  try { execSync('pgrep -x wine | xargs kill -9 2>/dev/null; true',                                         { shell:true, stdio:'ignore', timeout:3000 }) } catch {}
  try { execSync('pkill -9 -f "wine64|wine32|wine-preloader|wineloader"',                                    { stdio:'ignore', timeout:3000 }) } catch {}
  try { execSync('pkill -9 -f "wineserver|winedevice|wineboot"',                                             { stdio:'ignore', timeout:3000 }) } catch {}
  try { execSync('pkill -9 -f "eurotrucks2\\.exe|truckersmp-cli\\.exe|steamwebhelper"',                      { stdio:'ignore', timeout:3000 }) } catch {}
  try { execSync('pkill -9 -f "plugplay|services\\.exe|rpcss|conhost\\.exe|svchost\\.exe"',                  { stdio:'ignore', timeout:3000 }) } catch {}
  // Second pass after 400 ms to catch anything that respawned
  setTimeout(() => {
    try { execSync('killall -9 wine 2>/dev/null; true',                                              { shell:true, stdio:'ignore', timeout:3000 }) } catch {}
    try { execSync('pgrep -x wine | xargs kill -9 2>/dev/null; true',                               { shell:true, stdio:'ignore', timeout:3000 }) } catch {}
    try { execSync('pkill -9 -f "wine64|wine32|wineserver|winedevice|wineloader"',                  { stdio:'ignore', timeout:2000 }) } catch {}
  }, 400)

  sendLog('system', 'Force Kill sent — all Wine and game processes terminated.')
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('game:stopped', { code:-9 }) } catch {}
  gameProcess = null
  currentLaunchSettings = null
  if (steamPid) { try { process.kill(steamPid, 'SIGKILL') } catch {}; steamPid = null }
  _steamPollActive = false
  return { ok:true }
})

function sendLog(kind, text, cat) {
  mainWindow?.webContents.send('log:line', { kind, text, ts:Date.now(), ...(cat && { cat }) })
}

// ── TruckersMP API helper ──────────────────────────────────────────────────────
function tmpApiGet(apiPath, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.truckersmp.com/v2' + apiPath, { timeout }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch(e) { reject(new Error('Parse error: ' + e.message)) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

// ── TruckersMP Server Status ───────────────────────────────────────────────────
ipcMain.handle('servers:status', async () => {
  try {
    const json = await tmpApiGet('/servers')
    return { ok: true, servers: json.response || [] }
  } catch(e) {
    return { ok: false, error: e.message }
  }
})

// ── TMP Info (version + game time) ────────────────────────────────────────────
ipcMain.handle('tmp:info', async () => {
  try {
    const [vRes, tRes] = await Promise.all([
      tmpApiGet('/version'),
      tmpApiGet('/game_time')
    ])
    // /version returns data directly (no .response wrapper)
    const ver = vRes
    // /game_time returns {error:false, game_time:<total_minutes>}
    const totalMinutes = tRes.game_time || 0
    const dayMinutes   = totalMinutes % 1440
    const h = Math.floor(dayMinutes / 60)
    const m = dayMinutes % 60
    const gameTimeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`
    return {
      ok: true,
      version:      ver.name                    || '?',
      etsSupported: ver.supported_game_version  || '?',
      gameTime:     gameTimeStr,
    }
  } catch(e) {
    return { ok: false, error: e.message }
  }
})

// ── TMP Upcoming Events ────────────────────────────────────────────────────────
ipcMain.handle('tmp:events', async () => {
  try {
    const res = await tmpApiGet('/events')
    const r = res.response || {}
    // Combine upcoming + today + featured (API has no 'now' bucket), max 5
    const all = [
      ...(r.upcoming  || []),
      ...(r.today     || []),
      ...(r.featured  || []),
    ]
    // Deduplicate by id and keep first 5
    const seen = new Set()
    const events = all.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true }).slice(0, 5)
    return { ok: true, events }
  } catch(e) {
    return { ok: false, error: e.message }
  }
})

// ── TMP Player Lookup ──────────────────────────────────────────────────────────
ipcMain.handle('player:lookup', async (_, id) => {
  if (!id || isNaN(Number(id))) return { ok: false, error: 'Invalid player ID.' }
  try {
    const res = await tmpApiGet(`/player/${id}`)
    if (res.error) return { ok: false, error: res.descriptive || 'Player not found.' }
    return { ok: true, player: res.response }
  } catch(e) {
    return { ok: false, error: e.message }
  }
})

// ── Discord RPC Test ──────────────────────────────────────────────────────────
ipcMain.handle('discord:test', (_, s) =>
  testDiscordRPC(s.discordClientId || DISCORD_CLIENT_ID, s.rpcCustom || {}, s.rpcTestDuration, s.rpcTestPreset)
)

// Toggle the "pause watchers when window blurs" behaviour at runtime so
// the renderer can sync the setting without a restart.
ipcMain.handle('app:setPauseOnBlur', (_, enabled) => {
  _pauseOnBlurEnabled = !!enabled
  // If the user just disabled it while watchers are paused, resume now.
  if (!enabled && _watchersPaused) _resumeWatchers('user disabled pause-on-blur')
  return _pauseOnBlurEnabled
})

// Returns the locally installed truckersmp-cli version (e.g. "0.10.4") or an
// error string. Used by the About panel to verify the install is up to date.
ipcMain.handle('tools:trucksmpCliVersion', async () => {
  return new Promise(resolve => {
    try {
      const cli = findCLIPath()
      if (!cli) return resolve({ ok:false, error:'truckersmp-cli not found in PATH.' })
      const proc = execFile(cli, ['--version'], { timeout:5000 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok:false, error: (stderr||err.message||'').trim() })
        const out = (stdout || stderr || '').trim()
        const m = out.match(/(\d+\.\d+(?:\.\d+)?)/)
        resolve({ ok:true, version: m ? m[1] : out, raw: out, path: cli })
      })
      proc.on('error', e => resolve({ ok:false, error: e.message }))
    } catch (e) { resolve({ ok:false, error: e.message }) }
  })
})

// Renderer can pull the current RPC subsystem status at any time so the
// indicator dots in Settings show the right state on first open.
ipcMain.handle('rpc:getStatus', () => _rpcStatus)

// Live-update reconnect/AFK/telemetry settings without re-launching the game.
// Lets the user toggle behaviour mid-session and have it take effect on the
// next tick. If the game isn't running, the values are applied at next launch.
ipcMain.handle('rpc:applyOptions', (_, opts) => {
  if (!opts) return { ok:false }
  const wasAdvanced = _rpcAdvanced
  if (opts.advanced !== undefined) _rpcAdvanced = !!opts.advanced
  // If advanced was just toggled, restart the telemetry watcher and refresh
  // the activity so the Driving/Near lines appear or disappear immediately.
  if (wasAdvanced !== _rpcAdvanced) {
    if (_gameStillRunning() && _rpcConnArgs) {
      _startTelemetryWatcher({
        telemetryEnabled: _telemetryEnabled,
        telemetryPath:    _telemetryPath,
      }, _rpcConnArgs.logFn)
      _refreshDiscordActivity()
    }
  }
  const wasReconnectEnabled = _rpcReconnectEnabled
  if (opts.autoReconnect !== undefined) _rpcReconnectEnabled = !!opts.autoReconnect
  // If reconnect was just turned off, cancel any pending timer.
  if (wasReconnectEnabled && !_rpcReconnectEnabled && _rpcReconnectTimer) {
    clearTimeout(_rpcReconnectTimer); _rpcReconnectTimer = null
  }
  // If reconnect was just turned back on after a "gave-up" state, reset
  // the counter so the user gets another 3 attempts.
  if (!wasReconnectEnabled && _rpcReconnectEnabled) {
    _rpcReconnectAttempts = 0
    _pushRpcStatus({ reconnect:{ attempt:0 } })
    if (!_rpcSocket && _gameStillRunning() && _rpcConnArgs) _scheduleReconnect('user-toggle')
  }
  // AFK: restart the watcher with new minutes. Only when game is running.
  if (opts.afkEnabled !== undefined || opts.afkMinutes !== undefined) {
    if (_gameStillRunning() && _rpcConnArgs) {
      _startAfkWatcher({
        afkEnabled: opts.afkEnabled !== undefined ? opts.afkEnabled : _afkEnabled,
        afkMinutes: opts.afkMinutes !== undefined ? opts.afkMinutes : _afkMinutes,
        ets2mpLogsDir: _rpcConnArgs.ets2mpLogsDir,
      }, _rpcConnArgs.logFn)
    } else {
      if (opts.afkEnabled !== undefined) _afkEnabled = !!opts.afkEnabled
      if (opts.afkMinutes !== undefined) _afkMinutes = Math.max(1, Number(opts.afkMinutes) || 5)
    }
  }
  // Telemetry: same — restart the watcher with new path/enabled flag.
  if (opts.telemetryEnabled !== undefined || opts.telemetryPath !== undefined) {
    if (_gameStillRunning() && _rpcConnArgs) {
      _startTelemetryWatcher({
        telemetryEnabled: opts.telemetryEnabled !== undefined ? opts.telemetryEnabled : _telemetryEnabled,
        telemetryPath:    opts.telemetryPath    !== undefined ? opts.telemetryPath    : _telemetryPath,
      }, _rpcConnArgs.logFn)
    } else {
      if (opts.telemetryEnabled !== undefined) _telemetryEnabled = !!opts.telemetryEnabled
      if (opts.telemetryPath    !== undefined) _telemetryPath    = String(opts.telemetryPath || '').trim()
    }
  }
  return { ok:true, status: _rpcStatus }
})

// ── Standalone Wine ───────────────────────────────────────────────────────────
// All standalone wine artefacts live under one app-support dir so they are
// never mixed with the user's CrossOver installation.
const SW_DIR       = path.join(os.homedir(), 'Library', 'Application Support', 'TruckersMP-Launcher')
const SW_WINE_DIR  = path.join(SW_DIR, 'wine')          // legacy single-wine dir (pre-multi-wine; kept as fallback)
const SW_WINES_DIR = path.join(SW_DIR, 'wines')         // multi-wine parent — each install lives in wines/<slug>/
const SW_DXMT_DIR  = path.join(SW_DIR, 'dxmt')          // extracted DXMT DLLs

// nohero765/wine-builds- — stable signed builds (primary source)
const NOHERO_API   = 'https://api.github.com/repos/nohero765/wine-builds-/releases?per_page=10'
// BobTheHero6767/testing-wine-builds — dev builds, shown only when nohero765 has no releases
const BOB_API      = 'https://api.github.com/repos/BobTheHero6767/testing-wine-builds/releases?per_page=10'

// Recursively walk dir and return the first file whose name is in names[]
function findBinary(dir, names, depth) {
  if (depth > 8) return null
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findBinary(full, names, depth + 1)
      if (found) return found
    } else if (names.includes(entry.name)) {
      return full
    }
  }
  return null
}

// Locate the active standalone Wine binary.
// Priority: 1) active slug in SW_WINES_DIR, 2) any slug (first alphabetically), 3) legacy SW_WINE_DIR.
function standaloneWineBin() {
  const s = loadSettings()
  const activeSlug = s.standalonWineSlug || ''

  function findInRoot(rootDir) {
    if (!rootDir || !fs.existsSync(rootDir)) return null
    const srv = findBinary(rootDir, ['wineserver'], 0)
    if (srv) {
      const d = path.dirname(srv)
      for (const n of ['wine64', 'wine']) { const p = path.join(d, n); if (fs.existsSync(p)) return p }
    }
    return findBinary(rootDir, ['wine64', 'wine'], 0)
  }

  // 1. Active slug
  if (activeSlug) { const b = findInRoot(path.join(SW_WINES_DIR, activeSlug)); if (b) return b }

  // 2. Any installed slug (first alphabetically)
  if (fs.existsSync(SW_WINES_DIR)) {
    try {
      for (const e of fs.readdirSync(SW_WINES_DIR).sort()) {
        const d = path.join(SW_WINES_DIR, e)
        try { if (!fs.statSync(d).isDirectory()) continue } catch { continue }
        const b = findInRoot(d); if (b) return b
      }
    } catch {}
  }

  // 3. Legacy single-wine dir (pre-multi-wine installs)
  return findInRoot(SW_WINE_DIR)
}

// Copy DXMT Windows-side DLLs into the bottle's system32 so Wine's native-DLL
// lookup ("dxgi=n,b" etc.) can find them. Wine only searches drive_c/windows/system32
// for native overrides — it does not understand custom paths.
//
// Optional winemetalPath: if the DXMT archive included a macOS-side bridge library
// (winemetal.so / winemetal.dylib / libDXMTAPI.dylib) pass its path here to have it
// deployed into Wine's lib/wine/x86_64-unix/. If the archive did not include one the
// argument should be null/undefined — the copy is then silently skipped (meaning the
// Wine package's own copy, if any, is left untouched).
//
// For YAAGL wine that ships its own compatible winemetal.so this should be null so we
// do NOT overwrite it; the YAAGL copy was built against YAAGL's patched source tree.
// For Gcenx Wine the archive's winemetal (if present) should be deployed because
// Gcenx Wine may not ship a winemetal that is compatible with the downloaded DXMT build.
//
// Optional winePath: path to the wine binary. Required to locate lib/wine/x86_64-unix/.
// If omitted, the winemetal deploy step is skipped even when winemetalPath is set.
//
// The DLL copy is fast (~500 KB each) and idempotent.
function ensureDxmtInBottle(bottlePath, dxmtDir, winemetalPath, winePath) {
  if (!dxmtDir || !fs.existsSync(dxmtDir)) return
  const sys32    = path.join(bottlePath, 'drive_c', 'windows', 'system32')
  const syswow64 = path.join(bottlePath, 'drive_c', 'windows', 'syswow64')
  if (!fs.existsSync(sys32)) return

  // Copy 64-bit (or whatever dxmtDir contains) DLLs into system32
  const dlls = fs.readdirSync(dxmtDir).filter(f => f.toLowerCase().endsWith('.dll'))
  for (const dll of dlls) {
    try { fs.copyFileSync(path.join(dxmtDir, dll), path.join(sys32, dll)) } catch {}
  }

  // If dxmtDir is an x86_64/x64 directory, also copy its sibling x86 directory
  // into syswow64 so 32-bit Wine subprocesses (e.g. WoW64 helpers) also get DXMT.
  // DXMT uses "x86_64-windows" not bare "x86_64", so match the START of the name
  // only (no $ anchor). The 32-bit sibling is "i386-windows" in modern DXMT releases.
  const baseName = path.basename(dxmtDir).toLowerCase()
  const is64Dir  = /^(x86.?64|x64|win64)/i.test(baseName)
  if (is64Dir && fs.existsSync(syswow64)) {
    const parent = path.dirname(dxmtDir)
    const x86Dir = ['i386-windows', 'i386', 'x86', 'x32', 'win32']
      .map(n => path.join(parent, n))
      .find(d => fs.existsSync(d))
    if (x86Dir) {
      const x86Dlls = fs.readdirSync(x86Dir).filter(f => f.toLowerCase().endsWith('.dll'))
      for (const dll of x86Dlls) {
        try { fs.copyFileSync(path.join(x86Dir, dll), path.join(syswow64, dll)) } catch {}
      }
    }
  }

  // ── macOS-side Metal bridge library (winemetal) ──────────────────────────────
  // If winemetalPath was not explicitly provided by the caller, scan the parent
  // tree of dxmtDir (the extracted archive root) for known bridge library names.
  // This handles callers that don't thread the path through explicitly.
  if (!winemetalPath) {
    const bridgeNames = new Set(['winemetal.so', 'winemetal.dylib', 'libdxmtapi.dylib'])
    const scanForBridge = (dir, depth) => {
      if (depth > 4 || winemetalPath) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.isFile() && bridgeNames.has(e.name.toLowerCase())) {
          winemetalPath = path.join(dir, e.name); return
        }
        if (e.isDirectory()) scanForBridge(path.join(dir, e.name), depth + 1)
        if (winemetalPath) return
      }
    }
    // Start one level above dxmtDir (the x86_64/ sub-dir) to reach the archive root
    scanForBridge(path.dirname(dxmtDir), 0)
  }

  // Deploy the bridge library only when both the path is known and we have the
  // Wine binary so we can locate lib/wine/x86_64-unix/.
  if (winemetalPath && fs.existsSync(winemetalPath) && winePath) {
    // Wine lays out as: <root>/bin/wine, <root>/lib/wine/x86_64-unix/
    const wineUnixLib = path.resolve(path.dirname(winePath), '..', 'lib', 'wine', 'x86_64-unix')
    if (fs.existsSync(wineUnixLib)) {
      const destName = path.basename(winemetalPath)
      const dest = path.join(wineUnixLib, destName)
      try {
        // Back up the existing file before overwriting so a rollback is possible
        if (fs.existsSync(dest)) {
          try { fs.renameSync(dest, dest + '.bak') } catch {}
        }
        fs.copyFileSync(winemetalPath, dest)
        console.log('[DXMT] Deployed', destName, '→', dest)
      } catch(e) {
        console.warn('[DXMT] Could not deploy', destName, 'to Wine lib dir:', e.message)
      }
    } else {
      console.log('[DXMT] lib/wine/x86_64-unix not found alongside Wine binary — skipping winemetal deploy')
    }
  }

  // ── Deploy to Wine's lib/wine/x86_64-windows/ (builtin-dll=true mode) ────────
  // GitHub Actions DXMT artifacts are built with -Dwine_builtin_dll=true: the core
  // DLLs must live in <wine>/lib/wine/x86_64-windows/ to be treated as Wine builtins.
  // We deploy to BOTH system32 (native) and the wine lib dir (builtin) so the correct
  // path wins regardless of which DXMT build variant the user has downloaded.
  if (winePath && fs.existsSync(winePath)) {
    const wineLibWin = path.resolve(path.dirname(winePath), '..', 'lib', 'wine', 'x86_64-windows')
    if (fs.existsSync(wineLibWin)) {
      const coreNames = new Set(['dxgi.dll', 'd3d11.dll', 'd3d10core.dll', 'd3d10.dll', 'd3d10_1.dll', 'winemetal.dll'])
      for (const dll of dlls) {
        if (coreNames.has(dll.toLowerCase())) {
          try { fs.copyFileSync(path.join(dxmtDir, dll), path.join(wineLibWin, dll)) } catch {}
        }
      }
      console.log('[DXMT] Deployed core DLLs → lib/wine/x86_64-windows/ (builtin mode)')
    }
  }

  // ── Write persistent DLL overrides to WINEPREFIX registry ───────────────────
  // ETS2 launched via Steam's Play button does NOT inherit WINEDLLOVERRIDES from the
  // launcher process. Writing overrides to user.reg makes them apply to ALL processes
  // in this WINEPREFIX — including games started from inside Steam — without any env var.
  setDxmtDllOverridesInRegistry(bottlePath)
}

// ── Persistent DXMT registry DLL overrides ────────────────────────────────────
// Writes dxgi/d3d11/d3d10core as "native,builtin" in the WINEPREFIX user.reg so
// Wine always loads DXMT for any process in this prefix — no env var required.
// Called every time DLLs are deployed so the registry stays in sync.
function setDxmtDllOverridesInRegistry(bottlePath) {
  const userRegPath = path.join(bottlePath, 'user.reg')
  if (!fs.existsSync(userRegPath)) {
    console.log('[DXMT] user.reg not found — DLL overrides will be applied after wineboot runs')
    return
  }
  const dllsToSet   = ['d3d10', 'd3d10_1', 'd3d10core', 'd3d11', 'dxgi']
  const overrideVal = 'native,builtin'
  try {
    let content = fs.readFileSync(userRegPath, 'utf8')
    const nl = content.includes('\r\n') ? '\r\n' : '\n'
    // Wine uses double-backslash as path separator in .reg key names
    const sectionMarker = '[Software\\\\Wine\\\\DllOverrides]'
    const sectionIdx = content.indexOf(sectionMarker)
    if (sectionIdx === -1) {
      // Section does not exist — append it
      const ts = Math.floor(Date.now() / 1000)
      const entries = dllsToSet.map(d => `"${d}"="${overrideVal}"`).join(nl)
      content = content.trimEnd() + `${nl}${nl}${sectionMarker}${nl}${ts}${nl}${entries}${nl}`
    } else {
      // Section exists — update or add each key without touching the rest of the file
      const nextSec = content.indexOf(`${nl}[`, sectionIdx + sectionMarker.length)
      const secEnd  = nextSec === -1 ? content.length : nextSec
      let section   = content.slice(sectionIdx, secEnd)
      for (const dll of dllsToSet) {
        const keyRe   = new RegExp(`^"${dll}"=.*`, 'mi')
        const keyLine = `"${dll}"="${overrideVal}"`
        if (keyRe.test(section)) {
          section = section.replace(keyRe, keyLine)
        } else {
          // Insert after the timestamp line (line 2 of the section block)
          const firstNl  = section.indexOf(nl)
          const secondNl = section.indexOf(nl, firstNl + nl.length)
          const at = secondNl !== -1 ? secondNl + nl.length : section.length
          section = section.slice(0, at) + keyLine + nl + section.slice(at)
        }
      }
      content = content.slice(0, sectionIdx) + section + content.slice(secEnd)
    }
    fs.writeFileSync(userRegPath, content, 'utf8')
    console.log('[DXMT] user.reg: dxgi/d3d11/d3d10core=native,builtin (persistent overrides)')
  } catch(e) {
    console.warn('[DXMT] Could not update user.reg:', e.message)
  }
}

// Build a correct env object for any standalone Wine spawn.
// Adds the wine bin dir to PATH so wine can find wineserver, wineloader, etc.
// Adds multiple candidate lib dirs so native macOS libs (Metal, MoltenVK) load correctly.
function standaloneWineEnv(winePath, bottlePath, extra = {}) {
  const wineDir = path.dirname(winePath)
  // Standard lib dir alongside bin/
  const wineLib = path.join(wineDir, '..', 'lib')
  // Gcenx .app bundles may also ship frameworks in Contents/Frameworks
  const wineFrameworks = path.join(wineDir, '..', '..', '..', 'Frameworks')
  // Some builds put extra libs at Contents/Resources/lib or Contents/lib
  const wineResLib = path.join(wineDir, '..', '..', 'lib')
  const wineMacLib = path.join(wineDir, '..', '..', '..', 'lib')
  const dyldPaths = [
    wineLib, wineFrameworks, wineResLib, wineMacLib,
    process.env.DYLD_FALLBACK_LIBRARY_PATH || '',
  ].filter(Boolean).join(':')
  return {
    ...process.env,
    PATH: wineDir + ':' + (process.env.PATH || ''),
    DYLD_FALLBACK_LIBRARY_PATH: dyldPaths,
    WINEPREFIX:  bottlePath,
    WINEMSYNC:   '1',
    // WINEESYNC=1: required by YAAGL wine and improves stability on Wine-Staging
    // builds. Has no effect on builds that don't support it.
    WINEESYNC:   '1',
    WINEDEBUG:   '-all',
    // Force macOS-native window driver (winemac.drv). If DISPLAY is inherited
    // from the environment (e.g. XQuartz is installed), Wine switches to X11
    // mode and all windows silently fail to appear when XQuartz is not running.
    DISPLAY:     undefined,
    // Ensure Wine and its helper processes can create Unix socket files.
    // Missing TMPDIR on macOS causes wineserver to fail to bind its socket,
    // which makes every spawned Wine process exit immediately without a window.
    TMPDIR:      process.env.TMPDIR || os.tmpdir(),
    ...extra,
  }
}

// Simple HTTPS GET that follows one redirect and returns the body Buffer
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const doGet = (u, depth) => {
      if (depth > 5) return reject(new Error('Too many redirects'))
      const mod = u.startsWith('https') ? require('https') : require('http')
      mod.get(u, { headers: { 'User-Agent': 'TruckersMP-Launcher' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doGet(res.headers.location, depth + 1)
        }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end',  () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }).on('error', reject)
    }
    doGet(url, 0)
  })
}

// Active download handle — used by standalone:cancelWineDownload
let _activeWineDownloadReq = null

// Stream a URL to a file, sending progress events to renderer
function downloadToFile(url, dest, progressEvent) {
  return new Promise((resolve, reject) => {
    const doGet = (u, depth) => {
      if (depth > 5) return reject(new Error('Too many redirects'))
      const mod = u.startsWith('https') ? require('https') : require('http')
      const req = mod.get(u, { headers: { 'User-Agent': 'TruckersMP-Launcher' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doGet(res.headers.location, depth + 1)
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let received = 0
        const out = fs.createWriteStream(dest)
        _activeWineDownloadReq = { cancel: () => { req.destroy(); out.destroy(); reject(new Error('cancelled')) } }
        res.on('data', chunk => {
          received += chunk.length
          out.write(chunk)
          if (progressEvent && mainWindow) {
            mainWindow.webContents.send(progressEvent, { received, total })
          }
        })
        res.on('end', () => { _activeWineDownloadReq = null; out.end(); resolve() })
        res.on('error', err => { _activeWineDownloadReq = null; out.destroy(); reject(err) })
      }).on('error', reject)
      _activeWineDownloadReq = { cancel: () => { req.destroy(); reject(new Error('cancelled')) } }
    }
    doGet(url, 0)
  })
}

ipcMain.handle('standalone:cancelWineDownload', () => {
  if (_activeWineDownloadReq) {
    _activeWineDownloadReq.cancel()
    _activeWineDownloadReq = null
    return { ok: true }
  }
  return { ok: false }
})

// Fetch available wine versions.
// Logic: try nohero765/wine-builds- first (Stable). If it has releases → show only those.
// If nohero765 has NO releases → fall back and show BobTheHero6767 (Dev).
ipcMain.handle('standalone:fetchWineRelease', async () => {
  try {
    function parseVersions(rels, extra) {
      const out = []
      for (const rel of (Array.isArray(rels) ? rels : [])) {
        const assets = rel.assets || []
        const asset = assets.find(a => /\.tar\.(xz|gz)$/i.test(a.name))
        if (!asset) continue
        const tag = rel.tag_name || ''
        const vm  = asset.name.match(/(\d+)\.(\d+)/) || tag.match(/(\d+)\.(\d+)/)
        const major = vm ? parseInt(vm[1]) : 0
        const minor = vm ? parseInt(vm[2]) : 0
        out.push({
          name:    asset.name,
          url:     asset.browser_download_url,
          size:    asset.size,
          version: (rel.name || tag).trim() || asset.name,
          major, minor,
          ...extra,
        })
      }
      return out
    }

    // Fetch nohero765/wine-builds- (Stable)
    let noheroVersions = []
    try {
      const body = await httpsGet(NOHERO_API)
      noheroVersions = parseVersions(JSON.parse(body.toString()), { isStable: true, isDevWine: false })
    } catch(e) {
      console.warn('[nohero fetch]', e.message)
    }

    // Fetch BobTheHero6767/testing-wine-builds (Dev)
    let wineTestVersions = []
    try {
      const wtBody = await httpsGet(BOB_API)
      wineTestVersions = parseVersions(JSON.parse(wtBody.toString()), { isDevWine: true, isStable: false })
    } catch(e) {
      console.warn('[bob-wine fetch]', e.message)
    }

    // Show only nohero765 if it has releases; otherwise fall back to BobTheHero (Dev)
    const useNohero = noheroVersions.length > 0
    const versions  = useNohero ? noheroVersions : []
    const devVersions = useNohero ? [] : wineTestVersions

    if (!versions.length && !devVersions.length) {
      return { ok:false, error:'No wine releases found. Check https://github.com/nohero765/wine-builds-/releases manually.' }
    }

    return { ok:true, versions, wineTestVersions: devVersions, useNohero }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// Delete the downloaded standalone Wine directory
ipcMain.handle('standalone:deleteWine', async (_, slug) => {
  try {
    if (slug) {
      // Multi-wine: delete the specific slug directory
      const slugDir = path.join(SW_WINES_DIR, slug)
      if (fs.existsSync(slugDir)) fs.rmSync(slugDir, { recursive:true, force:true })
      // Clear active slug from settings if it matched
      const s = loadSettings()
      if (s.standalonWineSlug === slug) { s.standalonWineSlug = ''; saveSettings(s) }
    } else {
      // Legacy fallback: delete old single-wine dir
      if (fs.existsSync(SW_WINE_DIR)) fs.rmSync(SW_WINE_DIR, { recursive:true, force:true })
    }
    return { ok:true }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// List all installed Wine versions (multi-wine manager)
ipcMain.handle('standalone:listWines', () => {
  const s = loadSettings()
  const activeSlug = s.standalonWineSlug || ''
  const wines = []
  if (fs.existsSync(SW_WINES_DIR)) {
    try {
      for (const entry of fs.readdirSync(SW_WINES_DIR).sort()) {
        const dir = path.join(SW_WINES_DIR, entry)
        try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
        // Locate the wine binary (skip dirs without one — incomplete downloads)
        let bin = null
        const srv = findBinary(dir, ['wineserver'], 0)
        if (srv) {
          const d = path.dirname(srv)
          for (const n of ['wine64', 'wine']) { const p = path.join(d, n); if (fs.existsSync(p)) { bin = p; break } }
        }
        if (!bin) bin = findBinary(dir, ['wine64', 'wine'], 0)
        if (!bin) continue
        let version = ''
        try {
          const { execFileSync } = require('child_process')
          version = execFileSync(bin, ['--version'], {
            timeout:4000, encoding:'utf8', env:{ ...process.env, WINEDEBUG:'-all' },
          }).trim()
        } catch {}
        let fileName = '', releaseName = ''
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, '.wine-meta.json'), 'utf8'))
          fileName    = meta.fileName    || ''
          releaseName = meta.releaseName || ''
        } catch {}
        wines.push({ slug: entry, version: version || entry, active: entry === activeSlug, bin, fileName, releaseName })
      }
    } catch {}
  }
  // Also include the legacy single-wine dir (pre-multi-wine installs) if it has a valid binary
  if (fs.existsSync(SW_WINE_DIR)) {
    try {
      let legacyBin = null
      const legacySrv = findBinary(SW_WINE_DIR, ['wineserver'], 0)
      if (legacySrv) {
        const d = path.dirname(legacySrv)
        for (const n of ['wine64', 'wine']) { const p = path.join(d, n); if (fs.existsSync(p)) { legacyBin = p; break } }
      }
      if (!legacyBin) legacyBin = findBinary(SW_WINE_DIR, ['wine64', 'wine'], 0)
      if (legacyBin) {
        let version = ''
        try {
          const { execFileSync } = require('child_process')
          version = execFileSync(legacyBin, ['--version'], {
            timeout:4000, encoding:'utf8', env:{ ...process.env, WINEDEBUG:'-all' },
          }).trim()
        } catch {}
        // Only add if we haven't already found this slug in SW_WINES_DIR
        if (!wines.find(w => w.slug === '__legacy')) {
          let legacyFileName = ''
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(SW_WINE_DIR, '.wine-meta.json'), 'utf8'))
            legacyFileName = meta.fileName || ''
          } catch {}
          let legacyReleaseName = ''
          try { legacyReleaseName = JSON.parse(fs.readFileSync(path.join(SW_WINE_DIR, '.wine-meta.json'), 'utf8')).releaseName || '' } catch {}
          wines.push({ slug: '__legacy', version: version ? `${version} (legacy)` : 'Wine (legacy)', active: activeSlug === '__legacy', bin: legacyBin, fileName: legacyFileName, releaseName: legacyReleaseName })
        }
      }
    } catch {}
  }

  // Auto-mark the first entry active if none is selected yet
  if (wines.length && !wines.some(w => w.active)) wines[0].active = true
  return wines
})

// Set the active Wine installation by slug
ipcMain.handle('standalone:setActiveWine', (_, slug) => {
  try {
    const s = loadSettings(); s.standalonWineSlug = slug; saveSettings(s)
    return { ok:true }
  } catch(e) { return { ok:false, error: e.message } }
})

// Download + extract a Wine tarball into SW_WINES_DIR/<slug>/ (or legacy SW_WINE_DIR if no slug)
ipcMain.handle('standalone:downloadWine', async (_, url, slug, releaseName) => {
  try {
    const targetDir = slug ? path.join(SW_WINES_DIR, slug) : SW_WINE_DIR
    if (slug) fs.mkdirSync(SW_WINES_DIR, { recursive:true })
    fs.mkdirSync(SW_DIR, { recursive:true })
    const tarPath = path.join(SW_DIR, 'wine-staging.tar.xz')
    // Download
    await downloadToFile(url, tarPath, 'standalone:wineProgress')
    // Clear old extraction for this slot
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive:true, force:true })
    fs.mkdirSync(targetDir, { recursive:true })
    // Extract — do NOT use --strip-components (archive layout varies between Gcenx and YAAGL)
    mainWindow?.webContents.send('standalone:wineProgress', { phase:'extracting' })
    await new Promise((resolve, reject) => {
      const proc = spawn('tar', ['xJf', tarPath, '-C', targetDir])
      proc.stderr.on('data', d => console.warn('tar wine:', d.toString()))
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)))
      proc.on('error', reject)
    })
    fs.unlinkSync(tarPath)
    const wineBin = findBinary(targetDir, ['wine64', 'wine'], 0)
    if (!wineBin) return { ok:false, error:'Wine extracted but wine64/wine binary not found inside the archive. Please report this at github.com/nohero765.' }
    try { fs.chmodSync(wineBin, 0o755) } catch {}
    // Remove macOS quarantine attribute — shows the native password prompt to the user.
    // This clears the "App is damaged and can't be opened" Gatekeeper error on Wine binaries.
    mainWindow?.webContents.send('standalone:wineProgress', { phase:'removing-quarantine' })
    try {
      // Pass targetDir via osascript argv so no manual shell-escaping is needed.
      // AppleScript's "quoted form of" handles all special characters in the path.
      const { execFileSync } = require('child_process')
      execFileSync('osascript', [
        '-e', 'on run argv',
        '-e', '  do shell script "xattr -rc " & quoted form of (item 1 of argv) with administrator privileges',
        '-e', 'end run',
        '--', targetDir
      ], { timeout: 60000 })
    } catch (xattrErr) {
      // Error code -128 means the user clicked Cancel in the password dialog — not fatal.
      const cancelled = xattrErr.message?.includes('-128')
      console.warn('xattr step skipped or failed:', xattrErr.message)
      mainWindow?.webContents.send('log:line', {
        kind: 'warn',
        text: cancelled
          ? '⚠ Password prompt was cancelled — Wine may show an "App is damaged" error on first launch. Re-run Wine setup to try again.'
          : `⚠ xattr failed (${xattrErr.message}) — Wine may show an "App is damaged" error. Re-run Wine setup to try again.`,
        ts: Date.now()
      })
    }
    // Save metadata so the wine manager can show the correct release name
    try {
      fs.writeFileSync(path.join(targetDir, '.wine-meta.json'), JSON.stringify({
        slug,
        url,
        fileName:    url ? url.split('/').pop() : '',
        releaseName: releaseName || '',
        installedAt: Date.now()
      }), 'utf8')
    } catch {}
    // Set as the active wine
    if (slug) {
      const s = loadSettings(); s.standalonWineSlug = slug; saveSettings(s)
    }
    return { ok:true, wineBin }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// Create a wine bottle (wineprefix) using standalone wine
ipcMain.handle('standalone:createBottle', async (_, bottlePath) => {
  try {
    const wineBin = standaloneWineBin()
    if (!wineBin) return { ok:false, error:'Standalone Wine not installed. Complete Step 1 first.' }
    // Use a sensible default if caller did not provide a path
    if (!bottlePath || !bottlePath.trim()) bottlePath = path.join(SW_DIR, 'TruckersmpBottle')
    // 1. Create the folder
    fs.mkdirSync(bottlePath, { recursive:true })
    // 2. Run wine --init to create the bottle (wineboot under the hood)
    const { execFileSync } = require('child_process')
    const wineEnv = {
      ...process.env,
      WINEPREFIX: bottlePath,
      WINEARCH:   'win64',
      WINEMSYNC:  '1',
      WINEDEBUG:  '-all',
    }
    try {
      execFileSync(wineBin, ['--init'], { env: wineEnv, stdio: 'pipe', timeout: 60000 })
    } catch (initErr) {
      // wine --init frequently exits non-zero because MoltenVK dumps hundreds of lines of
      // Vulkan extension info to stderr — this is NOT a real failure.  Check whether
      // drive_c was actually created before treating it as an error.
      const driveC = path.join(bottlePath, 'drive_c')
      if (!fs.existsSync(driveC)) {
        // Strip the MoltenVK / VK_* noise and surface only the first meaningful line
        const raw = initErr.message || String(initErr)
        const meaningful = raw.split('\n').find(
          l => l.trim() && !/\[mvk-info\]|VK_[A-Z_]+|Vulkan version|MoltenVK/i.test(l)
        ) || raw.slice(0, 300)
        return { ok: false, error: meaningful }
      }
      // drive_c exists → bottle was successfully initialised despite the non-zero exit
    }
    // 3. Final verification
    const driveC = path.join(bottlePath, 'drive_c')
    if (!fs.existsSync(driveC)) return { ok:false, error:`drive_c not found at ${driveC}` }
    return { ok:true, bottlePath }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// Kill wineserver for a given bottle so Wine stops reopening windows
ipcMain.handle('standalone:killWineserver', async (_, bottlePath) => {
  try {
    const wineBin  = standaloneWineBin()
    const wineDir  = wineBin ? path.dirname(wineBin) : null
    const winesrv  = wineDir ? path.join(wineDir, 'wineserver') : null
    const env      = { ...process.env, WINEPREFIX: bottlePath }
    if (winesrv && fs.existsSync(winesrv)) {
      const { execFileSync } = require('child_process')
      try { execFileSync(winesrv, ['-k'], { env, stdio:'ignore', timeout:5000 }) } catch {}
    }
    // Belt-and-braces: also pkill any wineserver with this prefix
    try { spawn('pkill', ['-f', `WINEPREFIX=${bottlePath}`], { stdio:'ignore' }).unref() } catch {}
    return { ok:true }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// Download SteamSetup.exe to a temp location
ipcMain.handle('standalone:downloadSteam', async () => {
  try {
    const dest = path.join(os.tmpdir(), 'SteamSetup.exe')
    const url  = 'https://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe'
    await downloadToFile(url, dest, 'standalone:steamProgress')
    return { ok:true, exePath: dest }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// Run an .exe (SteamSetup.exe or user-provided) inside the standalone bottle via wine
ipcMain.handle('standalone:runExe', async (_, { exePath, bottlePath }) => {
  try {
    const wineBin = standaloneWineBin()
    if (!wineBin) return { ok:false, error:'Standalone Wine not installed.' }
    if (!fs.existsSync(exePath)) return { ok:false, error:`Installer not found: ${exePath}` }
    const env = { ...process.env, WINEPREFIX: bottlePath, WINEDEBUG:'-all', WINEMSYNC:'1' }
    // We launch and do NOT wait for it to close — Steam installer runs in background
    // and the user installs ETS2 while it's running. We report launched.
    spawn(wineBin, [exePath], { env, detached:true, stdio:'ignore' }).unref()
    return { ok:true }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// Shared helper: extract a DXMT .tar.gz and locate the DLLs + macOS bridge library
async function installDxmtFromTar(tarPath) {
  if (fs.existsSync(SW_DXMT_DIR)) fs.rmSync(SW_DXMT_DIR, { recursive:true, force:true })
  fs.mkdirSync(SW_DXMT_DIR, { recursive:true })
  await new Promise((resolve, reject) => {
    const flag = tarPath.endsWith('.tar.xz') ? 'xJf' : 'xzf'
    const proc = spawn('tar', [flag, tarPath, '-C', SW_DXMT_DIR])
    proc.stderr.on('data', d => console.warn('tar dxmt:', d.toString()))
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)))
    proc.on('error', reject)
  })
  function findAllFiles(dir, name, depth) {
    if (depth > 6) return []
    const results = []
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return results }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === name) results.push(full)
      else if (entry.isDirectory()) results.push(...findAllFiles(full, name, depth + 1))
    }
    return results
  }
  const allDxgi = findAllFiles(SW_DXMT_DIR, 'dxgi.dll', 0)
  if (!allDxgi.length) throw new Error('dxgi.dll not found inside the archive. Make sure this is a DXMT release tarball.')
  const is64Seg = seg => /^(x86.?64|x64|win64)/i.test(seg)
  const dxgiPath = allDxgi.find(p => p.split(/[/\\]/).some(is64Seg)) || allDxgi[0]
  const dxmtDir = path.dirname(dxgiPath)
  const bridgeNames = ['winemetal.so', 'winemetal.dylib', 'libdxmtapi.dylib']
  let winemetalPath = null
  const findWinemetal = (dir, depth) => {
    if (depth > 6 || winemetalPath) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isFile() && bridgeNames.includes(entry.name.toLowerCase())) { winemetalPath = path.join(dir, entry.name); return }
      if (entry.isDirectory()) findWinemetal(path.join(dir, entry.name), depth + 1)
      if (winemetalPath) return
    }
  }
  findWinemetal(SW_DXMT_DIR, 0)
  if (winemetalPath) console.log('[DXMT] Found macOS bridge library:', winemetalPath)
  else console.log('[DXMT] No winemetal bridge library in this archive (Wine package is expected to supply it)')
  const tarFileName = path.basename(tarPath)
  const verMatch = tarFileName.match(/(\d+\.\d+(?:\.\d+)?)/)
  const dxmtFileVersion = verMatch ? verMatch[1] : ''
  return { ok:true, dxmtDir, winemetalPath, dxmtFileVersion }
}

// Accept a DXMT .tar.gz, extract it, find the DLLs, store their parent dir
ipcMain.handle('standalone:installDxmt', async (_, tarPath) => {
  try {
    if (!fs.existsSync(tarPath)) return { ok:false, error:`File not found: ${tarPath}` }
    return await installDxmtFromTar(tarPath)
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// Fetch the latest DXMT release from GitHub, download and install automatically
ipcMain.handle('standalone:autoInstallDxmt', async () => {
  try {
    const sendDxmtStatus = msg => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('standalone:dxmtStatus', msg) }
    sendDxmtStatus('Fetching release info from GitHub…')
    const apiData = await httpsGet('https://api.github.com/repos/3Shain/dxmt/releases/latest')
    const release = JSON.parse(apiData.toString())
    const assets = release.assets || []
    const asset = assets.find(a => a.name.includes('arm64') && a.name.endsWith('.tar.gz'))
              || assets.find(a => a.name.endsWith('.tar.gz'))
    if (!asset) return { ok:false, error:'No .tar.gz asset found in the latest release' }
    const sizeMB = (asset.size / 1024 / 1024).toFixed(1)
    sendDxmtStatus(`Downloading ${asset.name} (${sizeMB} MB)…`)
    const tmpPath = path.join(os.tmpdir(), asset.name)
    await downloadToFile(asset.browser_download_url, tmpPath, null)
    sendDxmtStatus('Extracting archive…')
    const result = await installDxmtFromTar(tmpPath)
    try { fs.unlinkSync(tmpPath) } catch {}
    return result
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// Open the Wine log file in Finder
ipcMain.handle('standalone:openSteamLog', async () => {
  const { shell } = require('electron')
  const candidates = [
    path.join(SW_DIR, 'steam-wine.log'),
    path.join(SW_DIR, 'crossover-steam.log'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      shell.showItemInFolder(p)
      return { ok: true, path: p }
    }
  }
  return { ok: false, error: 'No Wine log file found yet. Launch Steam first, then try again.' }
})

// Read the last N lines of the Wine debug log
ipcMain.handle('standalone:readSteamLog', async () => {
  // Show the most recent log — CrossOver writes crossover-steam.log, standalone writes steam-wine.log
  const candidates = [
    path.join(SW_DIR, 'crossover-steam.log'),
    path.join(SW_DIR, 'steam-wine.log'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8')
        const lines = content.split('\n').filter(l => l.trim())
        if (!lines.length) continue
        return { ok:true, content: lines.slice(-120).join('\n'), path: p }
      } catch {}
    }
  }
  return { ok:true, content: 'No Steam Wine log found yet.\nLaunch Steam first, then check again.' }
})

// ── Clear Steam CEF HTML cache ──────────────────────────────────────────────
// Steam's CEF renderer caches pages under:
//   drive_c/users/<user>/AppData/Local/Steam/htmlcache
// A stale or GPU-rendered cache can cause the login screen to stay black even
// after the OpenGL version is patched. Deleting it forces a clean re-render.
ipcMain.handle('steam:clearHtmlCache', async (_, bottlePath) => {
  if (!bottlePath || !fs.existsSync(bottlePath)) {
    return { ok:false, error: 'Bottle path not set or does not exist.' }
  }
  try {
    const usersDir = path.join(bottlePath, 'drive_c', 'users')
    if (!fs.existsSync(usersDir)) return { ok:false, error: 'No users directory found in bottle.' }

    const userNames = fs.readdirSync(usersDir)
    let cleared = 0
    let totalBytes = 0
    for (const u of userNames) {
      const cacheDir = path.join(usersDir, u, 'AppData', 'Local', 'Steam', 'htmlcache')
      if (fs.existsSync(cacheDir)) {
        // Count approximate size before deleting
        try {
          const { execSync: ex } = require('child_process')
          const out = ex(`du -sk "${cacheDir}" 2>/dev/null || echo 0`, { encoding:'utf8' })
          totalBytes += (parseInt(out) || 0) * 1024
        } catch {}
        fs.rmSync(cacheDir, { recursive: true, force: true })
        cleared++
      }
    }
    if (cleared === 0) return { ok:true, msg: 'HTML cache was already empty (nothing to clear).' }
    const mb = (totalBytes / (1024*1024)).toFixed(1)
    return { ok:true, msg: `Cleared ${cleared} htmlcache folder${cleared > 1 ? 's' : ''} (${mb > 0 ? mb + ' MB' : 'unknown size'}).` }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// Check GitHub releases for a newer version of this launcher
const GITHUB_RELEASES_API = 'https://api.github.com/repos/nohero765/truckersmp-macos/releases/latest'
const { version: LAUNCHER_VERSION } = require('./package.json')
const APP_DISPLAY_VERSION = '2.0 Beta'

// Semver-aware comparison: returns true if latestTag is strictly newer than currentVer.
// Pre-release suffixes (beta/alpha/rc/dev) are stripped for numeric comparison only.
function _isNewerVersion(currentVer, latestTag) {
  const norm = s => s.replace(/^v/i, '').replace(/[^0-9.]/g, '.').replace(/\.{2,}/g, '.').replace(/^\.|\.$/g, '')
  const parts = s => norm(s).split('.').map(n => parseInt(n) || 0)
  const a = parts(currentVer), b = parts(latestTag)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ai = a[i] || 0, bi = b[i] || 0
    if (bi > ai) return true
    if (bi < ai) return false
  }
  return false
}

ipcMain.handle('app:checkUpdate', async () => {
  try {
    const buf = await httpsGet(GITHUB_RELEASES_API)
    const release = JSON.parse(buf.toString())
    const latestTag   = release.tag_name   || ''
    const htmlUrl     = release.html_url   || 'https://github.com/nohero765/truckersmp-macos/releases'
    const publishedAt = release.published_at || ''
    const releaseName = release.name || latestTag
    const body        = release.body || ''
    const hasUpdate   = _isNewerVersion(LAUNCHER_VERSION, latestTag)
    // Find a zip asset for macOS
    const assets = release.assets || []
    const zipAsset = assets.find(a => /\.zip$/i.test(a.name) && /arm64|macos|mac/i.test(a.name))
                  || assets.find(a => /\.zip$/i.test(a.name))
    const downloadUrl = zipAsset ? zipAsset.browser_download_url : htmlUrl
    const downloadSize = zipAsset ? zipAsset.size : 0
    return { ok:true, latestTag, releaseName, htmlUrl, publishedAt, current: LAUNCHER_VERSION, displayVersion: APP_DISPLAY_VERSION, hasUpdate, body, downloadUrl, downloadSize }
  } catch(e) {
    return { ok:false, error: e.message }
  }
})

// Active update download handle
let _activeUpdateReq = null

// Download and install update: download zip → extract to temp folder in AppSupport → replace .app → relaunch
ipcMain.handle('app:downloadUpdate', async (_, downloadUrl) => {
  try {
    const updateTempDir = path.join(SW_DIR, 'temp', 'update')
    fs.mkdirSync(updateTempDir, { recursive: true })
    const zipPath = path.join(SW_DIR, 'temp', 'launcher-update.zip')

    // Download
    await new Promise((resolve, reject) => {
      const doGet = (u, depth) => {
        if (depth > 5) return reject(new Error('Too many redirects'))
        const mod = u.startsWith('https') ? require('https') : require('http')
        const req = mod.get(u, { headers: { 'User-Agent': 'TruckersMP-Launcher' } }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return doGet(res.headers.location, depth + 1)
          }
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
          const total = parseInt(res.headers['content-length'] || '0', 10)
          let received = 0
          const out = fs.createWriteStream(zipPath)
          _activeUpdateReq = { cancel: () => { req.destroy(); out.destroy(); reject(new Error('cancelled')) } }
          res.on('data', chunk => {
            received += chunk.length
            out.write(chunk)
            if (mainWindow) mainWindow.webContents.send('app:updateProgress', { received, total, phase: 'downloading' })
          })
          res.on('end', () => { _activeUpdateReq = null; out.end(); resolve() })
          res.on('error', err => { _activeUpdateReq = null; out.destroy(); reject(err) })
        }).on('error', reject)
        _activeUpdateReq = { cancel: () => { req.destroy(); reject(new Error('cancelled')) } }
      }
      doGet(downloadUrl, 0)
    })

    // Extract zip
    if (mainWindow) mainWindow.webContents.send('app:updateProgress', { phase: 'extracting' })
    await new Promise((resolve, reject) => {
      const proc = spawn('unzip', ['-o', zipPath, '-d', updateTempDir])
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`)))
      proc.on('error', reject)
    })
    try { fs.unlinkSync(zipPath) } catch {}

    // Find the .app bundle inside extracted folder
    let appBundle = null
    const findApp = (dir, depth) => {
      if (depth > 3 || appBundle) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.isDirectory() && e.name.endsWith('.app')) { appBundle = path.join(dir, e.name); return }
        if (e.isDirectory()) findApp(path.join(dir, e.name), depth + 1)
        if (appBundle) return
      }
    }
    findApp(updateTempDir, 0)
    if (!appBundle) return { ok: false, error: 'Could not find .app bundle in the downloaded update archive.' }

    // Determine destination — the currently running .app
    const currentAppPath = path.dirname(path.dirname(path.dirname(path.dirname(app.getAppPath()))))
    const destAppPath = currentAppPath.endsWith('.app') ? currentAppPath : null
    if (!destAppPath) return { ok: false, error: 'Could not determine current .app path for replacement.' }

    // Replace: remove old app, move new one in
    if (mainWindow) mainWindow.webContents.send('app:updateProgress', { phase: 'installing' })
    try { fs.rmSync(destAppPath, { recursive: true, force: true }) } catch {}
    // Use ditto for proper macOS .app copy (preserves permissions, symlinks, etc.)
    await new Promise((resolve, reject) => {
      const proc = spawn('ditto', [appBundle, destAppPath])
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ditto exited ${code}`)))
      proc.on('error', reject)
    })

    // Clean up temp
    try { fs.rmSync(path.join(SW_DIR, 'temp'), { recursive: true, force: true }) } catch {}

    // Relaunch
    app.relaunch()
    app.exit(0)
    return { ok: true }
  } catch(e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('app:cancelUpdate', () => {
  if (_activeUpdateReq) { _activeUpdateReq.cancel(); _activeUpdateReq = null; return { ok: true } }
  return { ok: false }
})

// Return current standalone setup status
ipcMain.handle('standalone:getStatus', () => {
  const s = loadSettings()
  const wineBin = standaloneWineBin()
  // Read DXMT version from dxgi.dll PE header (ProductVersion string in VersionInfo)
  let dxmtVersion = ''
  const dxmtDll = s.standalonDxmtDir ? path.join(s.standalonDxmtDir, 'dxgi.dll') : null
  if (dxmtDll && fs.existsSync(dxmtDll)) {
    try {
      // DXMT embeds a version string in the file — read the PE VersionInfo block as binary
      // and look for a semver-like pattern after the FileVersion magic bytes.
      const buf = fs.readFileSync(dxmtDll)
      // Search for ASCII "FileVersion\0" followed by UTF-16LE version string
      const marker = Buffer.from('F\0i\0l\0e\0V\0e\0r\0s\0i\0o\0n\0\0\0', 'binary')
      let idx = -1
      for (let i = 0; i < buf.length - marker.length - 40; i++) {
        if (buf[i] === 0x46 && buf.slice(i, i + marker.length).equals(marker)) { idx = i + marker.length; break }
      }
      if (idx > 0) {
        // Decode the UTF-16LE string that follows
        let ver = ''; let j = idx
        while (j + 1 < Math.min(idx + 80, buf.length) && !(buf[j] === 0 && buf[j+1] === 0 && (j - idx) > 2)) {
          if (buf[j+1] === 0) ver += String.fromCharCode(buf[j])
          j += 2
        }
        ver = ver.trim()
        if (/\d/.test(ver)) dxmtVersion = ver
      }
    } catch {}
  }

  // Issue A: detect a stale settings.json that still points to the 32-bit x86
  // DXMT directory from before the x86_64 fix. dxgi.dll exists there so the
  // normal dxmtExists check passes, but Wine silently ignores 32-bit DLLs in
  // system32 for 64-bit processes — DXMT never activates. Warn the user so they
  // know to reinstall DXMT through the wizard.
  let dxmtArchWarning = false
  if (s.standalonDxmtDir && fs.existsSync(path.join(s.standalonDxmtDir, 'dxgi.dll'))) {
    const dirName = path.basename(s.standalonDxmtDir).toLowerCase()
    if (!/x86.?64|x64|win64/.test(dirName)) {
      dxmtArchWarning = true
      console.warn('[DXMT] Saved DXMT path may point to the 32-bit directory:', s.standalonDxmtDir,
        '— reinstall DXMT through the Setup Wizard to pick up the x86_64 build.')
    }
  }

  return {
    wineInstalled:  !!wineBin,
    wineBin:        wineBin || '',
    activeSlug:     s.standalonWineSlug || '',
    defaultBottlePath: path.join(SW_DIR, 'TruckersmpBottle'),
    bottlePath:     s.standalonBottlePath || '',
    bottleExists:   !!(s.standalonBottlePath && fs.existsSync(path.join(s.standalonBottlePath, 'drive_c'))),
    dxmtDir:        s.standalonDxmtDir || '',
    dxmtExists:     !!(s.standalonDxmtDir && fs.existsSync(path.join(s.standalonDxmtDir, 'dxgi.dll'))),
    dxmtVersion,
    dxmtFileVersion: s.standalonDxmtVersion || '',
    dxmtArchWarning,
    steamDir:       s.standalonSteamDir || '',
    gameDir:        s.standalonGameDir  || '',
    wizardDone:     !!s.standaloneWizardDone,
  }
})

// Auto-detect ETS2 game dir inside a bottle after Steam installs it.
// Walks bottle/drive_c/Program Files (x86)/Steam/steamapps/common/Euro Truck Simulator 2
ipcMain.handle('standalone:autoDetectGamePath', (_, bottlePath) => {
  if (!bottlePath) return { ok:false, error:'No bottle path' }
  const candidates = [
    path.join(bottlePath, 'drive_c', 'Program Files (x86)', 'Steam', 'steamapps', 'common', 'Euro Truck Simulator 2'),
    path.join(bottlePath, 'drive_c', 'Program Files', 'Steam', 'steamapps', 'common', 'Euro Truck Simulator 2'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return { ok:true, gameDir: p }
  }
  return { ok:false, error:'ETS2 not found — make sure Steam has finished installing it.' }
})

ipcMain.handle('standalone:setRetinaMode', (_, { bottlePath, enabled }) => {
  patchRetinaMode(bottlePath, enabled)
  return { ok:true }
})

// Auto-detect Steam dir inside a bottle
ipcMain.handle('standalone:autoDetectSteamPath', (_, bottlePath) => {
  if (!bottlePath) return { ok:false, error:'No bottle path' }
  const candidates = [
    path.join(bottlePath, 'drive_c', 'Program Files (x86)', 'Steam'),
    path.join(bottlePath, 'drive_c', 'Program Files', 'Steam'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.existsSync(path.join(p, 'Steam.exe'))) return { ok:true, steamDir: p }
  }
  return { ok:false, error:'Steam.exe not found in the bottle.' }
})

// Open a path in macOS Finder
ipcMain.handle('shell:openInFinder', (_, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok:false, error:'Path does not exist.' }
  require('child_process').spawn('open', [filePath], { detached:true, stdio:'ignore' }).unref()
  return { ok:true }
})

// ── TruckersMP Connectivity Check ─────────────────────────────────────────────
ipcMain.handle('net:checkTMP', () => {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(4000)
    socket.connect(443, 'api.truckersmp.com', () => {
      socket.destroy()
      resolve({ reachable: true })
    })
    socket.on('error', () => { socket.destroy(); resolve({ reachable: false }) })
    socket.on('timeout', () => { socket.destroy(); resolve({ reachable: false }) })
  })
})
