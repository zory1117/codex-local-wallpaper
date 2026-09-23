# Codex Local Wallpaper

一个只在本机运行的 Codex 背景注入器。它读取 JPG、JPEG 或 PNG，通过 Codex 已开放的本机 Chrome DevTools Protocol（CDP）端口注入 CSS，让背景图显示在应用壳层后面。

项目不修改 Codex 的安装文件、`app.asar` 或配置，不联网，不安装托盘程序，不创建计划任务，也不启动常驻监控。

## 快速开始

需要 Windows、Node.js 20 或更高版本，以及已安装的官方 Codex。

1. 把自己的背景图复制为 `assets/background.png`（也可以使用 JPG）。`assets` 下的个人图片默认被 `.gitignore` 排除，不会被提交。
2. 关闭已经运行的 Codex，双击 `start-codex-wallpaper.vbs`，或为它创建桌面快捷方式。
3. 脚本会启动官方 Codex 并注入背景。已有 Codex 进程时会拒绝启动，避免重复打开窗口。

如果 Codex 已经以调试端口启动，可以只连接现有窗口：

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\launch-wallpaper.ps1
```

也可以指定图片、端口和透明度：

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\launch-wallpaper.ps1 `
  -ImagePath .\assets\background.png -Port 9335 -Opacity 0.27
```

## 工作方式

- `-LaunchIfNeeded` 只在检测不到 `ChatGPT.exe` 时启动官方 Codex。
- 所有 CDP 通信都限制在 `127.0.0.1`，注入内容使用内存中的 `data:` URL。
- 注入器只选择 `app://-/index.html` 主页面，不会把样式注入宠物窗口、弹出窗口或网页内容。
- 页面初始化过早时，注入会等待文档节点出现，避免命令返回成功但背景实际丢失。
- 启动失败、端口不可用或已有 Codex 运行时只报错，不会强制结束进程，也不会自动重试启动。

某些 Codex 版本可能关闭远程调试端口；这种情况下需要使用支持该启动参数的版本。

## 开发

```powershell
npm test
```

测试覆盖图片格式、透明壳层、主页面选择、启动保护，以及页面初始化时序。

## License

MIT

