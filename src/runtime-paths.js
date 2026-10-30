import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Tests and offline tools always use a separate root; production keeps its existing layout.
export const DATA_ROOT = path.resolve(process.env.BOT_DATA_ROOT || PROJECT_ROOT)
export const CONFIG_FILE = path.resolve(process.env.BOT_CONFIG_FILE || path.join(DATA_ROOT, 'config.json'))
export const dataPath = (...parts) => path.join(DATA_ROOT, ...parts)
export const isTestMode = process.env.BOT_TEST_MODE === '1'
