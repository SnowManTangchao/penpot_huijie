import { z } from "zod";
import {
    editScopeSchema,
    pngImageSchema,
    pageLayoutSchema,
    imageGenerationSchema,
    type DesignContext,
    type DesignOperation,
} from "@penpot/mcp-common";
import { AdvancedDesignService } from "./AdvancedDesignService";
import { CodeExporter, HtmlCodeAdapter, ReactCodeAdapter } from "./CodeExporter";
import { LayoutPlanner } from "./LayoutPlanner";
import { AgentError } from "./AgentError";
import type { LanguageModel } from "ai";

export const advancedRequestSchema = z
    .object({
        ...editScopeSchema.shape,
        sessionId: z.string().min(1).max(128),
        action: z.discriminatedUnion("type", [
            z
                .object({
                    type: z.literal("analyze"),
                    model: z.string().min(1).max(160),
                    image: pngImageSchema,
                    prompt: z.string().max(4000),
                })
                .strict(),
            z.object({ type: z.literal("prepare-layout"), layout: pageLayoutSchema }).strict(),
            z.object({ type: z.literal("generate-image"), request: imageGenerationSchema }).strict(),
            z.object({ type: z.literal("prepare-image"), imageId: z.string().uuid(), replace: z.boolean() }).strict(),
            z
                .object({
                    type: z.literal("export-code"),
                    target: z.enum(["html-css", "react-css"]),
                    layout: pageLayoutSchema.optional(),
                })
                .strict(),
        ]),
    })
    .strict();

/** 高级能力的只读规划入口；写入仍交给现有不可变计划与确认通道。 */
export class AdvancedDesignRequest {
    constructor(private readonly service: AdvancedDesignService) {}
    async run(
        input: z.infer<typeof advancedRequestSchema>,
        owner: string,
        context: DesignContext,
        models: Map<string, LanguageModel>,
        signal: AbortSignal
    ) {
        const scope = editScopeSchema.parse({
            fileId: input.fileId,
            pageId: input.pageId,
            selectedIds: input.selectedIds,
            selectionCount: input.selectionCount,
        });
        if (
            context.file.id !== scope.fileId ||
            context.page.id !== scope.pageId ||
            context.selectionCount !== scope.selectionCount ||
            [...context.selectedIds].sort().join() !== [...scope.selectedIds].sort().join()
        ) {
            throw new AgentError("页面或选区已改变，请重新操作。");
        }
        const action = input.action;
        const binding = `${scope.fileId}/${scope.pageId}`;
        if (action.type === "analyze") {
            const model = models.get(action.model);
            if (!model) {
                throw new AgentError("所选视觉模型未配置。");
            }
            return this.service.analyze(model, action.image, action.prompt, signal);
        }
        if (action.type === "generate-image") {
            return this.service.generate(owner, input.sessionId, binding, action.request, signal);
        }
        if (action.type === "export-code") {
            const exporter = new CodeExporter([new HtmlCodeAdapter(), new ReactCodeAdapter()]);
            return exporter.export(action.target, action.layout ?? exporter.fromContext(context));
        }
        if (action.type === "prepare-layout") {
            return new LayoutPlanner().compile(action.layout, context);
        }
        const image = this.service.getImage(owner, input.sessionId, binding, action.imageId);
        let operation: DesignOperation;
        if (action.replace) {
            const target = context.shapes.find((s) => s.id === scope.selectedIds[0]);
            if (scope.selectionCount !== 1 || target?.type !== "rectangle" || !target.hasImage) {
                throw new AgentError("请选中一个已有图片填充的矩形，替换将保留其 ID、位置、尺寸和层级。");
            }
            operation = { tool: "set_image", shapeId: target.id, image };
        } else {
            const x = context.shapes.length ? Math.max(...context.shapes.map((s) => s.x + s.width)) + 80 : 0;
            operation = {
                tool: "create_image",
                name: "AI 图片",
                x,
                y: 0,
                width: image.width,
                height: image.height,
                image,
            };
        }
        return { operations: [operation] };
    }
}
