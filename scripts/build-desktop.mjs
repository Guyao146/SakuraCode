/** Windows GUI package: native launcher + the existing embedded Node SEA engine. No NuGet/npm additions. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = new Set(process.argv.slice(2))
if ([...args].some(arg => !['--install', '--skip-client'].includes(arg))) throw new Error('Usage: npm run desktop -- [--install] [--skip-client]')
if (process.platform !== 'win32') throw new Error('Desktop packaging requires Windows (the CLI/Web builds remain cross-platform).')
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24 to build the embedded desktop engine.')
process.chdir(root)
if (!args.has('--skip-client')) execFileSync(process.execPath, [path.join(root, 'scripts', 'build-client.mjs')], { stdio: 'inherit' })

const buildDir = path.join(root, 'build')
const sourceDir = path.join(root, 'scripts', 'desktop')
const engine = path.join(buildDir, 'SakuraCode.exe')
const destination = path.join(buildDir, 'SakuraCode Desktop.exe')
const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!existsSync(csc)) throw new Error('The Windows .NET Framework C# compiler is missing: ' + csc)
if (!existsSync(engine)) throw new Error('Build the standalone engine first: npm run client')
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const engineHash = createHash('sha256').update(readFileSync(engine)).digest('hex')
const metadata = path.join(buildDir, 'desktop-build.json')
writeFileSync(metadata, JSON.stringify({ version, engineSha256: engineHash,
  webSha256: createHash('sha256').update(readFileSync(path.join(root, 'src', 'web', 'index.html'))).digest('hex'),
  launcherSha256: createHash('sha256').update(readFileSync(path.join(sourceDir, 'Launcher.cs'))).digest('hex'),
  vipAssets: Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
    const name = `vip-${index + 1}.png`
    return [name, createHash('sha256').update(readFileSync(path.join(root, 'src', 'web', 'assets', 'vip', name))).digest('hex')]
  })),
}))
const assemblyInfo = path.join(buildDir, 'DesktopAssemblyInfo.cs')
writeFileSync(assemblyInfo, `using System.Reflection;\n[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]\n[assembly: AssemblyTitle("SakuraCode Desktop")]\n[assembly: AssemblyProduct("SakuraCode Desktop")]\n[assembly: AssemblyVersion("${version}.0")]\n[assembly: AssemblyFileVersion("${version}.0")]\n`)
const icon = path.join(buildDir, 'SakuraCode.ico')
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(sourceDir, 'icon.ps1'), '-OutputPath', icon], { stdio: 'inherit' })
execFileSync(csc, [
  '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', '/unsafe',
  '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Security.dll',
  `/win32manifest:${path.join(sourceDir, 'app.manifest')}`, `/win32icon:${icon}`,
  `/resource:${engine},SakuraCode.Engine.exe`, `/resource:${metadata},desktop-build.json`,
  `/out:${destination}`, assemblyInfo, path.join(sourceDir, 'Launcher.cs'),
], { stdio: 'inherit' })

const help = `SakuraCode Desktop ${version} — Windows x64 桌面版\r\n\r\n` +
  '双击 SakuraCode Desktop.exe：直接启动上次的工作区（或 --workspace 指定的目录），设置已合并进主界面。\r\n' +
  '首次启动打开「文档」目录；点击左下角账号右侧的齿轮，在「工作区与记忆」选择项目目录。「模型设置」只从官网同步的模型列表选择，不手填地址或 API Key。\r\n' +
  '启动性能：专用浏览器禁用不需要的内置扩展后台页与后台预加载，保留 Chromium 多进程安全沙箱；不修改系统浏览器设置。会话列表流式生成摘要、缓存未改变日志，并发状态刷新合并；协作面板展开后才扫描其他工作区。不删除会话、附件或记忆，不关闭项目 MCP／插件；浏览器、GPU 和已配置服务仍占用实际资源。\r\n' +
  '设置页按左侧分类与右侧卡片组织，主题在「通用与外观」，插件市场、扩展与 MCP 已移入设置。选择框支持键盘方向键、Home/End、Enter 与 Escape。\r\n' +
  '原主页底部的访问方式、版本、服务连接、工具数与 token 状态移至「设置 → 关于与更新 → 工作区状态」；左下角账号入口保留，上下文入口位于输入区工具栏。\r\n' +
  '左下角「登录 SakuraAPI」→「授权登录」打开本机一次性接收页，点击「前往官网授权」进入 https://sakuraapi.top/client-authorize.html。官网确认账号后通过一次性授权码与 S256 PKCE 连接，不自动创建或选择 Key。随后前往「模型设置」选择已有 Key，或选定模型分组并明确确认创建新 Key；已有 Key 分页、同步、官网 Key 管理、当前调用 Key 信息和相关错误也集中在该页。默认 Windows DPAPI 加密记住客户端账号凭据与所选 Key，可在账号页取消；不读取密码或浏览器登录令牌。\r\n' +
  '本机接收端明确确认已收到有效授权结果后，尝试关闭本次官网授权弹窗与本机接收页，不关闭无关标签或整个浏览器。浏览器禁止普通标签自动关闭时，可按页面提示手动关闭。等待、拒绝、官网错误或回传失败不自动关闭；失败可明确重试同一结果。结果回传不代表换码或安全保存成功，后续失败请在软件中处理。\r\n' +
  '若官网确认页显示 Client authorization must be confirmed on this site，这是官网确认接口拒绝请求，不是模型 Key 出错。核对 https://sakuraapi.top/client-authorize.html 并从软件重新发起；仍失败须由官网核对同源确认校验与页面 no-referrer 策略，客户端不会伪造来源或代替用户同意。无需删除已存设置／Key 或关闭浏览器安全功能。\r\n' +
  '桌面上游固定 https://api.sakuraapi.top/v1，旧桌面地址／Key、项目模型配置和模型环境变量不会切换上游。账号栏与摘要只显示用户名、邮箱和连接状态；VIP 徽章仅在「账号与余额 → VIP 会员资料」显示，余额、订阅余量与累计用量在各自资料卡中。VIP1–VIP10 图片全部内置，不依赖桌面原图；未知等级、非会员和缺失资料显示安全文字。只有选定的模型 Key 用于推理，账号令牌只访问获准官网账号接口；未提供的数据不估算，充值打开官网，不代理支付。\r\n' +
  '订阅卡分别显示日／周／月剩余额度及进度，不合并周期。只对已提供正上限与余量的周期绘制剩余比例；零余量显示 0%，图形限制在 0–100% 而不修改官网数值。零上限显示不限额，缺失周期／上限／余量显示未提供，不绘制虚假比例；官网提供重置时间时一并显示。\r\n' +
  '客户端会话连续 120 小时（5 天）未使用失效，最长一小时的 access token 在会话内透明轮换。不定时心跳或查询保活，后台 refresh 不延长闲置期限；只在真实前台交互时查询／报告活跃。令牌串行轮换并原子安全保存，保存失败需明确重试，不能重复提交旧刷新令牌或一次性授权码。创建 Key 的重试复用同一 UUID 与请求体，不自动重复创建。\r\n' +
  '「通用与外观 → SakuraAPI 额度显示」可选常驻显示（默认）、悬停弹出或仅在设置。悬停／聚焦输入区时向上弹出，不挤动布局；触屏点击「额度」，按 ↑ 进入浮层按钮，Esc／收起／点击外部关闭。账号与余额中的额度和操作始终保留。\r\n' +
  '额度显示偏好单独保存到桌面 settings.json，成功确认后生效；重启后、更换随机端口或工作区仍保留。保存失败回显错误且维持原方式，不改变授权、旧密钥或上下文设置。普通 Web 的显示偏好仅保存在当前浏览器。\r\n' +
  '输入区思考等级右侧「上下文 · ≈…」打开上下文窗口查看器：在输入卡片上方展开，不遮挡草稿，可查看分类／顺序彩色占比、刷新、阈值设置、立即压缩和清空上下文。统计含工具定义，思考只保留历史不计入；均为估算，不用于计费。\r\n' +
  '上下文默认本地预算 64K、按 token 压缩阈值 75%（48K），不是上游模型窗口上限。阈值按工作区保存；token 百分比与事件数独立触发，两项都为 0 才关闭自动压缩。压缩会使用选定的压缩模型，可能消耗额度。\r\n' +
  '「清空上下文」须确认，只让后续模型请求不再携带旧对话／摘要；完整历史、项目文件、其他会话与工作区记忆均保留，重启后也不恢复旧上下文。系统规则与工具定义继续发送；正在运行的任务／审批／压缩会阻止操作。\r\n' +
  '窗口不带额外标题栏；右上角最小化收起到托盘，任务继续运行，双击樱花托盘图标或重复启动恢复原窗口/草稿/最大化状态。最大化/还原、关闭保留；拖动顶部空白区域移动，双击顶部最大化，边缘可调整大小。\r\n' +
  '对话侧栏的右边缘、工作台的左边缘支持拖动调宽，宽度与收起偏好保存在当前浏览器；中间对话区自动适配，窗口变窄时自动限宽而不覆盖原宽度偏好。双击分隔线或聚焦后 Enter 恢复该栏默认宽度；左右方向键微调，Shift 加速，Home/End 调到最窄/最宽，拖拽时 Esc 取消。手机保留抽屉不显示分隔线；「通用与外观 → 恢复默认布局」重置两栏宽度。\r\n' +
  '点击左上项目卡选择最近工作区，或在设置中填写新目录后保存；会话历史按工作区保留在 .sakura/sessions。任一智能体运行时拒绝切换，不会隐式停止任务。\r\n' +
  '「新建工作区」在设置里的「新工作区默认目录」下创建子目录；每个工作区还能单独指定会话目录、勾选自动开启的智能体（.sakura/agents/*.md 定义的类型），设置随桌面程序保存、按工作区记录。\r\n' +
  '「通用与外观 → 失败自动重试」可设置首次失败后的时间窗口、次数与间隔，默认 60 秒内自动重试最多 3 次、间隔 2 秒。达到次数或时间后暂停，必须确认才再请求一次。只重试临时模型请求错误，不重放已执行工具、不自动重发消息，不重试主动停止、授权或额度错误。桌面策略跨工作区/重启保存，失败回滚。\r\n' +
  '「设置 → Skill」单独显示已加载 Skill、来源和正文，可刷新列表或选择 SKILL.md/Skill 文件夹导入到项目或用户库；一次一个、最多 128 个 UTF-8 文本文件/4 MiB，不支持 ZIP/二进制，不执行脚本，同名不覆盖。输入 @ 可选择 Skill、会话、智能体或记忆。\r\n' +
  '「设置 → MCP」单独显示连接状态、错误、重连及 MCP 工具；「设置 → 插件」合并本地插件和插件市场，互不混合列表。市场点击联网搜索后读取 npm 中标记为 sakuracode-plugin 的公开包，仅发送关键词，不发送账号/Key/项目或聊天。无结果会明确提示，不自动下载安装执行；兼容性由用户审查，桌面引擎不自带 npm，按 pluginsDir/bundles 手动挂载。\r\n' +
  '设置内容区右上角不再有关闭叉号，使用左侧「返回工作区」，窗口最右上角关闭按钮仍保留。数字/文本/多行输入框统一全宽圆角与主题样式。断线、模型未配置、整理记忆/上下文时可以先编辑草稿，发送按钮与提示说明限制；中文输入法确认不发送，返回工作区恢复聊天输入焦点。\r\n' +
  '「设置 → 工作区与记忆」管理所有已知工作区记忆，列表默认不读取正文，点击管理才展开。新工作区默认开启，保留旧关闭设置；保存为 .sakura/workspace-memory.md，旧 JSON 不覆盖。默认积累 8000 字或等待 30 分钟、当前工作区空闲时调用模型整理长期记忆，可能消耗额度，阈值可调；失败保留内容并暂停，需点击立即整理。可导出 Markdown、清空或跨工作区 @ 记忆，不要存放密钥、密码或敏感信息。\r\n' +
  '退出单独撤销当前客户端会话并删除本机加密授权，不全局退出官网，也不撤销模型 Key，需要时到官网 Key 管理页删除。退出／保存失败明确报错并暂停相关请求。旧 Key 授权继续兼容，但真实账号资料需使用新版授权；更老的网页账号令牌需重新授权。CLI／普通 Web 自定义模型配置不受影响。\r\n' +
  '运行中可以排队发送新消息；独立停止按钮只停止当前回合，不删除已排队任务。「变更」可点击定位成功的 write/edit 结果，并不是 Git 全量差异。\r\n' +
  '任务结束后，用户消息可「编辑并重新发送」或「回滚到此处」。先预览范围再确认，可只回滚对话、只恢复代码或同时回滚；从所选消息之前建立新分支，原会话保留。编辑保留原附件，不使用输入框中的未发送草稿；生成失败不自动重发。代码仅恢复新版本 write/edit 保存的普通项目文件快照，手动改动或缺失/损坏快照拒绝覆盖，不撤销 shell/MCP 任意副作用、Git 提交、独立会话或长期记忆。切回原会话不会自动恢复代码。\r\n' +
  '后台预览/开发服务持续运行时仍可预览、只回滚对话或编辑重发，不会自动停止后台任务，也不恢复项目文件。此时回滚代码选项会禁用；先停止后台任务，再刷新预览并重新确认代码恢复。\r\n' +
  '对话可拖入、选择或粘贴任意类型文件；最多 12 个、单个 8 MiB、合计 16 MiB。发送前显示文件名/大小，可移除，点击发送才上传。UTF-8 文本正文限单个 32000 字/合计 64000 字，超出部分明确标记截断，原文件完整保存在会话附件目录。PNG/JPEG/GIF/WebP 作为视觉附件，其他二进制只保留文件信息/原始字节，不自动解析、执行、解压或安装。\r\n' +
  '专家模式开关位于对话顶栏，显示关闭或协同中；开启不自动发送草稿。点击发送后，主智能体与每位专家各自收到文件副本。切换会话/工作区会移除未发送附件，删除会话一并删除其附件，不删除原始文件。附件内容随请求发送给所选模型，请勿上传秘密文件。\r\n' +
  '1.0.0 可靠性修复：日志成功写入后才进入模型上下文；删除当前会话同时清理待发送附件并保留文字草稿。迟到响应不会清空新会话草稿或覆盖专家状态；专家模式切换确认期间可以编辑草稿，暂不发送。文件读取中止可移除重选；旧版图片接口严格校验并分别保存成员副本。\r\n' +
  '协作成员的「独立会话」只读查看，不切换主会话。协作概览显示当前工作区实时任务、其他最近工作区的持久历史（明确标注历史），不会自动运行未打开项目。\r\n' +
  '默认用 Windows DPAPI 加密记住授权和所选 Key，下次启动恢复有效登录。账号页可直接开启/取消记住登录，取消仅移除密文、保留本次连接；保存失败保留原状态。账号撤销或连续 5 天闲置失效仍需重新授权。\r\n' +
  '专家的架构师/实现者/审查者共享主会话的已提交上下文：同一用户任务只出现一次，完整模型/工具步骤带成员来源提交共享，慢专家不读取后续排队用户任务。成员原始归档/附件仍独立，工作台「专家内部记录」不新增普通会话、不删除旧日志。专家输出默认整卡折叠，长任务/回答超过 600 字符或 10 行收为一行并显示最新输出摘要；点击或 Enter 展开全文，不把折叠当作上下文压缩。\r\n' +
  '专家模式长期记忆仅自动收集原始用户明确的调整方向，排除成员/主助手发言、工具结果、生成汇总和引用展开。内置 memory_write 与直接记忆文件 write/edit 被限制，设置中仍可手动管理；shell/第三方插件不是任意文件写入隔离沙箱。已有记忆/旧候选保留，不批量改写。专家开启/关闭/失败原位更新同一条可关闭提示，不堆进对话。\r\n' +
  '会话列表前置未开始/未完成/已完成/失败/已中断状态；当前运行与等待由实时成员和审批等请求确认，历史不伪称运行中。回答末尾显示本轮 token 和总耗时，接口报告与估算分开标明；有专家时待全部本轮/归属委派结束原位更新整轮总计，并行墙钟耗时不相加，含工具/审批/重试等待。历史与分支保留统计，旧日志耗时标记约数；不是计费账单。\r\n' +
  '浏览器呼出/返回、窗口尺寸/DPI变化按原生实际可见客户区布局，页面接收仅数值的可见宽高证据，漂移原地修复并短暂重新布局动画，不刷新/重挂 Chromium、不丢草稿、附件或选区。系统减少动态效果时不动画。\r\n' +
  '任务进度固定在工作台顶部、协作/变更标签之前，切换标签仍可见，长列表独立滚动；实际进度来自 todo_write，不推测完成百分比。\r\n' +
  '最近会话的「多选」可选择/全选搜索结果中可删除会话，最多每批 100 个。永久删除须确认，不删除或回滚项目文件；运行/绑定中的会话受保护，部分失败明确回显，不自动重试。\r\n' +
  '「新建」位于「多选」左侧，最近会话数量紧邻标题。页面/弹窗/下拉菜单采用轻量入场动画，系统选择减少动态效果时停用；不延迟输入与焦点。\r\n' +
  '新 Key 可选模型分组排除 subscription 类型，桌面一行三个；倍率四舍五入显示两位小数，实际计费以官网为准，账号订阅余量仍保留。\r\n' +
  '「关于与更新」可保存自建 HTTPS latest.json 更新源、关闭自动检查或恢复 GitHub 默认源。默认启动约 5 秒后及每 6 小时检查；失败保留上次结果，不发送账号/Key/项目/聊天。下载地址与自建源必须同源，重定向被拒绝。\r\n' +
  '更新只提示并交给系统浏览器手动下载，不静默安装、不执行下载文件。先退出旧版并备份 EXE，下载后使用 Get-FileHash -Algorithm SHA256 核对界面哈希，再仅替换 EXE/说明；不要删除用户数据或 .sakura。SHA-256 不代替可信发布者签名。服务器发布与只读部署脚本及说明位于源仓库 docs/desktop-updates.md。\r\n' +
  '关闭主窗口会停止后台和正在执行的任务。模型和思考等级需等所有智能体空闲后再修改；审批模式仍可运行中调整。\r\n\r\n' +
  '要求 Windows 10/11 x64、系统 .NET Framework 4.8 以及已安装的 Chrome 或 Edge；无需 Node/npm。\r\n' +
  '这是无标题栏原生窗口承载系统浏览器内容，不是 Electron 安装包。界面/引擎均内置，不依赖开发目录或 CDN。\r\n' +
  '桌面模式固定为本机回环地址和随机端口，忽略远程 Web 监听配置，不修改防火墙。远端部署继续使用 CLI --web。\r\n' +
  '本机配置/浏览器数据/启动日志位于 %LOCALAPPDATA%\\SakuraCode\\Desktop；会话按项目保存在 .sakura\\sessions（自定义目录除外）。\r\n' +
  '账号 access/refresh token 与模型 Key 分开使用，不放入命令行、浏览器 URL、工作台页面、日志或明文设置文件。项目插件/工具能访问本机，DPAPI 不是同用户隔离沙箱，仅打开可信项目。\r\n' +
  '当前为未签名本机构建；Windows 可能提示未知发布者。旧版 SakuraCode.exe 和已有配置不会被修改。\r\n\r\n' +
  '诊断：--data-dir <绝对路径> 使用独立用户数据；--workspace <绝对路径> 预选项目（否则沿用上次工作区）。\r\n' +
  '开发验证：SAKURA_DESKTOP_DEBUG=1 才会为专用应用窗口开启本机 CDP 调试，正常使用不要启用。\r\n'
const helpPath = path.join(buildDir, 'SakuraCode Desktop-使用说明.txt')
writeFileSync(helpPath, '\ufeff' + help, 'utf8')
writeFileSync(path.join(buildDir, 'SakuraCode Desktop.sha256'), createHash('sha256').update(readFileSync(destination)).digest('hex') + '  SakuraCode Desktop.exe\n')
console.log('\nDesktop package: ' + destination)

if (args.has('--install')) {
  const desktop = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' }).replace(/^\ufeff/, '').trim()
  if (!path.isAbsolute(desktop) || !existsSync(desktop)) throw new Error('Cannot find the current user desktop.')
  const target = path.join(desktop, path.basename(destination))
  copyFileSync(destination, target + '.new')
  renameSync(target + '.new', target)
  copyFileSync(helpPath, path.join(desktop, path.basename(helpPath)))
  const dataDir = path.join(process.env.LOCALAPPDATA, 'SakuraCode', 'Desktop')
  mkdirSync(dataDir, { recursive: true })
  const settings = path.join(dataDir, 'settings.json')
  if (!existsSync(settings)) writeFileSync(settings, JSON.stringify({ Workspace: root, AutoStart: false }, null, 2))
  console.log('Installed on desktop: ' + target)
}