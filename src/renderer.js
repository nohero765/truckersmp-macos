'use strict'

// ── State ─────────────────────────────────────────────────────────────────────
let settings = {}, detected = {}, running = false, launching = false
let logs = [], filter = '', logCat = 'all', autoScroll = true, showTs = false

// Classify a log line into 'wine' or 'launcher' when no explicit cat is set.
// Game process stdout/stderr and Discord RPC/chat lines are now tagged explicitly
// upstream; this function handles any remaining untagged lines.
function inferLogCat(text) {
  const t = text || ''
  // Wine/game-side signals
  if (/\[(Steam|CEF|WineGL|DXMT|wine|dxvk)\]|wineserver|WINEPREFIX|fixme:|err:|wine:|wine64|winedevice|plugplay/i.test(t)) return 'wine'
  // Launcher-side signals
  if (/Discord RPC|\[Discord\]|\[RPC\]|Rich Presence|chat watcher|chat log|\[ETS2MP\]/i.test(t)) return 'launcher'
  return 'launcher'
}
let launchMode = 'macos'
let serverStatusTimer = null
let isAppVisible = true, focusRestoreTimer = null
let steamRunning = false
let _autoUpdateResult = null
const STEAM_ICON_SVG = '<svg class="steam-icon" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.029 4.524 4.524s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.497 1.009 2.452-.397.957-1.497 1.41-2.455 1.015zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.252 0-2.265-1.014-2.265-2.265z"/></svg>'
const REFRESH_DEFAULT = 60000

const $ = id => document.getElementById(id)
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))

// ── Toast notifications ───────────────────────────────────────────────────────
function showToast(msg, type = 'info', duration = 3800) {
  const container = $('toast-container')
  if (!container) return
  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`
  toast.textContent = msg
  container.appendChild(toast)
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('toast-show')))
  setTimeout(() => {
    toast.classList.remove('toast-show')
    toast.addEventListener('transitionend', () => { try { toast.remove() } catch {} }, { once: true })
  }, duration)
}

// ── Confirm modal ─────────────────────────────────────────────────────────────
function showConfirm(msg, confirmText = 'Confirm', cancelText = 'Cancel') {
  return new Promise(resolve => {
    const overlay  = $('confirm-overlay')
    const msgEl    = $('confirm-msg')
    const btnOk    = $('confirm-ok')
    const btnCancel= $('confirm-cancel')
    if (!overlay) { resolve(window.confirm(msg)); return }
    msgEl.textContent = msg
    btnOk.textContent = confirmText
    btnCancel.textContent = cancelText
    overlay.classList.remove('hidden')
    const cleanup = val => {
      overlay.classList.add('hidden')
      resolve(val)
    }
    btnOk.onclick     = () => cleanup(true)
    btnCancel.onclick = () => cleanup(false)
  })
}

// ── Debug ─────────────────────────────────────────────────────────────────────
function dbg(msg) {
  console.log('[DBG]', msg)
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  dbg('Initialising v2.0…')
  settings = await window.api.loadSettings()
  dbg('Settings loaded')
  detected = await window.api.detectPaths()
  dbg(`Detect: wine=${detected.crossoverFound} cli=${detected.cliFound} steam=${detected.steamFound} game=${detected.gameFound}`)

  // Apply detection badges
  setBadge('badge-crossover', detected.crossoverFound)
  setBadge('badge-cli',       detected.cliFound)
  setBadge('badge-steam',     detected.steamFound)
  setBadge('badge-game',      detected.gameFound)

  // Auto-fill empty settings from detection
  if (!settings.cliPath    && detected.cliPath)    settings.cliPath    = detected.cliPath
  if (!settings.winePath   && detected.winePath)   settings.winePath   = detected.winePath
  if (!settings.bottlePath && detected.bottlePath) settings.bottlePath = detected.bottlePath
  if (!settings.steamDir   && detected.steamDir)   settings.steamDir   = detected.steamDir
  if (!settings.gameDir    && detected.gameDir)    settings.gameDir    = detected.gameDir

  if (detected.crossoverFound && detected.winePath) {
    const btn = $('btn-use-wine'); if (btn) btn.classList.remove('hidden')
  }

  // Populate fields
  fillField('s-cli',    settings.cliPath)
  fillField('s-wine',   settings.winePath)
  fillField('s-bottle', settings.bottlePath)
  fillField('s-steam',  settings.steamDir)
  fillField('s-game',   settings.gameDir)

  // Sanitize standalone paths — clear any CrossOver contamination.
  // If a standalone path contains CrossOver or /Applications it was auto-filled
  // from CrossOver detection and must be cleared so it doesn't shadow the bottle.
  function isCrossOverPath(p) {
    return p && (p.includes('CrossOver') || p.includes('/Applications/') || p.includes('com.codeweavers'))
  }
  if (isCrossOverPath(settings.standalonSteamDir)) { settings.standalonSteamDir = ''; fillField('sw-steam-dir', '') }
  if (isCrossOverPath(settings.standalonGameDir))  { settings.standalonGameDir  = ''; fillField('sw-game-dir',  '') }

  // Auto-detect standalone bottle contents (Steam + ETS2 inside the bottle)
  if (settings.wineMode === 'standalone' && settings.standalonBottlePath) {
    detectStandaloneBottlePaths(settings.standalonBottlePath)
  }
  fillField('s-extra',  settings.extraArgs)
  // Wine mode toggle
  swApplyWineMode(settings.wineMode || 'crossover')
  // Refresh standalone status badges on launch if already in standalone mode
  if ((settings.wineMode || 'crossover') === 'standalone' && typeof window._swRefreshStatusBadges === 'function') {
    window._swRefreshStatusBadges()
  }
  fillField('sw-bottle-path', settings.standalonBottlePath || '')
  fillField('sw-steam-dir',   settings.standalonSteamDir   || '')
  fillField('sw-game-dir',    settings.standalonGameDir    || '')
  const disc = $('s-discord'); if (disc) disc.checked = settings.discordIPC !== false
  fillField('s-discord-client-id', settings.discordClientId || '')
  // RPC custom fields
  const rc = settings.rpcCustom || {}
  const fillRpc = (id, val) => { const el=$( id); if(el) el.value = val||'' }
  fillRpc('rpc-details-login', rc.detailsLogin)
  fillRpc('rpc-details-game',  rc.detailsGame)
  fillRpc('rpc-state',         rc.state)
  fillRpc('rpc-image-key',     rc.largeImage)
  fillRpc('rpc-image-text',    rc.largeText)
  fillRpc('rpc-small-image-key',  rc.smallImage)
  fillRpc('rpc-small-image-text', rc.smallText)

  // RPC extras (auto-reconnect, advanced/telemetry)
  const rcc = $('s-rpc-reconnect');   if (rcc) rcc.checked = settings.rpcAutoReconnect !== false
  const adv = $('s-rpc-advanced');    if (adv) adv.checked = !!settings.rpcAdvanced
  const tle = $('s-telemetry-enabled'); if (tle) tle.checked = !!settings.telemetryEnabled
  fillField('s-telemetry-path', settings.telemetryPath || '')
  // Show the advanced sub-panel only when the master toggle is on.
  const advPanel = $('rpc-advanced-panel')
  if (advPanel) advPanel.style.display = settings.rpcAdvanced ? '' : 'none'

  // First-run welcome banner — only on truly first launch (no setting yet),
  // or until the user dismisses it explicitly. Hidden once dismissed.
  const banner = $('first-run-banner')
  if (banner) banner.style.display = settings.firstRunSeen ? 'none' : 'flex'

  // Discord section collapse state — persisted across launches.
  const discBody = $('discord-section-body'), discTitle = $('discord-section-toggle')
  if (discBody && discTitle) {
    const collapsed = !!settings.discordSectionCollapsed
    discBody.style.display = collapsed ? 'none' : ''
    discTitle.classList.toggle('collapsed', collapsed)
  }
  const sp   = $('s-sp');      if (sp)   sp.checked   = !!settings.singlePlayer
  const mhud = $('s-metal-hud'); if (mhud) mhud.checked = !!settings.metalHud
  const mhudSw = $('s-metal-hud-sw'); if (mhudSw) mhudSw.checked = !!settings.metalHud
  // Zoom level
  const zoomEl = $('s-zoom-level')
  const zoomPct = $('s-zoom-display')
  const zoom = settings.zoomLevel ?? 0.9
  document.documentElement.style.zoom = zoom
  if (zoomEl) { zoomEl.value = String(zoom); zoomEl.addEventListener('input', () => {
    const v = Number(zoomEl.value)
    document.documentElement.style.zoom = v
    if (zoomPct) zoomPct.textContent = Math.round(v * 100) + '%'
  }) }
  if (zoomPct) zoomPct.textContent = Math.round(zoom * 100) + '%'

  // Test duration dropdown (10 s / 20 s) and sample-payload preset.
  const tdEl = $('s-rpc-test-duration')
  if (tdEl) tdEl.value = String(settings.rpcTestDuration || 10)
  const tpEl = $('s-rpc-test-preset')
  if (tpEl) tpEl.value = settings.rpcTestPreset || 'driving_route'


  // Wine debug log toggle (standalone only)
  const wdlEl = $('s-wine-debug-log')
  if (wdlEl) wdlEl.checked = settings.standalonWineDebugLog !== false
  const retinaCb = $('s-retina-mode')
  if (retinaCb) retinaCb.checked = !!settings.standalonRetinaMode

  // Wine Activity section visibility
  const wineActivityEl = $('s-show-wine-activity')
  const wineSection = $('log-wine-section')
  const showWineActivity = settings.showWineActivity !== false
  if (wineActivityEl) wineActivityEl.checked = showWineActivity
  if (wineSection) wineSection.classList.toggle('hidden', !showWineActivity)

  applyTelemView(!!settings.replaceLogTelemetry)


  // Restore mode
  setMode(settings.launchMode || 'macos')

  // Validate existing paths
  validateAll()

  updatePreview()
  updateLaunchBtn()
  updateSteamBtn()
  wireEvents()
  wireIPC()

  // Restore refresh interval
  const savedInterval = settings.refreshInterval || REFRESH_DEFAULT
  const refreshSel = $('s-refresh-interval')
  if (refreshSel) refreshSel.value = String(savedInterval)

  // Load server status, TMP info, and events
  loadServerStatus()
  loadTMPInfo()
  loadTMPEvents()
  startRefreshTimer(savedInterval)

  // Memory optimisation: pause background work when window is hidden
  document.addEventListener('visibilitychange', handleVisibilityChange)

  // Startup update check — runs 4s after launch so it doesn't block init
  setTimeout(async () => {
    try {
      const res = await window.api.checkUpdate()
      if (res && res.ok && res.hasUpdate) {
        _autoUpdateResult = res
        const badge = $('update-badge')
        if (badge) badge.style.display = ''
      }
    } catch {}
  }, 4000)

  dbg('Ready')
}

// ── Refresh Timer ─────────────────────────────────────────────────────────────
function startRefreshTimer(intervalMs) {
  if (serverStatusTimer) clearInterval(serverStatusTimer)
  const ms = Number(intervalMs) || REFRESH_DEFAULT
  serverStatusTimer = setInterval(() => {
    if (isAppVisible) { loadServerStatus(); loadTMPInfo() }
  }, ms)
}

// ── Visibility / Memory Optimisation ─────────────────────────────────────────
function handleVisibilityChange() {
  const pauseOnHide = settings.refreshOnFocus !== false
  if (document.hidden) {
    isAppVisible = false
    clearTimeout(focusRestoreTimer)
    if (pauseOnHide) {
      clearInterval(serverStatusTimer)
      serverStatusTimer = null
      dbg('App hidden — background refresh paused')
    }
  } else {
    isAppVisible = true
    if (pauseOnHide) {
      // Wait 3 s after returning to focus before re-loading data
      focusRestoreTimer = setTimeout(() => {
        loadServerStatus()
        loadTMPInfo()
        const interval = settings.refreshInterval || REFRESH_DEFAULT
        startRefreshTimer(interval)
        dbg('App visible — refresh resumed')
      }, 3000)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fillField(id, val) { const el=$(id); if(el) el.value = val||'' }
function getField(id)       { const el=$(id); return el ? el.value.trim() : '' }

function setBadge(id, found) {
  const el=$(id); if(!el) return
  el.textContent = found ? 'Found' : 'Not found'
  el.className   = 'det-badge ' + (found ? 'found' : 'missing')
}

// Track which paths were manually set vs auto-detected
const manualPaths = { cli:false, wine:false, steam:false, game:false }

function setManual(key, isManual) {
  manualPaths[key] = isManual
  const el = $('manual-' + key); if (!el) return
  el.classList.toggle('hidden', !isManual)
  dbg(isManual ? `Manual path set: ${key}` : `Auto path: ${key}`)
}

function setStatus(label, cls, pid) {
  const l=$('status-label'); if(l) l.textContent = label
  const d=$('status-dot');   if(d) d.className   = 'status-dot ' + cls
  const p=$('status-pid');   if(p) p.textContent  = pid ? `PID ${pid}` : ''
}


// ── Launch Mode ───────────────────────────────────────────────────────────────
function setMode(mode) {
  launchMode = mode
  settings.launchMode = mode
  updatePreview()
  dbg(`Mode → ${mode.toUpperCase()}`)
}



// ── Command Preview ───────────────────────────────────────────────────────────
function updatePreview() {
  const el=$('cmd-preview'); if(!el) return
  if (!settings.cliPath) { el.textContent='truckersmp-cli (not configured)'; return }
  // Always set WINE env var — truckersmp-cli uses it to find the Wine binary.
  let cmd = settings.winePath ? `WINE="${settings.winePath}" ` : ''
  if (settings.bottlePath) cmd += `WINEPREFIX="${settings.bottlePath}" `
  // Both modes use -w (Wine mode) — without it, truckersmp-cli tries Proton.
  if (launchMode==='official') {
    cmd += settings.cliPath + ' -w'
    if (settings.bottlePath) cmd += ` -x "${settings.bottlePath}"`
    if (settings.gameDir)    cmd += ` -g "${settings.gameDir}"`
    if (settings.steamDir)   cmd += ` --wine-steam-dir "${settings.steamDir}"`
    if (!settings.discordIPC) cmd += ' --without-wine-discord-ipc-bridge'
    cmd += ' -r dx11 start ets2mp'
  } else {
    cmd += settings.cliPath + ' -w'
    if (settings.gameDir)    cmd += ` -g "${settings.gameDir}"`
    if (settings.bottlePath) cmd += ` -x "${settings.bottlePath}"`
    if (settings.steamDir)   cmd += ` --wine-steam-dir "${settings.steamDir}"`
    if (!settings.discordIPC) cmd += ' --without-wine-discord-ipc-bridge'
    cmd += ' -r dx11 start ets2mp'
  }
  if (settings.extraArgs) cmd += ' ' + settings.extraArgs
  el.textContent = cmd
}

// ── Auto-detect paths inside a standalone Wine bottle ─────────────────────────
// Checks the standard Steam/ETS2 locations inside the bottle and fills in any
// empty fields. Safe to call multiple times — never overwrites user-set values.
function detectStandaloneBottlePaths(bottlePath) {
  if (!bottlePath) return
  const driveC = bottlePath + '/drive_c'
  const steamCandidates = [
    driveC + '/Program Files (x86)/Steam',
    driveC + '/Program Files/Steam',
  ]
  // Detect Steam dir
  steamCandidates.forEach(c => {
    if (!settings.standalonSteamDir) {
      window.api.pathExists(c + '/steam.exe').then(ok => {
        if (ok && !settings.standalonSteamDir) {
          settings.standalonSteamDir = c
          fillField('sw-steam-dir', c)
          updateSteamBtn()
          window.api.saveSettings(settings)
        }
      })
    }
  })
  // Detect ETS2 game dir — check both 32-bit and 64-bit Steam install locations
  if (!settings.standalonGameDir) {
    const ets2Candidates = [
      driveC + '/Program Files (x86)/Steam/steamapps/common/Euro Truck Simulator 2',
      driveC + '/Program Files/Steam/steamapps/common/Euro Truck Simulator 2',
    ]
    ets2Candidates.forEach(ets2 => {
      window.api.pathExists(ets2 + '/bin').then(ok => {
        if (ok && !settings.standalonGameDir) {
          settings.standalonGameDir = ets2
          fillField('sw-game-dir', ets2)
          updateLaunchBtn()
          window.api.saveSettings(settings)
        }
      })
    })
  }
}

// ── Steam Button ──────────────────────────────────────────────────────────────
function updateSteamBtn() {
  const btn=$('btn-steam'); if(!btn) return
  const isStandalone = settings.wineMode === 'standalone'
  // Simple rule: light up if the relevant steam directory is known, grey if not.
  const ready = isStandalone
    ? !!settings.standalonSteamDir
    : !!(settings.steamDir || detected.steamDir)
  btn.disabled = !steamRunning && !ready
  if (steamRunning) {
    btn.classList.add('steam-running')
  } else {
    btn.classList.remove('steam-running')
  }
  btn.innerHTML = STEAM_ICON_SVG + (steamRunning ? 'Stop Steam' : 'Start Steam')
}

// ── Launch Button ─────────────────────────────────────────────────────────────
function updateLaunchBtn() {
  const btn=$('btn-launch'); if(!btn) return
  const warn=$('launch-warn')
  const fk=$('btn-forcekill')
  const isStandalone = settings.wineMode === 'standalone'
  const ready = isStandalone
    ? !!(settings.cliPath && settings.standalonBottlePath && settings.standalonGameDir)
    : !!((settings.cliPath || detected.cliPath) && (settings.winePath || detected.winePath))
  if (launching) {
    btn.innerHTML='<span class="launch-spinner"></span><span id="launch-text">Launching…</span>'
    btn.className='btn-launch'; btn.disabled=true
    if(warn) warn.classList.add('hidden')
    if(fk) fk.classList.add('hidden')
  } else if (running) {
    btn.innerHTML='<span id="launch-icon">■</span><span id="launch-text">Stop Game</span>'
    btn.className='btn-launch stop'; btn.disabled=false
    if(warn) warn.classList.add('hidden')
    if(fk) fk.classList.remove('hidden')
  } else {
    btn.innerHTML='<span id="launch-icon">▶</span><span id="launch-text">Launch ETS2 MP</span>'
    btn.className='btn-launch'; btn.disabled=!ready
    if(warn) warn.classList.toggle('hidden', ready)
    if(fk) fk.classList.add('hidden')
  }
}

// ── Collect fields → settings ─────────────────────────────────────────────────
function collect() {
  settings.cliPath      = getField('s-cli')
  settings.winePath     = getField('s-wine')
  settings.bottlePath   = getField('s-bottle')
  settings.steamDir     = getField('s-steam')
  settings.gameDir      = getField('s-game')
  settings.extraArgs    = getField('s-extra')
  const disc=$('s-discord'); settings.discordIPC   = disc ? disc.checked : true
  settings.discordClientId = getField('s-discord-client-id').trim()
  const sp=$('s-sp');        settings.singlePlayer = sp   ? sp.checked   : false
  const mhud=$('s-metal-hud'); settings.metalHud   = mhud ? mhud.checked : false
  const zoomSlider=$('s-zoom-level'); settings.zoomLevel = zoomSlider ? Number(zoomSlider.value) || 0.9 : 0.9
  const tdEl2=$('s-rpc-test-duration'); settings.rpcTestDuration = tdEl2 ? Number(tdEl2.value) || 10 : 10
  const tpEl2=$('s-rpc-test-preset'); settings.rpcTestPreset = tpEl2 ? tpEl2.value : 'driving_route'
  const wineActivity=$('s-show-wine-activity'); settings.showWineActivity = wineActivity ? wineActivity.checked : true
  const refreshSel=$('s-refresh-interval'); settings.refreshInterval = refreshSel ? Number(refreshSel.value) : REFRESH_DEFAULT
  const wdl=$('s-wine-debug-log'); settings.standalonWineDebugLog = wdl ? wdl.checked : true
  const retinaEl=$('s-retina-mode'); settings.standalonRetinaMode = retinaEl ? retinaEl.checked : false
  const getV = id => { const el=$(id); return el ? el.value.trim() : '' }
  settings.rpcCustom = {
    detailsLogin: getV('rpc-details-login'),
    detailsGame:  getV('rpc-details-game'),
    state:        getV('rpc-state'),
    largeImage:   getV('rpc-image-key'),
    largeText:    getV('rpc-image-text'),
    smallImage:   getV('rpc-small-image-key'),
    smallText:    getV('rpc-small-image-text')
  }
  // RPC extras
  const rcc = $('s-rpc-reconnect');     settings.rpcAutoReconnect = rcc ? rcc.checked : true
  settings.afkEnabled = false
  const adv = $('s-rpc-advanced');      settings.rpcAdvanced      = adv ? adv.checked : false
  const tle = $('s-telemetry-enabled'); settings.telemetryEnabled = tle ? tle.checked : false
  settings.telemetryPath = getField('s-telemetry-path').trim()
  // UI state we persist (so the layout sticks across launches)
  const discTitle = $('discord-section-toggle')
  if (discTitle) settings.discordSectionCollapsed = discTitle.classList.contains('collapsed')
  settings.launchMode     = launchMode
  // Standalone Wine — use field value directly, no CrossOver fallback.
  // If the field is cleared by the user, the setting becomes empty (intentional).
  const wmStandalone = $('wm-standalone')
  settings.wineMode = (wmStandalone && wmStandalone.classList.contains('active')) ? 'standalone' : 'crossover'
  settings.standalonBottlePath = getField('sw-bottle-path')
  settings.standalonSteamDir   = getField('sw-steam-dir')
  settings.standalonGameDir    = getField('sw-game-dir')
}


// ── Validate ──────────────────────────────────────────────────────────────────
async function validate(inputId, validId, val) {
  const el=$(validId); if(!el) return
  if (!val) { el.classList.add('hidden'); return }
  const ok = await window.api.pathExists(val)
  el.classList.remove('hidden')
  el.className   = 's-validate ' + (ok?'ok':'bad')
  el.textContent = ok ? '✓ Path exists' : '✕ Path not found'
  dbg(`Validate ${inputId}: ${ok?'✓ exists':'✕ not found'} → ${val}`)
}

async function validateAll() {
  const vmap = {'s-cli':'v-cli','s-wine':'v-wine','s-bottle':'v-bottle','s-steam':'v-steam','s-game':'v-game'}
  for (const [sid, vid] of Object.entries(vmap)) {
    const val = getField(sid)
    if (val) await validate(sid, vid, val)
  }
}

// ── Log ───────────────────────────────────────────────────────────────────────
const PFX = {system:'●',info:'›',success:'✓',warn:'⚠',error:'✕','diag-ok':'✓','diag-fail':'✕','diag-warn':'⚠','diag-info':'●','diag-head':'▸'}

function pushLog(e) {
  if (!e.cat) e.cat = inferLogCat(e.text)
  logs.push(e)
  if (logs.length>5000) logs.shift()
  if (filter && !e.text.toLowerCase().includes(filter)) { updateCount(); return }
  if (logCat !== 'all' && e.cat !== logCat) { updateCount(); return }
  renderLog(e); updateCount()
}

function renderLog(e) {
  const empty=$('log-empty'); if(empty) empty.classList.add('hidden')
  const d=document.createElement('div'); d.className=`log-line ${e.kind}`
  const p=document.createElement('span'); p.className='lp'; p.textContent=PFX[e.kind]||'›'
  const t=document.createElement('span'); t.className='lt'; t.textContent=e.text
  if(showTs){
    const ts=document.createElement('span'); ts.className='lts'
    ts.textContent=new Date(e.ts).toTimeString().slice(0,8)
    d.append(p,ts,t)
  } else { d.append(p,t) }
  const lb=$('log-body')
  if(lb){
    lb.appendChild(d)
    const logEmpty=$('log-empty')
    while(lb.children.length>5001){
      const oldest=lb.firstElementChild
      if(oldest&&oldest!==logEmpty) oldest.remove(); else break
    }
    if(autoScroll) lb.scrollTop=lb.scrollHeight
  }
}

function rebuildLog() {
  const lb=$('log-body'); if(!lb) return
  Array.from(lb.children).forEach(el=>{ if(el!==$('log-empty')) el.remove() })
  let list = logs
  if (filter) list = list.filter(l => l.text.toLowerCase().includes(filter))
  if (logCat !== 'all') list = list.filter(l => (l.cat || inferLogCat(l.text)) === logCat)
  const empty=$('log-empty')
  if(!list.length){ if(empty) empty.classList.remove('hidden') }
  else { if(empty) empty.classList.add('hidden'); list.forEach(renderLog) }
  updateCount()
}

function updateCount() { const el=$('line-count'); if(el) el.textContent=`${logs.length} lines` }

// ── Uninstall ─────────────────────────────────────────────────────────────────
async function uninstallSettings() {
  dbg('Uninstall settings clicked')
  if (!await showConfirm('This will permanently delete all launcher settings.\n\nPath: ~/.config/truckersmp-launcher/\n\nThe app will reset to defaults on next launch.', 'Delete', 'Cancel')) return
  const btn = $('btn-uninstall-settings')
  if (btn) { btn.disabled = true; btn.textContent = 'Removing…' }
  const res = await window.api.deleteSettings()
  if (btn) { btn.disabled = false }
  if (res.ok) {
    if (btn) { btn.textContent = 'Done ✓'; setTimeout(() => btn.textContent = 'Remove', 2500) }
    dbg('Launcher settings deleted ✓')
  } else {
    if (btn) { btn.textContent = 'Failed'; setTimeout(() => btn.textContent = 'Remove', 2500) }
    dbg('Settings deletion failed: ' + res.error)
    showToast('Failed to delete settings: ' + res.error, 'error')
  }
}

// ── TruckersMP Server Status ──────────────────────────────────────────────────
async function loadServerStatus() {
  const loading=$('srv-loading'), list=$('srv-list'), updated=$('srv-updated')
  if(loading) { loading.classList.remove('hidden'); loading.textContent='Checking servers…' }
  if(list) list.classList.add('hidden')

  try {
    const result = await window.api.getTMPServers()
    if(loading) loading.classList.add('hidden')

    if (!result.ok) {
      if(loading) { loading.classList.remove('hidden'); loading.className='srv-error'; loading.textContent='⚠ Failed: '+result.error }
      if(updated) updated.textContent='Failed'
      dbg('Server status fetch failed: '+result.error)
      return
    }

    const favs = new Set(settings.favouriteServers || [])
    const servers = (result.servers || [])
      .filter(s => s.game === 'ETS2')
      .sort((a,b) => {
        const af = favs.has(a.id) ? 0 : 1
        const bf = favs.has(b.id) ? 0 : 1
        if (af !== bf) return af - bf
        return (a.displayorder||99) - (b.displayorder||99)
      })

    if(list) {
      list.innerHTML = ''
      if (!servers.length) {
        list.innerHTML = '<div class="srv-loading">No ETS2 servers found</div>'
      } else {
        for (const srv of servers) {
          const row = document.createElement('div')
          row.className = 'srv-row'
          row.dataset.srvId = srv.id
          const online = srv.online !== false
          const queue  = srv.queue || 0
          const queueStr = queue > 0 ? ` <span class="srv-queue">+${queue}q</span>` : ''
          const isFav = favs.has(srv.id)
          row.innerHTML =
            `<button class="srv-fav ${isFav?'on':''}" title="${isFav?'Unfavourite':'Favourite'}" data-srv-fav="${srv.id}">${isFav?'★':'☆'}</button>` +
            `<span class="srv-dot ${online?'online':'offline'}"></span>` +
            `<span class="srv-name" title="${escHtml(srv.name)}">${escHtml(srv.name)}</span>` +
            `<span class="srv-players">${online ? srv.players : '—'}${queueStr}</span>`
          list.appendChild(row)
        }
        // wire favourite stars
        list.querySelectorAll('[data-srv-fav]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation()
            const id = Number(btn.dataset.srvFav)
            const arr = settings.favouriteServers || []
            const idx = arr.indexOf(id)
            if (idx >= 0) arr.splice(idx, 1); else arr.push(id)
            settings.favouriteServers = arr
            window.api.saveSettings(settings)
            dbg(`${idx>=0?'Unfavourited':'Favourited'} server ${id}`)
            loadServerStatus()  // re-render with new sort
          })
        })
        // If all servers offline, show maintenance hint
        const allOffline = servers.every(s => s.online === false)
        if (allOffline) {
          const hint = document.createElement('div')
          hint.className = 'srv-maint-hint'
          hint.textContent = '⚠ All servers offline — may be in maintenance.'
          list.appendChild(hint)
        }
        // Queue warning — show if any server has a queue
        const queueServers = servers.filter(s => (s.queue || 0) > 0)
        if (queueServers.length > 0) {
          const totalQ = queueServers.reduce((acc, s) => acc + (s.queue || 0), 0)
          const names = queueServers.map(s => `${escHtml(s.name)} (${s.queue})`).join(', ')
          const warn = document.createElement('div')
          warn.className = 'srv-queue-warn'
          warn.innerHTML = `<span class="srv-queue-warn-icon">⚠</span><span>Queue detected: ${names} — <strong>${totalQ}</strong> player${totalQ===1?'':'s'} waiting to join.</span>`
          list.appendChild(warn)
        }
      }
      list.classList.remove('hidden')
    }

    const now = new Date()
    if(updated) updated.textContent = 'Updated '+now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
    dbg(`Servers loaded: ${servers.length} ETS2 servers`)
  } catch(e) {
    if(loading) { loading.classList.remove('hidden'); loading.className='srv-error'; loading.textContent='⚠ Error: '+e.message }
    if(updated) updated.textContent='Error'
    dbg('Server status error: '+e.message)
  }
}

// ── TMP Info (version + game time) ───────────────────────────────────────────
async function loadTMPInfo() {
  const gtEl=$('tmp-gametime'), verEl=$('tmp-version'), etsEl=$('tmp-ets2ver'), updEl=$('tmp-updated')
  if(gtEl)  gtEl.textContent  = '…'
  if(verEl) verEl.textContent = '…'
  if(etsEl) etsEl.textContent = '…'

  try {
    const r = await window.api.getTMPInfo()
    if (!r.ok) {
      if(gtEl)  gtEl.textContent  = '—'
      if(verEl) verEl.textContent = '—'
      if(etsEl) etsEl.textContent = '—'
      if(updEl) updEl.textContent = 'Error'
      dbg('TMP info fetch failed: '+r.error)
      return
    }
    if(gtEl)  { gtEl.textContent = r.gameTime;     gtEl.classList.add('highlight') }
    if(verEl) verEl.textContent = r.version
    if(etsEl) etsEl.textContent = r.etsSupported
    const now = new Date()
    if(updEl) updEl.textContent = 'Updated '+now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
    dbg(`TMP info: v${r.version} | ETS2: ${r.etsSupported} | Time: ${r.gameTime}`)
  } catch(e) {
    if(updEl) updEl.textContent = 'Error'
    dbg('TMP info error: '+e.message)
  }
}

// ── TMP Events ────────────────────────────────────────────────────────────────
async function loadTMPEvents() {
  const loading=$('evt-loading'), list=$('evt-list'), updated=$('evt-updated')
  if(loading) { loading.classList.remove('hidden'); loading.textContent='Loading events…' }
  if(list) list.classList.add('hidden')

  try {
    const r = await window.api.getTMPEvents()
    if(loading) loading.classList.add('hidden')

    if (!r.ok) {
      if(loading) { loading.classList.remove('hidden'); loading.className='srv-error'; loading.textContent='⚠ '+r.error }
      if(updated) updated.textContent='Error'
      dbg('Events fetch failed: '+r.error)
      return
    }

    if(list) {
      list.innerHTML = ''
      if (!r.events || !r.events.length) {
        list.innerHTML = '<div class="evt-none">No upcoming events found.</div>'
      } else {
        for (const evt of r.events) {
          const row = document.createElement('div')
          row.className = 'evt-row'
          const startDate = evt.start_at ? new Date(evt.start_at).toLocaleDateString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '?'
          const game = evt.game || 'ETS2'
          row.innerHTML =
            `<div class="evt-name" title="${escHtml(evt.name)}">${escHtml(evt.name || 'Unnamed Event')}</div>` +
            `<div class="evt-meta">` +
            `<span class="evt-game-tag">${game}</span>` +
            `<span>${startDate}</span>` +
            (evt.server?.name ? `<span>· ${escHtml(evt.server.name)}</span>` : '') +
            `</div>`
          list.appendChild(row)
        }
      }
      list.classList.remove('hidden')
    }

    const now = new Date()
    if(updated) updated.textContent = 'Updated '+now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
    dbg(`Events loaded: ${r.events?.length||0} events`)
  } catch(e) {
    if(loading) { loading.classList.remove('hidden'); loading.className='srv-error'; loading.textContent='⚠ Error: '+e.message }
    if(updated) updated.textContent='Error'
    dbg('Events error: '+e.message)
  }
}

// ── Player Lookup ─────────────────────────────────────────────────────────────
async function lookupPlayer() {
  const input=$('player-id-input'), resultEl=$('player-result'), errEl=$('player-error'), loadEl=$('player-loading')
  const btn=$('btn-player-lookup')
  const id = input ? input.value.trim() : ''
  if (!id) return

  if(resultEl) { resultEl.classList.add('hidden'); resultEl.innerHTML='' }
  if(errEl)    { errEl.classList.add('hidden');    errEl.textContent='' }
  if(loadEl)   { loadEl.classList.remove('hidden') }
  if(btn)      { btn.disabled=true; btn.textContent='Searching…' }

  dbg(`Player lookup: ID=${id}`)
  const r = await window.api.lookupPlayer(id)

  if(loadEl)   loadEl.classList.add('hidden')
  if(btn)      { btn.disabled=false; btn.textContent='Look Up' }

  if (!r.ok) {
    if(errEl)  { errEl.textContent='⚠ '+r.error; errEl.classList.remove('hidden') }
    dbg('Player lookup failed: '+r.error)
    return
  }

  const p = r.player
  const joinYear = p.joinDate ? new Date(p.joinDate).getFullYear() : '?'
  const bansClass = p.bansCount === 0 ? 'ban-none' : p.bansCount < 3 ? 'ban-some' : 'ban-many'
  const bannedText = p.banned ? `<span class="player-stat-val banned-now">BANNED</span>` : `<span class="player-stat-val ${bansClass}">${p.bansCount} ban${p.bansCount===1?'':'s'}</span>`
  const vtcHtml = p.vtc && p.vtc.inVTC
    ? `<div class="player-vtc">
        <div>
          <div class="player-vtc-label">Virtual Trucking Co.</div>
          <div class="player-vtc-name">${escHtml(p.vtc.name || '—')} <span class="player-vtc-tag">[${escHtml(p.vtc.tag || '')}]</span></div>
        </div>
      </div>`
    : ''

  const card = `
    <div class="player-card">
      <div class="player-card-top">
        <img class="player-avatar" src="${p.avatar||''}" alt="avatar" onerror="this.style.display='none'"/>
        <div class="player-name-block">
          <div class="player-name">${escHtml(p.name || '?')}</div>
          <div class="player-group" style="color:${p.groupColor||'#9ca3af'}">${escHtml(p.groupName||'')}</div>
          <span class="player-id-badge">ID: ${p.id}</span>
        </div>
      </div>
      <div class="player-stats">
        <div class="player-stat">
          <div class="player-stat-label">Joined</div>
          <div class="player-stat-val">${joinYear}</div>
        </div>
        <div class="player-stat">
          <div class="player-stat-label">Bans</div>
          ${bannedText}
        </div>
      </div>
      ${vtcHtml}
    </div>`

  if(resultEl) { resultEl.innerHTML=card; resultEl.classList.remove('hidden') }
  dbg(`Player found: ${p.name} (ID ${p.id}), bans: ${p.bansCount}`)
}

// ── Keybinds ──────────────────────────────────────────────────────────────────
const KB_DEFAULTS = {
  launch:   { meta:true, key:'l' },
  stop:     { meta:true, key:'.' },
  steam:    { meta:true, key:'s' },
  refresh:  { meta:true, key:'r' },
  clear:    { meta:true, key:'k' },
  settings: { meta:true, key:',' },
}
const KB_ACTIONS = {
  launch:   () => { if(!running) { $('btn-launch')?.click(); dbg('Keybind: launch') } else if(running) { $('btn-launch')?.click(); dbg('Keybind: launch (stop)') } },
  stop:     () => { if(running) { $('btn-launch')?.click(); dbg('Keybind: stop') } },
  steam:    () => { $('btn-steam')?.click(); dbg('Keybind: steam toggle') },
  refresh:  () => { $('btn-refresh-srv')?.click(); loadServerStatus(); dbg('Keybind: refresh servers') },
  clear:    () => { $('btn-clear-log')?.click(); dbg('Keybind: clear log') },
  settings: () => { $('btn-header-settings')?.click(); dbg('Keybind: open settings') },
}
function kbToString(b) {
  if (!b || !b.key) return '—'
  let s = ''
  if (b.meta)  s += '⌘'
  if (b.ctrl)  s += '⌃'
  if (b.alt)   s += '⌥'
  if (b.shift) s += '⇧'
  let k = b.key.length === 1 ? b.key.toUpperCase() : b.key
  return s + k
}
function kbMatches(e, b) {
  if (!b || !b.key) return false
  if (!!b.meta  !== !!e.metaKey)  return false
  if (!!b.ctrl  !== !!e.ctrlKey)  return false
  if (!!b.alt   !== !!e.altKey)   return false
  if (!!b.shift !== !!e.shiftKey) return false
  return e.key.toLowerCase() === b.key.toLowerCase()
}
function setupKeybinds() {
  if (!settings.keybinds) settings.keybinds = {}
  // fill in any missing defaults
  for (const k of Object.keys(KB_DEFAULTS)) {
    if (!settings.keybinds[k]) settings.keybinds[k] = { ...KB_DEFAULTS[k] }
  }
  refreshKbButtons()

  // wire each keybind button to record-on-click
  document.querySelectorAll('.kb-btn').forEach(btn => {
    btn.addEventListener('click', () => startRecordingKeybind(btn))
  })
  // reset to defaults
  $('btn-kb-reset')?.addEventListener('click', () => {
    settings.keybinds = JSON.parse(JSON.stringify(KB_DEFAULTS))
    window.api.saveSettings(settings)
    refreshKbButtons()
    dbg('Keybinds reset to defaults')
  })

  // Global keydown — dispatch to actions
  document.addEventListener('keydown', e => {
    if (recordingKb) return  // recording mode handles its own keydown
    for (const action of Object.keys(KB_ACTIONS)) {
      if (kbMatches(e, settings.keybinds[action])) {
        e.preventDefault()
        KB_ACTIONS[action]()
        return
      }
    }
  })
}
function refreshKbButtons() {
  document.querySelectorAll('.kb-btn').forEach(btn => {
    const action = btn.dataset.kb
    btn.textContent = kbToString(settings.keybinds[action])
    btn.classList.remove('recording')
  })
}
let recordingKb = null
function startRecordingKeybind(btn) {
  if (recordingKb) {
    // cancel previous
    refreshKbButtons()
  }
  recordingKb = btn
  btn.textContent = 'Press a key…'
  btn.classList.add('recording')
  const onKey = (e) => {
    e.preventDefault()
    e.stopPropagation()
    // ignore lone modifier keys
    if (['Meta','Control','Alt','Shift'].includes(e.key)) return
    // Escape cancels
    if (e.key === 'Escape') {
      recordingKb = null
      refreshKbButtons()
      window.removeEventListener('keydown', onKey, true)
      dbg('Keybind recording cancelled')
      return
    }
    const newBind = {
      meta:  e.metaKey,
      ctrl:  e.ctrlKey,
      alt:   e.altKey,
      shift: e.shiftKey,
      key:   e.key,
    }
    const action = btn.dataset.kb
    settings.keybinds[action] = newBind
    window.api.saveSettings(settings)
    dbg(`Keybind '${action}' set to ${kbToString(newBind)}`)
    recordingKb = null
    refreshKbButtons()
    window.removeEventListener('keydown', onKey, true)
  }
  window.addEventListener('keydown', onKey, true)
}

// ── Telemetry view helpers ─────────────────────────────────────────────────────
const _LOG_ICON_SVG  = `<svg viewBox="0 0 20 20" width="13" fill="currentColor"><path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h7a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h4a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/></svg>`
const _TELEM_ICON_SVG = `<svg viewBox="0 0 20 20" width="13" fill="currentColor"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zm6-4a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zm6-3a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/></svg>`

function updateLogBtn(telemMode) {
  const btn = $('btn-header-log')
  if (!btn) return
  btn.innerHTML = telemMode
    ? `${_TELEM_ICON_SVG}<span>Telemetry</span>`
    : `${_LOG_ICON_SVG}<span>Log</span>`
  btn.title = telemMode ? 'Switch to Log' : 'Switch to Telemetry'
}

function applyTelemView(on) {
  const lb = $('log-body'), tp = $('telemetry-panel')
  if (lb) lb.classList.toggle('hidden', on)
  if (tp) tp.classList.toggle('hidden', !on)
  updateLogBtn(on)
  settings.replaceLogTelemetry = on
}


// ── Wire Events ───────────────────────────────────────────────────────────────
function wireEvents() {
  dbg('Wiring events…')

  // Server status refresh button
  const btnRefreshSrv=$('btn-refresh-srv')
  if(btnRefreshSrv) btnRefreshSrv.addEventListener('click',async()=>{
    btnRefreshSrv.textContent='↻'; btnRefreshSrv.disabled=true
    await loadServerStatus()
    btnRefreshSrv.textContent='↻ Refresh'; btnRefreshSrv.disabled=false
  })

  // TMP info refresh button
  const btnRefreshTmp=$('btn-refresh-tmp')
  if(btnRefreshTmp) btnRefreshTmp.addEventListener('click',async()=>{
    btnRefreshTmp.textContent='↻'; btnRefreshTmp.disabled=true
    await loadTMPInfo()
    btnRefreshTmp.textContent='↻ Refresh'; btnRefreshTmp.disabled=false
  })

  // Events refresh button
  const btnRefreshEvt=$('btn-refresh-evt')
  if(btnRefreshEvt) btnRefreshEvt.addEventListener('click',async()=>{
    btnRefreshEvt.textContent='↻'; btnRefreshEvt.disabled=true
    await loadTMPEvents()
    btnRefreshEvt.textContent='↻ Refresh'; btnRefreshEvt.disabled=false
  })

  // Player lookup button + Enter key
  const btnPlayerLookup=$('btn-player-lookup'), playerInput=$('player-id-input')
  if(btnPlayerLookup) btnPlayerLookup.addEventListener('click', lookupPlayer)
  if(playerInput) playerInput.addEventListener('keydown', e=>{ if(e.key==='Enter') lookupPlayer() })

  // Right sidebar collapse/expand toggle
  const btnToggleRight=$('btn-toggle-right'), sidebarRight=$('sidebar-right')
  if(btnToggleRight && sidebarRight) {
    // Restore persisted state
    try { if(localStorage.getItem('rightSidebarCollapsed')==='1') { sidebarRight.classList.add('collapsed'); btnToggleRight.textContent='›' } } catch {}
    btnToggleRight.addEventListener('click', () => {
      const collapsed = sidebarRight.classList.toggle('collapsed')
      btnToggleRight.textContent = collapsed ? '›' : '‹'
      try { localStorage.setItem('rightSidebarCollapsed', collapsed ? '1' : '0') } catch {}
    })
  }

  // ── Header log/telemetry icon button ────────────────────────────────────────
  $('btn-header-log')?.addEventListener('click', () => {
    applyTelemView(!settings.replaceLogTelemetry)
    window.api.saveSettings(settings)
    dbg(`Toggle telemetry view → ${settings.replaceLogTelemetry}`)
  })

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      dbg(`Tab → ${btn.dataset.tab}`)
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'))
      btn.classList.add('active')
      document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'))
      const panel=$('panel-'+btn.dataset.tab); if(panel) panel.classList.add('active')
    })
  })

  // ── Settings / About popup modals ──────────────────────────────────────────
  const popupBackdrop = $('popup-backdrop')
  let activePopupPanel = null

  function openPopup(panelId) {
    if (activePopupPanel) closePopup()
    const panel = $(panelId)
    if (!panel || !popupBackdrop) return
    panel.classList.remove('closing')
    popupBackdrop.classList.remove('closing')
    panel.classList.add('active', 'as-popup')
    popupBackdrop.classList.remove('hidden')
    activePopupPanel = panel
    dbg(`Popup open: ${panelId}`)
  }

  function closePopup() {
    if (!activePopupPanel) return
    const panel = activePopupPanel
    activePopupPanel = null
    panel.classList.add('closing')
    if (popupBackdrop) popupBackdrop.classList.add('closing')
    setTimeout(() => {
      panel.classList.remove('active', 'as-popup', 'closing')
      if (popupBackdrop) popupBackdrop.classList.add('hidden')
      if (popupBackdrop) popupBackdrop.classList.remove('closing')
    }, 150)
    dbg('Popup closed')
  }

  $('btn-header-settings')?.addEventListener('click', () => {
    openPopup('panel-settings')
    const gearBtn = $('btn-header-settings')
    if (gearBtn) {
      gearBtn.classList.remove('gear-spin')
      // Force reflow so re-clicking re-triggers the animation
      void gearBtn.offsetWidth
      gearBtn.classList.add('gear-spin')
      gearBtn.addEventListener('animationend', () => gearBtn.classList.remove('gear-spin'), { once: true })
    }
  })
  $('btn-header-about')?.addEventListener('click',    () => openPopup('panel-about'))
  $('close-settings-popup')?.addEventListener('click', closePopup)
  $('close-about-popup')?.addEventListener('click',    closePopup)
  if (popupBackdrop) popupBackdrop.addEventListener('click', closePopup)

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && activePopupPanel) closePopup()
  })


  // ── Show Wine Activity toggle ────────────────────────────────────────────────
  const wineActivityCb = $('s-show-wine-activity')
  if (wineActivityCb) {
    wineActivityCb.addEventListener('change', () => {
      const on = wineActivityCb.checked
      const sec = $('log-wine-section')
      if (sec) sec.classList.toggle('hidden', !on)
      settings.showWineActivity = on
      window.api.saveSettings(settings)
      dbg(`Show Wine Activity → ${on}`)
    })
  }

  // Start / Stop Steam
  const btnSteam=$('btn-steam')
  if(btnSteam) {
    btnSteam.addEventListener('click', async () => {
      collect()

      if (steamRunning) {
        // Stop Steam
        dbg('Stop Steam clicked')
        btnSteam.disabled = true
        btnSteam.innerHTML = STEAM_ICON_SVG + 'Stopping…'
        const res = await window.api.stopSteam(settings)
        if (!res.ok) {
          pushLog({kind:'error', text:'Stop Steam failed: ' + res.error, ts:Date.now()})
          dbg('Stop Steam failed: ' + res.error)
        } else {
          steamRunning = false
          pushLog({kind:'system', text:'Steam stopped.', ts:Date.now()})
          pushLog({kind:'warn', text:'Please search for "wine" in the Activity Monitor and terminate any lingering processes. While this may not be ideal it will be resolved in the future.', ts:Date.now()})
          dbg('Steam stopped OK')
        }
        updateSteamBtn()
      } else {
        // Start Steam
        dbg('Start Steam clicked')
        btnSteam.disabled = true
        btnSteam.innerHTML = STEAM_ICON_SVG + 'Launching…'
        let res
        try {
          res = await window.api.startSteam(settings)
        } catch(err) {
          res = { ok: false, error: err && err.message ? err.message : String(err) }
        }
        btnSteam.disabled = false
        if (!res || !res.ok) {
          pushLog({kind:'error', text:'Steam launch failed: ' + (res ? res.error : 'unknown error'), ts:Date.now()})
          dbg('Steam launch failed: ' + (res ? res.error : 'unknown error'))
          steamRunning = false
        } else {
          steamRunning = true
          dbg('Steam launched OK')
        }
        updateSteamBtn()
      }
    })
  }

  // Launch / Stop
  const btnLaunch=$('btn-launch')
  if(btnLaunch) btnLaunch.addEventListener('click',async()=>{
    if(running){
      dbg('Stop clicked')
      await window.api.stopGame()
      setStatus('Stopping…','stopping',null)
    } else {
      collect()
      dbg(`Launch clicked | mode=${launchMode}`)
      launching=true; setStatus('Launching…','launching',null); updateLaunchBtn()
      document.querySelector('[data-tab="log"]')?.click()

      // Connectivity check
      try {
        const conn = await window.api.checkTMPPort()
        if (!conn.reachable) {
          pushLog({kind:'warn', text:'⚠ TruckersMP servers not reachable — VPN may be required. Continuing anyway…', ts:Date.now()})
          dbg('Connectivity check failed — VPN may be needed')
        } else {
          pushLog({kind:'info', text:'› TruckersMP connectivity OK', ts:Date.now()})
          dbg('Connectivity check passed')
        }
      } catch(e) {
        dbg('Connectivity check error: '+e.message)
      }

      const res=await window.api.launchGame(settings)
      launching=false
      if(!res.ok){
        running=false; setStatus('Error','error',null); updateLaunchBtn()
        // Split multiline error messages into separate log lines for readability
        const now = Date.now()
        pushLog({kind:'error', text:'══════════════════════════════════════', ts:now})
        pushLog({kind:'error', text:'  Launch Failed', ts:now})
        pushLog({kind:'error', text:'══════════════════════════════════════', ts:now})
        const lines = res.error.split('\n')
        lines.forEach((line, i) => {
          if (line.trim()) {
            const kind = line.startsWith('Fix:') || line.startsWith('•') ? 'warn' : i===0 ? 'error' : 'info'
            pushLog({kind, text: line, ts: now + i})
          }
        })
        pushLog({kind:'system', text:'══════════════════════════════════════', ts:now})
        dbg('Launch failed: '+lines[0])
      } else {
        running=true; setStatus('Running','running',res.pid); updateLaunchBtn()
        document.body.classList.add('bg-paused')   // pause animations while game runs
        dbg(`Launched PID ${res.pid}`)
      }
    }
  })

  // Force Kill Wine
  const btnFK=$('btn-forcekill')
  if(btnFK) btnFK.addEventListener('click',async()=>{
    dbg('Force Kill clicked')
    btnFK.disabled=true; btnFK.textContent='☠ Killing…'
    await window.api.forceStopGame()
    setTimeout(()=>{ btnFK.disabled=false; btnFK.textContent='☠ Force Kill Wine' },2000)
  })

  // winecfg buttons (standalone + crossover)
  async function doLaunchWinecfg(btn) {
    collect()
    btn.disabled=true; btn.textContent='Launching…'
    const res = await window.api.launchWinecfg(settings)
    btn.disabled=false; btn.textContent='⚙ Launch winecfg'
    if (!res.ok) pushLog({kind:'error', text:'winecfg failed: '+res.error, ts:Date.now()})
    else pushLog({kind:'info', text:'winecfg opened', ts:Date.now()})
  }
  const btnWinecfg=$('btn-winecfg')
  if(btnWinecfg) btnWinecfg.addEventListener('click',()=>doLaunchWinecfg(btnWinecfg))
  const btnWinecfgCX=$('btn-winecfg-cx')
  if(btnWinecfgCX) btnWinecfgCX.addEventListener('click',()=>doLaunchWinecfg(btnWinecfgCX))

  // Open Wine bottle folder in Finder
  const btnOpenBottleFinder = $('btn-open-bottle-finder')
  if (btnOpenBottleFinder) {
    btnOpenBottleFinder.addEventListener('click', async () => {
      const bp = settings.standalonBottlePath
      if (!bp) { showToast('No bottle path set — configure it in Settings first.', 'warn'); return }
      const r = await window.api.openInFinder(bp)
      if (!r.ok) showToast('Could not open Finder: ' + r.error, 'error')
    })
  }

  // Auto-detect Steam and ETS2 paths inside the bottle
  const btnAutoDetect = $('btn-auto-detect-paths')
  if (btnAutoDetect) {
    btnAutoDetect.addEventListener('click', async () => {
      const bp = settings.standalonBottlePath
      if (!bp) { showToast('No bottle path set — configure it in Settings first.', 'warn'); return }
      btnAutoDetect.disabled = true; btnAutoDetect.textContent = '🔍 Detecting…'
      let found = []
      try {
        const stRes = await window.api.swAutoDetectSteamPath(bp)
        if (stRes.ok && stRes.steamDir) {
          settings.standalonSteamDir = stRes.steamDir
          fillField('sw-steam-dir', stRes.steamDir)
          found.push('Steam: ' + stRes.steamDir)
        }
      } catch {}
      try {
        const gRes = await window.api.swAutoDetectGamePath(bp)
        if (gRes.ok && gRes.gameDir) {
          settings.standalonGameDir = gRes.gameDir
          fillField('sw-game-dir', gRes.gameDir)
          found.push('ETS2: ' + gRes.gameDir)
        }
      } catch {}
      btnAutoDetect.disabled = false; btnAutoDetect.textContent = '🔍 Auto-detect Paths'
      if (found.length) {
        collect(); window.api.saveSettings(settings)
        pushLog({ kind:'success', text:'Auto-detected: ' + found.join(' | '), ts:Date.now() })
      } else {
        showToast('Nothing detected. Make sure Steam and ETS2 are installed inside the bottle first.', 'warn')
      }
    })
  }

  // Reinstall DXMT from a new .tar.gz without going through the full wizard
  const btnRepairDxmt = $('btn-repair-dxmt')
  if (btnRepairDxmt) {
    btnRepairDxmt.addEventListener('click', async () => {
      const result = await window.api.browse({ folder:false, message:'Select a DXMT .tar.gz release archive' })
      if (!result) return
      const tarPath = result
      btnRepairDxmt.disabled = true; btnRepairDxmt.textContent = 'Installing…'
      const res = await window.api.swInstallDxmt(tarPath)
      btnRepairDxmt.disabled = false; btnRepairDxmt.textContent = '🔧 Reinstall DXMT'
      if (!res.ok) {
        pushLog({ kind:'error', text:'DXMT reinstall failed: ' + res.error, ts:Date.now() })
        return
      }
      settings.standalonDxmtDir = res.dxmtDir
      if (res.dxmtFileVersion) settings.standalonDxmtVersion = res.dxmtFileVersion
      collect(); window.api.saveSettings(settings)
      swRefreshStatusBadges()
      pushLog({ kind:'success', text:'DXMT reinstalled ✓ → ' + res.dxmtDir, ts:Date.now() })
    })
  }

  // Wine Activity panel — auto-refreshes every 8 s
  async function refreshWineProcs() {
    const list = $('wine-proc-list'); if (!list) return
    const res = await window.api.listWineProcesses()
    if (!res.ok || !res.processes.length) {
      list.innerHTML = '<span style="color:var(--text-muted)">No Wine processes running.</span>'
      return
    }
    list.innerHTML = res.processes.map(p =>
      `<div style="display:flex;gap:8px;flex-wrap:wrap">` +
      `<span style="color:var(--accent-dim);min-width:38px;flex-shrink:0">${p.pid}</span>` +
      `<span style="color:var(--text-primary);min-width:80px;flex-shrink:0">${p.comm}</span>` +
      `<span style="color:var(--text-secondary);word-break:break-all">${p.args}</span>` +
      `</div>`
    ).join('')
  }
  // Start auto-refresh for Wine Activity (runs every 8 s while section is visible)
  setInterval(() => {
    const section = $('log-wine-section')
    if (section && !section.classList.contains('hidden')) refreshWineProcs()
  }, 8000)
  // Initial load on startup
  refreshWineProcs()
  // Wine CLI (standalone only)
  const btnRunWineCmd = $('btn-run-wine-cmd')
  const wineCmd       = $('sw-wine-cmd')
  const wineCmdResult = $('wine-cmd-result')
  async function runWineCmd() {
    const cmd = (wineCmd ? wineCmd.value : '').trim()
    if (!cmd) return
    if (btnRunWineCmd) { btnRunWineCmd.disabled=true; btnRunWineCmd.textContent='▶ Running…' }
    if (wineCmdResult) wineCmdResult.innerHTML = '<span style="color:var(--text-muted)">Launching…</span>'
    const res = await window.api.runWineCommand(cmd, settings)
    if (btnRunWineCmd) { btnRunWineCmd.disabled=false; btnRunWineCmd.textContent='▶ Run' }
    if (wineCmdResult) {
      if (res.ok) wineCmdResult.innerHTML = `<span style="color:var(--green)">✓ ${cmd} launched</span>`
      else wineCmdResult.innerHTML = `<span style="color:var(--red)">✗ ${res.error}</span>`
    }
  }
  if (btnRunWineCmd) btnRunWineCmd.addEventListener('click', runWineCmd)
  if (wineCmd) wineCmd.addEventListener('keydown', e => { if (e.key === 'Enter') runWineCmd() })

  // Wine Diagnostics
  const btnWineDiag  = $('btn-wine-diag')
  const wineDiagOut  = $('wine-diag-result')
  // Kill All Wine Processes button
  const btnKillAll    = $('btn-kill-all-wine')
  const killAllResult = $('kill-wine-result')
  if (btnKillAll) btnKillAll.addEventListener('click', async () => {
    collect()
    btnKillAll.disabled = true; btnKillAll.textContent = '⬛ Killing…'
    if (killAllResult) killAllResult.innerHTML = ''
    const res = await window.api.killAllWine(settings)
    btnKillAll.disabled = false; btnKillAll.textContent = '⬛ Kill All Wine Processes'
    if (killAllResult) {
      killAllResult.innerHTML = res.ok
        ? '<span style="color:var(--green)">✓ All Wine processes killed.</span>'
        : `<span style="color:var(--red)">✗ ${res.error}</span>`
    }
    // Also reset button states so the UI doesn't show game/steam as running
    running = false; launching = false; steamRunning = false
    updateLaunchBtn(); updateSteamBtn()
    setTimeout(() => { if (killAllResult) killAllResult.innerHTML = '' }, 4000)
  })

  // Bottle path change → auto-detect Steam + ETS2 inside the new bottle
  const swBottleInput = $('sw-bottle-path')
  if (swBottleInput) swBottleInput.addEventListener('change', () => {
    const bp = swBottleInput.value.trim()
    if (bp) { settings.standalonBottlePath = bp; detectStandaloneBottlePaths(bp) }
  })

  if (btnWineDiag) btnWineDiag.addEventListener('click', async () => {
    collect()
    btnWineDiag.disabled = true; btnWineDiag.textContent = '🔍 Running…'
    if (wineDiagOut) wineDiagOut.innerHTML = '<span style="color:var(--text-muted)">Running checks…</span>'
    const res = await window.api.diagnoseWine(settings)
    btnWineDiag.disabled = false; btnWineDiag.textContent = '🔍 Run'
    if (!wineDiagOut) return
    if (!res || !res.checks) {
      wineDiagOut.innerHTML = '<span style="color:var(--red)">Unexpected error — no response from main process.</span>'
      return
    }
    const rows = res.checks.map(c => {
      const icon   = c.ok ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--red)">✗</span>'
      const label  = `<span style="color:var(--text-primary)">${c.label}</span>`
      const detail = c.detail
        ? `<span style="color:var(--text-muted);padding-left:6px">${c.detail.length > 60 ? '…'+c.detail.slice(-57) : c.detail}</span>`
        : ''
      return `<div style="display:flex;gap:6px;white-space:nowrap;overflow:hidden">${icon} ${label}${detail}</div>`
    }).join('')
    const summary = res.ok
      ? '<div style="color:var(--green);font-weight:600;margin-bottom:4px">All checks passed ✓</div>'
      : '<div style="color:var(--red);font-weight:600;margin-bottom:4px">Some checks failed — see details below</div>'
    wineDiagOut.innerHTML = summary + rows
  })

  // Also refresh when settings tab is opened
  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.dataset.tab === 'settings') btn.addEventListener('click', refreshWineProcs)
  })

  // ── Wine Process Manager Modal (🔍 button) ─────────────────────────────────
  const wineModalEl      = $('wine-proc-modal')
  const wineModalList    = $('wine-proc-modal-list')
  const wineModalClose   = $('wine-proc-modal-close')
  const btnWineProcDetail= $('btn-wine-proc-detail')
  let _wineModalTimer    = null

  async function refreshModalProcs() {
    if (!wineModalList) return
    wineModalList.innerHTML = '<span style="color:var(--text-muted)">Checking…</span>'
    const res = await window.api.listWineProcesses()
    if (!res.ok || !res.processes.length) {
      wineModalList.innerHTML = '<span style="color:var(--text-muted);display:block;padding:20px 0;text-align:center">No Wine processes running.</span>'
      return
    }
    wineModalList.innerHTML = res.processes.map(p => {
      const safe = (p.args || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      return `<div style="display:flex;flex-direction:column;gap:3px;padding:9px 11px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:7px;margin-bottom:7px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="color:var(--accent-dim);min-width:46px;font-size:10.5px">${p.pid}</span>
          <span style="color:var(--text-primary);font-weight:700;font-size:11.5px">${p.comm}</span>
          <button data-kill-pid="${p.pid}" style="margin-left:auto;font-size:10px;padding:2px 10px;background:rgba(248,113,113,0.12);border:1px solid rgba(248,113,113,0.3);border-radius:4px;color:#f87171;cursor:pointer">Kill</button>
        </div>
        <div style="color:var(--text-muted);font-size:10.5px;word-break:break-all;line-height:1.55;padding-left:56px">${safe}</div>
      </div>`
    }).join('')
    wineModalList.querySelectorAll('[data-kill-pid]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pid = parseInt(btn.dataset.killPid)
        btn.disabled = true; btn.textContent = '…'
        await window.api.killWineProcess(pid)
        setTimeout(refreshModalProcs, 400)
      })
    })
  }

  if (btnWineProcDetail) btnWineProcDetail.addEventListener('click', () => {
    if (wineModalEl) {
      wineModalEl.style.display = 'flex'
      refreshModalProcs()
      // Auto-refresh every 3 s while modal is open
      if (!_wineModalTimer) _wineModalTimer = setInterval(refreshModalProcs, 3000)
    }
  })
  function closeWineModal() {
    if (wineModalEl) wineModalEl.style.display = 'none'
    if (_wineModalTimer) { clearInterval(_wineModalTimer); _wineModalTimer = null }
  }
  if (wineModalClose) wineModalClose.addEventListener('click', closeWineModal)
  if (wineModalEl) wineModalEl.addEventListener('click', e => {
    if (e.target === wineModalEl) closeWineModal()
  })
  // Keyboard close
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && wineModalEl && wineModalEl.style.display !== 'none')
      wineModalEl.style.display = 'none'
  })

  // First-run welcome banner — dismiss & remember.
  const fbBanner = $('first-run-banner'), fbDismiss = $('btn-first-run-dismiss')
  if (fbBanner && fbDismiss) fbDismiss.addEventListener('click', () => {
    fbBanner.style.display = 'none'
    settings.firstRunSeen = true
    window.api.saveSettings(settings)
  })

  // Discord section — collapsible header. Click anywhere on the title row to
  // fold/unfold. State is persisted via collect() + saveSettings.
  const discTitleEl = $('discord-section-toggle'), discBodyEl = $('discord-section-body')
  if (discTitleEl && discBodyEl) discTitleEl.addEventListener('click', () => {
    const willCollapse = !discTitleEl.classList.contains('collapsed')
    discTitleEl.classList.toggle('collapsed', willCollapse)
    discBodyEl.style.display = willCollapse ? 'none' : ''
    settings.discordSectionCollapsed = willCollapse
    window.api.saveSettings(settings)
  })

  // RPC customiser toggle
  const btnRpcCustom=$('btn-rpc-custom'), rpcPanel=$('rpc-panel')
  if(btnRpcCustom && rpcPanel) btnRpcCustom.addEventListener('click',()=>{
    const open = rpcPanel.classList.toggle('open')
    btnRpcCustom.textContent = open ? '▲ Close Customiser' : '✏ Customise Rich Presence'
  })
  const btnRpcSave=$('btn-rpc-save')
  if(btnRpcSave) btnRpcSave.addEventListener('click',()=>{
    collect(); window.api.saveSettings(settings)
    btnRpcSave.textContent='✓ Saved'
    setTimeout(()=>{ btnRpcSave.textContent='Save' },1800)
  })

  // ── RPC extras: live update on change ────────────────────────────────────
  // Persist + push to main so toggles take effect mid-session without a
  // restart. Debounce the telemetry-path text input so we don't spam main
  // while the user is typing.
  const pushExtras = () => {
    collect()
    window.api.saveSettings(settings)
    // Show/hide the advanced sub-panel whenever the master toggle changes.
    const advPanel = $('rpc-advanced-panel')
    if (advPanel) advPanel.style.display = settings.rpcAdvanced ? '' : 'none'
    if (window.api.applyRpcOptions) window.api.applyRpcOptions({
      advanced:         settings.rpcAdvanced,
      autoReconnect:    settings.rpcAutoReconnect,
      afkEnabled:       false,
      telemetryEnabled: settings.telemetryEnabled,
      telemetryPath:    settings.telemetryPath,
    })
  }
  ;['s-rpc-reconnect','s-rpc-advanced','s-telemetry-enabled']
    .forEach(id => { const el=$(id); if (el) el.addEventListener('change', pushExtras) })
  const tpEl = $('s-telemetry-path')
  if (tpEl) {
    let tpTimer = null
    tpEl.addEventListener('input', () => {
      if (tpTimer) clearTimeout(tpTimer)
      tpTimer = setTimeout(pushExtras, 600)
    })
  }

  // ── RPC live status indicators ───────────────────────────────────────────
  // Main pushes us a status frame whenever the connection state, AFK
  // status, or telemetry health changes. We translate that into the
  // dot colour + label next to each toggle.
  const setDot = (dotId, textId, cls, text, title) => {
    const dot = $(dotId), txt = $(textId)
    if (dot) {
      dot.classList.remove('rpc-dot-off','rpc-dot-warn','rpc-dot-err','rpc-dot-ok')
      dot.classList.add(cls)
      if (title) dot.title = title
    }
    if (txt) txt.textContent = text
  }
  const renderRpcStatus = (s) => {
    if (!s) return
    // Reconnect dot
    const c = s.connection
    if      (c === 'connected')    setDot('rpc-reconnect-dot','rpc-reconnect-text','rpc-dot-ok',   'Connected',  'Connected to Discord')
    else if (c === 'connecting')   setDot('rpc-reconnect-dot','rpc-reconnect-text','rpc-dot-warn', 'Connecting…','Connecting to Discord')
    else if (c === 'reconnecting') setDot('rpc-reconnect-dot','rpc-reconnect-text','rpc-dot-warn', `Retry ${s.reconnect?.attempt}/${s.reconnect?.max}`, 'Reconnecting to Discord')
    else if (c === 'gave-up')      setDot('rpc-reconnect-dot','rpc-reconnect-text','rpc-dot-err',  'Gave up',    'Reconnect attempts exhausted')
    else                           setDot('rpc-reconnect-dot','rpc-reconnect-text','rpc-dot-off',  'Idle',       'Disconnected')
    // Telemetry dot
    const t = s.telemetry || {}
    if      (t.reason === 'off')       setDot('rpc-telemetry-dot','rpc-telemetry-text','rpc-dot-off','Off','Telemetry disabled')
    else if (t.reason === 'no-source') setDot('rpc-telemetry-dot','rpc-telemetry-text','rpc-dot-err','No source','Set a path/URL below')
    else if (t.ok)                     setDot('rpc-telemetry-dot','rpc-telemetry-text','rpc-dot-ok','OK','Telemetry source reachable')
    else                               setDot('rpc-telemetry-dot','rpc-telemetry-text','rpc-dot-err',`Error (${t.reason||'unknown'})`,'Telemetry source unreachable')
  }
  if (window.api.onRpcStatus) window.api.onRpcStatus(renderRpcStatus)
  // Pull current status on first load so the dots are correct even if the
  // game isn't running (e.g. Off / Idle / Active).
  if (window.api.getRpcStatus) window.api.getRpcStatus().then(renderRpcStatus).catch(()=>{})

  const btnRpcTest=$('btn-rpc-test'), rpcTestStatus=$('rpc-test-status')
  if(btnRpcTest) btnRpcTest.addEventListener('click', async ()=>{
    collect()
    const dur = Number(settings.rpcTestDuration) || 10
    const presetEl = $('s-rpc-test-preset')
    const presetLabel = presetEl ? (presetEl.options[presetEl.selectedIndex]?.text || 'sample') : 'sample'
    btnRpcTest.disabled=true; btnRpcTest.textContent='Testing…'
    if(rpcTestStatus) rpcTestStatus.textContent=`Connecting to Discord — “${presetLabel}” for ${dur}s…`
    const res = await window.api.testRPC(settings)
    btnRpcTest.disabled=false; btnRpcTest.textContent='▶ Test it!'
    if(res.ok) {
      const shownFor = res.duration || dur
      if(rpcTestStatus) { rpcTestStatus.textContent=`✓ Showing “${presetLabel}” in Discord for ${shownFor}s`; rpcTestStatus.style.color='#34d399' }
      setTimeout(()=>{ if(rpcTestStatus){ rpcTestStatus.textContent=''; rpcTestStatus.style.color='' } }, (shownFor + 1) * 1000)
    } else {
      if(rpcTestStatus) { rpcTestStatus.textContent='✗ '+res.error; rpcTestStatus.style.color='#f87171' }
      setTimeout(()=>{ if(rpcTestStatus){ rpcTestStatus.textContent=''; rpcTestStatus.style.color='' } },5000)
    }
  })

  // (!) info pill — toggle the Advanced RPC tutorial popover.
  // Important: after the first open we set `style.display = ''` (empty), and
  // `!''` is truthy, so the previous "open = none-or-empty" check would never
  // close again. Decide purely on the explicit "is it currently hidden?" flag
  // by checking computed style, which works regardless of how it got there.
  const btnAdvTut=$('btn-adv-tutorial'), advTutPop=$('adv-tutorial-popover')
  const isPopoverOpen = () => advTutPop && getComputedStyle(advTutPop).display !== 'none'
  const setPopover = (open) => {
    if (!advTutPop || !btnAdvTut) return
    advTutPop.style.display = open ? 'block' : 'none'
    btnAdvTut.setAttribute('aria-expanded', open ? 'true' : 'false')
  }
  if (btnAdvTut && advTutPop) {
    btnAdvTut.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      const opening = !isPopoverOpen()
      setPopover(opening)
      if (opening) {
        const warn = $('adv-rpc-standalone-warn')
        if (warn) warn.style.display = (settings.wineMode === 'standalone') ? 'block' : 'none'
      }
    })
    // Click anywhere outside the popover (or its trigger) closes it.
    document.addEventListener('click', (e) => {
      if (!isPopoverOpen()) return
      if (advTutPop.contains(e.target) || btnAdvTut.contains(e.target)) return
      setPopover(false)
    })
    // Escape closes it too — small accessibility nicety.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isPopoverOpen()) setPopover(false)
    })
  }

  // ── ETS2MP logs folder + Force Watch buttons ───────────────────────────
  const btnSetLogs   = $('btn-set-ets2mp-logs')
  const btnForceWatch= $('btn-force-watch-chat')
  const logsStatus   = $('ets2mp-logs-status')

  const refreshLogsStatus = () => {
    if (!logsStatus) return
    const p = settings.ets2mpLogsDir
    if (p) { logsStatus.textContent = '✓ ' + p; logsStatus.style.color = '#34d399' }
    else   { logsStatus.textContent = 'Not set — auto-detect or pick a folder'; logsStatus.style.color = '#9ca3af' }
  }
  refreshLogsStatus()

  if (btnSetLogs) btnSetLogs.addEventListener('click', async () => {
    btnSetLogs.disabled = true
    try {
      const res = await window.api.pickEts2mpLogsDir()
      if (res?.ok) {
        settings.ets2mpLogsDir = res.path
        refreshLogsStatus()
      }
    } finally { btnSetLogs.disabled = false }
  })

  if (btnForceWatch) btnForceWatch.addEventListener('click', async () => {
    btnForceWatch.disabled = true
    const original = btnForceWatch.textContent
    btnForceWatch.textContent = '🔍 Scanning…'
    const showStatus = (text, color) => {
      if (!logsStatus) return
      logsStatus.textContent = text
      logsStatus.style.color = color
      setTimeout(refreshLogsStatus, 5000)
    }
    try {
      const res = await window.api.forceWatchChatLog()
      switch (res?.state) {
        case 'found':
          showStatus(`✓ Simulation ${res.simulation} (${res.file})`, '#34d399'); break
        case 'no-marker':
          showStatus(`⚠ ${res.file}: no connection marker yet`, '#fcd34d'); break
        case 'no-file':
          showStatus(`⚠ Today's chat log not found`, '#fcd34d'); break
        case 'no-folder':
          showStatus(`✗ Logs folder not set`, '#f87171'); break
        default:
          showStatus(`✗ ${res?.error || 'Scan failed'}`, '#f87171')
      }
    } catch (e) {
      showStatus(`✗ ${e.message}`, '#f87171')
    } finally {
      btnForceWatch.textContent = original
      btnForceWatch.disabled = false
    }
  })

  // Re-detect
  const btnDetect=$('btn-detect')
  if(btnDetect) btnDetect.addEventListener('click',async()=>{
    dbg('Re-detect clicked')
    btnDetect.textContent='↻ Detecting…'; btnDetect.disabled=true
    detected=await window.api.detectPaths()
    setBadge('badge-crossover', detected.crossoverFound)
    setBadge('badge-cli',       detected.cliFound)
    setBadge('badge-steam',     detected.steamFound)
    setBadge('badge-game',      detected.gameFound)
    if(detected.cliPath)    {settings.cliPath=detected.cliPath;       fillField('s-cli',    settings.cliPath);    setManual('cli',   false)}
    if(detected.winePath)   {settings.winePath=detected.winePath;     fillField('s-wine',   settings.winePath);   setManual('wine',  false)}
    if(detected.bottlePath) {settings.bottlePath=detected.bottlePath; fillField('s-bottle', settings.bottlePath);}
    if(detected.steamDir)   {settings.steamDir=detected.steamDir;     fillField('s-steam',  settings.steamDir);   setManual('steam', false)}
    if(detected.gameDir)    {settings.gameDir=detected.gameDir;       fillField('s-game',   settings.gameDir);    setManual('game',  false)}
    // In standalone mode, override steam/game badges with standalone-specific paths
    if (settings.wineMode === 'standalone') {
      setBadge('badge-steam', !!settings.standalonSteamDir)
      setBadge('badge-game',  !!settings.standalonGameDir)
    }
    validateAll()
    updatePreview(); updateLaunchBtn(); updateSteamBtn()
    btnDetect.textContent='↻ Re-detect'; btnDetect.disabled=false
    dbg(`Re-detect done: wine=${detected.crossoverFound} cli=${detected.cliFound} steam=${detected.steamFound} game=${detected.gameFound}`)
  })

  // Refresh interval selector
  const refreshSelEl = $('s-refresh-interval')
  if (refreshSelEl) refreshSelEl.addEventListener('change', () => {
    const ms = Number(refreshSelEl.value) || REFRESH_DEFAULT
    settings.refreshInterval = ms
    window.api.saveSettings(settings)
    startRefreshTimer(ms)
    dbg(`Refresh interval → ${ms}ms`)
  })

  // Use detected wine
  const btnUseWine=$('btn-use-wine')
  if(btnUseWine) btnUseWine.addEventListener('click',()=>{
    settings.winePath=detected.winePath
    fillField('s-wine',detected.winePath)
    validate('s-wine','v-wine',detected.winePath)
    updatePreview(); updateLaunchBtn(); updateSteamBtn()
    dbg('Auto-filled CrossOver Wine → '+detected.winePath)
  })

  // Browse buttons
  document.querySelectorAll('.s-browse').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      const id=btn.dataset.target, folder=btn.dataset.folder==='true'
      dbg(`Browse clicked for ${id} (folder=${folder})`)
      const result=await window.api.browse({folder})
      if(!result||!id) return
      fillField(id,result)
      collect(); updatePreview(); updateLaunchBtn(); updateSteamBtn()
      const vmap={'s-cli':'v-cli','s-wine':'v-wine','s-bottle':'v-bottle','s-steam':'v-steam','s-game':'v-game'}
      if(vmap[id]) await validate(id,vmap[id],result)
      // Mark as manually set in sidebar
      const manualMap={'s-cli':'cli','s-wine':'wine','s-steam':'steam','s-game':'game'}
      if(manualMap[id]) setManual(manualMap[id], true)
      dbg(`Browse ${id} → ${result.split('/').pop()} [MANUAL]`)
    })
  })

  // Live field input
  ;['s-cli','s-wine','s-bottle','s-steam','s-game','s-extra'].forEach(id=>{
    const el=$(id); if(!el) return
    el.addEventListener('input',()=>{collect();updatePreview();updateLaunchBtn();updateSteamBtn()})
    el.addEventListener('change',async()=>{
      collect();updatePreview();updateLaunchBtn();updateSteamBtn()
      const vmap={'s-cli':'v-cli','s-wine':'v-wine','s-bottle':'v-bottle','s-steam':'v-steam','s-game':'v-game'}
      if(vmap[id]) await validate(id,vmap[id],el.value.trim())
      // Mark as manual if user typed something, clear if empty
      const manualMap={'s-cli':'cli','s-wine':'wine','s-steam':'steam','s-game':'game'}
      if(manualMap[id]) setManual(manualMap[id], el.value.trim().length > 0)
      dbg(`Field ${id} changed → ${el.value.trim().split('/').pop()||'(empty)'} [MANUAL]`)
    })
  })

  // Checkboxes
  const disc=$('s-discord'), sp=$('s-sp'), mhud=$('s-metal-hud')
  if(disc) disc.addEventListener('change',()=>{collect();updatePreview();dbg(`Discord IPC → ${disc.checked}`)})
  if(sp)   sp.addEventListener('change',  ()=>{collect();updatePreview();dbg(`Singleplayer → ${sp.checked}`)})
  if(mhud) mhud.addEventListener('change',()=>{
    const sw=$('s-metal-hud-sw'); if(sw) sw.checked=mhud.checked
    collect();dbg(`Metal HUD → ${mhud.checked}`)
  })
  const mhudSwEl=$('s-metal-hud-sw')
  if(mhudSwEl) mhudSwEl.addEventListener('change',()=>{
    const orig=$('s-metal-hud'); if(orig) orig.checked=mhudSwEl.checked
    collect();dbg(`Metal HUD (SW) → ${mhudSwEl.checked}`)
  })
  const retinaCbEl=$('s-retina-mode')
  if(retinaCbEl) retinaCbEl.addEventListener('change',()=>{
    collect()
    window.api.saveSettings(settings)
    const isStandalone = settings.wineMode === 'standalone'
    const bp = isStandalone ? settings.standalonBottlePath : settings.bottlePath
    if(bp) window.api.swSetRetinaMode(bp, retinaCbEl.checked)
    dbg(`Retina Mode → ${retinaCbEl.checked}`)
  })

  // Copy preview
  const btnCopy=$('btn-copy')
  if(btnCopy) btnCopy.addEventListener('click',()=>{
    const txt=$('cmd-preview')?.textContent||''
    navigator.clipboard.writeText(txt)
    btnCopy.textContent='Copied!'; btnCopy.classList.add('ok')
    setTimeout(()=>{btnCopy.textContent='Copy';btnCopy.classList.remove('ok')},1500)
    dbg('Command copied to clipboard')
  })

  // Clear log
  const btnClear=$('btn-clear-log')
  if(btnClear) btnClear.addEventListener('click',()=>{
    logs=[]; rebuildLog(); dbg('Log cleared')
  })

  // Filter
  const logFilter=$('log-filter')
  if(logFilter) logFilter.addEventListener('input',()=>{
    filter=logFilter.value.trim().toLowerCase()
    const fc=$('filter-clear'); if(fc) fc.classList.toggle('hidden',!filter)
    rebuildLog()
    if(filter) dbg(`Filter → "${filter}"`)
  })
  const fc=$('filter-clear')
  if(fc) fc.addEventListener('click',()=>{
    const lf=$('log-filter'); if(lf) lf.value=''
    filter=''; fc.classList.add('hidden'); rebuildLog()
    dbg('Filter cleared')
  })

  // Log category filter buttons
  ;['all','wine','launcher'].forEach(cat => {
    const btn = $(`log-cat-${cat}`)
    if (!btn) return
    btn.addEventListener('click', () => {
      logCat = cat
      document.querySelectorAll('.log-cat-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      rebuildLog()
    })
  })

  // Timestamps & autoscroll
  const togTs=$('tog-ts')
  if(togTs) togTs.addEventListener('change',e=>{showTs=e.target.checked;rebuildLog();dbg(`Timestamps → ${showTs}`)})
  const togScroll=$('tog-scroll')
  if(togScroll) togScroll.addEventListener('change',e=>{
    autoScroll=e.target.checked
    if(autoScroll){const lb=$('log-body');if(lb)lb.scrollTop=lb.scrollHeight}
    dbg(`Auto-scroll → ${autoScroll}`)
  })

  // Save
  const btnSave=$('btn-save')
  if(btnSave) btnSave.addEventListener('click',async()=>{
    collect()
    dbg('Saving settings…')
    await window.api.saveSettings(settings)
    updatePreview(); updateLaunchBtn()
    const ok=$('save-ok')
    if(ok){ok.classList.remove('hidden');setTimeout(()=>ok.classList.add('hidden'),2000)}
    dbg('Settings saved ✓')
  })

  // Uninstall
  const btnUnSet=$('btn-uninstall-settings')
  if(btnUnSet) btnUnSet.addEventListener('click',uninstallSettings)

  // ── Keyboard shortcuts (configurable) ───────────────────────────────────
  setupKeybinds()

  dbg('All events wired ✓')
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function wireIPC() {
  window.api.onLog(e=>pushLog(e))
  window.api.onGameStopped(({code})=>{
    running=false
    document.body.classList.remove('bg-paused')
    if(code===0)       setStatus('Stopped','stopped',null)
    else if(code===-1) setStatus('Error','error',null)
    else               setStatus(`Stopped (exit ${code})`,'stopped',null)
    pushLog({kind:'warn', text:'Please search for "wine" in the Activity Monitor and terminate any lingering processes. While this may not be ideal it will be resolved in the future.', ts:Date.now()})
    updateLaunchBtn()
    dbg(`Game stopped with code ${code}`)
  })
  window.api.onSteamStopped(()=>{
    clearTimeout(window._cefRecoveryTimer)
    steamRunning = false
    updateSteamBtn()
    pushLog({kind:'system', text:'Steam process exited.', ts:Date.now()})
    dbg('Steam process exited')
  })
  window.api.onSteamRestarting(()=>{
    pushLog({kind:'warn', text:'Steam is restarting itself (CEF self-recovery). Waiting for session 2…', ts:Date.now()})
    const btn = $('btn-steam')
    if (btn) { btn.innerHTML = STEAM_ICON_SVG + 'Restarting…'; btn.disabled = true }
    dbg('Steam restarting (CEF self-restart)')
    // Safety net: if steam:ready never arrives within 90 s, re-enable the button
    // so the user isn't locked out waiting for a recovery that may have stalled.
    clearTimeout(window._cefRecoveryTimer)
    window._cefRecoveryTimer = setTimeout(() => {
      if (btn && btn.disabled) {
        steamRunning = false
        updateSteamBtn()
        pushLog({kind:'warn', text:'Steam recovery timed out. If Steam is running, click Stop Steam then Start Steam again.', ts:Date.now()})
      }
    }, 90000)
  })
  window.api.onSteamReady(()=>{
    clearTimeout(window._cefRecoveryTimer)
    steamRunning = true
    updateSteamBtn()
    pushLog({kind:'success', text:'Steam is ready.', ts:Date.now()})
    dbg('Steam ready signal received')
  })

  // ── ETS2MP logs folder prompt ────────────────────────────────────────────
  // Main asks us to prompt the user when it can't auto-locate the ETS2MP
  // logs folder on startup (or when starting the Discord RPC chat watcher).
  window.api.onEts2mpNeedsLogsDir(async () => {
    const ok = await showConfirm(
      "Couldn't find your ETS2MP logs folder.\n\nIt's normally at: ~/Documents/ETS2MP/logs\n\nThe launcher needs this folder so Discord Rich Presence can show which simulation you're connected to.\n\nPick it now?",
      'Pick Folder', 'Skip'
    )
    if (!ok) return
    try {
      const res = await window.api.pickEts2mpLogsDir()
      if (res?.ok) {
        // Refresh the in-memory settings copy so subsequent launches use it.
        try { settings.ets2mpLogsDir = res.path } catch {}
        if (typeof pushLog === 'function')
          pushLog({ kind:'success', text:`ETS2MP logs folder set to: ${res.path}`, ts:Date.now() })
      }
    } catch (e) {
      if (typeof pushLog === 'function')
        pushLog({ kind:'warn', text:`Failed to set ETS2MP logs folder: ${e.message}`, ts:Date.now() })
    }
  })
}

// ── Standalone Wine mode toggle (settings panel) ──────────────────────────────
function swApplyWineMode(mode) {
  const btnCX = $('wm-crossover'); const btnSW = $('wm-standalone')
  const infoCX = $('wm-crossover-info'); const infoSW = $('wm-standalone-info')
  const paths  = $('wm-standalone-paths')
  const cxWinecfg = $('wm-crossover-winecfg')
  if (!btnCX) return
  // Update settings.wineMode FIRST so updateSteamBtn/updateLaunchBtn
  // read the correct mode even before collect() runs.
  settings.wineMode = mode
  const standalone = mode === 'standalone'
  btnCX.classList.toggle('active', !standalone)
  btnSW.classList.toggle('active',  standalone)
  if (infoCX) infoCX.classList.toggle('hidden',  standalone)
  if (infoSW) infoSW.classList.toggle('hidden', !standalone)
  if (paths)  paths.classList.toggle('hidden',  !standalone)
  if (cxWinecfg) cxWinecfg.classList.toggle('hidden', standalone)

  // ── Update "via" label in game card ────────────────────────────────────────
  const lbl  = $('game-via-label')
  const icon = $('game-via-icon')
  if (lbl) lbl.textContent = standalone ? 'via Standalone Wine' : 'via CrossOver Wine'
  if (icon) {
    icon.src = standalone ? 'wine-logo.png' : 'logo1.png'
    icon.style.display = ''
    if (standalone) {
      icon.style.width = '14px'; icon.style.height = '14px'
      icon.style.objectFit = 'contain'; icon.style.filter = 'none'; icon.style.opacity = '0.8'
      icon.style.borderRadius = '0'
    } else {
      icon.style.width = ''; icon.style.height = ''
      icon.style.objectFit = ''; icon.style.filter = ''; icon.style.opacity = ''
      icon.style.borderRadius = ''
    }
  }

  const detWineIcon = $('det-wine-icon')
  if (detWineIcon) {
    detWineIcon.src = standalone ? 'wine-logo.png' : 'logo1.png'
    detWineIcon.style.objectFit = standalone ? 'contain' : ''
    detWineIcon.style.filter = ''
    detWineIcon.style.opacity = ''
    detWineIcon.style.borderRadius = standalone ? '0' : ''
  }

  // ── Update sidebar detection section for current mode ───────────────────────
  const detLabelWine = $('det-label-wine')
  if (detLabelWine) {
    detLabelWine.textContent = standalone ? 'Standalone Wine' : 'CrossOver Wine'
  }
  if (standalone) {
    // In standalone mode, show whether the standalone wine binary is installed
    window.api.swGetStatus().then(st => {
      setBadge('badge-crossover', st.wineInstalled)
    }).catch(() => setBadge('badge-crossover', false))
    // Update game and steam badges based on standalone configuration
    setBadge('badge-steam', !!settings.standalonSteamDir)
    setBadge('badge-game',  !!settings.standalonGameDir)
    // Refresh the settings-panel status indicators if the function is available
    if (typeof window._swRefreshStatusBadges === 'function') window._swRefreshStatusBadges()
  } else {
    // Back to crossover mode — restore the CrossOver detection result
    setBadge('badge-crossover', detected.crossoverFound)
    setBadge('badge-steam', detected.steamFound)
    setBadge('badge-game',  detected.gameFound)
  }

  // ── Dim CrossOver-only sections in settings when in standalone mode ──────────
  const scroll = document.querySelector('.settings-scroll')
  if (scroll) scroll.classList.toggle('sw-active', standalone)

  // ── Sync card wine toggle ───────────────────────────────────────────────────
  const cwtCX = $('cwt-cx'); const cwtSW = $('cwt-sw')
  if (cwtCX) cwtCX.classList.toggle('active', !standalone)
  if (cwtSW) cwtSW.classList.toggle('active',  standalone)

  // ── Show command preview in CrossOver mode, hide in standalone ──────────────
  const cmdSec = $('cmd-preview-section')
  if (cmdSec) cmdSec.style.display = standalone ? 'none' : ''

  // ── Wine status badge on game card ──────────────────────────────────────────
  const badge = $('wine-card-badge')
  if (badge) {
    if (standalone) {
      // Reset text immediately so stale content from previous mode never shows
      badge.textContent = '○ Checking…'
      badge.style.color = 'var(--text-secondary)'
      badge.classList.remove('hidden')
      window.api.swGetStatus().then(st => {
        if (!st.wineInstalled) {
          badge.textContent = '○ Wine not installed — open Settings to set up'
          badge.style.color = '#f87171'
        } else if (!st.bottleExists) {
          badge.textContent = '○ Bottle not set up — open Settings → Setup Wizard'
          badge.style.color = '#fb923c'
        } else {
          badge.style.color = '#4ade80'
          badge.textContent = '✓ Standalone Wine ready'
          window.api.swListWines().then(wines => {
            const active = wines.find(w => w.active) || wines[0]
            if (active) badge.textContent = `✓ ${active.version}`
          }).catch(() => {})
        }
      }).catch(() => {
        badge.textContent = '○ Status unavailable'
        badge.style.color = '#f87171'
      })
    } else {
      badge.classList.add('hidden')
    }
  }

  // ── Refresh launch / steam button readiness ─────────────────────────────────
  updateLaunchBtn()
  updateSteamBtn()
}

// ── Standalone Wine Setup Wizard ───────────────────────────────────────────────
;(function() {
  const wizard    = $('sw-wizard'); if (!wizard) return
  let swRelease   = null   // { name, url, size, version, major, minor, isYaagl } from API
  let swWizStep   = 1
  let swDefaultBottlePath = ''  // resolved from swGetStatus on first badge refresh

  // Convert a Wine version/filename string to a safe directory slug
  function slugifyWine(str) {
    return (str || 'wine').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'wine'
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  function fmt(bytes) {
    if (!bytes) return ''
    return bytes > 1024*1024 ? (bytes/1024/1024).toFixed(1)+' MB' : (bytes/1024).toFixed(0)+' KB'
  }
  function setErr(id, msg) {
    const el=$(id); if(!el) return
    el.textContent = msg; el.classList.toggle('visible', !!msg)
  }
  function setStepDots(step) {
    for (let i=1; i<=4; i++) {
      const d = $('swdot-'+i); if (!d) continue
      d.classList.remove('active','done')
      if (i < step) { d.classList.add('done'); d.style.cursor='pointer'; d.title='Go back to step '+i }
      else if (i === step) { d.classList.add('active'); d.style.cursor=''; d.title='' }
      else { d.style.cursor=''; d.title='' }
    }
  }
  function refreshDxmtSkipGlow() {
    const btn = $('sw-skip-dxmt')
    if (!btn) return
    window.api.swGetStatus().then(st => {
      if (st.dxmtExists) {
        btn.style.color       = 'var(--green)'
        btn.style.borderColor = 'var(--green)'
        btn.style.boxShadow   = '0 0 8px rgba(74,222,128,0.45), 0 0 0 1px rgba(74,222,128,0.18)'
        btn.textContent       = '✓ DXMT installed → Skip'
      } else {
        btn.style.color       = 'var(--text-muted)'
        btn.style.borderColor = 'rgba(235,235,245,0.15)'
        btn.style.boxShadow   = 'none'
        btn.textContent       = 'Skip for now'
      }
    })
  }

  function showStep(n) {
    swWizStep = n
    for (let i=1; i<=4; i++) {
      const p=$('swp-'+i); if(p) p.classList.toggle('active', i===n)
    }
    setStepDots(n)
    // Always refresh the DXMT skip glow when step 3 becomes visible,
    // regardless of which navigation path brought us here.
    if (n === 3) refreshDxmtSkipGlow()
  }
  // Click on a completed (done) step dot to jump back to that step
  for (let i = 1; i <= 4; i++) {
    const dot = $('swdot-' + i)
    if (dot) dot.addEventListener('click', () => {
      if (dot.classList.contains('done')) showStep(i)
    })
  }

  async function openWizard() {
    wizard.classList.remove('hidden')
    const st = await window.api.swGetStatus()

    // Colour-code skip buttons: green glow = step already done, grey = not done yet
    const skipWineBtn  = $('sw-skip-wine')
    const skipStep2Btn = $('sw-skip-2')
    const skipDxmtBtn  = $('sw-skip-dxmt')
    if (skipWineBtn) {
      if (st.wineInstalled) {
        skipWineBtn.style.color       = 'var(--green)'
        skipWineBtn.style.borderColor = 'var(--green)'
        skipWineBtn.style.boxShadow   = '0 0 8px rgba(74,222,128,0.45), 0 0 0 1px rgba(74,222,128,0.18)'
        skipWineBtn.textContent       = '✓ Already installed → Skip'
      } else {
        skipWineBtn.style.color       = 'var(--text-muted)'
        skipWineBtn.style.borderColor = 'rgba(235,235,245,0.15)'
        skipWineBtn.style.boxShadow   = 'none'
        skipWineBtn.textContent       = 'Already installed → Skip'
      }
    }
    if (skipStep2Btn) {
      if (st.bottleExists) {
        skipStep2Btn.style.color       = 'var(--green)'
        skipStep2Btn.style.borderColor = 'var(--green)'
        skipStep2Btn.style.boxShadow   = '0 0 8px rgba(74,222,128,0.45), 0 0 0 1px rgba(74,222,128,0.18)'
        skipStep2Btn.textContent       = '✓ Already done → Skip'
      } else {
        skipStep2Btn.style.color       = 'var(--text-muted)'
        skipStep2Btn.style.borderColor = 'rgba(235,235,245,0.15)'
        skipStep2Btn.style.boxShadow   = 'none'
        skipStep2Btn.textContent       = 'Already done → Skip'
      }
    }
    // DXMT skip button glow is handled by refreshDxmtSkipGlow() inside showStep(3).
    // Primary Install DXMT buttons — update text only; keep normal red styling.
    // Only the Skip button glows green when DXMT is already installed.
    const installDxmtBtn     = $('sw-install-dxmt')
    const autoInstallDxmtBtn = $('sw-auto-install-dxmt')
    if (installDxmtBtn) {
      installDxmtBtn.textContent = st.dxmtExists ? '✓ Reinstall DXMT →' : 'Install DXMT →'
      installDxmtBtn.style.color = ''
      installDxmtBtn.style.borderColor = ''
      installDxmtBtn.style.boxShadow = ''
    }
    if (autoInstallDxmtBtn) {
      autoInstallDxmtBtn.textContent = st.dxmtExists
        ? '✓ DXMT already installed — click to reinstall latest'
        : '⬇ Auto-install latest DXMT from GitHub'
      autoInstallDxmtBtn.style.color = ''
      autoInstallDxmtBtn.style.borderColor = ''
      autoInstallDxmtBtn.style.boxShadow = ''
    }

    if (!st.wineInstalled) {
      showStep(1); fetchWineRelease()
    } else if (!st.bottleExists) {
      showStep(2); prefillBottlePath()
    } else if (!st.dxmtExists) {
      showStep(3)
    } else {
      const msg = 'Standalone Wine is already fully set up.\n\nRestart the wizard anyway?\n' +
        '⚠️ Re-running Step 1 will replace the current Wine installation.\n' +
        'Re-running Step 2 will overwrite the existing bottle.'
      if (await showConfirm(msg, 'Restart Wizard')) { showStep(1); fetchWineRelease() }
      else wizard.classList.add('hidden')
    }
  }
  function closeWizard() { wizard.classList.add('hidden'); delete wizard.dataset.installOnly }

  // ── Step 1 ─────────────────────────────────────────────────────────────────
  // Sources: nohero765/wine-builds- (Stable) → if has releases show ONLY those.
  // If nohero765 has NO releases → show BobTheHero6767 (Dev) instead.

  function renderVersionPicker(versions, res) {
    const info = $('sw-wine-release-info')
    if (!info) return

    // nohero765 stable builds
    const stableBuilds = (versions || []).filter(v => v.isStable)
      .sort((a, b) => (b.major * 100 + b.minor) - (a.major * 100 + a.minor))
    // BobTheHero dev builds
    const devBuilds = ((res && res.wineTestVersions) || []).filter(v => v.isDevWine)
      .sort((a, b) => (b.major * 100 + b.minor) - (a.major * 100 + a.minor))

    // Pick which list to show — nohero takes precedence
    const showStable = stableBuilds.length > 0
    const list       = showStable ? stableBuilds : devBuilds

    if (!list.length) {
      info.innerHTML = '<span style="color:var(--red)">No wine releases found from either source.</span>'
      return
    }

    // Default selection = first in list (newest)
    swRelease = list[0]

    const selStyle   = 'border-color:var(--accent);background:rgba(59,130,246,0.1)'
    const unselStyle = 'border-color:rgba(235,235,245,0.1);background:transparent'

    const rows = list.map((v, i) => {
      const isSelected = i === 0
      const badge = showStable
        ? `<span style="color:#4ade80;font-size:10px;font-weight:700">✓ Stable</span>`
        : `<span style="color:#a78bfa;font-size:10px;font-weight:700">Dev</span>`
      const dot = isSelected
        ? `<span class="sw-ver-dot" style="width:14px;font-size:12px;color:var(--accent)">●</span>`
        : `<span class="sw-ver-dot" style="width:14px;font-size:12px;color:var(--text-muted)">○</span>`
      return `<div class="sw-ver-row"
        data-ver-url="${v.url}" data-ver-name="${v.name}" data-ver-size="${v.size || 0}"
        data-ver-version="${v.version || ''}" data-ver-major="${v.major || 0}" data-ver-minor="${v.minor || 0}"
        data-ver-dev="${v.isDevWine ? '1' : ''}"
        style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid;border-radius:6px;cursor:pointer;${isSelected ? selStyle : unselStyle}">
        ${dot}
        <span style="font-size:12px;font-weight:600">${v.version || v.name}</span>
        ${badge}
        <span style="margin-left:auto;font-size:10px;color:var(--text-muted)">${fmt(v.size)}</span>
      </div>`
    }).join('')

    info.innerHTML = `<div style="display:flex;flex-direction:column;gap:5px;margin-top:8px">${rows}</div>`

    // Update step 1 description to reflect selected version
    function updateStep1Desc(v) {
      const desc = $('sw-step1-desc')
      if (!desc) return
      const ver = v.version || v.name || ''
      desc.textContent = `This will install ${ver}`
    }
    updateStep1Desc(swRelease)

    // Click to select a different version — move dot to selected row
    info.querySelectorAll('.sw-ver-row').forEach(row => {
      row.addEventListener('click', () => {
        info.querySelectorAll('.sw-ver-row').forEach(r => {
          r.style.borderColor = 'rgba(235,235,245,0.1)'
          r.style.background  = 'transparent'
          const dot = r.querySelector('.sw-ver-dot')
          if (dot) { dot.textContent = '○'; dot.style.color = 'var(--text-muted)' }
        })
        row.style.borderColor = 'var(--accent)'
        row.style.background  = 'rgba(59,130,246,0.1)'
        const dot = row.querySelector('.sw-ver-dot')
        if (dot) { dot.textContent = '●'; dot.style.color = 'var(--accent)' }
        swRelease = {
          url:       row.dataset.verUrl,
          name:      row.dataset.verName,
          size:      parseInt(row.dataset.verSize) || 0,
          version:   row.dataset.verVersion,
          major:     parseInt(row.dataset.verMajor) || 0,
          minor:     parseInt(row.dataset.verMinor) || 0,
          isDevWine: !!row.dataset.verDev,
        }
        updateStep1Desc(swRelease)
      })
    })
  }

  function fetchWineRelease() {
    const info = $('sw-wine-release-info')
    if (info) info.innerHTML = '<span style="color:var(--text-secondary)">Checking available versions…</span>'
    window.api.swFetchWineRelease().then(res => {
      if (!res.ok) {
        if (info) info.innerHTML = `<span style="color:var(--red)">Failed to fetch: ${res.error}</span>`
        return
      }
      renderVersionPicker(res.versions, res)
    })
  }

  window.api.onWineProgress(data => {
    const wrap   = $('sw-wine-prog-wrap')
    const fill   = $('sw-wine-prog-fill')
    const label  = $('sw-wine-prog-label')
    const cancel = $('sw-cancel-wine-dl')
    if (!wrap) return
    wrap.classList.add('visible')
    if (cancel) cancel.style.display = data.phase === 'extracting' ? 'none' : ''
    if (data.phase === 'extracting') {
      if (label) label.textContent = 'Extracting…'
      if (fill)  fill.style.width  = '100%'
      return
    }
    if (data.total) {
      const pct = Math.round(data.received / data.total * 100)
      if (fill)  fill.style.width  = pct + '%'
      if (label) label.textContent = `Downloading… ${fmt(data.received)} / ${fmt(data.total)} (${pct}%)`
    } else {
      if (label) label.textContent = `Downloading… ${fmt(data.received)}`
    }
  })

  // Cancel button — aborts the active wine download
  const btnCancelWineDl = $('sw-cancel-wine-dl')
  if (btnCancelWineDl) {
    btnCancelWineDl.style.display = 'none'
    btnCancelWineDl.addEventListener('click', async () => {
      btnCancelWineDl.disabled = true; btnCancelWineDl.textContent = 'Cancelling…'
      await window.api.swCancelWineDownload().catch(() => {})
    })
  }

  const btnDlWine = $('sw-dl-wine')
  if (btnDlWine) btnDlWine.addEventListener('click', async () => {
    setErr('sw-wine-err', '')
    if (!swRelease) { setErr('sw-wine-err', 'Release info not loaded yet. Wait a moment and try again.'); return }
    btnDlWine.disabled = true; btnDlWine.textContent = 'Downloading…'
    if (btnCancelWineDl) { btnCancelWineDl.style.display = ''; btnCancelWineDl.disabled = false; btnCancelWineDl.textContent = '✕ Cancel' }
    const slug = slugifyWine(swRelease.version || swRelease.name)
    const res = await window.api.swDownloadWine(swRelease.url, slug, swRelease.name || swRelease.version || '')
    btnDlWine.disabled = false; btnDlWine.textContent = 'Download & Install Wine'
    if (btnCancelWineDl) { btnCancelWineDl.style.display = 'none'; btnCancelWineDl.disabled = false; btnCancelWineDl.textContent = '✕ Cancel' }
    const wrap = $('sw-wine-prog-wrap'); if (wrap) wrap.classList.remove('visible')
    if (!res.ok) {
      const msg = res.error === 'cancelled' ? 'Download cancelled.' : ('Download failed: ' + res.error)
      setErr('sw-wine-err', msg)
      return
    }
    renderWineManager()
    swRefreshStatusBadges()
    // Advance only if we got here via the full wizard (not the install-only overlay)
    if (!wizard.dataset.installOnly) { showStep(2); prefillBottlePath() }
    else { closeWizard(); delete wizard.dataset.installOnly }
  })

  const swClose1 = $('sw-close-1')
  if (swClose1) swClose1.addEventListener('click', closeWizard)

  // "Already installed → Skip" — jump straight to step 2 without GitHub fetch
  const swSkipWine = $('sw-skip-wine')
  if (swSkipWine) swSkipWine.addEventListener('click', () => { showStep(2); prefillBottlePath() })

  // "Check for release" — manually trigger the GitHub API fetch on demand.
  const swCheckWineRelease = $('sw-check-wine-release')
  if (swCheckWineRelease) swCheckWineRelease.addEventListener('click', () => {
    fetchWineRelease()
  })

  // Custom GitHub release URL — user can paste a direct .tar.xz / .tar.gz link
  const swCustomUrlInput = $('sw-custom-wine-url')
  const swApplyCustomUrl = $('sw-apply-custom-url')
  if (swApplyCustomUrl && swCustomUrlInput) {
    swApplyCustomUrl.addEventListener('click', () => {
      const url = swCustomUrlInput.value.trim()
      if (!url) { setErr('sw-wine-err', 'Please enter a URL first.'); return }
      if (!/^https?:\/\//i.test(url)) { setErr('sw-wine-err', 'URL must start with https://'); return }
      const filename = url.split('/').pop() || 'custom-wine'
      swRelease = {
        url,
        name: filename,
        size: 0,
        version: filename.replace(/\.tar\.(xz|gz)$/i, '') + ' ⚠ unofficial',
        major: 0, minor: 0,
        isCustomUrl: true,
        isDevWine: true,
      }
      const desc = $('sw-step1-desc')
      if (desc) desc.textContent = `This will install from custom URL: ${filename} (unofficial — not tested)`
      const info = $('sw-wine-release-info')
      if (info) info.innerHTML = `<span style="color:#fb923c">⚠ Custom URL — install at your own risk: <code style="font-size:10px">${url}</code></span>`
      setErr('sw-wine-err', '')
      swApplyCustomUrl.textContent = '✓ Applied'
      setTimeout(() => { swApplyCustomUrl.textContent = 'Apply URL' }, 2000)
    })
    // Save custom URL to settings when it changes
    swCustomUrlInput.addEventListener('input', () => {
      settings.customWineRepoUrl = swCustomUrlInput.value.trim()
    })
    // Restore saved custom URL on open
    if (settings.customWineRepoUrl) swCustomUrlInput.value = settings.customWineRepoUrl
  }

  // ── Step 2 ─────────────────────────────────────────────────────────────────
  function prefillBottlePath() {
    const inp = $('sw-wiz-bottle')
    if (inp && !inp.value) {
      inp.value = settings.standalonBottlePath || swDefaultBottlePath || ''
    }
  }

  window.api.onSteamProgress(data => {
    const wrap  = $('sw-steam-prog-wrap')
    const fill  = $('sw-steam-prog-fill')
    const label = $('sw-steam-prog-label')
    if (!wrap) return
    wrap.classList.add('visible')
    if (data.total) {
      const pct = Math.round(data.received / data.total * 100)
      if (fill)  fill.style.width  = pct + '%'
      if (label) label.textContent = `Downloading Steam… ${fmt(data.received)} / ${fmt(data.total)} (${pct}%)`
    } else {
      if (label) label.textContent = `Downloading Steam… ${fmt(data.received)}`
    }
  })

  const btnCreateBottle = $('sw-create-bottle')
  const btnNext2        = $('sw-next-2')
  if (btnCreateBottle) btnCreateBottle.addEventListener('click', async () => {
    setErr('sw-bottle-err', '')
    const inp = $('sw-wiz-bottle')
    // Auto-fill default if field is blank (backend will also use same default if still empty)
    if (inp && !inp.value.trim()) inp.value = swDefaultBottlePath || ''
    const bottlePath = (inp || {}).value?.trim() || ''
    btnCreateBottle.disabled = true; btnCreateBottle.textContent = 'Creating bottle…'
    const cr = await window.api.swCreateBottle(bottlePath)
    if (!cr.ok) {
      setErr('sw-bottle-err', 'Bottle creation failed: ' + cr.error)
      btnCreateBottle.disabled = false; btnCreateBottle.textContent = 'Create Bottle & Launch Steam'
      return
    }
    // Use the actual resolved path returned from the backend (handles empty-input default)
    const resolvedBottlePath = cr.bottlePath || bottlePath
    if (inp) inp.value = resolvedBottlePath
    settings.standalonBottlePath = resolvedBottlePath
    fillField('sw-bottle-path', resolvedBottlePath)
    btnCreateBottle.textContent = 'Downloading Steam…'; btnCreateBottle.disabled = true
    const dl = await window.api.swDownloadSteam()
    if (!dl.ok) {
      setErr('sw-bottle-err', 'Steam download failed: ' + dl.error)
      btnCreateBottle.disabled = false; btnCreateBottle.textContent = 'Create Bottle & Launch Steam'
      return
    }
    // Run the installer
    const run = await window.api.swRunExe({ exePath: dl.exePath, bottlePath: resolvedBottlePath })
    if (!run.ok) {
      setErr('sw-bottle-err', 'Failed to launch Steam installer: ' + run.error)
      btnCreateBottle.disabled = false; btnCreateBottle.textContent = 'Create Bottle & Launch Steam'
      return
    }
    btnCreateBottle.style.display = 'none'
    // Auto-detect Steam & ETS2 paths in the bottle right after Steam installer launches
    if (resolvedBottlePath) {
      try {
        const stRes = await window.api.swAutoDetectSteamPath(resolvedBottlePath)
        if (stRes.ok && stRes.steamDir) {
          settings.standalonSteamDir = stRes.steamDir
          fillField('sw-steam-dir', stRes.steamDir)
        }
      } catch {}
    }
    if (btnNext2) btnNext2.style.display = ''
  })

  const btnBack2  = $('sw-back-2')
  const btnSkip2  = $('sw-skip-2')
  if (btnBack2) btnBack2.addEventListener('click', () => showStep(1))
  if (btnSkip2) btnSkip2.addEventListener('click', () => showStep(3))
  if (btnNext2) btnNext2.addEventListener('click', async () => {
    // Auto-detect Steam & ETS2 paths before advancing — saves the user from filling them manually
    const bp = ($('sw-wiz-bottle') || {}).value?.trim() || settings.standalonBottlePath
    if (bp) {
      await window.api.swKillWineserver(bp).catch(() => {})
      try {
        const stRes = await window.api.swAutoDetectSteamPath(bp)
        if (stRes.ok && stRes.steamDir) { settings.standalonSteamDir = stRes.steamDir; fillField('sw-steam-dir', stRes.steamDir) }
      } catch {}
      try {
        const gRes = await window.api.swAutoDetectGamePath(bp)
        if (gRes.ok && gRes.gameDir) { settings.standalonGameDir = gRes.gameDir; fillField('sw-game-dir', gRes.gameDir) }
      } catch {}
    }
    showStep(3)
  })

  // ── Step 3 ─────────────────────────────────────────────────────────────────
  // Auto-install DXMT from GitHub
  const btnAutoInstallDxmt = $('sw-auto-install-dxmt')
  if (btnAutoInstallDxmt) {
    btnAutoInstallDxmt.addEventListener('click', async () => {
      const statusEl = $('sw-dxmt-auto-status')
      btnAutoInstallDxmt.disabled = true; btnAutoInstallDxmt.textContent = 'Working…'
      if (statusEl) { statusEl.textContent = 'Starting…'; statusEl.style.color = 'var(--text-secondary)' }
      window.api.onDxmtStatus(msg => {
        if (statusEl) { statusEl.textContent = msg; statusEl.style.color = 'var(--text-secondary)' }
      })
      const res = await window.api.swAutoInstallDxmt()
      btnAutoInstallDxmt.disabled = false; btnAutoInstallDxmt.textContent = '⬇ Auto-install latest DXMT from GitHub'
      if (res.ok) {
        settings.standalonDxmtDir = res.dxmtDir
        if (res.dxmtFileVersion) settings.standalonDxmtVersion = res.dxmtFileVersion
        if (statusEl) { statusEl.textContent = `✓ DXMT ${res.dxmtFileVersion || 'latest'} installed successfully`; statusEl.style.color = '#4ade80' }
        showStep(4); swRefreshStatusBadges()
      } else {
        if (statusEl) { statusEl.textContent = '✗ ' + res.error; statusEl.style.color = 'var(--accent, #f87171)' }
      }
    })
  }

  const btnInstallDxmt = $('sw-install-dxmt')
  if (btnInstallDxmt) btnInstallDxmt.addEventListener('click', async () => {
    setErr('sw-dxmt-err', '')
    const tarPath = ($('sw-wiz-dxmt') || {}).value?.trim()
    if (!tarPath) { setErr('sw-dxmt-err', 'Please browse to a DXMT .tar.gz file first.'); return }
    btnInstallDxmt.disabled = true; btnInstallDxmt.textContent = 'Installing…'
    const res = await window.api.swInstallDxmt(tarPath)
    btnInstallDxmt.disabled = false; btnInstallDxmt.textContent = 'Install DXMT →'
    if (!res.ok) { setErr('sw-dxmt-err', 'DXMT install failed: ' + res.error); return }
    settings.standalonDxmtDir = res.dxmtDir
    if (res.dxmtFileVersion) settings.standalonDxmtVersion = res.dxmtFileVersion
    showStep(4)
    swRefreshStatusBadges()
  })

  const btnBack3    = $('sw-back-3')
  const btnSkipDxmt = $('sw-skip-dxmt')
  if (btnBack3)    btnBack3.addEventListener('click',    () => showStep(2))
  if (btnSkipDxmt) btnSkipDxmt.addEventListener('click', () => showStep(4))

  // ── Step 4 ─────────────────────────────────────────────────────────────────
  const btnFinish = $('sw-finish')
  if (btnFinish) btnFinish.addEventListener('click', () => {
    const steamVal = ($('sw-wiz-steam') || {}).value?.trim()
    if (steamVal) { settings.standalonSteamDir = steamVal; fillField('sw-steam-dir', steamVal) }
    // Auto-detect bottle paths (steam + ETS2 game dir) if bottle is known
    if (settings.standalonBottlePath) detectStandaloneBottlePaths(settings.standalonBottlePath)
    settings.standaloneWizardDone = true
    collect(); window.api.saveSettings(settings)
    closeWizard()
    swRefreshStatusBadges()
  })

  // Expose for use by swApplyWineMode (called outside this IIFE)
  window._swRefreshStatusBadges = swRefreshStatusBadges

  // ── Status badges in settings panel ────────────────────────────────────────
  function swRefreshStatusBadges() {
    window.api.swGetStatus().then(st => {
      function set(indId, lblId, ok, okText, missText) {
        const ind=$( indId); const lbl=$(lblId); if(!ind||!lbl) return
        ind.textContent = ok ? '✓' : '○'
        ind.className   = 'sw-status-icon ' + (ok ? 'sw-status-ok' : 'sw-status-miss')
        lbl.textContent = ok ? okText : missText
        lbl.className   = ok ? 'sw-status-ok' : 'sw-status-miss'
      }
      set('sw-ind-wine',   'sw-lbl-wine',   st.wineInstalled, 'Wine installed ✓', 'Wine not installed')
      set('sw-ind-bottle', 'sw-lbl-bottle', st.bottleExists,  'Bottle ready ✓',   'Bottle not created')
      // DXMT badge: show version from filename if available
      const dxmtOk = st.dxmtExists && !st.dxmtArchWarning
      const dxmtDisplayVer = st.dxmtFileVersion || ''
      const dxmtLabel = st.dxmtArchWarning
        ? 'DXMT ⚠ reinstall needed (32-bit path)'
        : dxmtOk
          ? (dxmtDisplayVer ? `DXMT ${dxmtDisplayVer} ✓` : 'DXMT installed ✓')
          : 'DXMT not installed'
      set('sw-ind-dxmt', 'sw-lbl-dxmt', dxmtOk, dxmtLabel, dxmtLabel)
      if (st.defaultBottlePath) swDefaultBottlePath = st.defaultBottlePath
    })
    renderWineManager()
  }

  // ── Wine version manager (multi-wine) ──────────────────────────────────────
  function renderWineManager() {
    const container = $('sw-wine-manager'); if (!container) return
    window.api.swListWines().then(wines => {
      container.style.cssText = 'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.09);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:4px'

      if (!wines || !wines.length) {
        container.innerHTML =
          '<div style="color:rgba(255,255,255,0.55);font-size:9.5px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.07);margin-bottom:6px">Installed Wines</div>' +
          '<span style="color:rgba(255,255,255,0.4);font-size:11px">No Wine installed yet. Click "+ Install New" to get started.</span>'
        return
      }

      container.innerHTML = ''

      const header = document.createElement('div')
      header.style.cssText = 'color:rgba(255,255,255,0.55);font-size:9.5px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.07);margin-bottom:2px'
      header.textContent = 'Installed Wines'
      container.appendChild(header)

      for (const w of wines) {
        const displayName = w.releaseName || w.fileName || w.version || w.slug || 'Unknown Wine'
        const subLabel = (w.releaseName && w.fileName && w.fileName !== displayName) ? w.fileName : (w.version && w.version !== displayName ? w.version : '')

        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:6px;border:1px solid ' +
          (w.active ? 'rgba(99,102,241,0.22);background:rgba(99,102,241,0.09)' : 'transparent;background:transparent;cursor:pointer')
        if (!w.active) {
          row.title = 'Click to set as active Wine'
          row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.04)' }
          row.onmouseleave = () => { row.style.background = 'transparent' }
        }

        const nameWrap = document.createElement('div')
        nameWrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;overflow:hidden'

        const nameRow = document.createElement('div')
        nameRow.style.cssText = 'display:flex;align-items:center;gap:7px;min-width:0;overflow:hidden'

        const nameEl = document.createElement('span')
        nameEl.style.cssText = 'font-size:12px;font-family:var(--font-mono,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
          (w.active ? 'color:#fff;font-weight:700' : 'color:rgba(255,255,255,0.65)')
        nameEl.textContent = displayName
        nameRow.appendChild(nameEl)

        if (w.active) {
          const badge = document.createElement('span')
          badge.style.cssText = 'font-size:10px;color:#a5b4fc;font-weight:700;white-space:nowrap;flex-shrink:0'
          badge.textContent = '✓ active'
          nameRow.appendChild(badge)
        }

        if (w.isRecommended) {
          const rec = document.createElement('span')
          rec.style.cssText = 'font-size:9px;background:rgba(74,222,128,0.10);border:1px solid rgba(74,222,128,0.22);color:#4ade80;border-radius:4px;padding:1px 5px;font-weight:700;white-space:nowrap;flex-shrink:0'
          rec.textContent = '★ Recommended'
          nameRow.appendChild(rec)
        }

        nameWrap.appendChild(nameRow)

        if (subLabel && subLabel !== displayName) {
          const sub = document.createElement('span')
          sub.style.cssText = 'font-size:10px;font-family:var(--font-mono,monospace);color:rgba(255,255,255,0.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
          sub.textContent = subLabel
          nameWrap.appendChild(sub)
        }

        if (!w.active) {
          row.addEventListener('click', async () => {
            await window.api.swSetActiveWine(w.slug)
            settings.standalonWineSlug = w.slug
            renderWineManager(); swRefreshStatusBadges()
          })
        }

        const delBtn = document.createElement('button')
        delBtn.style.cssText = 'background:rgba(220,38,38,0.10);border:1px solid rgba(220,38,38,0.28);border-radius:5px;cursor:pointer;color:#f87171;font-size:10.5px;font-weight:700;padding:3px 11px;flex-shrink:0;text-transform:uppercase;font-family:inherit;letter-spacing:0.04em;transition:background 0.15s'
        delBtn.textContent = 'Uninstall'
        delBtn.title = `Delete "${displayName}"`
        delBtn.onmouseenter = () => { delBtn.style.background = 'rgba(220,38,38,0.22)' }
        delBtn.onmouseleave = () => { delBtn.style.background = 'rgba(220,38,38,0.10)' }
        delBtn.addEventListener('click', async e => {
          e.stopPropagation()
          if (!await showConfirm(`Delete "${displayName}"?\nThis cannot be undone — you will need to re-download to use it again.`, 'Delete')) return
          delBtn.disabled = true; delBtn.textContent = '…'
          const res = await window.api.swDeleteWine(w.slug)
          if (res.ok) { renderWineManager(); swRefreshStatusBadges(); showToast(`Deleted ${displayName}`, 'success') }
          else { delBtn.disabled = false; delBtn.textContent = 'Uninstall'; showToast('Delete failed: ' + res.error, 'error') }
        })

        row.append(nameWrap, delBtn)
        container.appendChild(row)
      }
    })
  }

  // ── Wine mode buttons (Settings panel) ─────────────────────────────────────
  const btnCX = $('wm-crossover'); const btnSW = $('wm-standalone')
  if (btnCX) btnCX.addEventListener('click', () => {
    swApplyWineMode('crossover'); collect(); window.api.saveSettings(settings)
  })
  if (btnSW) btnSW.addEventListener('click', () => {
    swApplyWineMode('standalone'); swRefreshStatusBadges(); collect(); window.api.saveSettings(settings)
  })

  // ── Card wine toggle (game card shortcut) ───────────────────────────────────
  const cwtCxBtn = $('cwt-cx'); const cwtSwBtn = $('cwt-sw')
  if (cwtCxBtn) cwtCxBtn.addEventListener('click', () => {
    swApplyWineMode('crossover'); collect(); window.api.saveSettings(settings)
  })
  if (cwtSwBtn) cwtSwBtn.addEventListener('click', () => {
    swApplyWineMode('standalone'); swRefreshStatusBadges(); collect(); window.api.saveSettings(settings)
  })

  // ── Wine manager buttons (Settings panel) ──────────────────────────────────
  const btnOpenWiz = $('btn-open-sw-wizard')
  if (btnOpenWiz) btnOpenWiz.addEventListener('click', openWizard)

  // "Install New" from wine manager → skip restart guard, go straight to version picker
  function openWineInstaller() {
    wizard.dataset.installOnly = '1'
    wizard.classList.remove('hidden')
    showStep(1)
    fetchWineRelease()
  }
  const btnInstallAnother = $('btn-install-another-wine')
  if (btnInstallAnother) btnInstallAnother.addEventListener('click', openWineInstaller)

  // ── Clear Steam HTML cache ───────────────────────────────────────────────────
  const btnClearCache = $('btn-clear-html-cache')
  if (btnClearCache) {
    btnClearCache.addEventListener('click', async () => {
      collect()
      const bottlePath = settings.wineMode === 'standalone'
        ? settings.standalonBottlePath
        : settings.bottlePath
      if (!bottlePath) {
        pushLog({ kind:'error', text:'Bottle path not set — configure it in Settings first.', ts:Date.now() })
        return
      }
      btnClearCache.disabled = true; btnClearCache.textContent = 'Clearing…'
      const res = await window.api.clearSteamHtmlCache(bottlePath)
      btnClearCache.disabled = false; btnClearCache.textContent = '🗑 Clear Cache'
      if (!res.ok) {
        pushLog({ kind:'error', text:'Clear cache failed: ' + res.error, ts:Date.now() })
      } else {
        pushLog({ kind:'success', text:'HTML cache cleared ✓ — ' + res.msg, ts:Date.now() })
      }
    })
  }

  // ── Wine log — open in Finder ────────────────────────────────────────────────
  const btnSteamLog = $('btn-steam-log')
  if (btnSteamLog) {
    btnSteamLog.addEventListener('click', async () => {
      const res = await window.api.swOpenSteamLog()
      if (!res.ok) pushLog({ kind:'warn', text:'Wine log: ' + res.error, ts:Date.now() })
    })
  }

  // Refresh badges when settings tab opens
  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.dataset.tab === 'settings') {
      btn.addEventListener('click', () => {
        if (($('wm-standalone') || {}).classList?.contains('active')) swRefreshStatusBadges()
      })
    }
  })
})()

// ── Welcome / Beta Notice Modal ───────────────────────────────────────────────
;(function() {
  const modal = $('welcome-modal')
  const btn   = $('btn-welcome-dismiss')
  if (!modal || !btn) return
  btn.addEventListener('click', () => modal.classList.add('hidden'))
})()

// ── About tab — update checker ────────────────────────────────────────────────
;(function() {
  const btn         = $('btn-check-update')
  const status      = $('update-status')
  const dlBtn       = $('btn-download-update')
  const changelogBtn= $('btn-view-changelog')
  const changelogMod= $('changelog-modal')
  const changelogBody=$('changelog-body')
  const changelogClose=$('changelog-close')
  if (!btn || !status) return

  let _latestRelease = null

  // Auto-populate from startup check when user opens About tab
  function applyAutoUpdateResult(res) {
    if (!res) return
    _latestRelease = res
    status.style.color = 'var(--text-secondary)'
    status.innerHTML = `Update available: <strong style="color:#4ade80">${res.latestTag}</strong> &nbsp;(current: ${res.current})`
    if (dlBtn) { dlBtn.classList.remove('hidden'); dlBtn.textContent = `⬇ Download & Install ${res.latestTag}` }
    if (changelogBtn && res.body) changelogBtn.classList.remove('hidden')
    // Clear the badge once the user has seen the About tab
    const badge = $('update-badge')
    if (badge) badge.style.display = 'none'
    _autoUpdateResult = null
  }

  $('btn-header-about')?.addEventListener('click', () => {
    if (_autoUpdateResult) applyAutoUpdateResult(_autoUpdateResult)
  })

  // Changelog modal
  if (changelogBtn && changelogMod) {
    changelogBtn.addEventListener('click', () => {
      if (_latestRelease && _latestRelease.body) {
        if (changelogBody) changelogBody.textContent = _latestRelease.body
        changelogMod.style.display = 'flex'
      }
    })
  }
  if (changelogClose && changelogMod) {
    changelogClose.addEventListener('click', () => { changelogMod.style.display = 'none' })
    changelogMod.addEventListener('click', e => { if (e.target === changelogMod) changelogMod.style.display = 'none' })
  }

  // Update screen elements
  const updateScreen    = $('update-screen')
  const updatePhase     = $('update-screen-phase')
  const updateBar       = $('update-screen-bar')
  const updateSpeed     = $('update-screen-speed')
  const updateCancelBtn = $('update-screen-cancel')

  function showUpdateScreen(show) {
    if (!updateScreen) return
    updateScreen.style.display = show ? 'flex' : 'none'
  }

  if (updateCancelBtn) {
    updateCancelBtn.addEventListener('click', async () => {
      updateCancelBtn.disabled = true
      updateCancelBtn.textContent = 'Cancelling…'
      await window.api.cancelUpdate()
      showUpdateScreen(false)
      updateCancelBtn.disabled = false
      updateCancelBtn.textContent = '✕ Cancel'
    })
  }

  // Register update progress listener
  if (window.api.onUpdateProgress) {
    let _lastReceived = 0, _lastTime = Date.now()
    window.api.onUpdateProgress(data => {
      if (!updateScreen) return
      if (data.phase === 'extracting') {
        if (updatePhase) updatePhase.textContent = 'Extracting…'
        if (updateBar)   updateBar.style.width   = '85%'
        if (updateSpeed) updateSpeed.textContent = ''
        return
      }
      if (data.phase === 'installing') {
        if (updatePhase) updatePhase.textContent = 'Installing…'
        if (updateBar)   updateBar.style.width   = '98%'
        if (updateSpeed) updateSpeed.textContent = ''
        return
      }
      if (data.total) {
        const pct = Math.round(data.received / data.total * 100)
        if (updateBar) updateBar.style.width = pct + '%'
        const now = Date.now()
        const dt = (now - _lastTime) / 1000
        if (dt > 0.5) {
          const bytesPerSec = (data.received - _lastReceived) / dt
          _lastReceived = data.received
          _lastTime = now
          const mbps = (bytesPerSec / 1024 / 1024).toFixed(1)
          if (updateSpeed) updateSpeed.textContent = `${fmt(data.received)} / ${fmt(data.total)}  •  ${mbps} MB/s`
        }
        if (updatePhase) updatePhase.textContent = `Downloading… ${pct}%`
      }
    })
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = '↻ Checking…'
    if (dlBtn) dlBtn.classList.add('hidden')
    if (changelogBtn) changelogBtn.classList.add('hidden')
    status.style.color = 'var(--text-secondary)'
    status.innerHTML = 'Fetching latest release from GitHub…'

    const res = await window.api.checkUpdate()
    btn.disabled = false
    btn.textContent = '↻ Check for Update'

    if (!res.ok) {
      status.style.color = 'var(--red)'
      status.textContent = '✗ Failed: ' + res.error
      return
    }

    _latestRelease = res

    if (!res.hasUpdate) {
      status.style.color = 'var(--text-primary)'
      status.textContent = `✓ You're on the latest version (${res.displayVersion || res.current})`
      if (dlBtn)        dlBtn.classList.add('hidden')
      if (changelogBtn) changelogBtn.classList.add('hidden')
    } else {
      status.style.color = 'var(--text-secondary)'
      status.innerHTML = `Update available: <strong style="color:#4ade80">${res.latestTag}</strong> &nbsp;(current: ${res.current})`
      if (dlBtn) {
        dlBtn.classList.remove('hidden')
        dlBtn.textContent = `⬇ Download & Install ${res.latestTag}`
      }
      if (changelogBtn && res.body) changelogBtn.classList.remove('hidden')
    }
  })

  if (dlBtn) {
    dlBtn.addEventListener('click', async () => {
      if (!_latestRelease) return
      dlBtn.disabled = true
      showUpdateScreen(true)
      if (updatePhase) updatePhase.textContent = 'Starting download…'
      if (updateBar)   updateBar.style.width   = '0%'
      if (updateSpeed) updateSpeed.textContent = ''
      const res = await window.api.downloadUpdate(_latestRelease.downloadUrl)
      if (!res.ok) {
        showUpdateScreen(false)
        dlBtn.disabled = false
        status.style.color = 'var(--red)'
        status.textContent = '✗ Update failed: ' + res.error
      }
    })
  }
})()



// ── Go ────────────────────────────────────────────────────────────────────────
init()
