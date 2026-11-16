/** Versioned, allowlisted personal-data archive; never a source-code or credential backup. */
export const BACKUP_LIMITS = Object.freeze({ archiveBytes: 48 * 1024 * 1024, decodedBytes: 64 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024, files: 2048, sessions: 128, previews: 2, previewMs: 5 * 60_000 })
export type BackupComponent = 'sessions' | 'memory' | 'knowledge' | 'tasks'
export interface BackupSelection { sessionIds?: string[]; memory?: boolean; knowledge?: boolean; tasks?: boolean }
export interface BackupEntry { path: string; bytes: number; sha256: string; data: string }
export interface BackupManifest {
  format: 'sakuracode-workspace-backup'
  version: 1
  createdAt: string
  components: BackupComponent[]
  sessionIds: string[]
  warnings: string[]
  entries: BackupEntry[]
}
export interface BackupPreview {
  id: string
  fingerprint: string
  expiresAt: number
  createdAt: string
  components: BackupComponent[]
  sessionIds: string[]
  files: number
  bytes: number
  warnings: string[]
}
export class BackupError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'BackupError' }
}
