# 0.2.2 验证记录

验证日期：2026-10-16。补丁严格适配 DSH 0.2.0-rc.2。

本地环境：macOS 15.8.1、arm64、Node.js 24.21.0。

- TypeScript 检查、Host/Client 构建通过。
- 完整测试共 25 项，全部通过，无跳过。
- 第 4 项覆盖主配置和 Standard、PTC、Cordis 三个预设，解析 YAML 后保留 suffix；LF/CRLF、重复应用及逐字节回滚通过。
- 旧版仅修改主配置的模拟安装显示 7/8；补齐预设不重复修改主配置。Mac 插件 RPC 在需要离线处理时同样报告 7/8，而不是 0/8 或 8/8。
- 未知预设、末项原文失配及外部修改拒绝写入；ASAR 独立读取和目标摘要校验通过。
- `/var`、`/private/var` 及符号链接归档路径使用同一规范化路径进行应用、查询、回滚。
- 三项 macOS 原生测试在临时目录构建隔离 `.app`：离线应用及本机签名校验、重复应用、只读查询、完整回滚通过；恢复 app.asar、Info.plist、可执行文件和 CodeResources 的原始字节。
- 代码签名有效但 ElectronAsarIntegrity 错误的测试应用被查询和 apply 正确拒绝；通过符号链接启动的测试应用在运行时拒绝修改。
- AGENTS 编辑器的字节保持、并发冲突、历史恢复、边界限制和原生 Cordis RPC 生命周期通过。

测试不修改 `/Applications` 的正式应用或实际 AGENTS.md，不发送模型请求。尚未在此版本的正式 DSH 桌面上执行升级和 UI 启动验证。

Ubuntu/macOS/Windows × Node 22/24 的 GitHub Actions 矩阵已配置；本地测试通过不代表其他平台已经运行。GitHub 上的实际结果以 Actions 为准。
