export type GitReviewRange = 'staged' | 'unstaged' | 'baseline' | 'untracked'
export type GitPatchRange = Exclude<GitReviewRange, 'untracked'>
export type GitReviewStatus = 'ready' | 'unborn' | 'not_repository' | 'git_unavailable'
export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'type_changed' | 'conflicted' | 'untracked'

export interface GitReviewLimits {
  maxFiles: number
  maxUntrackedFiles: number
  maxSelectedUntracked: number
  maxFileBytes: number
  maxTotalBytes: number
  maxOutputBytes: number
  maxPatchBytes: number
  maxMetadataBytes: number
  maxStoreBytes: number
  timeoutMs: number
  maxConcurrent: number
}

export const GIT_REVIEW_LIMITS: Readonly<GitReviewLimits> = Object.freeze({
  maxFiles: 2_000,
  maxUntrackedFiles: 2_000,
  maxSelectedUntracked: 32,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxPatchBytes: 4 * 1024 * 1024,
  maxMetadataBytes: 8 * 1024 * 1024,
  maxStoreBytes: 512 * 1024,
  timeoutMs: 30_000,
  maxConcurrent: 2,
})

export interface GitReviewOptions {
  /** Trusted application configuration only, never a request parameter. Must be absolute. */
  gitPath?: string
  limits?: Partial<GitReviewLimits>
}

export interface GitSnapshotOptions {
  /** HEAD, a full local object ID, or an unambiguous local branch/tag/ref. No revision expressions. */
  baseRef?: string
  /** Explicit opt-in to reading these otherwise metadata-only untracked paths. Repository-relative. */
  selectedUntracked?: string[]
  signal?: AbortSignal
}

/** Raw-byte code state. Review state and other untracked files do not participate. */
export interface GitTrackedFingerprint {
  status: GitReviewStatus
  repositoryId: string | null
  headOid: string | null
  scope: string | null
  fingerprint: string | null
  includesUntracked: false
  /** Nested repositories are not traversed: gitlink/index/current submodule HEAD only. */
  submodules: 'gitlink-only'
  normalization: 'raw-bytes-no-filters'
}

export interface GitConflictStage {
  stage: 1 | 2 | 3
  oid: string
  mode: string
}

export interface GitReviewFile {
  id: string
  range: GitReviewRange
  status: GitChangeStatus
  /** Paths are repository-relative, literal UTF-8 names, not pathspec expressions. */
  path: string
  oldPath: string | null
  newPath: string | null
  oldMode: string | null
  newMode: string | null
  oldOid: string | null
  newOid: string | null
  oldBytes: number | null
  newBytes: number | null
  binary: boolean
  conflict: boolean
  submodule: boolean
  symlink: boolean
  /** null explicitly means nested dirty state was not inspected. */
  submoduleDirty?: null
  conflictStages?: GitConflictStage[]
  similarity?: number
  oldLinkTarget?: string
  newLinkTarget?: string
  /** Unmodified, complete Git-generated patch for this tracked change; absent for special files. */
  patch?: string
  /** Only explicitly selected, regular UTF-8 untracked files expose text. */
  text?: string
  selected?: boolean
  fingerprint: string
  reviewed: boolean
  exportable: boolean
}

export interface GitReviewSnapshot {
  status: GitReviewStatus
  message?: string
  repositoryRoot: string | null
  repositoryId: string | null
  workspaceRoot: string
  /** Empty string means the entire repository; otherwise a repository-relative directory. */
  scope: string | null
  headOid: string | null
  base: { requestedRef: string; oid: string | null }
  snapshotId: string
  trackedFingerprint: GitTrackedFingerprint
  storeFingerprint: string
  selectedUntracked: string[]
  ranges: Record<GitReviewRange, GitReviewFile[]>
  /** A snapshot is either complete within its limits or fails; it is never silently truncated. */
  complete: true
  normalization: 'raw-bytes-no-filters'
}

export interface GitMarkReviewedRequest extends GitSnapshotOptions {
  expectedSnapshotId: string
  expectedStoreFingerprint?: string
  fileId: string
  reviewed: boolean
}

export interface GitReadUntrackedRequest extends GitSnapshotOptions {
  expectedSnapshotId: string
  path: string
}

export interface GitExportPatchRequest extends GitSnapshotOptions {
  expectedSnapshotId: string
  range: GitPatchRange
  fileIds: string[]
}

export interface GitPatchExport {
  patch: string
  byteLength: number
  filename: string
  snapshotId: string
  range: GitPatchRange
}

export type GitReviewErrorCode =
  | 'INVALID_ARGUMENT' | 'INVALID_REF' | 'UNSAFE_PATH' | 'UNSAFE_REPOSITORY'
  | 'UNSUPPORTED_REPOSITORY' | 'GIT_FAILED' | 'LIMIT_EXCEEDED' | 'CANCELLED' | 'TIMEOUT'
  | 'BUSY' | 'STALE_SNAPSHOT' | 'UNSUPPORTED_FILE' | 'STORE_CORRUPT' | 'UNSAFE_STORE'
  | 'STORE_BUSY' | 'STALE_STORE' | 'STATE_CHANGED'

export class GitReviewError extends Error {
  readonly code: GitReviewErrorCode
  readonly status: number

  constructor(code: GitReviewErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'GitReviewError'
    this.code = code
    this.status = status
  }
}
