/** Only the three supported non-secret display preferences cross the launch pipe. */
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDesktopLaunch } from '../src/desktop/host.js'
import { parseQuotaDisplay, QUOTA_DISPLAY_MODES } from '../src/util/appearance.js'

describe('quota display preferences', () => {
  it.each(QUOTA_DISPLAY_MODES)('accepts %s without modifying other launch settings', mode => {
    expect(parseQuotaDisplay(mode)).toBe(mode)
    const cwd = path.resolve('appearance-fixture')
    const launch = parseDesktopLaunch({ cwd, appearance: { quotaDisplay: mode }, apiKey: 'SYNTHETIC_LEGACY_KEY',
      workspacePrefs: { [cwd]: { sessionDir: 'history', agents: [], contextBudget: {
        contextWindowTokens: 128000, thresholdPercent: 70, autoThreshold: 0,
      } } } })
    expect(launch.appearance).toEqual({ quotaDisplay: mode })
    expect(launch.apiKey).toBe('SYNTHETIC_LEGACY_KEY')
    expect(launch.workspacePrefs?.[cwd]?.contextBudget?.thresholdPercent).toBe(70)
  })

  it('supports older launchers with no appearance field', () => {
    const cwd = path.resolve('appearance-fixture')
    expect(parseDesktopLaunch({ cwd }).appearance).toBeUndefined()
    expect(parseDesktopLaunch({ cwd, appearance: null }).appearance).toBeUndefined()
  })

  it('rejects invalid modes and malformed or mixed launch preferences', () => {
    const cwd = path.resolve('appearance-fixture')
    for (const value of [undefined, null, '', 'ALWAYS', 'never', 0, true, [], {}, ['hover']]) {
      expect(() => parseQuotaDisplay(value)).toThrow(/额度显示方式/)
    }
    for (const appearance of ['hover', [], {}, { quotaDisplay: 'invalid' }, { quotaDisplay: 'hover', apiKey: 'PRIVATE' }]) {
      expect(() => parseDesktopLaunch({ cwd, appearance })).toThrow()
    }
  })
})