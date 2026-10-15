# dsh-purge-plugin 0.2.3

提供一份全局 AGENTS.md 的网页编辑器，并按用户提供的 dsh_purge.py（署名：小杨）应用 8 项 DSH 源码补丁。设置入口为 **左下角设置 → 全局 AGENTS**，进入后直接编辑和保存；历史备份默认折叠。插件详情页只有 DSH 自带的插件管理功能。

## 0.2.3 修复（包含 0.2.2）

- 第 4 项同时校验并修改主配置和 Standard、PTC、Cordis 三种预设，保留各自的工作目录后缀。旧版仅修改主配置的安装会显示 **7/8**，不会误报完整覆盖。
- 兼容预设的单行及折叠 YAML、LF/CRLF；重复应用不会重复追加。
- 兼容 macOS `/var` 与 `/private/var`、符号链接路径；通过路径别名启动的应用也必须先退出。
- Mac 查询分别报告代码签名和 `ElectronAsarIntegrity` 校验结果，任一校验失败返回非零退出码。
- ASAR 回归测试统一使用同步路径规范化，避免 Windows 的 `RUNNER~1` 短路径与长路径表示差异导致误判；不改变运行时代码。

仅支持 DSH **0.2.0-rc.2**。磁盘补丁状态不等于当前会话已重新加载，也不代表模型服务端会改变响应策略。

## 全局文件

唯一编辑目标是运行 DSH 的主机上的 $DSH_HOME/AGENTS.md；未设置 DSH_HOME 时使用当前用户的 ~/.dsh/AGENTS.md。页面显示解析后的路径，首次保存会创建文件。所有工作区通过 DSH 原生全局指令加载器读取这份文件，保存后建议新建会话使用。

文件保存前检查 SHA-256 版本，拒绝覆盖外部修改并保留页面草稿。每次变更前自动备份原内容，使用同目录临时文件替换；保留 UTF-8/BOM/换行及已有 POSIX 权限。文件上限固定为 1 MiB，与 DSH 原生读取上限一致；模型实际加载总预算仍遵循 DSH 的配置。历史恢复也会备份被替换的内容。文件备份在 $DSH_HOME/plugins/dsh-purge/backups，沿用旧版目录和记录。

0.1.x 的多文件选择、额外提示词、模板按钮和权限控件已移除。旧配置值被忽略，不会自动搬进或覆盖 AGENTS.md；已有原生权限设置保留。

## 8 项补丁

| 编号 | 名称 | 实现 |
| --- | --- | --- |
| 1 | WORKSPACE_CONTEXT_INTRO | 替换普通工作区指令前言 |
| 2 | REPLACEMENT_WORKSPACE_CONTEXT_INTRO | 替换完整基线更新时的前言 |
| 3 | SCOPE_INTRO | 替换新增/更新作用域的前言 |
| 4 | SYSTEM_PROMPT_PERSONA | 修改主配置 personaPrefix 和三个预设的 prefix，保留所有 suffix |
| 5 | APPROVAL_NEVER_SENTENCE | 替换 user-approval 的主入口、invariant 入口及 types 构建中的审批文案 |
| 6 | SANDBOX_DENY_FILE_WRITE | 将 macOS Seatbelt 的 deny file-write* 规则替换为 allow file-write* |
| 7 | SANDBOX_MODE_DEFAULT | 将未指定 DSH_PERMISSION_MODE 时的沙箱默认值设为 danger-full-access |
| 8 | APPROVAL_POLICY_DEFAULT | 将相同环境变量缺省时的审批策略设为 never |

第 6 项规则只在 macOS 的相应沙箱路径使用；Linux/Windows 上也校验并替换同一发布文件，但不声称运行了 macOS 沙箱。显式环境变量、profile 或会话权限选择仍遵循 DSH 自身优先级，默认值补丁不追溯修改已有会话。

补丁改变模型提示词及本机沙箱/审批默认行为；模型服务本身的响应仍由服务决定。此版本没有额外的 prompt-inject.md 来源，也不改写 dsh.cmd/dsh.ps1。

## 安装与应用

要求 Node.js ^22.19.0 或 >=24。补丁严格校验 DSH 包版本为 0.2.0-rc.2；其他版本或原文不匹配时整批停止，在页面明确报错。

使用已构建的包：
dsh plugin --profile web add "/absolute/path/dsh-purge-plugin-0.2.3.tgz"

桌面 profile 使用 `--profile desktop`。发布安装包见 [GitHub Releases](https://github.com/Tiancaizhi9098/dsh-purge-plugin/releases)。

Windows 也使用上述命令，将路径替换为 Windows 绝对路径。普通目录安装继续自动应用；macOS 桌面版的 app.asar 使用下述离线兼容命令。无需 Python。

插件启动时自动尝试校验并应用 8 项补丁。先校验全部目标文件，再保存完整备份和摘要，然后逐文件原子替换；失败时尽力回滚本批已写入文件。重复启动不重复追加。页面仅显示一行状态，首次应用后明确提示重启 DSH。源码模块可能已缓存，必须重启才能完整生效。

安装目录不可写时，编辑器仍可使用，并显示补丁错误。使用对该安装目录有写权限的账号执行以下命令，然后重启 DSH：
node "/absolute/path/to/dsh-purge-plugin/scripts/patches.mjs" apply

可通过 DSH_BASE 指向当前安装的 @deepseek-ai 目录、DSH_HOME 指向当前数据目录。没有显式指定时，优先从运行 DSH 的入口逐级定位，随后从插件目录定位，不递归扫描用户目录。

查询：
node "/absolute/path/to/dsh-purge-plugin/scripts/patches.mjs" status

源码补丁备份保存在 $DSH_HOME/plugins/dsh-purge/runtime-backups，命令输出备份文件名。不要把它与 AGENTS.md 内容备份混淆。

## 回滚

停用或卸载插件不会自动还原已写入的 DSH 安装文件。需要还原时先停用插件，再使用有写权限的账号执行：
node "/absolute/path/to/dsh-purge-plugin/scripts/patches.mjs" revert "/absolute/path/to/runtime-backup.json"

最后重启 DSH。回滚先校验所有文件当前摘要；若安装文件已有其他修改，则拒绝覆盖。备份保留以便人工检查。

## 开发与验证

npm ci --ignore-scripts
npm run check
npm run build
npm test
npm pack --ignore-scripts

测试使用已发布 rc.2 文件的临时副本，不修改开发依赖中的 DSH 原件。覆盖 8 项补丁、三个预设、旧版覆盖缺口、三处审批构建、persona YAML、JS 语法、幂等、CRLF、整批预检、回滚及外部修改保护；同时覆盖指令文件的字节保持、并发写入、历史恢复、符号链接限制及原生 Cordis RPC 生命周期。macOS 原生事务测试用 `cc` 构建隔离测试应用，再用系统 `codesign` 验证；非 macOS 跳过这三项原生测试。

跨平台 CI 矩阵为 Ubuntu/macOS/Windows × Node 22/24。实际执行情况见 VALIDATION.md；配置了 CI 不代表已在全部平台运行。
## macOS 桌面版 app.asar

0.2.1 增加归档事务：一次预检全部 8 项补丁，保留其他归档条目和 unpacked 资源，更新目标文件的 SHA-256/分块摘要，并原子替换归档。完整原归档单独备份，回滚可恢复原始字节。未匹配的版本、损坏的目标摘要、混合 unpacked 补丁目标会停止写入。

Mac `.app` 包同时带有 Info.plist 的 ElectronAsarIntegrity 和代码签名。首次处理必须完全退出 DSH（含后台进程），解压插件包到用户目录后，以本机 Node 执行：

```sh
node "/完整路径/dsh-purge-plugin/scripts/macos.mjs" apply --app "/Applications/DeepSeek Harness.app"
```

该命令保存原 app.asar、Info.plist、主可执行文件和 CodeResources；更新归档头哈希，使用系统 codesign 给本机修改后的外层应用做临时签名，并执行 `codesign --verify --deep --strict`。内部 helper/framework 保留原签名。失败时尝试恢复本次原始文件。进程仍在运行时会拒绝操作。应用目录必须对当前用户可写。

这是本机修改后的临时签名，不等同于厂商签名或公证。命令不关闭 Gatekeeper、不更改系统安全设置，也不更改 Electron fuse。若应用因系统管理策略或厂商强制身份校验无法接受本机签名，应使用普通目录的 CLI/Web 安装方式。

完成后正常打开 DSH；安装/启用插件后，**设置 → 全局 AGENTS** 显示 8/8 状态。若先安装插件，页面会提示上述退出后运行的命令，AGENTS 编辑器仍可使用。以后正常启动只检查已应用的补丁，不重复重签。DSH 更新若替换 app.asar，需要对新版本重新验证；当前只支持 rc.2。

从 0.2.1 升级也要在完全退出后运行新版 `macos.mjs apply`，补齐旧版遗漏的预设；只更新插件包和重启并不能修复签名归档。`status` 只读检查，不会应用补丁。成功输出中 `signatureVerified` 和 `asarIntegrityVerified` 均应为 `true`，并且所有 8 项的 `applied` 均为 `true`。

查询及回滚：

```sh
node "/完整路径/dsh-purge-plugin/scripts/macos.mjs" status --app "/Applications/DeepSeek Harness.app"
# 先停用插件并退出 DSH；使用 apply 输出的 .macos.json 路径
node "/完整路径/dsh-purge-plugin/scripts/macos.mjs" revert --app "/Applications/DeepSeek Harness.app" --manifest "/完整路径/备份.macos.json"
```

Mac 应用包须使用 macos.mjs 回滚，才能一起恢复原签名和校验信息。回滚拒绝覆盖有其他修改的应用文件。普通目录仍使用 patches.mjs。
