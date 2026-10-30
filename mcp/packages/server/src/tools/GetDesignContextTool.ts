import {
    designContextInputSchema,
    designContextSchema,
    type DesignContext,
    type DesignContextInput,
} from "@penpot/mcp-common";
import type { PluginTaskResult } from "@penpot/mcp-common";
import { Tool } from "../Tool";
import { PluginTask } from "../PluginTask";
import { TextResponse, type ToolResponse } from "../ToolResponse";
import type { PenpotMcpServer } from "../PenpotMcpServer";

class DesignContextTask extends PluginTask<DesignContextInput, PluginTaskResult<DesignContext>> {
    constructor(input: DesignContextInput) {
        super("getDesignContext", input);
    }
}

/** 读取指定会话当前页面的有界快照，无副作用，只需 content:read。 */
export class GetDesignContextTool extends Tool<DesignContextInput & { sessionId?: string }> {
    constructor(server: PenpotMcpServer) {
        super(server, { ...designContextInputSchema.shape, sessionId: Tool.SESSION_ID_SCHEMA });
    }

    getToolName(): string {
        return "get_current_design_context";
    }

    getToolDescription(): string {
        return (
            "只读：获取当前文件、页面、选中图层及图层树（parentId 表示层级）。" +
            "必须绑定 fileId/pageId；页面切换时拒绝读取。最多 120 个图层、40 个选中对象、6 层深度，" +
            "文本最多 500 字符。truncated 表示页面或选区不完整。无写操作，不返回其他页面。"
        );
    }

    protected async executeCore(args: DesignContextInput & { sessionId?: string }): Promise<ToolResponse> {
        const input = designContextInputSchema.parse(args);
        const result = await this.mcpServer.pluginBridge.executePluginTask(
            new DesignContextTask(input),
            args.sessionId
        );
        const context = designContextSchema.parse(result.data);
        if (context.file.id !== input.fileId || context.page.id !== input.pageId) {
            throw new Error("上下文范围与请求不符。");
        }
        return new TextResponse(JSON.stringify(context));
    }
}
