// Orca panel: draws the list the worker hands it and asks the worker for changes.
// Open: what needs you first, then what's in progress by thread, then what got done today.
// Done: everything finished, grouped by day.
;(function () {
  const ORDER = { need: 0, run: 1, queue: 2, done: 3 }
  const NAME = { need: 'Needs you', run: 'In progress', queue: 'Queued', done: 'Done' }
  const LOCALE = 'en-GB'

  const view = {
    snapshot: null,
    tab: 'open',
    project: '',
    query: '',
    expanded: null,
    collapsed: new Set(),
    collapsedProjects: new Set(),
    showToday: false,
    confirming: null,
    changed: new Set()
  }
  let previous = null // id → updated, to tell what changed

  try {
    const saved = JSON.parse(localStorage.getItem('requests.view') || '{}')
    if (saved.tab === 'open' || saved.tab === 'done') view.tab = saved.tab
    if (typeof saved.project === 'string') view.project = saved.project
    if (typeof saved.showToday === 'boolean') view.showToday = saved.showToday
    if (Array.isArray(saved.collapsedProjects)) view.collapsedProjects = new Set(saved.collapsedProjects)
  } catch {}
  function remember() {
    try {
      localStorage.setItem(
        'requests.view',
        JSON.stringify({
          tab: view.tab,
          project: view.project,
          showToday: view.showToday,
          collapsedProjects: [...view.collapsedProjects]
        })
      )
    } catch {}
  }

  const $ = (id) => document.getElementById(id)
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  // ---------- Worker
  async function ask(name, input) {
    if (window.orca?.plugin?.request) return window.orca.plugin.request(name, input ?? {}, { timeoutMs: 8000 })
    const r = await window.orca.host.call('plugin.request', { name, input: input ?? {}, timeoutMs: 8000 })
    return r.output
  }
  function listen(name, fn) {
    if (window.orca?.plugin?.on) return window.orca.plugin.on(name, fn)
    if (window.orca?.on) return window.orca.on(name, fn)
  }

  // ---------- Dates
  const sameDay = (a, b) => a.toDateString() === b.toDateString()
  function yesterday() {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return d
  }
  function when(iso) {
    const t = Date.parse(iso)
    if (!t) return ''
    const min = Math.round((Date.now() - t) / 60000)
    if (min < 1) return 'now'
    if (min < 60) return `${min} min ago`
    const d = new Date(t)
    if (sameDay(d, new Date())) return d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
    if (sameDay(d, yesterday())) return 'yesterday'
    return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })
  }
  function dayLabel(iso) {
    const d = new Date(iso)
    if (sameDay(d, new Date())) return 'Today'
    if (sameDay(d, yesterday())) return 'Yesterday'
    return d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })
  }
  const isToday = (iso) => sameDay(new Date(iso), new Date())

  // ---------- Filtering
  function threadOf(item) {
    return view.snapshot.data.threads.find((t) => t.id === item.thread) || { topic: 'No thread', project: '' }
  }
  function inProject() {
    return view.snapshot.data.items.filter((i) => !view.project || threadOf(i).project === view.project)
  }
  function matches(i) {
    if (!view.query) return true
    const t = threadOf(i)
    return [i.title, i.said, i.answer, i.question, i.via, t.topic, t.project].join(' ').toLowerCase().includes(view.query)
  }
  const newest = (a, b) => b.updated.localeCompare(a.updated)
  // Same rule as the store: Claude changed it after the user last saw it.
  const isUnread = (i) => Boolean(i.changed) && (!i.seen || i.seen < i.changed)

  // ---------- Pieces
  // Takes you to the request's chat when it knows which one; otherwise copies the reference.
  function replyButton(i, primary) {
    const label = i.origin ? 'Go to chat' : 'Copy reference'
    return `<button class="${primary ? 'primary' : ''}" data-action="goto">${label}</button>`
  }
  function row(i, { meta, card } = {}) {
    const open = view.expanded === i.id
    return `<button class="row" data-action="expand" aria-expanded="${open}">
      <span class="status ${esc(i.status)}" role="img" aria-label="${NAME[i.status] || ''}"></span>
      <span>
        <span class="title">${esc(i.title)}</span>
        ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
        ${!card && i.status === 'done' && i.answer && !open ? `<span class="preview">${esc(i.answer)}</span>` : ''}
      </span>
      <span class="when">${isUnread(i) ? '<span class="new-dot" role="img" aria-label="New"></span>' : ''}${when(i.updated)}</span>
    </button>`
  }

  function actions(i) {
    const confirming = view.confirming === i.id
    const waiting = i.status === 'need'
    return `<div class="actions">
      ${waiting ? replyButton(i, true) : ''}
      ${i.status === 'done' ? `<button data-action="reopen">Reopen</button>` : `<button data-action="done">Mark done</button>`}
      ${waiting ? '' : replyButton(i, false)}
      <button data-action="remove" class="${confirming ? 'confirm' : ''}">${confirming ? 'Sure? Remove' : 'Remove'}</button>
    </div>`
  }

  function detail(i, { noQuestion } = {}) {
    return `<div class="detail">
      ${i.question && !noQuestion ? `<h4>Claude asks</h4><p>${esc(i.question)}</p>` : ''}
      ${i.said ? `<h4>What you said</h4><p class="said">${esc(i.said)}</p>` : ''}
      ${i.answer ? `<h4>Answer</h4><p>${esc(i.answer)}</p>` : ''}
      ${i.via ? `<h4>Who's on it</h4><p>${esc(i.via)}</p>` : ''}
      ${i.files?.length ? `<div class="files">${i.files.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : ''}
      ${actions(i)}
    </div>`
  }

  function item(i, options = {}) {
    const classes = [
      'item',
      view.expanded === i.id ? 'open' : '',
      i.status === 'done' ? 'is-done' : '',
      isUnread(i) ? 'unread' : '',
      view.changed.has(i.id) ? 'changed' : ''
    ]
    return `<div class="${classes.join(' ')}" data-id="${esc(i.id)}">${row(i, options)}${detail(i)}</div>`
  }

  function card(i) {
    const t = threadOf(i)
    const open = view.expanded === i.id
    const classes = ['card', open ? 'open' : '', isUnread(i) ? 'unread' : '', view.changed.has(i.id) ? 'changed' : '']
    return `<div class="${classes.join(' ')}" data-id="${esc(i.id)}">
      ${row(i, { meta: t.topic, card: true })}
      ${i.question ? `<p class="question">${esc(i.question)}</p>` : ''}
      ${open
        ? detail(i, { noQuestion: true })
        : `<div class="actions">${replyButton(i, true)}<button data-action="done">Mark done</button></div>`}
    </div>`
  }

  const chevron = (style = '') =>
    `<svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="${style}"><path d="M4 6l4 4 4-4"/></svg>`

  function thread(t, items) {
    const collapsed = view.collapsed.has(t.id)
    return `<section class="thread ${collapsed ? 'collapsed' : ''}" data-thread="${esc(t.id)}">
      <button class="thread-head" data-action="collapse" aria-expanded="${!collapsed}">
        ${chevron()}
        <span class="thread-name"><b>${esc(t.topic)}</b></span>
        <span class="count" aria-label="${items.length} in progress">${items.length}</span>
      </button>
      <div class="items">${items.map((i) => item(i, { meta: i.via })).join('')}</div>
    </section>`
  }

  // ---------- Drawing
  function drawHeader(all) {
    const n = { need: 0, moving: 0, done: 0 }
    for (const i of all) {
      if (i.status === 'need') n.need++
      else if (i.status === 'done') n.done++
      else n.moving++
    }
    const needs = n.need ? `<span class="need">${n.need} need${n.need > 1 ? '' : 's'} you</span>` : ''
    let sentence
    if (n.need && n.moving) sentence = `${needs}, ${n.moving} in progress`
    else if (n.need) sentence = needs
    else if (n.moving) sentence = `${n.moving} in progress, nothing waiting on you`
    else sentence = `<span class="calm">All clear</span>`
    const fresh = all.filter(isUnread).length
    if (fresh) sentence += `<span class="calm">, ${fresh} new</span>`
    $('summary').innerHTML = sentence

    const projects = [...new Set(view.snapshot.data.threads.map((t) => t.project))].sort((a, b) => a.localeCompare(b))
    if (view.project && !projects.includes(view.project)) view.project = ''
    $('project').innerHTML =
      `<option value="">All</option>` +
      projects.map((p) => `<option ${p === view.project ? 'selected' : ''} value="${esc(p)}">${esc(p)}</option>`).join('')

    $('tabs').innerHTML = [
      ['open', 'Open', n.need + n.moving],
      ['done', 'Done', n.done]
    ]
      .map(([k, label, c]) => `<button role="tab" data-tab="${k}" aria-selected="${view.tab === k}">${label}<span class="n">${c}</span></button>`)
      .join('')
  }

  // In-progress requests of one project, grouped by thread, most recently touched first.
  function threads(moving) {
    const byThread = new Map()
    for (const i of moving) {
      if (!byThread.has(i.thread)) byThread.set(i.thread, [])
      byThread.get(i.thread).push(i)
    }
    const groups = [...byThread.values()].map((items) => ({
      t: threadOf(items[0]),
      items: items.sort((a, b) => ORDER[a.status] - ORDER[b.status] || newest(a, b))
    }))
    groups.sort((a, b) => b.items[0].updated.localeCompare(a.items[0].updated))
    return groups.map((g) => thread(g.t, g.items)).join('')
  }

  function projectSummary(need, moving) {
    const parts = []
    if (need) parts.push(`<span class="need">${need} need${need > 1 ? '' : 's'} you</span>`)
    if (moving) parts.push(`${moving} in progress`)
    return parts.join(', ')
  }

  // Open tab: one group per project. Inside each, what needs the user first, then threads in
  // progress. Projects with something waiting on the user come first. With a project picked in
  // the filter there is only one group, so it goes without a header.
  function drawOpen(all) {
    const visible = all.filter(matches)
    const open = visible.filter((i) => i.status !== 'done')
    const today = visible.filter((i) => i.status === 'done' && isToday(i.updated)).sort(newest)
    let html = ''

    const byProject = new Map()
    for (const i of open) {
      const p = threadOf(i).project
      if (!byProject.has(p)) byProject.set(p, [])
      byProject.get(p).push(i)
    }
    const projects = [...byProject.entries()].map(([name, items]) => ({
      name,
      need: items.filter((i) => i.status === 'need').sort(newest),
      moving: items.filter((i) => i.status === 'run' || i.status === 'queue'),
      latest: items.reduce((m, i) => (i.updated > m ? i.updated : m), '')
    }))
    projects.sort((a, b) => (b.need.length > 0) - (a.need.length > 0) || b.latest.localeCompare(a.latest))

    const withHeaders = !view.project
    for (const p of projects) {
      const body = p.need.map(card).join('') + threads(p.moving)
      if (!withHeaders) {
        html += body
        continue
      }
      const collapsed = view.collapsedProjects.has(p.name) && !view.query
      html += `<section class="project ${collapsed ? 'collapsed' : ''}" data-project="${esc(p.name)}">
        <button class="project-head" data-action="collapse-project" aria-expanded="${!collapsed}">
          ${chevron()}
          <span><span class="project-name">${esc(p.name)}</span><span class="project-sum">${projectSummary(p.need.length, p.moving.length)}</span></span>
        </button>
        <div class="project-body">${body}</div>
      </section>`
    }

    if (!open.length) {
      html += view.query
        ? `<div class="empty"><b>Nothing open matches “${esc(view.query)}”</b>Try the Done tab.</div>`
        : `<div class="empty"><b>Nothing open</b>Everything you asked for is done.</div>`
    }

    if (today.length) {
      const open = view.showToday || Boolean(view.query)
      html += `<button class="section" data-action="toggle-today" aria-expanded="${open}">Done today <span class="n">${today.length}</span>${chevron(open ? '' : 'transform:rotate(-90deg)')}</button>`
      if (open) {
        html += today
          .map((i) => {
            const t = threadOf(i)
            return item(i, { meta: view.project ? t.topic : `${t.topic} (${t.project})` })
          })
          .join('')
      }
    }
    return html
  }

  function drawDone(all) {
    const done = all.filter((i) => i.status === 'done' && matches(i)).sort(newest)
    if (!done.length) {
      return view.query
        ? `<div class="empty"><b>Nothing done matches “${esc(view.query)}”</b></div>`
        : `<div class="empty"><b>Nothing done yet</b>What Claude finishes shows up here, by day.</div>`
    }
    let html = ''
    let currentDay = null
    for (const i of done) {
      const d = dayLabel(i.updated)
      if (d !== currentDay) {
        html += `<h2 class="section">${esc(d)}</h2>`
        currentDay = d
      }
      const t = threadOf(i)
      html += item(i, { meta: view.project ? t.topic : `${t.topic} (${t.project})` })
    }
    return html
  }

  function draw() {
    if (!view.snapshot) return
    const all = inProject()
    drawHeader(all)
    let html = view.snapshot.error ? `<div class="error" role="alert">${esc(view.snapshot.error)}</div>` : ''
    if (!view.snapshot.data.items.length) {
      html += `<div class="empty"><b>No requests yet</b>Talk to Claude as usual. When one message asks for several things, they show up here, split by topic.</div>`
    } else {
      html += view.tab === 'done' ? drawDone(all) : drawOpen(all)
    }
    $('list').innerHTML = html
  }

  // ---------- What changed since last time
  function receive(snapshot) {
    const current = new Map(snapshot.data.items.map((i) => [i.id, i.updated]))
    if (previous) {
      for (const [id, t] of current) if (previous.get(id) !== t) view.changed.add(id)
      if (view.changed.size) setTimeout(() => view.changed.clear(), 2600)
    }
    previous = current
    view.snapshot = snapshot
    draw()
  }

  // ---------- Toast
  let toastTimer = null
  function toast(message, undo) {
    const t = $('toast')
    t.innerHTML = `<span>${esc(message)}</span>${undo ? '<button data-undo>Undo</button>' : ''}`
    t.hidden = false
    t.onclick = async (e) => {
      if (!e.target.closest('[data-undo]')) return
      t.hidden = true
      try {
        receive(await undo())
      } catch (error) {
        toast(`Couldn't undo: ${error.message}`)
      }
    }
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (t.hidden = true), undo ? 6000 : 4000)
  }

  function copy(text) {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {}
    area.remove()
    return ok
  }

  // ---------- Interaction
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]')
    if (!b) return
    view.tab = b.dataset.tab
    view.expanded = null
    remember()
    draw()
  })
  $('project').addEventListener('change', (e) => {
    view.project = e.target.value
    remember()
    draw()
  })
  $('search').addEventListener('input', (e) => {
    view.query = e.target.value.trim().toLowerCase()
    draw()
  })

  let confirmTimer = null
  $('list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]')
    if (!b) return
    const action = b.dataset.action
    const threadId = b.closest('[data-thread]')?.dataset.thread
    const id = b.closest('[data-id]')?.dataset.id
    const current = id ? view.snapshot.data.items.find((i) => i.id === id) : null

    if (action === 'collapse') {
      view.collapsed.has(threadId) ? view.collapsed.delete(threadId) : view.collapsed.add(threadId)
      return draw()
    }
    if (action === 'collapse-project') {
      const name = b.closest('[data-project]')?.dataset.project
      view.collapsedProjects.has(name) ? view.collapsedProjects.delete(name) : view.collapsedProjects.add(name)
      remember()
      return draw()
    }
    if (action === 'toggle-today') {
      view.showToday = !view.showToday
      remember()
      return draw()
    }
    if (action === 'expand') {
      view.expanded = view.expanded === id ? null : id
      view.confirming = null
      draw()
      // Opening it counts as reading it.
      if (view.expanded === id && current && isUnread(current)) {
        try {
          receive(await ask('requests.seen', { id }))
        } catch {}
      }
      return
    }
    if (action === 'goto') {
      // Copy first: the clipboard only works right after the click.
      const ref = `[${id}]`
      const copied = copy(ref + ' ')
      const paste = copied ? `${ref} is copied: paste it and write your reply.` : `Start your message with ${ref}.`
      if (!current?.origin) {
        return toast(copied ? `Copied ${ref}. Paste it in Claude's chat and write your reply after it.` : `Start your message to Claude with ${ref}.`)
      }
      try {
        const r = await ask('requests.goto', { id })
        receive(r.snapshot)
        if (r.result === 'switched') toast(`Opened the chat. ${paste}`)
        else if (r.result === 'closed') toast(`That chat is closed. The request stays open. ${paste}`)
        else toast(`Couldn't open the chat. ${paste}`)
      } catch (error) {
        toast(`Couldn't open the chat: ${error.message}`)
      }
      return
    }
    if (!current) return
    try {
      if (action === 'done') {
        const before = { status: current.status, question: current.question }
        view.expanded = null
        receive(await ask('requests.update', { id, status: 'done' }))
        toast(`Done: ${current.title}`, () => ask('requests.update', { id, ...before }))
      } else if (action === 'reopen') {
        receive(await ask('requests.update', { id, status: 'run' }))
        toast(`Reopened: ${current.title}`)
      } else if (action === 'remove') {
        if (view.confirming !== id) {
          view.confirming = id
          clearTimeout(confirmTimer)
          confirmTimer = setTimeout(() => {
            view.confirming = null
            draw()
          }, 3000)
          return draw()
        }
        view.confirming = null
        view.expanded = null
        receive(await ask('requests.remove', { id }))
        toast(`Removed: ${current.title}`)
      }
    } catch (error) {
      toast(`Couldn't save: ${error.message}`)
    }
  })

  // ---------- Start
  async function load() {
    try {
      receive(await ask('requests.read'))
    } catch (error) {
      receive({ data: { threads: [], items: [] }, error: `Couldn't read the list: ${error.message}` })
    }
  }
  listen('requests.changed', receive)
  setInterval(draw, 60000) // keeps "3 min ago" fresh
  load()
})()
