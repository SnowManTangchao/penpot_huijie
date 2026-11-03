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

const screenshot = {
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoYPgPAAKDAYCtaVe6AAAAAElFTkSuQmCC",
    width: 1,
    height: 1,
};

test("图片消息经过校验后将图片字节传给模型", async () => {
    const input = chatRequestSchema.parse({
        ...request,
        messages: [{ role: "user", content: "参考这张截图", image: screenshot }],
    });
    const llm = model(`截图参考 [购买](penpot-shape:${shapeId})。`);
    for await (const _event of new NativeDesignAgent(llm, { read: async () => context }, undefined, [], "low").answer(
        input,
        AbortSignal.timeout(5000)
    )) {
    }
    const user = llm.doStreamCalls[0].prompt.find((message) => message.role === "user");
    assert.ok(user && Array.isArray(user.content));
    const image = user.content.find((part) => part.type === "file");
    assert.ok(image && image.data.type === "data");
    const bytes =
        typeof image.data.data === "string" ? Buffer.from(image.data.data, "base64") : Buffer.from(image.data.data);
    assert.deepEqual(bytes, Buffer.from(screenshot.data, "base64"));
    assert.equal(llm.doStreamCalls[0].reasoning, "low");
});

test("拒绝伪造图片和助手消息中的图片", () => {
    for (const message of [
        { role: "user", content: "图片", image: { ...screenshot, data: "https://example.com/image.png" } },
        { role: "assistant", content: "图片", image: screenshot },
    ]) {
        assert.equal(
            chatRequestSchema.safeParse({ ...request, messages: [message, ...request.messages] }).success,
            false
        );
    }
});

test("模型等待超时保留超时原因，不误报为模型或工具错误", async () => {
    const controller = new AbortController();
    const llm = new MockLanguageModelV4({
        doStream: async () => ({
            stream: new ReadableStream({
                start(stream) {
                    controller.abort(new DOMException("model deadline", "TimeoutError"));
                    stream.error(controller.signal.reason);
                },
            }),
        }),
    });
    await assert.rejects(
        async () => {
            for await (const _event of new NativeDesignAgent(llm, { read: async () => context }).answer(
                request,
                controller.signal
            )) {
            }
        },
        { name: "TimeoutError" }
    );
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
        [
            "request_design_clarification",
            "get_design_system",
            "get_current_file_context",
            "get_current_page",
            "get_selected_shapes",
            "get_shape_tree",
        ]
    );
});

function toolModel(name: string, input: unknown) {
    const llm = model("请核对方案。");
    const original = llm.doStream;
    let call = 0;
    llm.doStream = async (options) => {
        if (++call !== 2) {
            return original(options);
        }
        return {
            stream: new ReadableStream({
                start(controller) {
                    controller.enqueue({
                        type: "tool-call",
                        toolCallId: "proposal",
                        toolName: name,
                        input: JSON.stringify(input),
                    });
                    controller.enqueue({
                        type: "finish",
                        finishReason: { unified: "tool-calls", raw: "tool_calls" },
                        usage: {
                            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                            outputTokens: { total: 10, text: 10, reasoning: 0 },
                        },
                    });
                    controller.close();
                },
            }),
        };
    };
    return llm;
}

test("模型修正无效参数后仍能提交有效预览，修正前不生成计划", async () => {
    const llm = toolModel("set_fill", { shapeId, color: "invalid", opacity: 1 });
    const original = llm.doStream;
    const operation = { tool: "set_fill" as const, shapeId, color: "#0000FF", opacity: 1 };
    let step = 0;
    llm.doStream = async (options) => {
        if (++step !== 3) {
            return original(options);
        }
        return {
            stream: new ReadableStream({
                start(controller) {
                    controller.enqueue({
                        type: "tool-call",
                        toolCallId: "corrected",
                        toolName: "set_fill",
                        input: JSON.stringify({ shapeId, color: operation.color, opacity: 1 }),
                    });
                    controller.enqueue({
                        type: "finish",
                        finishReason: { unified: "tool-calls", raw: "tool_calls" },
                        usage: {
                            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                            outputTokens: { total: 10, text: 10, reasoning: 0 },
                        },
                    });
                    controller.close();
                },
            }),
        };
    };
    const events: AgentEvent[] = [];
    let saved: unknown;
    const agent = new NativeDesignAgent(llm, { read: async () => context }, async (operations) => {
        saved = operations;
        return { id: fileId, expiresAt: Date.now() + 300000, outsideSelection: false, targets: [], operations };
    });
    for await (const event of agent.answer(request, AbortSignal.timeout(5000))) {
        events.push(event);
        if (event.type === "tool" && event.status === "retrying") {
            assert.equal(saved, undefined);
        }
    }
    assert.deepEqual(saved, [operation]);
    assert.ok(events.some((event) => event.type === "tool" && event.status === "retrying"));
    assert.equal(events.at(-1)?.type, "done");
});

test("校验失败且未修正时不生成预览或报告成功", async () => {
    let saved: unknown;
    const agent = new NativeDesignAgent(
        toolModel("set_fill", { shapeId, color: "invalid", opacity: 1 }),
        { read: async () => context },
        async (operations) => {
            saved = operations;
            return { id: fileId, expiresAt: Date.now() + 300000, outsideSelection: false, targets: [], operations };
        }
    );
    const events: AgentEvent[] = [];
    await assert.rejects(async () => {
        for await (const event of agent.answer(request, AbortSignal.timeout(5000))) events.push(event);
    }, /未能修正操作参数/);
    assert.equal(saved, undefined);
    assert.equal(
        events.some((event) => ["plan", "plans", "done"].includes(event.type)),
        false
    );
});

test("其他有效操作不能掩盖尚未修正的参数错误", async () => {
    const llm = toolModel("set_fill", { shapeId, color: "invalid", opacity: 1 });
    const original = llm.doStream;
    let step = 0;
    llm.doStream = async (options) => {
        const result = await original(options);
        if (++step !== 2) return result;
        return {
            ...result,
            stream: result.stream.pipeThrough(
                new TransformStream({
                    transform(part, controller) {
                        if (part.type === "finish") {
                            controller.enqueue({
                                type: "tool-call",
                                toolCallId: "unrelated",
                                toolName: "set_text",
                                input: JSON.stringify({ shapeId, text: "有效文字" }),
                            });
                        }
                        controller.enqueue(part);
                    },
                })
            ),
        };
    };
    let saved: unknown;
    const agent = new NativeDesignAgent(llm, { read: async () => context }, async (operations) => {
        saved = operations;
        return { id: fileId, expiresAt: Date.now() + 300000, outsideSelection: false, targets: [], operations };
    });
    await assert.rejects(async () => {
        for await (const _event of agent.answer(request, AbortSignal.timeout(5000))) {
        }
    }, /未能修正操作参数/);
    assert.equal(saved, undefined);
});

test("whole-page alternatives stay preview-only and carry their validated layout summaries", async () => {
    const page = {
        title: "设备仪表盘",
        pageType: "dashboard",
        goal: "查看设备",
        roles: ["操作员"],
        interactions: [],
        style: "简洁",
        assumptions: [],
        width: 1200,
        height: 800,
        nodes: [{ key: "root", type: "container", name: "页面", width: 1200, height: 800 }],
    };
    const llm = toolModel("propose_page_layout", {
        alternatives: [
            page,
            {
                ...page,
                title: "顶栏仪表盘",
                nodes: [
                    ...page.nodes,
                    { key: "header", parent: "root", type: "shape", name: "顶栏", width: 1200, height: 60 },
                ],
            },
        ],
    });
    const original = llm.doStream;
    let step = 0;
    llm.doStream = async (options) => {
        if (++step > 2) {
            throw new Error("方案已经通过校验，后续说明请求超时不应阻塞预览。");
        }
        return original(options);
    };
    const prepared: unknown[] = [];
    const events: AgentEvent[] = [];
    for await (const event of new NativeDesignAgent(
        llm,
        { read: async () => context },
        async (operations, generation) => {
            prepared.push(generation);
            return {
                id: crypto.randomUUID(),
                expiresAt: Date.now() + 300000,
                outsideSelection: true,
                operations,
                targets: [],
                generation,
            };
        }
    ).answer(
        { ...request, messages: [{ role: "user", content: "生成两个设备仪表盘方案" }] },
        AbortSignal.timeout(5000)
    )) {
        events.push(event);
    }
    assert.equal(prepared.length, 2);
    const event = events.find((e) => e.type === "plans");
    assert.ok(event?.type === "plans");
    assert.equal(event.plans.length, 2);
    assert.equal(event.plans[0].operations[0].tool, "create_frame");
    assert.equal(event.plans[1].generation?.title, "顶栏仪表盘");
    assert.equal(events.at(-1)?.type, "done");
});

test("missing business requirements produce questions without preparing writes or invented citations", async () => {
    const llm = toolModel("request_design_clarification", { questions: ["页面供哪个角色使用？"] });
    const events: AgentEvent[] = [];
    for await (const event of new NativeDesignAgent(llm, { read: async () => context }, async () => {
        throw Error("不得生成计划");
    }).answer(request, AbortSignal.timeout(5000))) {
        events.push(event);
    }
    assert.deepEqual(events.at(-1), { type: "done", answer: "1. 页面供哪个角色使用？", citedShapeIds: [] });
    assert.equal(
        events.some((e) => e.type === "plan" || e.type === "plans"),
        false
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

test("model write tools generate a preview only, without exposing confirmation or execution", async () => {
    const llm = model("计划已生成，请确认。");
    const original = llm.doStream;
    let call = 0;
    llm.doStream = async (options) => {
        call++;
        if (call !== 2) {
            return original(options);
        }
        return {
            stream: new ReadableStream({
                start(controller) {
                    controller.enqueue({
                        type: "tool-call",
                        toolCallId: "fill",
                        toolName: "set_fill",
                        input: JSON.stringify({ shapeId, color: "#0000FF", opacity: 1 }),
                    });
                    controller.enqueue({
                        type: "finish",
                        finishReason: { unified: "tool-calls", raw: "tool_calls" },
                        usage: {
                            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                            outputTokens: { total: 10, text: 10, reasoning: 0 },
                        },
                    });
                    controller.close();
                },
            }),
        };
    };
    let saved: unknown;
    const plan = {
        id: fileId,
        expiresAt: Date.now() + 300000,
        outsideSelection: false,
        targets: [],
        operations: [{ tool: "set_fill" as const, shapeId, color: "#0000FF", opacity: 1 }],
    };
    const events: AgentEvent[] = [];
    for await (const event of new NativeDesignAgent(llm, { read: async () => context }, async (operations) => {
        saved = operations;
        return plan;
    }).answer(
        { ...request, messages: [{ role: "user", content: "把选中的矩形改成蓝色" }] },
        AbortSignal.timeout(5000)
    )) {
        events.push(event);
    }
    assert.deepEqual(saved, plan.operations);
    assert.ok(events.some((event) => event.type === "plan"));
    const tools = llm.doStreamCalls[0].tools?.map((tool) => tool.name) ?? [];
    assert.ok(tools.includes("create_frame") && tools.includes("set_fill"));
    assert.ok(tools.includes("set_corner_radius"));
    assert.equal(
        tools.some((name) => /execute|confirm|code/.test(name)),
        false
    );
});
