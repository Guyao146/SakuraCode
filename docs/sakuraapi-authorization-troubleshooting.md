# 官网客户端授权确认错误

症状：在 `https://sakuraapi.top/client-authorize.html` 登录后，点击「同意并连接账号」显示：

```text
Client authorization must be confirmed on this site
```

## 已核对的边界

- SakuraCode 打开官网真实授权页；不嵌入、代理或者用 Node 代替网站提交同意。
- 客户端参数为授权码 + S256 PKCE、随机 state、127.0.0.1 随机端口回传和精确官网 postMessage。PKCE verifier 留在本机。
- 公开官网脚本先复查 `/api/v1/auth/me`，再在用户点击时 POST `/api/v1/auth/client/authorize`；请求带 `expected_user_id`，不创建 Key。
- 这条英文提示并不存在于 SakuraCode 源码。官网脚本会将 API 的 `message` 原样显示在授权页。
- 在隔离 Chromium 中加载抓取的公开官网页面／脚本，**所有账号 API 均被拦截为合成响应**。观测到确认请求的 `Origin` 是 `https://sakuraapi.top`，`Referer` 缺失；页面的 `<meta name="referrer" content="no-referrer">` 导致这一行为。
- 本次没有读取用户网站登录令牌、提交真实同意、换取真实授权码或改动官网部署。因此不能仅凭该观测断言后端使用了哪条校验，也不能声称真实账号授权已修复。

## 官网侧应检查

1. 在出错确认请求中检查状态码和响应 `code`，不要复制或发布 Authorization、Cookie、一次性 code、state 或完整带参数 URL。
2. 找到产生该英文错误的同源确认校验，核对反向代理传递的 Origin／Referer、实际网站允许来源、路径和 Fetch Metadata 策略。
3. 如果后端要求授权页的 Referer，当前公开页面 `no-referrer` 与之不兼容。可在**官网源码**中仅对确认请求设置同源 referrer 策略，而不是关闭后端保护：

```js
const result = await api('/auth/client/authorize', {
  method: 'POST',
  referrer: location.origin + location.pathname,
  referrerPolicy: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_id: request.client_id,
    client_name: request.client_name,
    redirect_uri: request.redirect_uri,
    state: request.state,
    code_challenge: request.code_challenge,
    code_challenge_method: request.code_challenge_method,
    expected_user_id: currentUser.id,
  }),
});
```

这里的 `referrer` 使用不带查询参数的真实授权页地址，`same-origin` 不向跨站地址泄露来源；应同时保留接口同源限制、登录认证、明确用户同意、expected_user_id、state、redirect URI 与 PKCE 验证。不要手写浏览器不允许设置的 `Referer` 请求头、使用通配来源或把官网登录令牌交给本机应用。

如果错误来自不同的 Origin／代理校验，应修正对应配置并保留 fail-closed 行为；不要未经确认就改用上述方案。

## 用户端临时处理

取消本次连接，从 SakuraCode 重新发起并核对官网域名。若仍在官网确认按钮处报错，停止重复授权并等待官网修复；无需清空本机设置、删除模型 Key 或禁用浏览器安全功能。没有有效授权码时，SakuraCode 不会换码或自动创建 Key。

本次观察证据位于 `D:\VSProject\SakuraCode\tmp\startup-performance\official-consent-headers-r1.json`。建议方案也已在隔离 Chromium 的合成官网页面中验证：`D:\VSProject\SakuraCode\tmp\startup-performance\official-consent-proposed-site-fix-r1.json` 显示确认请求会带不含查询参数的授权页 Referer，其他确认字段不变；这不等于已经修复或部署了官网。该目录保存的是公开文件和合成测试结果，不含真实账号凭据。