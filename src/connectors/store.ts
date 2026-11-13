/** Workspace metadata only. Saving never opens a connection or executes software. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, promises as fs, type Stats } from 'node:fs'
import * as path from 'node:path'
import { ConnectorError, CONNECTOR_LIMITS, type ConnectorConfig, type ConnectorRevision } from './types.js'
import { validateConnector } from './validation.js'

interface Stored { version: 1; revision: number; connections: ConnectorConfig[] }
export interface ConnectorStoreSnapshot extends ConnectorRevision { connections: ConnectorConfig[]; error?: string }
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const fingerprint = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.nlink}`
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))

export class ConnectorStore {
  readonly file: string
  private readonly dir: string
  private readonly configured: ConnectorConfig[]
  private state: ConnectorStoreSnapshot
  private chain: Promise<unknown> = Promise.resolve()

  constructor(cwd: string, configured: readonly ConnectorConfig[] = []) {
    this.dir = path.join(path.resolve(cwd), '.sakura')
    this.file = path.join(this.dir, 'connectors.json')
    const connections = this.validateList(configured)
    this.configured = copy(connections)
    this.state = { revision: 0, fingerprint: hash('missing'), connections }
  }
  snapshot(): ConnectorStoreSnapshot { return copy(this.state) }
  private validateList(value: unknown): ConnectorConfig[] {
    if (!Array.isArray(value) || value.length > CONNECTOR_LIMITS.connections) throw new ConnectorError(400, 'at most 32 connectors are supported')
    const result = value.map(validateConnector)
    if (new Set(result.map(row => row.id.toLowerCase())).size !== result.length) throw new ConnectorError(400, 'connector IDs must be unique, including case')
    return result
  }
  private async directory(create = false): Promise<boolean> {
    if (create) await fs.mkdir(this.dir, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    let stat: Stats
    try { stat = await fs.lstat(this.dir) } catch (error) { if (missing(error)) return false; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ConnectorError(409, 'connector metadata directory cannot be a link')
    return true
  }
  private async disk(): Promise<ConnectorStoreSnapshot> {
    if (!await this.directory()) return { revision: 0, fingerprint: hash('missing'), connections: copy(this.configured) }
    let stat: Stats
    try { stat = await fs.lstat(this.file) } catch (error) { if (missing(error)) return { revision: 0, fingerprint: hash('missing'), connections: copy(this.configured) }; throw error }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > CONNECTOR_LIMITS.responseBytes) throw new ConnectorError(409, 'connector metadata must be a bounded ordinary file')
    const handle = await fs.open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let raw: string
    try {
      if (fingerprint(await handle.stat()) !== fingerprint(stat)) throw new ConnectorError(409, 'connector metadata changed while opening')
      const buffer = Buffer.alloc(CONNECTOR_LIMITS.responseBytes + 1)
      let size = 0
      while (size < buffer.length) {
        const chunk = await handle.read(buffer, size, buffer.length - size, null)
        if (!chunk.bytesRead) break
        size += chunk.bytesRead
      }
      if (size > CONNECTOR_LIMITS.responseBytes) throw new ConnectorError(409, 'connector metadata exceeds its byte budget')
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)) }
      catch { throw new ConnectorError(409, 'connector metadata is not valid UTF-8') }
      if (fingerprint(await handle.stat()) !== fingerprint(stat)) throw new ConnectorError(409, 'connector metadata changed while reading')
    } finally { await handle.close() }
    if (fingerprint(await fs.lstat(this.file)) !== fingerprint(stat)) throw new ConnectorError(409, 'connector metadata was replaced while reading')
    let parsed: Stored
    try { parsed = JSON.parse(raw) } catch { throw new ConnectorError(409, 'connector metadata is invalid; original file was preserved') }
    if (!parsed || parsed.version !== 1 || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || Object.keys(parsed).some(key => !['version', 'revision', 'connections'].includes(key))) throw new ConnectorError(409, 'unsupported connector metadata')
    return { revision: parsed.revision, fingerprint: hash(raw), connections: this.validateList(parsed.connections) }
  }
  async reload(): Promise<ConnectorStoreSnapshot> {
    try { this.state = await this.disk() }
    catch (error) { this.state = { ...this.state, error: error instanceof ConnectorError ? error.message : 'connector metadata could not be read' } }
    return this.snapshot()
  }
  async save(connections: readonly ConnectorConfig[], expected: ConnectorRevision, assertCurrent: () => void = () => {}): Promise<ConnectorStoreSnapshot> {
    const next = this.validateList(connections)
    if (!expected || !Number.isSafeInteger(expected.revision) || expected.revision < 0 || typeof expected.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expected.fingerprint)) throw new ConnectorError(400, 'a current connector revision and fingerprint are required')
    const operation = this.chain.catch(() => {}).then(async () => {
      assertCurrent()
      await this.directory(true)
      const lockFile = path.join(this.dir, 'connectors.lock'), owner = randomUUID()
      let lock
      try { lock = await fs.open(lockFile, 'wx', 0o600) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConnectorError(409, 'connector metadata is locked; original file was preserved'); throw error }
      let temp: string | undefined
      try {
        await lock.writeFile(owner)
        const current = await this.disk()
        if (current.revision !== expected.revision || current.fingerprint !== expected.fingerprint) throw new ConnectorError(409, 'connector metadata changed; reload before saving')
        if (current.revision === Number.MAX_SAFE_INTEGER) throw new ConnectorError(409, 'connector metadata revision is exhausted')
        const raw = JSON.stringify({ version: 1, revision: current.revision + 1, connections: next }, null, 2) + '\n'
        if (Buffer.byteLength(raw) > CONNECTOR_LIMITS.responseBytes) throw new ConnectorError(413, 'connector metadata exceeds its budget')
        temp = path.join(this.dir, `.connectors-${randomUUID()}.tmp`)
        const handle = await fs.open(temp, 'wx', 0o600)
        try { await handle.writeFile(raw, 'utf8'); await handle.sync() } finally { await handle.close() }
        const latest = await this.disk()
        if (latest.fingerprint !== current.fingerprint) throw new ConnectorError(409, 'connector metadata changed during save; original file was preserved')
        await this.directory()
        assertCurrent()
        await fs.rename(temp, this.file)
        temp = undefined
        this.state = { revision: current.revision + 1, fingerprint: hash(raw), connections: copy(next) }
        return this.snapshot()
      } finally {
        if (temp) await fs.unlink(temp).catch(() => {})
        const owned = await lock.stat()
        await lock.close()
        const latest = await fs.lstat(lockFile).catch(() => undefined)
        if (latest?.isFile() && !latest.isSymbolicLink() && fingerprint(latest) === fingerprint(owned)) await fs.unlink(lockFile).catch(() => {})
      }
    })
    this.chain = operation
    try { return await operation }
    catch (error) { if (error instanceof ConnectorError) throw error; throw new ConnectorError(500, 'connector metadata could not be saved; existing file was preserved') }
  }
}
