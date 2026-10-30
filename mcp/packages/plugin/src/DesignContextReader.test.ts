import assert from "node:assert/strict";
import test from "node:test";
import type { Penpot, Shape } from "@penpot/plugin-types";
import { DesignContextReader } from "./DesignContextReader.ts";

const scope = {
    fileId: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
};

function shape(id: string, children: Shape[] = []): Shape {
    return {
        id,
        name: id,
        type: "group",
        x: 10,
        y: 20,
        width: 100,
        height: 80,
        hidden: false,
        fills: [{ fillColor: "#ff0000", fillOpacity: 1 }],
        children,
        parent: null,
    } as unknown as Shape;
}

function fixture(roots: Shape[], selected: Shape[] = []) {
    const members = new Map<string, Shape>();
    const index = (nodes: Shape[]) => {
        for (const node of nodes) {
            members.set(node.id, node);
            if ("children" in node) {
                index(node.children);
            }
        }
    };
    index(roots);
    const api = {
        currentFile: { id: scope.fileId, name: "测试文件", revn: 7 },
        currentPage: {
            id: scope.pageId,
            name: "当前页面",
            root: shape("root", roots),
            getShapeById: (id: string) => members.get(id) ?? null,
        },
        selection: selected,
    } as unknown as Penpot;
    return new DesignContextReader(api);
}

test("reads the current page and selection without mutating shapes", () => {
    const text = {
        ...shape("title"),
        type: "text",
        characters: "购买商品",
        fontFamily: "Inter",
        fontSize: "24",
    } as Shape;
    const board = shape("board", [text]);
    const before = JSON.stringify(board);
    const context = fixture([board], [text]).read(scope);
    assert.deepEqual(context.selectedIds, ["title"]);
    assert.equal(context.shapes.find((item) => item.id === "title")?.text, "购买商品");
    assert.equal(context.shapes.find((item) => item.id === "title")?.fills[0].color, "#ff0000");
    assert.equal(context.file.revision, 7);
    assert.equal(JSON.stringify(board), before);
});

test("rejects a switched file or page", () => {
    const reader = fixture([]);
    assert.throws(() => reader.read({ ...scope, pageId: scope.fileId }), /已改变/);
    assert.throws(() => reader.read({ ...scope, fileId: scope.pageId }), /已改变/);
});

test("rejects a selection that does not belong to the current page", () => {
    assert.throws(() => fixture([], [shape("foreign")]).read(scope), /不属于/);
});

test("handles an empty page with no selection", () => {
    const context = fixture([]).read(scope);
    assert.deepEqual(context.shapes, []);
    assert.deepEqual(context.selectedIds, []);
    assert.equal(context.truncated, false);
});

test("accepts unset fill fields returned as null by the live Plugin API", () => {
    const board = { ...shape("board"), fills: [{ fillColor: "#eef3f8", fillOpacity: null }] } as unknown as Shape;
    const context = fixture([board], [board]).read(scope);
    assert.deepEqual(context.shapes[0].fills, [{ color: "#eef3f8", opacity: undefined }]);
});

test("bounds page size and prioritizes selected layers", () => {
    const roots = Array.from({ length: 200 }, (_, i) => shape(`shape-${i}`));
    const context = fixture(roots, [roots[199]]).read(scope);
    assert.equal(context.shapes.length, 120);
    assert.equal(context.shapes[0].id, "shape-199");
    assert.equal(context.truncated, true);
});

test("bounds depth and text length and reports omitted content", () => {
    const text = {
        ...shape("long-text"),
        type: "text",
        characters: "字".repeat(1000),
        fontFamily: "Inter",
        fontSize: "24",
    } as Shape;
    let root = text;
    for (let i = 0; i < 9; i++) {
        root = shape(`group-${i}`, [root]);
    }
    const context = fixture([root], [text]).read(scope);
    assert.equal(context.shapes[0].text?.length, 500);
    assert.equal(context.shapes[0].textTruncated, true);
    assert.equal(context.truncated, true);
    assert.equal(context.shapes.find((item) => item.id === "group-3")?.childrenTruncated, true);
});

test("bounds selection size and retains the original count", () => {
    const roots = Array.from({ length: 50 }, (_, i) => shape(`selected-${i}`));
    const context = fixture(roots, roots).read(scope);
    assert.equal(context.selectedIds.length, 40);
    assert.equal(context.selectionCount, 50);
    assert.equal(context.truncated, true);
});
