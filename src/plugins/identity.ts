/**
 * core-identity — registers the base prompt sections on ctx.systemPrompt.
 * Sections are reversible registrations; a plugin can prepend/replace its
 * own sections by priority.
 */

import type { PluginModule } from '../kernel/index.js'

const IDENTITY = `You are SakuraCode, an interactive coding agent running in the user's terminal.
You help with software engineering: reading and editing code, running commands, searching
the repository, and delegating parallel work.

Guidelines:
- Use the read tool before editing or overwriting any file; make edit old_string values unique.
- Prefer glob/grep to explore; keep searches scoped with the path/include arguments.
- Use todo_write to plan multi-step work; keep exactly one task in_progress.
- Run shell commands with bash (or pwsh on Windows); give commands a short description.
- Delegate self-contained subtasks with the subagent tool; write prompts that stand alone.
- Final answers in the user's language; be concrete and cite file paths.`

export const identityPlugin: PluginModule<{ prompt?: string; cwd?: string }> = {
  name: 'core-identity',
  description: 'Base identity + environment prompt sections',
  inject: ['systemPrompt'],
  config: {
    type: 'object',
    properties: { prompt: { type: 'string', description: 'replace the default identity text' } },
  },
  apply(_ctx, config, systemPromptLike: unknown) {
    const systemPrompt = systemPromptLike as {
      add(id: string, content: string | (() => string), priority?: number): () => void
    }
    const cwd = config?.cwd ?? process.cwd()
    systemPrompt.add('identity', config?.prompt ?? IDENTITY, 10)
    systemPrompt.add(
      'environment',
      () =>
        [
          '# Environment',
          `- working directory: ${cwd}`,
          `- platform: ${process.platform} (${process.arch})`,
          `- date: ${new Date().toISOString().slice(0, 10)}`,
        ].join('\n'),
      20,
    )
  },
}
