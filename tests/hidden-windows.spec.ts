import { describe, expect, it, vi } from 'vitest'

const child = vi.hoisted(() => ({
  execFile: vi.fn((_file: string, _args: string[], _options: Record<string, unknown>,
    callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    callback?.(null, { stdout: '', stderr: '' })
    return {}
  }),
  spawn: vi.fn(() => ({ pid: 1 })),
}))

vi.mock('node:child_process', () => ({ execFile: child.execFile, spawn: child.spawn }))

import { Commands } from '../src/infra/commands.ts'
import { spawnEventConsumer } from '../src/sources/feishu-loops.ts'
import { testDeployment } from './fixtures/deployment.ts'

describe('console windows', () => {
  it('runs a CLI without opening a console window on the operator\'s desktop', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    await commands.run('gh', ['api', 'some-path'])
    expect((child.execFile.mock.calls[0] as unknown[])[2]).toMatchObject({ windowsHide: true })
  })
  it('starts the Feishu event consumer without opening a console window', () => {
    spawnEventConsumer({ file: 'lark-cli', args: ['event', 'consume'] })
    expect((child.spawn.mock.calls[0] as unknown[])[2]).toMatchObject({ windowsHide: true })
  })
})
