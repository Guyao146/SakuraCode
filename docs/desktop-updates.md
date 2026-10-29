# 桌面更新服务器（0.7.5 起）

设置 → **关于与更新** 可手动检查新版本、修改更新源、关闭自动检查，并查看更新说明／下载地址／SHA-256。默认源仍为本项目 GitHub Releases。桌面偏好由启动器保存，跨随机端口、工作区与重启保留；保存失败不改变原设置。

这是**检查、提示和手动下载**方案，不会静默下载执行或自动替换 EXE。更新请求只携带 SakuraCode 版本 User-Agent；不携带账号令牌、API Key、工作区、聊天或 Cookie。说明按纯文本显示。客户端只接受稳定版以及同源的说明／下载地址，网络重定向被拒绝。请只配置自己信任的 HTTPS 服务器。

## 1. 发布文件

在 Windows 构建、验证新版本后运行（以下路径对应本仓库；其他机器改成自己的绝对路径）：

```powershell
npm.cmd run desktop
node 'D:\VSProject\SakuraCode\scripts\publish-desktop-update.mjs' `
  --output 'D:\VSProject\SakuraCode\tmp\published-desktop-updates' `
  --base-url 'https://updates.example.com/sakuracode/'
```

`updates.example.com` 是示例域名，必须替换为你的域名。脚本从实际产物计算 SHA-256、大小和当前版本，复制 EXE／说明文件，生成下载页和 `latest.json`。可用 `--notes-file <绝对路径>` 提供至多 16000 字符的 UTF-8 纯文本发行说明。测试其他产物时可明确传 `--exe`、`--guide`、`--version`；发布前由维护者确认版本与测试结果正确。

目录结构：

```text
latest.json
0.7.5/
  index.html
  SakuraCode Desktop.exe
  SakuraCode Desktop.sha256
  SakuraCode Desktop-使用说明.txt
```

每个版本目录不可覆盖，重复发布同版本会报错。新版本先完整写入独立暂存目录并校验复制哈希，再原子更新 `latest.json`。上传时先传完整版本目录，再传 `latest.json`；不要先让客户端看到未上传完的下载地址。版本文件保留以便回退。发布目录应放在 `build` 之外，因为重新构建会清理 `build`。

## 2. 部署

**最简单：**把生成的目录放到 Nginx／Caddy 的静态站点路径，对外开启 HTTPS。无需运行 SakuraCode、无需账号数据库、无需 npm 安装依赖。`latest.json` 设置 `Cache-Control: no-store`；版本目录可长期缓存；确保下载地址直达文件而不是跳转到对象存储的其他域名。

也提供无依赖 Node 20+ 的只读程序，可部署到 Linux／Windows 服务器：

```bash
node /srv/sakuracode-tools/serve-desktop-updates.mjs \
  --directory /srv/sakuracode-updates --host 127.0.0.1 --port 8787
```

将 `D:\VSProject\SakuraCode\scripts\serve-desktop-updates.mjs` 复制到上述服务器工具路径，上传发布目录到 `/srv/sakuracode-updates`。用 systemd／已有进程管理器保持程序运行。此服务只允许读取更新清单、固定名称的版本文件；没有上传、管理、任意文件访问、安装或命令执行接口。

在已有 HTTPS Nginx 站点内配置：

```nginx
location /sakuracode/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_set_header Host $host;
}
```

`proxy_pass` 尾部 `/` 会移除 `/sakuracode/` 前缀，刚好对应 Node 服务的发布目录。TLS 证书沿用你的 HTTPS 站点配置。容器场景可显式用 `--host 0.0.0.0`，但不要把纯 HTTP 端口直接暴露到公网。HTTP 更新源仅允许回环地址用于本地测试。

## 3. 客户端接入

在 **关于与更新 → 更新源地址** 填入：

```text
https://updates.example.com/sakuracode/latest.json
```

点击“保存更新设置”，再点击“检查更新”。默认启动约 5 秒后检查一次，之后每 6 小时检查；同一新版本每个服务进程只提示一次。失败保留上次结果，不影响聊天，也不自动重试安装。点击“恢复官方更新源”会清空自建地址，保留自动检查选项。

普通 CLI/Web 服务可以用 `SAKURA_UPDATES_URL` 设置默认源；普通 Web 页面修改仅在该服务进程生效。`SAKURA_UPDATES_AUTO_CHECK=0` 可强制关闭后台轮询，仍保留手动检查。远端／只读访客能检查更新，但不能修改本机更新源。

## 清单协议

```json
{
  "schemaVersion": 1,
  "project": "SakuraCode",
  "platform": "windows-x64",
  "version": "0.7.5",
  "releaseUrl": "https://updates.example.com/sakuracode/0.7.5/",
  "notes": "UTF-8纯文本说明",
  "publishedAt": "2026-10-27T05:00:00.000Z"
}
```

上述为只提供发行说明页的有效清单示例，示例域名需替换。提供直接下载时，由发布脚本额外生成 `downloadUrl`（EXE 地址）、`sha256`（实际 64 位十六进制哈希）、`size`（实际整数字节数），不要手填示例哈希。响应最多 1 MiB；EXE 声明大小最多 512 MiB。三个下载字段必须一起提供，也可全部省略只显示下载说明页。版本必须是有效稳定 SemVer。地址无用户信息、查询参数或片段，并与清单同源；不接受任意第三方下载链接。

## 手动更新与信任边界

1. 下载后退出旧程序，备份旧 `SakuraCode Desktop.exe`。
2. 用 PowerShell `Get-FileHash -Algorithm SHA256 -LiteralPath '<下载EXE的绝对路径>'`，与界面／发布页上的 SHA-256 比对；确认 Windows 发布者签名（若维护者已签名）。
3. 只替换 EXE 与使用说明；不要删除 `%LOCALAPPDATA%\SakuraCode\Desktop`、`.sakura` 或自定义会话目录，不要复制别人的用户数据。
4. 启动并确认版本；有问题退出后恢复备份 EXE，已有数据保留。

SHA-256 能验证下载内容与清单一致，**不能代替可信发布者签名**；服务器若被攻破，攻击者也能替换清单和哈希。当前本机构建未签名，Windows 可能提示未知发布者。内置下载按钮交给系统浏览器，客户端不会替你自动验证下载文件或执行程序。自动安装／签名清单验证不在此版本范围内。