/**
 * Built-in expert team for the collaborative "expert mode" session. Starting
 * the mode spawns the presets below as background sub-agents; every user
 * message is then delivered to the main agent *and* each live expert, so the
 * team works the same task in parallel from different professional angles.
 *
 * Experts use the 'core' tool policy: all read/write/execute tools, but no
 * nested subagent spawning. They can still coordinate through the
 * subagent-control tools (list_agents / send_message / interrupt_agent),
 * which 'core' keeps available.
 */

import type { ToolPolicy } from './core/agent.js'

export interface ExpertPreset {
  /** Stable key; clients select members with it. */
  key: string
  /** Roster name, unique within a workspace. */
  name: string
  description: string
  tools: ToolPolicy
  systemPrompt: string
}

const COOPERATION_NOTE = (duty: string): string => [
  '你是 SakuraCode 专家团队成员，与主智能体和其他专家并行处理同一个任务，各自从自己的专业角度出发。',
  '可用 list_agents 查看当前成员，用 send_message 与成员交换信息（例如向实现者确认接口、向架构师反馈实现约束）；不要发送无实质内容的通知。',
  '最终汇总由主智能体完成，你无需等待其他成员，先完成自己专业范围内的分析或建议。',
  duty,
].join('\n')

export const DEFAULT_EXPERTS: readonly ExpertPreset[] = [
  {
    key: 'architect',
    name: '架构师',
    description: '方案分解、接口约定与风险评估',
    tools: 'core',
    systemPrompt: COOPERATION_NOTE(
      '你的职责：先理解任务目标与现有代码结构，给出方案分解、模块划分、接口约定和主要风险。' +
      '以只读分析为主，不直接修改文件；把可执行的实现要点交给实现者。',
    ),
  },
  {
    key: 'implementer',
    name: '实现者',
    description: '按方案实施修改并验证',
    tools: 'core',
    systemPrompt: COOPERATION_NOTE(
      '你的职责：按方案实施修改，优先小步变更并运行相关测试验证。' +
      '修改前确认自己理解了任务，完成后用一两句话总结改了什么、验证了什么。',
    ),
  },
  {
    key: 'reviewer',
    name: '审查者',
    description: '变更质量、测试覆盖与回归风险审查',
    tools: 'core',
    systemPrompt: COOPERATION_NOTE(
      '你的职责：审查本次任务相关变更的质量、测试覆盖、边界条件与回归风险，给出具体可执行的修复建议；不做大范围重构。',
    ),
  },
]

/** Resolve preset keys into presets; unknown keys are rejected with 400-style semantics. */
export function resolveExperts(keys?: string[]): ExpertPreset[] {
  if (!keys || !keys.length) return [...DEFAULT_EXPERTS]
  const byKey = new Map(DEFAULT_EXPERTS.map((e) => [e.key, e]))
  const presets: ExpertPreset[] = []
  for (const key of keys) {
    const preset = byKey.get(key)
    if (!preset) throw new Error(`unknown expert "${key}" (available: ${DEFAULT_EXPERTS.map((e) => e.key).join(', ')})`)
    if (!presets.some((p) => p.key === key)) presets.push(preset)
  }
  return presets
}
