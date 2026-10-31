import { z } from "zod";

const label = z.string().trim().min(1).max(160);
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const dimension = z.number().min(1).max(10000);

/** 独立于画布数据模型的有界布局树；parent 引用逻辑节点，不引用 Penpot 对象。 */
export const layoutNodeSchema = z
    .object({
        key,
        parent: key.optional(),
        type: z.enum(["container", "text", "shape", "image_placeholder", "component"]),
        name: label,
        width: dimension,
        height: dimension,
        x: z.number().min(0).max(10000).optional(),
        y: z.number().min(0).max(10000).optional(),
        direction: z.enum(["absolute", "row", "column"]).optional(),
        padding: z.number().min(0).max(1000).optional(),
        gap: z.number().min(0).max(1000).optional(),
        align: z.enum(["start", "center", "end"]).optional(),
        color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .optional(),
        opacity: z.number().min(0).max(1).optional(),
        colorToken: z.string().max(160).optional(),
        typographyToken: z.string().max(160).optional(),
        componentId: z.string().max(160).optional(),
        text: z.string().min(1).max(4000).optional(),
        fontFamily: label.optional(),
        fontSize: z.number().min(1).max(1000).optional(),
        borderRadius: z.number().min(0).max(1000).optional(),
    })
    .strict();

export const pageLayoutSchema = z
    .object({
        title: label,
        pageType: z.enum(["dashboard", "login", "list", "detail", "form", "other"]),
        goal: z.string().trim().min(1).max(500),
        roles: z.array(label).min(1).max(8),
        interactions: z.array(z.string().min(1).max(300)).max(16),
        style: label,
        assumptions: z.array(z.string().min(1).max(300)).max(12),
        width: dimension,
        height: dimension,
        nodes: z.array(layoutNodeSchema).min(1).max(120),
    })
    .strict()
    .superRefine((page, ctx) => {
        const nodes = new Map(page.nodes.map((n) => [n.key, n]));
        const fail = (message: string) => ctx.addIssue({ code: "custom", message });
        if (nodes.size !== page.nodes.length) {
            fail("节点 key 重复。");
        }
        const roots = page.nodes.filter((n) => !n.parent);
        if (
            roots.length !== 1 ||
            roots[0].type !== "container" ||
            roots[0].width !== page.width ||
            roots[0].height !== page.height
        ) {
            fail("必须有一个与页面尺寸相同的根容器。");
        }
        for (const node of page.nodes) {
            if (node.type === "text" && !node.text) {
                fail("文本节点缺少内容。");
            }
            if (node.type === "component" && !node.componentId) {
                fail("组件节点缺少组件引用。");
            }
            if (node.type !== "container" && page.nodes.some((n) => n.parent === node.key)) {
                fail("仅容器可包含子节点。");
            }
            const visited = new Set([node.key]);
            let parent = node.parent;
            while (parent) {
                if (!nodes.has(parent) || visited.has(parent) || visited.size >= 6) {
                    fail("父节点缺失、循环引用或层级超过六层。");
                    break;
                }
                visited.add(parent);
                parent = nodes.get(parent)!.parent;
            }
        }
    });

export const qualityIssueSchema = z.object({
    code: z.enum(["overflow", "overlap", "alignment", "style"]),
    message: z.string().max(500),
    nodeKeys: z.array(key).max(120),
    shapeIds: z.array(z.string()).max(120).optional(),
});
export const generationSummarySchema = z.object({
    title: label,
    pageType: label,
    goal: z.string().max(500),
    roles: z.array(label).max(8),
    interactions: z.array(z.string().max(300)).max(16),
    style: label,
    width: dimension,
    height: dimension,
    sections: z.array(z.object({ key, parent: key.optional(), name: label, type: label })).max(120),
    warnings: z.array(z.string().max(500)).max(30),
    issues: z.array(qualityIssueSchema).max(120),
});
export type PageLayout = z.infer<typeof pageLayoutSchema>;
export type LayoutNode = z.infer<typeof layoutNodeSchema>;
export type GenerationSummary = z.infer<typeof generationSummarySchema>;
export type QualityIssue = z.infer<typeof qualityIssueSchema>;
