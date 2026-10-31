import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
    prepareDesignPlanSchema,
    executeDesignPlanSchema,
    designPlanSchema,
    designExecutionSchema,
    type PluginTaskResult,
} from "@penpot/mcp-common";
import { Tool } from "../Tool";
import { PluginTask } from "../PluginTask";
import { TextResponse, type ToolResponse } from "../ToolResponse";
import type { PenpotMcpServer } from "../PenpotMcpServer";

/** 固定数据通道；模型仅使用规划工具，执行入口由原生面板确认请求持有。 */
export class DesignPlanTool extends Tool<{ sessionId: string; input: unknown }> {
    get permission(): "read" | "write" {
        return this.action === "prepare" ? "read" : "write";
    }
    constructor(
        server: PenpotMcpServer,
        private readonly action: "prepare" | "execute" | "cancel"
    ) {
        super(server, {
            sessionId: z.string().min(1).max(128),
            input: action === "prepare" ? prepareDesignPlanSchema : executeDesignPlanSchema,
        });
    }

    getToolName(): string {
        return { prepare: "prepare_design_plan", execute: "execute_design_plan", cancel: "cancel_design_plan" }[
            this.action
        ];
    }
    getToolDescription(): string {
        if (this.action === "cancel") {
            return "取消：使当前会话内的预览计划失效，无画布副作用。";
        }
        return this.action === "prepare"
            ? "只读：生成固定工具计划与对象属性预览，不修改画布。"
            : "写入：仅执行当前会话内已预览且经用户确认的计划，回读校验并返回逐步结果。";
    }
    protected formatArgs(): string {
        return "<设计计划参数已隐藏>";
    }

    protected async executeCore(args: { sessionId: string; input: unknown }): Promise<ToolResponse> {
        const sessionId = z.string().min(1).max(128).parse(args.sessionId);
        const input = (this.action === "prepare" ? prepareDesignPlanSchema : executeDesignPlanSchema).parse(args.input);
        const result = (await this.mcpServer.pluginBridge.executePluginTask(
            new PluginTask("designEdit", {
                action: this.action,
                input: this.action === "prepare" ? { ...input, planId: randomUUID() } : input,
            }),
            sessionId
        )) as PluginTaskResult<unknown>;
        const data = (
            this.action === "prepare"
                ? designPlanSchema
                : this.action === "execute"
                  ? designExecutionSchema
                  : z.object({ status: z.literal("cancelled") })
        ).parse(result.data);
        return new TextResponse(JSON.stringify(data));
    }
}
