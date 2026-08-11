# Pi Studio

[English](README.md) · [简体中文](README.zh-CN.md)

Pi Studio 是一个独立的 Electron 桌面客户端，用于运行 [Pi coding agent](https://github.com/earendil-works/pi)。它将 Pi 项目、任务线程、模型配置、扩展、权限控制、自动化任务和文件预览整合到同一个桌面工作区中。

> Pi Studio 是独立的社区项目，与 Pi 维护者没有隶属或官方背书关系。

## 界面预览

当前界面将主工作区、插件管理、公开 Skills Hub 和 Android 远程控制配置整合在同一个桌面客户端中。

<table>
  <tr>
    <td width="50%"><img src="imageassets/newpi01.png" alt="Pi Studio 主页" width="100%"></td>
    <td width="50%"><img src="imageassets/newpi03.png" alt="Pi Studio 插件管理" width="100%"></td>
  </tr>
  <tr>
    <td align="center">主页</td>
    <td align="center">插件管理</td>
  </tr>
  <tr>
    <td width="50%"><img src="imageassets/newpi04.png" alt="Pi Studio Skills Hub" width="100%"></td>
    <td width="50%"><img src="imageassets/newpi02.png" alt="Pi Studio Android 远程控制配置" width="100%"></td>
  </tr>
  <tr>
    <td align="center">Skills Hub</td>
    <td align="center">Android 远程控制配置</td>
  </tr>
</table>

## 新增功能

- **插件管理** —— 支持搜索、安装、更新、启用、停用和删除来自 npm、GitHub 或本地路径的 Pi extension 包；同一面板也会列出 Pi 共享目录和当前项目中发现的 skill。
- **Skills Hub** —— 浏览和搜索公开的 [skills.sh](https://skills.sh/) 目录，查看 skill 详情与安装命令，并直接安装到 Pi。
- **Android 手机远程控制** —— 通过短时有效的二维码与桌面端配对，配置 Signal WSS 地址，查看连接状态并管理可信设备。远程传输使用带 STUN 发现的直连 WebRTC，并有意拒绝 TURN/relay 候选。
- **中英文界面** —— 桌面端支持在 English 和简体中文之间切换。

## 功能

- 在桌面侧边栏管理本地项目和 Pi 任务线程。
- 使用流式响应聊天，并配置模型与思考级别。
- 阅读和预览 Markdown、HTML、源代码、图片及常见办公文档。
- 通过 Pi 共享的 `models.json` 配置 provider 和模型。
- 使用 Pi 共享 agent 目录中的扩展和插件。
- 通过内置 Skills Hub 浏览和安装公开 skill。
- 连接 Android companion，远程查看任务线程并执行经过批准的控制操作。
- 运行定时自动化任务，并明确选择 Sandbox 或完全权限。
- 在每个安装包中嵌入版本化的 Pi/Node 运行时，并支持由应用管理运行时更新。
- 使用权限门控制 shell 命令、项目边界和扩展操作。

## 下载

从 GitHub Releases 下载最新的 `Pi-Studio-Setup-<version>.exe`（Windows x64）或 `Pi-Studio-<version>-arm64.dmg`（Apple Silicon macOS）。当前安装包尚未签名，Windows SmartScreen 或 macOS Gatekeeper 可能会显示安全提示。

每个安装包都包含原生的固定版本 Node.js + Pi 运行时。首次启动时，Pi Studio 会校验并将内置运行时解压到用户数据目录；之后的应用更新会复用已解压的运行时，不需要再次下载运行时。

## 开发环境要求

- 支持的安装包目标平台是 Windows x64 和 macOS arm64。
- 开发和打包需要 Node.js `24.14.0` 或更高版本，但必须处于 Node 24 主版本内。
- npm。
- 打包脚本需要全局安装 Pi coding agent：

```powershell
npm install -g @earendil-works/pi-coding-agent@0.84.1
```

## 开发

```powershell
npm install
npm run typecheck
npm run test:permission
npm run dev
```

常用命令：

```powershell
npm run build             # 构建 Electron 应用
npm run bundle            # 构建由安装包嵌入的运行时归档
npm run dist              # 打包、构建并创建安装包
npm run pack              # 创建未打包的目录构建产物
```

构建产物写入 `release/`。`npm run dist` 会创建包含内置运行时归档的 Electron 安装包；`release/` 中生成的归档会保留用于 QA，不需要单独上传。仓库在 `package.json` 中固定 Pi 运行时版本 `0.84.1`，打包脚本会在创建归档前校验该版本。如需从指定的本地安装位置打包，可将 `PI_PACKAGE_DIR` 设置为对应的 package 目录。

## 配置与数据

Pi Studio 使用 Pi 的 agent 配置目录 `~/.pi/agent`，其中包括模型、provider、身份验证和扩展设置。桌面应用自己的设置保存在 Electron 用户数据目录中。

API key 属于用户数据。不要将 `auth.json`、`models.json`、会话文件、包含 key 的截图或本地配置目录提交到仓库。

## 权限与安全

Pi 可以代表用户读写项目文件并执行工具。Pi Studio 默认以 Sandbox 模式启动新线程；必须明确选择后才能使用完全权限。上述控制可以减少误操作，但不能替代操作系统隔离或用户审核。

不要在公开 issue、pull request、截图或示例文件中粘贴 API key 或其他密钥。如发现安全问题，请先通过 GitHub 私下联系项目维护者，再进行公开披露。

## 参与贡献

欢迎提交 bug 报告和 pull request。提交修改前请：

1. 保持修改范围集中，并说明面向用户的行为变化。
2. 运行 `npm run typecheck`。
3. 如果修改了权限或工具执行代码，运行 `npm run test:permission`。
4. 不要包含本地数据、生成的 bundle、安装包、凭据或 QA 浏览器配置文件。

## 第三方软件

Pi Studio 使用 Electron、React、Vite、Pi coding agent、Node.js 以及其他开源依赖。组件清单和许可证信息请参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

Pi Studio 源代码使用 [MIT License](LICENSE) 授权。

Pi 名称、项目名称、logo 及其他商标仍归其各自所有者所有。MIT 许可证不授予商标使用权。
