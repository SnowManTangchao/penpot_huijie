import { pageLayoutSchema, type PageLayout, type LayoutNode, type DesignContext } from "@penpot/mcp-common";

export interface CodeExport {
    target: string;
    files: Record<string, string>;
    warnings: string[];
}
export interface CodeAdapter {
    readonly target: string;
    export(page: PageLayout): CodeExport;
}

/** React/CSS 适配器复用设计映射；每个容器导出独立函数组件。 */
export class ReactCodeAdapter implements CodeAdapter {
    readonly target = "react-css";
    export(page: PageLayout): CodeExport {
        const base = new HtmlCodeAdapter().export(page);
        const names = new Map(page.nodes.filter((n) => n.type === "container").map((n, i) => [n.key, `Section${i}`]));
        const render = (node: LayoutNode): string => {
            if (node.type === "container") {
                return `<${names.get(node.key)} />`;
            }
            const props = `className=${JSON.stringify(`node-${node.key}`)} aria-label={${JSON.stringify(node.name)}}`;
            if (node.type === "text") {
                return `<p ${props}>{${JSON.stringify(node.text)}}</p>`;
            }
            if (node.imageAssetId) {
                return `<img ${props} src=${JSON.stringify(`/assets/by-file-media-id/${node.imageAssetId}`)} alt={${JSON.stringify(node.name)}} />`;
            }
            return `<figure ${props}${node.componentId ? ` data-component={${JSON.stringify(node.componentId)}}` : ""} />`;
        };
        const components = page.nodes
            .filter((n) => n.type === "container")
            .map(
                (node) =>
                    `export function ${names.get(node.key)}() {\n  return (\n    <section className="node-${node.key}" aria-label={${JSON.stringify(node.name)}}${node.componentId ? ` data-component={${JSON.stringify(node.componentId)}}` : ""}>\n` +
                    page.nodes
                        .filter((n) => n.parent === node.key)
                        .map((child) => `      ${render(child)}`)
                        .join("\n") +
                    "\n    </section>\n  );\n}\n"
            )
            .join("\n");
        const root = page.nodes.find((n) => !n.parent)!;
        const { "index.html": _html, ...files } = base.files;
        return {
            ...base,
            target: this.target,
            files: {
                ...files,
                "DesignPage.jsx": `import React from "react";\nimport "./styles.css";\n\n${components}\nexport default ${names.get(root.key)};\n`,
            },
        };
    }
}

/** 目标栈注册表；导出只产生文本文件，从不执行产物。 */
export class CodeExporter {
    constructor(private readonly adapters: CodeAdapter[]) {}
    export(target: string, input: unknown): CodeExport {
        const adapter = this.adapters.find((item) => item.target === target);
        if (!adapter) {
            throw new Error("不支持此代码导出目标。");
        }
        return adapter.export(pageLayoutSchema.parse(input));
    }

    fromContext(context: DesignContext): PageLayout {
        if (context.truncated && context.selectedIds.length === 0) {
            throw new Error("快照不完整，请缩小页面内容或使用已修正的布局树导出。");
        }
        const visible = context.shapes.filter((s) => !s.hidden);
        const included = new Set(context.selectedIds.length ? context.selectedIds : visible.map((s) => s.id));
        for (let depth = 0; depth < 6; depth++) {
            for (const shape of visible) {
                if (shape.parentId && included.has(shape.parentId)) {
                    included.add(shape.id);
                }
            }
        }
        const shapes = visible.filter((s) => included.has(s.id));
        if (shapes.some((s) => s.textTruncated || s.childrenTruncated)) {
            throw new Error("选区快照不完整，请缩小选区或使用已修正的布局树导出。");
        }
        if (!shapes.length || shapes.length > 119) {
            throw new Error("请选择 1–119 个完整可见图层。");
        }
        const x = Math.min(...shapes.map((s) => s.x));
        const y = Math.min(...shapes.map((s) => s.y));
        const width = Math.max(...shapes.map((s) => s.x + s.width)) - x;
        const height = Math.max(...shapes.map((s) => s.y + s.height)) - y;
        const keys = new Map(shapes.map((s, i) => [s.id, `node${i}`]));
        const nodes: LayoutNode[] = [
            { key: "root", name: context.page.name || "页面", type: "container", width, height },
        ];
        for (const shape of shapes) {
            const parent = shapes.find((s) => s.id === shape.parentId);
            const color = shape.fills[0]?.color;
            const token = context.designSystem?.colors.find((c) => c.color.toLowerCase() === color?.toLowerCase());
            const typography = context.designSystem?.typographies.find(
                (t) => t.fontFamily === shape.fontFamily && t.fontSize === shape.fontSize
            );
            nodes.push({
                key: keys.get(shape.id)!,
                parent: parent ? keys.get(parent.id)! : "root",
                type:
                    shape.type === "text"
                        ? "text"
                        : shape.type === "board" || shapes.some((s) => s.parentId === shape.id)
                          ? "container"
                          : shape.hasImage
                            ? "image_placeholder"
                            : "shape",
                name: shape.name || "图层",
                width: shape.width,
                height: shape.height,
                x: shape.x - (parent?.x ?? x),
                y: shape.y - (parent?.y ?? y),
                ...(shape.type === "text"
                    ? { text: shape.text || " ", fontFamily: shape.fontFamily, fontSize: Number(shape.fontSize) || 16 }
                    : {}),
                ...(color && /^#[0-9a-fA-F]{6}$/.test(color) ? { color, colorToken: token?.id } : {}),
                ...(typography ? { typographyToken: typography.id } : {}),
                opacity: shape.fills[0]?.opacity,
                borderRadius: shape.cornerRadii?.[0],
                ...(shape.imageAssetId ? { imageAssetId: shape.imageAssetId } : {}),
                ...(shape.componentId ? { componentId: shape.componentId } : {}),
            });
        }
        // 仅对无重叠且共线的直接子节点恢复流式布局，其余保持局部定位并提示。
        for (const node of nodes.filter((n) => n.type === "container")) {
            const children = nodes.filter((n) => n.parent === node.key);
            const row = children.length > 1 && children.every((n) => Math.abs((n.y ?? 0) - (children[0].y ?? 0)) < 1);
            const column =
                children.length > 1 && children.every((n) => Math.abs((n.x ?? 0) - (children[0].x ?? 0)) < 1);
            if (!row && !column) {
                continue;
            }
            const sorted = [...children].sort((a, b) => (row ? a.x! - b.x! : a.y! - b.y!));
            const gaps = sorted
                .slice(1)
                .map((n, i) => (row ? n.x! - sorted[i].x! - sorted[i].width : n.y! - sorted[i].y! - sorted[i].height));
            if (
                gaps.some((gap) => gap < 0 || gap > 1000 || Math.abs(gap - gaps[0]) > 1) ||
                (sorted[0].x ?? 0) !== (sorted[0].y ?? 0) ||
                (sorted[0].x ?? 0) > 1000
            ) {
                continue;
            }
            node.direction = row ? "row" : "column";
            node.gap = gaps[0];
            node.padding = sorted[0].x ?? 0;
            const positions = sorted.map((n) => nodes.indexOf(n));
            const first = Math.min(...positions);
            nodes.splice(0, nodes.length, ...nodes.filter((n) => !children.includes(n)));
            nodes.splice(first, 0, ...sorted);
        }
        return pageLayoutSchema.parse({
            title: context.page.name || "页面",
            pageType: "other",
            goal: "导出当前设计",
            roles: ["用户"],
            interactions: [],
            style: "当前设计",
            assumptions: [],
            width,
            height,
            nodes,
        });
    }
}

/** 原生 HTML/CSS PoC：容器作为命名区块，行列约束映射 Flex，设计 Token 映射变量。 */
export class HtmlCodeAdapter implements CodeAdapter {
    readonly target = "html-css";
    private escape(value: string): string {
        return value.replace(
            /[&<>"']/g,
            (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
        );
    }
    private cssString(value: string): string {
        return `"${Array.from(value)
            .map((c) => (/[a-zA-Z0-9 _-]/.test(c) ? c : `\\${c.codePointAt(0)!.toString(16)} `))
            .join("")}"`;
    }
    export(page: PageLayout): CodeExport {
        const warnings = [...page.assumptions];
        const tokens = new Map<string, string>();
        const tokenNames = new Map<string, string>();
        const tokenName = (prefix: string, id: string) => {
            const key = `${prefix}:${id}`;
            if (!tokenNames.has(key)) {
                tokenNames.set(key, `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${tokenNames.size}`);
            }
            return tokenNames.get(key)!;
        };
        const rootKey = page.nodes.find((n) => !n.parent)!.key;
        const styles: string[] = [
            `.node-${rootKey},.node-${rootKey} *{box-sizing:border-box}.node-${rootKey} section,.node-${rootKey} p,.node-${rootKey} figure{margin:0}.node-${rootKey} p{white-space:pre-wrap}`,
        ];
        const render = (node: LayoutNode, depth: number): string => {
            const parent = page.nodes.find((n) => n.key === node.parent);
            const colorName = node.colorToken ? tokenName("color", node.colorToken) : undefined;
            const typographyName = node.typographyToken ? tokenName("font", node.typographyToken) : undefined;
            if (colorName) {
                tokens.set(colorName, node.color ?? "#202020");
            }
            if (typographyName) {
                tokens.set(typographyName, `${node.fontSize ?? 16}px ${this.cssString(node.fontFamily ?? "Inter")}`);
            }
            const color = colorName
                ? `var(--${colorName})`
                : (node.color ?? (node.type === "text" ? "#202020" : "transparent"));
            const css = [
                `width:${node.width}px`,
                `min-height:${node.height}px`,
                "position:relative",
                "flex-shrink:0",
                `${node.type === "text" ? "color" : "background"}:${node.opacity !== undefined && node.opacity < 1 ? `color-mix(in srgb,${color} ${node.opacity * 100}%,transparent)` : color}`,
                `border-radius:${node.borderRadius ?? 0}px`,
            ];
            if (parent && (!parent.direction || parent.direction === "absolute")) {
                css.push(
                    "position:absolute",
                    `left:${node.x ?? parent.padding ?? 0}px`,
                    `top:${node.y ?? parent.padding ?? 0}px`
                );
                warnings.push("存在自由定位区域；建议修正布局树的 row/column 约束后重新导出。");
            }
            if (node.direction === "row" || node.direction === "column") {
                css.push(
                    "display:flex",
                    `flex-direction:${node.direction}`,
                    `gap:${node.gap ?? 0}px`,
                    `padding:${node.padding ?? 0}px`,
                    `align-items:${node.align === "center" ? "center" : node.align === "end" ? "flex-end" : "flex-start"}`
                );
            }
            if (node.type === "text") {
                css.push(
                    `font:${typographyName ? `var(--${typographyName})` : `${node.fontSize ?? 16}px ${this.cssString(node.fontFamily ?? "Inter")}`}`
                );
            }
            styles.push(`.node-${node.key}{${css.join(";")}}`);
            const indent = "  ".repeat(depth);
            const tag = node.type === "text" ? "p" : node.type === "container" ? "section" : "figure";
            if (node.type === "image_placeholder" && node.imageAssetId) {
                warnings.push("图片在 assets.json 映射到 Penpot 资源路径；部署时请下载并替换为项目资源。");
                return `${indent}<img class="node-${node.key}" src="/assets/by-file-media-id/${node.imageAssetId}" alt="${this.escape(node.name)}">`;
            }
            if (["component", "image_placeholder"].includes(node.type)) {
                warnings.push(`${node.name} 需要接入项目组件或图片资源。`);
            }
            const children = page.nodes
                .filter((n) => n.parent === node.key)
                .map((n) => render(n, depth + 1))
                .join("\n");
            const content = node.type === "text" ? this.escape(node.text!) : children ? `\n${children}\n${indent}` : "";
            return `${indent}<${tag} class="node-${node.key}" aria-label="${this.escape(node.name)}"${node.componentId ? ` data-component="${this.escape(node.componentId)}"` : ""}>${content}</${tag}>`;
        };
        const body = render(
            page.nodes.find((n) => !n.parent)!,
            1
        );
        const html = `<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${this.escape(page.title)}</title><link rel="stylesheet" href="styles.css"></head>\n<body>\n${body}\n</body>\n</html>\n`;
        const css = `.node-${rootKey}{${[...tokens].map(([name, value]) => `--${name}:${value}`).join(";")}}\n${styles.join("\n")}\n`;
        const assets = page.nodes
            .filter((n) => n.imageAssetId)
            .map((n) => ({ key: n.key, id: n.imageAssetId, source: `/assets/by-file-media-id/${n.imageAssetId}` }));
        return {
            target: this.target,
            files: {
                "index.html": html,
                "styles.css": css,
                "layout.json": JSON.stringify(page, null, 2),
                "assets.json": JSON.stringify(assets, null, 2),
            },
            warnings: [...new Set([...warnings, "导出仅含视觉结构；不包含业务逻辑、响应式断点或未提供的组件实现。"])],
        };
    }
}
