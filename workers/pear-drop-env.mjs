// Pear Drop worker config, from the args the Electron main process passes (see electron/main.js):
// [port, dataDir, name, version]. Runs before the server module is evaluated.
import process from 'bare-process'
const [port, data, name, version] = Bare.argv.slice(2)
if (port) process.env.PORT = port
if (data) process.env.DATA = data
if (name) process.env.NAME = name
if (version) process.env.VERSION = version
