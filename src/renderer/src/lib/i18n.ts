export type Language = "en" | "zh";

/**
 * The existing UI was authored in Chinese. This dictionary-backed DOM bridge
 * lets every panel participate in the app language immediately while keeping
 * extension/model/user content untouched. Exact UI labels are translated;
 * dynamic labels are handled by the small patterns below.
 */
const exact: Record<string, string> = {
  "设置": "Settings",
  "模型与提供商": "Models & providers",
  "思考默认值": "Thinking defaults",
  "诊断与配置": "Diagnostics & config",
  "更新 Pi": "Update Pi",
  "新建任务": "New task",
  "自动化": "Automations",
  "插件": "Plugins",
  "线程": "Threads",
  "文件": "Files",
  "项目": "Projects",
  "暂无线程": "No threads yet",
  "尚无项目，点击 + 打开一个文件夹。": "No projects yet. Click + to open a folder.",
  "Pi 合计用量": "Total Pi usage",
  "刷新": "Refresh",
  "暂无用量数据": "No usage data",
  "打开项目文件夹": "Open project folder",
  "尚未打开任何项目。": "No projects have been opened.",
  "正在启动 pi 进程…": "Starting pi process…",
  "新线程": "New thread",
  "图片消息": "Image message",
  "搜索项目": "Search projects",
  "没有匹配的项目": "No matching projects",
  "新建项目": "New project",
  "只能在发送第一条消息前更换任务文件夹。": "The task folder can only be changed before the first message is sent.",
  "归档项目": "Archive project",
  "归档项目失败：": "Failed to archive project: ",
  "恢复项目": "Restore project",
  "线程已归档，可在设置的“归档线程”中恢复。": "Thread archived. Restore it from Archived threads in Settings.",
  "线程已恢复到侧栏。": "Thread restored to the sidebar.",
  "已归档项目": "Archived projects",
  "已归档线程": "Archived threads",
  "暂无归档项目。": "No archived projects.",
  "暂无归档线程。": "No archived threads.",
  "归档只会从侧栏、搜索和新建任务的项目列表中隐藏文件夹，不会删除文件夹或其中的线程。": "Archiving only hides the folder from the sidebar, search, and new-task project list. It does not delete the folder or its threads.",
  "归档只会隐藏线程，不会删除会话文件；恢复后线程会重新出现在所属项目下。": "Archiving only hides the thread; it does not delete the session file. Restored threads reappear under their project.",
  "归档线程": "Archive thread",
  "恢复线程": "Restore thread",
  "Commands, plugins & skills": "Commands, plugins & skills",
  "项目已归档，可在设置的“归档项目”中恢复。": "Project archived. Restore it from Archived projects in Settings.",
  "项目已恢复到侧栏。": "Project restored to the sidebar.",
  "复制": "Copy",
  "用户": "User",
  "复制这条用户消息": "Copy this user message",
  "默认思考深度": "Default effort",
  "默认提供商": "Default provider",
  "默认模型": "Default model",
  "隐藏思考块": "Hide thinking block",
  "（未设）": "(Not set)",
  "保存思考默认值": "Save thinking defaults",
  "保存模型配置": "Save model config",
  "重新加载": "Reload",
  "关闭": "Close",
  "添加提供商": "Add provider",
  "创建": "Create",
  "取消": "Cancel",
  "模型": "Models",
  "添加模型": "Add model",
  "暂无模型，点击“添加模型”。": "No models yet. Click “Add model”.",
  "思考": "Reasoning",
  "图像": "Images",
  "高级": "Advanced",
  "删除": "Delete",
  "删除模型": "Delete model",
  "删除提供商": "Delete provider",
  "显示": "Show",
  "隐藏": "Hide",
  "请求头": "Request headers",
  "请求头名称": "Header name",
  "添加请求头": "Add header",
  "API 类型": "API type",
  "配置文件": "Configuration files",
  "打开配置目录": "Open config folder",
  "语言": "Language",
  "英文": "English",
  "中文": "Chinese",
  "拒绝": "Deny",
  "允许": "Allow",
  "需要确认": "Confirmation required",
  "选择一个选项": "Choose an option",
  "图片预览": "Image preview",
  "终端 pi 的 Windows 桌面端：完整继承模型、运行框架与插件系统。左侧选择项目与线程，右侧预览文件。": "A Windows desktop client for terminal Pi, with its models, harness, and extension system. Choose projects and threads on the left and preview files on the right.",
  "搜索会话与文件": "Search threads and files",
  "折叠侧栏": "Collapse sidebar",
  "先在“线程”页打开一个项目。": "Open a project from the Threads tab first.",
  "加载中…": "Loading…",
  "连接中": "Connecting",
  "重命名": "Rename",
  "当前线程上下文用量": "Current thread context usage",
  "上下文": "Context",
  "已使用": "Used",
  "总上下文": "Total context",
  "剩余": "Remaining",
  "暂无上下文数据": "No context data",
  "切换工作文件夹": "Change working folder",
  "新会话": "New session",
  "切换预览": "Toggle preview",
  "刷新预览": "Refresh preview",
  "文件产物": "File outputs",
  "原内容": "Original content",
  "新内容": "New content",
  "写入内容": "Written content",
  "写入": "Write",
  "无法创建 HTML 预览地址。": "Could not create the HTML preview URL.",
  "思考中": "Thinking",
  "待处理 follow-up": "Pending follow-up",
  "· 当前任务完成后自动发送": "· Sends when the current task finishes",
  "重新编辑": "Edit again",
  "完全权限": "Full access",
  "敏感命令执行前需确认（默认）": "Confirm sensitive commands before execution (default)",
  "pi 默认，不拦截任何操作": "Pi default; no operations are intercepted",
  "命令": "Commands",
  "无可用命令": "No commands available",
  "没有匹配的命令": "No matching commands",
  "搜索命令、插件或 skill": "Search commands, plugins, or skills",
  "模型与思考等级": "Model and effort",
  "无可用模型（检查 auth）": "No models available (check auth)",
  "思考等级": "Effort",
  "JSON 语法错误，保存前请修正": "Invalid JSON. Fix it before saving.",
  "显示名称": "Display name",
  "支持扩展思考": "Supports extended reasoning",
  "（继承 / 未设）": "(Inherit / not set)",
  "提供商级 compat（高级 JSON）": "Provider compat (advanced JSON)",
  "编辑会写入 ~/.pi/agent，与终端 pi 共享。": "Changes are written to ~/.pi/agent and shared with terminal Pi.",
  "已保存 ✓": "Saved ✓",
  "Pi 运行时": "Pi runtime",
  "node 版本": "Node version",
  "pi 版本": "Pi version",
  "配置目录": "Config directory",
  "在资源管理器显示": "Show in File Explorer",
  "在资源管理器中显示": "Show in File Explorer",
  "更新 Pi 核心": "Update Pi core",
  "当前版本": "Current version",
  "最新版本": "Latest version",
  "可更新": "Update available",
  "检查并更新中…": "Checking and updating…",
  "检查并更新 Pi": "Check and update Pi",
  "立即重启 Pi Studio": "Restart Pi Studio now",
  "未检测到 pi：": "Pi was not detected: ",
  "请填写任务名称": "Enter a task name",
  "请选择工作文件夹": "Choose a working folder",
  "请填写要执行的 prompt": "Enter a prompt to run",
  "请填写要执行的提示词": "Enter a prompt to run",
  "定时执行可使用 skill 的自定义 prompt（仅在 Pi Studio 运行时调度）": "Schedule custom prompts that can use skills (runs while Pi Studio is open)",
  "共": "Total",
  "个任务": "tasks",
  "尚无定时任务。点“新建任务”创建一个。": "No scheduled tasks yet. Select New task to create one.",
  "未命名任务": "Untitled task",
  "上次失败": "Last run failed",
  "立即运行": "Run now",
  "编辑": "Edit",
  "任务名称": "Task name",
  "例如：每日晨报": "For example: Daily briefing",
  "工作文件夹": "Working folder",
  "选择任务运行的项目目录": "Choose the project folder for this task",
  "选择": "Select",
  "要执行的指令，可调用 skill，例如：\n/standup 生成今日 standup 报告并写入 docs/": "Instructions to run. Skills are supported, for example:\n/standup Create today's standup report in docs/",
  "触发时在该文件夹新建一个 pi 会话执行，完成后保存为可查看的线程。": "When triggered, a new Pi session runs in this folder and is saved as a viewable thread.",
  "重复": "Repeat",
  "按小时": "Hourly",
  "每天": "Daily",
  "每周": "Weekly",
  "每小时第": "At minute",
  "分钟执行": "of every hour",
  "时刻": "Time",
  "保存任务": "Save task",
  "pi 进程连接中；历史已可浏览，发送消息会自动等待连接完成": "Connecting to Pi. History is available; sending will wait for the connection.",
  "从此 Agent 回复分支": "Branch from this Agent reply",
  "从这条 Agent 回复开始创建新分支": "Create a new branch from this Agent reply",
  "连接并保存会话后可 Fork": "Fork is available after the session connects and saves",
  "复制截至这条 Agent 回复的分支": "Clone the branch through this Agent reply",
  "连接并保存会话后可 Clone": "Clone is available after the session connects and saves",
  "思考过程 ·": "Reasoning ·",
  "字": "chars",
  "立即 steering（尽快插入上下文执行）": "Steer now (insert into context as soon as possible)",
  "输入插话… Enter 存为待处理 follow-up（完成后发送），Alt+Enter 立即 steering（中断当前）": "Type a message… Enter queues a follow-up; Alt+Enter steers immediately",
  "随心输入 · 粘贴/拖拽图片 · + 添加文件": "Type a message · Paste or drop images · + Add files",
  "随心输入  ·  粘贴/拖拽图片  ·  + 添加文件": "Type a message · Paste or drop images · + Add files",
  "权限级别：sandbox 仅自动放行明确只读的 shell 命令，并限制项目外写入；完全权限为 pi 默认 unrestricted 模式": "Permission level: sandbox auto-allows clearly read-only shell commands and restricts writes outside the project; full access uses Pi's unrestricted mode",
  "存为待处理 follow-up（Enter）；Alt+Enter 立即 steering": "Queue as follow-up (Enter); Alt+Enter steers immediately",
  "本地": "Local",
  "管理 pi 的 extension 包与 skill": "Manage Pi extension packages and skills",
  "开关写入 ~/.pi/agent/settings.json，与终端 pi 共享；更改在下次启动 pi 会话时生效。": "Changes are written to ~/.pi/agent/settings.json and shared with terminal Pi. They apply to the next Pi session.",
  "开关写入 ~/.pi/agent/settings.json，与终端 pi 共享；自动扫描 ~/.pi/agent/skills、~/.pi/agent/skill 和当前项目的 .pi skill 目录。": "Changes are written to ~/.pi/agent/settings.json and shared with terminal Pi. Pi scans ~/.pi/agent/skills, ~/.pi/agent/skill, and the current project's .pi skill folders.",
  "搜索插件或 skill": "Search plugins or skills",
  "清除搜索": "Clear search",
  "刷新插件和 skill": "Refresh plugins and skills",
  "更新全部": "Update all",
  "检查并更新所有扩展（pi update --extensions）": "Check and update all extensions (pi update --extensions)",
  "安装来源，如 npm:@foo/bar 或 git:github.com/user/repo 或本地路径": "Package source, such as npm:@foo/bar, git:github.com/user/repo, or a local path",
  "安装": "Install",
  "尚未安装任何 extension 包。": "No extension packages are installed.",
  "已停用": "Disabled",
  "检查并更新此扩展": "Check and update this extension",
  "移除": "Remove",
  "未在 ~/.pi/agent/skills 等目录发现独立 skill。": "No standalone skills were found in ~/.pi/agent/skills or other skill folders.",
  "停用 skill 会将其入口文件重命名为 *.disabled（可逆）。": "Disabling a skill renames its entry file to *.disabled and can be reversed.",
  "从左侧文件树点一个文件以预览。": "Select a file in the left file tree to preview it.",
  "支持：文本 / 代码 / Markdown / HTML / 图片 / Word(.docx) / Excel(.xlsx, .csv)": "Supports text, code, Markdown, HTML, images, Word (.docx), and Excel (.xlsx, .csv).",
  "文件过大，已截断。": "The file is too large and has been truncated.",
  "文件过大，无法预览。": "The file is too large to preview.",
  "文件不存在": "File not found",
  "该格式暂不支持预览": "Preview is not available for this format",
  "搜索线程": "Search threads",
  "搜索所有线程中的关键词…": "Search across all threads…",
  "清空": "Clear",
  "输入关键词，在全部项目的线程对话中搜索。": "Enter keywords to search thread conversations across all projects.",
  "匹配线程标题与用户 / 助手消息内容。": "Matches thread titles and user or assistant messages.",
  "未找到包含": "No threads found containing",
  "的线程。": ".",
  "处匹配": "matches",
  "条": "messages",
  "打开": "Open",
  "个线程": "threads",
  "header 名": "Header name",
  "值（支持 $ENV / !cmd）": "Value (supports $ENV / !cmd)",
  "模型 id（必填）": "Model ID (required)",
  "上下文 128000": "Context 128000",
  "上下文长度 (tokens)": "Context length (tokens)",
  "最大输出 16384": "Max output 16384",
  "最大输出 tokens": "Maximum output tokens",
  "兼容性覆盖，如 thinkingFormat / supportsDeveloperRole 等": "Compatibility overrides such as thinkingFormat or supportsDeveloperRole",
  "pi 思考等级 → 提供方取值；null 表示隐藏该等级": "Pi effort level → provider value; null hides the level",
  "JSON 对象：键为思考等级，值为提供方取值或 null": "JSON object mapping effort levels to provider values or null",
  "自定义 API 接入地址，如 https://api.example.com/v1": "Custom API endpoint, such as https://api.example.com/v1",
  "支持明文、环境变量 $MY_KEY、或 shell 命令 !cmd": "Supports plain text, environment variables such as $MY_KEY, or shell commands with !cmd",
  "sk-... 或 $ENV_VAR 或 !command": "sk-..., $ENV_VAR, or !command",
  "自定义请求头，值同样支持 $ENV / !cmd": "Custom request headers; values also support $ENV / !cmd",
  "诊断与配置文件": "Diagnostics & configuration",
  "重新读取 models.json": "Reload models.json",
  "自定义提供商与模型，参考 models.md。常用字段图形化；compat 在“高级”里用 JSON 编辑，thinkingLevelMap 按档位配置。": "Configure custom providers and models using models.md. Common fields have controls; edit compat as JSON under Advanced and configure thinkingLevelMap by level.",
  "提供商标识符，如 my-proxy": "Provider ID, such as my-proxy",
  "尚无提供商。点“添加提供商”接入自定义 API（OpenAI / Anthropic / Gemini 兼容端点、Ollama、代理等）。": "No providers yet. Select Add provider to connect a custom API, compatible endpoint, Ollama, or proxy.",
  "新建会话的初始思考等级；模型需 reasoning=true 才生效": "Initial effort for new sessions; the model must have reasoning=true",
  "这些是全局默认值，写入 settings.json。单个模型的思考能力由该模型的“思考”开关与 compat 决定。": "These global defaults are written to settings.json. Each model's reasoning support is controlled by its Reasoning setting and compat fields.",
  "打开 settings.json": "Open settings.json",
  "打开 models.json": "Open models.json",
  "编辑会写入": "Changes are written to",
  "，与终端 pi 共享。": " and shared with terminal Pi.",
  "这些文件由桌面端与终端 pi 共享。在此面板保存会原子写回并保留你手写的高级字段；也可用上方按钮直接在外部编辑。": "These files are shared by Pi Studio and terminal Pi. Saving here writes atomically and preserves advanced fields; the buttons above open them for external editing.",
  "新建对话": "New conversation",
  "打开文件夹…": "Open folder…",
  "剪切": "Cut",
  "粘贴": "Paste",
  "进入设置…": "Open Settings…",
  "视图": "View",
  "展开侧栏": "Expand sidebar",
  "切换预览面板": "Toggle preview panel",
  "帮助": "Help",
  "关于 Pi Studio": "About Pi Studio",
  "Pi Studio · 终端 pi 的 Windows 桌面端": "Pi Studio · Windows desktop client for terminal Pi",
  "Pi 合计 token 用量": "Total Pi token usage",
  "条 ·": "messages ·",
  "个会话": "sessions",
  "Extension 包（": "Extension packages (",
  "请等待当前回复结束后再 Fork。": "Wait for the current reply to finish before forking.",
  "已从所选 Agent 回复创建 Fork。": "Created a fork from the selected Agent reply.",
  "请等待当前回复结束后再 Clone。": "Wait for the current reply to finish before cloning.",
  "已 Clone 截至所选 Agent 回复的分支。": "Cloned the branch through the selected Agent reply.",
  "模型配置已保存，新模型现在可在对话框中选择。": "Model configuration saved. The new model is now available in the chat.",
  "收回侧边栏预览": "Restore side preview",
  "切换失败": "Change failed",
  "该扩展已是最新版本。": "This extension is already up to date.",
  "所有扩展已是最新版本。": "All extensions are already up to date.",
  "扩展已更新到最新版本。": "The extension was updated to the latest version.",
  "所有扩展已更新到最新版本。": "All extensions were updated to the latest version.",
  "扩展已更新。": "Extension updated.",
  "更新命令已执行，但进程退出异常。请检查扩展版本。": "The update command ran, but the process exited unexpectedly. Check the extension version.",
  "未知错误": "Unknown error",
  "删除失败": "Deletion failed",
  "线程已永久删除，无法恢复。": "Thread permanently deleted and cannot be recovered.",
  "任务已开始执行…": "Task started…",
  "已切换到 sandbox（非只读命令及项目外写入需确认）。": "Switched to sandbox. Non-read-only commands and writes outside the project require confirmation.",
  "已切换到完全权限。": "Switched to full access.",
  "Pi 已是最新版本。": "Pi is already up to date.",
  "Pi 已更新到最新版本。": "Pi was updated to the latest version.",
  "Pi 更新命令已执行，但进程退出时出现已知 Windows 兼容问题。请重启 Pi Studio 以使用新版本。": "The Pi update ran, but the process hit a known Windows exit issue. Restart Pi Studio to use the new version.",
  "Pi 更新状态不确定（进程退出异常）。请重启 Pi Studio 后检查版本。": "Pi update status is uncertain because the process exited unexpectedly. Restart Pi Studio and check the version.",
  "请输入提供商标识符（如 my-proxy）": "Enter a provider ID, such as my-proxy",
  "标识符已存在": "That ID already exists",
  "请先修正标红的高级 JSON 字段": "Fix the highlighted advanced JSON fields first",
  "模型配置已保存到 models.json。新模型在新建线程时生效；运行中的线程需新建会话。": "Model configuration was saved to models.json. New models apply to new threads; start a new session in active threads.",
  "思考默认值已保存到 settings.json。": "Thinking defaults were saved to settings.json.",
  "有未保存的更改，确定放弃并关闭？": "Discard unsaved changes and close?",
  "将丢弃未保存的模型编辑并重新读取 models.json，继续？": "Discard unsaved model changes and reload models.json?",
  "Pi 核心由 Pi Studio 统一管理（内置副本不可被": "Pi Studio manages the Pi core. The bundled copy cannot be updated in place by",
  "原地更新）。点击下方按钮后，Pi Studio 会自行下载并安装新版本到应用数据目录，更新完成后新开的线程使用新版本。扩展请在「插件」面板更新。": ". Use the button below to download and install a new version into app data. New threads use it after the update. Update extensions in the Plugins panel.",
  "运行": "Run",
  "更新 pi CLI 本体（不含扩展，扩展请在「插件」面板更新）。会先检查是否为最新版本，结果以提示呈现。更新完成后新开的线程使用新版本。": "to update the Pi CLI itself. Extensions are updated separately in the Plugins panel. Pi checks the current version first, and new threads use the updated version.",
  "正在检查最新版本…": "Checking for updates…",
  "正在下载 Pi 核心…": "Downloading Pi core…",
  "正在解压安装包…": "Extracting package…",
  "正在精简运行时文件…": "Pruning runtime files…",
  "正在激活新版本…": "Activating the new version…",
  "正在检查 GitHub 发布页最新版本…": "Checking the latest GitHub Release…",
  "当前环境不能自动安装应用更新": "This environment cannot install app updates automatically",
  "请先下载应用更新": "Download the app update first",
  "更新服务没有返回版本信息": "The update service did not return version information",
  "更新服务没有返回 Windows 安装包": "The update service did not return a Windows installer",
};

const prefixes: Array<[string, string]> = [
  ["未检测到 pi：", "Pi was not detected: "],
  ["归档项目失败：", "Failed to archive project: "],
  ["恢复项目失败：", "Failed to restore project: "],
  ["恢复线程失败：", "Failed to restore thread: "],
  ["归档线程失败：", "Failed to archive thread: "],
  ["归档线程：", "Archive thread: "],
  ["在文件管理器中打开：", "Open in File Explorer: "],
  ["连接 pi 进程失败：", "Failed to connect to Pi: "],
  ["加载插件失败：", "Failed to load plugins: "],
  ["安装失败：", "Installation failed: "],
  ["移除失败：", "Removal failed: "],
  ["加载任务失败：", "Failed to load tasks: "],
  ["保存任务失败：", "Failed to save task: "],
  ["执行失败：", "Execution failed: "],
  ["切换权限失败：", "Failed to change permissions: "],
  ["切换文件夹失败：", "Failed to change folder: "],
  ["Pi 更新失败：", "Pi update failed: "],
  ["更新扩展失败：", "Failed to update extension: "],
  ["更新全部扩展失败：", "Failed to update all extensions: "],
  ["读取配置失败：", "Failed to read configuration: "],
  ["保存失败：", "Save failed: "],
  ["打开失败：", "Open failed: "],
  ["检查失败：", "Check failed: "],
  ["自动化任务完成：", "Automation task completed: "],
  ["自动化任务失败：", "Automation task failed: "],
  ["Pi Studio 更新失败：", "Pi Studio update failed: "],
  ["启动安装程序失败：", "Failed to start the installer: "],
  ["永久删除线程失败：", "Failed to permanently delete thread: "],
  ["Pi 运行时包安装失败：", "Pi runtime package installation failed: "],
];

/**
 * A small reverse catalog is intentional here. Most renderer copy is authored
 * in Chinese and translated by `exact`, but a few desktop controls originated
 * in English. Keeping their reverse labels here prevents those controls from
 * leaking into the Chinese UI without translating arbitrary transcript or
 * extension content.
 */
const englishExact: Record<string, string> = {
  ...Object.fromEntries(Object.entries(exact).map(([source, target]) => [target, source])),
  "Settings": "设置",
  "Minimize": "最小化",
  "Maximize": "最大化",
  "Close": "关闭",
  "Dismiss": "关闭提示",
  "Toggle preview": "切换预览",
  "Copy": "复制",
  "Copied": "已复制",
  "Good": "有帮助",
  "Bad": "没帮助",
  "Fork": "分支",
  "Forking…": "创建分支中…",
  "Clone": "克隆",
  "Cloning…": "克隆中…",
  "Tool activity": "工具活动",
  "call": "调用",
  "calls": "次调用",
  "Waiting for tool data": "等待工具数据",
  "Waiting for execution data": "等待执行数据",
  "Output will appear here while the tool runs": "工具运行时会显示输出",
  "Queued — execution has not started": "排队中，尚未开始执行",
  "No output returned": "未返回输出",
  "Arguments": "参数",
  "Arguments unavailable": "参数不可用",
  "Output": "输出",
  "Read": "读取",
  "attachment": "附件",
  "Pi Studio Agent": "Pi Studio 智能体",
  "Commands, plugins & skills": "命令、插件和技能",
  "image": "图像",
  "Add files": "添加文件",
  "Slash commands / skills": "斜杠命令 / 技能",
  "Stop": "停止",
  "Send": "发送",
  "No project": "暂无项目",
  "Prompt": "提示词",
  "Sandbox": "沙盒",
  "Skills Hub": "技能中心",
  "Help": "帮助",
  "Open folder": "打开文件夹",
  "New thread": "新线程",
  "New Thread": "新线程",
  "English": "英文",
  "Pi extension": "Pi 扩展",
  "No": "否",
  "Yes": "是",
  "Cancel": "取消",
  "OK": "确定",
  "Save": "保存",
  "connection failed": "连接失败",
  "ready": "就绪",
  "connecting…": "连接中…",
  "Pi ready": "Pi 已就绪",
  "Pi unavailable": "Pi 不可用",
  "Close remote settings": "关闭远程设置",
  "Open project folder": "打开项目文件夹",
  "Attach files": "添加文件",
  "Model started responding successfully.": "模型已成功响应。",
  "File not found": "文件不存在",
  "This is a folder": "这是一个文件夹",
  "Binary file": "二进制文件",
  "No preview available for this file type": "暂不支持预览此文件类型",
  "Excel preview could not be parsed on the Pi Studio host": "Pi Studio 无法解析此 Excel 预览",
  "docx parse failed": "DOCX 解析失败",
  "xlsx parse failed": "XLSX 解析失败",
  "pptx parse failed": "PPTX 解析失败",
  "stat failed": "读取文件状态失败",
  "Model request failed.": "模型请求失败。",
  "The model process exited without producing a response.": "模型进程退出时没有返回响应。",
  "The model did not start responding within 120 seconds.": "模型在 120 秒内没有开始响应。",
};

const englishPrefixes: Array<[string, string]> = [
  ...prefixes.map(([source, target]) => [target, source] as [string, string]),
  ["Failed to load settings: ", "加载设置失败："],
  ["Failed to load projects: ", "加载项目失败："],
  ["Open folder failed: ", "打开文件夹失败："],
  ["Open thread failed: ", "打开线程失败："],
  ["Pin project failed", "置顶项目失败"],
  ["Unpin project failed", "取消置顶项目失败"],
  ["Pin thread failed", "置顶线程失败"],
  ["Unpin thread failed", "取消置顶线程失败"],
  ["prompt failed", "提示失败"],
  ["abort failed", "中止失败"],
  ["set model failed", "设置模型失败"],
  ["set thinking failed", "设置思考等级失败"],
  ["new session failed", "新建会话失败"],
  ["fork failed", "创建分支失败"],
  ["clone failed", "克隆失败"],
  ["rename failed", "重命名失败"],
  ["load tree failed", "加载文件树失败"],
  ["read failed", "读取失败"],
  ["Could not locate Pi runtime", "未找到 Pi 运行时"],
  ["Timed out while locating the Pi runtime", "查找 Pi 运行时超时"],
  ["Pi runtime package could not be installed: ", "Pi 运行时包安装失败："],
  ["No managed Node runtime is available to install the Pi update", "没有可用于安装 Pi 更新的托管 Node 运行时"],
  ["Model test process exited with code ", "模型测试进程以代码 "],
];

function translateToEnglish(value: string): string {
  const trimmed = value.trim();
  if (exact[trimmed]) return value.replace(trimmed, exact[trimmed]);
  let translated = value;
  for (const [source, target] of prefixes) {
    if (trimmed.startsWith(source)) {
      translated = value.replace(source, target);
      break;
    }
  }
  return translated
    .replace(/共\s*(\d+)\s*个任务/g, "$1 tasks")
    .replace(/(\d+)\s*个任务/g, "$1 tasks")
    .replace(/(\d+)\s*处匹配/g, "$1 matches")
    .replace(/(\d+)\s*个线程/g, "$1 threads")
    .replace(/(\d+)\s*条\s*·/g, "$1 messages ·")
    .replace(/(\d+)\s*条/g, "$1 messages")
    .replace(/(\d+)\s*个会话/g, "$1 sessions")
    .replace(/(\d+)\s*个附件/g, "$1 attachments")
    .replace(/(\d+)\s*模型/g, "$1 models")
    .replace(/^每小时 第\s*(\d+)\s*分钟$/, "Hourly at minute $1")
    .replace(/^每天\s+/, "Daily at ")
    .replace(/^每周\s+/, "Weekly on ")
    .replace(/^更新到\s+v(.+)$/, "Update to v$1")
    .replace(/^发现新版本\s+v(.+)（当前\s+v(.+)）$/, "Found v$1 (current v$2)")
    .replace(/^正在安装依赖（(.+?)）…$/, "Installing dependencies ($1)…")
    .replace(/^已更新到\s+v(.+)$/, "Updated to v$1")
    .replace(/^Pi 核心已更新到\s+v(.+)，新开的线程将使用新版本。$/, "Pi core updated to v$1. New threads will use it.")
    .replace(/^正在下载 Pi Studio v(.+)…$/, "Downloading Pi Studio v$1…")
    .replace(/^Pi Studio v(.+) 已下载，可以安装并重启$/, "Pi Studio v$1 downloaded and ready to install")
    .replace(/^Pi Studio 已经是最新版本（v(.+)）$/, "Pi Studio is already up to date (v$1)")
    .replace(/^正在安装 Pi Studio v(.+)，应用将自动重启$/, "Installing Pi Studio v$1; the app will restart")
    .replace(/^Pi 运行时 v(.+) 已就绪$/, "Pi runtime v$1 is ready")
    .replace(/^正在准备内置 Pi 运行时 v(.+)$/, "Preparing embedded Pi runtime v$1")
    .replace(/^正在解压内置 Pi 运行时$/, "Extracting embedded Pi runtime")
    .replace(/^正在激活 Pi 运行时 v(.+)$/, "Activating Pi runtime v$1")
    .replace(/^Pi 运行时 v(.+) 已作为独立包安装到应用数据目录：(.+)$/, "Pi runtime v$1 installed as a standalone package at $2")
    .replace(/合计\s*\$/g, "Total $");
}

function translateToChinese(value: string): string {
  const trimmed = value.trim();
  if (englishExact[trimmed]) return value.replace(trimmed, englishExact[trimmed]);
  for (const [source, target] of englishPrefixes) {
    if (trimmed.startsWith(source)) {
      return value.replace(source, target);
    }
  }
  return value
    .replace(/^(\d+) tasks$/, "$1 个任务")
    .replace(/^(\d+) matches$/, "$1 处匹配")
    .replace(/^(\d+) threads$/, "$1 个线程")
    .replace(/^(\d+) messages$/, "$1 条消息")
    .replace(/^(\d+) sessions$/, "$1 个会话")
    .replace(/^(\d+) attachments$/, "$1 个附件")
    .replace(/^(\d+) models$/, "$1 个模型")
    .replace(/^Hourly at minute\s+(\d+)$/, "每小时 第 $1 分钟")
    .replace(/^Daily at\s+/, "每天 ")
    .replace(/^Weekly on\s+/, "每周 ")
    .replace(/^Update to\s+v(.+)$/, "更新到 v$1")
    .replace(/^Pi runtime v(.+) is ready$/, "Pi 运行时 v$1 已就绪")
    .replace(/^Preparing embedded Pi runtime v(.+)$/, "正在准备内置 Pi 运行时 v$1")
    .replace(/^Extracting embedded Pi runtime$/, "正在解压内置 Pi 运行时")
    .replace(/^Activating Pi runtime v(.+)$/, "正在激活 Pi 运行时 v$1")
    .replace(/^Pi runtime v(.+) installed as a standalone package at (.+)$/, "Pi 运行时 v$1 已作为独立包安装到应用数据目录：$2")
    .replace(/^Total\s+\$/g, "合计 $");
}

/** Translate application-owned UI copy. User, Agent, tool, and extension content is excluded by the DOM bridge. */
export function translateUiText(value: string, language: Language): string {
  return language === "en" ? translateToEnglish(value) : translateToChinese(value);
}

const originals = new WeakMap<Node, string>();
const attrOriginals = new WeakMap<Element, Map<string, string>>();
const PROTECTED_TEXT_SELECTOR = ".md,.toast,.msg-user-text,.thinking-body,.tool-output,.tool-name,.tool-summary,.modal-title,.modal-msg,.extui-card-message,.extui-card-title,.extui-card-options,.pname,.tt-text,.chat-head-title,.chat-head-folder-path,.project-menu-option,.thread-preview,.project-context-name,.archived-project-name,.archived-thread-name,.archived-thread-path,.msg-artifact-name,.msg-artifact-path,.ft-name,.plugins-row-name,.plugins-row-sub,.auto-prompt,.skills-hub-card-name,.skills-hub-card-source,.skills-hub-description,.skills-hub-install-command,.skills-hub-file,.skills-hub-markdown,.preview-title,.set-prov-id,.search-item-title,.search-item-snippet,.search-item-proj";

function isProtectedText(element: Element | null): boolean {
  return !!element?.closest(PROTECTED_TEXT_SELECTOR);
}

function localizeNode(root: ParentNode, language: Language): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || isProtectedText(parent)) continue;
    if (!originals.has(node)) originals.set(node, node.nodeValue || "");
    const original = originals.get(node) || "";
    const next = translateUiText(original, language);
    if (node.nodeValue !== next) node.nodeValue = next;
  }
  const elements = root instanceof Element ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
  for (const el of elements) {
    for (const attr of ["title", "aria-label", "placeholder"]) {
      const current = el.getAttribute(attr);
      if (current == null) continue;
      if (isProtectedText(el) || (attr === "title" && el.matches(".thread,.project-head"))) continue;
      let map = attrOriginals.get(el);
      if (!map) {
        map = new Map();
        attrOriginals.set(el, map);
      }
      if (!map.has(attr)) map.set(attr, current);
      const original = map.get(attr)!;
      const next = translateUiText(original, language);
      if (current !== next) el.setAttribute(attr, next);
    }
  }
}

export function installLanguageBridge(language: Language): () => void {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  localizeNode(document.body, language);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element && record.attributeName) {
        const el = record.target;
        const attr = record.attributeName;
        const current = el.getAttribute(attr);
        const map = attrOriginals.get(el);
        const oldOriginal = map?.get(attr);
        const expected = oldOriginal == null ? null : translateUiText(oldOriginal, language);
        // React may update a title/aria-label/placeholder on an existing node.
        // Adopt that new source value, but ignore the attribute write made by
        // this bridge itself.
        if (current != null && expected !== null && current !== expected) map!.set(attr, current);
        localizeNode(el, language);
        continue;
      }
      if (record.type === "characterData" && record.target.parentNode) {
        const oldOriginal = originals.get(record.target);
        const current = record.target.nodeValue || "";
        const expected = oldOriginal == null ? null : translateUiText(oldOriginal, language);
        // A React update changed a previously localized text node. Adopt the
        // new source value before translating it, while ignoring our own write.
        if (expected !== null && current !== expected) originals.set(record.target, current);
        localizeNode(record.target.parentNode, language);
      }
      for (const added of record.addedNodes) {
        if (added.nodeType === Node.ELEMENT_NODE) localizeNode(added as Element, language);
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["title", "aria-label", "placeholder"],
  });
  return () => observer.disconnect();
}
