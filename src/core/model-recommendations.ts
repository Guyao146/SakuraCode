/** Offline, explainable recommendations. No guessed pricing/capabilities or model requests. */
import { createHash } from 'node:crypto'
import type { ModelChoice } from './llm.js'

export interface AgentModelPreferences {
  roleModels?: Record<string, { model: string; adapter?: string }>
  tags?: Record<string, string[]>
}
export interface ModelRecommendation { adapter: string; model: string; reason: string; catalogFingerprint: string }

export function modelCatalogFingerprint(catalog: readonly ModelChoice[]): string {
  return createHash('sha256').update(JSON.stringify(catalog.map(row => ({ adapter: row.adapter, model: row.model, reasoning: row.reasoning })))).digest('hex')
}

function preferenceRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function preferenceTags(value: unknown): string[] | undefined {
  const tags = Array.isArray(value) && value.length <= 64 ? [...value] : undefined
  return tags?.every(tag => typeof tag === 'string') ? tags : undefined
}

export function recommendModel(
  agent: { model: string; modelAdapter?: string; meta: { role?: string; expert?: unknown } },
  catalog: readonly ModelChoice[], preferences: unknown = {},
): ModelRecommendation | null {
  if (!catalog.length) return null
  const prefs = preferenceRecord(preferences)
  const fingerprint = modelCatalogFingerprint(catalog), role = typeof agent.meta.expert === 'string' ? agent.meta.expert : agent.meta.role || 'sub'
  const resolve = (model: string, adapter?: string) => {
    const matches = catalog.filter(row => row.model === model && (adapter === undefined || row.adapter === adapter))
    return matches.length === 1 ? matches[0] : undefined
  }
  const choice = preferenceRecord(preferenceRecord(prefs?.roleModels)?.[role])
  const pinned = choice && typeof choice.model === 'string' && (choice.adapter === undefined || typeof choice.adapter === 'string')
    ? { model: choice.model, adapter: choice.adapter as string | undefined } : undefined
  const configured = pinned && resolve(pinned.model, pinned.adapter)
  if (configured) return { adapter: configured.adapter, model: configured.model, reason: '根据工作区为此职责明确配置的模型偏好推荐；仍需你确认。', catalogFingerprint: fingerprint }
  const requiredTag = role === 'implementer' ? 'coding' : role === 'architect' || role === 'reviewer' ? 'reasoning' : undefined
  const tags = preferenceRecord(prefs?.tags)
  const tagged = requiredTag && catalog.filter(row => (preferenceTags(tags?.[row.adapter + '/' + row.model]) ?? preferenceTags(tags?.[row.model]) ?? []).includes(requiredTag))
  if (tagged && tagged.length === 1) return { adapter: tagged[0]!.adapter, model: tagged[0]!.model,
    reason: `工作区为此模型明确标注了 ${requiredTag} 能力，符合当前职责；不是质量或费用保证。`, catalogFingerprint: fingerprint }
  if ((role === 'architect' || role === 'reviewer') && catalog.filter(row => row.reasoning === true).length === 1) {
    const candidate = catalog.find(row => row.reasoning === true)!
    return { adapter: candidate.adapter, model: candidate.model, reason: '授权目录明确标记此模型支持推理，适合先用于分析／审查；不是任务质量或费用保证。', catalogFingerprint: fingerprint }
  }
  const current = resolve(agent.model, agent.modelAdapter)
  if (current) return { adapter: current.adapter, model: current.model,
    reason: '没有足够的已配置职责偏好或能力信息，建议保持当前模型；不会从名称猜测价格或能力。', catalogFingerprint: fingerprint }
  const fallback = catalog.find(row => row.default) ?? catalog[0]!
  return { adapter: fallback.adapter, model: fallback.model,
    reason: pinned ? '配置的职责模型已不在当前目录，暂建议当前默认模型；需要你确认或另选。' : '尚无独立模型，建议使用已配置的默认模型；需要你确认。', catalogFingerprint: fingerprint }
}
