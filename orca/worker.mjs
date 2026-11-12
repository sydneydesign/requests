// Orca plugin worker. Watches the request list, hands it to the panel and keeps the
// status bar counter up to date. Orca starts it when the plugin is enabled (because it
// has a status bar item) and keeps it running.
import fs from 'node:fs'
import path from 'node:path'
import { count, filePath, modify, read, remove, update } from '../claude/bin/store.mjs'

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
    const waiting = snapshot.data.items.filter((i) => i.status === 'need').map((i) => i.title)
    let text = 'All clear'
    if (n.need) text = `${n.need} need${n.need > 1 ? '' : 's'} you` + (moving ? `, ${moving} in progress` : '')
    else if (moving) text = `${moving} in progress`
    const tooltip = snapshot.error
      ? `Requests: ${snapshot.error}`
      : waiting.length
        ? `Needs you: ${waiting.slice(0, 5).join('; ')}${waiting.length > 5 ? '…' : ''}`
        : 'Open "Requests" in the right sidebar'
    try {
      await orca.host.call('statusBar.update', {
        id: 'counter',
        text,
        tooltip,
        tone: snapshot.error ? 'danger' : n.need ? 'warning' : moving ? 'accent' : 'neutral'
      })
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
    modify((d) => update(d, id, question === undefined ? { status } : { status, question }), file)
    check()
    return snapshot
  })

  orca.panels.handle('requests.remove', async ({ id }) => {
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
