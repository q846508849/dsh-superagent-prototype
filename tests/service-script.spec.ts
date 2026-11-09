/** Tests for scripts/dsh-superagent using a temporary checkout path with spaces and stubbed ps, tmux, and dsh binaries. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync }
  from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

/** Windows has no `ps`, no tmux, and no POSIX signals, so the processes there are real and the service is started detached. */
const WINDOWS = process.platform === 'win32'
/** The Windows script reads the process table through CIM, which takes seconds, so the waits there are longer. */
const LONG = WINDOWS ? 120_000 : 20_000

let root: string
let server: Server | undefined
let sleepers: ChildProcess[] = []
/** The profile under test; Windows takes a fresh one per test, because a service left running would answer for the next test. */
let profile = 'superagent'
let taken = 0
/** A profile name no other run uses; on POSIX the names stay as they are, because the process table there is a stub. */
const unique = (name: string) => (WINDOWS ? `${name}-${process.pid}-${++taken}` : name)
const control = (name: string) => join(root, '.artifacts', 'control', 'profiles', name)
const program = (name: string, body: string) =>
  writeFileSync(join(root, 'bin', name), WINDOWS ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`, { mode: 0o755 })
/** Spawn a dummy process whose PID the script can see; ignoreInterrupt simulates a hung graceful stop. */
function sleeper(ignoreInterrupt = false): number {
  let child: ChildProcess
  if (WINDOWS) {
    child = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 30000)'], { stdio: 'ignore' })
  } else {
    const [command, args] = ignoreInterrupt
      ? ['sh', ['-c', 'trap "" INT; exec sleep 60']] as const
      : ['sleep', ['60']] as const
    child = spawn(command, [...args], { stdio: 'ignore' })
  }
  sleepers.push(child)
  return child.pid!
}
/** A process the script should find in the process table. */
type Entry = { pid: number; args: string[]; comm?: string; after?: number }
/** The command line of a DSH service process for `name`. */
const serviceArgs = (name: string, words: string[] = []) =>
  ['node', '/opt/my tools/dsh', ...words, '--profile', name, '--no-open']
const service = (pid: number, name = profile, words: string[] = []) => ({ pid, args: serviceArgs(name, words) })
const render = (entry: Entry) =>
  `${entry.after === undefined ? '' : `after:${entry.after} `}${entry.pid} ${entry.comm ?? 'node'} ${entry.args.join(' ')}\n`
/** Start a process the script reads from the Windows process table. */
function spawnEntry(entry: Entry): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 30000)', '--', ...entry.args], { stdio: 'ignore' })
  sleepers.push(child)
  return child.pid!
}
/** Declare the processes the script should find and return their PIDs; the fake `ps` reads them from a file on POSIX, and on Windows they are started for real. */
function table(...entries: Entry[]): number[] {
  if (!WINDOWS) {
    writeFileSync(join(root, 'ps.txt'), entries.map(render).join(''))
    return entries.map(entry => entry.pid)
  }
  return entries.map(entry => {
    if (entry.after === undefined) return spawnEntry(entry)
    // The entry shows up once the process it waits for is gone.
    const waited = sleepers.find(child => child.pid === entry.after)
    waited?.once('exit', () => spawnEntry(entry))
    return entry.pid
  })
}
/** Declare the processes the script should find once the service has started. */
function started(...entries: Entry[]): number[] {
  if (!WINDOWS) {
    writeFileSync(join(root, 'ps-started.txt'), entries.map(render).join(''))
    return entries.map(entry => entry.pid)
  }
  return entries.map(entry => spawnEntry(entry))
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script '))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent'), join(root, 'scripts', 'dsh-superagent'))
  profile = unique('superagent')
  table()
  if (!WINDOWS) {
    program('ps', `list='${root}/ps.txt'; [ -f '${root}/launched' ] && [ -f '${root}/ps-started.txt' ] && list='${root}/ps-started.txt'
want=; while [ $# -gt 0 ]; do [ "$1" = -p ] && want=$2; shift; done
while IFS= read -r line; do
  case "$line" in after:*) dep=\${line#after:}; dep=\${dep%% *}; kill -0 "$dep" 2>/dev/null && continue; line=\${line#after:$dep };; esac
  pid=\${line%% *}; kill -0 "$pid" 2>/dev/null || continue
  if [ -z "$want" ] || [ "$pid" = "$want" ]; then printf '%s\\n' "$line"; fi
done < "$list"`)
    // Log tmux invocations and simulate session creation by outputting the pane PID.
    program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
      + `case "$1" in has-session) exit 1;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
    program('dsh', 'exit 0')
  } else {
    // The npm shim on Windows is a batch file; it records its arguments, marks the service as launched, and
    // starts a Node process whose command line names the profile, which is how the script finds the service.
    const code = `require('fs').writeFileSync('${root.replace(/\\/g, '/')}/service.pid.txt', String(process.pid)); setTimeout(function(){}, 30000)`
    program('dsh.cmd', `echo %*>>"${root}\\dsh.log"\r\necho dsh fake started\r\ntype nul>>"${root}\\launched"\r\n`
      + `"${process.execPath}" -e "${code}" -- %*`)
  }
})
afterEach(() => {
  server?.close(); server = undefined
  for (const child of sleepers) child.kill()
  sleepers = []
  // The shim starts a Node child that keeps the log file open, so it has to end before the directory can be removed.
  const pidFile = join(root, 'service.pid.txt')
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (pid > 0) {
      try { process.kill(pid) } catch { /* The service is already gone. */ }
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})
/** The Python interpreter that runs the script: `python3` on POSIX systems, `python` on Windows, where the `python3` name is often absent. */
const PYTHON = process.env.DSH_SUPERAGENT_PYTHON ?? (WINDOWS ? 'python' : 'python3')
function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(PYTHON, [join(root, 'scripts', 'dsh-superagent'), ...args],
    { env: { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`, DSH_SUPERAGENT_PROFILE: profile, DSH_SUPERAGENT_URL: '' },
      timeout: LONG },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const READY = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }
/** Start a mock HTTP server that returns 503 until the service starts (unless always is true). */
async function answering(state: unknown = READY, always = false): Promise<string> {
  server = createServer((_request, response) => {
    if (!always && !existsSync(join(root, 'launched'))) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
const status = async (name: string, url = 'http://127.0.0.1:9') =>
  JSON.parse((await run('status', '--profile', name, '--url', url)).stdout) as { pids: number[]; manually_stopped: boolean }

it('refuses to stop when two processes serve the profile, before it writes the stop marker', async () => {
  table(service(sleeper()), { pid: sleeper(), args: ['node', '/opt/dsh', '--profile=' + profile] })
  expect(await run('stop')).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes found') })
  expect(existsSync(join(control(profile), 'manually-stopped'))).toBe(false)
}, LONG)
it('keeps a stop per profile', async () => {
  const one = unique('one'), two = unique('two')
  expect(await run('stop', '--profile', one)).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
  expect(await status(one)).toMatchObject({ manually_stopped: true })
  expect(await status(two)).toMatchObject({ manually_stopped: false })
  const skipped = await run('--respect-stop', 'start', '--profile', one)
  expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('Intentional stop is active') })
}, LONG)
it('takes no `dsh plugin` command of the profile for its service', async () => {
  const wanted = sleeper()
  const [, servicePid] = table(
    { pid: sleeper(), args: ['node', '/opt/my tools/dsh', 'plugin', '--profile', profile, 'add', 'link:/x'] },
    service(wanted))
  expect(await status(profile)).toMatchObject({ pids: [servicePid] })
}, LONG)
it('records the service PID at start, and still refuses a second instance the scan finds', async () => {
  const url = await answering()
  if (!WINDOWS) {
    const pid = sleeper()
    writeFileSync(join(root, 'pane'), `${pid}\n`)
    started(service(pid))
    const start = await run('start', '--url', url, '--timeout', '10')
    expect(start).toMatchObject({ code: 0, stdout: expect.stringContaining(`"pids": [\n    ${pid}\n  ]`) })
    expect(readFileSync(join(control(profile), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
    const tmux = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').find(call => call.startsWith('new-session'))!.split('\n')
    // The checkout's path, which has a space, is one argument, and the log path inside it is quoted for the shell.
    const checkout = realpathSync(root)
    expect(tmux).toEqual(expect.arrayContaining(['-P', '-F', '#{pane_pid}', '-c', checkout]))
    const log = new RegExp(`>> '${checkout}/\\.artifacts/dsh-superagent-${profile}-\\d{8}-\\d{6}-\\d+\\.log' 2>&1$`)
    expect(tmux.find(word => word.startsWith('umask 077; exec '))).toMatch(log)
    const second = sleeper()
    started(service(pid), { pid: second, args: ['node', '/opt/dsh', '--profile', profile] })
    const again = await run('start', '--url', url, '--timeout', '10')
    expect(again).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes') })
    expect(await status(profile)).toMatchObject({ pids: [pid, second] })
    return
  }
  // Windows starts the service detached and finds its process in the process table.
  const start = await run('start', '--url', url, '--timeout', '10')
  expect(start).toMatchObject({ code: 0 })
  const pid = Number(readFileSync(join(control(profile), 'service.pid'), 'utf8').trim())
  expect(pid).toBeGreaterThan(0)
  expect(await status(profile, url)).toMatchObject({ pids: [pid] })
  // The service was started with the profile, and what it printed reached the log.
  expect(readFileSync(join(root, 'dsh.log'), 'utf8')).toContain(`--profile ${profile} --no-open`)
  const logs = readdirSync(join(root, '.artifacts')).filter(name => name.startsWith(`dsh-superagent-${profile}-`))
  expect(logs).toHaveLength(1)
  expect(readFileSync(join(root, '.artifacts', logs[0]!), 'utf8')).toContain('dsh fake started')
  const second = started(service(sleeper()))[0]
  const again = await run('start', '--url', url, '--timeout', '10')
  expect(again).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes') })
  expect((await status(profile, url)).pids.sort()).toEqual([pid, second].sort())
}, LONG)
it('waits only for the process it stopped', async () => {
  const pid = sleeper()
  // Another instance shows up once the stopped one ended.
  table(service(pid), { pid: sleeper(), after: pid, args: ['node', '/opt/dsh', '--profile', profile] })
  expect(await run('stop', '--stop-timeout', '5')).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped') })
}, LONG)
it('keeps only the newest logs it wrote for the profile', async () => {
  const url = await answering()
  if (!WINDOWS) {
    const pid = sleeper()
    writeFileSync(join(root, 'pane'), `${pid}\n`)
    started(service(pid))
  }
  mkdirSync(join(root, '.artifacts'), { recursive: true })
  for (const name of [profile, 'other']) for (let index = 0; index < 25; index++) {
    const log = join(root, '.artifacts', `dsh-superagent-${name}-20260901-0000${String(index).padStart(2, '0')}-1.log`)
    writeFileSync(log, '')
    utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
  }
  writeFileSync(join(root, '.artifacts', 'dsh-superagent-20260901-000000-1.log'), '')
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const logs = readdirSync(join(root, '.artifacts'))
  const own = logs.filter(name => name.startsWith(`dsh-superagent-${profile}-`)).sort()
  expect(own).toHaveLength(20)
  // The oldest went; the new one stays, with the newest earlier ones. Another profile's logs and older names stay.
  expect(own).not.toContain(`dsh-superagent-${profile}-20260901-000000-1.log`)
  expect(own.filter(name => !name.startsWith(`dsh-superagent-${profile}-20260901-`))).toHaveLength(1)
  expect(logs.filter(name => name.startsWith('dsh-superagent-other-'))).toHaveLength(25)
  expect(logs).toContain('dsh-superagent-20260901-000000-1.log')
}, LONG)
it('reports a service whose Feishu bot setup could not check as running, and reads an answer with keys missing', async () => {
  table(service(sleeper()))
  const feishu = { health: { runtime: { state: 'ready', detail: '' }, feishu: { state: 'paused', detail: '' } },
    setup: { problem: null, feishuProblem: { code: 'feishuNoBot', detail: 'No bot' } } }
  expect(await run('status', '--url', await answering(feishu, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'ready' } } }, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'error' } } }, true))).toMatchObject({ code: 1 })
}, LONG)
it('exits 2 while a part such as a Source reports an error, which a restart does not fix, and prints what it reports', async () => {
  table(service(sleeper()))
  const github = { health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' } }, setup: {} }
  const url = await answering(github, true)
  const checked = await run('status', '--url', url)
  expect(checked.code).toBe(2)
  expect(JSON.parse(checked.stdout)).toMatchObject({ errors: { github: 'bad token' } })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('github reports an error, which a restart does not fix: bad token') })
}, LONG)
it('exits 3 while the service waits for setup, from status and from start, which a restart does not fix', async () => {
  table(service(sleeper()))
  const waiting = { health: { runtime: { state: 'paused', detail: '' } },
    setup: { problem: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' }, feishuProblem: null } }
  const url = await answering(waiting, true)
  expect(await run('status', '--url', url)).toMatchObject({ code: 3 })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 3, stdout: expect.stringContaining('waiting for setup: The GitHub Source names no repository.') })
}, LONG)
it('restarts the service, and a restart whose graceful stop timed out does not keep recovery off', async () => {
  const url = await answering()
  if (!WINDOWS) {
    const old = sleeper(), pid = sleeper()
    table(service(old))
    writeFileSync(join(root, 'pane'), `${pid}\n`)
    started(service(pid))
    const restarted = await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '5')
    expect(restarted).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped.') })
    expect(restarted.stdout).not.toContain('Automatic recovery is paused')
    expect(existsSync(join(control(profile), 'manually-stopped'))).toBe(false)
    expect(readFileSync(join(control(profile), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
    // A service that does not stop in time is left running, and the next check may restart it.
    rmSync(join(root, 'launched'))
    table(service(sleeper(true)))
    expect(await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '1'))
      .toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
    expect(await status(profile)).toMatchObject({ manually_stopped: false })
    return
  }
  // Windows has no signal that reaches a detached service, so a stop ends the process tree instead of timing out.
  table(service(sleeper()))
  const restarted = await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '1')
  expect(restarted).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped.') })
  expect(existsSync(join(control(profile), 'manually-stopped'))).toBe(false)
  expect(Number(readFileSync(join(control(profile), 'service.pid'), 'utf8').trim())).toBeGreaterThan(0)
}, LONG)
it('refuses a second control operation while one holds the profile\'s lock', async () => {
  mkdirSync(control(profile), { recursive: true })
  const held = join(root, 'held')
  const lock = JSON.stringify(join(control(profile), 'operation.lock'))
  // The lock is a byte range on Windows and a whole file on POSIX.
  const holder = spawn(PYTHON, ['-c', WINDOWS ? `import msvcrt, os, pathlib, time
handle = os.open(${lock}, os.O_CREAT | os.O_RDWR, 0o600)
os.write(handle, b'\\0')
os.lseek(handle, 0, os.SEEK_SET)
msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)
pathlib.Path(${JSON.stringify(held)}).touch()
time.sleep(30)` : `import fcntl, pathlib, time
lock = open(${lock}, 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
pathlib.Path(${JSON.stringify(held)}).touch()
time.sleep(30)`], { stdio: 'ignore' })
  sleepers.push(holder)
  while (!existsSync(held)) await new Promise(resolve => setTimeout(resolve, 50))
  expect(await run('status')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('Another dsh-superagent control operation is in progress') })
}, LONG)
it('refuses to start a service while no process runs it but something answers at its URL', async () => {
  const url = await answering(READY, true)
  expect(await run('start', '--url', url, '--timeout', '5'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('An existing orchestrator answers at this URL') })
  if (WINDOWS) {
    // The service was never started, so the shim never ran.
    expect(existsSync(join(root, 'dsh.log'))).toBe(false)
    expect(existsSync(join(root, 'launched'))).toBe(false)
    return
  }
  expect(readFileSync(join(root, 'tmux.log'),
    'utf8').split('---\n').filter(Boolean).map(call => call.split('\n')[0])).toEqual(['has-session'])
}, LONG)
it('starts the service in a new window of the profile\'s tmux session when the session exists', async () => {
  if (WINDOWS) {
    // Windows has no tmux; the detached start above covers the same ground.
    return
  }
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in has-session) exit 0;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const calls = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').map(call => call.split('\n'))
  expect(calls.find(call => call[0] === 'new-window')).toEqual(expect.arrayContaining(['-t', '=dsh-superagent:']))
  expect(calls.some(call => call[0] === 'new-session')).toBe(false)
}, LONG)
it('exits 1 when the started service does not answer in time, and leaves its process running', async () => {
  if (!WINDOWS) {
    const pid = sleeper()
    writeFileSync(join(root, 'pane'), `${pid}\n`)
    started(service(pid))
    expect(await run('start', '--url', 'http://127.0.0.1:9', '--timeout', '2'))
      .toMatchObject({ code: 1, stderr: expect.stringContaining('Startup health check timed out') })
    expect(() => process.kill(pid, 0)).not.toThrow()
    return
  }
  expect(await run('start', '--url', 'http://127.0.0.1:9', '--timeout', '2'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Startup health check timed out') })
  const pid = Number(readFileSync(join(control(profile), 'service.pid'), 'utf8').trim())
  expect(pid).toBeGreaterThan(0)
  expect(() => process.kill(pid, 0)).not.toThrow()
}, LONG)
it('does not signal a process that took the recorded service PID, and keeps a stop that timed out', async () => {
  mkdirSync(control(profile), { recursive: true })
  const other = sleeper()
  table({ pid: other, comm: 'sleep', args: ['sleep', '60'] })
  writeFileSync(join(control(profile), 'service.pid'), `${other}\n`)
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 0 })
  expect(() => process.kill(other, 0)).not.toThrow()
  // A service that does not stop in time keeps the stop, so recovery does not start it again.
  rmSync(join(control(profile), 'manually-stopped'))
  // POSIX keeps a process that ignores the interrupt; Windows ends the process tree instead of waiting for a signal.
  const stubborn = table(service(sleeper(true)))[0]!
  if (WINDOWS) {
    // Windows ends the process tree instead of waiting for a signal that never arrives.
    expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 0 })
    expect(existsSync(join(control(profile), 'manually-stopped'))).toBe(true)
    expect(() => process.kill(stubborn, 0)).toThrow()
    return
  }
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(existsSync(join(control(profile), 'manually-stopped'))).toBe(true)
}, LONG)
