/**
 * Headless check: prove the compiler arm drives a real `dsh --profile headless`
 * turn, without a real model.
 *
 * Prerequisites (one-time, in the directory you run this from):
 *   npm i @deepseek-ai/dsh@0.2.2-rc.1 @deepseek-ai/dsh-base@0.2.2-rc.1 \
 *         @deepseek-ai/dsh-headless@0.2.2-rc.1
 *   npm run build && npm pack            # in the plugin repo
 *   node scripts/e2e/headless-check.mjs ./sasimoreyang-ai-dsh-dag-<version>.tgz
 *
 * What it does, all under one throwaway DSH_HOME in the current directory:
 *   1. writes a headless profile whose bundle list includes this plugin
 *   2. installs the packed tarball into that profile
 *   3. starts a stub model that answers the planner with a `read(...)` plan and
 *      the joiner with `Finish(<token found in the observation>)`
 *   4. runs `dsh --profile headless --patch <overlay> --json "<task>"`
 *   5. asserts the headless text quotes the token, and that the engine's JSONL
 *      record shows one task, one wave, two model calls and an observation that
 *      actually carried the file content
 *
 * The stub-joiner answer is derived from the observation, so a pass cannot be
 * faked by the process merely exiting zero: it proves planner → tool dispatch
 * through the registry → observation → joiner → assistant text.
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve('.')
const home = join(root, 'home')
const profile = join(home, 'profiles', 'headless')
const tarball = process.argv[2]
if (tarball === undefined) throw new Error('usage: node scripts/e2e/headless-check.mjs <plugin-tarball>')
const metricsPath = join(root, 'engine.jsonl')
const secretPath = join(root, 'secret.txt')
// The plan parser mirrors Python's literal_eval, so a Windows path written with
// single backslashes loses them. Plans carry forward slashes; Windows accepts them.
const secretPosix = secretPath.replace(/\\/g, '/')
const token = 'TOKEN-LOCAL-7788'

const run = (command, args, options = {}) => {
  // Node 24 refuses to spawn a .cmd shim without a shell.
  const needsShell = command === 'npm' && process.platform === 'win32'
  return execFileSync(needsShell ? 'npm.cmd' : command, args,
    { stdio: 'inherit', cwd: root, ...(needsShell ? { shell: true } : {}), ...options })
}

rmSync(home, { recursive: true, force: true })
rmSync(metricsPath, { force: true })
mkdirSync(profile, { recursive: true })
writeFileSync(secretPath, `the local token is ${token}\n`, 'utf8')

writeFileSync(join(profile, 'cordis.yml'), '[]\n', 'utf8')
writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-headless-local',
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@sasimoreyang-ai/dsh-dag'],
    },
  },
}, null, 2)}\n`, 'utf8')

run('npm', ['i', '--legacy-peer-deps', '--omit=peer', '--no-audit', '--no-fund', tarball], { cwd: profile })

const overlay = readFileSync(join(here, 'enable.template.yml'), 'utf8')
  .replace('__METRICS__', metricsPath.replace(/\\/g, '/'))
writeFileSync(join(root, 'enable.yml'), overlay, 'utf8')

const stub = spawn(process.execPath, [join(here, 'stub-model.mjs')], {
  env: { ...process.env, STUB_PORT: '8799', STUB_TARGET: secretPosix },
  stdio: 'inherit',
})

const waitForStub = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:8799/v1/models')
      if (response.ok) return
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('stub model did not start')
}

try {
  await waitForStub()
  const cli = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(cli)) throw new Error(`dsh is not installed here: ${cli}`)

  const env = { ...process.env, DSH_HOME: home, STUB_API_KEY: 'stub-key', DSH_PROFILE: undefined }
  const args = [
    cli, '--profile', 'headless',
    '--patch', join(root, 'enable.yml'),
    '--approval-policy', 'never',
    '--json',
    `What token is in ${secretPosix}?`,
  ]
  const output = execFileSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 300_000 })
  writeFileSync(join(root, 'run.jsonl'), output, 'utf8')
  console.log('--- headless stdout ---')
  console.log(output.trim())

  const events = output.trim().split('\n').map(line => JSON.parse(line))
  const final = events.find(event => event.type === 'final')
  const said = events.filter(event => event.type === 'text').map(event => event.text).join('')

  console.log('\n--- assertions ---')
  const checks = [
    ['final event exists', final !== undefined],
    ['turn completed', final?.reason?.kind === 'completed'],
    ['assistant text quotes the token', said.includes(token)],
    ['no empty answer', said.trim() !== ''],
    ['engine metrics written', existsSync(metricsPath)],
  ]
  if (existsSync(metricsPath)) {
    const record = JSON.parse(readFileSync(metricsPath, 'utf8').trim().split('\n')[0])
    console.log(`engine record: answer=${JSON.stringify(record.answer)} planTasks=${record.planTasks} waves=${record.planWaves} llmCalls=${record.llmCalls}`)
    console.log(`  task[0]: ${JSON.stringify(record.tasks?.[0]?.resolvedArgs)}`)
    checks.push(
      ['planner produced one task', record.planTasks === 1],
      ['one ready wave', record.planWaves === 1],
      ['tool observation carried the file content', (record.tasks?.[0]?.observation ?? '').includes(token)],
      ['two model calls (planner + joiner)', record.llmCalls === 2],
    )
  }
  let failed = 0
  for (const [label, ok] of checks) {
    if (!ok) failed += 1
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  }
  console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
  process.exitCode = failed === 0 ? 0 : 1
} finally {
  stub.kill('SIGTERM')
}
