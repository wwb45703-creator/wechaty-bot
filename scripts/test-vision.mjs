/** Received image decode and mocked vision generation; no live WeChat or model calls. */
import { runRegression } from './regression-suite.mjs'
process.exitCode = runRegression(['image-compat.test.mjs', 'model-context.test.mjs'])
