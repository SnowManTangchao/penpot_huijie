import assert from "node:assert/strict";
import test from "node:test";
import { pngImageSchema } from "@penpot/mcp-common";
import { HtmlCodeAdapter, ReactCodeAdapter, CodeExporter } from "./CodeExporter";
import ts from "typescript";
import { AdvancedDesignService, type ImageProvider } from "./AdvancedDesignService";
import { AdvancedDesignRequest, advancedRequestSchema } from "./AdvancedDesignRequest";
import { MockLanguageModelV4 } from "ai/test";
import type { DesignContext } from "@penpot/mcp-common";
import { pageLayoutSchema } from "@penpot/mcp-common";

export const page = pageLayoutSchema.parse({
    title: "登录",
    pageType: "login",
    goal: "登录设备",
    roles: ["操作员"],
    interactions: [],
    style: "简洁",
    assumptions: [],
    width: 400,
    height: 300,
    nodes: [
        { key: "root", type: "container", name: "登录", width: 400, height: 300, direction: "column", gap: 16 },
        {
            key: "title",
            parent: "root",
            type: "text",
            name: "标题",
            width: 300,
            height: 40,
            text: "<script>alert(1)</script>",
            color: "#123456",
            colorToken: "brand",
            fontFamily: "Inter",
            fontSize: 24,
        },
    ],
});

test("exports escaped semantic sections, flex layout and design tokens without executing code", () => {
    const output = new CodeExporter([new HtmlCodeAdapter()]).export("html-css", page);
    assert.match(output.files["index.html"], /&lt;script&gt;/);
    assert.doesNotMatch(output.files["index.html"], /<script>/);
    assert.match(output.files["styles.css"], /flex-direction:column/);
    assert.match(output.files["styles.css"], /--color-brand-0:#123456/);
    assert.ok(output.files["layout.json"]);
    assert.throws(() => new CodeExporter([]).export("missing", page));
});

test("rejects executable image inputs and invalid PNG dimensions", () => {
    assert.equal(pngImageSchema.safeParse({ data: "<svg onload='x'>", width: 1, height: 1 }).success, false);
    assert.equal(pngImageSchema.safeParse({ data: "aGVsbG8=", width: 1, height: 1 }).success, false);
});

const png = {
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
    width: 1,
    height: 1,
};
class TestImageProvider implements ImageProvider {
    readonly model = "test-image";
    readonly license = "test-only";
    async generate() {
        return { images: [png] };
    }
}
const scope = {
    fileId: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
    sessionId: "tab",
    selectedIds: [],
    selectionCount: 0,
};
const context: DesignContext = {
    file: { id: scope.fileId, name: "文件", revision: 1 },
    page: { id: scope.pageId, name: "页面" },
    selectedIds: [],
    selectionCount: 0,
    shapes: [],
    truncated: false,
};

test("generated previews are isolated and selection prepares data without executing writes", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const service = new AdvancedDesignService(new TestImageProvider());
    const input = { prompt: "山", size: "1024x1024", quality: "low", count: 1 };
    const result = await service.generate(
        "owner",
        "tab",
        `${scope.fileId}/${scope.pageId}`,
        input,
        AbortSignal.timeout(5000)
    );
    const id = result.images[0].id;
    assert.deepEqual(service.getImage("owner", "tab", `${scope.fileId}/${scope.pageId}`, id), png);
    for (const [owner, session, binding] of [
        ["other", "tab", `${scope.fileId}/${scope.pageId}`],
        ["owner", "other", `${scope.fileId}/${scope.pageId}`],
        ["owner", "tab", "other-page"],
    ]) {
        assert.throws(() => service.getImage(owner, session, binding, id), /过期/);
    }
    const request = advancedRequestSchema.parse({
        ...scope,
        action: { type: "prepare-image", imageId: id, replace: false },
    });
    const proposal = await new AdvancedDesignRequest(service).run(
        request,
        "owner",
        context,
        new Map(),
        AbortSignal.timeout(5000)
    );
    assert.ok("operations" in proposal && proposal.operations[0].tool === "create_image");
    await assert.rejects(
        new AdvancedDesignRequest(service).run(
            { ...request, pageId: crypto.randomUUID() },
            "owner",
            context,
            new Map(),
            AbortSignal.timeout(5000)
        ),
        /改变/
    );
    t.mock.timers.tick(300_001);
    assert.throws(() => service.getImage("owner", "tab", `${scope.fileId}/${scope.pageId}`, id), /过期/);
    assert.throws(() => service.getImage("owner", "tab", "file/page", "missing"), /过期/);
});

test("React export produces separately named components with parseable JSX and safe text literals", () => {
    const layout = structuredClone(page);
    layout.nodes.push({
        key: "card",
        parent: "root",
        type: "container",
        name: "内容卡片",
        width: 200,
        height: 100,
        direction: "column",
    });
    layout.nodes[1].parent = "card";
    layout.nodes[2].componentId = "existing-component";
    const result = new CodeExporter([new ReactCodeAdapter()]).export("react-css", layout);
    assert.match(result.files["DesignPage.jsx"], /export function Section0/);
    assert.match(result.files["DesignPage.jsx"], /<Section1 \/>/);
    assert.match(result.files["DesignPage.jsx"], /data-component=\{"existing-component"\}/);
    const parsed = ts.transpileModule(result.files["DesignPage.jsx"], {
        compilerOptions: { jsx: ts.JsxEmit.React },
        fileName: "DesignPage.jsx",
        reportDiagnostics: true,
    });
    assert.deepEqual(parsed.diagnostics, []);
});

test("complete selected regions export even when unrelated page content is truncated", () => {
    const shape = {
        id: "title",
        name: "标题",
        parentId: null,
        type: "text",
        x: 20,
        y: 20,
        width: 200,
        height: 30,
        text: "设备",
        fontSize: "20",
        hidden: false,
        childrenTruncated: false,
        fills: [],
    };
    const current = { ...context, truncated: true, selectedIds: ["title"], selectionCount: 1, shapes: [shape] };
    const layout = new CodeExporter([]).fromContext(current);
    assert.equal(layout.nodes[1].text, "设备");
    assert.throws(
        () => new CodeExporter([]).fromContext({ ...current, shapes: [{ ...shape, textTruncated: true }] }),
        /不完整/
    );
});

test("vision output is validated and compiles OCR text to editable tools after correction", async () => {
    const layout = {
        ...page,
        width: 1,
        height: 1,
        nodes: page.nodes.map((n) => ({ ...n, width: 1, height: 1, colorToken: undefined })),
    };
    const analysis = { layout, confidence: layout.nodes.map((n) => ({ key: n.key, score: 0.8, note: "需核对" })) };
    const model = new MockLanguageModelV4({
        doGenerate: {
            content: [{ type: "text", text: JSON.stringify(analysis) }],
            finishReason: { unified: "stop", raw: "stop" },
            warnings: [],
            usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 10, text: 10, reasoning: 0 },
            },
        },
    });
    const service = new AdvancedDesignService();
    const result = await service.analyze(model, png, "还原", AbortSignal.timeout(5000));
    assert.equal(result.confidence[0].score, 0.8);
    result.layout.nodes[1].text = "人工修正";
    const proposal = await new AdvancedDesignRequest(service).run(
        advancedRequestSchema.parse({ ...scope, action: { type: "prepare-layout", layout: result.layout } }),
        "owner",
        context,
        new Map(),
        AbortSignal.timeout(5000)
    );
    assert.ok(
        "operations" in proposal &&
            proposal.operations.some((op) => op.tool === "create_text" && op.text === "人工修正")
    );
    assert.ok(
        model.doGenerateCalls[0].prompt.some(
            (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((part) => part.type === "file")
        )
    );
});

test("code export rejects incomplete canvas snapshots and escapes unsafe font and component strings", () => {
    const exporter = new CodeExporter([new HtmlCodeAdapter()]);
    assert.throws(() => exporter.fromContext({ ...context, truncated: true }), /不完整/);
    const layout = structuredClone(page);
    layout.nodes[1].fontFamily = 'x";}body{background:url(https://evil.test)';
    const output = exporter.export("html-css", layout);
    assert.doesNotMatch(output.files["styles.css"], /background:url\(https/);
    assert.equal(pngImageSchema.safeParse({ ...png, width: 4097 }).success, false);
});
