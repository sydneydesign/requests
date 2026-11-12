#!/usr/bin/env node
// The command Claude uses to log and update the user's requests.
// Help: node requests.mjs help
import path from 'node:path'
import { STATUS_NAME, add, clean, count, filePath, modify, read, remove, update } from './store.mjs'

const HELP = `Usage: node requests.mjs <command> [options]

  new      --thread T --title X [--project P] [--said "..."] [--status working]
           [--via V] [--answer A] [--question Q] [--file F]...
           Logs a request. Creates the thread (thread + project) if it doesn't exist.
  update   <id> [--status needs-you|working|queued|done] [--answer A] [--question Q]
           [--title X] [--via V] [--file F]...
  list     [--project P] [--done]      Open requests, grouped by thread, with their ids.
  remove   <id>
  clean    [--days 14]                 Deletes requests done more than N days ago.
  path                                 Where the file is.

Statuses: needs-you (waiting on the user), working, queued, done.`

function parseArgs(argv) {
  const positional = []
  const options = { files: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
    let value = eq > 0 ? a.slice(eq + 1) : argv[i + 1]
    if (eq < 0) {
      if (value === undefined || value.startsWith('--')) value = true
      else i++
    }
    if (name === 'file') options.files.push(String(value))
    else options[name] = value
  }
  return { command: positional[0], positional: positional.slice(1), options }
}

const ALLOWED = {
  new: ['thread', 'title', 'project', 'said', 'status', 'via', 'answer', 'question', 'files'],
  update: ['status', 'answer', 'question', 'title', 'via', 'files'],
  list: ['project', 'done', 'files'],
  remove: ['files'],
  clean: ['days', 'files'],
  path: ['files'],
  help: ['files']
}

function checkOptions(command, options) {
  for (const k of Object.keys(options)) {
    if (!ALLOWED[command].includes(k)) throw new Error(`"--${k}" doesn't apply to "${command}". See: node requests.mjs help`)
  }
  for (const [k, v] of Object.entries(options)) {
    if (v === true && k !== 'done') throw new Error(`Missing a value for --${k}.`)
  }
}

const line = (item, thread) => `${item.id}  ${thread ? thread.topic + ' — ' : ''}${item.title}  [${STATUS_NAME[item.status]}]`

function list(options) {
  const data = read()
  const showDone = Boolean(options.done)
  const project = typeof options.project === 'string' ? options.project.toLowerCase() : null
  const threads = data.threads
    .filter((t) => !project || t.project.toLowerCase() === project)
    .sort((a, b) => b.updated.localeCompare(a.updated))
  const out = []
  for (const t of threads) {
    const items = data.items.filter((i) => i.thread === t.id && (showDone || i.status !== 'done'))
    if (!items.length) continue
    out.push(`${t.topic}  (${t.project})`)
    for (const i of items) out.push(`  ${line(i)}`)
  }
  const n = count(data)
  out.push('', `${n.need} need the user, ${n.run} in progress, ${n.queue} queued, ${n.done} done.`)
  if (!threads.length) out.unshift('No threads yet.')
  return out.join('\n')
}

function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2))
  if (!command || command === 'help' || options.help) return HELP
  if (!ALLOWED[command]) throw new Error(`Unknown command "${command}".\n\n${HELP}`)
  checkOptions(command, options)

  switch (command) {
    case 'new': {
      const { item, thread } = modify((d) =>
        add(d, { ...options, project: options.project || process.env.REQUESTS_PROJECT || path.basename(process.cwd()) })
      )
      return `Logged: ${line(item, thread)}`
    }
    case 'update': {
      const id = positional[0]
      if (!id) throw new Error('Missing the id. Example: update k3fp --status done')
      const { item, thread } = modify((d) => update(d, id, options))
      return `Updated: ${line(item, thread)}`
    }
    case 'list':
      return list(options)
    case 'remove': {
      const id = positional[0]
      if (!id) throw new Error('Missing the id.')
      const item = modify((d) => remove(d, id))
      return `Removed: ${item.id}  ${item.title}`
    }
    case 'clean': {
      const days = options.days === undefined ? 14 : Number(options.days)
      if (!Number.isFinite(days) || days < 0) throw new Error('--days must be a number.')
      const n = modify((d) => clean(d, days))
      return `Deleted ${n} requests done more than ${days} days ago.`
    }
    case 'path':
      return filePath()
  }
}

try {
  console.log(main())
} catch (error) {
  console.error(`Error: ${error.message}`)
  process.exit(1)
}
