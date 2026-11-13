#!/usr/bin/env node
// Run by the Claude Code hooks. Whatever it prints goes into Claude's context.
//   start    → when a session starts: the instructions and the open requests.
//   message  → with every user message: marks this chat's updates as read, plus a short reminder.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STALE_MINUTES, STATUS_NAME, isStale, isUnread, markChatSeen, modify, originFromEnv, read, sameChat } from './store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = `node "${path.join(here, 'requests.mjs')}"`

// Claude Code sends data on stdin; we don't need it, but it has to be drained.
try { fs.readFileSync(0) } catch {}

function openRequests() {
  let data
  try {
    data = read()
  } catch (error) {
    return `(Couldn't read the list: ${error.message})`
  }
  // This goes into every new session's context, so it is capped:
  // at most 12 threads and 4 requests per thread, the ones waiting on the user first.
  const MAX_THREADS = 12
  const MAX_ITEMS = 4
  const order = { need: 0, run: 1, queue: 2 }
  const lines = []
  let hiddenThreads = 0
  const threads = [...data.threads].sort((a, b) => b.updated.localeCompare(a.updated))
  for (const t of threads) {
    const items = data.items
      .filter((i) => i.thread === t.id && i.status !== 'done')
      .sort((a, b) => order[a.status] - order[b.status])
    if (!items.length) continue
    if (lines.length >= MAX_THREADS) {
      hiddenThreads++
      continue
    }
    const short = (s) => (s.length > 60 ? s.slice(0, 57) + '…' : s)
    let l = `- ${t.topic} (${t.project}): ` + items.slice(0, MAX_ITEMS).map((i) => `${i.id} ${short(i.title)} [${STATUS_NAME[i.status]}]`).join('; ')
    if (items.length > MAX_ITEMS) l += `; and ${items.length - MAX_ITEMS} more`
    lines.push(l)
  }
  if (hiddenThreads) lines.push(`- and ${hiddenThreads} more threads with open requests (see them with "list")`)
  return lines.length ? `Threads with open requests:\n${lines.join('\n')}` : 'No open requests.'
}

const mode = process.argv[2]
if (mode === 'start') {
  const instructions = fs.readFileSync(path.join(here, '..', 'INSTRUCTIONS.md'), 'utf8').replaceAll('{{CLI}}', cli)
  console.log(`${instructions}\n${openRequests()}`)
} else if (mode === 'message') {
  markThisChatSeen()
  console.log(`[requests] If this message brings new requests or moves an existing one, log it with ${cli} (instructions at the start of the session).`)
  const waiting = waitingOnUser()
  if (waiting) console.log(waiting)
  const stale = staleInThisChat()
  if (stale) console.log(stale)
}

// The user just wrote in this chat, so they have read what Claude said here: mark this chat's
// unread requests as read. Only writes when there is something to mark.
function markThisChatSeen() {
  const origin = originFromEnv()
  if (!origin) return
  try {
    const data = read()
    if (!data.items.some((i) => isUnread(i) && sameChat(i.origin, origin))) return
    modify((d) => markChatSeen(d, origin))
  } catch {}
}

// Reminds Claude, with every message, what is still waiting on the user, so a reply about
// something else never closes it by accident. Prints nothing when nothing is waiting.
function waitingOnUser() {
  let data
  try {
    data = read()
  } catch {
    return ''
  }
  const waiting = data.items
    .filter((i) => i.status === 'need')
    .sort((a, b) => b.updated.localeCompare(a.updated))
  if (!waiting.length) return ''
  const shown = waiting.slice(0, 5).map((i) => `[${i.id}] ${i.title.length > 50 ? i.title.slice(0, 47) + '…' : i.title}`)
  const more = waiting.length > 5 ? `, and ${waiting.length - 5} more` : ''
  return `[requests] Still waiting on the user: ${shown.join('; ')}${more}. Keep them open unless this message answers them.`
}

// Work handed to workers or other sessions often finishes in a later turn, and then nothing
// reminds Claude to close it. Lists this chat's requests in progress with no update for a while.
// Outside Orca there is no chat to match, so it lists all of them.
function staleInThisChat() {
  let data
  try {
    data = read()
  } catch {
    return ''
  }
  const origin = originFromEnv()
  const stale = data.items
    .filter((i) => isStale(i) && (!origin || sameChat(i.origin, origin)))
    .sort((a, b) => a.updated.localeCompare(b.updated))
  if (!stale.length) return ''
  const shown = stale.slice(0, 5).map((i) => `[${i.id}] ${i.title.length > 50 ? i.title.slice(0, 47) + '…' : i.title}`)
  const more = stale.length > 5 ? `, and ${stale.length - 5} more` : ''
  return `[requests] In progress with no update for over ${STALE_MINUTES} min: ${shown.join('; ')}${more}. Close the ones that are done; leave the rest.`
}
