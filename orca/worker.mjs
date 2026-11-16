// Orca plugin worker. Watches the request list, hands it to the panel and keeps the
// status bar counter up to date. Orca starts it when the plugin is enabled (because it
// has a status bar item) and keeps it running.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { count, filePath, isUnread, markSeen, modify, read, remove, update } from '../claude/bin/store.mjs'

// Orca's host API has no way to focus a terminal, so "Go to chat" uses Orca's own command-line
// tool, which ships with the app. The worker runs as the user, so it can call it.
function orcaBin() {
  const win = process.platform === 'win32'
  const candidates = [
    process.env.ORCA_CLI_BIN_DIR && path.join(process.env.ORCA_CLI_BIN_DIR, win ? 'orca.exe' : 'orca'),
    // The worker runs in Orca's own executable, and the CLI ships next to it. The worker's
    // environment has no LOCALAPPDATA, so this is how it finds the CLI on Windows.
    win && path.join(path.dirname(process.execPath), 'resources', 'bin', 'orca.exe'),
    !win && path.join(path.dirname(process.execPath), '..', 'Resources', 'bin', 'orca'),
    '/Applications/Orca.app/Contents/Resources/bin/orca'
  ].filter(Boolean)
  return candidates.find((c) => fs.existsSync(c)) || 'orca'
}

function cliEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // Orca gives the worker a trimmed Windows environment without APPDATA, and the CLI needs it
  // to find the running app.
  if (process.platform === 'win32' && env.USERPROFILE) {
    env.APPDATA ||= path.join(env.USERPROFILE, 'AppData', 'Roaming')
    env.LOCALAPPDATA ||= path.join(env.USERPROFILE, 'AppData', 'Local')
  }
  return env
}

function runOrca(args) {
  return new Promise((resolve) =>
    // The worker runs inside Orca's Electron with ELECTRON_RUN_AS_NODE set. The CLI launcher
    // would pass it on and Orca would start as plain Node, so drop it.
    execFile(orcaBin(), args, { timeout: 8000, env: cliEnv() }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout || ''), error: String(stderr || error?.message || '').trim() })
    )
  )
}

// The live terminal for a request's chat: the same terminal if it is still open, otherwise
// whatever terminal now sits in the same tab. Null when the chat is gone.
async function liveTerminal(origin) {
  const r = await runOrca(['terminal', 'list', '--json'])
  if (!r.ok) return null
  let list
  try {
    const parsed = JSON.parse(r.stdout)
    list = Array.isArray(parsed) ? parsed : parsed.terminals || parsed.result?.terminals || []
  } catch {
    return null
  }
  const alive = list.filter((t) => t.connected !== false && !t.orphaned)
  return (
    alive.find((t) => origin.terminal && t.handle === origin.terminal) ||
    alive.find((t) => origin.tab && t.tabId === origin.tab) ||
    null
  )
}

// Handles of the chats (terminals) open in Orca now. The board drops done requests whose chat
// has closed. Cached for a few seconds because the board asks on every change.
let chatsCache = { at: 0, handles: null }
async function openChats(log) {
  if (chatsCache.handles && Date.now() - chatsCache.at < 5000) return chatsCache.handles
  const r = await runOrca(['terminal', 'list', '--json'])
  if (!r.ok) {
    log(`Couldn't list Orca's terminals: ${r.error}`)
    return null
  }
  try {
    const parsed = JSON.parse(r.stdout)
    const list = Array.isArray(parsed) ? parsed : parsed.terminals || parsed.result?.terminals || []
    const handles = list.filter((t) => t.connected !== false && !t.orphaned).map((t) => t.handle)
    chatsCache = { at: Date.now(), handles }
    return handles
  } catch {
    return null
  }
}

let stopAll = () => {}

export default function activate(orca) {
  const file = filePath()
  let lastText = null
  let snapshot = { data: { version: 2, threads: [], items: [] }, error: null, file }

  function load() {
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') text = `\0${error.message}`
    }
    if (text === lastText) return false
    lastText = text
    try {
      snapshot = { data: read(file), error: null, file }
    } catch (error) {
      snapshot = { ...snapshot, error: error.message }
    }
    return true
  }

  async function counter() {
    if (!orca.host.has('statusBar.update')) return
    const n = count(snapshot.data)
    const moving = n.run + n.queue
    const unread = snapshot.data.items.filter(isUnread)
    const unreadNeed = unread.filter((i) => i.status === 'need')
    let text = 'All clear'
    if (n.need) text = `${n.need} need${n.need > 1 ? '' : 's'} you` + (moving ? `, ${moving} in progress` : '')
    else if (moving) text = `${moving} in progress`
    if (unread.length) text += `, ${unread.length} new`
    // Orca refuses a tooltip over 256 characters.
    const fit = (s) => (s.length > 256 ? s.slice(0, 255) + '…' : s)
    const tooltip = fit(snapshot.error
      ? `Requests: ${snapshot.error}`
      : unread.length
        ? `New: ${unread.slice(0, 5).map((i) => i.title).join('; ')}${unread.length > 5 ? '…' : ''}`
        : 'Open "Requests" in the right sidebar')
    // Orange only for something new that needs the user; seen-but-unanswered stays calm.
    const tone = snapshot.error ? 'danger' : unreadNeed.length ? 'warning' : unread.length ? 'accent' : 'neutral'
    try {
      await orca.host.call('statusBar.update', { id: 'counter', text, tooltip, tone })
    } catch (error) {
      orca.log(`Couldn't update the counter: ${error.message}`)
    }
  }

  function notify() {
    orca.panels.post('requests.changed', snapshot)
    void counter()
  }

  function check() {
    if (load()) notify()
  }

  // Watch the folder (the file is replaced on every save) and, just in case, look every 4 s.
  let pending = null
  let watcher = null
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    watcher = fs.watch(path.dirname(file), () => {
      clearTimeout(pending)
      pending = setTimeout(check, 120)
    })
  } catch (error) {
    orca.log(`Can't watch ${path.dirname(file)}: ${error.message}`)
  }
  const poll = setInterval(check, 4000)

  orca.panels.handle('requests.read', async () => {
    load()
    return snapshot
  })

  // `question` only comes with "Undo" after "Mark done", to put the question back.
  orca.panels.handle('requests.update', async ({ id, status, question }) => {
    modify((d) => update(d, id, question === undefined ? { status } : { status, question }, { by: 'user' }), file)
    check()
    return snapshot
  })

  // Opening a request in the panel counts as reading it.
  orca.panels.handle('requests.seen', async ({ id }) => {
    load()
    const item = snapshot.data.items.find((i) => i.id === id)
    if (item && isUnread(item)) {
      modify((d) => markSeen(d, id), file)
      check()
    }
    return snapshot
  })

  // Switches Orca to the chat the request came from and marks it read.
  // result: "switched", "closed" (that chat is gone), "unknown" (logged before chats were
  // recorded, or outside Orca) or "failed".
  orca.panels.handle('requests.goto', async ({ id }) => {
    load()
    const item = snapshot.data.items.find((i) => i.id === id)
    if (!item) return { snapshot, result: 'failed', error: 'That request no longer exists.' }
    if (!item.origin) return { snapshot, result: 'unknown' }
    const terminal = await liveTerminal(item.origin)
    let result = 'closed'
    let error = ''
    if (terminal) {
      const r = await runOrca(['terminal', 'switch', '--terminal', terminal.handle])
      result = r.ok ? 'switched' : 'failed'
      error = r.error
      if (!r.ok) orca.log(`Couldn't switch to ${terminal.handle}: ${r.error}`)
    }
    if (isUnread(item)) modify((d) => markSeen(d, id), file)
    check()
    return { snapshot, result, error }
  })

  // Opens the board: Orca's custom editor on the request file, in a ".requests" folder
  // workspace that Orca adds the first time. The plugin key depends on how it was installed
  // (local.requests for a development folder), so it is looked up by the manifest id.
  orca.panels.handle('requests.openBoard', async () => {
    const list = await runOrca(['plugin', 'list', '--json'])
    let key = 'local.requests'
    try {
      const plugins = JSON.parse(list.stdout).result?.plugins || []
      key = plugins.find((p) => p.pluginKey === 'requests' || p.pluginKey.endsWith('.requests'))?.pluginKey || key
    } catch {}
    const r = await runOrca(['plugin', 'open', key, '--editor', file])
    if (!r.ok) orca.log(`Couldn't open the board: ${r.error || r.stdout}`)
    return { opened: r.ok, error: r.ok ? '' : r.error || 'Orca refused to open it.' }
  })

  // null when Orca can't list its terminals; the board then falls back to "done today".
  orca.panels.handle('requests.openChats', async () => ({ handles: await openChats((m) => orca.log(m)) }))

  orca.panels.handle('requests.remove',async ({ id }) => {
    modify((d) => remove(d, id), file)
    check()
    return snapshot
  })

  load()
  void counter()

  stopAll = () => {
    clearInterval(poll)
    clearTimeout(pending)
    watcher?.close()
  }
}

export function deactivate() {
  stopAll()
}
