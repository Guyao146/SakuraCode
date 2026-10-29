/** A real long-lived preview server owned by the harness background-job registry. */
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { JobsService } from '../src/core/jobs.js'

const exec = promisify(execFile)

export async function startHistoryBackgroundPreview(jobs: JobsService, cwd: string) {
  const script = path.join(cwd, 'history-background-preview.cjs')
  await fs.writeFile(script, `const http = require('node:http');
const server = http.createServer((_req, res) => { res.end('HISTORY_BACKGROUND_PREVIEW_ALIVE'); });
server.listen(0, '127.0.0.1', () => console.log('HISTORY_PREVIEW_URL=http://127.0.0.1:' + server.address().port));
`)
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  const quote = (value: string) => "'" + value.replaceAll("'", shell === 'pwsh' ? "''" : "'\\''") + "'"
  const job = jobs.start((shell === 'pwsh' ? '& ' : '') + quote(process.execPath) + ' ' + quote(script), shell, cwd)
  async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 8000
    while (!check()) {
      if (Date.now() > deadline) throw new Error('Synthetic background preview did not settle: ' + jobs.output(job.id))
      await delay(25)
    }
  }
  async function stop(): Promise<void> {
    if (process.platform === 'win32' && job.proc?.pid && job.status === 'running') {
      // Await the whole tree before its shell exits; a direct shell kill can
      // otherwise orphan the Node server before taskkill discovers it.
      job.killedByUs = true
      await exec('taskkill.exe', ['/PID', String(job.proc.pid), '/T', '/F'], { windowsHide: true })
    } else jobs.kill(job.id)
    await waitFor(() => job.status !== 'running')
  }
  try {
    await waitFor(() => /HISTORY_PREVIEW_URL=http:\/\/127\.0\.0\.1:\d+/.test(jobs.output(job.id) ?? '') || job.status !== 'running')
    const url = jobs.output(job.id)?.match(/HISTORY_PREVIEW_URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1]
    if (!url || job.status !== 'running') throw new Error('Synthetic background preview failed: ' + jobs.output(job.id))
    return { job, url, stop }
  } catch (error) { await stop(); throw error }
}