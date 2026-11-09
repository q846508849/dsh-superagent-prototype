/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'
import { SHIM_HELPER_NAME, SHIM_HELPER_SOURCE, credentialHelperFor, isWindows, normalizeGitPath, shimFileName, shimTarget } from './platform.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const posixQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
/** A value a batch file holds: a percent sign doubles, and a quote would end the value early. */
const batchValue = (value: string): string => value.replaceAll('%', '%%').replaceAll('"', '')
export const credentialHelper = (cli: string): string => credentialHelperFor(cli)

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  const left = real(a)
  const right = real(b)
  // A Windows path does not distinguish upper from lower case.
  return isWindows ? left.toLowerCase() === right.toLowerCase() : left === right
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/**
 * The marker a line carries. A Windows batch file hides the marker behind a `rem` comment and the Node helper
 * behind a line comment, so the comment prefix comes off before the marker is compared.
 */
const markerLine = (line: string): string => isWindows ? line.replace(/\r$/, '').replace(/^(?:rem[ \t]+|\/\/[ \t]?)/i, '') : line

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.some(line => markerLine(line) === marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/** A worker shim: the program it stands in for, or the message it fails with. */
interface Shim { name: string, program: string, failure: string }

/** Writes a POSIX shim: a shell script that strips the shim directory from PATH and execs the program. */
async function writePosixShim(dir: string, shim: Shim, kept: Set<string>): Promise<void> {
  const withoutShims = [
    `self=${posixQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${posixQuote(program)} "$@"`
  const fail = (message: string): string => `echo ${posixQuote(message)} >&2\nexit 1`
  const body = shim.failure ? fail(shim.failure) : run(shim.program)
  const temporary = join(dir, `.${shim.name}.${process.pid}.tmp`)
  await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
  await rename(temporary, join(dir, shim.name))
  kept.add(shim.name)
}

/**
 * Writes a Windows shim: a batch file that hands the program and the failure message to the Node helper, which
 * runs the program with the shim directory taken out of PATH.
 */
async function writeWindowsShim(dir: string, shim: Shim, kept: Set<string>): Promise<void> {
  const name = shimFileName(shim.name)
  const temporary = join(dir, `.${name}.${process.pid}.tmp`)
  await writeFile(temporary, [
    '@echo off',
    `rem ${MARKER}`,
    'setlocal',
    `set "DSH_SUPERAGENT_SHIM_TARGET=${batchValue(shimTarget(shim.program))}"`,
    `set "DSH_SUPERAGENT_SHIM_FAIL=${batchValue(shim.failure)}"`,
    // The desktop plugin runs under Electron, which runs a script as a plain Node process while this variable is set.
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${batchValue(process.execPath)}" "${batchValue(join(dir, SHIM_HELPER_NAME))}" %*`,
    '',
  ].join('\r\n'))
  await rename(temporary, join(dir, name))
  kept.add(name)
}

/** Writes the Node helper the Windows shims run, next to them and in the same atomic way. */
async function writeShimHelper(dir: string): Promise<void> {
  const temporary = join(dir, `.${SHIM_HELPER_NAME}.${process.pid}.tmp`)
  await writeFile(temporary, SHIM_HELPER_SOURCE)
  await rename(temporary, join(dir, SHIM_HELPER_NAME))
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shims: Shim[] = [
    { name: 'gh', program: github.cli, failure: '' },
    { name: 'lark-cli', program: feishu ? feishu.cli : '', failure: feishu ? '' : 'lark-cli is unavailable: this installation has no Feishu bot.' },
  ]
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    shims.push({ name, program: '', failure: `${name} is blocked in this installation; use gh, which acts as ${github.login}.` })
  }
  if (isWindows) {
    // A Windows shim cannot be a shell script, so the shims are batch files that run the Node helper beside them.
    await writeShimHelper(dir)
    kept.add(SHIM_HELPER_NAME)
    for (const shim of shims) await writeWindowsShim(dir, shim, kept)
  } else {
    for (const shim of shims) await writePosixShim(dir, shim, kept)
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  // Git prints a Windows path with forward slashes, and a Windows path does not distinguish upper from lower case.
  const actual = helpers.map(entry => normalizeGitPath(entry))
  const expected = [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].map(entry => normalizeGitPath(entry))
  if (actual.join('\0') !== expected.join('\0')) throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
