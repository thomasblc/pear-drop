// Pear Drop's engine as a Bare worker: the Node server in pear-drop/server.mjs runs on Bare through
// bare-node-runtime's Node builtins map. The Electron window loads its page from 127.0.0.1.
import 'bare-node-runtime/global'
import './pear-drop-env.mjs'
import '../pear-drop/server.mjs' with { imports: 'bare-node-runtime/imports' }
