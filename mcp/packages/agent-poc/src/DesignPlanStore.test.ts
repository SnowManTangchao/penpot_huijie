import assert from "node:assert/strict";
import test from "node:test";
import { DesignPlanStore } from "./DesignPlanStore";
import type { DesignPlan, DesignExecution } from "@penpot/mcp-common";

const scope = {
    fileId: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
    selectedIds: [],
    selectionCount: 0,
};
const plan: DesignPlan = {
    id: "33333333-3333-4333-8333-333333333333",
    expiresAt: Date.now() + 300_000,
    outsideSelection: true,
    operations: [
        { tool: "create_rectangle", name: "矩形", x: 0, y: 0, width: 100, height: 50, color: "#0000ff", opacity: 1 },
    ],
    targets: [],
};
const result: DesignExecution = {
    planId: plan.id,
    status: "success",
    steps: [{ tool: "create_rectangle", status: "success" }],
};

test("binds confirmation to owner, editor, file and page; cancellation forbids writes", async () => {
    const store = new DesignPlanStore();
    store.add("alice", "tab", scope, plan);
    const execute = async () => result;
    await assert.rejects(store.execute("bob", "tab", scope, plan.id, execute));
    await assert.rejects(store.execute("alice", "other-tab", scope, plan.id, execute));
    await assert.rejects(store.execute("alice", "tab", { ...scope, pageId: scope.fileId }, plan.id, execute));
    store.cancel("alice", "tab", scope, plan.id);
    await assert.rejects(store.execute("alice", "tab", scope, plan.id, execute), /取消/);
});

test("returns saved result for duplicate confirmation and refuses in-flight or unknown outcomes", async () => {
    const store = new DesignPlanStore();
    store.add("alice", "tab", scope, plan);
    let finish: (value: DesignExecution) => void = () => {};
    const first = store.execute(
        "alice",
        "tab",
        scope,
        plan.id,
        () =>
            new Promise((resolve) => {
                finish = resolve;
            })
    );
    await assert.rejects(
        store.execute("alice", "tab", scope, plan.id, async () => result),
        /正在执行/
    );
    finish(result);
    assert.deepEqual(await first, result);
    assert.deepEqual(
        await store.execute("alice", "tab", scope, plan.id, async () => {
            throw Error("must not replay");
        }),
        result
    );
    const failed = new DesignPlanStore();
    failed.add("alice", "tab", scope, plan);
    await assert.rejects(
        failed.execute("alice", "tab", scope, plan.id, async () => {
            throw Error("network");
        })
    );
    await assert.rejects(
        failed.execute("alice", "tab", scope, plan.id, async () => result),
        /未知/
    );
});

test("expired plans cannot be confirmed", async () => {
    const store = new DesignPlanStore();
    store.add("alice", "tab", scope, { ...plan, expiresAt: Date.now() - 1 });
    await assert.rejects(
        store.execute("alice", "tab", scope, plan.id, async () => result),
        /过期/
    );
});

test("iteration history is bounded and scoped to the authenticated account, editor, file and page", async () => {
    const store = new DesignPlanStore();
    for (let i = 0; i < 5; i++) {
        const item = { ...plan, id: crypto.randomUUID() };
        store.add("alice", "tab", scope, item);
        await store.execute("alice", "tab", scope, item.id, async () => ({ ...result, planId: item.id }));
    }
    assert.equal(store.getHistory("alice", "tab", scope).length, 3);
    assert.deepEqual(store.getHistory("bob", "tab", scope), []);
    assert.deepEqual(store.getHistory("alice", "other-tab", scope), []);
    assert.deepEqual(store.getHistory("alice", "tab", { ...scope, pageId: scope.fileId }), []);
});
