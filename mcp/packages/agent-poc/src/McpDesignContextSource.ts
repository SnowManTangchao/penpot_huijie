import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
    designContextSchema,
    designPlanSchema,
    designExecutionSchema,
    type DesignContextInput,
    type EditScope,
    type DesignOperation,
} from "@penpot/mcp-common";
import type { DesignContextSource } from "./DesignQuestionAgent";
import { AgentError } from "./AgentError";

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

    private async edit(name: string, input: unknown) {
        const response = await this.client.callTool({ name, arguments: { sessionId: this.sessionId, input } });
        const content = response.content.find((item) => item.type === "text");
        if (response.isError || !content || content.type !== "text") {
            throw new Error("设计工具调用失败。");
        }
        try {
            return JSON.parse(content.text);
        } catch {
            if (
                name === "prepare_design_plan" &&
                content.text.includes('"tool"') &&
                (content.text.includes("No matching discriminator") ||
                    content.text.includes("Invalid discriminator value"))
            ) {
                throw new AgentError(
                    "编辑器插件版本过旧，不支持本次操作。请刷新当前 Penpot 编辑器页面并重新连接，再重新提问；尚未修改画布。"
                );
            }
            const reasons = [
                "文件、页面或选区已改变，请重新生成计划。",
                "目标对象已修改，请重新生成计划。",
                "上下文已改变，计划已失效。",
                "目标已锁定、隐藏或类型不符。",
                "目标已删除或不属于当前页面。",
                "计划已失效，请重新生成。",
                "计划正在执行，请勿重复确认。",
                "计划范围不符。",
            ];
            throw new AgentError(
                reasons.find((reason) => content.text.includes(reason)) ??
                    "计划已失效或设计工具拒绝操作，请重新生成计划。"
            );
        }
    }

    async prepare(scope: EditScope, operations: DesignOperation[]) {
        return designPlanSchema.parse(await this.edit("prepare_design_plan", { ...scope, operations }));
    }

    async execute(scope: EditScope, planId: string) {
        return designExecutionSchema.parse(await this.edit("execute_design_plan", { ...scope, planId }));
    }

    async cancel(scope: EditScope, planId: string) {
        await this.edit("cancel_design_plan", { ...scope, planId });
    }
}
