import { z } from "zod";
import { pageLayoutSchema } from "./LayoutTree.ts";

/** 仅接受有界 PNG 字节，不接受 URL、SVG 或可执行资源。 */
export const pngImageSchema = z
    .object({
        data: z
            .string()
            .min(32)
            .max(2_800_000)
            .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        width: z.number().int().min(1).max(4096),
        height: z.number().int().min(1).max(4096),
    })
    .strict()
    .superRefine((image, ctx) => {
        try {
            const bytes = (globalThis as unknown as { atob(value: string): string }).atob(image.data);
            const number = (offset: number) =>
                Array.from(bytes.slice(offset, offset + 4)).reduce((n, c) => n * 256 + c.charCodeAt(0), 0);
            if (
                !bytes.startsWith("\x89PNG\r\n\x1a\n") ||
                bytes.slice(12, 16) !== "IHDR" ||
                number(16) !== image.width ||
                number(20) !== image.height ||
                image.data.length % 4 !== 0
            ) {
                throw new Error("PNG");
            }
        } catch {
            ctx.addIssue({ code: "custom", message: "PNG 文件头或尺寸无效。" });
        }
    });

export const visualAnalysisSchema = z
    .object({
        layout: pageLayoutSchema,
        confidence: z
            .array(
                z
                    .object({
                        key: z.string().max(64),
                        score: z.number().min(0).max(1),
                        note: z.string().max(300),
                    })
                    .strict()
            )
            .min(1)
            .max(120),
    })
    .strict()
    .superRefine((result, ctx) => {
        const keys = new Set(result.confidence.map((item) => item.key));
        if (
            keys.size !== result.confidence.length ||
            result.layout.nodes.some((node) => !keys.has(node.key)) ||
            result.confidence.some((item) => !result.layout.nodes.some((node) => node.key === item.key))
        ) {
            ctx.addIssue({ code: "custom", message: "识别置信度必须逐一对应布局节点。" });
        }
    });

export const imageGenerationSchema = z
    .object({
        prompt: z.string().trim().min(1).max(4000),
        size: z.enum(["1024x1024", "1536x1024", "1024x1536"]),
        quality: z.enum(["low", "medium", "high"]),
        count: z.number().int().min(1).max(2),
        reference: pngImageSchema.optional(),
        mask: pngImageSchema.optional(),
    })
    .strict()
    .superRefine((request, ctx) => {
        if (
            request.mask &&
            (!request.reference ||
                request.mask.width !== request.reference.width ||
                request.mask.height !== request.reference.height)
        ) {
            ctx.addIssue({ code: "custom", message: "局部编辑需要同尺寸的参考图和透明蒙版。" });
        }
    });

export type PngImage = z.infer<typeof pngImageSchema>;
export type ImageGenerationRequest = z.infer<typeof imageGenerationSchema>;
