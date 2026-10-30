import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import type { DesignContext } from "@penpot/mcp-common";
import { NativeDesignAgent, chatRequestSchema, type AgentEvent } from "./NativeDesignAgent";

const fileId = "11111111-1111-4111-8111-111111111111";
const pageId = "22222222-2222-4222-8222-222222222222";
const shapeId = "33333333-3333-4333-8333-333333333333";
const context: DesignContext = {
    file: { id: fileId, name: "商店", revision: 1 },
    page: { id: pageId, name: "首页" },
    selectedIds: [shapeId],
    selectionCount: 1,
    truncated: true,
    shapes: [
        {
            id: shapeId,
            name: "购买",
            type: "text",
            parentId: null,
            x: 0,
            y: 0,
            width: 100,
            height: 40,
            hidden: false,
            text: "立即购买",
            fills: [{ color: "#ff0000" }],
            childrenTruncated: false,
        },
    ],
};
const request = chatRequestSchema.parse({
    fileId,
    pageId,
    sessionId: "tab",
    selectedIds: [shapeId],
    selectionCount: 1,
    model: "test",
    messages: [{ role: "user", content: "选区是什么？" }],
});

function model(answer: string) {
    const finish = {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
    } as const;
    return new MockLanguageModelV4({
        doStream: [
            {
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({
                            type: "tool-call",
                            toolCallId: "read",
                            toolName: "get_current_file_context",
                            input: "{}",
                        });
                        controller.enqueue({ ...finish, finishReason: { unified: "tool-calls", raw: "tool_calls" } });
                        controller.close();
                    },
                }),
            },
            {
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({ type: "text-start", id: "answer" });
                        controller.enqueue({ type: "text-delta", id: "answer", delta: answer });
                        controller.enqueue({ type: "text-end", id: "answer" });
                        controller.enqueue(finish);
                        controller.close();
                    },
                }),
            },
        ],
    });
}

test("streams tool states and text, injects current context and verifies final references", async () => {
    const llm = model(`选中的 [购买](penpot-shape:${shapeId}) 为100×40，填充 #ff0000。上下文不完整。`);
    const events: AgentEvent[] = [];
    for await (const event of new NativeDesignAgent(llm, { read: async () => context }).answer(
        request,
        AbortSignal.timeout(5000)
    )) {
        events.push(event);
    }
    assert.equal(events[0].type, "context");
    assert.ok(events.some((event) => event.type === "delta"));
    assert.ok(events.some((event) => event.type === "tool" && event.status === "complete"));
    assert.deepEqual(events.at(-1), {
        type: "done",
        answer: `选中的 [购买](penpot-shape:${shapeId}) 为100×40，填充 #ff0000。上下文不完整。`,
        citedShapeIds: [shapeId],
    });
    assert.match(JSON.stringify(llm.doStreamCalls[0].prompt), /立即购买/);
    assert.deepEqual(
        llm.doStreamCalls[0].tools?.map((tool) => tool.name),
        ["get_current_file_context", "get_current_page", "get_selected_shapes", "get_shape_tree"]
    );
});

test("refuses changed page or selection before sending design data to model", async () => {
    for (const changed of [
        { ...request, pageId: fileId },
        { ...request, selectedIds: [] },
        { ...request, selectionCount: 2 },
    ]) {
        const llm = model("unused");
        await assert.rejects(async () => {
            for await (const _ of new NativeDesignAgent(llm, { read: async () => context }).answer(
                changed,
                AbortSignal.timeout(5000)
            )) {
                /* 消费流以触发范围检查。 */
            }
        }, /已改变/);
        assert.equal(llm.doStreamCalls.length, 0);
    }
});

test("never marks invented or missing references as completed", async () => {
    for (const answer of ["没有引用", "[虚构图层](penpot-shape:foreign)"]) {
        const events: AgentEvent[] = [];
        await assert.rejects(async () => {
            for await (const event of new NativeDesignAgent(model(answer), { read: async () => context }).answer(
                request,
                AbortSignal.timeout(5000)
            )) {
                events.push(event);
            }
        }, /引用/);
        assert.equal(
            events.some((event) => event.type === "done"),
            false
        );
    }
});

test("rejects browser supplied user identity, code and unbounded history", () => {
    assert.equal(chatRequestSchema.safeParse({ ...request, profileId: fileId }).success, false);
    assert.equal(chatRequestSchema.safeParse({ ...request, code: "execute()" }).success, false);
    assert.equal(
        chatRequestSchema.safeParse({ ...request, messages: Array(13).fill(request.messages[0]) }).success,
        false
    );
});
