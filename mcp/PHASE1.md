# 原生 AI 设计助手：Phase 1

来源：[Notion MVP 任务 TK-41](https://app.notion.com/p/4091a252e21181a7b809f5e1d38c8125)。
验收日期：2026-10-30。

## 实现范围

- 编辑器右侧 AI 面板，复用 Penpot 原生按钮、下拉框、排版及明暗主题颜色。
- 同源 `/api/agent/config` 和 `/api/agent/chat`，服务端模型白名单及 NDJSON 流式事件。
- 每次请求使用登录 Cookie 向 Penpot 后端核验账号及文件读权限。
- 仅在服务端取得当前账号的 MCP 令牌，绑定编辑器 sessionId、fileId、pageId。
- MCP `/mcp/agent` 仅注册 `get_current_design_context`，拒绝单用户模式和缺少 Bearer 的请求。
- 模型工具包含当前文件、当前页面、选区及有界图层树的只读查询，不提供代码执行工具。
- 每轮读取真实快照，限制 120 个图层、40 个选中对象及 6 层树深度；明确展示截断情况。
- 回答必须引用已读取的图层，最终引用校验失败时清除临时回答；支持点击引用选中并缩放到图层。
- 支持停止生成、新对话、连续追问及连接和服务错误提示。

API 密钥仅由 Node 服务读取，不写入浏览器、插件或设计文件。聊天不持久化到数据库。
本阶段不提供画布写工具，不承诺撤销、事务回滚、视觉理解或设计 Tokens 读取。

## 本机启动

Windows 工作区和 WSL 开发 checkout 独立。运行中的服务需要使用对应 checkout 的源代码，
同时更新 MCP Server 与 Plugin。

在开发容器中配置前端 `frontend/resources/public/js/config.js`（忽略文件）：

```javascript
globalThis.penpotFlags = "enable-mcp";
```

如已有配置，应保留原配置并加入该开关。随后刷新浏览器。
在本机 Penpot「设置 → 集成」启用 MCP，并配置账号令牌；返回 AI 面板连接编辑器。
原生助手目前复用现有 MCP 账号集成，首次启用该集成是必要前置条件。

在 `mcp/` 安装依赖并构建：

```sh
pnpm install --frozen-lockfile
pnpm --filter mcp-common run build
pnpm --filter mcp-server run build
pnpm --filter mcp-plugin run build
pnpm --filter mcp-server run start:multi-user
```

另一个终端中，在 `mcp/packages/agent-poc` 基于 `.env.example` 配置 `.env.local` 后执行：

```sh
pnpm run serve:local
```

配置 `PENPOT_AGENT_ORIGIN` 为浏览器实际站点来源；使用服务端 `AI_MODEL` 或逗号分隔的
`AI_MODELS`，以及 `OPENAI_API_KEY` 或现有 OpenCode Go 凭据文件。
浏览器不能提交任意 Provider URL 或 API 密钥。示例文件包含本机端口配置。

开发代理已增加 `/api/agent/` 到 4404 的路由，关闭代理缓存和响应缓冲。
已有运行中的开发容器需要更新 nginx 配置并校验、重新加载；仅修改仓库文件不更新容器内已复制的配置。
生产部署仍需自行配置同源代理、进程管理和服务端凭据。

修改面板后需确认 SCSS 构建和 ClojureScript 编译均成功。
样式构建失败会导致新面板使用浏览器默认控件及错误的继承颜色。

## 真实验收

本机 `https://localhost:3449`，文件「新建文件 1」，页面「Page 1」。
当前选中 Rectangle（`c086f573-5869-80fd-8008-de85da16d35a`）。

1. 浏览器原生面板 → 同源 Agent → Penpot 登录及文件授权 → 多用户只读 MCP →
   WebSocket Plugin → 当前页面读取 → GLM 模型流式回答，整条链路实际通过。
2. 回答为填充色 `#B1B2B5`、不透明度 1、尺寸 `149 × 215`、位置约 `(484, 189)`。
   已在独立打开的同一文件属性面板逐项对照，结果一致。
3. 清除选区后点击回答中的「定位图层」，真实 Rectangle 重新选中并缩放到视口。
4. 连续追问宽高比，模型引用同一图层并回答 `149:215 ≈ 0.693`。
5. 会话范围、跨用户访问、虚构引用和过期令牌由自动测试覆盖；未对真实账号做越权修改测试。

联调修复了三个会阻止首次发送的问题：

- 本机前端配置缺失，MCP 控制器未初始化，原连接按钮无实际作用。
- 默认模型初始化读取了 React 状态更新前的旧值，发送回调也捕获了旧草稿。
- 后端 JSON 接口使用 camelCase，账号属性和令牌有效期应读取 `mcpEnabled`、`expiresAt`。

另修复侧栏选区参数传递，并保留服务端安全错误消息供面板展示。

## 验证

- Agent 自动测试：10 项通过，覆盖真实 AI SDK 流程、引用校验、登录与文件权限、实际 JSON 字段及过期令牌。
- 前端状态测试：5 项、16 个断言通过。
- MCP Server 全量测试：105 项通过，其中只读入口的 5 项集成测试覆盖 HTTP → WebSocket、工具白名单及用户隔离。
- 编辑器主程序编译：0 警告；相关 CLJS lint、SCSS lint 及格式检查通过。
- 整个前端测试包仍有已有测试文件的类型推断警告；本次新增模块编译无警告。
