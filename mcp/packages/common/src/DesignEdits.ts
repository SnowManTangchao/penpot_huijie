import { z } from "zod";
import { generationSummarySchema, qualityIssueSchema } from "./LayoutTree.ts";

const coordinate = z.number().min(-100000).max(100000);
const dimension = z.number().min(0.01).max(100000);
const bounds = { x: coordinate, y: coordinate, width: dimension, height: dimension };
const fill = {
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    opacity: z.number().min(0).max(1),
    colorRef: z.string().max(160).optional(),
};
const reference = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const creation = {
    name: z.string().trim().min(1).max(160),
    ...bounds,
    ...fill,
    ref: reference.optional(),
    parentRef: reference.optional(),
};
const target = { shapeId: z.string().uuid() };
const radius = z.number().min(0).max(100000);

/** 固定写工具只描述数据；模型不接触执行权限、会话或代码。 */
export const designOperations = {
    create_rectangle: z
        .object({ tool: z.literal("create_rectangle"), ...creation, borderRadius: radius.optional() })
        .strict(),
    create_text: z
        .object({
            tool: z.literal("create_text"),
            ...creation,
            text: z.string().min(1).max(4000),
            fontFamily: z.string().trim().min(1).max(160),
            fontSize: z.number().min(1).max(1000),
            typographyRef: z.string().max(160).optional(),
        })
        .strict(),
    create_frame: z.object({ tool: z.literal("create_frame"), ...creation }).strict(),
    create_component: z
        .object({
            tool: z.literal("create_component"),
            name: creation.name,
            ...bounds,
            ref: reference.optional(),
            parentRef: reference.optional(),
            componentId: z.string().min(1).max(160),
        })
        .strict(),
    set_text: z.object({ tool: z.literal("set_text"), ...target, text: z.string().max(4000) }).strict(),
    set_fill: z.object({ tool: z.literal("set_fill"), ...target, ...fill }).strict(),
    set_bounds: z.object({ tool: z.literal("set_bounds"), ...target, ...bounds }).strict(),
    set_corner_radius: z.object({ tool: z.literal("set_corner_radius"), ...target, borderRadius: radius }).strict(),
};
export const designOperationSchema = z.discriminatedUnion("tool", [
    designOperations.create_rectangle,
    designOperations.create_text,
    designOperations.create_frame,
    designOperations.create_component,
    designOperations.set_text,
    designOperations.set_fill,
    designOperations.set_bounds,
    designOperations.set_corner_radius,
]);
export const editScopeSchema = z
    .object({
        fileId: z.string().uuid(),
        pageId: z.string().uuid(),
        selectedIds: z.array(z.string().uuid()).max(40),
        selectionCount: z.number().int().min(0).max(40),
    })
    .strict()
    .refine(
        (s) => s.selectionCount === s.selectedIds.length && new Set(s.selectedIds).size === s.selectedIds.length,
        "选区不完整，请缩小选区后重试。"
    );
export const prepareDesignPlanSchema = z
    .object({
        ...editScopeSchema.shape,
        operations: z.array(designOperationSchema).min(1).max(120),
        generation: generationSummarySchema.optional(),
    })
    .strict();
export const executeDesignPlanSchema = z
    .object({
        ...editScopeSchema.shape,
        planId: z.string().uuid(),
        batchIndex: z.number().int().min(0).max(11).optional(),
    })
    .strict();

const snapshotSchema = z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    parentId: z.string().nullable(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    hidden: z.boolean(),
    blocked: z.boolean(),
    fills: z.array(z.record(z.string(), z.unknown())),
    text: z.string().optional(),
    fontFamily: z.string().optional(),
    fontSize: z.string().optional(),
    cornerRadii: z.tuple([radius, radius, radius, radius]).optional(),
});
export const designPlanSchema = z.object({
    id: z.string().uuid(),
    expiresAt: z.number(),
    outsideSelection: z.boolean(),
    operations: z.array(designOperationSchema).min(1).max(120),
    targets: z.array(snapshotSchema).max(120),
    generation: generationSummarySchema.optional(),
});
export const designExecutionSchema = z.object({
    planId: z.string().uuid(),
    status: z.enum(["success", "partial", "failed"]),
    steps: z
        .array(
            z.object({
                tool: z.string(),
                status: z.enum(["success", "failed", "skipped"]),
                shapeId: z.string().optional(),
                before: snapshotSchema.nullable().optional(),
                after: snapshotSchema.nullable().optional(),
                message: z.string().optional(),
            })
        )
        .max(120),
    batches: z
        .array(
            z.object({
                index: z.number().int(),
                shapeIds: z.array(z.string()).max(10),
                status: z.enum(["success", "partial", "failed"]),
            })
        )
        .max(12)
        .optional(),
    issues: z.array(qualityIssueSchema).max(120).optional(),
    cancelled: z.boolean().optional(),
    hasMore: z.boolean().optional(),
    message: z.string().max(500).optional(),
});
export type DesignOperation = z.infer<typeof designOperationSchema>;
export type EditScope = z.infer<typeof editScopeSchema>;
export type DesignPlan = z.infer<typeof designPlanSchema>;
export type DesignExecution = z.infer<typeof designExecutionSchema>;
export type EditSnapshot = z.infer<typeof snapshotSchema>;
