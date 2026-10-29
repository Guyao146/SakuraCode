/** Public numerical viewport evidence from the private native launcher. No URLs, handles or credentials. */
export interface DesktopViewport { width: number; height: number; dpi: number; version: number }
export function parseDesktopViewport(value: unknown): DesktopViewport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (!Number.isSafeInteger(row.width) || Number(row.width) < 1 || Number(row.width) > 32768 ||
      !Number.isSafeInteger(row.height) || Number(row.height) < 1 || Number(row.height) > 32768 ||
      !Number.isSafeInteger(row.dpi) || Number(row.dpi) < 48 || Number(row.dpi) > 960 ||
      !Number.isSafeInteger(row.version) || Number(row.version) < 1) return null
  return { width: Number(row.width), height: Number(row.height), dpi: Number(row.dpi), version: Number(row.version) }
}