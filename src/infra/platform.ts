/**
 * The platform differences the plugin adapts to: the shell that runs a command, the quoting shims and git
 * credential helpers need, and the path shapes a deployment accepts. Windows support is additive: outside the
 * `isWindows` branches every behaviour stays what it was on POSIX systems.
 */
import { accessSync, chmodSync, constants, statSync } from 'node:fs'
import { extname, join } from 'node:path'

/** True on Windows, where paths, shells and executable lookups differ from POSIX systems. */
export const isWindows: boolean = process.platform === 'win32'

/**
 * Quotes a value for the platform's shell. POSIX shells take single quotes, Windows shells double quotes: a
 * Windows path holds spaces, and git for Windows runs a `!` credential helper through the sh it ships.
 */
export function shellQuote(value: string): string {
  if (isWindows) return windowsQuote(value)
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Quotes a value for a Windows shell: double quotes, with a quote, a dollar sign and a trailing backslash inside escaped. */
const windowsQuote = (value: string): string => {
  const escaped = value
    .replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`)
    .replace(/([$`])/g, '\\$1')
    .replace(/(\\+)$/, (_match, slashes: string) => `${slashes}${slashes}`)
  return `"${escaped}"`
}

/**
 * The command that runs a shell command: `sh -c` on POSIX systems, PowerShell on Windows. PowerShell is preferred
 * over cmd.exe because it reads the execution environment's variables the way the prepare command expects.
 */
export function prepareShell(command: string): string[] {
  if (!isWindows) return ['sh', '-c', command]
  const shell = windowsShell()
  if (shell.endsWith('cmd.exe')) return [shell, '/d', '/s', '/c', command]
  return [shell, '-NoProfile', '-NonInteractive', '-Command', command]
}

/** The Windows shell that runs the prepare command: PowerShell when the machine has it, cmd.exe otherwise. */
function windowsShell(): string {
  for (const name of ['pwsh.exe', 'powershell.exe']) {
    const found = lookupInPath(name, process.env.PATH ?? '')
    if (found) return found
  }
  return process.env.ComSpec ?? 'cmd.exe'
}

/** The first file with that name in the PATH directories, which is how Windows resolves a command name. */
function lookupInPath(name: string, path: string): string | undefined {
  for (const directory of path.split(';')) {
    if (!directory) continue
    const candidate = join(directory, name)
    try { if (statSync(candidate).isFile()) return candidate } catch { /* Not here; try the next directory. */ }
  }
  return undefined
}

/** The file name a shim gets: the command name on POSIX systems, `<name>.cmd` on Windows, where cmd.exe resolves it. */
export function shimFileName(name: string): string {
  return isWindows ? `${name}.cmd` : name
}

/**
 * The value a shim hands to its helper: the real program the shim stands in for. On Windows the value travels
 * through a `set "VAR=..."` line, which a quote in the path would end early.
 */
export function shimTarget(program: string): string {
  return isWindows ? program.replaceAll('"', '') : program
}

/** The git credential helper that binds a worker's git to the deployment's GitHub CLI. */
export function credentialHelperFor(cli: string): string {
  return `!${shellQuote(cli)} auth git-credential`
}

/**
 * Restricts a file to its owner. Windows has no mode bits: the file's secrecy rests on the access control list of
 * the directory that holds it, which the deployment creates inside the operator's own profile.
 */
export function restrictFile(path: string, mode: number): void {
  if (isWindows) return
  chmodSync(path, mode)
}

/**
 * The program and arguments that run a CLI. Windows cannot start a batch file directly: npm installs its CLIs as
 * `.cmd` shims, so a Windows run goes through cmd.exe and calls the batch file, which keeps the CLI's exit code.
 */
export function commandInvocation(program: string, args: string[]): { file: string; args: string[] } {
  if (isWindows && /\.(cmd|bat)$/i.test(program)) {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', 'call', program, ...args] }
  }
  return { file: program, args }
}

/**
 * The options every child process of this plugin starts with. The desktop host runs the plugin in a windowless
 * Electron process, so a console program started without `windowsHide` opens a terminal window on the operator's
 * desktop every time the plugin runs a CLI. The option has no effect on POSIX systems.
 */
export const hiddenChild = { windowsHide: true } as const

/**
 * Normalizes what git prints for comparison with what this side expects: git prints a Windows path with forward
 * slashes, inside quotes, because its backslashes are escapes there, and a Windows path does not distinguish upper
 * from lower case. A POSIX path is compared verbatim.
 */
export function normalizeGitPath(path: string): string {
  if (!isWindows) return path
  // Git quotes the origin on Windows and escapes the backslashes inside it, because they are escapes there.
  const origin = path.replace(/^file:"([^"]*)"/, (_match, quoted: string) => `file:${quoted.replaceAll('\\\\', '\\')}`)
  return origin.replaceAll('\\', '/').toLowerCase()
}

/** The pattern an absolute path matches: a rooted POSIX path, or a drive, UNC or rooted Windows path. */
export function absolutePathPattern(): RegExp {
  return isWindows ? /^([A-Za-z]:[\\/]|\\\\|\/)/ : /^\//
}

/** Whether a path is absolute on this platform. */
export function isAbsolutePath(path: string): boolean {
  return absolutePathPattern().test(path)
}

/**
 * The files a command name may have in the PATH directories: the bare name on POSIX systems, and every executable
 * extension on Windows, where a command name resolves through PATHEXT. The extensions come before the directories,
 * so a deployment resolves to the real program rather than to a batch file that stands in for it.
 */
export function pathCandidates(directories: readonly string[], name: string): string[] {
  if (!isWindows) return directories.map(directory => join(directory, name))
  return pathExtensions().flatMap(extension => directories.map(directory => join(directory, name + extension)))
}

/**
 * The extensions Windows resolves a command name with. The executable extension comes first, because a worker's shim
 * is a batch file and a deployment has to point at the program itself.
 */
function pathExtensions(): string[] {
  const configured = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(entry => entry.trim().toLowerCase()).filter(entry => entry.length > 0)
  const preferred = ['.exe', '.cmd', '.bat']
  const ordered = [...preferred.filter(entry => configured.includes(entry)), ...configured.filter(entry => !preferred.includes(entry))]
  return ordered.length ? ordered : preferred
}

/**
 * Whether a file is a program the user may run: a regular file, which on POSIX systems must also carry the
 * executable bit. A program the user named by its path is their own choice, and Windows reports at once when it
 * cannot start it; a program found on PATH must carry one of the extensions the system runs.
 */
export function isExecutableFile(candidate: string, named = false): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    if (isWindows) return named || pathExtensions().includes(extname(candidate).toLowerCase())
    accessSync(candidate, constants.X_OK)
    return true
  } catch { return false }
}

/** The DSH shell tool a Session runs commands with: `bash` on POSIX systems, `pwsh` on Windows. */
export function shellToolName(): string {
  return isWindows ? 'pwsh' : 'bash'
}

/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const POSIX_SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/** PowerShell's waiting command, `Start-Sleep`, which has no POSIX equivalent; `sleep` is its alias there. */
const POWERSHELL_SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*[\\/])?(?:start-)?sleep\b/i
/** Whether a shell command would hold the step: POSIX `sleep`, or PowerShell's `Start-Sleep` on Windows. */
export function waitsFor(command: string): boolean {
  return POSIX_SLEEP.test(command) || (isWindows && POWERSHELL_SLEEP.test(command))
}

/** The Node helper the Windows shims run, which stands in for the shell script a POSIX shim is. */
export const SHIM_HELPER_NAME = '_shim.cjs'
/**
 * The helper's source, kept as a string because the bundler does not copy a loose file into the built plugin.
 * It runs the program a shim stands in for, and reports a shim's own failure when the shim blocks a command.
 */
export const SHIM_HELPER_SOURCE = String.raw`// # Written by dsh-superagent on every start; edits are lost.
'use strict'
// Runs the program a dsh-superagent shim stands in for. The .cmd wrapper hands over the program and the failure
// message through the environment, because a batch file cannot pass arguments the way a shell script does.
const { spawnSync } = require('node:child_process')
const { constants } = require('node:os')

const failure = process.env.DSH_SUPERAGENT_SHIM_FAIL || ''
if (failure) {
  process.stderr.write(failure + '\n')
  process.exit(1)
}

const target = process.env.DSH_SUPERAGENT_SHIM_TARGET || ''
if (!target) {
  process.stderr.write('dsh-superagent shim has no program to run\n')
  process.exit(1)
}

// Strip the shim directory from PATH, so a program that resolves the command by name reaches the real binary.
const separator = process.platform === 'win32' ? ';' : ':'
const shimDirectory = __dirname.toLowerCase().replace(/[\\/]+$/, '')
const path = (process.env.PATH || '').split(separator)
  .filter(entry => entry.toLowerCase().replace(/[\\/]+$/, '') !== shimDirectory)
  .join(separator)

const childEnv = Object.assign({}, process.env, { PATH: path })
// Windows cannot start a batch file, so the command interpreter runs it; every other program starts itself.
const batch = /\.(cmd|bat)$/i.test(target)
const result = batch
  ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', target, ...process.argv.slice(2)], { stdio: 'inherit', shell: false, env: childEnv })
  : spawnSync(target, process.argv.slice(2), { stdio: 'inherit', shell: false, env: childEnv })
if (result.error) {
  process.stderr.write(String(result.error.message) + '\n')
  process.exit(1)
}
// A program a signal killed has no exit code; report it the way a shell does.
if (result.signal) process.exit(128 + (constants.signals[result.signal] || 0))
process.exit(typeof result.status === 'number' ? result.status : 1)
`
