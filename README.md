# SakuraCode

[![樱落生态成员](https://raw.githubusercontent.com/Guyao146/Sakura-EcoSystem-wiki/main/assets/ConnectEcoSystem.svg)](https://mcylyr.cn)
[![已编写Wiki](https://raw.githubusercontent.com/Guyao146/Sakura-EcoSystem-wiki/main/assets/sakura-wiki.svg)](https://wiki.mcylyr.cn/)

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

## v1.0.0 正式版

本次将此前 0.7.3–0.7.7 的桌面体验与可靠性改进一并发布为 1.0.0。下载、升级步骤及验证限制见 [v1.0.0 发行说明](docs/releases/v1.0.0.md)。

### 可靠性修复

- 长驻后台预览服务不再阻止影响预览、编辑重发和只回滚对话；这些操作保留项目代码与后台任务。恢复代码仍须停止后台任务，结束后刷新预览并重新确认。
- 会话日志写入成功后才发布到内存和订阅者；磁盘故障不会把失败消息或已回滚附件带入下次模型请求。
- 删除当前会话清理未发送附件并保留文字草稿；切换会话后的迟到响应不再清空新草稿或改变新会话的专家状态。
- 专家模式切换期间仍可编辑草稿，但暂停发送；服务端校验目标会话、专家模式与团队变更，避免错误分发。
- 文件读取中止会显示失败并允许移除；旧版图片接口严格校验格式与合计数量，图片同样独立保存到每个成员的会话目录。

## v0.7.6 更新

- 对话支持拖入、选择或粘贴任意类型文件，发送前预览名称／大小并可移除；点击发送才上传，保存附件失败保留草稿，未确认结果不自动重发。
- 已发送消息按文字、图片、文件卡片纵向右对齐，刷新可回放；附件正文不进入侧栏会话标题或任务摘要。
- 专家模式移至对话顶栏，开启只创建待命团队，不发送草稿；发送时主智能体和每位专家分别保存附件副本。
- 附件数量／大小与文本上下文有明确上限；PDF、Office、ZIP 等二进制保留原始字节，不自动解析或执行。

## v0.7.5 更新

- 最近会话标题与数量相邻，「新建」移到「多选」左侧；统一修正描述／操作按钮的留白。
- 新 Key 仅列出普通模型分组，桌面一行三个、窄屏自适应；倍率四舍五入显示两位小数，不改变实际计费精度。
- 增加页面、面板、弹窗和下拉菜单的轻量过渡，遵循系统减少动态效果偏好；不延迟输入、焦点或权限状态。
- 「关于与更新」可保存自建 HTTPS 更新源，读取稳定版本、更新说明、同源下载地址和 SHA-256；不会静默安装。提供无依赖发布脚本／只读服务器，见 [桌面更新部署说明](docs/desktop-updates.md)。

## v0.7.4 更新

- Skill、MCP 独立设置页；插件页合并「本地插件」与可联网搜索的 npm 插件市场。
- 修复断线／记忆整理／上下文操作锁死聊天草稿，完善中文输入法确认与桌面宿主焦点转交。
- 删除设置内容区右上角关闭叉号，统一数字、文本与多行输入框样式；账号、历史和用户配置均保留。

## v0.7.3 更新

- 新增可配置的失败自动重试，达到次数或时间上限后须手动确认。
- 新增 Skill 文件／文件夹导入，以及会话、Skill、智能体和跨工作区记忆的分类 `@` 引用。
- 工作区记忆默认开启，保存为 Markdown，在设置中按需展开管理；支持按积累量或时间自动整理长期记忆。

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

Windows 10/11 x64 上可构建双击启动的 **SakuraCode Desktop.exe**：原生启动器内置独立运行引擎，以无标题栏原生窗口承载系统 Chrome / Edge 的应用内容（没有浏览器标签栏、地址栏或额外标题栏）；项目和模型设置位于主界面，不弹启动前设置窗，也不是把 CLI 快捷方式重命名成桌面版。它沿用 Web GUI 的会话、协作、审批和运行看板。

```powershell
Set-Location 'D:\VSProject\SakuraCode'
# 构建内置引擎与桌面 GUI，需要 Node 24、Windows .NET Framework 的 C# 编译器
npm.cmd run desktop
# 构建并复制到当前用户桌面；不覆盖旧的 SakuraCode.exe 或已有桌面设置
npm.cmd run desktop -- --install
& 'D:\VSProject\SakuraCode\build\SakuraCode Desktop.exe'
```

- **运行环境**：Windows 10/11 x64、.NET Framework 4.8、已安装的 Chrome 或 Edge；不需要 Node/npm。默认优先 Edge，也可用 `SAKURA_CHROME` 指定已安装浏览器的完整路径。无需管理员权限，不修改系统防火墙或安装浏览器扩展。
- **启动直进工作区**：双击即启动上次的工作区（首次为「文档」目录，或 `--workspace` 指定目录）；左下角账号右侧的设置齿轮打开分类设置页，在「工作区与记忆」选择可信项目目录。桌面版通过官网授权连接 SakuraAPI，模型只能从授权 Key 返回的可用列表选择，上游固定为 `https://api.sakuraapi.top/v1`，不提供手填地址或 Key。旧桌面配置、项目模型配置与模型环境变量不会切换桌面上游；CLI / 普通 Web 的自定义模型配置仍可使用。默认工具需审批，主界面内仍可切换模式。
- **工作区切换**：点击左上项目卡展开最近项目，选择目标后确认，或在设置中填写新目录保存。任一智能体运行时切换返回 `409`，不会替你停止任务；先等待完成或明确中断再切换。同进程内重建 harness，会话历史按工作区保留在 `.sakura/sessions`，可随时切回；SakuraAPI 授权、模型选择与审批模式跨工作区保留。仅打开可信项目：项目插件 / 工具能操作其中代码。
- **密钥保护**：桌面版默认在当前 Windows 用户下用 DPAPI 加密记住独立客户端账号凭据和所选 API Key，下次启动恢复有效授权，无需每次登录。可在「账号与余额」取消保存；已连接的内存授权也可直接开启保存，不重复官网授权。账号令牌与模型 Key 分开使用，不写到项目配置、命令行参数、浏览器 URL、工作台页面或明文桌面设置中；仅经私有管道传给本机引擎，分别用于官网获准账号接口与固定模型接口。DPAPI 不是同用户隔离沙箱。
- **窗口生命周期**：正常启动无命令行黑窗，也没有启动前设置窗口，直接打开上次的工作区。最小化按钮或托盘菜单「收起到托盘」隐藏主窗口及任务栏按钮，后台任务继续；双击托盘樱花、「打开工作区」或重复启动恢复原窗口、草稿和最大化状态，不重建浏览器。关闭主窗口会停止引擎及其工具 / MCP / 浏览器子进程，Windows Job Object 也负责桌面壳异常退出时的清理；引擎意外退出时会提示并整体退出，而不是回到设置窗。
- **无标题栏窗口**：最小化、最大化／还原、关闭按钮合并到现有页面右上角，不额外增加一条标题栏；拖动顶部空白区域移动窗口，双击可最大化／还原，边缘仍可调整大小。关闭与 Alt+F4 都执行完整后台清理。这里只改变桌面壳，普通浏览器里的 Web GUI 不会隐藏浏览器窗口控件。
- **本机边界**：固定 `127.0.0.1` 和随机空闲端口，桌面模式不继承远端 `web` 配置 / 令牌；继续执行 Host/Origin 检查。同机应用可访问该本地服务；这不是多用户隔离。远端运行仍使用下面的 `--web` 部署方式。
- **数据位置**：设置、DPAPI 密钥密文、专用浏览器 profile、引擎缓存及滚动启动日志位于 `%LOCALAPPDATA%\SakuraCode\Desktop`。会话仍按项目保存在 `.sakura/sessions`（或项目自行配置的目录）。程序内嵌引擎和页面，不依赖开发仓库；移动单个 exe 不会自动迁移用户设置 / 项目历史。
- **签名与更新**：当前为未签名本机构建，可能提示未知发布者。「关于与更新」可手动／定时检查 GitHub 或自建 HTTPS 更新源，查看说明、下载与声明的 SHA-256；不静默安装。先退出并备份旧 EXE，下载后核对哈希，只替换程序文件，现有配置和会话不被覆盖。自建部署见 [桌面更新服务器](docs/desktop-updates.md)。

诊断参数：`--workspace <绝对路径>` 预选项目（否则沿用上次工作区）；`--data-dir <绝对路径>` 用独立用户数据测试。正常窗口不开放 CDP 调试；仅本地测试时设置 `SAKURA_DESKTOP_DEBUG=1`，并在结束后清除。

启动器使用原生 Toolhelp 进程快照寻找 Chromium 窗口，不反复加载 WMI；专用浏览器禁用后台网络预加载和不需要的内置扩展后台页，仍保留多进程安全沙箱。会话列表以流式 JSONL 生成有上限的元数据缓存，未变化日志不再重复读入完整历史；每次读取仍校验普通文件、大小、修改时间和文件标识，外部写入／删除／归档会失效。没有 SSE 订阅者时不做无消费者的全量刷新；并发状态事件合并为一份有修订校验的快照。隐藏的协作面板不在启动时扫描其他工作区，展开后才读取历史。以上不关闭记忆／MCP 功能，不删除历史；Chromium、GPU 与配置的项目插件仍有实际资源开销。

桌面端到端验证：构建后运行 `npx tsx D:\VSProject\SakuraCode\scripts\desktop-smoke.ts`，也可追加安装产物的绝对路径。使用隔离的临时中文项目、合成授权 Key 和仅存在于该临时项目的测试插件，把固定官网查询／模型请求替换为本地 mock 响应；不增加产品侧的上游绕过开关、不访问真实账号。实际驱动固定上游校验、设置 HTTP API、工作区切换、记忆开关／清空／重启持久化、DPAPI 加密回环、聊天／刷新／看板、单实例、正常退出和桌面壳崩溃后的子进程清理。官网弹窗回传另由 `D:\VSProject\SakuraCode\tests\sakuraapi-authorization-browser.test.ts` 使用真实 Chromium 与拦截的合成官网页面验证。截图和 `desktop-smoke-verification.json` 报告保存在 `D:\VSProject\SakuraCode\tmp\desktop-previews`（其他 checkout 使用对应的绝对路径）；不会保存真实 API Key 或修改实际桌面用户配置。锁屏时不会发送物理输入，真实鼠标拖动／双击和 Alt+F4 会明确列为跳过，完整交互验证需在桌面已解锁时运行。

若自动化环境无法取得安全的前台焦点，可显式运行 `npx tsx D:\VSProject\SakuraCode\scripts\desktop-smoke.ts "D:\VSProject\SakuraCode\build\SakuraCode Desktop.exe" --no-physical-input`。该模式不发送物理鼠标／键盘输入，报告将原生焦点截图／边缘像素、拖动／双击、Alt+F4 列为**未验证**，仍完整执行原生窗口 API、页面 CDP、模型请求、持久化和退出清理检查。默认完整交互模式仍会将焦点失败作为失败，不自动降级为通过。

桌面窗口尺寸回归使用真实 HWND 缩放，并检查快速连续缩放、最大化／还原和视图切换后，页面视口与内嵌浏览器客户区一致。390px 等响应式模拟只在独立的临时浏览器中运行；测试结束或失败都会清除模拟尺寸，不能把 1440px 虚拟页面留在 1090px 的原生窗口里。截图仅捕获当前视口，不以虚拟截图宽度代替实际窗口边界。

## Web GUI

`sakura --web` 启动本地 Web 服务（默认 `http://127.0.0.1:3099`，仅绑定回环地址），同一进程内承载完整的 harness：聊天流（SSE 实时推送 ui/* 事件）、工具调用卡片（参数/输出/耗时/截图）、审批卡片（允许/拒绝）、多智能体面板（花名册 + 状态 + 中断 + 消息）、MCP 服务器面板、会话切换与历史回放、审批模式切换、明暗主题（默认夜间）。

```bash
sakura --web [--host 127.0.0.1] [--port 3099] [--no-open] [--resume <id>] [--yolo | --mode <m>]
```

Web 客户端页面位于 `D:\VSProject\SakuraCode\src\web\index.html`（零依赖、无外部字体/CDN），VIP 图片位于 `D:\VSProject\SakuraCode\src\web\assets\vip`：开发模式由服务端读盘，普通编译复制资源，独立客户端及桌面构建将页面和十张图片内嵌进 exe，不依赖桌面原图。SSE 帧与 REST API 的完整契约见 `D:\VSProject\SakuraCode\src\web\server.ts` 头注释。

### 工作区布局

- **视觉风格**：深色石墨灰底色搭配樱花粉强调色（日间主题为暖白底配深樱花粉）。品牌标识、卡片化的项目／会话条、图标空态与圆角输入区统一在「樱落」设计语言下；所有图标均为内置 SVG，无外部字体或 CDN。
- **分类设置页**：左下角账号区右侧的齿轮打开独立设置页：账号与余额、通用与外观、模型设置、工作区与记忆、**Skill、MCP、插件**、集成与连接、关于与更新。设置内容区不再有右上角关闭叉号，使用「返回工作区」恢复原面板偏好及聊天输入焦点；桌面窗口的关闭按钮保留。数字、文本及多行输入框使用统一全宽圆角样式、主题色和键盘焦点提示。
- **授权后窗口错位**：若账号已连接但设置卡片偏到右侧、窗口按钮消失，这与官网拒绝授权不同。桌面容器会在重新激活及既有监控检查时校正嵌入浏览器的实际尺寸；尺寸正常时不重复调整。旧版可先轻微调整主窗口大小恢复显示，无需退出授权或清空设置。诊断与验证边界见 [桌面授权后布局](docs/desktop-account-layout.md)。
- **资源分类**：Skill 页显示实际已加载的 Skill 数量、项目／用户／额外目录来源、搜索、按需展开正文、刷新及导入。MCP 页独立显示连接状态、错误、重连与 MCP 工具。本地插件列表和联网市场集中在「插件」页的两个标签中，本地工具目录不混入 MCP 工具。

- **左侧 · 项目与会话**：显示当前项目、搜索历史、创建／切换会话及导出 Markdown；`Ctrl / ⌘ + K` 定位会话搜索。「多选」支持逐项选择或全选当前搜索结果中可删除的会话，确认后仅删除会话日志／附件，不删除、回滚项目文件。每批最多 100 个，运行中、协作绑定、压缩中或待处理会话会被保护；文件占用等部分失败会明确回显，不会自动重试。
- **中间 · 对话**：顶栏展示会话标题、专家模式、运行状态与面板入口。模型、审批模式、思考等级与上下文入口集中在输入区；访问方式、版本、服务连接、工具数和 token 信息在「设置 → 关于与更新 → 工作区状态」。上下文查看器展开在输入卡片上方，不遮挡草稿。断线、模型未配置、记忆整理或上下文操作只限制发送，不再锁死本地草稿，输入区明确显示原因；只读访客／历史仍不可写。中文输入法确认不触发发送。桌面宿主激活时将原生键盘焦点交还其内嵌 Chromium，不重置网页光标，不抢其他应用焦点。
- **紧凑对话**：超过 600 字符或 10 行的任务／回答默认收成一行，显示最新输出行的尾部摘要，流式输出实时更新。专家输出默认整卡折叠，点击或键盘 Enter 展开；「收起长对话／展开对话」可批量操作。完整文本、复制、附件、工具和历史不删除，不会自动调用模型压缩上下文。当前页面的手动展开选择在回合结束的历史同步中保留，刷新后恢复默认折叠。

登录保存、专家内部记录、折叠与托盘的行为／验证边界见 [桌面对话与登录体验](docs/desktop-conversation-refinements.md)。
- **任意文件附件（0.7.6）**：拖入对话区、点击回形针选择或粘贴文件；不限制扩展名，最多 12 个／单个 8 MiB／合计 16 MiB。发送前仅在浏览器读取，文件卡显示名称与大小，可移除，点击发送才上传。UTF-8 文本正文进入本次模型上下文（单个最多 32,000 字、合计 64,000 字，超限明确标记截断）；PNG/JPEG/GIF/WebP 作为视觉附件；其他二进制（含 PDF、Office、ZIP）只保留原文件和元数据，不宣称解析正文，不自动执行、解压或安装。原始字节按消息存入会话目录 `attachments`，不会覆盖原文件；刷新后已发送附件可见，删除会话同时删除该会话副本。切换会话／工作区移除未发送附件，避免误投；断线时仍可整理本地附件，重连后手动发送。所选模型将收到附件内容，勿上传秘密文件。
- **右侧 · 工作台**：默认收起。任务进度固定在顶部、位于「协作／变更」标签之前，长任务列表单独滚动，切换标签仍可见。「协作」展示已知工作区与会话概览、成员状态和独立会话；「变更」列出当前记录中成功的 `write` / `edit`，点击定位并展开工具结果。专家共享主会话的已提交上下文，但原始归档日志仍归入「专家内部记录」，不混入左侧普通会话；不删除磁盘日志，重启后可只读查看并从主会话重放共享专家卡。两个标签支持方向键及偏好恢复；Skill、插件与 MCP 在各自设置页中。当前工作区使用真实 SSE 运行状态，其他最近工作区只读取持久会话历史并标明「历史」，不会因此启动智能体／插件或宣称后台任务仍在运行。仅监测此 SakuraCode 实例，不是多实例／多服务器状态聚合。变更列表不是 Git 差异，也不追踪命令间接修改；实时子智能体变更会带来源。
- **多智能体操作**：点击「新建智能体」，可选预定义类型、模型、专属指令和初始任务；也可先创建待命成员，再通过「发消息」派发独立任务。多个成员可并行运行，运行中的消息按邮箱排队，可单独中断。主会话的停止按钮只控制主智能体。
- **面板调宽**：拖动左侧对话栏的右边缘、右侧工作台的左边缘即可调整宽度，偏好保存在当前浏览器，收起／恢复后仍保留。双击分隔线或聚焦后按 `Enter` 恢复该栏默认宽度；聚焦分隔线后用左右方向键微调，`Shift` 加速，`Home`／`End` 调到允许的最窄／最宽，拖拽时按 `Esc` 取消。窗口变窄会自动限宽、保留中间对话空间，重新放大后恢复原偏好；中等宽度的工作台抽屉仍可调宽，手机抽屉不显示拖拽分隔线。「设置 → 通用与外观 → 恢复默认布局」同时重置两栏宽度。
- **响应式与键盘**：桌面两侧面板可独立收起，偏好与主题保存在本机浏览器；中等宽度把工作台改为抽屉，手机宽度把两侧均改为抽屉，保留对话空间。统一选择框支持方向键、Home／End、Enter、Escape，长列表可搜索，日夜主题使用一致样式。`Esc` 关闭抽屉／对话框，工作台标签支持左右方向键，设置分类支持上下方向键。

### SakuraAPI 官网授权

点击左下角「登录 SakuraAPI」进入「账号与余额」，再点击「授权登录」。系统默认浏览器打开本机一次性接收页；点击「前往官网授权」进入 `https://sakuraapi.top/client-authorize.html`。在官网确认账号并点击「同意并连接账号」后，SakuraCode 用一次性授权码和 **S256 PKCE** 获取独立客户端账号凭据，自动同步资料、VIP、余额、有效订阅与累计用量。**连接账号不创建或自动选择模型 Key**：前往「设置 → 模型设置」选择已有 Key，或选择本人可用的 1–32 个模型分组并明确确认创建。已有官网登录可复用，但授权不静默进行。

- 不读取密码、浏览器 profile、官网 `localStorage` 或浏览器登录令牌。授权消息验证精确官网 origin、本次 popup、state 与 clientId；native/server 端换码，PKCE verifier 不传给网页。随机回环路径、Host / Origin 检查及一次性消费保留；不确认的换码结果不重放，需重新授权，不清理系统浏览器登录。
- 仅在本机接收端明确确认**已收到有效授权结果**后，尝试关闭本次打开的官网授权弹窗及本机接收页；不关闭无关标签或系统浏览器。普通标签可能被浏览器禁止脚本关闭，此时保留「可手动关闭」提示。等待、拒绝、官网报错、回传失败或缺少确认时不自动关闭；回传可明确重试同一结果。已回传不等于凭据已换取或保存，后续连接／保存失败仍在软件中提示重试。
- 桌面版默认 **Windows DPAPI 加密记住授权**，客户端 access/refresh token 与所选 Key 一起存入独立加密文件 `%LOCALAPPDATA%\SakuraCode\Desktop\sakuraapi.json`，采用原子写入和匹配私有管道确认。账号页支持已登录后更改保存状态，取消保存仅移除密文、保留当前连接，退出则撤销客户端会话。保存失败保持原状态并回显错误。轮换串行；新刷新令牌保存失败暂停查询，明确同步重试保存，不重复消费旧刷新令牌。普通本地 Web 仅内存保留授权；远端操作员／访客不能访问本机账号。旧 Key 授权可继续用；更老账号 JWT 不会当作 Key，需重新授权。
- 账号栏与账号摘要仅显示用户名／邮箱和连接状态，**VIP 徽章只在「账号与余额 → VIP 会员资料」显示**。VIP1–VIP10 使用内置图片；非 VIP、功能关闭、未知等级或响应缺失显示安全文字，不猜测等级、不按充值阈值推算。VIP 使用客户端权限允许的 `/api/v1/usage/dashboard/snapshot-v2`，不假设拥有网页 `/user/vip` 权限。
- 选择已有 Key 时复查所有权、状态、过期及额度；创建须确认并使用固定 UUID 幂等键，同一次失败重试保持同一请求体，不自动再次创建。只有所选 Key 用于 `https://api.sakuraapi.top/v1`，账号令牌仅发送到固定获准官网账号路由。模型来自 Key 可用列表，拒绝重定向与手工上游覆盖。账号余额、订阅余量、累计费用使用白名单字段并与 Key 配额区分；缺失数据为「未提供」或 `—`，不限额不伪装成零余量。
- 已有 Key 选择／分页、模型分组创建、当前调用 Key 信息、同步和官网 Key 管理入口集中在「模型设置」，Key 操作错误直接在该页及创建确认框回显。「账号与余额」保留账号授权、VIP、余额、订阅、用量及前往模型设置的入口。
- 每个有效订阅分别显示**日／周／月剩余额度**和对应进度条，周期不相加。进度只使用该周期已提供的上限和余量；零余量为 0%，超过上限时仅将图形限制到 100%，数值仍保留服务端值。上限为 0 显示「不限额」且不绘制虚假比例；周期／上限／余量缺失时明确标注未提供、不估算比例。服务器返回重置时间时一并显示，窄窗口按周期纵向排列。
- 「设置 → 通用与外观 → SakuraAPI 额度显示」提供 **常驻显示**（默认）、**悬停弹出**、**仅在设置**。悬停模式在指针进入或键盘聚焦输入区时向上弹出，不挤动聊天与输入框；触屏可点击「额度」，键盘在额度按钮按 `↑` 进入浮层操作，`Esc`／「收起」／点击外部可关闭。刷新与充值按钮仍可使用；仅在设置模式下，余额、订阅余量、同步、充值及退出授权仍保留在「账号与余额」。
- 显示偏好为 `appearance.quotaDisplay`（`always`／`hover`／`settings`）。桌面版保存在 `%LOCALAPPDATA%\SakuraCode\Desktop\settings.json` 的 `Appearance` 字段，通过独立的本机操作员 API 和有确认的私有管道保存，跨随机端口、工作区与重启保留，不改动已有凭据或上下文阈值。普通 Web 使用当前 origin 的浏览器 `sakura-appearance` 存储；远端／访客只能改变自己的浏览器外观，不能读取本机账号或写桌面配置。保存失败会回显错误并保留原显示方式。
- 客户端会话连续 **120 小时（5 天）未使用**失效；最长一小时的 access token 在有效会话内透明轮换。后台 refresh 不延长闲置期限；新版账号不使用定时查询或心跳保活，仅启动、打开账号、明确同步、窗口实际激活和发送模型请求等真实操作查询／报告活跃。`idle_expires_at` 是服务器快照，不据旧快照提前退出。失败保留并标注旧数据；授权失效暂停模型调用，需重新授权。
- 退出调用 `/api/v1/auth/client/revoke`，**只撤销当前客户端会话**，随后删除本机密文；不全局退出网站，也不撤销模型 Key。删除失败明确报错并暂停模型调用，需重试。充值按钮打开官方 `https://sakuraapi.top/purchase`，不嵌入被官网禁止的 iframe、不代理支付。DPAPI 不隔离同用户恶意进程或已授权项目插件。

官网授权页若显示 `Client authorization must be confirmed on this site`，表示**官网确认接口拒绝了请求**，不是模型 Key 或本机 PKCE 换码失败。先确认地址为 `https://sakuraapi.top/client-authorize.html` 且从软件重新发起；不要直接访问 API 地址、删除凭据或关闭浏览器安全设置。若点击官网「同意并连接账号」仍报错，需要官网检查同源确认校验是否与页面的 `no-referrer` 策略冲突。排查与最小修复建议见 `D:\VSProject\SakuraCode\docs\sakuraapi-authorization-troubleshooting.md`；客户端不会伪造来源、代理官网登录令牌或自动同意授权。

Windows PowerShell 若拦截 `npm.ps1`，可用 `npm.cmd run web`。修改页面后刷新浏览器；若使用独立 exe，需先运行 `npm.cmd run client` 重新内嵌页面。

界面回归使用现有 Vitest + Chrome/Edge 的原生 CDP，不新增浏览器自动化依赖：`npm.cmd test -- D:\VSProject\SakuraCode\tests\web-client.test.ts D:\VSProject\SakuraCode\tests\web-remote-client.test.ts D:\VSProject\SakuraCode\tests\web-panel-resize.test.ts`。没有 Chrome/Edge 或原生 WebSocket 的环境会跳过真实浏览器用例，静态契约测试仍运行。可设置 `SAKURA_UI_SCREENSHOTS` 为输出目录，保存桌面、手机、日间主题、协作面板及两栏调宽截图。

### 失败自动重试

「设置 → 通用与外观 → 失败自动重试」设置首次失败后的固定时间窗口、自动次数和间隔，默认 **60 秒内最多自动重试 3 次、间隔 2 秒**（初始请求不算重试）。网络断开、超时、HTTP 408／429／5xx 等临时模型错误可重试；授权、参数、额度问题、主动停止和工具执行失败不自动重试。上游 `Retry-After` 可延长等待，但不能越过时间窗口继续自动请求。

到达次数或时间后暂停，显示「确认再试一次／停止重试」卡片；每次确认只允许一个额外请求，再失败仍需确认，不受 `yolo` 模式影响。浏览器刷新／重连可恢复待确认卡片；关闭、停止任务或确认超时会安全结束等待。只重试当前模型请求，**不重复投递用户消息、不重放此前已执行的命令／写文件／委派，也不重试登录或支付**。失败流残片与新回答分离，已报告的失败用量保留统计；重试可能重复产生模型费用。

桌面版通过独立 `desktop/retry` 私有管道确认保存到 `settings.json` 的 `Retry`，跨工作区和随机端口保留，失败不改变策略或已有凭据；普通 Web 保存到当前服务运行状态，重启默认值在 `plugins.core-retry.config` 中配置。运行中的单次请求保持其开始时策略，保存的新值适用于后续请求。无交互的 CLI／后台记忆整理在用尽次数后停止，不自动批准。REPL 可手动确认。参见配置模板 `core-retry`。

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
/compact [focus] 手动压缩当前会话上下文    /memory   AGENTS.md 与工作区记忆状态
/hooks     已配置的 shell 钩子      /permissions  权限规则 + 本会话放行清单
```

REPL 也接受管道喂入（`echo "任务" | sakura`）：stdin 到达 EOF 时若仍有 turn 在跑，会等本轮跑完再干净退出，不会把任务丢掉。

自定义斜杠命令：把 markdown 文件放进 `.sakura/commands/<名字>.md`（项目）或 `~/.sakura/commands/`（用户），正文即提示词模板，支持 `$ARGUMENTS` 与 `$1..$9` 占位符；REPL 与 Web GUI（输入 `/` 唤起菜单）均可调用。

## Skills / Hooks / 上下文压缩 / 项目记忆 / 工作区记忆 / ask_user / web_search

这些核心能力全部以插件形式提供：

- **Skills**（`core-skills`）：`.sakura/skills/<名字>/SKILL.md`（YAML frontmatter：name/description/whenToUse + 正文指令）自动注入系统提示词，模型用 `skill` 工具按需加载完整指令。项目 > 用户 > extraDirs 优先级，`/skills` 查看。
- **Hooks**（`core-hooks`）：`plugins.core-hooks.config.hooks` 配置 `pre-tool-call | post-tool-call | turn-end | session-start` 四类事件的外部命令（glob matcher）；pre 钩子非零退出即否决该工具调用。命令经 stdin 收到 JSON payload，环境变量 `SAKURA_*` 同步。
- **上下文压缩**（`core-compaction`）：会话事件超过阈值（默认 120，`auto: 0` 只关闭事件触发）或估算上下文达到 token 阈值（默认 48,000，`autoTokens: 0` 只关闭 token 触发）自动用模型摘要压缩旧上下文；两项都为 0 才关闭自动压缩。`/compact [focus]` 手动触发。压缩标记进会话日志，`deriveMessages` 投影自动截断。
- **压缩用别的模型**：摘要请求默认跟随当前选中的模型；`plugins.core-compaction.config.compactModel`(已注册模型名或适配器 id)让所有压缩固定走指定模型。写在 `~/.sakura/config.yml` 即为全局统一；写在项目 `sakura.yml` 里则该项目单独覆盖(逐键合并,项目优先)。Web GUI 输入框上方的「压缩 · 跟随当前」下拉也可即时调整(经 `POST /api/settings {compactModel}`,只影响之后的压缩,运行中也能改)。GUI 运行时选择不落盘;要持久化请用配置文件。
- **按工作区配置**：桌面模式下每个工作区可单独指定「会话目录」(默认 `<工作区>/.sakura/sessions`;填绝对路径或相对工作区的路径,修改后该工作区重新挂载);「自动开启的智能体」勾选 `.sakura/agents/*.md` 里定义的类型,挂载该工作区时自动创建这些协作成员,取消勾选在下次切换/重挂后生效。全局的「新工作区默认目录」决定「新建工作区」按钮在哪里创建子目录(留空时需填写完整路径);服务端会递归创建目录,不存在的目标仍然会被拒绝切换。这些偏好随桌面设置持久化(每工作区一条),不写入项目目录。
- **项目记忆**（`core-project-memory`）：从工作目录向上发现 AGENTS.md（每层一个），最多 3 层注入系统提示词，`/memory` 查看。
- **工作区长期记忆**（`core-workspace-memory` + `core-memory-processing` + `tool-workspace-memory`）：与 AGENTS.md 项目规则分开，保存在各工作区的 `.sakura/workspace-memory.md`。**新工作区默认开启**，已有 JSON 记忆的显式关闭设置保留；读取旧 `.sakura/workspace-memory.json`，首次修改写入 Markdown，旧 JSON 留作备份、不覆盖。设置 → 工作区与记忆先列出全部已知工作区的状态，点击「管理记忆」才读取正文，可编辑开关、长期内容与整理阈值、导出 Markdown 或确认清空当前记忆及待整理记录。关闭不删除内容；清空不删除会话／项目文件／旧 JSON 备份。长期正文最多 16,000 字，版本检查、跨进程写锁和原子替换防止丢失更新，损坏／链接文件停止使用、不自动覆盖。
- **自动长期记忆整理**：完成的主会话文本积累到同一 Markdown 的待整理部分，不直接注入为事实；不采集系统提示、思考、附件或工具原始输出，常见凭据和已知模型密钥先过滤（不是可靠的敏感信息检测，仍不要输入秘密）。默认积累 **8,000 字或等待 30 分钟**，当前打开的工作区空闲时使用当前模型整理长期经验；两项可单独设为 0，或关闭自动整理。每次最多处理 64,000 字，剩余积累保留，待整理上限 128,000 字。失败保留原内容并暂停自动整理，需明确点击「立即整理」再试；会消耗模型额度。未打开的项目不启动后台模型／插件，其他工作区仍可管理或明确 `@` 引用；立即整理需先切到该工作区。
- **Skill 导入**：设置 → **Skill** → 导入 Skill，选择 `SKILL.md` 或包含它的文件夹，保存到当前项目 `.sakura/skills` 或用户 `~/.sakura/skills`。一次一个 Skill、最多 128 个 UTF-8 文本文件／4 MiB，`SKILL.md` 最大 256 KiB；不支持 ZIP 或二进制资源。路径穿越、联接、冲突、无效元数据会被拒绝；同名技能不隐式覆盖。导入不会执行脚本或安装依赖，成功后立即刷新已加载列表。手动放入的新 Skill 可点击「刷新列表」，无须重启；项目同名 Skill 优先。
- **分类 `@` 引用**：在输入框键入 `@`，可搜索选择当前工作区会话、Skill、现有智能体／智能体类型，以及本机已知工作区的长期记忆。方向键切换、Enter／Tab 选择、Esc 关闭；`@路径[:行范围]` 文件引用继续可用。标记形如 `@[skill:名称]`、`@[session:ID]`、`@[agent:ID]`、`@[agent-type:名称]`、`@[memory:编码后的工作区路径]`。Skill 正文在本次请求显式加载，智能体目标指示主智能体用正常审批的 `send_message`／`subagent` 委派；不是一提及就绕过审批直接执行。跨工作区记忆只有显式选择才加入，不自动混合项目；关闭／未知／损坏记忆拒绝引用。每消息最多 12 个资源引用、80,000 字预算；会话引用最多最近 24,000 字并标明截断。导入和记忆管理接口只允许本机操作员，远端操作员／访客不能读取跨工作区记忆。
- **ask_user**（`core-interaction` + `tool-ask-user`）：模型通过 `ask_user` 工具向用户提问（2-4 个选项或自由文本）；REPL 走终端问答，Web GUI 渲染成对话流里的选项卡片。
- **web_search**（`tool-web-search`）：DuckDuckGo HTML 端点搜索，返回标题/URL/摘要列表，`endpoint` 可换自建代理。

## Browser Use / MCP HTTP / @ 提及 / 图片粘贴（v0.3）

### 编辑消息与回滚对话／代码

当前会话任务结束后，每条已保存的用户消息下方有 **「编辑并重新发送」** 和 **「回滚到此处」**。确认窗口会先显示影响的消息和代码文件，默认不会直接删除记录：

- **编辑**：修改这条用户消息，从它之前建立新会话分支，然后重新生成回答；原会话及之后的回答完整保留。原消息附件复制到新会话，未发送的输入框草稿不会混入本次编辑。保存和生成分开提交，生成失败不会自动重发；尚未开始生成的编辑分支提供「为已编辑消息重新生成」入口。
- **只回滚对话**：新分支不包含所选消息及其后的对话，保留当前项目文件；可以继续发送新任务。原会话仍在侧栏，可切回查看或导出，但切回原会话本身不会自动恢复代码。
- **回滚对话和代码**：同时撤销所选回合及其后有快照的项目文件修改；**只回滚代码** 则保留当前对话，单独恢复文件。新建文件恢复为不存在，已有文件恢复修改前字节。
- **冲突保护**：仅跟踪本功能启用后，由原生 `write`／`edit` 工具对当前工作区普通文件的修改。每次修改前持久保存 SHA-256 校验的前后镜像；文件后来被手动修改、删除、替换为链接或被其他任务改写时，拒绝强制覆盖。预览后对话／文件发生变化，须重新预览并确认。
- **范围限制**：旧会话没有历史快照时只能回滚对话；不回滚工作区外文件、`.git`／`.sakura`／会话内部数据、符号链接／联接／硬链接或超过 8 MiB 的文件。不承诺撤销 shell／MCP／插件的任意副作用、Git 提交、独立协作者会话或长期记忆。快照为本机敏感项目数据，位于会话的 `checkpoints.jsonl` 与 `checkpoints/`，不要上传含秘密的会话目录；删除会话也会删除其快照。
- **权限和运行保护**：只读访客与只读历史没有写入口；先恢复历史为主会话才能操作。智能体／排队消息运行、审批／问题／计划／重试待确认、压缩、记忆整理或工作区变更中均禁止回滚。持续运行的后台预览／开发服务不阻止预览、只回滚对话或编辑重发，这些操作不停止后台任务、不恢复项目文件；后台任务运行时禁止回滚代码，确认窗口会明确说明，停止后须刷新并重新确认。建立新分支重置协作花名册和会话审批放行，不自动把旧专家结果带进新对话。
- **并发和中断边界**：原生子任务及后续 `send_message` 委派按发起的用户回合归属快照，直接给独立协作者发任务不会混入主对话回滚。哈希检查和应用内写队列保护常规并发，但多文件恢复不是操作系统级事务；断电、进程强杀或外部程序同时写文件时应先检查项目与快照，不保证全量原子撤销。普通 I/O 失败会尝试恢复已处理文件并明确报错。

接口：`POST /api/sessions/:id/history/preview`（`turnSeq`）；`POST .../history/edit` 或 `.../history/rewind`（`turnSeq`、`contextRevision`、预览 `fingerprint`、`confirmed: true`、`mode: conversation|code|both`，编辑还须 `text`）；`POST /api/conversation/generate`（当前编辑分支 `sessionId`）。操作复用操作员权限与工作区标识，过期预览或冲突返回 409。原会话日志仍为 append-only，不使用破坏性的 Git reset。

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
- **会话导出**（`core-session-export`）：markdown 转写（思考/工具折叠块、图片占位、压缩提示）与过滤 JSON；GUI 会话项的「…」或右键菜单选择「导出 Markdown」、REPL `/export [文件]`、`GET /api/sessions/:id/export`。

## 行级 diff / 上下文计量 / REPL 增强（v0.6）

- **edit 卡片 unified diff**（`src/util/diff.ts`）：LCS 行级差异渲染成 `@@ -a,b +c,d @@` hunk 加红删绿增行；完全相同不渲染，超 2000 行回退整块对比。
- **token 估算**（`src/util/tokens.ts`、`src/util/context.ts`）：CJK 每字 1 token、ASCII 词片 chars/4、图片部件固定 800；查看器与自动压缩还计入实际注册的工具定义。启发式估算，不用于计费；真实用量仍使用上游返回值。
- **按体量自动压缩**：`autoTokens`（默认 48000）在事件计数（`auto`，默认 120）之外独立触发压缩——长回合不再靠事件数漏检。
- **REPL 增强**：流式暗色显示思考内容（main 专属，与正文严格分行）；`/hooks` 列出已配置钩子、`/permissions` 列出权限规则与会话级放行。

## 输入区的上下文窗口查看器

点击输入区工具栏中、思考等级右侧的「上下文 · ≈…」展开查看器；正常窗口下浮层位于整个输入卡片上方，不遮挡草稿：

- **分类／顺序**：彩色条和图例显示系统规则、工具定义、用户消息、助手消息、工具调用与工具结果的估算 tokens／占比。「思考」另列已记录体量并标明**不计入**——目前不回传给模型。统计基于当前主会话的有效上下文，不累计已被压缩或清空的旧历史；顺序模式最多 256 段，较早的合并会明确提示。刷新不调用模型、不消耗模型额度。
- **阈值设置**：默认本地预算 64,000 tokens，现有 48,000 token 阈值对应 75%。这是可调整的**本地规划预算，不是上游声明的模型窗口**；没有可靠元数据时不猜测或写死模型上限。百分比和事件数各自独立触发，可分别设为 0。桌面设置按工作区保存并在重启／切回工作区后恢复；普通 Web 设置在服务运行期间有效，配置文件可用 `contextWindowTokens`／`thresholdPercent`／`auto` 持久化，`thresholdPercent` 显式配置时优先于 `autoTokens`。
- **立即压缩**：使用「压缩模型」生成摘要，保留完整历史；需要已配置或授权的模型，可能消耗模型额度。任务、工具配对或其他压缩未完成时禁止竞争操作，错误后可明确重试，不自动重复提交。
- **清空上下文**：确认后只重置当前主会话后续发送给模型的对话及旧摘要；系统规则与工具定义仍在，**历史记录、项目文件、工作区记忆和其他会话不删除**。标记在日志持久化，重启后不会恢复旧上下文。取消默认获得焦点；只读访客、运行中的任务和过期的会话／上下文版本不能执行。
- 可用键盘打开，左右方向键切换分类／顺序，Escape 关闭并返回入口；窄窗口和明暗主题均可使用。只读查看历史时查看器明确标注显示的是实时主会话，并禁止修改。

接口：`state.contextBreakdown` 仅返回计数、类别与有界的顺序段，不返回原始系统提示词／工具内容；`POST /api/context/settings` 更新阈值，`POST /api/context/compact` 和 `POST /api/context/clear` 要求当前 `sessionId`、`contextRevision`，清空还须 `confirmed: true`。全部写操作复用工作区标识及操作员权限校验。

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

### 上游站点、格式与会话命名（v0.7.2）

下面的多上游、手填连接与默认 OpenAI 说明是 CLI / 普通 Web 的通用能力和版本记录。**当前 Windows 桌面产品使用上面的 SakuraAPI 官网授权与固定上游策略**，不提供手填连接或自定义提供方；工作区与会话功能共用。

- **多上游站点与格式**：设置页的「上游站点」按已注册提供方列出（`state.providers`，仅含 id / 默认模型 / 是否默认 / 格式，不含密钥），可保存多个站点配置并切换；每站点独立选择**请求格式**——`chat-completions`（`POST {baseURL}/chat/completions`）或 `responses`（`POST {baseURL}/responses`，OpenAI Responses API）。`responses` 格式把消息映射为 `input` 项（assistant 的历史 `tool_calls` 展开为 `function_call` 项、tool 回合展开为 `function_call_output` 项，无正文内容的 assistant 回合不占项），工具声明使用扁平 schema（`{type:'function', name, description, parameters}`），并解析 `response.output_text.delta` / `response.function_call_arguments.delta` / `response.completed` 等事件——文本、思考摘要、工具调用、用量与 done 原因都与 chat-completions 对齐。不含推理事件的兼容服务在 `completed` 时回落解析 `output_text`。
- **拉取模型列表**：设置页「拉取模型」调用 `POST /api/models/upstream`（仅桌面/操控端可用且与当前工作区一致），GET `{baseURL}/models` 并解析 `{data:[{id}]}`，去重排序后填入模型输入框的候选列表（最多 512 条，15 秒超时）。仅允许 https（loopback http 除外）地址，避免把密钥发到明文端点；该接口只读取列表，不改配置。
- **会话命名**：新建会话时立即要求输入名称（可留空走默认），会话项右侧 ✎ 可随时重命名（`PATCH /api/sessions/:id {title}`，单行 ≤60 字符，自动截断）；标题持久化为 `session/note` 事件，回放与导出都能读到，不再是启动时的时间戳 id。
- **默认模型与端点**：`DEFAULT_MODEL` 为 `gpt-4o-mini`，默认 base URL 指向 `https://api.openai.com/v1`，只回退 `SAKURA_*` 环境变量，文档与示例配置只写 OpenAI 官方示例（配置文件与插件 schema 里仍可自由填写任意兼容服务）。密钥建议用 `SAKURA_API_KEY`。
- **主页与侧栏布局**：欢迎页在常见窗口高度下不再垂直滚动（内容区上边距与间距收紧、低高度下压缩欢迎区）；「新建会话」按钮移到「最近会话」标题与搜索框之间，搜索框下方只保留会话列表本身。
- **检查更新**：设置页「版本与更新」卡的「检查更新」调用 `POST /api/updates/check`，从 GitHub Releases（`api.github.com/repos/Guyao146/SakuraCode/releases/latest`，可用 `updatesBaseUrl` 选项覆盖）读取最新 tag 并与当前版本做 semver 比较（忽略预发布后缀）。服务启动 5 秒后自动检查一次、之后每 6 小时复检；发现新版本时**每个版本只通知一次**——SSE 推送一条 `notice`（聊天气泡）和一个 `update` 帧（驱动设置按钮上的红点徽标，随 `state.update` 持久化到状态快照，刷新页面后仍在）。检查失败只缓存 `error` 字段并显示「检查失败」，不影响任何其他功能；接口对所有已登录角色开放（只读访客也能看到版本提示），`updatesAutoCheck: false` 可完全关闭后台轮询。

## 专家协同模式与插件市场（v0.7.2 增补）

- **专家协同模式**：对话顶栏显示「专家 · 关闭」开关（0.7.6 起）。点开后生成内置三人专家组，**保留草稿和待发送附件，不自动发送任务**；点击发送时，每条用户消息与附件同时发给主智能体和全部专家（`专家 · 协同中`），各自从专业角度并行处理，成员间可用 `list_agents` / `send_message` 协调，由主智能体汇总。附件各自保存在成员会话目录，删除一个成员会话不会移除其他成员的副本。再次点击关闭分发，但专家保留在花名册里，可继续单独对话或删除。
  - 内置专家组定义在 `src/experts.ts`：架构师（只读分析、方案分解与接口约定）、实现者（小步实施并跑测试）、审查者（变更质量与回归风险审查），均用 `core` 工具策略（读写执行全开、不可再嵌套生成子智能体）。`POST /api/experts/start {task?, experts?}` 可选部分成员，未知 key 返回 400；`POST /api/experts/stop` 幂等。
  - 生命周期：专家属于当前会话——切换会话或重挂工作区会 dispose 整个花名册并关闭分发，避免旧成员漂到新会话；`state.expertMode` 随状态快照下发，刷新页面后开关状态保留。
- **插件与联网市场**：设置 → 插件，分为「本地插件」和「插件市场」。本地列表只展示真实挂载的插件（内置／外部）与非 MCP 工具，搜索即时过滤；Skill 与 MCP 分别在独立设置页。市场只有明确点击「联网搜索」或提交搜索后才访问固定 HTTPS npm 公开注册表，搜索发布者标记为 `sakuracode-plugin` 的包，支持分页、空结果、失败提示和明确重试。查询仅发送关键词，不附账号、Key、工作区或聊天内容；本机操作员专用，远端／访客不能借主机网络搜索。服务端限制 10 秒、1 MiB、3 个并发查询，同关键词结果短时缓存；详情链接固定为 npm 包页，元数据仅作为文本显示，不信任发布者任意链接。公开结果**不是官方兼容性审核**，当前可能没有包；不会虚构结果、下载、安装或执行。桌面引擎不自带 npm，安装前需审查源码，再按 `pluginsDir`／`bundles` 手动挂载。
- **专家协同的收尾动作**：团队成员卡中专家带「专家」徽标；开启专家模式后自动展开协作面板；任意专家产出结果后，团队标题栏出现「汇总专家结论」按钮，一点即让主智能体综合各专家结论给出统一答复与下一步建议（走正常消息通道）。按钮显隐跟随状态帧实时更新，只读访客不可用。
- **CLI 对齐**：两个新能力在 REPL 里同样可用。`/experts` 查看状态，`/experts on [开场任务]` 生成专家组（生成逻辑与 Web GUI 共用 `spawnExperts`，`/experts off` 关闭分发但保留成员），之后每条输入同时发给主智能体与全部专家；`/new`、`/resume` 切换会话时随花名册一并结束。交互式 REPL 启动 2 秒后在后台检查更新，发现新版本只打印一行提示（不阻塞首个提示符、失败静默）；`/update` 手动检查。one-shot（`-p`）与 `--web` 不触发专家模式与启动检查。

## 专家协同与更新检查的可靠性修复（v0.7.2 修订）

- **专家复用**：`spawnExperts(agents, keys?, takenNames?)` 按 `meta.expert` 预设 key 识别已有专家——`/experts off` 再 `/experts on`（或 GUI 关闭再开启）时**复用原成员及其会话历史**，不会重复生成同名专家；名字被其他智能体占用而无法生成时整组启动失败并返回 409，不留半残团队。开场任务只投递一次：复用场景下不重发。
- **汇总真实结论**：「汇总专家结论」只收集状态为 `done` 且结果非空的成员（`buildExpertSummary`），出错 / 取消 / 仍在运行的成员只列状态、**绝不带出过期结果**；每成员上限 12_000 字符、总计 40_000 字符。汇总作为一条普通消息发给主智能体，不再 echo 回专家（`POST /api/experts/summarize`，无可用结论时返回 409）。
- **会话切换隔离**：服务器维护单调递增的 `sessionEpoch`，切换 / 删除会话时自增并关闭专家分发；进行中的旧请求在写回结果前会先校验 epoch，若会话已变则返回 409 让前端按当前会话重试，避免把旧会话的回复落到新会话上（影响 `/api/message`、`/api/experts/*`、`/api/settings`、`/api/sessions/:id` 等写接口）。
- **更新检查的健壮性**：`UpdateChecker`（src/updates.ts）单飞行合并并发的手动与自动检查；每个版本只通知一次（`checkAndDetectChange` 在 await 之后认领版本 key，防止并发双发）；请求强制 `credentials: 'omit'` + `redirect: 'error'`、响应体上限 1 MiB；只接受稳定版 feed（draft / prerelease 一律视为错误）；release URL 固定为 `github.com/Guyao146/SakuraCode/releases/tag/<tag>`（保留前导 v），不信任 feed 里的 `html_url`。临时失败保留上一次已知的版本字段并附加 `error`，恢复后同一版本不会重复通知。`close()` 幂等并中止进行中的检查，服务器关闭后不再有任何轮询。

## Token 计量与缓存命中率（v0.7.2 增补）

- **解析上游真实用量**：OpenAI 兼容适配器现在读取用量帧里的缓存与推理明细——OpenAI 风格的 `prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens`、DeepSeek 风格的顶层 `prompt_cache_hits` / `reasoning_tokens`，以及 Responses API 的 `input_tokens_details` / `output_tokens_details`。不报告这些字段的服务商不受影响（字段保持 undefined，不计零）。
- **回合级聚合**：`ui/turn/end` 的 `usage` 是**整回合所有步的累加**（此前只保留最后一步，多步工具回合的用量被丢弃）；每步的用量仍随 `assistant/message.stream.usage` 落盘，会话重放后可复算。
- **会话与每轮收尾**：会话前置真实状态；专家模式提示原位替换。主回答下方显示本轮 tokens 与墙钟总耗时（接口报告／本地估算明确区分），失败／取消／重试也计入；专家与有归属的成员通信全部结束后原位更新整轮总计，刷新与分支可还原。专家共享一次 canonical 用户任务及带来源的已提交步骤，不串入后续排队用户消息；长期记忆仅采集用户调整方向，不采集成员发言／生成汇总。桌面浏览器返回／resize 用实际原生可见客户区证据约束页面，原地 reflow 与减少动态效果兼容。边界与安全限制见 `D:\VSProject\SakuraCode\docs\desktop-conversation-refinements.md`。
- **会话级统计**：`state.tokenStats`（`{requests, inputTokens, outputTokens, cachedTokens, reasoningTokens}`）从会话日志派生，刷新页面/重连后不丢失；GUI 输入框上方的「本轮 N tokens」在有缓存命中时显示占比（如「本轮 1.5k tokens（缓存 62%）」），把鼠标悬停在「上下文 ≈」上可看累计输入/输出/缓存命中率与推理 token；REPL 新增 `/usage` 打印同样的汇总（含上下文估算）。
- **缓存友性的请求结构**：提高缓存命中率是结构问题，SakuraCode 已经按前缀稳定原则构造请求——系统提示始终是 `messages[0]` 且只在内容变化时追加；历史严格按日志顺序追加、从不重写旧消息；工具声明按插件挂载顺序稳定导出；旧截图只保留最近一组（更早的降级为文本），大输出工具统一 30k 字符截断。会话级实测：**不要中途手工编辑历史、保持系统提示稳定、别在长会话里频繁切换模型**（换模型不改变历史前缀，但工具/温度等请求字段变化仍可能让服务商视为不同请求）。多数上游（OpenAI、DeepSeek、Moonshot、GLM 等）对 ≥1k token 的重复前缀自动启用缓存，无需任何请求参数。

## 统一页面尺寸与安全删除会话

- **一致的内容范围**：聊天、运行看板和设置共用最大 880px 内容宽度、响应式内边距和稳定滚动条预留空间；切换页面不改变侧栏／协作面板的已保存偏好，小屏仍沿用原有抽屉交互。
- **永久删除需确认**：操作员可点击会话项的垃圾桶，确认后删除该会话目录（含日志及会话附件）。不可撤销；不会删除或回滚项目文件。取消按钮默认获得焦点，只读访客没有删除权限。
- **保护执行上下文**：运行或排队中的任务、协作成员绑定、上下文压缩、待处理审批／问题／计划会阻止删除；界面给出原因，服务端返回 `409`。删除期间拒绝竞争写操作，等待已有日志写入完成，并封闭旧会话句柄以防意外重建。
- **当前与历史分开处理**：删除空闲的当前会话会回到空白对话，保留模型选择与未发送草稿；删除其他历史只移除对应条目，不打断当前任务。`DELETE /api/sessions/:id` 返回结果并通过 `session/deleted` SSE 同步到其他客户端，断线重连也会核对列表。
- **隔离过期请求**：工作区标识、状态版本和历史加载版本共同阻止旧响应恢复已删除记录。GUI 写请求携带 `X-Sakura-Workspace`；无效 ID 返回 `400`、不存在的会话返回 `404`，不同工作区的同名 ID 按存储根目录隔离。自动分配的 Web／桌面端口避开浏览器禁用端口，不关闭浏览器安全限制。


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
