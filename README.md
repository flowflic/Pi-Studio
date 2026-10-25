# Pi Studio

Final file delivery uses the Agent's `pi_studio_present` tool, following DeepSeek Harness's explicit presentation approach. The last successful declaration in a reply replaces earlier lists; only validated existing files appear below the completed final response. Scripts, scratch data and QA outputs stay out unless explicitly delivered. Saved sessions retain declarations. Older sessions show only successful outputs referenced by the final response.

**Token usage** settings include per-provider/model cost details, input/output/cache billing, price sources, the bundled dsh-cost-meter price snapshot (2026-09-30), and custom USD/million-token rates. Long-context and historical DeepSeek peak tiers are calculated per request. Positive saved estimates are retained unless explicitly overridden. Subscription equivalents are separate from API cost estimates; unknown prices are marked. The sidebar Usage popover shows a rolling **last 24 hours** window.

The same page shows quota windows, used/remaining percentages and reset times for OpenCode Go, Kimi Code, MiniMax Token Plan, GLM Coding Plan and Claude Pro/Max. Absolute provider quotas are shown when supplied. Credentials come from configured official routes, Pi auth, environment variables or OpenCode login; credential commands and OAuth renewal are not executed. Visible pages refresh every minute and retain timestamped previous data on failures. Percentage-only APIs are never converted into invented token limits.

[English](README.md) · [简体中文](README.zh-CN.md)

Pi Studio is an independent Electron desktop client for the [Pi coding agent](https://github.com/earendil-works/pi). It brings Pi projects, threads, model configuration, extensions, permission controls, automation, and file previews into one desktop workspace.

> Pi Studio is an independent community project. It is not affiliated with or endorsed by the Pi maintainers.

## Screenshots

The current interface brings the main workspace, plugin manager, public Skills Hub, and Android remote-control settings into one desktop client.

<table>
  <tr>
    <td width="50%"><img src="imageassets/newpi01.png" alt="Pi Studio home workspace" width="100%"></td>
    <td width="50%"><img src="imageassets/newpi03.png" alt="Pi Studio plugin manager" width="100%"></td>
  </tr>
  <tr>
    <td align="center">Home workspace</td>
    <td align="center">Plugin manager</td>
  </tr>
  <tr>
    <td width="50%"><img src="imageassets/newpi04.png" alt="Pi Studio Skills Hub" width="100%"></td>
    <td width="50%"><img src="imageassets/newpi02.png" alt="Pi Studio Android remote-control settings" width="100%"></td>
  </tr>
  <tr>
    <td align="center">Skills Hub</td>
    <td align="center">Android remote-control settings</td>
  </tr>
</table>

## Recent additions

- **Release notes in app updates** — When Settings → Update finds a newer release, it shows that version's notes (from the GitHub release) so you can see what changed before downloading and installing. A link to the release page is shown when no notes are attached.
- **Clickable choice menus** — When Pi asks you to pick between options with a "Q1: question / Options:" block, the chat renders it as a card: click an option instead of typing its number. Every question also offers "Other (custom plan)" for when none of the proposals work, and the composed answer is sent as your reply.
- **Pi Agent 1.4.0 with MCP** — Ships the official MCP support, Codemode and tool search. Add or edit `mcpServers` JSON, enable, disable or remove servers, check their connection and tools, and sign in or out of OAuth in Settings → MCP. stdio and Streamable HTTP are supported; run `/reload` (or reopen the chat) after saving. Chats keep nested tool-call records, extension statuses and text components. 1.4.0 also brings compaction and branch summaries that use the model's output limit, Codemode scripts that queue for a free worker (`PI_CODEMODE_MAX_WORKERS` raises the limit), image input for classifier models, and a schema-generated `models.json` configuration reference.
- **Quick setup for built-in providers** — A panel at the top of Settings → Models & providers covers OpenCode Go and Zen, Z.ai GLM Coding Plan (China and global), Qwen Token Plan (China, global, individual), MiniMax Token Plan (China and global), DeepSeek, Kimi For Coding, Moonshot / Kimi API (China and global) and Xiaomi MiMo Token Plan. Pick a provider, paste an API key, optionally test the connection, and save: Pi supplies the endpoint, protocol and model catalog. The key is stored in `models.json` under that provider's `apiKey` without overriding Pi's endpoint or built-in models, and `auth.json` is never touched. The panel reports whether a stored `auth.json` credential takes precedence over the key.
- **Consistent model lists** — For providers with an explicit model list, the thread picker shows only the saved, available models instead of merging in the provider's built-in catalog. Saving settings refreshes open threads.
- **MCP marketplace (Glama)** — A marketplace panel in Settings → MCP reads the [Glama MCP directory](https://glama.ai/mcp/servers). Search by keyword, filter by category, language or hosting, and install: the panel lifts the install example from the server's page into an editable command, arguments and environment variables, previews the generated `mcp.json` entry, and requires explicit confirmation before replacing an existing name. Installs write to Pi's shared `mcp.json`; run `/reload` to load the tools. The panel credits Glama and links every record back to its listing. A sidebar shortcut under Plugins opens this page directly.
- **Office previews** — Local, read-only Univer spreadsheets with sheet tabs, a formula bar, zoom, common XLSX styles, merged cells, row/column dimensions and frozen panes. DOCX previews retain pages, headers, footers and tables with fit-to-width zoom. No conversion server or document upload is needed. Charts, drawings, pivots and conditional formatting are not fully imported; large workbooks have explicit preview limits. PPTX retains its existing basic preview.
- **Plugin manager** — Search, install, update, enable, disable, and remove Pi extension packages from npm, GitHub, or local paths. The same panel also lists skills discovered in Pi's shared and project directories.
- **Skills Hub** — Browse and search the public [skills.sh](https://skills.sh/) directory, inspect a skill's details and install command, and install it directly into Pi.
- **Android remote companion** — Pair an Android device with a desktop host through a short-lived QR ticket, configure the Signal WSS endpoint, view connection state, and manage trusted devices. The remote transport uses direct WebRTC with STUN discovery; TURN/relay candidates are intentionally rejected. Remote project-relative previews include bounded Excel/CSV table snapshots for Pi-Studio-Remote 0.2.
- **Bilingual UI** — Switch the desktop UI between English and Simplified Chinese.

## Features

- Manage local projects and Pi threads from a desktop sidebar.
- Chat with streaming responses and configurable model and thinking levels.
- Read and preview Markdown, HTML, source code, images, and common office documents.
- Configure providers and models through Pi's shared `models.json` configuration.
- Enable built-in providers (OpenCode Go/Zen, Z.ai, MiniMax, Qwen, DeepSeek, Kimi, Moonshot, Xiaomi MiMo) by pasting an API key into the quick setup panel.
- Use Pi extensions and plugins from the shared Pi agent directory.
- Browse and install public skills through the integrated Skills Hub.
- Pair with the Android companion for remote thread viewing and approved controls.
- Run scheduled automations with an explicit sandbox or full-access permission level.
- Keep a versioned Pi/Node runtime embedded in each installer and support app-managed runtime updates.
- Use a permission gate for shell commands, project boundaries, and extension actions.

## Download

Download the latest `Pi-Studio-Setup-<version>.exe` for Windows x64 or `Pi-Studio-<version>-arm64.dmg` for Apple Silicon macOS from GitHub Releases. The installers are currently unsigned, so Windows SmartScreen or macOS Gatekeeper may show a warning.

Each installer contains a native pinned Node.js + Pi runtime. On first launch, Pi Studio verifies and extracts that embedded runtime into the user data directory. App updates promote a newer embedded runtime while reusing an installed runtime of the same or a newer version, without a separate download.

## Development requirements

- Windows x64 and macOS arm64 are the supported packaging targets.
- Node.js `24.14.0` or newer within the Node 24 major version for development and packaging.
- npm.
- Install an isolated Pi coding agent runtime in the project for development and packaging:

```powershell
npm install --global --prefix .runtime-source @earendil-works/pi-coding-agent@1.4.0
```

## Development

```powershell
npm install
npm run typecheck
npm run test:permission
npm run dev
```

Useful commands:

```powershell
npm run build             # Build the Electron application
npm run bundle             # Build the runtime archive embedded by the installer
npm run dist              # Bundle, build, and create the installer
npm run pack              # Create an unpacked directory build
```

Build output is written to `release/`. `npm run dist` creates the Electron installer with the runtime archive embedded inside it; the generated archive in `release/` is retained for QA and does not need to be uploaded separately. The repository pins Pi runtime `1.4.0` in `package.json`. Packaging prefers `.runtime-source` and also accepts a matching global installation. To package from a specific local installation, set `PI_PACKAGE_DIR` to its package directory.

Settings → Token usage offers a green heatmap with daily, weekly and cumulative views, date filters, input/output/cache totals, model breakdowns and estimated costs. Usage comes from saved sessions with forked records deduplicated.

Settings → MCP manages global `mcpServers` JSON: add/edit, enable/disable, remove, check connections and tools, and OAuth sign-in/sign-out. stdio and Streamable HTTP use Pi's built-in MCP support, including Codemode and tool search. Run `/reload` in chat or reopen it after saving. Nested tool calls, extension statuses and text widgets are displayed in chat.

The same page embeds the Glama MCP marketplace. Search and filters query `glama.ai/mcp/servers`; installing a result reads the public server page, extracts the install example, and opens a review panel where the command, arguments, environment variables and generated `mcp.json` entry can be edited before writing. Existing names are never overwritten without confirmation. Glama's documented API requires a per-user key, so Pi Studio reads the public directory pages instead and keeps the attribution and per-record links the directory requires.

Run `npm run test:usage-mcp` and `npm run test:settings-ui` for feature checks. After `npm run bundle`, `npm run test:runtime-mcp` checks the packaged upgrade and actual nested MCP execution using isolated settings and local model/MCP fixtures without user credentials. `npm run test:mcp-marketplace` and `npm run test:mcp-marketplace-ui` cover the marketplace parsers, install path and UI.

## Configuration and data

Pi Studio shares Pi's agent configuration under `~/.pi/agent`, including model, provider, authentication, and extension settings. The desktop application's own settings are stored in Electron's user data directory.

API keys are user data. Do not commit `auth.json`, `models.json`, session files, screenshots containing keys, or local configuration directories to this repository.

## Permissions and security

Pi can read and write project files and execute tools on the user's behalf. Pi Studio starts new threads in sandbox mode by default. Sandbox automatically runs operations that can be verified as low-risk and explicit, while destructive or recursive deletion, sensitive paths, external code execution, network state changes, and uncertain operations still require confirmation. Full access must be selected explicitly for a thread or automation task. These controls reduce accidental actions but do not replace operating-system isolation or user review.

Do not paste API keys or other secrets into public issues, pull requests, screenshots, or example files. For a security issue, contact the project maintainer privately through GitHub before public disclosure.

## Contributing

Bug reports and pull requests are welcome. Before submitting a change:

1. Keep changes focused and explain user-visible behavior.
2. Run `npm run typecheck`.
3. Run `npm run test:permission` when permission or tool execution code changes.
4. Do not include local data, generated bundles, installers, credentials, or QA browser profiles.

## Third-party software

Pi Studio uses Electron, React, Vite, Pi coding agent, Node.js, and other open-source packages. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the component inventory and license references.

## License

The Pi Studio source code is licensed under the [MIT License](LICENSE).

The Pi name, project name, logos, and other trademarks remain the property of their respective owners. The MIT license does not grant trademark rights.
