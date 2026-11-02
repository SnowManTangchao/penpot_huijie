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
            appendChild(child) {
                child.parent = this;
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
        uploadMediaData: async () => ({ id: "99999999-9999-4999-8999-999999999999", width: 1, height: 1 }),
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

const png = {
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
    width: 1,
    height: 1,
};

test("image candidate is inserted only on confirmation and replacement preserves identity and geometry", async () => {
    const f = fixture();
    const plan = f.prepare([{ tool: "create_image", name: "候选", x: 200, y: 100, width: 1, height: 1, image: png }]);
    assert.equal(f.shapes.size, 1);
    const result = await f.editor.execute({ ...f.scope, planId: plan.id });
    assert.equal(result.status, "success");
    assert.equal(result.steps[0].after.fills[0].fillImage.id, "99999999-9999-4999-8999-999999999999");
    f.shape.fills = [
        { fillImage: { id: "old-image" }, fillOpacity: 0.6 },
        { fillColor: "#123456", fillOpacity: 0.2 },
    ];
    const before = {
        id: f.shape.id,
        x: f.shape.x,
        y: f.shape.y,
        parent: f.shape.parent,
        width: f.shape.width,
        height: f.shape.height,
    };
    const replacement = f.prepare([{ tool: "set_image", shapeId: id, image: png }]);
    assert.equal(f.shape.fills[0].fillImage.id, "old-image");
    const replaced = await f.editor.execute({ ...f.scope, planId: replacement.id });
    assert.equal(replaced.status, "success");
    assert.equal(f.shape.fills[0].fillOpacity, 0.6);
    assert.deepEqual(f.shape.fills[1], { fillColor: "#123456", fillOpacity: 0.2 });
    assert.deepEqual(
        {
            id: f.shape.id,
            x: f.shape.x,
            y: f.shape.y,
            parent: f.shape.parent,
            width: f.shape.width,
            height: f.shape.height,
        },
        before
    );
});

test("image upload failure creates no blank shape and context change during upload prevents fill replacement", async () => {
    const f = fixture();
    f.api.uploadMediaData = async () => {
        throw new Error("upload failed");
    };
    const plan = f.prepare([{ tool: "create_image", name: "候选", x: 0, y: 0, width: 1, height: 1, image: png }]);
    assert.equal((await f.editor.execute({ ...f.scope, planId: plan.id })).status, "failed");
    assert.equal(f.shapes.size, 1);
    f.shape.fills = [{ fillImage: { id: "old-image" } }];
    const replacement = f.prepare([{ tool: "set_image", shapeId: id, image: png }]);
    f.api.uploadMediaData = async () => {
        f.api.currentPage.id = crypto.randomUUID();
        return { id: "new-image", width: 1, height: 1 };
    };
    assert.equal((await f.editor.execute({ ...f.scope, planId: replacement.id })).status, "failed");
    assert.equal(f.shape.fills[0].fillImage.id, "old-image");
});

test("creates nested editable content in bounded batches and verifies parent links", async () => {
    const f = fixture();
    const base = { name: "区域", x: 10, y: 20, width: 100, height: 50, color: "#ffffff", opacity: 1 };
    const plan = f.prepare([
        { ...base, tool: "create_frame", ref: "root" },
        ...Array.from({ length: 24 }, (_, i) => ({
            ...base,
            tool: "create_rectangle",
            ref: `item${i}`,
            parentRef: "root",
        })),
    ]);
    assert.equal(f.shapes.size, 1);
    const first = await f.editor.execute({ ...f.scope, planId: plan.id, batchIndex: 0 });
    assert.equal(first.hasMore, true);
    assert.equal(first.steps.length, 10);
    await f.editor.execute({ ...f.scope, planId: plan.id, batchIndex: 1 });
    const result = await f.editor.execute({ ...f.scope, planId: plan.id, batchIndex: 2 });
    assert.equal(result.status, "success");
    assert.equal(result.batches.length, 3);
    const rootId = result.steps[0].shapeId;
    assert.ok(result.steps.slice(1).every((s) => s.after.parentId === rootId));
    assert.equal(result.steps.length, 25);
});

test("rejects forward, duplicate and non-container parent references without creating objects", () => {
    const f = fixture();
    const base = { name: "区域", x: 0, y: 0, width: 100, height: 50, color: "#ffffff", opacity: 1 };
    for (const operations of [
        [{ ...base, tool: "create_rectangle", parentRef: "missing" }],
        [
            { ...base, tool: "create_frame", ref: "a" },
            { ...base, tool: "create_frame", ref: "a" },
        ],
        [
            { ...base, tool: "create_rectangle", ref: "a" },
            { ...base, tool: "create_rectangle", parentRef: "a" },
        ],
    ]) {
        assert.throws(() => f.prepare(operations), /引用/);
    }
    assert.equal(f.shapes.size, 1);
});

test("between batches rejects replay, stale created objects and changed page before creating more", async () => {
    const f = fixture();
    const plan = f.prepare(
        Array.from({ length: 21 }, (_, i) => ({
            tool: "create_frame",
            name: `区域${i}`,
            ref: `node${i}`,
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            color: "#ffffff",
            opacity: 1,
        }))
    );
    const first = await f.editor.execute({ ...f.scope, planId: plan.id, batchIndex: 0 });
    await assert.rejects(f.editor.execute({ ...f.scope, planId: plan.id, batchIndex: 0 }), /批次顺序/);
    assert.equal(f.shapes.size, 11);
    f.shapes.get(first.steps[0].shapeId).x = 999;
    await assert.rejects(f.editor.execute({ ...f.scope, planId: plan.id, batchIndex: 1 }), /对象已修改/);
    assert.equal(f.shapes.size, 11);
});

test("reuses actual local color and typography assets and rejects stale asset previews", async () => {
    const f = fixture();
    const color = {
        id: "brand",
        color: "#112233",
        opacity: 0.8,
        asFill: () => ({ fillColor: "#112233", fillOpacity: 0.8, fillColorRefId: "brand" }),
    };
    const typography = {
        id: "body",
        fontFamily: "Inter",
        fontSize: "18",
        applyToText: (s) => {
            s.fontFamily = "Inter";
            s.fontSize = "18";
            s.typographyRefId = "body";
        },
    };
    f.api.library = { local: { colors: [color], typographies: [typography], components: [] } };
    const op = {
        tool: "create_text",
        name: "标题",
        text: "设备",
        x: 0,
        y: 0,
        width: 200,
        height: 40,
        color: "#112233",
        opacity: 0.8,
        colorRef: "brand",
        typographyRef: "body",
        fontFamily: "Inter",
        fontSize: 18,
    };
    const plan = f.prepare([op]);
    const result = await f.editor.execute({ ...f.scope, planId: plan.id });
    assert.equal(result.status, "success");
    assert.equal(result.steps[0].after.fills[0].fillColorRefId, "brand");
    assert.equal(f.shapes.get(result.steps[0].shapeId).typographyRefId, "body");
    const stale = f.prepare([op]);
    color.color = "#000000";
    const failed = await f.editor.execute({ ...f.scope, planId: stale.id });
    assert.equal(failed.status, "failed");
    assert.equal(f.shapes.size, 2);
});

test("final readback catches earlier geometry changed by later layout updates", async () => {
    const f = fixture();
    const plan = f.prepare(
        [0, 1].map((i) => ({
            tool: "create_frame",
            name: `区域${i}`,
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            color: "#ffffff",
            opacity: 1,
        }))
    );
    let firstId;
    f.api.waitForLayoutUpdate = async () => {
        if (!firstId) {
            firstId = [...f.shapes.keys()].at(-1);
        } else {
            f.shapes.get(firstId).x = 999;
        }
    };
    const result = await f.editor.execute({ ...f.scope, planId: plan.id });
    assert.equal(result.status, "partial");
    assert.equal(result.steps[0].status, "failed");
    assert.match(result.steps[0].message, /最终回读/);
});

test("cancellation during generation stops at an operation boundary and records created object IDs", async () => {
    const f = fixture();
    const base = { name: "区域", x: 0, y: 0, width: 100, height: 50, color: "#ffffff", opacity: 1 };
    const plan = f.prepare(Array.from({ length: 21 }, (_, i) => ({ ...base, tool: "create_frame", ref: `node${i}` })));
    let reads = 0;
    f.api.waitForLayoutUpdate = async () => {
        if (++reads === 2) {
            f.editor.cancel(plan.id);
        }
    };
    const result = await f.editor.execute({ ...f.scope, planId: plan.id });
    assert.equal(result.cancelled, true);
    assert.equal(result.status, "partial");
    assert.equal(result.steps.filter((s) => s.status === "success").length, 2);
    assert.ok(result.steps.slice(2).every((s) => s.status === "skipped"));
    assert.equal(f.shapes.size, 3);
});

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
