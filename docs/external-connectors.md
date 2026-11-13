# 外接软件与知识库连接器

SakuraCode 可以通过 **MCP**、**HTTP JSON 桥接 v1** 或自定义插件适配器调用外部软件／知识库。这里是 SakuraCode 向软件发起连接，不是给第三方开放完整桌面 API。

## 使用入口

设置 → **集成与连接 → 外接软件与知识库**：

1. **添加外接**，填写连接 ID、显示名称与接口类型。
   - HTTP：软件提供本文的桥接接口，填写基地址；非本机服务必须 HTTPS。
   - MCP HTTP：填写 MCP 端点地址。
   - MCP stdio：填写已安装且信任的程序路径和 JSON 参数数组；与地址二选一。
2. 如需凭据，填写 **环境变量引用**，不是 Token／Key。例如请求头 `{"Authorization":"MY_SOFTWARE_AUTH"}` 表示读取启动进程的 `MY_SOFTWARE_AUTH`，其值应是服务要求的完整头值，例如 `Bearer …`。修改进程环境后需重新启动 SakuraCode／重新连接。不会使用模型账号或所选模型 Key 代替软件凭据。
3. **确认保存（不连接）**。这一步不执行命令、不联网。新连接默认手动启动，所有外部能力默认关闭。
4. 点击 **连接**，确认目标后发现服务的能力。连接本机程序也会执行该程序；只连接信任的服务。
5. 点击 **启用能力**，勾选需要的动作或外部知识搜索／阅读，再确认。只注册这些工具，不因软件自称「只读」而绕过审批。
6. 外部知识从下方指定来源搜索；确认后还需遵循当前审批模式。不会向全部连接广播关键词，不自动把内容导入本地知识库或长期记忆。

修改连接元数据会断开旧连接并重置能力授权，需重新连接／启用。已授权清单以实际 manifest 的 SHA-256 保存；后续重新连接发现动作／schema／说明变化时，工具暂停到重新确认，不只凭相同动作名复用旧授权。配置或工作区版本变化时旧确认被拒绝。

连接 ID 与动作组成 `connector__<id>__<action>`，总名称不得超过 64 字符。建议连接 ID 简短（例如 `notes`、`editor`），动作名称只使用英文、数字、`_`、`-`。

## 配置与权限

连接元数据保存在当前工作区 `.sakura/connectors.json`，版本为 1，具备 revision／内容指纹与同目录原子保存保护。只保存非秘密参数和环境变量名；**不要在名称、URL、命令参数或软件说明中放密码、密钥**。界面和导出不是用于存储明文凭据的保险箱。

也可在 `sakura.yml` 提供初始元数据；工作区 JSON 存在时以 JSON 为准，不覆盖它：

```yaml
connectors:
  - id: notes
    name: 我的外部知识库
    category: knowledge
    adapter: http
    url: https://my-software.example/bridge
    headersEnv:
      Authorization: MY_SOFTWARE_AUTH
    timeoutMs: 30000
    autoConnect: false
```

`autoConnect: true` 是明确允许每次引擎／工作区启动时执行本机程序或连接服务；不等于授权所有工具。未开启时刷新页面、打开设置不会连接服务。旧 `mcpServers` 配置与其 `mcp__…` 工具保留原有含义，不自动迁移或改变权限。

只允许本机操作员管理新连接。远端操作员、访客、手机分享没有新增连接管理、密钥读取或任意软件调用接口。模型只能调用已配置／已启用能力，不能用工具临时指定 URL、命令或修改连接配置。

智能体可用只读 `external_connectors` 查看已连接、已确认启用的连接 ID 与能力；列表不包含端点、命令或凭据，也不会连接外部服务。

所有外部动作以及 `external_knowledge_search`、`external_knowledge_read` 按 **execute** 进入原工具审批管道；`plan` 模式拒绝，`default`／`acceptEdits` 需要确认或原有明确允许规则，`yolo` 保持全自动语义。**启用能力不代表自动批准每次调用。** 等待审批时连接被断开或替换，原请求拒绝发送，需在当前连接重新发起。

外部知识的查询／文档 ID 会发往所选服务；返回的片段在模型使用工具时进入所选模型请求。设置页的资料查询不自动调用模型。外部内容是参考数据，不是覆盖当前用户任务、项目规则或工具权限的指令。此机制不是完整 DLP，勿连接不可信服务或发送不适合外传的资料。

## HTTP JSON 桥接 v1

基地址是配置的 `url`，不得带用户名、密码、query 或 fragment。HTTP 只用于回环本机，其他必须 HTTPS；请求拒绝重定向，不跟随能力清单中的任意地址。参数都发到配置目标的固定子路由。

### 发现能力

```http
GET <url>/capabilities
Accept: application/json
```

```json
{
  "version": 1,
  "actions": [
    {
      "name": "status",
      "description": "查询软件当前状态",
      "parameters": {"type":"object","properties":{},"additionalProperties":false}
    }
  ],
  "knowledge": {"search":true,"read":true}
}
```

`actions` 必须存在，可以为空。`knowledge` 可省略；知识库专用连接可只提供它。能力清单是数据，不会执行代码。每连接最多 128 动作、单 schema 64 KiB，整响应最多 1 MiB。

### 调用软件动作

```http
POST <url>/actions/<action-name>
Content-Type: application/json
```

```json
{"version":1,"requestId":"一次调用的 UUID","args":{"text":"任务参数"}}
```

```json
{"output":"软件提供的文本结果","isError":false}
```

客户端只转发动作已声明的参数及协议字段，不自动附加会话、工作区文件、系统提示或全部对话。本版动作结果支持文本，不自动处理远程图片／二进制。软件自己的 REST／数据库协议可由薄桥接程序转换为此契约；没有 API／MCP 的软件仍需自行实现桥接或本机插件，不宣称任意软件都能直接连。

### 知识检索

```http
POST <url>/knowledge/search
```

```json
{"version":1,"requestId":"UUID","query":"关键词","limit":5,"maxChars":6000}
```

```json
{
  "results":[
    {"id":"doc-123","title":"文档名","source":"来源标识","snippet":"相关片段","version":"服务实际版本","startLine":10,"endLine":12}
  ],
  "truncated":false
}
```

`id`、`snippet` 必须存在；标题／来源／版本／行号都可省略，SakuraCode 明确显示未提供，不造成本地文件行号。片段总预算默认 6,000 字符、1–20 条；可选 256–16,000 字符。分数不统一换算成可信度。

### 阅读与续页

```http
POST <url>/knowledge/read
```

```json
{"version":1,"requestId":"UUID","id":"doc-123","maxChars":12000,"cursor":"可选上一页游标"}
```

协议顶层 `version:1` 表示桥接协议版本。文档版本通过 `documentVersion` 字段传递（适配器调用层仍使用 `options.version`），避免与协议版本字段重名：

```json
{"version":1,"requestId":"UUID","id":"doc-123","documentVersion":"服务实际版本","maxChars":12000}
```

```json
{"id":"doc-123","content":"有界正文","source":"来源标识","version":"服务实际版本","truncated":true,"cursor":"下一页游标"}
```

单页最多 12,000 UTF-16 字符。截断必须给出可续读游标；提供方返回超预算正文时拒绝，不静默切掉剩余文字或伪造续页。文档版本冲突由服务返回错误；未提供版本时不宣称一致性保证。

## MCP 知识库绑定

普通 MCP 工具保持软件动作，不能根据名称猜测它是否是知识库。符合上面的结果契约时，可明确设置：

```yaml
connectors:
  - id: company
    name: MCP 文档服务
    category: knowledge
    adapter: mcp
    url: https://my-software.example/mcp
    knowledgeTools:
      search: search_documents
      read: read_document
```

搜索工具接收 `{query,limit,maxChars}`，阅读工具接收 `{id,cursor?,version?,maxChars}`；MCP 文本结果必须是对应 v1 搜索／阅读 JSON。此处 `version` 属于阅读工具参数，没有 HTTP 协议字段冲突。未匹配或不符合契约时明确失败，不解析任意自然语言猜文档来源。

MCP 复用现有管理器及 stdio／Streamable HTTP 会话，私有工具注册不会直接变成主智能体可见权限。本机新连接使用基本系统环境＋明确 `envRefs`，不默认继承模型密钥环境。已安装 `.cmd` 启动器仍遵循 Windows 现有行为；连接确认不能证明第三方程序不会安装依赖，应先审查程序／参数。

## 自定义适配器开发接口

从 `sakuracode/connectors` 导入 `ConnectorAdapter` 类型，通过已有插件的 `ctx.connectors.registerAdapter()` 注册：

```ts
import type { ConnectorAdapter, ConnectorsService } from 'sakuracode/connectors'

const adapter: ConnectorAdapter = {
  id: 'myapp',
  version: 1,
  description: '已有软件 API 的本机适配器',
  async connect(config, { cwd, signal }) {
    // 调用你已配置且信任的软件；不自动读取全部项目。
    return {
      capabilities: {
        version: 1,
        actions: [{name:'status',description:'查询状态',parameters:{type:'object'}}]
      },
      async call(action, args, signal) {
        return { output: '软件实际返回的结果' }
      },
      close() {}
    }
  }
}

export default {
  name: 'myapp-connector',
  inject: ['connectors'],
  apply(ctx) {
    const dispose = ctx.get<ConnectorsService>('connectors').registerAdapter(adapter)
    ctx.effect(() => dispose)
  }
}
```

自定义适配器在原本的 `bundles`／插件目录中安装与审查；不会自动下载执行。适配器必须支持取消和关闭；本机插件是可信代码，不是权限隔离沙箱。退出、工作区卸载、配置改变都会撤销工具并取消连接。

## 本机合成示例

源码开发环境运行：

```text
node scripts/example-connector-bridge.mjs 8789
```

然后添加 `adapter:http`，地址 `http://127.0.0.1:8789`，按上述流程连接并启用。它只提供合成软件状态与示例知识资料，没有真实账号、资料读取或外网请求，不自动绑定端口到公网，也不会随 SakuraCode 启动。

## 失败和验证边界

请求上限 256 KiB、响应 1 MiB、每连接最多 4 个本地等待调用；超时最长 120 秒。超时／取消后暂停该连接并撤销工具，需明确重新连接，避免连续调用继续堆积；适配器仍需支持关闭。超时、断线或重连不自动重发动作；`requestId` 可供桥接服务记账，客户端不保证远端 exactly-once。断开取消本地连接／等待，不保证撤销已经到达软件的副作用。

文件损坏、符号链接／联接、硬链接、revision／指纹冲突或已有 `connectors.lock` 时拒绝保存。不要删除正在使用的锁；处理遗留锁前先关闭实例、备份并由本机用户检查。

回归使用临时 HOME／工作区、假 MCP 进程和本机合成 HTTP 服务；不连接真实软件或云知识库、不登录真实账号。交付不部署服务、不自动迁移资料、不提交推送或修改版本号。

本轮验证：全量 110 个测试文件、1,415 个用例通过，无失败或跳过。最终界面清理调整后，16 条外接／远端接口与真实浏览器回归通过，源码和 tests/scripts 严格类型检查通过。重建桌面包的隔离端到端冒烟通过，包括配置保存不联网、确认连接与能力、带版本资料检索／阅读、断开移除及零模型请求；包来源指纹和 SHA-256 核对一致。物理键盘／鼠标、前台截图和系统输入法候选确认明确跳过，不作为已验证项。
