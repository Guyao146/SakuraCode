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
writeFileSync(metadata, JSON.stringify({ version, engineSha256: engineHash }))
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
  '首次启动打开「文档」目录；点击左侧「设置」选择可信项目目录、模型 API 地址、模型名与 API Key 后保存。\r\n' +
  '点击左上项目卡选择最近工作区，或在设置中填写新目录后保存；会话历史按工作区保留在 .sakura/sessions。任一智能体运行时拒绝切换，不会隐式停止任务。\r\n' +
  '「新建工作区」在设置里的「新工作区默认目录」下创建子目录；每个工作区还能单独指定会话目录、勾选自动开启的智能体（.sakura/agents/*.md 定义的类型），设置随桌面程序保存、按工作区记录。\r\n' +
  '设置中的 API Key 留空表示保持当前密钥；勾选清除才会移除本次运行的密钥。取消保存不影响本次运行。保存密钥为可选项，使用 Windows 当前用户 DPAPI 加密。\r\n' +
  '运行中可以排队发送新消息；独立停止按钮只停止当前回合，不删除已排队任务。「变更」可点击定位成功的 write/edit 结果，并不是 Git 全量差异。\r\n' +
  '协作成员的「独立会话」只读查看，不切换主会话。主界面另含审批、运行看板与设置；任务栏樱花图标可重新打开主窗口。\r\n' +
  '关闭主窗口会停止后台和正在执行的任务。模型和思考等级需等所有智能体空闲后再修改；审批模式仍可运行中调整。\r\n\r\n' +
  '要求 Windows 10/11 x64、系统 .NET Framework 4.8 以及已安装的 Chrome 或 Edge；无需 Node/npm。\r\n' +
  '这是复用系统浏览器的独立应用窗口，不是 Electron 安装包。界面/引擎均内置，不依赖开发目录或 CDN。\r\n' +
  '桌面模式固定为本机回环地址和随机端口，忽略远程 Web 监听配置，不修改防火墙。远端部署继续使用 CLI --web。\r\n' +
  '本机配置/浏览器数据/启动日志位于 %LOCALAPPDATA%\\SakuraCode\\Desktop；会话按项目保存在 .sakura\\sessions（自定义目录除外）。\r\n' +
  'API Key 只发给你配置的模型服务，不放入命令行、浏览器 URL 或明文设置文件。项目插件/工具能访问本机，仅打开可信项目。\r\n' +
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