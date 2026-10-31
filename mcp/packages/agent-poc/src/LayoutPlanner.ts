import {
    pageLayoutSchema,
    designOperationSchema,
    type DesignContext,
    type DesignOperation,
    type GenerationSummary,
    type LayoutNode,
    type QualityIssue,
} from "@penpot/mcp-common";

/** 将布局约束编译为有序白名单操作；不持有画布写入能力。 */
export class LayoutPlanner {
    compile(input: unknown, context: DesignContext): { operations: DesignOperation[]; generation: GenerationSummary } {
        const page = pageLayoutSchema.parse(input);
        const system = context.designSystem;
        const warnings = [...page.assumptions];
        const issues: QualityIssue[] = [];
        const operations: DesignOperation[] = [];
        const placed = new Map<string, { node: LayoutNode; x: number; y: number }>();
        const root = page.nodes.find((n) => !n.parent)!;
        // 新页面放到现有内容右侧，避免覆盖用户已有设计。
        const origin = context.shapes.length ? Math.max(...context.shapes.map((s) => s.x + s.width)) + 80 : 0;
        if (origin + page.width > 100000) {
            throw new Error("页面超出画布坐标上限。");
        }
        const visit = (node: LayoutNode, x: number, y: number) => {
            placed.set(node.key, { node, x, y });
            const requestedColor = node.color ?? (node.type === "text" ? "#202020" : "#F5F5F5");
            const color = node.colorToken
                ? system?.colors.find((c) => c.id === node.colorToken)
                : system?.colors.find(
                      (c) => c.color.toLowerCase() === requestedColor.toLowerCase() && c.opacity === (node.opacity ?? 1)
                  );
            if (node.colorToken && !color) {
                throw new Error("颜色 Token 不在当前文件中。");
            }
            const typography = node.typographyToken
                ? system?.typographies.find((t) => t.id === node.typographyToken)
                : system?.typographies.find(
                      (t) => t.fontFamily === node.fontFamily && Number(t.fontSize) === node.fontSize
                  );
            if (node.typographyToken && !typography) {
                throw new Error("文本样式不在当前文件中。");
            }
            const base = {
                name: node.name,
                x,
                y,
                width: node.width,
                height: node.height,
                ref: node.key,
                ...(node.parent ? { parentRef: node.parent } : {}),
            };
            const fill = {
                color: color?.color ?? requestedColor,
                opacity:
                    color?.opacity ??
                    node.opacity ??
                    (node.type === "container" && node.parent && !node.color && !node.colorToken ? 0 : 1),
                ...(color ? { colorRef: color.id } : {}),
            };
            let op: unknown;
            if (node.type === "component") {
                if (!system?.components.some((c) => c.id === node.componentId)) {
                    throw new Error("组件不在当前文件中。");
                }
                op = { ...base, tool: "create_component", componentId: node.componentId };
            } else if (node.type === "text") {
                op = {
                    ...base,
                    ...fill,
                    tool: "create_text",
                    text: node.text,
                    fontFamily: typography?.fontFamily ?? node.fontFamily ?? system?.fonts[0] ?? "Inter",
                    fontSize: Number(typography?.fontSize ?? node.fontSize ?? 16),
                    ...(typography ? { typographyRef: typography.id } : {}),
                };
            } else {
                op = {
                    ...base,
                    ...fill,
                    tool: node.type === "container" ? "create_frame" : "create_rectangle",
                    ...(node.type !== "container" && node.borderRadius !== undefined
                        ? { borderRadius: node.borderRadius }
                        : {}),
                };
                if (node.type === "image_placeholder") {
                    warnings.push(`${node.name} 为可编辑图片占位，尚未载入图片。`);
                }
            }
            operations.push(designOperationSchema.parse(op));
            let cursor = node.padding ?? 0;
            const padding = node.padding ?? 0;
            const children = page.nodes.filter((n) => n.parent === node.key);
            for (const child of children) {
                let cx = child.x ?? padding;
                let cy = child.y ?? padding;
                if (node.direction === "row" || node.direction === "column") {
                    const row = node.direction === "row";
                    const available = (row ? node.height : node.width) - padding * 2;
                    const size = row ? child.height : child.width;
                    const cross =
                        padding +
                        (node.align === "center"
                            ? (available - size) / 2
                            : node.align === "end"
                              ? available - size
                              : 0);
                    cx = row ? cursor : cross;
                    cy = row ? cross : cursor;
                    cursor += (row ? child.width : child.height) + (node.gap ?? 0);
                }
                if (cx < 0 || cy < 0 || cx + child.width > node.width || cy + child.height > node.height) {
                    issues.push({
                        code: "overflow",
                        message: `${child.name} 超出 ${node.name} 的边界。`,
                        nodeKeys: [child.key, node.key],
                    });
                }
                visit(child, x + cx, y + cy);
            }
            for (let i = 0; i < children.length; i++) {
                const a = placed.get(children[i].key)!;
                for (const bNode of children.slice(i + 1)) {
                    const b = placed.get(bNode.key)!;
                    if (
                        a.x < b.x + b.node.width &&
                        a.x + a.node.width > b.x &&
                        a.y < b.y + b.node.height &&
                        a.y + a.node.height > b.y
                    ) {
                        issues.push({
                            code: "overlap",
                            message: `${a.node.name} 与 ${b.node.name} 的矩形边界重叠，请核对是否为有意叠放。`,
                            nodeKeys: [a.node.key, b.node.key],
                        });
                    }
                }
            }
        };
        visit(root, origin, 0);
        if (operations.some((op) => "color" in op && !op.colorRef)) {
            warnings.push("未匹配现有颜色的节点使用预览中的临时样式，不会新建设计资产。");
        }
        if (operations.some((op) => op.tool === "create_text" && !op.typographyRef)) {
            warnings.push("未匹配文本样式的文字使用临时字体与字号。");
        }
        if (system?.truncated) {
            warnings.push("设计资产列表已截断，仅在已读取的资产中匹配。");
        }
        if (context.truncated) {
            warnings.push("页面快照已截断，新增位置仅避让已读取的内容，请确认预览中的落点。");
        }
        warnings.push("当前生成固定尺寸的可编辑页面；行列约束在生成时求解，尚不绑定自动响应式布局。");
        return {
            operations,
            generation: {
                title: page.title,
                pageType: page.pageType,
                goal: page.goal,
                roles: page.roles,
                interactions: page.interactions,
                style: page.style,
                width: page.width,
                height: page.height,
                sections: page.nodes.map(({ key, parent, name, type }) => ({ key, parent, name, type })),
                warnings: [...new Set(warnings)].slice(0, 30),
                issues: issues.slice(0, 120),
            },
        };
    }
}
