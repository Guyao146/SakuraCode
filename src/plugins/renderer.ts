/**
 * ui-renderer — terminal rendering as a plugin. It only listens to ui/*
 * events the agent loop emits, so the loop never imports UI code.
 * Modes: 'repl' streams the main agent's text live; 'headless' buffers the
 * answer and prints it at turn end (like zcode -p).
 */

import type { PluginModule } from '../kernel/index.js'
import { renderTodos, type Todo } from '../tools/todo.js'

export interface RendererConfig {
  mode?: 'repl' | 'headless'
  color?: boolean
  showToolOutput?: boolean
}

const dim = (s: string, on: boolean) => (on ? `\x1b[2m${s}\x1b[0m` : s)
const green = (s: string, on: boolean) => (on ? `\x1b[32m${s}\x1b[0m` : s)
const red = (s: string, on: boolean) => (on ? `\x1b[31m${s}\x1b[0m` : s)
const yellow = (s: string, on: boolean) => (on ? `\x1b[33m${s}\x1b[0m` : s)

function previewArgs(raw: string, max = 100): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const parts = Object.entries(parsed).map(([k, v]) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}: ${text.length > 60 ? text.slice(0, 60) + '…' : text}`
    })
    const joined = parts.join(', ')
    return joined.length > max ? joined.slice(0, max) + '…' : joined
  } catch {
    return raw.slice(0, max)
  }
}

interface UITextPayload {
  agentId: string
  delta: string
  main?: boolean
}

interface UITurnEndPayload {
  agentId?: string
  cancelled?: boolean
  error?: string
  main?: boolean
}

export const rendererPlugin: PluginModule<RendererConfig> = {
  name: 'ui-renderer',
  description: 'Terminal rendering driven by ui/* events',
  apply(_ctx, config) {
    const mode = config?.mode ?? 'repl'
    const color = config?.color ?? process.stdout.isTTY ?? false
    const showToolOutput = config?.showToolOutput ?? true
    // Buffered final answer per agent (headless mode). A single shared buffer
    // made the printed answer depend on the per-event `main` claim alone: a
    // ui/text carrying `main: true` from a *different* agent (a mislabeling or
    // third-party emitter, or a helper spawned with meta.role 'main' — a role
    // ctx.agents.spawn accepts, and the role harness.main() looks for) was
    // appended to the main agent's answer. Keying by agentId ties every delta
    // to the one turn allowed to flush it, so a subagent's stream can never
    // reach the main answer.
    const answers = new Map<string, string>()
    let streamedAny = false

    // Track the last written char so separators insert exactly one newline —
    // never zero (mangled lines) and never two (blank gaps).
    let lastChar = ''
    const write = (s: string) => {
      process.stdout.write(s)
      lastChar = s[s.length - 1] ?? lastChar
    }
    // Headless stdout is reserved for the answer itself; tool noise and
    // turn notices go to stderr so pipes stay clean.
    const writeErr = (s: string) => process.stderr.write(s)
    const diag = (s: string) => (mode === 'headless' ? writeErr(s) : write(s))
    // Producers must carry the same agentId on ui/text and ui/turn/end (the
    // agent loop always does); a missing id becomes its own bucket.
    const agentKey = (agentId?: string): string => agentId ?? ''

    // Thinking markers: only explicitly-main reasoning prints, and the answer
    // always starts on a fresh line (exactly one — no doubled newlines).
    let thinkingPending = false
    let thinkingEndedNewline = false
    // Consecutive thinking chunks form one block — no newline between them.
    let inThinking = false
    const endThinkingGap = () => {
      if (!thinkingPending) return
      if (!thinkingEndedNewline && lastChar && lastChar !== '\n') write('\n')
      thinkingPending = false
      inThinking = false
    }

    _ctx.on('ui/text', (payload: UITextPayload) => {
      if (!payload.main) return
      if (mode === 'repl') {
        endThinkingGap()
        write(payload.delta)
        streamedAny = true
      } else {
        const key = agentKey(payload.agentId)
        answers.set(key, (answers.get(key) ?? '') + payload.delta)
      }
    })

    _ctx.on('ui/tool/call', (payload: { name: string; argsRaw: string; main?: boolean }) => {
      endThinkingGap()
      if (mode === 'repl' && streamedAny && payload.main) write('\n')
      diag(dim(`● ${payload.name}(${previewArgs(payload.argsRaw)})`, color) + '\n')
    })

    _ctx.on('ui/thinking', (payload: { delta?: string; text?: string; main?: boolean }) => {
      if (mode !== 'repl') return
      // Reasoning is the model's scratchpad — dim it so the answer stays
      // visually primary, same role as the collapsed blocks in the GUI.
      // Subagent and unlabeled reasoning is never interleaved with the main
      // stream; it belongs to the agent's own card elsewhere.
      if (payload.main !== true) return
      const delta = payload.delta ?? payload.text ?? ''
      if (!delta) return
      if (!inThinking && lastChar && lastChar !== '\n') write('\n')
      inThinking = true
      write(dim(delta, color))
      thinkingPending = true
      thinkingEndedNewline = delta.endsWith('\n')
    })

    _ctx.on(
      'ui/tool/result',
      (payload: { name: string; output: string; isError?: boolean }) => {
        if (!showToolOutput) return
        const first = payload.output.split('\n').find((l) => l.trim()) ?? ''
        const line = first.length > 140 ? first.slice(0, 140) + '…' : first
        diag(dim(payload.isError ? red(`  ⚠ ${line}`, color) : `  ⎿ ${line}`, color) + '\n')
      },
    )

    _ctx.on('ui/todos', (payload: { todos: Todo[] }) => {
      diag(dim('\n' + renderTodos(payload.todos) + '\n', color))
    })

    _ctx.on('ui/turn/end', (payload: UITurnEndPayload) => {
      // Only a main-agent turn end may flush the answer buffer — a subagent
      // finishing mid-turn must not print it early.
      const isMain = payload.main !== false
      const key = agentKey(payload.agentId)
      if (mode === 'headless') {
        if (isMain) {
          if (payload.cancelled) writeErr(yellow('\n[interrupted]', color) + '\n')
          if (payload.error) writeErr(red(`\n[error] ${payload.error}`, color) + '\n')
          const buffered = answers.get(key) ?? ''
          if (buffered.trim()) write('\n' + buffered.trim() + '\n')
        }
      } else {
        if (payload.cancelled && isMain) write(yellow('\n[interrupted]', color) + '\n')
        if (payload.error) {
          write(red(isMain ? `\n[error] ${payload.error}` : `  [subagent error] ${payload.error}`, color) + '\n')
        }
        if (streamedAny && isMain) write('\n')
      }
      // An ending turn drops only its own buffer: a subagent turn end must
      // neither flush nor discard the main agent's buffered answer.
      answers.delete(key)
      if (isMain) streamedAny = false
    })
  },
}
