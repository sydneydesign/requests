#!/usr/bin/env node
// Run by the Claude Code hooks. Whatever it prints goes into Claude's context.
//   start    → when a session starts: the instructions and the open requests.
//   message  → with every user message: a one-line reminder.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATUS_NAME, read } from './store.mjs'

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
  console.log(`[requests] If this message brings new requests or moves an existing one, log it with ${cli} (instructions at the start of the session).`)
}
