# SakuraCode

**SakuraCode** 是一个终端编码智能体（CLI coding agent），用 TypeScript（ESM）编写。模型通过工具循环读写代码、执行命令、检索仓库，并能把自包含子任务并行委派给 subagent。它的插件体系遵循 **Everything is a Plugin** 的架构哲学：内置一个零依赖的 Cordis 风格微内核，服务、工具、审批门、终端渲染全部以插件形式挂载，组合本身就是数据。

## 特性

- **微内核**（`src/kernel`）：五种事件派发模式（`emit` / `parallel` / `serial` / `bail` / `waterfall`）；一切注册可逆（`on()` / `effect()` 返回 disposer，`dispose()` 按 LIFO 释放）；插件以 `name` / `inject` / `apply(ctx, config)` 挂载，`inject` 声明的服务键未就绪时自动等待（round-robin 重试）。
- **会话**：append-only JSONL 日志（`.sakura/sessions/<id>/session.jsonl`），"model-visible means logged" —— 每次请求的上下文都能通过 `deriveMessages()` 从日志重建；支持按 session id 恢复（`--resume <id>`）。
- **工具集**（35 个，按 `read` / `write` / `execute` / `agent` 四类）：
  - read（14）：`read` · `glob` · `grep` · `web_fetch` · `web_search` · `ask_user` · `skill` · `exit_plan` · `todo_write` · `job_list` · `job_output` · `list_subagent_models` · `list_agents` · `plugin_manager`
  - write（2）：`write` · `edit`
  - execute（16）：`bash` · `pwsh` · `job_kill` · `browser_navigate` / `browser_screenshot` / `browser_click` / `browser_type` / `browser_key` / `browser_evaluate` / `browser_close` · `computer_screenshot` / `computer_click` / `computer_move` / `computer_scroll` / `computer_type` / `computer_key`
  - agent（3）：`subagent` · `send_message` · `interrupt_agent`
- **跨平台 shell**：`bash` / `pwsh` 的解释器在进程内自动发现（`SAKURA_BASH` / `SAKURA_PWSH` 环境变量优先，其次 PATH，最后探测 Git for Windows / MSYS2 / WSL / PowerShell 7 等已知安装位置）——Windows 上装过 Git 就能直接用 `bash` 工具，无需手工配置；缺失时返回可操作的错误而非 `ENOENT`。
- **工具管道**：每次调用流经 `tools/pre-execute → tools/execute → tools/post-execute` 三级瀑布 —— 监听器可在 pre 阶段拒绝（审批门就是这么实现的）、在 execute 阶段短路、在 post 阶段改写输出。
- **多智能体**：`subagent` 工具前台/后台委派；`send_message` mailbox 投递、`interrupt_agent` 中断、`list_agents` 查看花名册；子代理工具策略 `full` / `core` / 显式白名单。
- **审批门**：`plan`（只读）→ `default`（write / execute / agent 类工具均需确认——文件写入、命令执行，以及 `subagent` / `send_message` / `interrupt_agent` 也会弹确认）→ `acceptEdits`（自动放行 write 类）→ `yolo`（全放行）；交互式 TTY 弹 y/N 确认，headless 无确认器时 fail closed。
- **配置**：profile / bundle / plugin rows / `--patch` 多层组合，`--dump-config` 查看最终生效组合。
- **CLI**：交互式 REPL（斜杠命令）+ one-shot（`-p`）两种用法。
- **远端运行看板**：`/dashboard` 查看智能体、三列任务进度和待审批事项；支持独立操作员／只读访客令牌、跨设备实时同步与断线恢复，默认仍仅监听本机。

## 快速开始

要求 Node.js >= 20。运行时依赖只有 `yaml` 一个。

```bash
npm install

# 环境变量（任意 OpenAI 兼容端点均可：OpenAI / GLM / Moonshot / 本地 vLLM …）
export SAKURA_API_KEY="sk-..."
export SAKURA_BASE_URL="https://api.openai.com/v1"    # 可选，默认 https://api.openai.com/v1
export SAKURA_MODEL="gpt-4o-mini"                    # 可选，默认 gpt-4o-mini

# one-shot（headless）
npm run dev -- -p "总结 src/kernel/index.ts 的事件派发设计"
# 等价写法
npx tsx src/cli.ts -p "总结 src/kernel/index.ts 的事件派发设计"

# 交互式 REPL
npm run sakura

# Web GUI（浏览器客户端，审美遵循樱落生态设计规范）
npm run web            # 等价于 npx tsx src/cli.ts --web --no-open
npx tsx src/cli.ts --web --port 3099   # 自定端口并自动打开浏览器
```

## Windows 桌面 GUI

Windows 10/11 x64 上可构建双击启动的 **SakuraCode Desktop.exe**：原生启动器内置独立运行引擎，直接用系统 Chrome / Edge 的应用模式打开聊天工作区（没有普通浏览器标签栏）；项目和模型设置位于主界面，不弹启动前设置窗，也不是把 CLI 快捷方式重命名成桌面版。它沿用 Web GUI 的会话、协作、审批和运行看板。

```powershell
Set-Location 'D:\VSProject\SakuraCode'
# 构建内置引擎与桌面 GUI，需要 Node 24、Windows .NET Framework 的 C# 编译器
npm.cmd run desktop
# 构建并复制到当前用户桌面；不覆盖旧的 SakuraCode.exe 或已有桌面设置
npm.cmd run desktop -- --install
& 'D:\VSProject\SakuraCode\build\SakuraCode Desktop.exe'
```

- **运行环境**：Windows 10/11 x64、.NET Framework 4.8、已安装的 Chrome 或 Edge；不需要 Node/npm。默认优先 Edge，也可用 `SAKURA_CHROME` 指定已安装浏览器的完整路径。无需管理员权限，不修改系统防火墙或安装浏览器扩展。
- **启动直进工作区**：双击即启动上次的工作区（首次为「文档」目录，或 `--workspace` 指定目录）；左侧「设置」视图选择可信项目目录、模型 API 地址、模型名与 API Key。模型设置留空时沿用项目配置 / 环境变量；均未设置时默认 OpenAI 地址及 `gpt-4o-mini`。远端模型 API 必须 HTTPS，本机模型可以 HTTP。默认工具需审批，主界面内仍可切换模式。
- **工作区切换**：点击左上项目卡展开最近项目，选择目标后确认，或在设置中填写新目录保存。任一智能体运行时切换返回 `409`，不会替你停止任务；先等待完成或明确中断再切换。同进程内重建 harness，会话历史按工作区保留在 `.sakura/sessions`，可随时切回；桌面模型覆盖值与审批模式跨工作区保留。仅打开可信项目：项目插件 / 工具能操作其中代码。
- **密钥保护**：可选择在当前 Windows 用户下用 DPAPI 加密保存 API Key。不会把密钥写到项目配置、命令行参数、浏览器 URL 或明文桌面设置中；仅经匿名标准输入管道传给本机引擎，再发送给你选择的模型服务。DPAPI 不是针对当前登录用户或其工具的隔离沙箱。
- **窗口生命周期**：正常启动无命令行黑窗，也没有启动前设置窗口，直接打开上次的工作区。任务栏通知区域的樱花图标可重新打开主窗口。关闭主窗口会停止引擎及其工具 / MCP / 浏览器子进程，Windows Job Object 也负责桌面壳异常退出时的清理；引擎意外退出时会提示并整体退出，而不是回到设置窗。
- **本机边界**：固定 `127.0.0.1` 和随机空闲端口，桌面模式不继承远端 `web` 配置 / 令牌；继续执行 Host/Origin 检查。同机应用可访问该本地服务；这不是多用户隔离。远端运行仍使用下面的 `--web` 部署方式。
- **数据位置**：设置、DPAPI 密钥密文、专用浏览器 profile、引擎缓存及滚动启动日志位于 `%LOCALAPPDATA%\SakuraCode\Desktop`。会话仍按项目保存在 `.sakura/sessions`（或项目自行配置的目录）。程序内嵌引擎和页面，不依赖开发仓库；移动单个 exe 不会自动迁移用户设置 / 项目历史。
- **签名与更新**：当前为未签名本机构建，可能提示未知发布者；没有自动更新或安装器。重新构建替换 exe 即可，现有配置不被覆盖。

诊断参数：`--workspace <绝对路径>` 预选项目（否则沿用上次工作区）；`--data-dir <绝对路径>` 用独立用户数据测试。正常窗口不开放 CDP 调试；仅本地测试时设置 `SAKURA_DESKTOP_DEBUG=1`，并在结束后清除。

桌面端到端验证：构建后运行 `npx tsx scripts/desktop-smoke.ts`。使用隔离的临时中文项目和本地 mock 模型，实际驱动设置 HTTP API、工作区切换、DPAPI 加密回环、聊天 / 刷新 / 看板、单实例、正常退出和桌面壳崩溃后的子进程清理。截图保存在 `D:\VSProject\SakuraCode\tmp\desktop-previews`（其他 checkout 使用其对应的绝对路径）；不会保存真实 API Key 或修改实际桌面用户配置。

## Web GUI

`sakura --web` 启动本地 Web 服务（默认 `http://127.0.0.1:3099`，仅绑定回环地址），同一进程内承载完整的 harness：聊天流（SSE 实时推送 ui/* 事件）、工具调用卡片（参数/输出/耗时/截图）、审批卡片（允许/拒绝）、多智能体面板（花名册 + 状态 + 中断 + 消息）、MCP 服务器面板、会话切换与历史回放、审批模式切换、明暗主题（默认夜间）。

```bash
sakura --web [--host 127.0.0.1] [--port 3099] [--no-open] [--resume <id>] [--yolo | --mode <m>]
```

Web 客户端是单文件 `src/web/index.html`（零依赖、无外部字体/CDN）：开发模式由服务端直接读盘，桌面客户端构建时内嵌进 exe。SSE 帧与 REST API 的完整契约见 `src/web/server.ts` 头注释。

### 工作区布局

- **视觉风格**：深色石墨灰底色搭配樱花粉强调色（日间主题为暖白底配深樱花粉）。品牌标识、卡片化的项目／会话条、图标空态与圆角输入区统一在「樱落」设计语言下；所有图标均为内置 SVG，无外部字体或 CDN。
- 桌面设置视图同样使用 graphite + sakura 配色：侧栏「工作区」一节显示当前项目（高亮）与最近项目，设置视图为分组表单、平面输入框、圆角主按钮，API Key 可切换显示／隐藏，保存结果即时回显。

- **左侧 · 项目与会话**：显示当前项目、搜索历史、创建／切换会话及导出 Markdown；`Ctrl / ⌘ + K` 定位会话搜索。
- **中间 · 对话**：顶栏只保留会话标题、运行状态与面板入口。模型、审批模式、思考等级集中在输入区；底部显示服务连接、工具数和 token 信息。四张起步卡片可填入项目分析、修复、测试或多智能体任务。
- **右侧 · 工作台**：默认收起。「协作」展示成员状态、独立会话与任务进度；「变更」列出当前记录中成功的 `write` / `edit`，点击定位并展开工具结果；「扩展」展示实际挂载的插件、可搜索工具与 MCP 连接。三个标签支持方向键及偏好恢复。变更列表不是 Git 差异，也不追踪命令间接修改；实时子智能体变更会带来源，重载后应从独立会话查看。
- **多智能体操作**：点击「新建智能体」，可选预定义类型、模型、专属指令和初始任务；也可先创建待命成员，再通过「发消息」派发独立任务。多个成员可并行运行，运行中的消息按邮箱排队，可单独中断。主会话的停止按钮只控制主智能体。
- **响应式与键盘**：桌面两侧面板可独立收起，偏好与主题保存在本机浏览器；中等宽度把工作台改为抽屉，手机宽度把两侧均改为抽屉，保留对话空间。`Esc` 关闭抽屉／对话框，工作台标签支持左右方向键。

Windows PowerShell 若拦截 `npm.ps1`，可用 `npm.cmd run web`。修改页面后刷新浏览器；若使用独立 exe，需先运行 `npm.cmd run client` 重新内嵌页面。

界面回归使用现有 Vitest + Chrome/Edge 的原生 CDP，不新增浏览器自动化依赖：`npm test -- tests/web-client.test.ts tests/web-remote-client.test.ts`。没有 Chrome/Edge 或原生 WebSocket 的环境会跳过真实浏览器用例，静态契约测试仍运行。可设置 `SAKURA_UI_SCREENSHOTS` 为输出目录，保存桌面、手机、日间主题及协作面板截图。

### 远端看板：局域网 / VPN

在工作电脑的 PowerShell 中运行（模型 API Key 与本机使用方式相同）：

```powershell
Set-Location 'D:\VSProject\SakuraCode'
# 每个令牌生成 32 个随机字节。通过可信渠道保存和分享，别放进 URL 或提交到仓库。
$env:SAKURA_WEB_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$env:SAKURA_WEB_VIEWER_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# 在当前终端查看令牌后分别保存：前者能操作，后者只能查看。
$env:SAKURA_WEB_TOKEN
$env:SAKURA_WEB_VIEWER_TOKEN
npm.cmd run web -- --host 0.0.0.0 --port 3099
```

启动日志会列出局域网看板地址。在另一台电脑或手机访问 `http://工作电脑的局域网IP:3099/dashboard`，输入对应令牌登录。`0.0.0.0` 是监听地址，不是浏览器访问地址。需要在系统防火墙中仅对可信的局域网／VPN 放行该端口；不会自动修改防火墙或配置路由器端口转发。

- **操作员**：可发任务、控制智能体、处理工具审批／提问／计划确认及切换会话；智能体工具仍遵循审批模式。
- **只读访客**：可看状态、实时消息、历史和导出，但所有工作区写接口由服务端统一返回 `403`，不是只隐藏按钮。只读不等于脱敏：历史、工具输出和工作区路径可能包含敏感数据，令牌只应交给可信人员。
- **运行看板**：智能体状态、模型和错误，待人工处理入口，以及待开始／进行中／已完成三列任务。任务来源是当前进程 `todo_write` 的最新工作区清单，不是独立的拖拽任务管理系统，也不是多服务器监控平台。
- **跨设备恢复**：SSE 自动重连，重新获取状态、历史和未解决请求；断线保留当前页面的未发送草稿，不自动重发任务。多设备处理同一请求只接受首个有效响应；访客查看历史不改变共享的运行会话，操作员切换会话会同步到其他设备，遇到运行中智能体时返回 `409`。切换会话清空临时的「本会话始终允许」授权。
- **登录与生命周期**：令牌须为 32–256 个非空白 ASCII 字符，建议使用上面的随机生成方式。操作员／访客令牌必须不同；远端监听缺少操作员令牌时拒绝启动。登录后使用 `HttpOnly; SameSite=Strict` 的不透明 cookie，不把令牌写入浏览器存储。登录最长 12 小时，退出即撤销当前 cookie 与事件流；共享令牌需更换环境变量并重启服务才能轮换。
- **请求超时**：工具审批／用户提问等待 5 分钟，计划确认等待 10 分钟，超时安全拒绝／取消。浏览器离线不会直接拒绝审批；服务重启不恢复内存中的登录、任务清单和待处理请求，持久会话日志仍可恢复。

独立 Windows 客户端同样支持上述参数：

```powershell
npm.cmd run client
& 'D:\VSProject\SakuraCode\build\SakuraCode.exe' --web --no-open --host 0.0.0.0 --port 3099
```

构建 exe 需要 Node 24；运行生成的 exe 无需额外安装 Node。若已卸载 Node，可在 PowerShell 中用系统加密随机数生成令牌：

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$env:SAKURA_WEB_TOKEN = [Convert]::ToBase64String($bytes)
```

也可在工作区配置中设置 `web.host`、`web.port`、`web.tokenEnv`、`web.viewerTokenEnv`、`web.publicOrigin`，完整示例见配置模板。配置只保存环境变量名，不保存令牌本身；CLI 的 `--host`、`--port`、`--public-origin` 优先于配置。

### HTTPS 反向代理

**不要把明文 HTTP 端口直接暴露到公网。** 跨公网建议使用可信 VPN，或已有的 HTTPS 反向代理。代理与服务同机时，让后端保持回环监听，并声明浏览器实际访问的 HTTPS origin（仅协议、域名及可选端口，不带路径）：

```powershell
# 先设置 SAKURA_WEB_TOKEN，可选 SAKURA_WEB_VIEWER_TOKEN
npm.cmd run web -- --host 127.0.0.1 --port 3099 --public-origin https://sakura.example.com
```

外部域名、DNS、TLS 证书及反向代理需自行部署，并将站点根路径转发到 `http://127.0.0.1:3099`。代理必须保留浏览器的 `Host`（有非标准端口时一起保留）、`Origin`、cookie 和 `Authorization`，关闭 SSE 缓冲／缓存，读取超时大于 25 秒心跳间隔，请求体限制至少容纳 16 MiB。服务刻意不信任 `X-Forwarded-*` 来跳过同源检查；若出现 `Host does not match configured public origin`，请修正代理的 Host 转发而不是关闭校验。启用此配置后 cookie 额外带 `Secure`，只应经 HTTPS 使用；暂不支持 `/sakura/` 之类子路径部署。

脚本调用受保护 API 时使用 `Authorization: Bearer <令牌>`，不支持 URL 查询参数令牌。操作员拥有工作区控制权、工具可能操作宿主机；本功能不是不可信用户的隔离沙箱。登录尝试按实际连接来源限流（每分钟 10 次，代理后可能共享额度）；建议同时在入口限制来源。


REPL 内斜杠命令：

```text
/help      帮助                     /plugins   已挂载插件列表
/exit      退出（/quit 等价）       /sessions  历史会话列表
/agents    智能体花名册             /resume <id> 查看历史会话
/mode <m>  切换审批模式             /new       v0：重启进程即新会话
/tools     已注册工具列表           /skills    已发现的技能
/compact [focus] 手动压缩当前会话上下文    /memory   已加载的 AGENTS.md
/hooks     已配置的 shell 钩子      /permissions  权限规则 + 本会话放行清单
```

REPL 也接受管道喂入（`echo "任务" | sakura`）：stdin 到达 EOF 时若仍有 turn 在跑，会等本轮跑完再干净退出，不会把任务丢掉。

自定义斜杠命令：把 markdown 文件放进 `.sakura/commands/<名字>.md`（项目）或 `~/.sakura/commands/`（用户），正文即提示词模板，支持 `$ARGUMENTS` 与 `$1..$9` 占位符；REPL 与 Web GUI（输入 `/` 唤起菜单）均可调用。

## Skills / Hooks / 上下文压缩 / 项目记忆 / ask_user / web_search

六项核心能力，全部以插件形式提供：

- **Skills**（`core-skills`）：`.sakura/skills/<名字>/SKILL.md`（YAML frontmatter：name/description/whenToUse + 正文指令）自动注入系统提示词，模型用 `skill` 工具按需加载完整指令。项目 > 用户 > extraDirs 优先级，`/skills` 查看。
- **Hooks**（`core-hooks`）：`plugins.core-hooks.config.hooks` 配置 `pre-tool-call | post-tool-call | turn-end | session-start` 四类事件的外部命令（glob matcher）；pre 钩子非零退出即否决该工具调用。命令经 stdin 收到 JSON payload，环境变量 `SAKURA_*` 同步。
- **上下文压缩**（`core-compaction`）：会话事件超过阈值（默认 120，`auto: 0` 关闭）自动用模型摘要压缩旧上下文；`/compact [focus]` 手动触发。压缩标记进会话日志，`deriveMessages` 投影自动截断。
- **压缩用别的模型**：摘要请求默认跟随当前选中的模型；`plugins.core-compaction.config.compactModel`(已注册模型名或适配器 id)让所有压缩固定走指定模型。写在 `~/.sakura/config.yml` 即为全局统一；写在项目 `sakura.yml` 里则该项目单独覆盖(逐键合并,项目优先)。Web GUI 输入框上方的「压缩 · 跟随当前」下拉也可即时调整(经 `POST /api/settings {compactModel}`,只影响之后的压缩,运行中也能改)。GUI 运行时选择不落盘;要持久化请用配置文件。
- **按工作区配置**：桌面模式下每个工作区可单独指定「会话目录」(默认 `<工作区>/.sakura/sessions`;填绝对路径或相对工作区的路径,修改后该工作区重新挂载);「自动开启的智能体」勾选 `.sakura/agents/*.md` 里定义的类型,挂载该工作区时自动创建这些协作成员,取消勾选在下次切换/重挂后生效。全局的「新工作区默认目录」决定「新建工作区」按钮在哪里创建子目录(留空时需填写完整路径);服务端会递归创建目录,不存在的目标仍然会被拒绝切换。这些偏好随桌面设置持久化(每工作区一条),不写入项目目录。
- **项目记忆**（`core-project-memory`）：从工作目录向上发现 AGENTS.md（每层一个），最多 3 层注入系统提示词，`/memory` 查看。
- **ask_user**（`core-interaction` + `tool-ask-user`）：模型通过 `ask_user` 工具向用户提问（2-4 个选项或自由文本）；REPL 走终端问答，Web GUI 渲染成对话流里的选项卡片。
- **web_search**（`tool-web-search`）：DuckDuckGo HTML 端点搜索，返回标题/URL/摘要列表，`endpoint` 可换自建代理。

## Browser Use / MCP HTTP / @ 提及 / 图片粘贴（v0.3）

- **Browser Use**（`tool-browser`）：CDP 直连 Chrome/Edge（原生 WebSocket，零依赖），7 个工具 `browser_navigate / screenshot / click / type / key / evaluate / close`；截图以图片进入模型上下文。懒启动 headless 单例，路径自动探测（可用 `SAKURA_CHROME` 或 config.chromePath 指定）。
- **MCP 双传输**：stdio 之外支持 Streamable HTTP —— `mcpServers.<name>.url` + 可选 `headers`（如 Authorization），与 stdio 服务器共用同一套 `mcp__<server>__<tool>` 桥接与状态面板。
- **@ 文件提及**：输入 `@src/foo.ts` 或 `@src/foo.ts:30-80`，发送前自动展开成带行号的上下文块（预算与截断保护）；REPL 与 Web 均生效，未命中以提示说明。
- **GUI 多模态输入**：composer 粘贴/拖放/📎 选择图片 → 随消息进入模型上下文（data URL，8MB 上限）。
- **消息排队**：回合进行中继续发消息会排队（mailbox 串行），不再 409。
- **REPL 会话切换**：`/new`、`/resume <id>` 原地切换主会话（子智能体花名册随之重置）。
- **会话标题**：取首条用户消息，侧栏列表可读性更好。
- **GUI 细节**：edit 工具卡渲染红/绿 diff 块；「智能体 ＋」对话框直接生成子智能体。

## 权限规则 / 多模型 / 思考等级（v0.4）

- **权限规则**（`core-approval` 扩展）：`rules` 配置 allow/deny 规则（工具名 glob、`kind:<x>` 整类、`args` 字符串前缀约束），deny 永远压过 allow；GUI 审批卡新增「本会话总是允许」（会话级放行，翻不了 deny）。评估顺序：yolo → read → plan/acceptEdits 门 → deny 规则 → 会话放行 → allow 规则 → 交互审批。
- **模型配置档**（`core-model-profiles`）：顶层 `models` 定义多套 provider（baseURL/apiKey/apiKeyEnv/model/models/headers/`format`：`chat-completions` 或 `responses`），`llm.pick` 按档名或模型名路由；`/model [名字]` 切换，GUI 页头下拉多模型时自动出现。
- **思考等级**（`ctx.llm.thinking`）：off/low/medium/high；适配器按 `thinkingParam`（reasoning_effort / thinking / none）下发、`thinkingModel` 可换推理模型；reasoning_content 流式解析为 `ui/thinking`，GUI 渲染成可折叠的思考块（回合结束自动收起，历史回放保留）；REPL `/thinking [等级]`，GUI 页头下拉。

## 计划审批 / 智能体类型 / 任务面板 / 会话导出（v0.5）

- **Plan 工作流**（`tool-plan`）：plan 模式下模型只读研究，`exit_plan` 呈现计划 → GUI 计划卡 / REPL 问答 → 批准自动切 acceptEdits 并同回合执行，拒绝则继续规划。
- **预定义智能体类型**（`core-agent-defs`）：`.sakura/agents/<名字>.md`（description/model/tools + 正文 systemPrompt）注册类型；`subagent` 工具与 GUI 生成对话框都能按名生成。
- **任务面板**：`todo_write` 状态实时显示在 GUI 侧栏（`ctx.todos` + `ui/todos`）。
- **会话导出**（`core-session-export`）：markdown 转写（思考/工具折叠块、图片占位、压缩提示）与过滤 JSON；GUI 会话项 ⬇ 下载、REPL `/export [文件]`、`GET /api/sessions/:id/export`。

## 行级 diff / 上下文计量 / REPL 增强（v0.6）

- **edit 卡片 unified diff**（`src/util/diff.ts`）：LCS 行级差异渲染成 `@@ -a,b +c,d @@` hunk 加红删绿增行；完全相同不渲染，超 2000 行回退整块对比。
- **token 估算**（`src/util/tokens.ts`）：CJK 每字 1 token、ASCII 词片 chars/4、图片部件固定 800；供压缩阈值与 GUI 页头 `⧉` 上下文表使用。
- **按体量自动压缩**：`autoTokens`（默认 48000）在事件计数（`auto`，默认 120）之外独立触发压缩——长回合不再靠事件数漏检。
- **REPL 增强**：流式暗色显示思考内容（main 专属，与正文严格分行）；`/hooks` 列出已配置钩子、`/permissions` 列出权限规则与会话级放行。

## 工作台改版与执行可靠性（v0.7）

- **聚焦布局**：打开就是聊天栏，右侧「工作台」默认收起（右上「协作」打开）；左上项目卡点开是工作区列表；会话按「今天 / 更早」分组；工具失败自动展开完整输出并附复制/展开按钮。
- **模型连接可见**：`state.modelStatus`（`LLMService.modelStatus()`）安全暴露 configured / requiresApiKey / baseURL / 思考能力——前端据此引导配置（未配置时保留草稿）、并只显示适配器实际支持的思考档位；不做联网探测。
- **模型设置**：支持同时更新 endpoint、API Key 与模型；表单密钥留空表示保持，显式清除另有勾选项。0.7.1 修复了无效工作区和保存失败时部分生效的问题，具体边界见下节。
- **停止与排队分离**：GUI 运行中显示独立停止按钮（只停当前回合、排队消息保留并显示本页排队数），旧版「按钮即中断」的误切走结束。
- **子智能体独立会话**：成员卡新增「独立会话」——只读 GET records 查看该智能体自己的会话，不切主会话、不 disposeAll（旧版复用 POST /api/sessions 会拆掉整个花名册）。
- **变更面板**：按**成功**的 `write` / `edit` 工具结果汇总本会话文件变更；失败尝试不计入，行内可点击定位对应工具结果与差异。
- **headless 管道干净**：工具调用/结果/任务/中断与错误通知全部走 stderr，stdout 只留答案本身（`sakura -p` 可安全管道）。
- **压缩阈值暴露**：`CompactionService.autoThreshold` / `autoTokensThreshold` 供 GUI 上下文表使用（`state.contextBudget`）。

## 配置与工作台修复（v0.7.1）

- **可回退的桌面设置**：先验证目标和候选 harness；无效目录、配置加载失败或持久化回调拒绝时保留原工作区、模型路由与桌面字段。未填密钥不再清空，显式清除后同进程切换工作区也不会恢复旧值。清空模型/地址覆盖恢复项目基线，不再恢复上次 UI 覆盖。注册 profile 的凭据覆盖按提供方保存于运行内存；这不是新增的多 profile 持久化格式。
- **运行中的配置保护**：桌面设置和工作区切换在任一智能体运行时返回 `409`，不暗中中断任务；常规模型/思考选择也遵循此限制。纯审批模式仍允许运行中调整，非法组合请求不会先修改权限再报错。
- **发送和停止分开**：运行时发送按钮仍可见，显示「排队发送」；停止只取消当前回合。连续排队按后续独立回合执行，本页排队数在开始时递减，失败请求保留草稿且不自动重发。不是同一回合内的实时 steering，也不提供跨设备精确队列管理。
- **变更可追溯**：三标签导航、键盘顺序和偏好恢复接通；工具卡按会话/智能体/调用标识关联，不同成员相同调用 ID 不串结果。成功文件操作可点击定位；失败的编辑差异标明「拟议变更（未应用）」。
- **内联脚本与 CSP 对齐**：单文件 GUI 的 CSP 脚本哈希按 HTML tokenizer 实际看到的文本（CRLF/CR 已规范化为 LF）计算，而不是原始字节；否则 `index.html` 带 Windows 换行时浏览器会以 CSP 为由拒绝执行自己的内联脚本，页面只剩静态骨架、所有按钮无效。`tests/web-server.test.ts` 固化了这条哈希规则，浏览器套件的「本地服务已连接」断言是最终护栏。
- **桌面窗口进程树追踪**：Edge/Chrome 的 `--app` 根进程会把窗口交给子进程（compat 层握手后根进程立即退出），启动器改为扫描进程树找到真实属主窗口并持续监视；关闭时先对窗口发 `WM_CLOSE`、再终止整棵进程树。`runtime.json` 同时记录窗口属主 PID，smoke 据此校验子进程命令行不泄露密钥。
- **独立会话可靠读取**：快速切换成员时仅最后一次选择可更新阅读器；访客也可只读查看，不重建主会话或花名册。关闭、退出登录及工作区变化时清理阅读器。复制回答、工具输出和代码块共用真实成功/失败反馈。
- **验证边界**：配置回归使用本地 HTTP SSE 模型，检查实际请求地址、模型名和认证头；不是对用户真实模型的连通性测试。桌面持久化经私有管道交给启动器，没有新增磁盘写入确认协议；不能把 HTTP 成功等同于所有断电/磁盘失败场景均已覆盖。显式清除跨进程重启的继承语义未在本轮验证。

### 上游站点、格式与会话命名（v0.7.1 增补）

- **多上游站点与格式**：设置页的「上游站点」按已注册提供方列出（`state.providers`，仅含 id / 默认模型 / 是否默认 / 格式，不含密钥），可保存多个站点配置并切换；每站点独立选择**请求格式**——`chat-completions`（`POST {baseURL}/chat/completions`）或 `responses`（`POST {baseURL}/responses`，OpenAI Responses API）。`responses` 格式把消息映射为 `input` 项（assistant 的历史 `tool_calls` 展开为 `function_call` 项、tool 回合展开为 `function_call_output` 项，无正文内容的 assistant 回合不占项），工具声明使用扁平 schema（`{type:'function', name, description, parameters}`），并解析 `response.output_text.delta` / `response.function_call_arguments.delta` / `response.completed` 等事件——文本、思考摘要、工具调用、用量与 done 原因都与 chat-completions 对齐。不含推理事件的兼容服务在 `completed` 时回落解析 `output_text`。
- **拉取模型列表**：设置页「拉取模型」调用 `POST /api/models/upstream`（仅桌面/操控端可用且与当前工作区一致），GET `{baseURL}/models` 并解析 `{data:[{id}]}`，去重排序后填入模型输入框的候选列表（最多 512 条，15 秒超时）。仅允许 https（loopback http 除外）地址，避免把密钥发到明文端点；该接口只读取列表，不改配置。
- **会话命名**：新建会话时立即要求输入名称（可留空走默认），会话项右侧 ✎ 可随时重命名（`PATCH /api/sessions/:id {title}`，单行 ≤60 字符，自动截断）；标题持久化为 `session/note` 事件，回放与导出都能读到，不再是启动时的时间戳 id。
- **默认模型与端点**：`DEFAULT_MODEL` 为 `gpt-4o-mini`，默认 base URL 指向 `https://api.openai.com/v1`，只回退 `SAKURA_*` 环境变量，文档与示例配置只写 OpenAI 官方示例（配置文件与插件 schema 里仍可自由填写任意兼容服务）。密钥建议用 `SAKURA_API_KEY`。
- **主页与侧栏布局**：欢迎页在常见窗口高度下不再垂直滚动（内容区上边距与间距收紧、低高度下压缩欢迎区）；「新建会话」按钮移到「最近会话」标题与搜索框之间，搜索框下方只保留会话列表本身。

## 健壮性（Windows 及其他）

- **跨平台 shell 发现**：`bash` / `pwsh` 工具与后台任务共享同一套解释器解析（`SAKURA_BASH` / `SAKURA_PWSH` → PATH → 已知安装位置），结果缓存、可用 `resetShellCache()` 重置；POSIX 下子进程置于独立进程组，超时/中断会连同整个进程树一起终止。
- **工具参数校验**：每次调用在审批门前按工具自身的 JSON Schema 校验——缺 required 参数或字符串参数传了非字符串会得到精确报错；`write` 不再会把缺 `file_path` 的调用静默写成字面量 `undefined` 文件。
- **压缩正确性**：压缩标记不会落在"一步进行中"的窗口（assistant tool_calls 尚未收到全部 tool/result 时 defer 到下一个回合边界）；`deriveMessages()` 同时保证绝不产出没有配对 assistant tool_calls 的孤儿 tool 消息——否则 OpenAI 兼容 API 以 400 拒绝，该会话的 resume 会永久损坏。同会话的自动压缩也会串行化，重复触发只产生一个标记。
- **REPL 管道喂入**：`echo "任务" | sakura` 时 stdin 的 EOF 不再杀死刚启动的 turn——'close' 会推迟到本轮（或 `/compact` 这类走模型的斜杠命令）结束，写完答案、flush 会话后再退出；直接 `process.exit()` 会在 Windows 上踩 libuv 的 handle 关闭断言，因此退出走事件循环自然排空。
- **会话切换语义**：`main({ resumeSessionId })` 在目标与当前主会话不一致时真正重绑定（丢弃旧主代理、按目标会话重建），主代理正在跑 turn 时明确拒绝并提示先 `interrupt()`/`wait()`，避免 GUI 切换会话或 `/api/interrupt` 拿到半残状态。
- **模型选择直达请求**：`/model`、GUI 下拉、`/api/settings {model}` 把所选模型名写进发往适配器的请求（`ctx.llm.select()`），换完仍发旧模型或空字符串的问题已修；子代理各自 pin 的模型不被全局选择覆盖。
- **Web GUI 访问防护**：校验 Host、Origin 与请求来源；本地回环别名兼容，远端强制令牌认证，HTTPS 反代必须显式声明 origin。无 Origin 的 curl/CLI 仍需远端凭证；请求体 15s 未读完返回 408 并释放连接。


没有 API Key 时：`npm test`（vitest）不触网；`createHarness({ adapter })` 可注入自定义 `ModelAdapter` 替换默认的 OpenAI 兼容适配器（测试/私有部署同款入口）。注意：默认适配器是**始终注册**的（默认 baseURL 为 `https://api.openai.com/v1`），缺 key 不会在启动时报错——鉴权错误要到真正发请求时才浮出。无 Key 冒烟可直接用仓库自带的 mock 服务器：先 `npx tsx scripts/mock-openai-server.ts`（监听 `http://127.0.0.1:3100`），再跑 `sakura -p "..." --base-url http://127.0.0.1:3100 --model mock-chat --yolo`。

## 架构总览

```text
┌───────────────────────────────────────────────────────────────┐
│ CLI (src/cli.ts)   REPL · -p one-shot · --dump-config          │
└──────────────────────────┬────────────────────────────────────┘
                           │ createHarness(opts)
┌──────────────────────────▼────────────────────────────────────┐
│ harness (src/harness.ts) — BASE_BUNDLE：组合即数据              │
│  core-session → core-system-prompt → core-plugin-registry      │
│  → core-identity → core-approval → core-llm → core-tools       │
│  → core-jobs → core-agent                                      │
│  → tool-fs / tool-fs-search / tool-shell / tool-jobs           │
│  → tool-todo / tool-web / tool-subagent / tool-subagent-control│
│  → tool-plugin-manager → (bundles + pluginsDir drop-in)          │
│  → ui-renderer（终端渲染，只听 ui/* 事件）                      │
└──────────────────────────┬────────────────────────────────────┘
                           │ ctx.plugin(name/inject/apply)
┌──────────────────────────▼────────────────────────────────────┐
│ kernel Context (src/kernel) — 服务注册表 + 五种事件模式          │
│  ctx.sessions  ctx.llm      ctx.tools     ctx.systemPrompt     │
│  ctx.approval  ctx.jobs     ctx.agents    ctx.agentLoop        │
│  插件各自获得作用域 Context；inject 等待依赖；dispose 按 LIFO    │
└───────────────────────────────────────────────────────────────┘
```

一个 turn 的流水线（事件名即公共契约）：

```text
turn/start (waterfall，可改写或拒绝输入)
  └─ 每一步 step（上限 maxSteps，默认 40）：
       agent/pre-step (waterfall；blocked 则收束本轮)
       step/start (emit)
       agent/request (waterfall；可改写模型请求)
       llm/stream (waterfall 包裹适配器流；文本增量走 ui/text)
       tools/pre-execute → tools/execute → tools/post-execute   ← 每个工具调用
       step/end (emit)
  └─ agent/turn-stopping (serial) → 会话关闭
UI 观测事件：ui/turn/start · ui/text · ui/tool/call · ui/tool/result · ui/todos · ui/turn/end
```

会话日志事件：`agent/meta` · `system/message` · `user/message` · `assistant/message`（内嵌流摘要）· `tool/call` · `tool/result` · `assistant/attempt`（仅观测）· `session/note`（仅观测）。`deriveMessages()` 将日志投影为模型消息：最新 `system/message` 置顶、`tool/result` 还原为 tool 消息、`assistant/attempt` 不进入历史。

几个值得知道的工具行为细节（均已由测试覆盖）：

- `edit` 是**字面量**字符串替换：`old_string` 按精确文本匹配（需唯一，或传 `replace_all`），`$` 系列替换模式不会被展开。
- `glob` / `grep` 兼容 CRLF 文件（匹配前先剥掉行尾 `\r`，`$` 锚点看到的是真实行内容）；只有当模式显式引用了点前缀（如 `.gitignore`、`.*`、`config/.env*`）时才会扫描 dotfiles。
- `web_fetch` 流式读取响应，内容截断在 400KB（400_000 字节），不会把超大响应整个缓冲进内存。
- `bash` / `pwsh` 的解释器按 env → PATH → 已知位置自动发现（见「Windows 支持」一节）；后台任务超时/中断会连同进程树一起终止，任务日志落在 `.sakura/jobs/job-N.log`。
- 中断按 turn 粒度：`interrupt_agent` 只取消目标代理的当前 turn（每个 turn 使用全新的 `AbortController`），该代理之后仍可继续使用；Ctrl+C 退出 REPL 则随 harness 卸载中止所有在跑的 turn。
- 工具参数先过 Schema 校验：缺 required 参数或字符串参数类型不符会得到精确报错（而不是 `String(undefined)` 式的静默伪造）。
- `/compact` 不会切断进行中的步骤：若会话里有尚未收到 `tool/result` 的工具调用，压缩会**推迟**（返回 deferred），等本轮结束后下一机会再压，避免压缩标记落在一对 call/result 之间；`deriveMessages` 投影也会丢弃已被标记截断的孤儿 `role:'tool'` 消息，双保险。
- 会话切换是真正的重绑定：`harness.main({ resumeSessionId })` 在目标会话与当前主会话不同时丢弃旧主代理并按目标会话重建；主代理正在跑 turn 时会拒绝并提示先 `interrupt()`/`wait()`。Web GUI 的 `POST /api/sessions` 走同一路径，启动时传的 `--resume` 只在启动时生效一次，不会顶掉之后的切换。
- 模型选择直达请求：`/model`、GUI 下拉与 `/api/settings {model}` 都会把所选模型名写进请求（`ctx.llm.select()`），而不是只改路由——之前的「换完仍发旧模型/发空字符串」已修；子代理按各自 handle 的 model 行事，不会被全局选择篡改。
- Web GUI 默认仅限本机；远端监听强制令牌、请求同源校验和访客只读，HTTPS 反代 origin 需显式配置。请求体 15s 内未读完返回 408 并释放连接，不再被挂住的 body 拖死。

## 插件开发指南

一个插件就是一个导出 `name` / `inject` / `apply(ctx, config)` 的模块。仓库里的 `plugins/sakura-plugin-clock/index.js` 是真实的开箱示例：

```js
export const name = 'sakura-plugin-clock'
export const description = 'now — returns the current local time (out-of-tree example)'

export const inject = ['tools'] // 声明依赖的服务键；未就绪时内核自动等待

export function apply(ctx, config) {
  const prefix = config?.toolPrefix ?? ''
  ctx.get('tools').register({
    name: `${prefix}now`,
    description: 'Get the current local date and time (example plugin).',
    kind: 'read',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ output: new Date().toString() }),
  })
}
```

**挂载方式**：drop-in 目录与 bundles **二选一**（plugin rows 只负责注入配置或禁用，不引入新插件）。同一插件重复挂载会报错（同名工具二次注册直接抛异常）；harness 会按插件名（模块导出的 `name`）对 `bundles:` 与 `pluginsDir` 扫描的结果去重，但这层保护不应被依赖——请保证一个插件只通过一种方式挂载：

1. **drop-in 目录**：放进 `pluginsDir`（默认 `plugins/`），`plugins/<name>/index.js`（或 `index.mjs`）自动发现；顶层 `*.js` / `*.mjs` / `*.cjs` 文件同样会被扫描。
2. **bundles**：在 `sakura.yml` 的 `bundles:` 列表里写模块 specifier（文件路径或 npm 包名），在 base bundle 之后挂载；路径不应落在 `pluginsDir` 之下。
3. **plugin rows**：`sakura.yml` 的 `plugins.<name>` 行注入 `config` 或 `disabled: true`。

**常见扩展点**：

```js
// 监听事件（可逆：返回值即 disposer）
ctx.on('tools/post-execute', async (payload, next) => {
  // payload.output 可改写；throw 可拦截
  return next(payload)
})
ctx.on('ui/turn/end', (p) => console.log(`turn of ${p.agentId} finished`))

// 注册工具（inject: ['tools'] 后 ctx.get('tools')）
ctx.get('tools').register({ name: 'my_tool', kind: 'read', /* … */ })

// 追加系统提示词 section（inject: ['systemPrompt']，priority 越小越靠前）
ctx.get('systemPrompt').add('team-rules', 'TypeScript strict, no any.', 30)
```

**kernel 全 API 速查**（`Context`）：

| API | 作用 |
| --- | --- |
| `provide(key)` | 声明服务键，返回 disposer |
| `set(key, value)` | 为已 `provide` 的键赋实现 |
| `get(key)` / `peek(key)` / `has(key)` | 解析服务（沿父链回溯）/ 容错解析 / 存在性判断 |
| `on(event, fn, { prepend })` | 注册监听器，返回 disposer |
| `emit(event, ...)` | fire-and-forget，注册顺序，无返回值 |
| `parallel(event, ...)` | 并发等待，无返回值 |
| `serial(event, ...)` | 顺序等待，收集返回值 |
| `bail(event, ...)` | 顺序执行，直到某监听器返回非 `undefined` |
| `waterfall(event, base, payload)` | 环绕中间件：`next()` 委托下游，不调 `next()` 即短路 |
| `effect(setup)` | 可逆副作用包装，随上下文 LIFO 释放 |
| `plugin(p, config)` | 挂载插件（`inject` 等待依赖），返回插件作用域 Context |
| `start()` | 触发 `kernel/start`（parallel） |
| `fork()` | 子 Context：共享父服务与监听器，注册相互独立 |
| `dispose()` | LIFO 释放全部注册与服务 |

## 配置参考

配置分层（后者覆盖前者）：内置默认 → `~/.sakura/config.yml` → 项目 `sakura.yml` / `sakura.yaml` / `sakura.config.yml`（取第一个存在的，或 `--config <file>` 指定）→ `--patch` 内联 YAML → CLI flags。

`sakura.example.yml` 关键字段：

| 字段 | 说明 |
| --- | --- |
| `profile` | 激活的 profile 名（默认 `default`） |
| `profiles.<name>` | 命名组合：`bundles` 列表 + `plugins` 行覆盖（config 深合并、disabled 覆盖） |
| `bundles` | 外置插件模块 specifier（文件路径或包名） |
| `pluginsDir` | 插件扫描目录（默认 `plugins`，目录不存在则跳过） |
| `systemPrompt` | 追加到系统提示词的文本 |
| `plugins.<name>.config` / `.disabled` | 插件行：注入配置或禁用任意内置插件 |

常用插件行：`core-llm`（`baseURL` / `apiKey` / `apiKeyEnv` / `model` / `models` / `format`：`chat-completions`（默认）或 `responses`）、`core-approval`（`mode`）、`core-agent`（`maxSteps` / `allowNestedSubagents` / `defaultModel`）、`core-session`（`dir`）、`core-jobs`（`dir`）、`tool-shell`（`defaultTimeoutMs`）、`tool-fs`（`maxReadLines`）、`tool-subagent`（`toolName`）。`core-session` / `core-jobs` 的 `dir` 是生效配置：只有当你没有配置时，harness 才回落到默认的 `<cwd>/.sakura/sessions` / `<cwd>/.sakura/jobs`。

CLI flags（与 `sakura --help` 一致）：

| Flag | 说明 |
| --- | --- |
| `-p`, `--print` | one-shot：执行 prompt 后退出 |
| `--yolo` | 自动批准所有工具调用 |
| `--mode <mode>` | 审批模式：`plan` / `default` / `acceptEdits` / `yolo`（优先级见下方注） |
| `--model <model>` | 聊天模型（默认 `gpt-4o-mini`） |
| `--base-url <url>` | OpenAI 兼容 API base URL |
| `--max-steps <n>` | 单轮步数上限（默认 40） |
| `--allow-nested` | 允许 subagent 再 spawn subagent |
| `--resume <id>` | 恢复历史会话 |
| `--profile <name>` | 选择配置里的命名 profile |
| `--config <file>` | 指定配置文件 |
| `--patch <yaml>` | 最后应用的内联 YAML 补丁 |
| `--dump-config` | 打印解析后的组合并退出 |
| `-h`, `--help` / `--version` | 帮助 / 版本 |

> 注：审批模式优先级为 `--yolo` / `--mode` flags → 配置（profile 解析后）里 `core-approval` 行的 `mode` → 默认 `default`。`--mode` 已接线到运行时，取值会校验（不在 `plan` / `default` / `acceptEdits` / `yolo` 之内时启动即报错）。

`--dump-config` 输出示例（结构）：

```json
{
  "profile": "default",
  "pluginsDir": "plugins",
  "bundles": [],
  "disabledPlugins": [],
  "model": "gpt-4o-mini",
  "approvalMode": "default",
  "pluginRows": { "core-llm": { "config": { "model": "gpt-4o-mini" } } }
}
```

## 多智能体使用

`subagent` 工具把自包含任务委派给一个拥有独立会话、独立系统提示词与工具集的子代理：

| 参数 | 说明 |
| --- | --- |
| `description`（必填） | 委派标签，如 "explore auth module" |
| `prompt`（必填） | 完整、无歧义的任务指令 —— 子代理看不到父对话 |
| `model` | 子代理模型 id（可用 `list_subagent_models` 查询） |
| `run_in_background` | 后台运行，立即返回句柄 |

后台模式配合控制工具使用：

- `list_agents` —— 查看全部智能体的状态、会话与最近结果；
- `send_message { agent_id, message, wait? }` —— mailbox 投递；代理运行中则排队，`wait: true` 等待处理完成；
- `interrupt_agent { agent_id }` —— 中断其当前 turn（`AbortController`）。

**工具策略**（`core-agent` 的 `ToolPolicy`）：`full`（全部工具）/ `core`（摘除 subagent 家族）/ 显式工具名白名单数组。当 `allowNestedSubagents: false`（默认）时，即使是 `full` 策略也会摘除 `subagent` 与 `list_subagent_models`，防止无限嵌套；`--allow-nested` 或 `core-agent` 行配置可打开嵌套。主代理（role `main`）跨 turn 持久会话，子代理默认每 turn 新会话。

## 测试与开发

```bash
npm run test        # vitest run（include: tests/**/*.test.ts）
npm run test:watch  # vitest watch
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/（bin: sakura → dist/cli.js）
npm run dev         # tsx src/cli.ts
```

目录结构：`src/kernel`（微内核）· `src/core`（session / llm / tools / system-prompt / approval / jobs / agent 服务）· `src/tools`（内置工具插件）· `src/plugins`（identity / renderer）· `src/harness.ts`（组合）· `src/cli.ts`（入口）· `src/config.ts`（分层配置）· `plugins/`（drop-in 示例）。

测试用 vitest 编写（`vitest.config.ts`：30s 超时，扫描 `tests/**/*.test.ts`），`npm test` 一次跑完；现有 **38 个测试套件、466 个用例**，覆盖内核、会话（投影/压缩/恢复）、配置、agent loop、工具与参数校验、审批与权限规则、shell 跨平台发现与进程树终止、后台任务、hooks、skills/命令、MCP（stdio + HTTP/SSE）、web 服务器（含同源与 body 超时加固）、Web 工作区真实浏览器交互、渲染器与端到端。其中 `tests/e2e.test.ts` 不做任何适配器替换——真实的 OpenAI 兼容适配器（`src/core/llm.ts`）走 HTTP SSE 对接 `scripts/mock-openai-server.ts`（零依赖的脚本化端点，并顺带用真子进程冒烟 CLI：`--version` / `--dump-config` / 管道喂入 REPL 的端到端回归）。该 mock 服务器也可独立运行做无 Key 调试：`npx tsx scripts/mock-openai-server.ts`（监听 `127.0.0.1:3100`，见[快速开始](#快速开始)）。

Windows 上运行浏览器回归时，建议给测试子进程一个独立且完整的 `HOME`/`USERPROFILE`（包含 `AppData/Local` 与 `AppData/Roaming`，并同步 `LOCALAPPDATA`/`APPDATA`/`TEMP`/`TMP`），同时移除继承的 `__COMPAT_LAYER`、`CHROME_CRASHPAD_PIPE_NAME` 和 `EDGE_*` 变量：Chrome 对默认用户目录的校验依赖 KnownFolder，空隔离目录会直接启动失败。仓库测试不读取你的真实模型凭据；需要固定浏览器时设置 `SAKURA_CHROME` 为已安装的可执行路径。

## Roadmap

- `read_image` 多模态读取工具（tool/result 图片回放已就绪，直接按路径读图尚未接入）
- 会话日志 zstd 压缩与跨版本格式迁移（v0 尚无）
- GNU 风格 job 控制（`jobs` 服务已具备 start / list / output / kill 底座）
- MCP 客户端能力补齐（resources / sampling / 生命周期通知）
- 桌面 SEA 客户端（`build/SakuraCode.exe`）的代码签名与自动更新
- 工具长尾：LSP 符号检索、图片 diff、语音输入

## License

TBD
