# 原生 AI Agent：Phase 0

来源：[Notion MVP 任务 TK-41](https://app.notion.com/p/4091a252e21181a7b809f5e1d38c8125)。
核查日期：2026-10-30。

## 代码基线与运行

- 当前分支 `develop`，HEAD 与本地 `origin/develop` 均为
  `0fa1077b9ac4329639f75a881694ddebb23e003b`。未拉取远端，不能据此认定已同步远端最新提交。
- MCP workspace 版本 `2.17.0`；Node 22+、pnpm 12.16.1。
- `mcp/packages/server/src/PenpotMcpServer.ts`：工具注册、HTTP、请求级身份上下文。
- `mcp/packages/server/src/PluginBridge.ts`：按用户和 sessionId 路由插件任务。
- `mcp/packages/plugin/src/main.ts`：插件 UI、WebSocket 连接和元数据。
- `mcp/packages/plugin/src/plugin.ts`：插件任务分派。
- `mcp/packages/plugin/src/PenpotUtils.ts`：图层树及布局信息等辅助方法。
- `plugins/libs/plugin-types/index.d.ts`：Plugin API 类型，运行时由前端实现。

在 `mcp/` 中执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter mcp-common run build
pnpm run build
pnpm run start
```

本地默认 Streamable HTTP：`http://localhost:4401/mcp`；WebSocket：4402；
REPL：4403。独立插件安装和启动见同目录 README。
集成开发环境通过 `./manage.sh run-devenv --agentic` 启动，浏览器使用
`https://localhost:3449`，插件走同源 `/mcp/ws`。
新增工具需要同时更新 Server 和 Plugin；只更新其中一端不能运行。

## 现有能力

| 能力 | 代码与结论 |
| --- | --- |
| 指导与类型查询 | `high_level_overview`、`penpot_api_info` |
| 页面和选区 | `execute_code` 可读 `penpot.currentFile/currentPage/selection` |
| 图层结构 | `PenpotUtils.shapeStructure(shape, maxDepth)`，已有深度控制，但没有节点总数限制 |
| 视觉预览 | `export_shape`，可导出页面、选区或图层 |
| 创建修改 | `execute_code` 调用 Plugin API；权限来自插件，不是生产 Agent 的工具白名单 |
| 条件工具 | `import_image` 受文件访问配置限制；`submit_feedback` 需后端 URI；开发工具受开发/多用户模式限制 |
| 多会话隔离 | PluginBridge 按用户令牌查找会话；多会话不明确时拒绝猜测；不存在的会话不能访问 |

`execute_code` 使用 `new Function`，因此 PoC 不向模型暴露该工具。

## 新增只读工具

`get_current_design_context({fileId, pageId, sessionId?})`：

- 输入、输出 Zod Schema：`packages/common/src/DesignContext.ts`。
- 固定插件任务 `getDesignContext`；不接收、拼接或执行模型代码。
- 权限：`content:read`；无设计写操作、无 undo 事务。
- 文件、页面必须与宿主绑定值相符；页面切换后失败，不返回新页面内容。
- 选区通过当前页 `getShapeById` 核对；不读取文件里的其他页面。
- 最多 120 个对象，先收集最多 40 个选中对象，再收集最多 6 层的页面树。
  `parentId` 表示层级，`childrenTruncated` 表示未返回的子节点。
- 名称等字符串最多 160 字符，单图层文本最多 500 字符，填充最多 3 项。
- 返回文件修订号、选区原始数量、`truncated`、`textTruncated`。
- 只提供基础几何、纯色填充和文字属性。渐变、图片、描边、混合文字范围、
  设计 Tokens 和视觉判断尚未纳入快照，不能把缺失值当成不存在。
- Plugin API 的填充字段可能返回 `null`；已转换为缺失值并添加回归测试。
- 无连接、多会话未指定、权限不足、范围不符和 Schema 错误均失败。
  现有 MCP Tool 基类会把异常包装为文本；PoC 拒绝把非 JSON 文本当成快照。

## 最小问答 PoC

`packages/agent-poc` 使用 Vercel AI SDK Core，CLI 是 Phase 0 的验证入口。
它不是 Phase 1 的原生聊天面板。

```powershell
# 在 mcp 目录运行。凭据只放本机环境，勿写入源码或设计文件。
$env:PENPOT_MCP_URL = 'http://localhost:4401/mcp'
$env:PENPOT_FILE_ID = '从当前设计 URL 的 file-id 获取'
$env:PENPOT_PAGE_ID = '从当前设计 URL 的 page-id 获取'
# 多用户 MCP 使用既有连接对应的令牌；多会话时必须指定目标 sessionId。
# $env:PENPOT_MCP_TOKEN = ...
# $env:PENPOT_SESSION_ID = ...

# 不需要模型密钥，先核对真实页面和选区。
pnpm --filter penpot-agent-poc ask --context

# 模型必须支持 Chat Completions Tool Calling。
$env:AI_MODEL = '服务支持的模型名'
# $env:OPENAI_API_KEY = ...
# $env:OPENAI_BASE_URL = '服务的 /v1 URL' # 可选
pnpm --filter penpot-agent-poc ask '当前选中的图层是什么？它的尺寸、文字和填充色是什么？'
```

OpenCode Go 可复用本机已有凭据，不必复制 Key：

```powershell
$env:AI_MODEL = 'glm-5.3-flash'
$env:OPENAI_BASE_URL = 'https://opencode.ai/inference/go/openai/v1'
$env:OPENCODE_AUTH_FILE = "$env:USERPROFILE/.local/share/opencode/auth.json"
```

也可将包内 `.env.example` 复制为 `.env.local`，填写本机路径、目标范围及 MCP 配置，
执行 `pnpm --filter penpot-agent-poc ask:local '问题'`。`.env.local` 已加入忽略规则。
Provider 使用 `@ai-sdk/openai-compatible`，请求带独立 User-Agent 和同次对话稳定的
`x-opencode-session`，遵循 [Go 接入说明](https://opencode.ai/v2/docs/console/go/)。

Agent 第一步必须调用唯一的只读工具，第二步禁止继续调用工具并生成答案。
模型无法选择其他文件、页面、会话或传入代码。回答包含原始快照及
`citedShapeIds`；引用格式为 `[名称](penpot-shape:ID)`，CLI 只展示引用，
不会自动跳转或选中画布对象。缺失引用、引用不存在的对象、读取失败和空回答均报错。
此校验能检查引用存在性，不能保证模型对每个属性的解释正确；真实模型仍需人工对照快照验收。

模型 Key 只在 Node 进程读取。远程 MCP 要求 HTTPS，令牌放请求头，
URL 禁止携带凭据和查询参数。CLI 不输出 SDK 原始异常，避免回显请求凭据。
不会持久化聊天或设计内容；成功时终端会显示当前问题对应的设计快照。

## 原生 UI、通信及鉴权边界

- 后续 UI 挂载点：`frontend/src/app/main/ui/workspace.cljs` 的 `workspace-content*`，
  已向 `sidebar*` 传入 `file/page-id/selected`；入口与布局可接入
  `frontend/src/app/main/ui/workspace/sidebar.cljs`。使用现有 Rumext 组件和状态事件。
- 建议后续浏览器经同源后端接口请求 Agent，由后端绑定登录用户、文件权限、
  当前页面和 MCP 会话，再由 Agent 调用 MCP HTTP，PluginBridge 经 WebSocket 调用插件。
  这是接入建议，本次没有新增生产 HTTP 路由或浏览器鉴权协议。
- 现有 MCP 多用户令牌用于匹配已登录 Penpot 建立的插件连接；普通模式下不是每次请求
  都向后端重新验证令牌。不可把此机制直接等同于原生 Agent 的完整鉴权。
- 现有 `execute_code` 仍对原有 MCP 客户端开放。本次白名单限制在 PoC 模型工具集合内，
  没有把整个 MCP 服务改为只读。生产隔离仍需限制 Agent 凭据的工具权限。
- Key、用户身份和会话选择由服务端持有，不由模型或浏览器任意指定。
- 撤销/重做和事务恢复尚未验证，不能承诺自动回滚。

## 实测与验收记录

真实读取目标为用户提供的 SaaS 文件 `ChipTest运控`，当前页 `Chip运动控制界面原型`：

- fileId：`61fd668e-ca9f-8100-8008-dc9de40701ad`。
- pageId：`61fd668e-ca9f-8100-8008-dc9de40701ae`。
- 选中画板：`主界面 · 料盒展开`，ID `cef51e24-553f-8073-8008-dd12a82ef0ef`。
- 尺寸 `1426 × 893`，位置 `(0, 0)`，基础填充 `#eef3f8`。
- 新增 Reader 已编译后通过开发用 `execute_code` 在真实 Plugin API 上运行：
  返回 120 个对象、`truncated=true`；选区和文字 `ChipTest主控系统` 均与画布相符。
  这是同一 Reader 的现场核查，不代表 SaaS 已部署新的 MCP 工具。
- 有界快照只包含部分页面，不能据其统计全部对象。首次包含整个 Zod 的调试 bundle
  被 SaaS 以 HTTP 413 拒绝；改用只含 Reader 的小 bundle 核查成功。
- 自动测试覆盖真实 AI SDK 循环（模型用 SDK 测试替身）、HTTP→WebSocket 固定任务、
  用户会话隔离、文件/页面范围、空选区、节点/深度/文本上限和填充 null。
- 真实模型联调已成功：从 SaaS MCP 采集上述页面快照，再通过 PoC 的唯一只读工具
  交给 OpenCode Go `glm-5.3-flash`。模型正确回答选中画板的名称、尺寸与填充色，
  以及“开始”按钮背景 `#21a366`、文字 `#ffffff`，引用了 4 个真实图层 ID，
  并说明 `truncated=true`。Key 直接从本机已有 OpenCode 凭据文件在内存读取。
  这是“真实画布快照 → AI SDK Tool Calling → 真实模型”的验证；新的固定 MCP 工具
  HTTP→WebSocket 链路另由自动集成测试验证，尚未将新 Server/Plugin 部署到 SaaS。
- 已验证临时矩形创建、回读及清理：尺寸 16×16、颜色 `#123456`，位于画布外；
  删除后临时对象剩余 0，顶层图层 ID 列表与选区保持一致。首次清理后回读访问了
  已删除代理的空 ID，报 UUID 错误；改为删除前保存 ID 后复测通过。
  此操作验证基础写能力；没有验证 undo/redo，也不等于撤销事务。

SaaS 与本机开发环境相互独立。现场 `localhost:3449` 的 502 原因为容器重启后
后端和前端进程未启动。已在原 WSL checkout 的 tmux 中启动后端及 frontend watch，
并修正 `/opt/cargo/registry` 缓存归属。后端 profile 接口恢复 200，前端 main/worker
编译 0 警告、0 错误，浏览器已重新显示项目列表。
WSL checkout 与 Windows 工作区不是同一目录；本次新增代码仍在 Windows 工作区，
没有覆盖 WSL 的源码。

验证命令（在 mcp 目录）：

最终结果：Plugin 42、Server 103、Agent PoC 5，共 150 个测试通过；
全部包的 TypeScript 检查和 MCP Prettier 检查通过。

```sh
pnpm --filter mcp-common run build
pnpm -r run types:check
pnpm run test
pnpm run fmt:check
```

测试日志应先重定向到文件，再读取，不能直接管道过滤。

SDK 接口已通过 Context7 核对，参考
[AI SDK Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)。
