// Orca custom editor: the request list as a full-width board, or the panel itself as a list.
// It opens on ~/.requests/requests.json but reads and changes the list through the worker,
// like the panel, and never edits the file as a document.
;(function () {
  const STATUSES = ['need', 'run', 'queue', 'done']
  const NAME = { need: 'Needs you', run: 'In progress', queue: 'Queued', done: 'Done' }
  const STALE_MINUTES = 30

  const view = { snapshot: null, mode: 'board', project: '', query: '', openChats: null, expanded: null, clearedAt: '' }
  try {
    const saved = JSON.parse(localStorage.getItem('requests.board') || '{}')
    if (saved.mode === 'list' || saved.mode === 'board') view.mode = saved.mode
    if (typeof saved.project === 'string') view.project = saved.project
    if (typeof saved.clearedAt === 'string') view.clearedAt = saved.clearedAt
  } catch {}
  const remember = () => {
    try {
      localStorage.setItem('requests.board', JSON.stringify({ mode: view.mode, project: view.project, clearedAt: view.clearedAt }))
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

  // ---------- Rules (same as the panel and the store)
  const isUnread = (i) => Boolean(i.changed) && (!i.seen || i.seen < i.changed)
  const isStale = (i) => i.status === 'run' && Date.now() - Date.parse(i.updated) > STALE_MINUTES * 60000
  const today = (iso) => new Date(iso).toDateString() === new Date().toDateString()
  // Short relative time; a real date after a week. A clock a little ahead of the file's
  // reads as "now", never as a blank.
  function ago(iso) {
    const t = Date.parse(iso)
    if (!t) return ''
    const min = Math.round((Date.now() - t) / 60000)
    if (min < 1) return 'now'
    if (min < 60) return `${min}m`
    if (min < 1440) return `${Math.round(min / 60)}h`
    if (min < 7 * 1440) return `${Math.round(min / 1440)}d`
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }

  function threadOf(i) {
    return view.snapshot.data.threads.find((t) => t.id === i.thread) || { topic: 'No thread', project: '' }
  }
  // A done request stays while the chat it came from is open, and until "Clear". Without a
  // known chat (logged outside Orca, or Orca can't list its terminals) it stays for the day.
  function keepDone(i) {
    if (view.clearedAt && i.updated <= view.clearedAt) return false
    if (view.openChats && i.origin?.terminal) return view.openChats.has(i.origin.terminal)
    return today(i.updated)
  }
  function inProject() {
    return view.snapshot.data.items.filter((i) => !view.project || threadOf(i).project === view.project)
  }
  function matches(i) {
    if (!view.query) return true
    const t = threadOf(i)
    return [i.id, i.title, i.said, i.answer, i.question, i.via, t.topic, t.project].join(' ').toLowerCase().includes(view.query)
  }
  function items() {
    return inProject()
      .filter(matches)
      .filter((i) => i.status !== 'done' || keepDone(i))
      .sort((a, b) => b.updated.localeCompare(a.updated))
  }
  async function refreshChats() {
    try {
      const r = await ask('requests.openChats')
      view.openChats = Array.isArray(r?.handles) ? new Set(r.handles) : null
    } catch {
      view.openChats = null
    }
  }

  // ---------- Drawing (same header and status icons as the panel)
  const icon = (s, small) => `<span class="status ${s}${small ? ' sm' : ''}" role="img" aria-label="${NAME[s]}"></span>`
  function summary(all) {
    const n = { need: 0, run: 0, queue: 0 }
    for (const i of all) if (i.status in n) n[i.status]++
    return `<span class="ttl">Requests</span><span class="counts">${['need', 'run', 'queue']
      .filter((s) => n[s])
      .map((s) => `<span title="${NAME[s]}">${icon(s, true)}${n[s]}</span>`)
      .join('')}</span>`
  }

  function actions(i) {
    const go = `<button class="primary" data-action="goto">${i.origin ? 'Go to chat' : 'Copy reference'}</button>`
    if (i.status === 'done') return `${go}<button data-action="reopen">Reopen</button>`
    return `${go}<button data-action="done">Mark done</button>`
  }

  // A card, after Cursor's board: status icon, ID and time on top; the title; one line of
  // context (Claude's question in orange, or the thread and project). Reply when it needs you.
  function card(i) {
    const t = threadOf(i)
    const open = view.expanded === i.id
    const unread = isUnread(i)
    const stale = isStale(i)
    const time = stale ? `<span class="m stale">idle ${ago(i.updated)}</span>` : `<span class="m">${ago(i.updated)}</span>`
    if (i.status === 'done' && !open) {
      return `<button class="bcard done slim" data-id="${esc(i.id)}" aria-expanded="false" title="${esc(i.title)}">
        ${icon('done', true)}<span class="t" dir="auto">${esc(i.title)}</span><span class="m">${ago(i.updated)}</span>
      </button>`
    }
    const context = i.status === 'need' && i.question
      ? `<span class="q" dir="auto">${esc(i.question)}</span>`
      : `<span class="ctx"><span class="th" dir="auto" title="${esc(t.topic)}">${esc(t.topic)}</span>${view.project ? '' : `<span class="chip">${esc(t.project)}</span>`}</span>`
    return `<div class="bcard ${esc(i.status)} ${open ? 'open' : ''} ${unread ? 'unread' : ''}" data-id="${esc(i.id)}">
      <button class="face" data-id="${esc(i.id)}" aria-expanded="${open}">
        <span class="top">${icon(i.status, true)}<span class="id">${esc(i.id)}</span>${unread ? '<span class="new-dot" role="img" aria-label="New update"></span>' : ''}${time}</span>
        <span class="t" dir="auto">${esc(i.title)}</span>
        ${context}
      </button>
      ${i.status === 'need' && !open ? `<div class="cardfoot"><button class="reply" data-action="goto">Reply</button></div>` : ''}
      ${open ? `<div class="more">
        ${i.question ? `<p><b>Claude asks</b> ${esc(i.question)}</p>` : ''}
        ${i.said ? `<p class="said"><b>You said</b> ${esc(i.said)}</p>` : ''}
        ${i.answer ? `<p class="ans"><b>Claude</b> ${esc(i.answer)}</p>` : ''}
        ${i.via ? `<p class="via"><b>Who's on it</b> ${esc(i.via)}</p>` : ''}
        <div class="actions">${actions(i)}</div>
      </div>` : ''}
    </div>`
  }

  function board(list) {
    return `<div class="cols">${STATUSES.map((s) => {
      const these = list.filter((i) => i.status === s)
      const clear = s === 'done' && these.length ? `<button class="clear" data-action="clear">Clear</button>` : ''
      return `<section class="col col-${s}" aria-label="${NAME[s]}">
        <h2>${icon(s, true)}${NAME[s]} <span class="n">${these.length}</span>${clear}</h2>
        <div class="cards">${these.map(card).join('') || `<p class="empty">${view.query ? 'No matches' : 'Nothing here'}</p>`}</div>
      </section>`
    }).join('')}</div>`
  }

  // List view is the sidebar panel itself: panel.js draws into #listview and handles its own
  // search, project filter and actions. The board only shows or hides it.
  function render() {
    const isBoard = view.mode === 'board'
    document.querySelectorAll('.switch button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view.mode)))
    $('main').hidden = !isBoard
    $('listview').hidden = isBoard
    // In List view the panel brings its own header: the board's bar hides and its List | Board
    // switch moves into the panel's header row, so there is one header either way.
    const sw = document.querySelector('.switch')
    const panelTools = document.querySelector('#listview .ptools')
    if (isBoard) {
      if (sw.parentElement !== $('bhead')) $('bhead').insertBefore(sw, $('bsearchrow'))
    } else if (panelTools && sw.parentElement !== panelTools) {
      panelTools.appendChild(sw)
    }
    $('bhead').hidden = !isBoard
    if (!view.snapshot || !isBoard) return
    const projects = [...new Set(view.snapshot.data.threads.map((t) => t.project).filter(Boolean))].sort()
    if (view.project && !projects.includes(view.project)) view.project = ''
    $('bproject').innerHTML =
      `<option value="">All projects</option>` +
      projects.map((p) => `<option ${p === view.project ? 'selected' : ''}>${esc(p)}</option>`).join('')
    $('bsummary').innerHTML = summary(inProject())
    // Keep each column's scroll position across redraws.
    const scrolls = [...document.querySelectorAll('.col .cards')].map((c) => c.scrollTop)
    const x = $('main').scrollLeft
    $('main').innerHTML = board(items())
    document.querySelectorAll('.col .cards').forEach((c, n) => (c.scrollTop = scrolls[n] || 0))
    $('main').scrollLeft = x
  }

  async function receive(s) {
    if (!s || !s.data) return
    view.snapshot = s
    render()
    await refreshChats()
    render()
  }
  // Chats close without the list changing, so look again every 30 s. Also keeps "5m" fresh.
  setInterval(() => { if (view.snapshot) refreshChats().then(render) }, 30000)

  // ---------- Toast (the panel's element, shared)
  let toastTimer = null
  function toast(message, undo) {
    const t = $('toast')
    t.innerHTML = `<span>${esc(message)}</span>${undo ? '<button data-undo>Undo</button>' : ''}`
    t.hidden = false
    t.onclick = async (e) => {
      if (!e.target.closest('[data-undo]')) return
      t.hidden = true
      try { receive(await undo()) } catch (error) { toast(`Couldn't undo: ${error.message}`) }
    }
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (t.hidden = true), undo ? 6000 : 4000)
  }
  function copy(text) {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch {}
    area.remove()
    return ok
  }

  // ---------- Interaction
  $('bproject').addEventListener('change', (e) => { view.project = e.target.value; remember(); render() })
  document.querySelector('.switch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]')
    if (!b) return
    view.mode = b.dataset.view
    remember()
    render()
  })

  // Search and display menu, as in the panel.
  $('bsearchbtn').addEventListener('click', () => {
    const open = $('bsearchrow').hidden
    $('bsearchrow').hidden = !open
    $('bsearchbtn').setAttribute('aria-expanded', String(open))
    if (open) $('bsearch').focus()
    else if (view.query) {
      $('bsearch').value = ''
      view.query = ''
      render()
    }
  })
  $('bsearch').addEventListener('input', (e) => {
    view.query = e.target.value.trim().toLowerCase()
    render()
  })
  $('bsearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('bsearchbtn').click()
  })
  function setMenu(open) {
    $('bdisplaymenu').hidden = !open
    $('bdisplaybtn').setAttribute('aria-expanded', String(open))
  }
  $('bdisplaybtn').addEventListener('click', (e) => {
    e.stopPropagation()
    setMenu($('bdisplaymenu').hidden)
  })
  $('bdisplaymenu').addEventListener('click', (e) => {
    e.stopPropagation()
    if (e.target.closest('[data-action="clear"]')) {
      view.clearedAt = new Date().toISOString()
      remember()
      setMenu(false)
      render()
    }
  })
  document.addEventListener('click', () => { if (!$('bdisplaymenu').hidden) setMenu(false) })

  $('main').addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action], [data-id]')
    if (!target) return
    const action = target.dataset.action

    if (action === 'clear') {
      view.clearedAt = new Date().toISOString()
      remember()
      render()
      return
    }

    const id = target.dataset.id || target.closest('[data-id]')?.dataset.id || target.closest('.bcard')?.querySelector('[data-id]')?.dataset.id
    const current = view.snapshot.data.items.find((i) => i.id === id)
    if (!current) return

    if (!action) {
      // Only the card's face toggles it, so text in an open card can be selected.
      if (target.tagName !== 'BUTTON') return
      // Open or close the card. Opening it counts as reading it, as in the panel.
      view.expanded = view.expanded === id ? null : id
      render()
      if (view.expanded && isUnread(current)) {
        try { receive(await ask('requests.seen', { id })) } catch {}
      }
      return
    }

    if (action === 'goto') {
      // Copy first: the clipboard only works right after the click.
      const ref = `[${id}]`
      const copied = copy(ref + ' ')
      const paste = copied ? `${ref} is copied: paste it and write your reply.` : `Start your message with ${ref}.`
      if (!current.origin) return toast(copied ? `Copied ${ref}. Paste it in Claude's chat.` : `Start your message to Claude with ${ref}.`)
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

    try {
      if (action === 'done') {
        const before = { status: current.status, question: current.question }
        view.expanded = null
        receive(await ask('requests.update', { id, status: 'done' }))
        toast(`Done: ${current.title}`, () => ask('requests.update', { id, ...before }))
      } else if (action === 'reopen') {
        view.expanded = null
        receive(await ask('requests.update', { id, status: 'run' }))
        toast(`Reopened: ${current.title}`)
      }
    } catch (error) {
      toast(`Couldn't save: ${error.message}`)
    }
  })

  // Orca expects a custom editor to ask for its document. The board reads the worker's parsed
  // copy instead, so it only acknowledges the file.
  window.orca?.document?.get?.().catch(() => {})

  listen('requests.changed', receive)
  ask('requests.read').then(receive).catch((e) => { $('main').textContent = `Couldn't read the list: ${e.message}` })
  render()
})()
