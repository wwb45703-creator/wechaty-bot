/** Service parsing and simulated Electron IPC; never toggles a real plugin. */
import { runRegression, runIsolatedScript } from './regression-suite.mjs'
const service = runRegression(['bridge-compat.test.mjs'])
const ipc = runIsolatedScript('test-ui-social-ipc.mjs', ['--experimental-vm-modules'])
process.exitCode = service || ipc ? 1 : 0
