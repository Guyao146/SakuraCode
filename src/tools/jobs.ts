/**
 * tool-jobs — job_list / job_output / job_kill over ctx.jobs.
 */

import type { PluginModule } from '../kernel/index.js'
import type { JobsService } from '../core/jobs.js'
import type { ToolsService } from '../core/tools.js'

export const jobToolsPlugin: PluginModule = {
  name: 'tool-jobs',
  description: 'job_list / job_output / job_kill — manage background jobs',
  inject: ['tools', 'jobs'],
  apply(_ctx, _config, toolsLike: unknown, jobsLike: unknown) {
    const tools = toolsLike as ToolsService
    const jobs = jobsLike as JobsService

    tools.register({
      name: 'job_list',
      description: 'List background jobs with status.',
      kind: 'read',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const list = jobs.list()
        if (!list.length) return { output: 'no background jobs' }
        return {
          output: list
            .map((j) => `${j.id}  ${j.status.padEnd(7)}  ${String(j.exitCode ?? '')}  ${j.command.slice(0, 80)}`)
            .join('\n'),
        }
      },
    })

    tools.register({
      name: 'job_output',
      description: 'Read captured output of a background job.',
      kind: 'read',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Job id, e.g. "job-1".' } },
        required: ['id'],
      },
      execute: async (args) => {
        const text = jobs.output(String(args.id ?? ''))
        if (text === undefined) return { output: `error: unknown job "${args.id}"`, isError: true }
        return { output: text || '(no output yet)' }
      },
    })

    tools.register({
      name: 'job_kill',
      description: 'Kill a running background job.',
      kind: 'execute',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Job id to kill.' } },
        required: ['id'],
      },
      execute: async (args) => {
        const ok = jobs.kill(String(args.id ?? ''))
        return { output: ok ? `killed ${args.id}` : `error: job "${args.id}" is not running`, isError: !ok }
      },
    })
  },
}
