/** Operator-only version management contracts. Document.version remains the raw UTF-8 SHA-256. */
import type { KnowledgeDocument } from './index.js'

export interface KnowledgeRevision {
  revision: number
  fingerprint: string
}

export interface KnowledgeVersionDocument extends KnowledgeDocument {
  /** Path within this collection version, not a filesystem path supplied by the caller. */
  path: string
}

export interface KnowledgeCollectionVersion {
  id: string
  number: number
  createdAt: number
  kind: 'legacy' | 'managed'
  contentHash: string
  documents: KnowledgeVersionDocument[]
  totalBytes: number
  /** False if any part of this immutable version is missing, changed or unsafe. */
  available: boolean
  error?: string
}

export interface KnowledgeCollection {
  id: string
  name: string
  activeVersionId: string
  versions: KnowledgeCollectionVersion[]
}

export interface KnowledgeLegacyBatch {
  batchId: string
  documents: KnowledgeVersionDocument[]
  totalBytes: number
  contentHash: string
  available: boolean
  error?: string
}

export interface KnowledgeVersionState extends KnowledgeRevision {
  collections: KnowledgeCollection[]
  /** Only explicitly selected top-level legacy directories can be adopted. */
  legacyBatches: KnowledgeLegacyBatch[]
  /** All unadopted documents, including those in legacyBatches. */
  unmanagedDocuments: KnowledgeDocument[]
  /** Workspace-relative unreferenced storage paths; never included in reads or searches. */
  orphans: string[]
  usage: {
    files: number
    bytes: number
    versions: number
    collections: number
    overLimit: boolean
  }
  errors: string[]
}

export interface KnowledgeUpdateInput {
  collectionId: string
  /** The complete replacement file set. An empty set explicitly removes all documents. */
  files: { path: string; content: string }[]
}

export interface KnowledgeUpdatePreview {
  previewId: string
  collectionId: string
  versionId: string
  baseVersionId: string
  baseContentHash: string
  contentHash: string
  expected: KnowledgeRevision
  /** Epoch milliseconds; previews are instance-local, single-use and do not survive restart. */
  expiresAt: number
  diff: { added: string[]; removed: string[]; modified: string[]; unchanged: string[] }
  documents: KnowledgeVersionDocument[]
  totalBytes: number
}

export interface KnowledgeVersionMutation extends KnowledgeVersionState {
  collectionId: string
  versionId: string
}

/** Internal disk schema. Never accept stored source/ID strings as filesystem authority. */
export interface StoredKnowledgeFile {
  path: string
  hash: string
  bytes: number
  lines: number
}

export interface StoredKnowledgeVersion {
  id: string
  number: number
  createdAt: number
  kind: 'legacy' | 'managed'
  /** One legacy directory name, or exactly id for managed versions. */
  directory: string
  contentHash: string
  files: StoredKnowledgeFile[]
}

export interface StoredKnowledgeCollection {
  id: string
  name: string
  activeVersionId: string
  versions: StoredKnowledgeVersion[]
}

export interface KnowledgeManifest {
  version: 1
  revision: number
  collections: StoredKnowledgeCollection[]
}
