import { z } from "zod";

/** 只读上下文的范围由调用方绑定，不接受模型生成的代码。 */
export const designContextInputSchema = z.object({
    fileId: z.string().uuid(),
    pageId: z.string().uuid(),
});

const label = z.string().max(160);
export const designShapeSchema = z.object({
    id: z.string(),
    name: label,
    type: label,
    parentId: z.string().nullable(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    hidden: z.boolean(),
    text: z.string().max(500).optional(),
    textTruncated: z.boolean().optional(),
    fontFamily: label.optional(),
    fontSize: label.optional(),
    fills: z.array(z.object({ color: label.optional(), opacity: z.number().optional() })).max(3),
    childrenTruncated: z.boolean(),
});

export const designContextSchema = z.object({
    file: z.object({ id: z.string(), name: label, revision: z.number() }),
    page: z.object({ id: z.string(), name: label }),
    selectedIds: z.array(z.string()).max(40),
    selectionCount: z.number().int().nonnegative(),
    shapes: z.array(designShapeSchema).max(120),
    truncated: z.boolean(),
});

export type DesignContextInput = z.infer<typeof designContextInputSchema>;
export type DesignContext = z.infer<typeof designContextSchema>;
export type DesignShape = z.infer<typeof designShapeSchema>;
