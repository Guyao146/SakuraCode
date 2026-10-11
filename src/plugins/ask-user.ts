/**
 * core-interaction + tool-ask-user — interactive question asking.
 *
 * interactionPlugin registers ctx.interaction: a tiny service the ask_user
 * tool (and any other plugin) uses to put a question to the user. UIs listen
 * on interaction/request and answer through setHandler; without a handler
 * ask() resolves with a null answer immediately so headless runs never block.
 *
 * The ask_user tool is for genuine decision points: choosing between clear
 * options the user cares about, or missing key information that cannot be
 * obtained with the other tools. It is deliberately not for things the agent
 * can look up itself.
 */

import type { Context, Plugin } from '../kernel/index.js'
import { params, type ToolsService } from '../core/tools.js'

export interface QuestionRequest {
  id: string
  question: string
  options: string[]
}

export type QuestionHandler = (req: QuestionRequest) => Promise<string | null> | string | null

export interface InteractionService {
  /** Set (or clear) the UI's answer handler; without one ask() resolves null. */
  setHandler(handler: QuestionHandler | undefined): void
  /** Emit interaction/request, collect the answer, emit interaction/resolved. */
  ask(req: Omit<QuestionRequest, 'id'> & { id?: string }): Promise<{ id: string; answer: string | null }>
}

class InteractionServiceImpl implements InteractionService {
  private handler: QuestionHandler | undefined

  constructor(private readonly ctx: Context) {}

  setHandler(handler: QuestionHandler | undefined): void {
    this.handler = handler
  }

  async ask(req: Omit<QuestionRequest, 'id'> & { id?: string }): Promise<{ id: string; answer: string | null }> {
    const id = req.id ?? `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const question = req.question
    const options = req.options ?? []
    this.ctx.emit('interaction/request', { id, question, options })
    let answer: string | null = null
    if (this.handler) {
      try {
        const result = await this.handler({ id, question, options })
        answer = typeof result === 'string' ? result : null
      } catch {
        answer = null // a broken handler must not fail the tool call
      }
    }
    this.ctx.emit('interaction/resolved', { id, answer })
    return { id, answer }
  }
}

export const interactionPlugin: Plugin = {
  name: 'core-interaction',
  description: 'Interactive question service (ctx.interaction) — request/resolved events plus an answer handler',
  apply(ctx) {
    ctx.provide('interaction')
    ctx.set('interaction', new InteractionServiceImpl(ctx))
  },
}

/** Per-option cap, in characters. */
const OPTION_LIMIT = 120

export const askUserToolsPlugin: Plugin = {
  name: 'tool-ask-user',
  description: 'ask_user — ask the user a question (optional 2-4 options) and wait for the reply',
  inject: ['tools', 'interaction'] as const,
  apply(_ctx, _config, toolsLike: unknown, interactionLike: unknown) {
    const tools = toolsLike as ToolsService
    const interaction = interactionLike as InteractionService

    tools.register({
      name: 'ask_user',
      description:
        'Ask the user a question and wait for their reply. Use it when the user must decide between ' +
        'clear alternatives, or when key information is missing and cannot be obtained with the other ' +
        'tools. With options the user picks one (provide 2-4); without options they answer in free ' +
        'text. Do not overuse: never ask for anything you can find out yourself.',
      kind: 'execute',
      parameters: params(
        {
          question: { type: 'string', description: 'The question to put to the user.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 4,
            description: '2-4 answer choices the user picks from; omit for a free-form answer.',
          },
        },
        ['question'],
      ),
      async execute(args) {
        const question = typeof args.question === 'string' ? args.question.trim() : ''
        if (!question) {
          return { output: 'error: ask_user requires a non-empty "question"', isError: true }
        }
        const rawOptions = Array.isArray(args.options) ? args.options : []
        if (rawOptions.length === 1 || rawOptions.length > 4) {
          return { output: 'error: "options" must be omitted, empty, or contain 2-4 entries', isError: true }
        }
        const options = rawOptions.map((o) => truncate(String(o), OPTION_LIMIT))
        const { answer } = await interaction.ask({ question, options })
        return {
          output:
            answer === null ? '(no answer — proceed with your best judgment)' : `User answered: ${answer}`,
        }
      },
    })
  },
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max)
}
