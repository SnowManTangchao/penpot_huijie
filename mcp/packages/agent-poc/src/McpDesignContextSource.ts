import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { designContextSchema, type DesignContextInput } from "@penpot/mcp-common";
import type { DesignContextSource } from "./DesignQuestionAgent";

/** 只调用固定 MCP 工具；范围、会话与凭据不交给模型选择。 */
export class McpDesignContextSource implements DesignContextSource {
    private readonly client = new Client({ name: "penpot-agent-poc", version: "0.1.0" });

    constructor(
        private readonly scope: DesignContextInput,
        private readonly sessionId?: string
    ) {}

    async connect(url: URL, token?: string): Promise<void> {
        if (url.username || url.password || url.search || url.hash) {
            throw new Error("MCP URL 不应包含凭据、查询参数或片段，请使用 PENPOT_MCP_TOKEN。");
        }
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
            throw new Error("远程 MCP 必须使用 HTTPS。");
        }
        await this.client.connect(
            new StreamableHTTPClientTransport(url, {
                requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
            })
        );
    }

    async read() {
        const response = await this.client.callTool({
            name: "get_current_design_context",
            arguments: { ...this.scope, ...(this.sessionId ? { sessionId: this.sessionId } : {}) },
        });
        const text = response.content.find((item) => item.type === "text");
        if (response.isError || !text || text.type !== "text") {
            throw new Error("MCP 上下文工具失败。");
        }
        let data: unknown;
        try {
            data = JSON.parse(text.text);
        } catch {
            throw new Error("MCP 未返回设计快照，请检查插件版本、连接及文件/页面范围。");
        }
        const context = designContextSchema.parse(data);
        if (context.file.id !== this.scope.fileId || context.page.id !== this.scope.pageId) {
            throw new Error("MCP 返回了范围以外的上下文。");
        }
        return context;
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}
