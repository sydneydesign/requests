// Orca panel: draws the list the worker hands it and asks the worker for changes.
// One line per request. Grouped by project (status shown as each row's icon, sorted Needs you,
// In progress, Queued) or by status (tinted bands, project as a chip). The display menu switches.
;(function () {
  const ORDER = { need: 0, run: 1, queue: 2, done: 3 }
  const NAME = { need: 'Needs you', run: 'In progress', queue: 'Queued', done: 'Done' }
  const LOCALE = 'en-GB'

  const view = {
    snapshot: null,
    group: 'project', // 'project' or 'status'
    doneRange: 'today', // 'today' or 'all'
    project: '',
    query: '',
    searchOpen: false,
    expanded: null,
    collapsed: new Set(), // project or status groups the user closed
    openDone: new Set(), // groups whose done requests are showing
    confirming: null,
    changed: new Set()
  }
  let previous = null // id → updated, to tell what changed

  try {
    const saved = JSON.parse(localStorage.getItem('requests.view') || '{}')
    if (saved.group === 'project' || saved.group === 'status') view.group = saved.group
    if (saved.doneRange === 'today' || saved.doneRange === 'all') view.doneRange = saved.doneRange
    if (typeof saved.project === 'string') view.project = saved.project
    if (Array.isArray(saved.collapsed)) view.collapsed = new Set(saved.collapsed)
  } catch {}
  function remember() {
    try {
      localStorage.setItem(
        'requests.view',
        JSON.stringify({ group: view.group, doneRange: view.doneRange, project: view.project, collapsed: [...view.collapsed] })
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
  const isToday = (iso) => sameDay(new Date(iso), new Date())
  // Short relative time for the row's right edge; a date after a week.
  function when(iso) {
    const t = Date.parse(iso)
    if (!t) return ''
    const min = Math.round((Date.now() - t) / 60000)
    if (min < 1) return 'now'
    if (min < 60) return `${min}m`
    if (min < 1440) return `${Math.round(min / 60)}h`
    if (min < 7 * 1440) return `${Math.round(min / 1440)}d`
    return new Date(t).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })
  }
  // Same rule as the store: in progress with no update for over 30 min. Probably done and never closed.
  const STALE_MINUTES = 30
  const isStale = (i) => i.status === 'run' && Date.now() - Date.parse(i.updated) > STALE_MINUTES * 60000

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
  const byStatus = (a, b) => ORDER[a.status] - ORDER[b.status] || newest(a, b)
  const isOpen = (i) => i.status !== 'done'
  const inRange = (i) => view.doneRange === 'all' || isToday(i.updated)
  // Same rule as the store: Claude changed it after the user last saw it.
  const isUnread = (i) => Boolean(i.changed) && (!i.seen || i.seen < i.changed)
  // A search opens everything, so matches are never hidden.
  const isClosed = (key) => view.collapsed.has(key) && !view.query
  const showsDone = (key) => view.openDone.has(key) || Boolean(view.query)

  // ---------- Pieces
  const chevron = () =>
    `<svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>`
  const icon = (s, small) => `<span class="status ${s}${small ? ' sm' : ''}" role="img" aria-label="${NAME[s]}"></span>`
  const counts = (items) => {
    const n = { need: 0, run: 0, queue: 0 }
    for (const i of items) if (i.status in n) n[i.status]++
    return ['need', 'run', 'queue'].filter((s) => n[s]).map((s) => `<span title="${NAME[s]}">${icon(s, true)}${n[s]}</span>`).join('')
  }

  // Takes you to the request's chat when it knows which one; otherwise copies the reference.
  function replyButton(i, primary) {
    const label = i.origin ? 'Go to chat' : 'Copy reference'
    return `<button class="${primary ? 'primary' : ''}" data-action="goto">${label}</button>`
  }

  // One request: icon, title on one line, then one line of context (Claude's question in
  // orange, or the thread and who is on it). On the right, Reply for a question, else the time.
  function row(i, { chip } = {}) {
    const open = view.expanded === i.id
    const t = threadOf(i)
    const stale = isStale(i)
    const second =
      i.status === 'need' && i.question
        ? `<span class="q">${esc(i.question)}</span>`
        : `<span class="meta">${[t.topic, i.via].filter(Boolean).map(esc).join(' · ')}</span>`
    const right =
      i.status === 'need' && !open
        ? `<button class="reply" data-action="goto">Reply</button>`
        : `<span class="when${stale ? ' stale' : ''}"${stale ? ' title="No update from Claude in a while. Mark it done if it is finished."' : ''}>${stale ? `idle ${when(i.updated)}` : when(i.updated)}</span>`
    return `<div class="row" data-action="expand" role="button" tabindex="0" aria-expanded="${open}">
      ${icon(i.status)}
      <span class="body">
        <span class="title">${isUnread(i) ? '<span class="new-dot" role="img" aria-label="New update"></span>' : ''}${esc(i.title)}${chip ? `<span class="chip">${esc(t.project)}</span>` : ''}</span>
        ${second}
      </span>
      ${right}
    </div>`
  }

  function actions(i) {
    const confirming = view.confirming === i.id
    return `<div class="actions">
      ${replyButton(i, i.status === 'need')}
      ${i.status === 'done' ? `<button data-action="reopen">Reopen</button>` : `<button data-action="done">Mark done</button>`}
      <button data-action="remove" class="${confirming ? 'confirm' : ''}">${confirming ? 'Sure? Remove' : 'Remove'}</button>
    </div>`
  }

  function detail(i) {
    return `<div class="detail">
      ${i.question ? `<h4>Claude asks</h4><p>${esc(i.question)}</p>` : ''}
      ${i.said ? `<h4>What you said</h4><p class="said">${esc(i.said)}</p>` : ''}
      ${i.answer ? `<h4>Answer</h4><p>${esc(i.answer)}</p>` : ''}
      ${i.via ? `<h4>Who's on it</h4><p>${esc(i.via)}</p>` : ''}
      ${i.files?.length ? `<div class="files">${i.files.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : ''}
      ${actions(i)}
    </div>`
  }

  function item(i, options = {}) {
    const open = view.expanded === i.id
    const classes = ['item', open ? 'open' : '', i.status === 'done' ? 'is-done' : '', isUnread(i) ? 'unread' : '', view.changed.has(i.id) ? 'changed' : '']
    return `<div class="${classes.join(' ')}" data-id="${esc(i.id)}">${row(i, options)}${open ? detail(i) : ''}</div>`
  }

  // ---------- Drawing
  function drawHeader(all) {
    $('summary').innerHTML = `<span class="ttl">Requests</span><span class="counts">${counts(all)}</span>`

    const projects = [...new Set(view.snapshot.data.threads.map((t) => t.project))].sort((a, b) => a.localeCompare(b))
    if (view.project && !projects.includes(view.project)) view.project = ''
    $('project').innerHTML =
      `<option value="">All projects</option>` +
      projects.map((p) => `<option ${p === view.project ? 'selected' : ''} value="${esc(p)}">${esc(p)}</option>`).join('')
    document.querySelectorAll('[data-group]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === view.group)))
    document.querySelectorAll('[data-done]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.done === view.doneRange)))
    // A dot on the display button when the view is not the default one.
    $('displaybtn')?.classList.toggle('changed-view', view.group !== 'project' || view.doneRange !== 'today' || Boolean(view.project))
  }

  function doneLine(key, done) {
    if (!done.length) return ''
    const showing = showsDone(key)
    const label = `${done.length} done${view.doneRange === 'today' ? ' today' : ''}`
    return `<button class="done-line" data-action="toggle-done" data-key="${esc(key)}" aria-expanded="${showing}">${icon('done', true)}<span>${label}</span>${chevron()}</button>
      ${showing ? done.sort(newest).map((i) => item(i)).join('') : ''}`
  }

  // By project: projects with something waiting on you first, then open work, then done only.
  // Inside, rows sorted Needs you, In progress, Queued; done folds into one line.
  function drawByProject(visible) {
    const byProject = new Map()
    for (const i of visible) {
      const p = threadOf(i).project
      if (!byProject.has(p)) byProject.set(p, [])
      byProject.get(p).push(i)
    }
    const rank = (items) => (items.some((i) => i.status === 'need') ? 0 : items.some(isOpen) ? 1 : 2)
    const latest = (items) => items.reduce((m, i) => (i.updated > m ? i.updated : m), '')
    const projects = [...byProject.entries()]
      .filter(([, items]) => items.some((i) => isOpen(i) || inRange(i)))
      .sort(([, a], [, b]) => rank(a) - rank(b) || latest(b).localeCompare(latest(a)))
    return projects
      .map(([name, items]) => {
        const key = `p:${name}`
        const body =
          items.filter(isOpen).sort(byStatus).map((i) => item(i)).join('') +
          doneLine(key, items.filter((i) => !isOpen(i) && inRange(i)))
        // With one project picked in the filter, it goes without a header.
        if (view.project) return `<section class="project">${body}</section>`
        const closed = isClosed(key)
        return `<section class="project ${closed ? 'collapsed' : ''}">
          <button class="project-head" data-action="collapse" data-key="${esc(key)}" aria-expanded="${!closed}">
            ${chevron()}<span class="project-name">${esc(name)}</span><span class="counts">${counts(items)}</span>
          </button>
          ${closed ? '' : body}
        </section>`
      })
      .join('')
  }

  // By status: one band per status, the project as a chip on each row. Done starts closed.
  function drawByStatus(visible) {
    return ['need', 'run', 'queue', 'done']
      .map((s) => {
        const these = visible.filter((i) => i.status === s && (s !== 'done' || inRange(i))).sort(newest)
        if (!these.length) return ''
        const key = `s:${s}`
        const closed = s === 'done' ? !showsDone(key) : isClosed(key)
        const label = `${NAME[s]}${s === 'done' && view.doneRange === 'today' ? ' today' : ''}`
        return `<section class="band-group ${closed ? 'collapsed' : ''}">
          <button class="band" data-action="${s === 'done' ? 'toggle-done' : 'collapse'}" data-key="${key}" aria-expanded="${!closed}">
            ${icon(s, true)}<span>${label}</span><span class="n">${these.length}</span>${chevron()}
          </button>
          ${closed ? '' : these.map((i) => item(i, { chip: !view.project })).join('')}
        </section>`
      })
      .join('')
  }

  function drawList(all) {
    const visible = all.filter(matches)
    if (!visible.some((i) => isOpen(i) || inRange(i))) {
      return view.query
        ? `<div class="empty"><b>Nothing matches “${esc(view.query)}”</b></div>`
        : `<div class="empty"><b>All clear</b>Nothing open${view.doneRange === 'today' ? ', and nothing done today' : ''}.</div>`
    }
    return view.group === 'status' ? drawByStatus(visible) : drawByProject(visible)
  }

  function draw() {
    if (!view.snapshot) return
    const all = inProject()
    drawHeader(all)
    let html = view.snapshot.error ? `<div class="error" role="alert">${esc(view.snapshot.error)}</div>` : ''
    if (!view.snapshot.data.items.length) {
      html += `<div class="empty"><b>No requests yet</b>Talk to Claude as usual. When one message asks for several things, they show up here, split by topic.</div>`
    } else {
      html += drawList(all)
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
  // Search hides behind an icon, as in Cursor. Escape clears and closes it.
  function setSearch(open) {
    view.searchOpen = open
    $('searchrow').hidden = !open
    $('searchbtn').setAttribute('aria-expanded', String(open))
    if (open) $('search').focus()
    else if (view.query) {
      $('search').value = ''
      view.query = ''
      draw()
    }
  }
  $('searchbtn')?.addEventListener('click', () => setSearch(!view.searchOpen))
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setSearch(false)
  })
  $('search').addEventListener('input', (e) => {
    view.query = e.target.value.trim().toLowerCase()
    draw()
  })

  // Display menu: grouping, project and how much of Done to show.
  function setMenu(open) {
    $('displaymenu').hidden = !open
    $('displaybtn').setAttribute('aria-expanded', String(open))
  }
  $('displaybtn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    setMenu($('displaymenu').hidden)
  })
  $('displaymenu')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const g = e.target.closest('[data-group]')
    const d = e.target.closest('[data-done]')
    if (g) view.group = g.dataset.group
    if (d) view.doneRange = d.dataset.done
    if (g || d) {
      view.openDone.clear()
      remember()
      draw()
    }
  })
  document.addEventListener('click', () => {
    if ($('displaymenu') && !$('displaymenu').hidden) setMenu(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('displaymenu') && !$('displaymenu').hidden) setMenu(false)
  })
  $('project').addEventListener('change', (e) => {
    view.project = e.target.value
    remember()
    draw()
  })

  // The board tab (orca/board). Only in the sidebar: the board's own List view hides this switch.
  $('openboard')?.addEventListener('click', async () => {
    try {
      const r = await ask('requests.openBoard')
      if (!r?.opened) toast(`Couldn't open the board. ${r?.error || ''}`.trim())
    } catch (error) {
      toast(`Couldn't open the board: ${error.message}`)
    }
  })

  // Rows are divs with role=button (they hold a Reply button), so Enter and Space open them.
  $('list').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.row[role="button"]')) {
      e.preventDefault()
      e.target.click()
    }
  })

  let confirmTimer = null
  $('list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]')
    if (!b) return
    const action = b.dataset.action
    const id = b.closest('[data-id]')?.dataset.id
    const current = id ? view.snapshot.data.items.find((i) => i.id === id) : null

    if (action === 'collapse') {
      const key = b.dataset.key
      view.collapsed.has(key) ? view.collapsed.delete(key) : view.collapsed.add(key)
      remember()
      return draw()
    }
    if (action === 'toggle-done') {
      const key = b.dataset.key
      view.openDone.has(key) ? view.openDone.delete(key) : view.openDone.add(key)
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
  setInterval(draw, 60000) // keeps "3m" fresh
  load()
})()
