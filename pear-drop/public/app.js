// Pear Drop page: polls /api/state and keeps one DOM node per transfer (updated in place, so focus
// and open panels survive the refresh).
const $ = (id) => document.getElementById(id)
const items = new Map() // id -> { el, refs }
const open = { files: new Set(), qr: new Set(), confirm: new Set() }
let target = null // { key, name } of a nearby device, or null for link mode
let lastState = null

const fmtBytes = (n) => {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1000)))
  const v = n / 1000 ** i
  return (i === 0 ? v : v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i]
}
const fmtMs = (ms) => ms < 1000 ? ms + ' ms' : ms < 60000 ? (ms / 1000).toFixed(1) + ' s' : Math.floor(ms / 60000) + ' min ' + Math.round(ms % 60000 / 1000) + ' s'
const shortLink = (l) => { const k = l.replace('peardrop://', ''); return 'peardrop://' + k.slice(0, 12) + '...' + k.slice(-6) }
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's')
const esc = (x) => String(x).replace(/[&<>"']/g, (ch) => '&#' + ch.charCodeAt(0) + ';')

function showErr (msg) { const e = $('err'); e.textContent = msg || ''; e.hidden = !msg }
let noteTimer = null
function showNote (msg) { const e = $('note'); e.textContent = msg; e.hidden = false; clearTimeout(noteTimer); noteTimer = setTimeout(() => { e.hidden = true }, 6000) }

async function api (method, url, body) {
  const res = await fetch(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed')
  return data
}

// ---------- mode ----------
function setMode (m) {
  $('sendPanel').hidden = m !== 'send'
  $('recvPanel').hidden = m !== 'recv'
  $('openBtn').setAttribute('aria-pressed', String(m === 'recv'))
  showErr('')
}
$('sendBtn').onclick = () => { setMode('send'); $('fileIn').click() }
$('openBtn').onclick = () => { setMode('recv'); $('linkIn').focus() }
$('pickFiles').onclick = () => $('fileIn').click()
$('pickFolder').onclick = () => $('dirIn').click()

// ---------- nearby target ----------
function setTarget (d) {
  target = d ? { key: d.key, name: d.name } : null
  $('target').hidden = !target
  if (target) $('targetName').textContent = target.name
  $('mode').textContent = target ? 'Nearby' : 'Link mode'
  $('pathBtn').textContent = target ? 'Send path' : 'Share path'
  $('h1rest').textContent = target ? `Send to ${target.name}.` : 'Share a link.'
  if (lastState) renderNearby(lastState.nearby)
}
$('clearTarget').onclick = () => setTarget(null)

// ---------- send ----------
async function upload (name, list) {
  // list: [{ path, file }]
  if (!list.length) return showErr('No files')
  showErr('')
  try {
    const t = await api('POST', '/api/send', { name, to: target && target.key, files: list.map((x) => ({ path: x.path, size: x.file.size })) })
    await poll()
    for (const x of list) {
      const res = await fetch(`/api/upload?id=${t.id}&path=${encodeURIComponent(x.path)}`, { method: 'PUT', body: x.file })
      if (!res.ok) throw new Error('Upload failed')
    }
    await api('POST', '/api/finish/' + t.id, {})
    if (!t.to) open.qr.add(t.id)
    poll()
  } catch (e) { showErr(e.message) }
}

$('fileIn').onchange = (ev) => {
  const files = [...ev.target.files]
  ev.target.value = ''
  const name = files.length === 1 ? files[0].name : plural(files.length, 'file')
  upload(name, files.map((f) => ({ path: f.name, file: f })))
}
$('dirIn').onchange = (ev) => {
  const files = [...ev.target.files]
  ev.target.value = ''
  if (!files.length) return
  const name = files[0].webkitRelativePath.split('/')[0]
  upload(name, files.filter((f) => f.name !== '.DS_Store').map((f) => ({ path: f.webkitRelativePath.split('/').slice(1).join('/'), file: f })))
}

$('pathForm').onsubmit = async (ev) => {
  ev.preventDefault()
  const p = $('pathIn').value.trim()
  if (!p) return showErr('Path missing')
  try {
    const t = await api('POST', '/api/send', { path: p, to: target && target.key })
    $('pathIn').value = ''
    if (!t.to) open.qr.add(t.id)
    showErr('')
    poll()
  } catch (e) { showErr(e.message) }
}

// Drag and drop anywhere on the hero card; folders are walked with the entry API.
const hero = $('hero')
let dragDepth = 0
hero.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; hero.classList.add('drag'); setMode('send') })
hero.addEventListener('dragover', (e) => e.preventDefault())
hero.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; hero.classList.remove('drag') } })
hero.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; hero.classList.remove('drag')
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean)
  const out = []
  const fileOf = (fe) => new Promise((res, rej) => fe.file(res, rej))
  const readAll = (dir) => new Promise((res, rej) => {
    const r = dir.createReader(); const all = []
    const next = () => r.readEntries((batch) => { if (!batch.length) return res(all); all.push(...batch); next() }, rej)
    next()
  })
  async function walk (entry, prefix) {
    if (entry.isFile) { if (entry.name !== '.DS_Store') out.push({ path: prefix + entry.name, file: await fileOf(entry) }) } else if (entry.isDirectory) for (const c of await readAll(entry)) await walk(c, prefix + entry.name + '/')
  }
  const oneDir = entries.length === 1 && entries[0].isDirectory
  if (oneDir) for (const c of await readAll(entries[0])) await walk(c, '')
  else for (const en of entries) await walk(en, '')
  const name = oneDir ? entries[0].name : out.length === 1 ? out[0].file.name : plural(out.length, 'file')
  upload(name, out)
})

// ---------- receive ----------
$('recvPanel').onsubmit = async (ev) => {
  ev.preventDefault()
  const l = $('linkIn').value.trim()
  if (!l) return showErr('Link missing')
  try { await api('POST', '/api/receive', { link: l }); $('linkIn').value = ''; showErr(''); poll() } catch (e) { showErr(e.message) }
}

// ---------- transfers list ----------
// ---------- nearby: devices and incoming requests ----------
const devRows = new Map()
const reqRows = new Map()

function renderNearby (n) {
  if (!n) return
  const box = $('devices')
  const seen = new Set()
  n.devices.forEach((d, i) => {
    seen.add(d.key)
    let row = devRows.get(d.key)
    if (!row) {
      row = document.createElement('div')
      row.className = 'dev'
      row.innerHTML = '<span class="p-dot" aria-hidden="true"></span><span class="dn"></span><span class="ds"></span><button class="copy" type="button" aria-pressed="false">Send</button>'
      row.querySelector('button').onclick = () => {
        const cur = row._d
        if (target && target.key === cur.key) return setTarget(null)
        setTarget(cur); setMode('send'); $('hero').scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      devRows.set(d.key, row)
    }
    row._d = d
    if (box.children[i] !== row) box.insertBefore(row, box.children[i] || null)
    row.classList.toggle('off', !d.online)
    row.querySelector('.p-dot').className = 'p-dot' + (d.online ? ' p-dot--online' : '')
    row.querySelector('.dn').textContent = d.name
    row.querySelector('.ds').textContent = d.online ? 'Online' : 'Left'
    const b = row.querySelector('button')
    b.disabled = !d.online
    b.title = d.online ? '' : 'Offline'
    b.setAttribute('aria-pressed', String(!!target && target.key === d.key))
  })
  for (const [k, row] of devRows) if (!seen.has(k)) { row.remove(); devRows.delete(k) }
  const online = n.devices.filter((d) => d.online).length
  $('nCount').textContent = !n.on ? 'Off' : !n.ready ? 'Looking' : online ? online + ' online' : ''
  $('nbEmpty').hidden = n.devices.length > 0
  $('nbEmptyText').textContent = !n.on ? 'Nearby is off' : n.ready ? 'No devices nearby' : 'Looking for devices'
  if (target) {
    const d = n.devices.find((x) => x.key === target.key)
    $('targetDot').className = 'p-dot' + (d && d.online ? ' p-dot--online' : '')
  }

  // Incoming requests: Accept is the one lime button while one waits, so Send files steps down.
  const rbox = $('reqs')
  const rseen = new Set()
  let primaryGiven = false
  for (const q of n.requests) {
    rseen.add(q.id)
    let el = reqRows.get(q.id)
    if (!el) {
      el = document.createElement('section')
      el.className = 'p-card req'
      el.innerHTML = '<div class="what"><span class="p-dot" aria-hidden="true"></span><span><b class="rf"></b> wants to send <b class="rn"></b> <span class="dim rs"></span></span><span class="tag warn" hidden>Peer left</span></div><div class="btns"><button class="p-btn p-btn--sm" type="button" data-act="accept">Accept</button><button class="p-btn p-btn--secondary p-btn--sm" type="button" data-act="decline">Decline</button></div>'
      el.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act
        if (!act) return
        e.target.disabled = true
        try {
          await api('POST', `/api/nearby/${act}/${q.id}`, {})
          showErr('')
        } catch (er) { showErr(er.message) }
        poll()
      })
      reqRows.set(q.id, el)
      rbox.appendChild(el)
    }
    el.querySelector('.rf').textContent = q.from
    el.querySelector('.rn').textContent = q.name
    el.querySelector('.rs').textContent = `${fmtBytes(q.size)}, ${plural(q.files, 'file')}`
    const left = q.state === 'left'
    el.querySelector('.p-dot').className = 'p-dot' + (left ? '' : ' p-dot--online')
    el.querySelector('.tag').hidden = !left
    const acc = el.querySelector('[data-act=accept]')
    const dec = el.querySelector('[data-act=decline]')
    acc.disabled = left
    acc.title = left ? 'Sender offline' : ''
    const primary = !left && !primaryGiven
    if (primary) primaryGiven = true
    acc.className = 'p-btn p-btn--sm ' + (primary ? 'p-btn--primary' : 'p-btn--secondary')
    dec.disabled = false
    dec.textContent = left ? 'Dismiss' : 'Decline'
  }
  for (const [k, el] of reqRows) if (!rseen.has(k)) { el.remove(); reqRows.delete(k) }
  $('sendBtn').className = 'p-btn ' + (primaryGiven ? 'p-btn--secondary' : 'p-btn--primary')
}

function tagOf (t) {
  if (t.status === 'error') return ['Error', 'bad']
  if (t.status === 'removing') return ['Removing', '']
  if (t.status === 'stopped') return ['Stopped', '']
  if (t.status === 'declined') return ['Declined', 'warn']
  if (t.status === 'waiting') return ['Waiting', '']
  if (t.status === 'left') return ['Peer left', 'warn']
  if (t.role === 'send') {
    if (t.status === 'adding') return ['Adding', 'live']
    if (t.status === 'announcing') return ['Getting link ready', '']
    return t.peers ? ['Seeding', 'live'] : ['Shared', '']
  }
  if (t.status === 'finding' || t.status === 'starting') return ['Finding', '']
  if (t.status === 'offline') return ['Sender offline', 'warn']
  if (t.status === 'receiving') return ['Receiving', 'live']
  return [t.peers ? 'Seeding' : 'Done', t.peers ? 'live' : '']
}

function build (t) {
  const el = document.createElement('div')
  el.className = 'item'
  el.innerHTML = `
    <div class="top"><span class="name"></span><span class="tag"></span><span class="size"></span></div>
    <div class="bar"><i></i></div>
    <div class="meta"></div>
    <div class="keyrow" hidden><span class="p-key"></span><button class="copy" type="button" data-act="copy">Copy</button><button class="copy" type="button" data-act="qr" aria-pressed="false">QR</button></div>
    <img class="qr" alt="QR code of the link" width="192" height="192" hidden>
    <div class="tools"><button class="copy" type="button" data-act="files" aria-pressed="false"></button><button class="copy" type="button" data-act="reveal" hidden>Show folder</button><button class="copy" type="button" data-act="stop" hidden>Stop sharing</button><button class="copy" type="button" data-act="remove" hidden>Remove</button></div>
    <div class="confirm" hidden><span>Remove <b class="cn"></b>, frees <b class="cs"></b></span><span class="dim ck" hidden>Downloads kept</span><button class="copy danger" type="button" data-act="rm-yes">Remove</button><button class="copy" type="button" data-act="rm-no">Cancel</button></div>
    <div class="files" hidden></div>`
  const q = (s) => el.querySelector(s)
  const refs = { name: q('.name'), tag: q('.tag'), size: q('.size'), bar: q('.bar'), fill: q('.bar i'), meta: q('.meta'), keyrow: q('.keyrow'), key: q('.p-key'), qr: q('.qr'), files: q('.files'), filesBtn: q('[data-act=files]'), qrBtn: q('[data-act=qr]'), reveal: q('[data-act=reveal]'), copy: q('[data-act=copy]'), stop: q('[data-act=stop]'), remove: q('[data-act=remove]'), confirm: q('.confirm'), cn: q('.cn'), cs: q('.cs'), ck: q('.ck'), rmYes: q('[data-act=rm-yes]'), fileRows: new Map() }
  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act
    const cur = items.get(t.id).t
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(cur.link) } catch { const r = document.createRange(); r.selectNodeContents(refs.key); getSelection().removeAllRanges(); getSelection().addRange(r) }
      refs.copy.textContent = 'Copied'; setTimeout(() => { refs.copy.textContent = 'Copy' }, 1500)
    }
    if (act === 'qr') { open.qr.has(t.id) ? open.qr.delete(t.id) : open.qr.add(t.id); update(cur) }
    if (act === 'files') { open.files.has(t.id) ? open.files.delete(t.id) : open.files.add(t.id); update(cur) }
    if (act === 'reveal') api('POST', '/api/reveal/' + t.id, {}).catch((er) => showErr(er.message))
    if (act === 'stop') {
      refs.stop.disabled = true
      try { await api('POST', '/api/stop/' + t.id, {}) } catch (er) { showErr(er.message) }
      refs.stop.disabled = false
      poll()
    }
    if (act === 'remove') { open.confirm.add(t.id); update(cur); refs.rmYes.focus() }
    if (act === 'rm-no') { open.confirm.delete(t.id); update(cur) }
    if (act === 'rm-yes') {
      open.confirm.delete(t.id)
      refs.rmYes.disabled = true
      try {
        const out = await api('POST', '/api/remove/' + t.id, {})
        showNote(`Removed ${out.name}, ${fmtBytes(out.freed)} freed`)
      } catch (er) { showErr(er.message) }
      refs.rmYes.disabled = false
      poll()
    }
  })
  return { el, refs, t }
}

function update (t) {
  const it = items.get(t.id)
  it.t = t
  const r = it.refs
  r.name.textContent = t.name || 'Waiting for list'
  r.name.title = t.name || ''
  const [label, cls] = tagOf(t)
  r.tag.textContent = label
  r.tag.className = 'tag ' + cls
  const total = t.totalBytes
  const sending = t.role === 'send' && t.status !== 'adding'
  r.size.textContent = sending ? fmtBytes(total) : total ? `${fmtBytes(t.bytes)} / ${fmtBytes(total)}` : ''
  const pct = total ? Math.min(100, (t.bytes / total) * 100) : 0
  r.fill.style.width = (sending ? 100 : pct) + '%'
  r.bar.classList.toggle('idle', !(cls === 'live'))
  r.bar.setAttribute('role', 'progressbar'); r.bar.setAttribute('aria-valuenow', String(Math.round(pct))); r.bar.setAttribute('aria-label', 'Progress')

  const m = []
  const active = t.status === 'receiving' || t.status === 'adding'
  if (active) m.push(`<span>${pct.toFixed(0)}%</span>`, `<span>${(t.rate / 1e6).toFixed(1)} MB/s</span>`)
  if (t.role === 'receive' && t.ttfbMs) m.push(`<span>First byte ${fmtMs(t.ttfbMs)}</span>`)
  if (t.role === 'receive' && t.totalMs) m.push(`<span>Total ${fmtMs(t.totalMs)}</span>`)
  if (t.role === 'send' && t.addMs) m.push(`<span>Added in ${fmtMs(t.addMs)}</span>`)
  if (t.role === 'send' && t.announceMs) m.push(`<span>Link ready in ${fmtMs(t.announceMs)}</span>`)
  if (t.role === 'send' && t.uploaded) m.push(`<span>Sent ${fmtBytes(t.uploaded)}</span>`)
  if (t.to) m.push(`<span>To ${esc(t.to)}</span>`)
  if (t.from) m.push(`<span>From ${esc(t.from)}</span>`)
  if (t.fileCount) m.push(`<span>${plural(t.fileCount, 'file')}</span>`)
  const quiet = ['stopped', 'declined', 'removing', 'waiting', 'left'].includes(t.status)
  const seeding = !quiet && ((t.role === 'send' && !active && t.status !== 'announcing') || t.status === 'seeding')
  if (seeding) m.push(`<span class="${t.peers ? 'on' : ''}">Seeding to ${plural(t.peers, 'peer')}</span>`)
  else if (t.role === 'receive' && t.status !== 'error' && !quiet) m.push(`<span class="${t.peers ? 'on' : ''}">${plural(t.peers, 'peer')}</span>`)
  if (t.status === 'error') m.push(`<span>${esc(t.error || 'Failed')}</span>`)
  if (t.status === 'receiving' && t.rate === 0 && t.peers === 0) m.push('<span>Peer offline</span>')
  const html = m.join('')
  if (r.meta.innerHTML !== html) r.meta.innerHTML = html

  const showKey = t.link && !t.to && !quiet && (t.role === 'receive' || (t.status !== 'adding' && t.status !== 'announcing')) && t.status !== 'error'
  r.keyrow.hidden = !showKey
  if (showKey) { r.key.textContent = shortLink(t.link); r.key.title = t.link }
  const qrOpen = showKey && open.qr.has(t.id)
  r.qrBtn.setAttribute('aria-pressed', String(qrOpen))
  if (qrOpen && !r.qr.src) r.qr.src = '/api/qr/' + t.id
  r.qr.hidden = !qrOpen

  r.filesBtn.hidden = !t.fileCount
  r.filesBtn.textContent = open.files.has(t.id) ? 'Hide files' : 'Files'
  r.filesBtn.setAttribute('aria-pressed', String(open.files.has(t.id)))
  r.reveal.hidden = !(t.role === 'receive' && t.outDir && t.bytes > 0)
  const shareable = t.role === 'send' ? ['shared', 'announcing', 'waiting', 'left'].includes(t.status) : t.status === 'seeding'
  r.stop.hidden = !shareable
  r.remove.hidden = t.status === 'removing'
  const confirming = open.confirm.has(t.id) && t.status !== 'removing'
  r.confirm.hidden = !confirming
  if (confirming) {
    r.cn.textContent = t.name || 'this transfer'
    r.cs.textContent = fmtBytes(t.role === 'send' ? t.totalBytes : t.bytes)
    r.ck.hidden = t.role !== 'receive'
  }
  r.files.hidden = !open.files.has(t.id)
  if (!r.files.hidden) {
    for (const f of t.files) {
      let row = r.fileRows.get(f.path)
      if (!row) {
        row = document.createElement('div'); row.className = 'file'
        row.innerHTML = '<div class="ft"><span></span><span></span></div><div class="bar"><i></i></div>'
        row.querySelector('.ft span').textContent = f.path
        r.files.appendChild(row); r.fileRows.set(f.path, row)
      }
      const fp = f.size ? f.bytes / f.size * 100 : 100
      row.querySelector('.ft span:last-child').textContent = `${fmtBytes(f.bytes)} / ${fmtBytes(f.size)}`
      row.querySelector('.bar i').style.width = fp + '%'
      row.querySelector('.bar').classList.toggle('idle', cls !== 'live')
    }
  }
}

let busy = false
async function poll () {
  if (busy) return
  busy = true
  try {
    const s = await api('GET', '/api/state')
    lastState = s
    renderNearby(s.nearby)
    $('device').textContent = s.version ? `${s.name} · v${s.version}` : s.name
    $('peers').textContent = plural(s.peers, 'peer')
    $('dot').className = 'p-dot' + (s.peers ? ' p-dot--online' : '')
    const box = $('items')
    s.transfers.forEach((t, i) => {
      if (!items.has(t.id)) { const it = build(t); items.set(t.id, it) }
      const it = items.get(t.id)
      if (box.children[i] !== it.el) box.insertBefore(it.el, box.children[i] || null)
      update(t)
    })
    $('empty').hidden = s.transfers.length > 0
    for (const [id, it] of items) if (!s.transfers.some((t) => t.id === id)) { it.el.remove(); items.delete(id) }
    const act = s.transfers.filter((t) => ['adding', 'announcing', 'receiving', 'finding', 'offline'].includes(t.status)).length
    $('tCount').textContent = s.transfers.length ? (act ? act + ' active' : plural(s.transfers.length, 'transfer')) : ''
  } catch {
    $('peers').textContent = 'App offline'
    $('dot').className = 'p-dot'
  } finally { busy = false }
}
poll()
setInterval(poll, 700)
// A file dropped outside the drop zone must not make the window navigate to it.
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())
document.querySelectorAll('.p-enter').forEach((el, i) => setTimeout(() => el.classList.add('is-in'), 70 * i))

// Inside the Pear app (Electron, the preload exposes window.bridge): the updater worker reports a
// staged update; Restart applies it and relaunches the app.
// A block, and not the global name `bridge`: Electron's contextBridge defines window.bridge as a
// non-configurable property, and a top-level `const bridge` makes the whole script fail to load.
{
const pb = window.bridge
if (pb && pb.startWorker) {
  const W = '/workers/main.js'
  const dec = new TextDecoder()
  const bar = $('update')
  const txt = $('updateText')
  const btn = $('updateBtn')
  pb.startWorker(W)
  const dbg = (k) => (d) => console.log('[updater ' + k + ']', dec.decode(d).trim())
  pb.onWorkerStdout(W, dbg('out'))
  pb.onWorkerStderr(W, dbg('err'))
  pb.onWorkerIPC(W, (d) => {
    const m = dec.decode(d)
    console.log('[updater ipc]', m)
    if (m === 'updating') { bar.hidden = false; btn.hidden = true; $('ubar').hidden = false; txt.textContent = 'Downloading an update' }
    if (m.startsWith('updating-progress ')) {
      try {
        const p = JSON.parse(m.slice(18))
        const pct = Math.max(0, Math.min(100, Math.round((p.progress || 0) * (p.progress > 1 ? 1 : 100))))
        bar.hidden = false; btn.hidden = true; $('ubar').hidden = false
        $('ubarFill').style.width = pct + '%'
        txt.textContent = `Downloading an update · ${pct} %` + (p.speed ? ` · ${(p.speed / 1e6).toFixed(1)} MB/s` : '')
      } catch {}
    }
    if (m === 'updated') { bar.hidden = false; btn.hidden = false; $('ubar').hidden = true; txt.textContent = 'New version ready' }
  })
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = 'Restarting'
    try {
      await pb.applyUpdate()
      await pb.appAfterUpdate()
    } catch (e) {
      txt.textContent = 'Update failed: ' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      btn.disabled = false
      btn.textContent = 'Restart'
    }
  })
}
}
