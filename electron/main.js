const { app, BrowserWindow, ipcMain } = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const PearRuntime = require('pear-runtime')
const FramedStream = require('framed-stream')

const { isMac, isLinux, isWindows } = require('which-runtime')
const { command, flag } = require('paparam')
const pkg = require('../package.json')
const { name, productName, version, upgrade } = pkg

const protocol = name
const mainWorkerSpecifier = '/workers/main.js'

const workers = new Map()

const appName = productName ?? name

const cmd = command(
  appName,
  flag('--storage <dir>', 'pass custom storage to pear-runtime'),
  flag('--no-updates', 'start without OTA updates'),
  flag('--port <port>', 'local port of the Pear Drop engine (default 3140)'),
  flag('--name <name>', 'device name shown to other devices'),
  flag('--no-sandbox', 'start without Chromium sandbox').hide()
)

cmd.parse(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2))

const pearStore = cmd.flags.storage
const updates = cmd.flags.updates
const pdPort = String(cmd.flags.port || 3140)

if (pearStore) app.setPath('userData', pearStore)

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg
})

function getAppPath() {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  if (isWindows) return process.execPath
  return path.join(process.resourcesPath, '..', '..')
}

function sendToAll(name, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(name, data)
  }
}

function shouldUpdate() {
  if (!updates) return false

  if (isWindows) {
    const isMsix = process.windowsStore ?? false
    if (isMsix) {
      return app.isPackaged
    }
    return false
  }

  if (isMac) {
    if (process.mas) {
      return false
    }
    return app.isPackaged
  }

  // TODO: Linux Snap and Flatpak should not update.
  return app.isPackaged
}

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)
  const appPath = getAppPath()
  const dir = storageDir()
  const extension = isLinux ? '.AppImage' : isMac ? '.app' : '.msix'

  const worker = PearRuntime.run(require.resolve('..' + specifier), [
    shouldUpdate(),
    version,
    upgrade,
    productName + extension,
    dir,
    appPath
  ])
  return wireWorker(specifier, worker)
}

function storageDir() {
  const appPath = getAppPath()
  let dir = null
  if (pearStore) {
    console.log('pear store: ' + pearStore)
    dir = pearStore
  } else if (appPath === null) {
    dir = path.join(os.tmpdir(), 'pear', appName)
  } else {
    const isSnap = !!process.env.SNAP_USER_COMMON
    const linuxConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    dir = isMac
      ? path.join(os.homedir(), 'Library', 'Application Support', appName)
      : isLinux
        ? isSnap
          ? path.join(process.env.SNAP_USER_COMMON, appName)
          : path.join(linuxConfigHome, appName)
        : path.join(os.homedir(), 'AppData', 'Local', appName)
  }
  return dir
}

function wireWorker(specifier, worker) {
  const pipe = new FramedStream(worker)

  function sendWorkerStdout(data) {
    sendToAll('pear:worker:stdout:' + specifier, data)
  }
  function sendWorkerStderr(data) {
    sendToAll('pear:worker:stderr:' + specifier, data)
  }
  function sendWorkerIPC(data) {
    sendToAll('pear:worker:ipc:' + specifier, data)
  }
  function onBeforeQuit() {
    pipe.destroy()
  }
  ipcMain.handle('pear:worker:writeIPC:' + specifier, (evt, data) => {
    return pipe.write(data)
  })
  workers.set(specifier, pipe)
  pipe.on('data', sendWorkerIPC)
  worker.stdout.on('data', sendWorkerStdout)
  worker.stderr.on('data', sendWorkerStderr)
  // Pear Drop diagnostics: the updater's output also goes to the terminal that launched the app.
  worker.stdout.on('data', (d) => process.stdout.write(String(d)))
  worker.stderr.on('data', (d) => process.stderr.write(String(d)))
  pipe.on('data', (d) => process.stdout.write('[updater ipc] ' + String(d) + '\n'))
  worker.once('exit', (code) => {
    app.removeListener('before-quit', onBeforeQuit)
    ipcMain.removeHandler('pear:worker:writeIPC:' + specifier)
    pipe.removeListener('data', sendWorkerIPC)
    worker.stdout.removeListener('data', sendWorkerStdout)
    worker.stderr.removeListener('data', sendWorkerStderr)
    sendToAll('pear:worker:exit:' + specifier, code)
    workers.delete(specifier)
  })
  app.on('before-quit', onBeforeQuit)
  return pipe
}

// Pear Drop's engine (workers/pear-drop.mjs) runs as its own Bare worker and serves the page the
// window shows. Stopped when the app quits.
let pearDrop = null
let pearDropExited = null
let pearDropTries = 0
let quitting = false
function startPearDrop() {
  if (pearDrop) return
  const dataDir = path.join(storageDir(), 'pear-drop')
  const worker = PearRuntime.run(require.resolve('../workers/pear-drop.mjs'), [pdPort, dataDir, deviceName(dataDir), version])
  pearDrop = worker
  pearDropExited = new Promise((resolve) => worker.once('exit', resolve))
  worker.stdout?.on('data', (d) => process.stdout.write('[pear-drop] ' + d))
  worker.stderr?.on('data', (d) => process.stderr.write('[pear-drop] ' + d))
  pearDropExited.then((code) => {
    pearDrop = null
    // Right after an update relaunch, the previous engine can still hold the storage lock for a
    // moment: the new one fails to open it and exits. Try again, 1 s apart, a few times.
    if (!quitting && code !== 0 && ++pearDropTries <= 10) {
      console.log('[pear-drop] engine exited with ' + code + ', restarting (' + pearDropTries + ')')
      setTimeout(startPearDrop, 1000)
    }
  })
}

// Name shown to other devices in Nearby: --name, else a neutral name made once per install
// (never the computer name, which often contains the owner's real name).
function deviceName(dataDir) {
  if (cmd.flags.name) return cmd.flags.name
  const file = path.join(dataDir, 'device-name')
  try {
    const saved = fs.readFileSync(file, 'utf8').trim()
    if (saved) return saved
  } catch {}
  const generated = 'Pear Drop ' + crypto.randomBytes(2).toString('hex').toUpperCase()
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(file, generated)
  } catch {}
  return generated
}

// Quit only once the engine has really stopped (it closes its storage on SIGTERM), so an update
// relaunch never finds the storage still locked.
app.on('before-quit', (evt) => {
  quitting = true
  if (!pearDrop) return
  evt.preventDefault()
  const worker = pearDrop
  const done = Promise.race([pearDropExited, new Promise((resolve) => setTimeout(resolve, 5000))])
  try {
    worker.destroy()
  } catch {}
  done.then(() => {
    pearDrop = null
    app.quit()
  })
})

async function waitForPearDrop(url, ms = 30000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const res = await fetch(url + '/api/state')
      if (res.ok) return true
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Pear Drop',
    backgroundColor: '#050A06',
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  // The window only ever shows the local engine: no navigation elsewhere, no new windows.
  const base = 'http://127.0.0.1:' + pdPort
  win.webContents.on('will-navigate', (evt, target) => {
    if (target !== base && !target.startsWith(base + '/')) evt.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const devServerUrl = process.env.PEAR_DEV_SERVER_URL

  if (devServerUrl) {
    await win.loadURL(devServerUrl)
    win.webContents.openDevTools()
    return
  }

  startPearDrop()
  const url = 'http://127.0.0.1:' + pdPort
  if (await waitForPearDrop(url)) await win.loadURL(url)
  else await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

ipcMain.handle('pear:applyUpdate', () => {
  const pipe = getWorker(mainWorkerSpecifier)

  return new Promise((resolve, reject) => {
    function onData(data) {
      const message = data.toString()

      if (message === 'pear:updateApplied') {
        pipe.removeListener('data', onData)
        resolve()
      } else if (message.startsWith('pear:updateFailed')) {
        pipe.removeListener('data', onData)
        reject(new Error(message.slice('pear:updateFailed'.length).trim() || 'update failed'))
      }
    }

    pipe.on('data', onData)
    pipe.write('pear:applyUpdate')
  })
})
ipcMain.handle('pear:startWorker', (evt, filename) => {
  // Only the updater worker may be started from the page.
  if (filename !== mainWorkerSpecifier) throw new Error('Unknown worker')
  getWorker(filename)
  return true
})
ipcMain.handle('app:afterUpdate', () => {
  if (isLinux && process.env.APPIMAGE) {
    app.relaunch({
      execPath: process.env.APPIMAGE,
      args: [
        '--appimage-extract-and-run',
        ...process.argv.slice(1).filter((arg) => arg !== '--appimage-extract-and-run')
      ]
    })
  } else if (!isWindows) {
    app.relaunch()
  }
  app.quit()
})

function handleDeepLink(url) {
  console.log('deep link:', url)
}

app.setAsDefaultProtocolClient(protocol)

app.on('open-url', (evt, url) => {
  evt.preventDefault()
  handleDeepLink(url)
})

const lock = app.requestSingleInstanceLock()

if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (evt, args) => {
    const url = args.find((arg) => arg.startsWith(protocol + '://'))
    if (url) handleDeepLink(url)
  })

  app.whenReady().then(() => {
    createWindow().catch((err) => {
      console.error('Failed to create window:', err)
      app.quit()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((err) => {
          console.error('Failed to create window:', err)
        })
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
