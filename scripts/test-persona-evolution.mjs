/** Compatibility entrypoint: isolated offline assertions for the current social-growth contract. */
import { runRegression } from './regression-suite.mjs'
process.exitCode = runRegression(['social-store.test.mjs', 'preferences-compat.test.mjs'])
