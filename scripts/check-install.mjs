import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = process.argv[2]
if (!cli || !process.env.npm_execpath) throw new Error('Use npm run check:install -- /absolute/path/to/@deepseek-ai/dsh/lib/bin.js')
const cliFile = resolve(cli)
const cliPackage = JSON.parse(readFileSync(join(dirname(cliFile), '..', 'package.json'), 'utf8'))
assert.equal(cliPackage.name, '@deepseek-ai/dsh')
assert.equal(cliPackage.version, '0.2.0-rc.2')
const home = mkdtempSync(join(tmpdir(), 'dsh-dag-install-'))
const env = { ...process.env, DSH_HOME: home }
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 5_000_000 })
  if (result.error || result.status !== 0) throw new Error(`Install check failed in ${home}: ${result.error ?? result.stderr.slice(-4000)}`)
  return result.stdout
}
run([process.env.npm_execpath, 'run', 'build'])
const metadata = JSON.parse(run([process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', home]))
const tarball = join(home, metadata[0].filename)
run([cliFile, 'plugin', '--profile', 'web', 'add', tarball])
const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
assert.ok(manifest.dsh.profile.bundles.includes('@sasimoreyang-ai/dsh-dag'))
const config = run([cliFile, '--profile', 'web', '--dump-config'])
assert.match(config, /id: tool-dag/u)
assert.match(config, /@sasimoreyang-ai\/dsh-dag/u)
// Isolate the plugin's schema from unrelated stock-profile schema diagnostics.
// The full web composition was checked above, before changing this temporary manifest.
manifest.dsh.profile.bundles = ['@sasimoreyang-ai/dsh-dag']
writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify(manifest, null, 2))
// Import through DSH's actual runtime peer resolver.
const schema = run([cliFile, '--profile', 'web', '--dump-config-schema'])
assert.match(schema, /maxConcurrency/u)
console.log(JSON.stringify({ dsh: cliPackage.version, home, tarball, bundleSelected: true, configComposed: true, schemaImported: true }, null, 2))
