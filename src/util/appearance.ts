/** Non-secret display preferences, independent of workspace/model settings. */
export const QUOTA_DISPLAY_MODES = ['always', 'hover', 'settings'] as const
export type QuotaDisplayMode = typeof QUOTA_DISPLAY_MODES[number]

export interface DesktopAppearance {
  quotaDisplay: QuotaDisplayMode
}

export function parseQuotaDisplay(value: unknown): QuotaDisplayMode {
  if (!QUOTA_DISPLAY_MODES.includes(value as QuotaDisplayMode)) {
    throw new Error('额度显示方式须为常驻、悬停弹出或仅在设置中显示。')
  }
  return value as QuotaDisplayMode
}