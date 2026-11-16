export interface WorktreeOperation { signal?: AbortSignal; assertCurrent?: () => void }
export interface WorktreeOptions { managedRoot?: string; gitPath?: string }
export interface WorktreeInfo { id: string; taskId: string; path: string; dataDir: string; commit: string; repositoryId: string; createdAt: string }
export interface WorktreeFile { path: string; status: 'added' | 'modified' | 'deleted'; baseHash: string | null; sourceHash: string | null; text?: string; integrable: boolean; integrated: boolean }
export interface WorktreeCreatePreview { id: string; fingerprint: string; repositoryId: string; commit: string; taskId: string; files: number; bytes: number; warnings: string[] }
export interface WorktreeRead { worktree: WorktreeInfo; fingerprint: string; files: WorktreeFile[]; warnings: string[] }
export interface WorktreeIntegratePreview { id: string; fingerprint: string; worktreeId: string; files: WorktreeFile[]; conflicts: { path: string; reason: string }[]; canIntegrate: boolean; warnings: string[] }
export class WorktreeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly recoveryPath?: string) { super(message); this.name = 'WorktreeError' }
}
