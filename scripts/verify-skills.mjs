/** Skills require evaluated, explicit approval; bundled examples are not implicitly active. */
import { runRegression } from './regression-suite.mjs'
process.exitCode = runRegression(['skills-review.test.mjs'])
