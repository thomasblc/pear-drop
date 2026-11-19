// Pear Drop engine: send files peer to peer, with no account and no server.
// Link mode + nearby mode. The sender writes files into a Hyperdrive in its own Corestore,
// announces the drive's discovery key on Hyperswarm and replicates to whoever asks. A receiver
// opens the drive by key (the link), downloads every file to ~/Downloads/Pear Drop/<name>/ and then
// keeps seeding it. No account, no server: the link is the only thing that travels out of band.
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import crypto from 'hypercore-crypto'
import idEnc from 'hypercore-id-encoding'
import b4a from 'b4a'
import QRCode from 'qrcode'
import Protomux from 'protomux'
import c from 'compact-encoding'

// Inside a packaged Pear app the module URL is bare:/app.bundle/..., not a file: URL.
let HERE
try { HERE = path.dirname(fileURLToPath(import.meta.url)) } catch { HERE = process.cwd() }
const PORT = Number(process.env.PORT || 3130)
const DATA = path.resolve(HERE, process.env.DATA || 'data')
const NAME = process.env.NAME || 'Pear Drop'
const OUT = path.resolve(process.env.OUT || path.join(os.homedir(), 'Downloads', 'Pear Drop'))
const PUBLIC = path.join(HERE, 'public')
const LIST_FILE = path.join(DATA, 'transfers.json')
const SCHEME = 'peardrop://'
const STORE_DIR = path.join(DATA, 'store')
const NEARBY = process.env.NEARBY !== '0'
const VERSION = process.env.VERSION || ''
// Receiving: fetch the whole file in parallel (true) or block by block in order (false, slow on a
// real network: about 0.8 MB/s at 80 ms round trip). The Pear app ships with the value it was built with.
const PARALLEL_FETCH = true
const NEARBY_SALT = 'pear-drop/nearby/v1'
const noop = () => {}
const hex = (b) => b4a.toString(b, 'hex')

fs.mkdirSync(DATA, { recursive: true })
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

// macOS: mark every received file and folder as downloaded from the internet, like browsers and
// AirDrop do, so Gatekeeper checks an app or a script before it first runs. One xattr at a time.
function quarantine (target) {
  if (process.platform !== 'darwin') return Promise.resolve()
  const flags = '0081;' + Math.floor(Date.now() / 1000).toString(16) + ';Pear Drop;'
  return new Promise((resolve) => {
    try {
      const p = spawn('/usr/bin/xattr', ['-w', 'com.apple.quarantine', flags, target], { stdio: 'ignore' })
      p.on('error', () => resolve())
      p.on('exit', () => resolve())
    } catch { resolve() }
  })
}
// The file, then each folder between it and the transfer's folder (an .app bundle is a folder).
async function quarantinePath (file, root, done) {
  await quarantine(file)
  for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) {
    if (done.has(dir)) break
    done.add(dir)
    await quarantine(dir)
    if (dir === root) break
  }
}

// ---------- storage, swarm ----------
const store = new Corestore(STORE_DIR)
await store.ready()
const swarm = new Hyperswarm({ keyPair: await store.createKeyPair('pear-drop-swarm') })
swarm.on('connection', (conn, info) => {
  conn.on('error', () => {})
  store.replicate(conn)
  applyBlocks(conn)
  log('peer +', hex(info.publicKey).slice(0, 8), 'connections', swarm.connections.size)
  conn.on('close', () => log('peer -', hex(info.publicKey).slice(0, 8)))
  if (NEARBY) { openNearby(conn); helloGate(conn) }
})

// ---------- stop sharing: refuse replication of given cores ----------
// Leaving the topic is not enough: one connection carries every drive, and Corestore serves any
// core it has on disk to a connected peer that asks for it by discovery key (_attachMaybe). A
// Protomux pair on ('hypercore/alpha', discoveryKey) with a no-op handler wins over that default
// handler, so the remote's request is rejected. Hypercore unpairs its own handler when the core
// closes, so blocks are applied again after the core is gone.
const blocked = new Set() // hex discovery keys
function applyBlocks (conn) {
  if (!blocked.size || conn.destroyed) return
  const mux = Protomux.from(conn)
  for (const dk of blocked) mux.pair({ protocol: 'hypercore/alpha', id: b4a.from(dk, 'hex') }, noop)
}
// Corestore closes an unused core after a few 2 s GC cycles; wait for that (max 20 s). A core with
// a replication channel still open is never idle, so it never closes: returns false then.
async function waitClosed (dks) {
  const end = Date.now() + 20000
  while (dks.some((dk) => store.cores.get(dk)) && Date.now() < end) await new Promise((res) => setTimeout(res, 250))
  return !dks.some((dk) => store.cores.get(dk))
}
async function dirSize (dir) {
  let n = 0
  const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const e of entries) if (e.isFile()) n += (await fsp.stat(path.join(e.parentPath || e.path, e.name)).catch(() => ({ size: 0 }))).size
  return n
}

// ---------- transfers (persisted list + live runtime state) ----------
/** @type {Array<any>} persisted records */
let records = []
try { records = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')) } catch {}
const live = new Map() // id -> { drive, status, bytes, files: Map(path -> bytes), up, rate, samples, netBytes, error }
let saving = Promise.resolve()
function persist () {
  const body = JSON.stringify(records, null, 2)
  saving = saving.then(async () => {
    const tmp = LIST_FILE + '.tmp'
    await fsp.writeFile(tmp, body)
    await fsp.rename(tmp, LIST_FILE)
  }).catch((e) => log('persist failed', e.message))
  return saving
}
const rec = (id) => records.find((r) => r.id === id)
const newId = () => b4a.toString(crypto.randomBytes(6), 'hex')
const linkOf = (keyBuf) => SCHEME + idEnc.encode(keyBuf)

function parseLink (s) {
  const raw = String(s || '').trim().replace(/^peardrop:\/\//i, '').replace(/^pear:\/\//i, '').replace(/[/?#].*$/, '')
  if (!/^([0-9a-f]{64}|[a-z0-9]{52})$/i.test(raw)) return null
  try { return idEnc.decode(raw.length === 64 ? raw.toLowerCase() : raw) } catch { return null }
}

// Names and paths coming from a peer are data: no "..", no absolute paths, no control characters.
function safeName (s, fallback) {
  const n = String(s || '').replace(/[\u0000-\u001f/\\:]/g, ' ').replace(/^[.\s]+/, '').trim().slice(0, 100)
  return n || fallback
}
function safeRel (p) {
  const parts = String(p).split('/').filter(Boolean)
  if (!parts.length || parts.some((x) => x === '..' || x === '.' || /[\u0000-\u001f\\]/.test(x))) return null
  return parts
}

function track (id) {
  let t = live.get(id)
  if (!t) {
    t = { drive: null, status: 'starting', bytes: 0, files: new Map(), up: 0, rate: 0, samples: [], netBytes: 0, error: null }
    live.set(id, t)
  }
  return t
}

// Rate: bytes moved over the last ~3 s, sampled every 500 ms.
setInterval(() => {
  const now = Date.now()
  for (const [id, t] of live) {
    const r = rec(id); if (!r) continue
    const moved = r.role === 'send' ? t.up : t.bytes
    t.samples.push([now, moved])
    while (t.samples.length > 1 && now - t.samples[0][0] > 3000) t.samples.shift()
    const [t0, b0] = t.samples[0]
    t.rate = now > t0 ? Math.max(0, (moved - b0) / ((now - t0) / 1000)) : 0
  }
}, 500).unref()

function peersOf (t) {
  if (!t.drive) return 0
  const a = t.drive.core.peers.length
  const b = t.drive.blobs ? t.drive.blobs.core.peers.length : 0
  return Math.max(a, b)
}

// Server + client: a receiver that finished keeps serving, so a third peer can pull from both.
// Returns the PeerDiscovery; await its flushed() before handing out a link, or the first
// receiver can look the topic up before it is announced.
function announce (drive) {
  return swarm.join(drive.discoveryKey, { server: true, client: true })
}

async function watchUploads (id, drive) {
  const blobs = await drive.getBlobs()
  const t = track(id)
  const r = rec(id)
  if (r && blobs && !r.dks) { r.dks = [hex(drive.discoveryKey), hex(blobs.core.discoveryKey)]; persist() }
  blobs.core.on('upload', (index, byteLength) => { t.up += byteLength })
  blobs.core.on('download', (index, byteLength) => { t.netBytes += byteLength })
}

// ---------- send ----------
async function walk (abs) {
  const st = await fsp.stat(abs)
  if (st.isFile()) return { name: path.basename(abs), files: [{ abs, rel: path.basename(abs), size: st.size }] }
  if (!st.isDirectory()) throw new Error('Not a file or folder')
  const files = []
  const entries = await fsp.readdir(abs, { recursive: true, withFileTypes: true })
  for (const e of entries) {
    if (!e.isFile() || e.name === '.DS_Store') continue // symlinks and sockets are skipped
    const full = path.join(e.parentPath || e.path, e.name)
    files.push({ abs: full, rel: path.relative(abs, full).split(path.sep).join('/'), size: (await fsp.stat(full)).size })
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return { name: path.basename(abs), files }
}

// `to`: hex device key of a nearby device (nearby mode), or null for a link.
function nearbyTarget (to) {
  if (!to) return null
  const d = nb.devices.get(String(to))
  if (!d || !d.online) throw new Error('Device offline')
  return { key: d.key, name: d.name }
}

async function createSend (name, files, to = null) {
  const id = newId()
  const r = {
    id, role: 'send', name, ns: 'send-' + id, key: null, createdAt: Date.now(),
    files: files.map((f) => ({ path: f.rel, size: f.size })),
    totalBytes: files.reduce((s, f) => s + f.size, 0), fileCount: files.length, done: false
  }
  if (to) { r.to = to; r.offerId = newId(); r.offer = 'adding' }
  const drive = new Hyperdrive(store.namespace(r.ns))
  await drive.ready()
  r.key = idEnc.encode(drive.key)
  records.unshift(r)
  const t = track(id)
  t.drive = drive
  t.status = 'adding'
  await persist()
  return { r, t, drive }
}

// Streams one file into the drive, never holding it in memory.
async function addStream (r, t, drive, rel, source) {
  const parts = safeRel(rel)
  if (!parts) throw new Error('Bad path')
  const count = new Transform({
    transform (chunk, enc, cb) { t.bytes += chunk.length; t.files.set(rel, (t.files.get(rel) || 0) + chunk.length); cb(null, chunk) }
  })
  await pipeline(source, count, drive.createWriteStream('/' + parts.join('/'), { metadata: { drop: r.name } }))
}

async function finishSend (r, t, drive) {
  r.addedAt = Date.now()
  r.addMs = r.addedAt - r.createdAt
  await watchUploads(r.id, drive)
  if (r.to) {
    // Nearby: the device is already connected, so the offer goes out now and replication rides the
    // existing connection. The announce still runs (in the background) in case it reconnects.
    r.offer = 'waiting'
    r.done = true
    r.readyAt = Date.now()
    t.status = 'shared'
    await persist()
    sendOffer(r)
    announce(drive)
    log('offered', r.name, 'to', r.to.name)
    return
  }
  // The link only shows once the announce has landed on the DHT: a receiver that looks up the topic
  // earlier finds nobody, and Hyperswarm only looks again 10 to 12 min later.
  t.status = 'announcing'
  await announce(drive).flushed()
  r.done = true
  r.readyAt = Date.now()
  r.announceMs = r.readyAt - r.addedAt
  t.status = 'shared'
  await persist()
  log('shared', r.name, r.fileCount, 'files', r.totalBytes, 'bytes in', r.addMs, 'ms', linkOf(drive.key))
}

async function sendPath (p, to) {
  const abs = path.resolve(String(p || '').replace(/^~(?=\/|$)/, os.homedir()))
  const target = nearbyTarget(to)
  const { name, files } = await walk(abs)
  if (!files.length) throw new Error('Empty folder')
  const { r, t, drive } = await createSend(name, files, target)
  ;(async () => {
    for (const f of files) await addStream(r, t, drive, f.rel, fs.createReadStream(f.abs))
    await finishSend(r, t, drive)
  })().catch((e) => { if (t.stopped) return; t.status = 'error'; t.error = 'Read failed'; r.error = e.message; persist(); log('send failed', e) })
  return r
}

// ---------- stop sharing, remove ----------
async function dksOf (r, t) {
  if (r.dks) return r.dks
  const main = hex(crypto.discoveryKey(idEnc.decode(r.key)))
  if (!t.drive) return [main]
  // getBlobs waits for the network when the header never arrived: do not hang on it.
  const blobs = await Promise.race([t.drive.getBlobs().catch(() => null), new Promise((res) => setTimeout(res, 1500, null))])
  return blobs ? [main, hex(blobs.core.discoveryKey)] : [main]
}

function closeChannels (drive) {
  if (!drive || !drive.opened) return
  for (const core of [drive.core, drive.blobs && drive.blobs.core]) {
    if (!core) continue
    for (const p of [...core.peers]) p.channel.close() // Hypercore Peer, internal field
  }
}

async function stopSharing (r) {
  const t = track(r.id)
  if (r.stopped) return
  r.stopped = true
  t.stopped = true // ends a receive loop
  if (r.to && (r.offer === 'waiting' || r.offer === 'adding')) { sendNearby(r.to.key, { t: 'cancel', id: r.offerId }); r.offer = 'cancelled' }
  const dks = await dksOf(r, t)
  for (const dk of dks) blocked.add(dk)
  await swarm.leave(b4a.from(dks[0], 'hex')).catch(noop)
  closeChannels(t.drive)
  for (const conn of swarm.connections) applyBlocks(conn)
  const d = t.drive
  t.drive = null
  if (d) await d.close().catch(noop)
  t.status = 'stopped'
  await persist()
  waitClosed(dks).then(() => { for (const conn of swarm.connections) applyBlocks(conn) })
  log('stopped sharing', r.name)
}

// Deletes the drive's cores from the Corestore. Hypercore 11.37's purge() is broken
// (_closeAllSessions is not a function), and storage.deleteCore() alone leaves the blocks of the
// default session behind, so: clear every block (public clear API), close, wait for Corestore to
// drop the cores, delete their entries, then a full compaction with blob GC to give the disk back.
async function removeTransfer (r) {
  const t = track(r.id)
  t.status = 'removing'
  const before = await dirSize(STORE_DIR)
  const t0 = Date.now()
  if (!r.stopped) await stopSharing(r)
  t.status = 'removing'
  const dks = await dksOf(r, t)
  if (await store.storage.hasCore(b4a.from(dks[0], 'hex'))) {
    // Inactive session: an active one would attach the cores to every open connection again, and a
    // peer that holds the drive (a seeding receiver) would keep them open forever.
    const drive = r.role === 'send'
      ? new Hyperdrive(store.namespace(r.ns, { active: false }), { active: false })
      : new Hyperdrive(store.session({ active: false }), idEnc.decode(r.key), { active: false })
    await drive.ready()
    closeChannels(drive)
    const blobs = await Promise.race([drive.getBlobs().catch(() => null), new Promise((res) => setTimeout(res, 1500, null))])
    if (blobs) {
      const b = hex(blobs.core.discoveryKey)
      if (!dks.includes(b)) dks.push(b)
      await blobs.core.clear(0, blobs.core.length)
    }
    await drive.core.clear(0, drive.core.length)
    await drive.close()
  }
  for (const dk of dks) blocked.add(dk)
  for (const conn of swarm.connections) applyBlocks(conn)
  // Only delete the entries of cores Corestore has really closed; the blocks are gone either way.
  if (await waitClosed(dks)) {
    for (const dk of dks) {
      const s = await store.storage.resumeCore(b4a.from(dk, 'hex'))
      if (s) { await store.storage.deleteCore(s.core); await s.close() }
    }
  } else log('cores still open, entries kept', r.name)
  await store.storage.compact({ bottommostLevelCompaction: 2, blobGarbageCollectionPolicy: 1, blobGarbageCollectionAgeCutoff: 1 })
  for (const conn of swarm.connections) applyBlocks(conn)
  records = records.filter((x) => x !== r)
  live.delete(r.id)
  await persist()
  const freed = Math.max(0, before - await dirSize(STORE_DIR))
  log('removed', r.name, 'freed', freed, 'bytes in', Date.now() - t0, 'ms')
  return { freed, ms: Date.now() - t0, name: r.name }
}

// ---------- receive ----------
async function uniqueDir (base) {
  for (let i = 1; ; i++) {
    const p = i === 1 ? base : `${base} ${i}`
    try { await fsp.access(p) } catch { return p }
  }
}

async function receive (id) {
  const r = rec(id)
  const t = track(id)
  const key = idEnc.decode(r.key)
  const drive = t.drive || new Hyperdrive(store.session(), key)
  t.drive = drive
  await drive.ready()
  const disc = announce(drive)
  const runStart = Date.now()
  r.startedAt ||= runStart

  // 1. Wait for the file list: a sender that is offline is a state, not an error.
  t.status = 'finding'
  const finding = drive.findingPeers()
  swarm.flush().then(finding, finding)
  // An empty drive after update() means "no sender found yet", never "empty transfer".
  let lastLookup = Date.now()
  while (drive.core.length < 2) { // block 0 is the header, files start at 1
    if (t.stopped) return
    if (Date.now() - runStart > 6000 && peersOf(t) === 0) t.status = 'offline'
    await drive.update({ wait: true }).catch(() => {})
    if (drive.core.length >= 2) break
    // Hyperswarm alone would look the topic up again only after 10 to 12 min: ask every 5 s.
    if (peersOf(t) === 0 && Date.now() - lastLookup > 5000) {
      lastLookup = Date.now()
      await disc.refresh({ client: true, server: true }).catch(() => {})
    }
    await new Promise((res) => setTimeout(res, 1000))
  }

  // 2. List entries with sizes.
  t.status = 'receiving'
  if (!r.files) {
    const files = []
    let dropName = null
    for await (const e of drive.list('/', { recursive: true })) {
      if (!e.value.blob) continue
      if (!safeRel(e.key)) continue
      files.push({ path: e.key.slice(1), size: e.value.blob.byteLength })
      dropName ||= e.value.metadata && e.value.metadata.drop
    }
    r.name = safeName(dropName, 'drop-' + r.key.slice(0, 8))
    r.files = files
    r.fileCount = files.length
    r.totalBytes = files.reduce((s, f) => s + f.size, 0)
    r.outDir = await uniqueDir(path.join(OUT, r.name))
    r.listMs = Date.now() - r.startedAt
    await persist()
  }
  await watchUploads(id, drive)
  await fsp.mkdir(r.outDir, { recursive: true })
  const quarantined = new Set()

  // 3. Download every file by streaming drive -> disk. A .part file is a valid prefix, so a restart
  // appends to it; blocks fetched beyond it are already in the Corestore and are read locally.
  t.bytes = 0
  const resumed = r.files.some((f) => f.done) || r.runs > 0
  r.runs = (r.runs || 0) + 1
  let localAtStart = 0
  for (const f of r.files) {
    const parts = safeRel(f.path)
    const dest = path.join(r.outDir, ...parts)
    if (!dest.startsWith(r.outDir + path.sep)) throw new Error('Bad path')
    if (f.done) { t.bytes += f.size; t.files.set(f.path, f.size); continue }
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    const part = dest + '.part'
    let have = 0
    try { have = (await fsp.stat(part)).size } catch {}
    if (have > f.size) { await fsp.truncate(part, 0); have = 0 }
    localAtStart += have
    t.bytes += have
    t.files.set(f.path, have)
    if (have < f.size) {
      const count = new Transform({
        transform (chunk, enc, cb) {
          if (!r.ttfbMs) { r.ttfbMs = Date.now() - r.startedAt; persist() }
          t.bytes += chunk.length
          t.files.set(f.path, (t.files.get(f.path) || 0) + chunk.length)
          cb(null, chunk)
        }
      })
      // The read stream fetches blocks in order (a linear range), which keeps only one or two 64 KB
      // blocks in flight: about 0.8 MB/s at 80 ms round trip, measured Mac to Mac over Wi-Fi.
      // A parallel range over the whole file lets Hypercore keep up to 512 requests in flight.
      let range = null
      try {
        const entry = await drive.entry('/' + f.path)
        const blobs = await drive.getBlobs()
        const b = entry && entry.value && entry.value.blob
        if (PARALLEL_FETCH && b && blobs) range = blobs.core.download({ start: b.blockOffset, end: b.blockOffset + b.blockLength })
      } catch (e) { log('parallel range skipped', e.message) }
      try {
        await pipeline(drive.createReadStream('/' + f.path, have ? { start: have } : {}), count, fs.createWriteStream(part, { flags: have ? 'a' : 'w' }))
      } finally { if (range) range.destroy() }
    }
    if (f.size === 0) await fsp.writeFile(part, '')
    await fsp.rename(part, dest)
    await quarantinePath(dest, r.outDir, quarantined)
    f.done = true
    await persist()
  }
  r.done = true
  r.doneAt = Date.now()
  r.totalMs ||= r.doneAt - r.startedAt
  r.lastRun = { ms: r.doneAt - runStart, netBytes: t.netBytes, filePrefixBytes: localAtStart, resumed }
  t.status = 'seeding'
  await persist()
  log('received', r.name, r.totalBytes, 'bytes', 'ttfb', r.ttfbMs, 'ms total', r.totalMs, 'ms this run', r.lastRun)
}

async function startReceive (link, from = null) {
  const key = parseLink(link)
  if (!key) throw new Error('Invalid link')
  const keyZ = idEnc.encode(key)
  const existing = records.find((r) => r.key === keyZ)
  if (existing) return existing
  const r = { id: newId(), role: 'receive', key: keyZ, name: null, createdAt: Date.now(), done: false }
  if (from) r.from = from
  records.unshift(r)
  await persist()
  runReceive(r.id)
  return r
}

function runReceive (id) {
  receive(id).catch((e) => {
    const t = track(id)
    if (t.stopped) return
    t.status = 'error'; t.error = 'Download failed'; log('receive failed', e)
  })
}

// ---------- restore after a restart ----------
for (const r of records) {
  const t = track(r.id)
  if (r.stopped) {
    t.status = 'stopped'
    for (const dk of r.dks || [hex(crypto.discoveryKey(idEnc.decode(r.key)))]) blocked.add(dk)
    if (r.role === 'receive' && r.files) { for (const f of r.files) t.files.set(f.path, f.done ? f.size : 0); t.bytes = r.files.reduce((s, f) => s + (f.done ? f.size : 0), 0) }
    continue
  }
  if (r.role === 'send') {
    if (!r.done && !r.addedAt) { t.status = 'error'; t.error = 'Interrupted'; continue }
    r.done = true
    const drive = new Hyperdrive(store.namespace(r.ns))
    t.drive = drive
    t.status = 'announcing'
    drive.ready().then(() => watchUploads(r.id, drive)).then(() => announce(drive).flushed()).then(() => { t.status = 'shared' }).catch((e) => { t.status = 'error'; t.error = 'Storage'; log(e) })
  } else if (r.done) {
    const drive = new Hyperdrive(store.session(), idEnc.decode(r.key))
    t.drive = drive
    t.status = 'seeding'
    for (const f of r.files) t.files.set(f.path, f.size)
    t.bytes = r.totalBytes
    drive.ready().then(() => watchUploads(r.id, drive)).then(() => announce(drive)).catch((e) => { t.status = 'error'; t.error = 'Storage'; log(e) })
  } else {
    log('resuming', r.name || r.key.slice(0, 8))
    runReceive(r.id)
  }
}

// ---------- nearby mode ----------
// Every instance joins a topic derived from the public IP the DHT sees for it plus a fixed salt, so
// only devices behind the same public IP meet. On every connection both sides open a small
// Protomux channel whose handshake is a hello: { name, proof }, proof = hash(topic, Noise
// handshake hash, sender's public key). Only a peer that knows the same topic (same IP) can make
// it, it is bound to this session (no replay) and to its sender (no echo). No valid hello = not
// listed, offers ignored, and a connection with no hello and no replication is closed (helloGate).
const nb = { ip: null, topic: null, devices: new Map(), requests: new Map(), conns: new Map() }

function checkNearbyIp () {
  const ip = swarm.dht.host
  if (!ip || ip === nb.ip) return
  if (nb.topic) swarm.leave(nb.topic).catch(noop)
  nb.ip = ip
  nb.topic = crypto.hash(b4a.from(NEARBY_SALT + ' ' + ip))
  const t0 = Date.now()
  swarm.join(nb.topic, { server: true, client: true }).flushed().then(() => log('nearby announced in', Date.now() - t0, 'ms'), noop)
  log('nearby topic', hex(nb.topic).slice(0, 8))
  for (const conn of swarm.connections) openNearby(conn)
}
if (NEARBY) setInterval(checkNearbyIp, 1000).unref()

function openNearby (conn) {
  if (!nb.topic || conn.destroyed) return
  const prev = nb.conns.get(conn)
  if (prev && prev.topic === nb.topic) return
  if (prev) prev.ch.close()
  const mux = Protomux.from(conn)
  const st = { conn, ch: null, msg: null, peer: hex(conn.remotePublicKey), ok: false, topic: nb.topic }
  const ch = mux.createChannel({
    protocol: 'pear-drop/nearby',
    handshake: c.json,
    messages: [{ encoding: c.json, onmessage: (m) => onNearbyMessage(st, m) }],
    onopen: (hs) => onHello(st, hs),
    onclose: () => onNearbyClose(st)
  })
  if (!ch) return
  st.ch = ch
  st.msg = ch.messages[0]
  nb.conns.set(conn, st)
  ch.open({ v: 1, name: NAME, proof: hex(crypto.hash([st.topic, conn.handshakeHash, conn.publicKey])) })
}

// Firewall for the nearby topic: Hyperswarm cannot tell which topic an incoming connection came
// from, so after 15 s a connection that neither said a valid hello nor replicates a drive is closed.
function helloGate (conn) {
  const check = () => {
    if (conn.destroyed) return
    if (!nb.topic) return setTimeout(check, 5000).unref()
    const st = nb.conns.get(conn)
    if (st && st.ok) return
    for (const s of Protomux.from(conn)) if (s.protocol === 'hypercore/alpha' && s.opened) return
    log('closing peer without hello', hex(conn.remotePublicKey).slice(0, 8))
    conn.destroy()
  }
  setTimeout(check, 15000).unref()
}

function onHello (st, hs) {
  const want = hex(crypto.hash([st.topic, st.conn.handshakeHash, st.conn.remotePublicKey]))
  if (!hs || hs.proof !== want) { log('hello refused', st.peer.slice(0, 8)); st.ch.close(); return }
  st.ok = true
  const d = nb.devices.get(st.peer) || { key: st.peer }
  d.name = safeName(hs.name, 'Device').slice(0, 40)
  d.online = true
  d.st = st
  d.leftAt = null
  nb.devices.set(st.peer, d)
  log('nearby +', d.name)
  for (const q of nb.requests.values()) if (q.from === st.peer && q.state === 'left') q.state = 'pending'
  for (const r of records) if (r.to && r.to.key === st.peer && r.offer === 'waiting' && !r.stopped) sendOffer(r)
}

function onNearbyClose (st) {
  if (nb.conns.get(st.conn) === st) nb.conns.delete(st.conn)
  const d = nb.devices.get(st.peer)
  if (!st.ok || !d || d.st !== st) return
  d.online = false
  d.leftAt = Date.now()
  for (const q of nb.requests.values()) if (q.from === st.peer && q.state === 'pending') q.state = 'left'
  log('nearby -', d.name)
}

function sendNearby (peer, m) {
  const d = nb.devices.get(peer)
  if (!d || !d.online) return false
  d.st.msg.send(m)
  return true
}

function sendOffer (r) {
  return sendNearby(r.to.key, { t: 'offer', id: r.offerId, name: r.name, size: r.totalBytes, files: r.fileCount, link: SCHEME + r.key })
}

function onNearbyMessage (st, m) {
  if (!st.ok || !m || typeof m !== 'object' || typeof m.id !== 'string' || !/^[0-9a-f]{12}$/.test(m.id)) return
  const d = nb.devices.get(st.peer)
  const qid = st.peer.slice(0, 16) + m.id
  if (m.t === 'offer') {
    const key = parseLink(m.link)
    if (!key || nb.requests.has(qid)) return
    if (records.some((r) => r.key === idEnc.encode(key))) return // already have it
    const mine = [...nb.requests.values()].filter((q) => q.from === st.peer).length
    if (mine >= 3 || nb.requests.size >= 20) return // a nearby device cannot flood the screen
    nb.requests.set(qid, {
      id: qid, offerId: m.id, from: st.peer, fromName: d.name, state: 'pending', at: Date.now(),
      name: safeName(m.name, 'Files'), size: Math.max(0, Number(m.size) || 0), files: Math.max(0, Math.floor(Number(m.files) || 0)), link: SCHEME + idEnc.encode(key)
    })
    log('request from', d.name, m.name, m.size)
  } else if (m.t === 'cancel') {
    nb.requests.delete(qid)
  } else if (m.t === 'reply') {
    const r = records.find((x) => x.to && x.to.key === st.peer && x.offerId === m.id)
    if (!r || r.offer !== 'waiting') return
    r.offer = m.ok ? 'accepted' : 'declined'
    r.repliedMs = Date.now() - (r.readyAt || r.createdAt)
    log('offer', r.offer, r.name, 'by', d.name, 'after', r.repliedMs, 'ms')
    if (!m.ok) stopSharing(r).catch((e) => log('stop failed', e))
    else persist()
  }
}

async function answerRequest (qid, ok) {
  const q = nb.requests.get(qid)
  if (!q) throw new Error('Request gone')
  if (ok) {
    const d = nb.devices.get(q.from)
    if (!d || !d.online) throw new Error('Sender offline')
    const r = await startReceive(q.link, q.fromName)
    sendNearby(q.from, { t: 'reply', id: q.offerId, ok: true })
    nb.requests.delete(qid)
    return view(r)
  }
  sendNearby(q.from, { t: 'reply', id: q.offerId, ok: false })
  nb.requests.delete(qid)
  return { ok: true }
}

function nearbyView () {
  const now = Date.now()
  for (const [k, d] of nb.devices) if (!d.online && now - d.leftAt > 120000) nb.devices.delete(k)
  return {
    on: NEARBY, ready: !!nb.topic,
    devices: [...nb.devices.values()].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name)).map((d) => ({ key: d.key, name: d.name, online: d.online })),
    requests: [...nb.requests.values()].map((q) => ({ id: q.id, from: q.fromName, name: q.name, size: q.size, files: q.files, state: q.state }))
  }
}

function statusOf (r, t) {
  if (t.status === 'removing') return 'removing'
  if (r.stopped) return r.offer === 'declined' ? 'declined' : 'stopped'
  if (r.role === 'send' && r.to && r.offer === 'waiting' && t.status === 'shared') {
    const d = nb.devices.get(r.to.key)
    return d && d.online ? 'waiting' : 'left'
  }
  return t.status
}

// ---------- HTTP ----------
function view (r) {
  const t = track(r.id)
  return {
    id: r.id, role: r.role, name: r.name, link: r.key ? SCHEME + r.key : null,
    status: statusOf(r, t), error: t.error, to: r.to ? r.to.name : null, from: r.from || null, offer: r.offer || null, totalBytes: r.totalBytes || 0, fileCount: r.fileCount || 0,
    bytes: r.role === 'send' && t.status !== 'adding' ? r.totalBytes : t.bytes, announceMs: r.announceMs || null,
    uploaded: t.up, rate: Math.round(t.rate), peers: peersOf(t),
    ttfbMs: r.ttfbMs || null, totalMs: r.totalMs || null, addMs: r.addMs || null,
    createdAt: r.createdAt, outDir: r.outDir || null, lastRun: r.lastRun || null,
    files: (r.files || []).map((f) => ({ path: f.path, size: f.size, bytes: r.role === 'send' && t.status !== 'adding' ? f.size : (t.files.get(f.path) || 0) }))
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' }
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])

function json (res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function readJson (req) {
  let s = ''
  for await (const c of req) { s += c; if (s.length > 1e5) throw new Error('Too big') }
  return JSON.parse(s || '{}')
}

const server = http.createServer(async (req, res) => {
  // DNS-rebinding and cross-site guard: this server reads paths on disk, so only this page may talk to it.
  if (!ALLOWED_HOSTS.has(req.headers.host)) return json(res, 403, { error: 'Forbidden' })
  const origin = req.headers.origin
  if (req.method !== 'GET' && origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'Forbidden' })
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  try {
    if (req.method === 'GET' && p === '/api/state') {
      return json(res, 200, { name: NAME, version: VERSION, peers: swarm.connections.size, out: OUT, nearby: nearbyView(), transfers: records.map(view) })
    }
    // Network diagnosis: one row per live connection (UDX stream stats), local only.
    if (req.method === 'GET' && p === '/api/debug') {
      const rows = [...swarm.connections].map((c) => {
        const s = c.rawStream || {}
        const g = (k) => { try { return s[k] } catch { return null } }
        return { peer: hex(c.remotePublicKey).slice(0, 8), host: g('remoteHost'), port: g('remotePort'), relayed: !!(c.relay || c._relay || g('relayed')), mtu: g('mtu'), rttMs: g('rtt'), cwnd: g('cwnd'), inflight: g('inflight'), retransmits: g('retransmits'), txBytes: g('bytesTransmitted'), rxBytes: g('bytesReceived'), txPackets: g('packetsTransmitted'), rxPackets: g('packetsReceived') }
      })
      return json(res, 200, { dht: { host: swarm.dht.host, port: swarm.dht.port, firewalled: swarm.dht.firewalled, randomized: swarm.dht.randomized }, connections: rows })
    }
    if (req.method === 'GET' && p.startsWith('/api/qr/')) {
      const r = rec(p.slice(8))
      if (!r || !r.key) return json(res, 404, { error: 'Not found' })
      const svg = await QRCode.toString(SCHEME + r.key, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#050A06FF', light: '#FFFFFFFF' } })
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' })
      return res.end(svg)
    }
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/') && p !== '/api/upload') {
      return json(res, 415, { error: 'Unsupported' })
    }
    if (req.method === 'POST' && p === '/api/send') {
      const body = await readJson(req)
      if (body.path) {
        try { return json(res, 200, view(await sendPath(body.path, body.to))) } catch (e) {
          return json(res, 400, { error: e.code === 'ENOENT' ? 'Path not found' : e.code === 'EACCES' ? 'No access' : e.message })
        }
      }
      // Browser upload (drag and drop or file picker): the list first, then one PUT per file.
      const files = (body.files || []).filter((f) => safeRel(f.path)).map((f) => ({ rel: safeRel(f.path).join('/'), size: Number(f.size) || 0 }))
      if (!files.length) return json(res, 400, { error: 'No files' })
      let target
      try { target = nearbyTarget(body.to) } catch (e) { return json(res, 400, { error: e.message }) }
      const { r } = await createSend(safeName(body.name, 'Files'), files, target)
      return json(res, 200, view(r))
    }
    if (req.method === 'PUT' && p === '/api/upload') {
      const r = rec(url.searchParams.get('id'))
      const t = r && live.get(r.id)
      if (!r || r.role !== 'send' || r.done || !t || t.status !== 'adding') return json(res, 404, { error: 'Not found' })
      const rel = url.searchParams.get('path')
      if (!r.files.some((f) => f.path === rel)) return json(res, 400, { error: 'Unknown file' })
      await addStream(r, t, t.drive, rel, req)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && p.startsWith('/api/finish/')) {
      const r = rec(p.slice(12))
      const t = r && live.get(r.id)
      if (!r || r.role !== 'send' || !t || t.status !== 'adding') return json(res, 404, { error: 'Not found' })
      await finishSend(r, t, t.drive)
      return json(res, 200, view(r))
    }
    if (req.method === 'POST' && p === '/api/receive') {
      const body = await readJson(req)
      try { return json(res, 200, view(await startReceive(body.link))) } catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (req.method === 'POST' && p.startsWith('/api/stop/')) {
      const r = rec(p.slice(10))
      if (!r || !r.key) return json(res, 404, { error: 'Not found' })
      await stopSharing(r)
      return json(res, 200, view(r))
    }
    if (req.method === 'POST' && p.startsWith('/api/remove/')) {
      const r = rec(p.slice(12))
      if (!r || !r.key) return json(res, 404, { error: 'Not found' })
      if (track(r.id).status === 'removing') return json(res, 409, { error: 'Removing' })
      return json(res, 200, await removeTransfer(r))
    }
    if (req.method === 'POST' && (p.startsWith('/api/nearby/accept/') || p.startsWith('/api/nearby/decline/'))) {
      const ok = p.startsWith('/api/nearby/accept/')
      try { return json(res, 200, await answerRequest(p.slice(ok ? 19 : 20), ok)) } catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (req.method === 'POST' && p.startsWith('/api/reveal/')) {
      const r = rec(p.slice(12))
      if (!r || !r.outDir) return json(res, 404, { error: 'Not found' })
      spawn('open', [r.outDir], { stdio: 'ignore', detached: true }).unref()
      return json(res, 200, { ok: true })
    }
    if (req.method === 'GET') {
      const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1))
      const file = path.join(PUBLIC, rel)
      if (!file.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: 'Not found' })
      const mem = globalThis.PEAR_DROP_ASSETS && globalThis.PEAR_DROP_ASSETS[rel]
      const data = mem || await fsp.readFile(file).catch(() => null)
      if (!data) return json(res, 404, { error: 'Not found' })
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' })
      return res.end(data)
    }
    json(res, 404, { error: 'Not found' })
  } catch (e) {
    log('http error', e)
    json(res, 500, { error: 'Failed' })
  }
})
server.listen(PORT, '127.0.0.1', () => log(`Pear Drop "${NAME}" on http://127.0.0.1:${PORT} data ${DATA} out ${OUT}`))

// ---------- shutdown ----------
let closing = false
async function shutdown (sig) {
  if (closing) return
  closing = true
  log(sig, 'closing')
  for (const t of live.values()) t.stopped = true
  server.close()
  const timer = setTimeout(() => process.exit(1), 5000)
  try {
    await swarm.destroy()
    for (const t of live.values()) if (t.drive) await t.drive.close().catch(() => {})
    await store.close()
    await saving
  } catch (e) { log('close error', e.message) }
  clearTimeout(timer)
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
