/** Static templates never install, discover, connect or enable capabilities. */
import type { ConnectorTemplate } from './types.js'
export function connectorTemplates(): ConnectorTemplate[] {
  const defaults = { category: 'software' as const, autoConnect: false, enabledActions: [], knowledgeEnabled: false, timeoutMs: 30_000 }
  return [
    { id: 'local-mcp', title: '本机 MCP', description: '填写已安装程序的明确可执行文件路径；参数独立填写，凭据只使用环境变量引用。', config: { ...defaults, id: 'local_mcp', name: '本机 MCP', adapter: 'mcp', command: '', args: [], envRefs: {} } },
    { id: 'https-mcp', title: 'HTTPS MCP', description: '填写明确的 HTTPS MCP 地址；认证头只引用环境变量。', config: { ...defaults, id: 'https_mcp', name: 'HTTPS MCP', adapter: 'mcp', url: 'https://example.invalid/mcp', headersEnv: {} } },
    { id: 'http-json-bridge', title: 'HTTP JSON bridge', description: '填写 HTTPS 或本机回环 HTTP 地址；只读取 v1 能力声明。', config: { ...defaults, id: 'http_bridge', name: 'HTTP JSON bridge', adapter: 'http', url: 'http://127.0.0.1:3000', headersEnv: {} } },
  ]
}
