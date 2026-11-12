// Reads and writes the request list. Both Claude's command (requests.mjs) and the Orca
// plugin's worker use it, so they always see the same file. No dependencies: Node built-ins only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const STATUSES = ['need', 'run', 'queue', 'done']

export const STATUS_NAME = {
  need: 'needs you',
  run: 'in progress',
  queue: 'queued',
  done: 'done'
}

const ALIASES = {
  need: 'need', 'needs-you': 'need', needs: 'need', blocked: 'need', waiting: 'need',
  run: 'run', running: 'run', working: 'run', 'in-progress': 'run', doing: 'run',
  queue: 'queue', queued: 'queue', later: 'queue',
  done: 'done', finished: 'done', complete: 'done', completed: 'done'
}

export function validStatus(value) {
  const key = String(value || '').trim().toLowerCase().replace(/\s+/g, '-')
  const status = ALIASES[key]
  if (!status) throw new Error(`Unknown status "${value}". Use needs-you, working, queued or done.`)
  return status
}

export function filePath() {
  return process.env.REQUESTS_FILE || path.join(os.homedir(), '.requests', 'requests.json')
}

const empty = () => ({ version: 2, threads: [], items: [] })

function normalize(data) {
  const d = data && typeof data === 'object' ? data : {}
  return {
    version: 2,
    threads: Array.isArray(d.threads) ? d.threads : [],
    items: Array.isArray(d.items) ? d.items : []
  }
}

export function read(file = filePath()) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return empty()
    throw error
  }
  if (!text.trim()) return empty()
  try {
    return normalize(JSON.parse(text))
  } catch {
    throw new Error(`The request list is not valid JSON: ${file}`)
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Writes under a lock (a .lock folder) so two sessions at once don't overwrite each other,
// and swaps the file in one go (write elsewhere, then rename) so Orca never reads half a file.
export function modify(change, file = filePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  const start = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) {
          fs.rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {}
      if (Date.now() - start > 5_000) {
        throw new Error(`The request list is locked. If nothing is writing to it, delete ${lock}`)
      }
      sleep(40)
    }
  }
  try {
    const data = read(file)
    const result = change(data)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
    fs.renameSync(tmp, file)
    return result
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

const key = (text) =>
  String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

function newId(used) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  for (let length = 4; ; length++) {
    for (let attempt = 0; attempt < 50; attempt++) {
      let id = ''
      for (let i = 0; i < length; i++) id += chars[Math.floor(Math.random() * chars.length)]
      if (!used.has(id)) return id
    }
  }
}

const now = () => new Date().toISOString()

function text(value, field, max) {
  const clean = String(value ?? '').trim()
  if (max && clean.length > max) throw new Error(`"${field}" is too long (${max} characters at most).`)
  return clean
}

export function findThread(data, topic, project) {
  return data.threads.find((t) => key(t.topic) === key(topic) && key(t.project) === key(project))
}

export function add(data, fields) {
  const topic = text(fields.thread, 'thread', 80)
  const project = text(fields.project, 'project', 80) || 'No project'
  const title = text(fields.title, 'title', 140)
  if (!topic) throw new Error('Missing --thread (the thread this request belongs to).')
  if (!title) throw new Error('Missing --title.')
  const used = new Set([...data.threads.map((t) => t.id), ...data.items.map((i) => i.id)])
  let thread = findThread(data, topic, project)
  if (!thread) {
    thread = { id: newId(used), topic, project, created: now(), updated: now() }
    used.add(thread.id)
    data.threads.push(thread)
  }
  thread.updated = now()
  const item = {
    id: newId(used),
    thread: thread.id,
    title,
    status: fields.status ? validStatus(fields.status) : 'run',
    said: text(fields.said, 'said', 2000),
    answer: text(fields.answer, 'answer', 4000),
    question: text(fields.question, 'question', 2000),
    files: (fields.files || []).map((f) => text(f, 'file', 400)).filter(Boolean),
    via: text(fields.via, 'via', 120),
    origin: fields.origin || null,
    created: now(),
    updated: now(),
    changed: now(),
    seen: null
  }
  data.items.push(item)
  return { item, thread }
}

// Where a request was last touched by Claude: the Orca workspace, tab and terminal of that
// chat, read from the environment Orca gives each terminal. Null outside Orca.
export function originFromEnv(env = process.env) {
  if (!env.ORCA_TERMINAL_HANDLE && !env.ORCA_TAB_ID) return null
  return {
    workspace: env.ORCA_WORKSPACE_ID || env.ORCA_WORKTREE_ID || null,
    tab: env.ORCA_TAB_ID || null,
    terminal: env.ORCA_TERMINAL_HANDLE || null
  }
}

// Unread: Claude changed it after the user last saw it. Requests from before this field existed count as read.
export function isUnread(item) {
  return Boolean(item.changed) && (!item.seen || item.seen < item.changed)
}

export function sameChat(a, b) {
  if (!a || !b) return false
  return (a.terminal && a.terminal === b.terminal) || (a.tab && a.tab === b.tab)
}

// Marks as read every unread request whose chat is `origin`. Returns how many changed.
export function markChatSeen(data, origin) {
  let n = 0
  for (const i of data.items) {
    if (isUnread(i) && sameChat(i.origin, origin)) {
      i.seen = now()
      n++
    }
  }
  return n
}

export function markSeen(data, id) {
  const item = findItem(data, id)
  item.seen = now()
  return item
}

export function findItem(data, id) {
  const item = data.items.find((i) => i.id === String(id).trim().replace(/^\[|\]$/g, ''))
  if (!item) throw new Error(`There is no request with id "${id}".`)
  return item
}

// `by` is "claude" (default) or "user". A change by Claude makes the request unread and records
// which chat it came from; a change by the user in the panel counts as having seen it.
export function update(data, id, changes, { by = 'claude', origin = null } = {}) {
  const item = findItem(data, id)
  if (changes.status !== undefined) item.status = validStatus(changes.status)
  if (changes.title !== undefined) item.title = text(changes.title, 'title', 140) || item.title
  if (changes.answer !== undefined) item.answer = text(changes.answer, 'answer', 4000)
  if (changes.question !== undefined) item.question = text(changes.question, 'question', 2000)
  if (changes.via !== undefined) item.via = text(changes.via, 'via', 120)
  if (changes.files?.length) {
    const added = changes.files.map((f) => text(f, 'file', 400)).filter(Boolean)
    item.files = [...new Set([...(item.files || []), ...added])]
  }
  // A request that is done or moving again no longer waits on the user.
  if (changes.status !== undefined && item.status !== 'need' && changes.question === undefined) item.question = ''
  item.updated = now()
  if (by === 'user') {
    item.seen = now()
  } else {
    item.changed = now()
    if (origin) item.origin = origin
  }
  const thread = data.threads.find((t) => t.id === item.thread)
  if (thread) thread.updated = now()
  return { item, thread }
}

export function remove(data, id) {
  const item = findItem(data, id)
  data.items = data.items.filter((i) => i !== item)
  dropEmptyThreads(data)
  return item
}

function dropEmptyThreads(data) {
  const withItems = new Set(data.items.map((i) => i.thread))
  data.threads = data.threads.filter((t) => withItems.has(t.id))
}

// Deletes requests that were done more than `days` days ago.
export function clean(data, days = 14) {
  const limit = Date.now() - days * 86_400_000
  const before = data.items.length
  data.items = data.items.filter((i) => i.status !== 'done' || Date.parse(i.updated) > limit)
  dropEmptyThreads(data)
  return before - data.items.length
}

export function count(data) {
  const n = { need: 0, run: 0, queue: 0, done: 0 }
  for (const i of data.items) if (n[i.status] !== undefined) n[i.status]++
  return n
}
