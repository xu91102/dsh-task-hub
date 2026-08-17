// Make `npm test` self-sufficient on a clean clone.
//
// Every test imports from ../lib/, and lib/ is gitignored build output, so on a
// fresh checkout `npm test` fails with ERR_MODULE_NOT_FOUND until `npm run build`
// has run once. npm runs `pretest` before `test`; this script builds only when
// lib/ is missing so that clean clones just work while day-to-day test runs stay
// fast (devs rebuild explicitly with `npm run build` to test latest changes).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const libEntry = join(root, 'lib', 'index.js')

if (existsSync(libEntry)) process.exit(0)

console.log('lib/ is missing (clean clone) — running `npm run build` first …')
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
