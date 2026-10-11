/** Regressions for the desktop launch pipe: settings parsing, the harness
 *  getter (it must follow workspace switches) and the persist callback that
 *  keeps DPAPI key storage on the launcher side. */
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { parseDesktopLaunch, startDesktopHost, type DesktopLaunch } from "../src/desktop/host.js"
import type { DesktopSettingsState } from "../src/web/server.js"
async function makeWorkspace(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  return dir
}


function baseLaunch(cwd: string): DesktopLaunch {
  return { cwd, approvalMode: 'default' }
}

describe('desktop host', () => {
  it('parses recent workspaces and the remember flag', async () => {
    const workspace = await makeWorkspace('sakura-host-parse-')
    try {
      const launch = await parseDesktopLaunch({
        ...baseLaunch(workspace),
        recentWorkspaces: [path.join(workspace, 'a'), path.join(workspace, 'b')],
        rememberKey: true,
      })
      expect(launch.recentWorkspaces).toEqual([path.resolve(workspace, 'a'), path.resolve(workspace, 'b')])
      expect(launch.rememberKey).toBe(true)
      expect(() => parseDesktopLaunch({ ...baseLaunch(workspace), recentWorkspaces: ['relative/path'] })).toThrow()
      expect(() => parseDesktopLaunch({ ...baseLaunch(workspace), recentWorkspaces: [path.join(workspace, 'x') + '\0'] })).toThrow()
      expect(() => parseDesktopLaunch({ ...baseLaunch(workspace), rememberKey: 'yes' as unknown as boolean })).toThrow()
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })

  it('exposes a live harness through workspace switches and forwards persisted settings', async () => {
    const workspace = await makeWorkspace('sakura-host-persist-')
    const other = await makeWorkspace('sakura-host-persist-other-')
    const persisted: DesktopSettingsState[] = []
    try {
      const handle = await startDesktopHost({ ...baseLaunch(workspace), recentWorkspaces: [] }, (settings) => persisted.push(settings))
      try {
        const post = (body: unknown) => fetch(handle.url + 'api/desktop/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const initial = handle.harness
        expect(initial).toBeDefined()

        // The key only rides the private pipe while the remember flag is on.
        await post({ apiKey: 'host-secret', rememberKey: true })
        await post({ rememberKey: false })
        expect(persisted.map((entry) => entry.apiKey)).toEqual(['host-secret', undefined])

        await (await post({ workspace: other })).json()
        expect(handle.harness).not.toBe(initial)
        expect(persisted.at(-1)?.workspace).toBe(other)
        // The recent list starts with the current workspace.
        expect(persisted.at(-1)?.recentWorkspaces).toEqual([other, workspace])
      } finally {
        await handle.close()
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
      await fs.rm(other, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })
})
