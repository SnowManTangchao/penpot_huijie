import assert from "node:assert/strict";
import test from "node:test";
import { LayoutPlanner } from "./LayoutPlanner";
import { pageLayoutSchema, type DesignContext } from "@penpot/mcp-common";

export const dashboard = {
    title: "设备概览",
    pageType: "dashboard",
    goal: "查看设备状态",
    roles: ["操作员"],
    interactions: ["查看指标"],
    style: "工业控制台",
    assumptions: ["指标使用示例数据"],
    width: 1200,
    height: 800,
    nodes: [
        {
            key: "page",
            type: "container",
            name: "设备概览",
            width: 1200,
            height: 800,
            direction: "column",
            padding: 24,
            gap: 16,
            color: "#FFFFFF",
        },
        {
            key: "title",
            parent: "page",
            type: "text",
            name: "标题",
            width: 1152,
            height: 48,
            text: "设备概览",
            color: "#112233",
            fontFamily: "Inter",
            fontSize: 32,
        },
        {
            key: "cards",
            parent: "page",
            type: "container",
            name: "指标区",
            width: 1152,
            height: 160,
            direction: "row",
            gap: 16,
        },
        {
            key: "card",
            parent: "cards",
            type: "shape",
            name: "在线设备",
            width: 240,
            height: 160,
            color: "#112233",
            borderRadius: 8,
        },
    ],
};
const context: DesignContext = {
    file: { id: "file", name: "文件", revision: 1 },
    page: { id: "page", name: "页面" },
    shapes: [],
    selectedIds: [],
    selectionCount: 0,
    truncated: false,
    designSystem: {
        colors: [{ id: "color", name: "品牌", color: "#112233", opacity: 1 }],
        typographies: [],
        components: [],
        fonts: ["Inter"],
        truncated: false,
    },
};

test("dashboard compiles parent-first with relative layout, editable nodes and existing color references", () => {
    const result = new LayoutPlanner().compile(dashboard, context);
    assert.equal(result.operations.length, 4);
    assert.equal(result.operations[0].tool, "create_frame");
    assert.equal(result.operations[1].tool, "create_text");
    assert.equal(result.operations[1].x, 24);
    assert.equal(result.operations[1].y, 24);
    assert.equal(result.operations[1].parentRef, "page");
    const region = result.operations[2];
    const card = result.operations[3];
    assert.ok("y" in region && region.y === 88);
    assert.ok("colorRef" in card && card.colorRef === "color");
    assert.equal(result.generation.title, dashboard.title);
    assert.equal(result.generation.sections.length, 4);
});

test("rejects duplicate keys, cycles, missing parents, leaf parents, multiple roots and non-finite dimensions", () => {
    for (const nodes of [
        [...dashboard.nodes, dashboard.nodes[1]],
        dashboard.nodes.map((n) => (n.key === "cards" ? { ...n, parent: "card" } : n)),
        dashboard.nodes.map((n) => (n.key === "title" ? { ...n, parent: "missing" } : n)),
        dashboard.nodes.map((n) => (n.key === "cards" ? { ...n, parent: "title" } : n)),
        dashboard.nodes.map((n) => (n.key === "title" ? { ...n, parent: undefined } : n)),
        dashboard.nodes.map((n) => ({ ...n, width: Infinity })),
    ]) {
        assert.equal(pageLayoutSchema.safeParse({ ...dashboard, nodes }).success, false);
    }
});

test("reports deterministic overflow, overlap and temporary styles with node references", () => {
    const input = {
        ...dashboard,
        nodes: [
            { key: "root", type: "container", name: "页面", width: 1200, height: 800 },
            { key: "a", parent: "root", type: "shape", name: "甲", x: 1190, y: 0, width: 100, height: 100 },
            { key: "b", parent: "root", type: "shape", name: "乙", x: 1195, y: 0, width: 100, height: 100 },
        ],
    };
    const result = new LayoutPlanner().compile(input, { ...context, designSystem: undefined });
    assert.ok(result.generation.issues.some((i) => i.code === "overflow" && i.nodeKeys.includes("a")));
    assert.ok(result.generation.issues.some((i) => i.code === "overlap"));
    assert.ok(result.generation.warnings.some((w) => w.includes("临时")));
});

test("unknown token/component references fail before any plan is prepared", () => {
    for (const node of [
        { ...dashboard.nodes[3], colorToken: "invented" },
        { ...dashboard.nodes[3], type: "component", componentId: "invented" },
    ]) {
        assert.throws(() =>
            new LayoutPlanner().compile({ ...dashboard, nodes: [...dashboard.nodes.slice(0, 3), node] }, context)
        );
    }
});

test("places a new page clear of existing content and preserves the requested style", () => {
    const existing = {
        id: "existing",
        name: "已有",
        type: "board",
        parentId: null,
        x: 0,
        y: 0,
        width: 1600,
        height: 900,
        hidden: false,
        fills: [],
        childrenTruncated: false,
    };
    const result = new LayoutPlanner().compile(dashboard, { ...context, shapes: [existing] });
    assert.ok("x" in result.operations[0] && result.operations[0].x >= 1680);
    assert.equal(result.generation.style, "工业控制台");
});
