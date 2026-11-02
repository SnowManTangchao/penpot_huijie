import type { Penpot, Shape } from "@penpot/plugin-types";
import type { DesignContext, DesignContextInput, DesignShape } from "../../common/src/DesignContext.ts";

/** 在一次同步读取中获取当前页面快照，不调用任何写 API。 */
export class DesignContextReader {
    private readonly api: Penpot;

    constructor(api: Penpot) {
        this.api = api;
    }

    read(input: DesignContextInput): DesignContext {
        const scope = input;
        const file = this.api.currentFile;
        const page = this.api.currentPage;
        if (!file || !page) {
            throw new Error("没有打开的 Penpot 页面。");
        }
        if (file.id !== scope.fileId || page.id !== scope.pageId) {
            throw new Error("当前文件或页面已改变，请重新绑定上下文。");
        }

        const shapes = new Map<string, DesignShape>();
        const selection = this.api.selection;
        let truncated = selection.length > 40;
        const selectedIds: string[] = [];
        for (const selected of selection.slice(0, 40)) {
            const shape = page.getShapeById(selected.id);
            if (!shape) {
                throw new Error("选中图层不属于当前页面。");
            }
            selectedIds.push(shape.id);
            shapes.set(shape.id, this.snapshot(shape));
        }

        const visit = (shape: Shape, depth: number): void => {
            if (!shapes.has(shape.id)) {
                if (shapes.size >= 120) {
                    truncated = true;
                    return;
                }
                shapes.set(shape.id, this.snapshot(shape));
            }
            const children = "children" in shape ? shape.children : [];
            if (depth >= 5) {
                if (children.length > 0) {
                    shapes.get(shape.id)!.childrenTruncated = true;
                    truncated = true;
                }
                return;
            }
            for (const child of children) {
                if (shapes.size >= 120 && !shapes.has(child.id)) {
                    shapes.get(shape.id)!.childrenTruncated = true;
                    truncated = true;
                    break;
                }
                visit(child, depth + 1);
            }
        };
        // 优先展开选中的区域，便于在大页面中定向迭代新生成的内容。
        for (const id of selectedIds) {
            visit(page.getShapeById(id)!, 0);
        }
        const roots = "children" in page.root ? page.root.children : [];
        for (const root of roots) {
            if (shapes.size >= 120 && !shapes.has(root.id)) {
                truncated = true;
                break;
            }
            visit(root, 0);
        }
        for (const snapshot of shapes.values()) {
            const original = page.getShapeById(snapshot.id);
            if (original && "children" in original) {
                snapshot.childrenTruncated = original.children.some((child) => !shapes.has(child.id));
                truncated ||= snapshot.childrenTruncated;
            }
        }
        const result = {
            file: { id: file.id, name: file.name.slice(0, 160), revision: file.revn },
            page: { id: page.id, name: page.name.slice(0, 160) },
            selectedIds,
            selectionCount: selection.length,
            shapes: [...shapes.values()],
            truncated,
            designSystem: this.readDesignSystem(),
        };
        return result;
    }

    private readDesignSystem(): NonNullable<DesignContext["designSystem"]> {
        const library = this.api.library?.local;
        const colors = (library?.colors ?? []).filter((c) => c.color && /^#[0-9a-fA-F]{6}$/.test(c.color));
        const typographies = (library?.typographies ?? []).filter(
            (t) => Number(t.fontSize) >= 1 && Number(t.fontSize) <= 1000
        );
        const components = library?.components ?? [];
        const fonts = this.api.fonts?.all ?? [];
        return {
            colors: colors
                .slice(0, 60)
                .map((c) => ({ id: c.id, name: c.name.slice(0, 160), color: c.color!, opacity: c.opacity ?? 1 })),
            typographies: typographies.slice(0, 40).map((t) => ({
                id: t.id,
                name: t.name.slice(0, 160),
                fontFamily: t.fontFamily.slice(0, 160),
                fontSize: t.fontSize,
            })),
            components: components.slice(0, 40).map((c) => ({ id: c.id, name: c.name.slice(0, 160) })),
            fonts: fonts.slice(0, 60).map((f) => f.name.slice(0, 160)),
            truncated: colors.length > 60 || typographies.length > 40 || components.length > 40 || fonts.length > 60,
        };
    }

    private snapshot(shape: Shape): DesignShape {
        const text = shape.type === "text" ? shape.characters : undefined;
        const component = shape.isComponentHead?.() ? shape.component() : null;
        return {
            id: shape.id,
            name: shape.name.slice(0, 160),
            type: shape.type,
            parentId: shape.parent?.id ?? null,
            x: shape.x,
            y: shape.y,
            width: shape.width,
            height: shape.height,
            hidden: shape.hidden,
            ...(component ? { componentId: component.id } : {}),
            hasImage: Array.isArray(shape.fills) && shape.fills.some((fill) => Boolean(fill.fillImage)),
            ...(Array.isArray(shape.fills) && shape.fills.find((fill) => fill.fillImage)?.fillImage?.id
                ? { imageAssetId: shape.fills.find((fill) => fill.fillImage)!.fillImage!.id }
                : {}),
            ...(shape.type === "rectangle"
                ? {
                      cornerRadii: [
                          shape.borderRadiusTopLeft ?? 0,
                          shape.borderRadiusTopRight ?? 0,
                          shape.borderRadiusBottomRight ?? 0,
                          shape.borderRadiusBottomLeft ?? 0,
                      ] as [number, number, number, number],
                  }
                : {}),
            ...(shape.type === "text"
                ? {
                      text: text!.slice(0, 500),
                      textTruncated: text!.length > 500,
                      fontFamily: String(shape.fontFamily).slice(0, 160),
                      fontSize: String(shape.fontSize).slice(0, 160),
                  }
                : {}),
            fills: (Array.isArray(shape.fills) ? shape.fills : []).slice(0, 3).map((fill) => ({
                color: fill.fillColor?.slice(0, 160) ?? undefined,
                opacity: fill.fillOpacity ?? undefined,
            })),
            childrenTruncated: false,
        };
    }
}
