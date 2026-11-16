/** No I/O preflight and isolated, bounded diagnostic sessions. No tools or queries are invoked. */
import { performance } from 'node:perf_hooks'
import { CONNECTOR_LIMITS, ConnectorDiagnosticError, ConnectorError, type ConnectorAdapter, type ConnectorConfig,
  type ConnectorDiagnosticReport, type ConnectorDiagnosticStage, type ConnectorDiagnosticStageName,
  type ConnectorFieldIssue, type ConnectorPreflightReport, type ConnectorSession } from './types.js'
import { connectorSecrets, containsConnectorSecret, validateCapabilities, validateConnector } from './validation.js'

const elapsed = (start: number) => Math.max(0, Math.round(performance.now() - start))
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const stageNames: ConnectorDiagnosticStageName[] = ['field-check', 'target', 'credentials', 'connection', 'handshake', 'capabilities']
const recommendation = '检查所标字段；凭据只通过环境变量引用，修正后重新确认诊断。'
const issue = (field: string, code: string, message = '此字段无效或不安全。'): ConnectorFieldIssue => ({ field, code, message, recommendation })
const fieldNames = new Set(['config', 'id', 'name', 'category', 'adapter', 'url', 'command', 'args', 'headersEnv', 'envRefs', 'timeoutMs', 'autoConnect', 'enabledActions', 'approvedCapabilities', 'knowledgeEnabled', 'knowledgeTools'])
const fieldCodes = new Set(['INVALID_FIELD', 'INVALID_URL', 'UNSAFE_TARGET', 'INVALID_CREDENTIAL_REF', 'UNSAFE_COMMAND', 'INSTALLER_BLOCKED', 'INVALID_ARGS', 'UNSAFE_ARGS', 'INLINE_CREDENTIAL', 'INVALID_TRANSPORT', 'INVALID_BINDINGS'])
function staticCheck(value: unknown, adapters: ReadonlyMap<string, ConnectorAdapter>): { report: ConnectorPreflightReport; config?: ConnectorConfig } {
  const start = performance.now(), raw = plain(value) ? value : {}
  const issues: ConnectorFieldIssue[] = [], credentials: ConnectorPreflightReport['credentials'] = []
  let config: ConnectorConfig | undefined
  try { config = validateConnector(value) }
  catch (error) {
    issues.push(issue(error instanceof ConnectorError && error.field && fieldNames.has(error.field) ? error.field : 'config',
      error instanceof ConnectorError && error.code && fieldCodes.has(error.code) ? error.code : 'INVALID_FIELD'))
  }
  // Presence only, even for an otherwise invalid draft. Never echo keys, reference names or values.
  for (const group of ['envRefs', 'headersEnv'] as const) {
    const refs = raw[group]
    if (!plain(refs)) continue
    Object.values(refs).slice(0, 32).forEach((name, index) => {
      const field = `${group}[${index}]`
      if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) return
      const secret = process.env[name], present = secret !== undefined && secret.length > 0
      credentials.push({ field, present })
      if (!present) issues.push(issue(field, 'MISSING_CREDENTIAL', '环境变量凭据尚未设置。'))
      else if (secret.length > 8192 || (group === 'headersEnv' ? /[\u0000-\u001f\u007f]/ : /\u0000/).test(secret)) issues.push(issue(field, 'INVALID_CREDENTIAL', '环境变量凭据格式无效。'))
    })
  }
  if (config && !adapters.has(config.adapter)) issues.push(issue('adapter', 'ADAPTER_UNAVAILABLE', '所选适配器未注册。'))
  const metadataOkay = !!config
  const credentialStructureOkay = !issues.some(row => row.field === 'config' || row.field === 'headersEnv' || row.field === 'envRefs')
  const targetOkay = !!config && adapters.has(config.adapter)
  const credentialsOkay = credentialStructureOkay && !issues.some(row => ['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'INVALID_CREDENTIAL_REF'].includes(row.code))
  const stages: ConnectorDiagnosticStage[] = stageNames.map(stage => ({ stage, status: 'skipped', durationMs: 0, message: '尚未执行。' }))
  stages[0] = { stage: 'field-check', status: metadataOkay ? 'success' : 'failed', durationMs: elapsed(start), message: metadataOkay ? '配置通过静态字段检查。' : '配置字段检查未通过。', ...(!metadataOkay ? { code: issues[0]?.code ?? 'INVALID_FIELD', recommendation } : {}) }
  stages[1] = { stage: 'target', status: targetOkay ? 'success' : metadataOkay || issues.some(row => ['url', 'command', 'args'].includes(row.field)) ? 'failed' : 'skipped', durationMs: 0,
    message: targetOkay ? '目标格式和适配器已检查；尚未检查可达性或程序是否存在。' : '目标尚未通过静态检查。' }
  stages[2] = { stage: 'credentials', status: credentialsOkay ? 'success' : 'failed', durationMs: 0, message: credentialsOkay ? '只检查显式凭据引用的存在性和格式；未验证权限。' : '凭据引用缺失或格式无效。', ...(!credentialsOkay ? { code: 'CREDENTIAL_CHECK_FAILED', recommendation } : {}) }
  return { config, report: { ok: issues.length === 0, issues: issues.slice(0, 66), credentials, stages, configSummary: {
    adapter: raw.adapter === 'http' || raw.adapter === 'mcp' ? raw.adapter : typeof raw.adapter === 'string' ? 'other' : 'unknown',
    category: raw.category === 'software' || raw.category === 'knowledge' ? raw.category : 'unknown',
    targetKind: typeof raw.url === 'string' && raw.url ? 'network' : typeof raw.command === 'string' && raw.command ? 'local' : 'unspecified',
    argumentCount: Array.isArray(raw.args) ? Math.min(raw.args.length, 65) : 0, credentialCount: credentials.length, knowledgeBindings: plain(raw.knowledgeTools),
  } } }
}
export function preflightConnector(value: unknown, adapters: ReadonlyMap<string, ConnectorAdapter>): ConnectorPreflightReport { return staticCheck(value, adapters).report }

const messages: Record<ConnectorDiagnosticError['code'], [string, string]> = {
  AUTH_REJECTED: ['服务明确拒绝认证或授权。', '检查所引用凭据及服务权限，然后重新确认诊断。'],
  REDIRECT_BLOCKED: ['服务返回重定向，已阻止跟随。', '填写服务的明确最终地址，再重新确认诊断。'],
  MALFORMED_RESPONSE: ['响应不符合协议格式。', '检查服务协议与响应格式。'],
  INVALID_MANIFEST: ['能力声明或参数 schema 无效。', '修正服务能力声明后重新诊断。'],
  INVALID_BINDINGS: ['知识工具绑定未在声明中找到。', '填写服务明确提供的搜索与读取工具名。'],
  TIMEOUT: ['诊断达到时间限制。', '检查目标状态；需要重试时重新确认，系统不会自动重试。'],
  NO_EXECUTABLE: ['无法启动指定的可执行文件。', '填写已安装程序的明确路径；诊断不会下载或安装软件。'],
  ACCESS_DENIED: ['系统拒绝启动指定程序。', '检查程序的执行权限。'],
  RPC_REJECTED: ['服务返回协议错误。', '检查服务协议配置；原始错误内容未导出。'],
}
/** All close promises are observed, but a broken third-party adapter cannot hold the report indefinitely. */
async function boundedClose(session: ConnectorSession): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([Promise.resolve().then(() => session.close()).then(() => true, () => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 300) })]) }
  finally { if (timer) clearTimeout(timer) }
}
export async function diagnoseConnector(value: unknown, adapters: ReadonlyMap<string, ConnectorAdapter>, cwd: string,
  options: { signal: AbortSignal; assertCurrent?: () => void }): Promise<ConnectorDiagnosticReport> {
  const start = performance.now(), checked = staticCheck(value, adapters)
  const report: ConnectorDiagnosticReport = { ...checked.report, durationMs: 0, warnings: ['诊断只建立短生命周期连接并检查能力声明，不执行动作，也不曾测试知识查询结果。', '连接或握手可能已到达服务；关闭本地会话不代表撤销服务端副作用。'] }
  if (!report.ok || !checked.config) { report.durationMs = elapsed(start); return report }
  const config = checked.config, adapter = adapters.get(config.adapter)!, secrets = connectorSecrets(config)
  const controller = new AbortController()
  let reason: 'CANCELLED' | 'TIMEOUT' | 'STALE' | undefined, finished = false, session: ConnectorSession | undefined
  let closePromise: Promise<boolean> | undefined
  const closeOnce = (target: ConnectorSession) => closePromise ??= boundedClose(target)
  let currentStage: 'connection' | 'handshake' | 'capabilities' = 'connection'
  let stageStart = performance.now()
  const replace = (stage: ConnectorDiagnosticStageName, data: Omit<ConnectorDiagnosticStage, 'stage'>) => { report.stages[stageNames.indexOf(stage)] = { stage, ...data } }
  const cancel = (code: typeof reason) => { if (!reason) reason = code; controller.abort() }
  const aborted = () => cancel('CANCELLED')
  const check = () => {
    if (reason || options.signal.aborted) { if (!reason) cancel('CANCELLED'); throw new Error() }
    try { options.assertCurrent?.(); if (adapters.get(config.adapter) !== adapter) throw new Error() }
    catch { cancel('STALE'); throw new Error() }
  }
  options.signal.addEventListener('abort', aborted, { once: true })
  const timeout = setTimeout(() => cancel('TIMEOUT'), Math.min(config.timeoutMs ?? 30_000, 30_000))
  // Epoch guards must cover adapters which ignore AbortSignal and never settle.
  const epoch = setInterval(() => { if (!finished) { try { check() } catch {} } }, 25)
  let rejectAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error()); controller.signal.addEventListener('abort', rejectAbort, { once: true }) })
  // Keep this observed even when check() rejects before Promise.race is installed.
  void cancelled.catch(() => {})
  try {
    check()
    const onStage = (stage: 'connection' | 'handshake') => {
      if (finished) return
      check()
      if (stage === 'connection' && report.stages[stageNames.indexOf('connection')]!.status !== 'success') {
        replace('connection', { status: 'success', durationMs: elapsed(stageStart), message: '传输已建立；尚不代表认证或握手成功。' })
        currentStage = 'handshake'; stageStart = performance.now()
      } else if (stage === 'handshake' && report.stages[stageNames.indexOf('handshake')]!.status !== 'success') {
        replace('handshake', { status: 'success', durationMs: elapsed(stageStart), message: '协议握手已验证。' })
        currentStage = 'capabilities'; stageStart = performance.now()
      }
    }
    const connected = Promise.resolve().then(() => { check(); return adapter.connect({ ...config, autoConnect: false, enabledActions: [], knowledgeEnabled: false, approvedCapabilities: undefined }, { cwd, signal: controller.signal, diagnostic: { onStage } }) })
    void connected.then(late => { if (finished || controller.signal.aborted) return closeOnce(late) }, () => {})
    session = await Promise.race([connected, cancelled])
    check()
    for (const stage of ['connection', 'handshake'] as const) if (report.stages[stageNames.indexOf(stage)]!.status === 'skipped') replace(stage, { status: 'unknown', durationMs: 0, message: '适配器未提供此阶段的独立证据。' })
    currentStage = 'capabilities'; stageStart = performance.now()
    let capabilities
    try {
      if (Buffer.byteLength(JSON.stringify(session.capabilities)) > CONNECTOR_LIMITS.responseBytes) throw new Error()
      capabilities = validateCapabilities(session.capabilities)
      if (containsConnectorSecret(capabilities, secrets) || containsConnectorSecret(Object.keys(capabilities), secrets)) throw new Error()
      if (capabilities.actions.some(action => `connector__${config.id}__${action.name}`.length > 64)) throw new Error()
      if (capabilities.knowledge?.search && !session.search || capabilities.knowledge?.read && !session.read) throw new Error()
    } catch { throw new ConnectorDiagnosticError('capabilities', 'INVALID_MANIFEST') }
    if (secrets.some(secret => JSON.stringify(capabilities).includes(secret))) throw new ConnectorDiagnosticError('capabilities', 'INVALID_MANIFEST')
    if (config.knowledgeTools && (!capabilities.actions.some(action => action.name === config.knowledgeTools!.search) || !capabilities.actions.some(action => action.name === config.knowledgeTools!.read))) throw new ConnectorDiagnosticError('capabilities', 'INVALID_BINDINGS')
    // No upstream descriptions, schemas, data, names or arbitrary keys enter the exported preview.
    report.capabilities = { actionCount: capabilities.actions.length, actions: capabilities.actions.slice(0, 20).map((_, index) => `action_${index + 1}`), truncated: capabilities.actions.length > 20,
      knowledge: { search: capabilities.knowledge?.search === true, read: capabilities.knowledge?.read === true, queryTested: false } }
    report.warnings.push('能力预览使用序号；服务提供的名称、描述及 schema 不进入导出报告。')
    replace('capabilities', { status: 'success', durationMs: elapsed(stageStart), message: '能力声明和知识绑定已检查；未调用任何动作、搜索或读取。' })
    check()
  } catch (error) {
    report.ok = false; delete report.capabilities
    let code: string | undefined, message = '诊断未完成；无法从现有证据确定失败原因。', advice = '检查目标与适配器；原始响应和错误内容不会进入报告。'
    if (reason) {
      code = reason
      message = reason === 'TIMEOUT' ? messages.TIMEOUT[0] : reason === 'STALE' ? '诊断目标或工作区已变化，结果已丢弃。' : '诊断已取消。'
      advice = '如需再次诊断，请检查当前目标并重新确认。'
    } else if (error instanceof ConnectorDiagnosticError && Object.hasOwn(messages, error.code)) {
      code = error.code; currentStage = error.stage; [message, advice] = messages[error.code]
    }
    replace(currentStage, { status: 'failed', durationMs: elapsed(stageStart), ...(code ? { code } : {}), message, recommendation: advice })
  } finally {
    finished = true; clearTimeout(timeout); clearInterval(epoch)
    options.signal.removeEventListener('abort', aborted)
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
    controller.abort()
    if (session && !await closeOnce(session)) report.warnings.push('会话关闭已请求，但未在限定时间内确认完成。')
  }
  // Cancellation can also arrive during bounded cleanup.
  if (options.signal.aborted) {
    report.ok = false; delete report.capabilities
    replace(currentStage, { status: 'failed', durationMs: 0, code: reason ?? 'CANCELLED', message: '诊断已取消或达到时间限制。', recommendation: '重新确认当前目标后再诊断。' })
  }
  // assertCurrent is checked again after bounded cleanup, before the result can be published.
  try { options.assertCurrent?.(); if (adapters.get(config.adapter) !== adapter) throw new Error() } catch {
    report.ok = false; delete report.capabilities
    replace('capabilities', { status: 'failed', durationMs: 0, code: 'STALE', message: '诊断目标或工作区已变化，结果已丢弃。', recommendation: '重新确认当前目标。' })
  }
  report.durationMs = elapsed(start)
  return report
}
