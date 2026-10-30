/** Compatibility entrypoint: isolated offline assertions for the current social-growth contract. */
import { runRegression } from './regression-suite.mjs'
process.exitCode = runRegression(['preferences-compat.test.mjs', 'reach-compat.test.mjs', 'model-context.test.mjs'])
