/**
 * ctx.systemPrompt — prompt/tool-schema assembly. Sections are registered
 * with a priority (lower runs first); assemble() joins them. The assembled
 * prompt is logged into the session as a system/message — the prompt travels
 * only as system/message history.
 */

export interface PromptSection {
  id: string
  content: string | (() => string)
  priority: number
}

export class SystemPromptService {
  private sections = new Map<string, PromptSection>()

  /** Register a section; returns a disposer (reversible registration). */
  add(id: string, content: string | (() => string), priority = 100): () => void {
    this.sections.set(id, { id, content, priority })
    return () => this.sections.delete(id)
  }

  has(id: string): boolean {
    return this.sections.has(id)
  }

  /** Join sections by priority; empty renderings drop out. */
  assemble(): string {
    return [...this.sections.values()]
      .sort((a, b) => a.priority - b.priority)
      .map((s) => (typeof s.content === 'function' ? s.content() : s.content))
      .filter((text) => text.trim().length > 0)
      .join('\n\n')
  }
}

export const systemPromptPlugin = {
  name: 'core-system-prompt',
  description: 'Prompt assembly from reversible sections (ctx.systemPrompt)',
  apply(ctx: import('../kernel/index.js').Context) {
    ctx.provide('systemPrompt')
    ctx.set('systemPrompt', new SystemPromptService())
  },
}
