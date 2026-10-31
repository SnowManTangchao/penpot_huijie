import assert from "node:assert/strict";
import test from "node:test";
import { DesignEditor } from "./DesignEditor.ts";

const fileId = "11111111-1111-4111-8111-111111111111";
const pageId = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";

function fixture() {
    const shapes = new Map();
    const root = {
        id: "00000000-0000-0000-0000-000000000000",
        appendChild(s) {
            s.parent = root;
        },
    };
    const create = (type = "rectangle") => {
        const shape = {
            id: crypto.randomUUID(),
            type,
            name: "Rectangle",
            x: 0,
            y: 0,
            width: 100,
            height: 40,
            hidden: false,
            blocked: false,
            parent: root,
            fills: [{ fillColor: "#ff0000", fillOpacity: 1 }],
            characters: "原文",
            fontFamily: "Inter",
            fontSize: "14",
            borderRadiusTopLeft: 0,
            borderRadiusTopRight: 0,
            borderRadiusBottomRight: 0,
            borderRadiusBottomLeft: 0,
            get borderRadius() {
                return this.borderRadiusTopLeft;
            },
            set borderRadius(value) {
                this.borderRadiusTopLeft = value;
                this.borderRadiusTopRight = value;
                this.borderRadiusBottomRight = value;
                this.borderRadiusBottomLeft = value;
            },
            resize(w, h) {
                this.width = w;
                this.height = h;
            },
        };
        shapes.set(shape.id, shape);
        return shape;
    };
    const shape = create();
    shapes.delete(shape.id);
    shape.id = id;
    shapes.set(id, shape);
    let blocks = 0;
    const listeners = new Map();
    const api = {
        on: (_type, callback) => {
            const key = Symbol();
            listeners.set(key, callback);
            return key;
        },
        off: (key) => {
            listeners.delete(key);
        },
        currentFile: { id: fileId },
        currentPage: { id: pageId, root, getShapeById: (id) => shapes.get(id) ?? null },
        selection: [shape],
        flags: { throwValidationErrors: false },
        history: {
            undoBlockBegin: () => {
                blocks++;
                return Symbol();
            },
            undoBlockFinish: () => {},
        },
        createRectangle: () => create(),
        createBoard: () => create("board"),
        createText: (text) => {
            const s = create("text");
            s.characters = text;
            return s;
        },
    };
    const editor = new DesignEditor(api);
    const scope = { fileId, pageId, selectedIds: [id], selectionCount: 1 };
    const prepare = (operations = [{ tool: "set_fill", shapeId: id, color: "#0000ff", opacity: 1 }]) =>
        editor.prepare({ ...scope, operations, planId: crypto.randomUUID() });
    return {
        editor,
        api,
        shapes,
        shape,
        scope,
        prepare,
        blocks: () => blocks,
        notifyShapeChange: () => {
            for (const callback of listeners.values()) {
                callback();
            }
        },
    };
}

test("preview and cancellation have no canvas effects; confirmation reads back and deduplicates", async () => {
    const f = fixture();
    const plan = f.prepare();
    assert.equal(f.shape.fills[0].fillColor, "#ff0000");
    const result = await f.editor.execute({ ...f.scope, planId: plan.id });
    assert.equal(result.status, "success");
    assert.equal(result.steps[0].after.fills[0].fillColor, "#0000FF");
    assert.equal(result.steps[0].before.fills[0].fillColor, "#ff0000");
    assert.deepEqual(await f.editor.execute({ ...f.scope, planId: plan.id }), result);
    assert.equal(f.blocks(), 1);
    assert.throws(() => f.editor.cancel(plan.id), /无法取消/);
    const other = f.prepare();
    f.editor.cancel(other.id);
    await assert.rejects(f.editor.execute({ ...f.scope, planId: other.id }), /失效/);
});

test("rectangle radius is previewed without effects, applied to every corner and verified", async () => {
    const f = fixture();
    const plan = f.prepare([{ tool: "set_corner_radius", shapeId: id, borderRadius: 16 }]);
    assert.deepEqual(plan.targets[0].cornerRadii, [0, 0, 0, 0]);
    assert.equal(f.shape.borderRadius, 0);
    const result = await f.editor.execute({ ...f.scope, planId: plan.id });
    assert.equal(result.status, "success");
    assert.deepEqual(result.steps[0].after.cornerRadii, [16, 16, 16, 16]);
    const square = f.prepare([{ tool: "set_corner_radius", shapeId: id, borderRadius: 0 }]);
    assert.equal((await f.editor.execute({ ...f.scope, planId: square.id })).status, "success");
    assert.equal(f.shape.borderRadius, 0);
});

test("rectangle creation accepts a radius; invalid targets, invalid radii and stale corners are rejected", async () => {
    const f = fixture();
    const plan = f.prepare([
        {
            tool: "create_rectangle",
            name: "圆角矩形",
            x: 0,
            y: 0,
            width: 100,
            height: 60,
            color: "#FFFFFF",
            opacity: 1,
            borderRadius: 12,
        },
    ]);
    const result = await f.editor.execute({ ...f.scope, planId: plan.id });
    assert.equal(result.status, "success");
    assert.deepEqual(result.steps[0].after.cornerRadii, [12, 12, 12, 12]);
    for (const radius of [-1, Infinity, NaN, "16"]) {
        assert.throws(() => f.prepare([{ tool: "set_corner_radius", shapeId: id, borderRadius: radius }]));
    }
    const stale = f.prepare([{ tool: "set_corner_radius", shapeId: id, borderRadius: 8 }]);
    f.shape.borderRadiusBottomRight = 3;
    await assert.rejects(f.editor.execute({ ...f.scope, planId: stale.id }), /已修改/);
    f.shape.type = "text";
    assert.throws(() => f.prepare([{ tool: "set_corner_radius", shapeId: id, borderRadius: 8 }]), /类型不符/);
});

test("rejects stale targets, selection, page, missing shapes and expired plans before any write", async () => {
    for (const mutate of [
        (f) => {
            f.shape.width++;
        },
        (f) => {
            f.api.selection = [];
        },
        (f) => {
            f.api.currentPage.id = fileId;
        },
        (f) => {
            f.shapes.delete(id);
        },
        (f) => {
            f.editor.invalidate();
        },
        (f) => {
            f.notifyShapeChange();
        },
    ]) {
        const f = fixture();
        const plan = f.prepare();
        mutate(f);
        await assert.rejects(f.editor.execute({ ...f.scope, planId: plan.id }));
        assert.equal(f.blocks(), 0);
    }
});

test("all six fixed operations work, with explicit warnings outside selection", async () => {
    const f = fixture();
    f.shape.type = "text";
    const plan = f.prepare([
        { tool: "set_text", shapeId: id, text: "新文字" },
        { tool: "set_bounds", shapeId: id, x: 12, y: 34, width: 80, height: 30 },
        { tool: "set_fill", shapeId: id, color: "#0000ff", opacity: 0.5 },
        ...["create_rectangle", "create_text", "create_frame"].map((tool) => ({
            tool,
            name: "新增",
            x: 0,
            y: 0,
            width: 120,
            height: 60,
            color: "#ffffff",
            opacity: 1,
            ...(tool === "create_text" ? { text: "你好", fontFamily: "Inter", fontSize: 16 } : {}),
        })),
    ]);
    assert.equal(plan.outsideSelection, true);
    const result = await f.editor.execute({ ...f.scope, planId: plan.id });
    assert.equal(result.status, "success");
    assert.equal(result.steps.length, 6);
    assert.equal(f.shape.characters, "新文字");
    assert.equal(f.shapes.size, 4);
});

test("preflights entire batch and stops after partial failure without replaying writes", async () => {
    const f = fixture();
    assert.throws(() => f.prepare([{ tool: "set_text", shapeId: id, text: "wrong type" }]));
    assert.throws(() => f.prepare([{ tool: "set_fill", shapeId: fileId, color: "#0000ff", opacity: 1 }]));
    assert.throws(() => f.prepare([{ tool: "execute_code", code: "evil" }]));
    const plan = f.prepare([
        { tool: "set_fill", shapeId: id, color: "#0000ff", opacity: 1 },
        { tool: "create_rectangle", name: "新增", x: 0, y: 0, width: 10, height: 10, color: "#ffffff", opacity: 1 },
        { tool: "set_bounds", shapeId: id, x: 100, y: 100, width: 20, height: 20 },
    ]);
    f.api.createRectangle = () => {
        throw new Error("private contents");
    };
    const result = await f.editor.execute({ ...f.scope, planId: plan.id });
    assert.equal(result.status, "partial");
    assert.deepEqual(
        result.steps.map((s) => s.status),
        ["success", "failed", "skipped"]
    );
    assert.equal(f.shape.x, 0);
    assert.doesNotMatch(JSON.stringify(result), /private contents/);
    assert.deepEqual(await f.editor.execute({ ...f.scope, planId: plan.id }), result);
});

test("readback detects a silent setter failure and never reports success", async () => {
    const f = fixture();
    Object.defineProperty(f.shape, "fills", { get: () => [{ fillColor: "#FF0000", fillOpacity: 1 }], set: () => {} });
    const plan = f.prepare();
    const result = await f.editor.execute({ ...f.scope, planId: plan.id });
    assert.equal(result.status, "failed");
    assert.match(result.steps[0].message, /回读/);
});

test("context changes while awaiting layout stop subsequent steps", async () => {
    const f = fixture();
    f.api.waitForLayoutUpdate = async () => {
        f.editor.invalidate();
    };
    const plan = f.prepare([
        { tool: "set_fill", shapeId: id, color: "#0000FF", opacity: 1 },
        { tool: "set_bounds", shapeId: id, x: 10, y: 20, width: 30, height: 40 },
    ]);
    const result = await f.editor.execute({ ...f.scope, planId: plan.id });
    assert.deepEqual(
        result.steps.map((step) => step.status),
        ["failed", "skipped"]
    );
    assert.equal(f.shape.x, 0);
});
