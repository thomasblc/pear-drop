// https://github.com/holepunchto/hello-pear-worker v1.2.0

const PearRuntime = require('pear-runtime') // pear-runtime on desktop; pear-mobile on mobile
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')
const path = require('bare-path')
const dir = require('bare-storage')
const { isBareKit } = require('which-runtime')

// mobile doesn't have the executable path (argv[0])
// and the worker entry path (argv[1]) in the workers argv‘s
// ... to reuse the same worker in all platforms this logic is needed
const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)]

const updaterConfig = {
  updates: argv(0) !== 'false',
  version: argv(1),
  upgrade: argv(2),
  name: argv(3),
  dir: argv(4) || dir.persistent(), // argv[4] is undefined in mobile
  app: argv(5), // argv[5] is undefined in mobile
  delay: 0 // offer a staged update right away (the runtime default is a random wait of up to 1 h)
}

const pipe = new FramedStream(Bare.IPC)
const store = new Corestore(path.join(updaterConfig.dir, 'pear-runtime', 'corestore'))
const swarm = new Hyperswarm()
const pear = new PearRuntime({ ...updaterConfig, swarm, store })

pear.updater.on('error', (err) => pipe.write('updater-error ' + err.message))

// Diagnostics: what the updater is doing, to stdout (the Electron main process prints it with an
// [updater] prefix) and to the page console.
console.log('[updater] start updates=' + updaterConfig.updates + ' version=' + updaterConfig.version + ' upgrade=' + updaterConfig.upgrade + ' app=' + updaterConfig.app + ' dir=' + updaterConfig.dir)
pear.ready().then(() => console.log('[updater] ready, drive length ' + pear.updater.drive.core.length), (err) => console.log('[updater] ready failed: ' + err.message))
swarm.on('connection', (c) => console.log('[updater] connected to ' + c.remotePublicKey.toString('hex').slice(0, 8)))

if (updaterConfig.updates !== false) {
  swarm.on('connection', (connection) => store.replicate(connection))
  const discovery = swarm.join(pear.updater.drive.core.discoveryKey, {
    client: true,
    server: false
  })
  // If the first lookup misses the seeder, Hyperswarm
  // only looks again 10 to 15 min later, so a staged update never shows. Look again every 5 s while
  // no peer is connected; once connected, new versions arrive live over that connection.
  const refresher = setInterval(() => {
    if (swarm.connections.size === 0) discovery.refresh().catch(() => {})
  }, 5000)
  goodbye(() => clearInterval(refresher))
}

// An append on the app's drive doesn't check for an update straight away: the
// updater defers it by a random delay of up to an hour (see PearRuntimeUpdater)
// so that a released fleet doesn't hit the seeder all at once. Forward the
// delay so the app can say it is waiting rather than look inert. Without it,
// a staged update is indistinguishable from a broken updater for up to an hour.
pear.updater.on('update-scheduled', (delay) => pipe.write('update-scheduled ' + delay))
pear.updater.on('updating', () => pipe.write('updating'))
// Progress of the update download for the in-app bar (mirror-drive monitor, every 250 ms).
pear.updater.on('updating-progress', (st) => {
  const d = (st && st.download) || {}
  pipe.write('updating-progress ' + JSON.stringify({ progress: d.progress || 0, bytes: d.bytes || 0, speed: d.speed || 0 }))
})
pear.updater.on('updated', () => pipe.write('updated'))
pear.on('minver-required', () => pipe.write('minver-required')) // for mobile store update notification

goodbye(async () => {
  await swarm.destroy()
  await pear.close()
  await store.close()
})

pipe.on('data', async (data) => {
  const message = data.toString()
  if (message !== 'pear:applyUpdate') {
    pipe.write('unknown-message ' + message)
    return
  }

  try {
    await pear.ready()
    await pear.updater.applyUpdate()
    pipe.write('pear:updateApplied')
  } catch (err) {
    pipe.write('pear:updateFailed ' + err.message)
  }
})

