import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import type { DesignContext } from "@penpot/mcp-common";
import { DesignQuestionAgent } from "./DesignQuestionAgent";

const context: DesignContext = {
    file: { id: "file", name: "商店", revision: 1 },
    page: { id: "page", name: "结算" },
    selectedIds: ["buy"],
    selectionCount: 1,
    truncated: false,
    shapes: [
        {
            id: "buy",
            name: "购买按钮",
            type: "text",
            parentId: null,
            x: 10,
            y: 20,
            width: 100,
            height: 40,
            hidden: false,
            text: "立即购买",
            fills: [{ color: "#ff0000" }],
            childrenTruncated: false,
        },
    ],
};

function model(answer: string) {
    const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
    };
    return new MockLanguageModelV4({
        doGenerate: [
            {
                content: [
                    { type: "tool-call", toolCallId: "read", toolName: "get_current_design_context", input: "{}" },
                ],
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage,
                warnings: [],
            },
            {
                content: [{ type: "text", text: answer }],
                finishReason: { unified: "stop", raw: "stop" },
                usage,
                warnings: [],
            },
        ],
    });
}

test("AI SDK executes the read tool and makes the snapshot available to the answer step", async () => {
    const llm = model("选中的 [购买按钮](penpot-shape:buy) 文本为“立即购买”，填充色为 #ff0000。");
    const result = await new DesignQuestionAgent(llm, { read: async () => context }).ask("选中了什么？");
    assert.deepEqual(result.citedShapeIds, ["buy"]);
    assert.deepEqual(result.context.selectedIds, ["buy"]);
    assert.match(JSON.stringify(llm.doGenerateCalls[1].prompt), /立即购买/);
    assert.deepEqual(
        llm.doGenerateCalls[0].tools?.map((item) => item.name),
        ["get_current_design_context"]
    );
});

test("rejects invented layer references", async () => {
    await assert.rejects(
        new DesignQuestionAgent(model("[陌生图层](penpot-shape:foreign)"), {
            read: async () => context,
        }).ask("当前页面是什么？"),
        /不存在/
    );
});

test("requires design object references when layers are present", async () => {
    await assert.rejects(
        new DesignQuestionAgent(model("这是一个商店。"), {
            read: async () => context,
        }).ask("当前页面是什么？"),
        /没有引用/
    );
});

test("does not return an answer if the read tool fails", async () => {
    await assert.rejects(
        new DesignQuestionAgent(model("[购买按钮](penpot-shape:buy)"), {
            read: async () => {
                throw new Error("Disconnected");
            },
        }).ask("当前选区是什么？")
    );
});

test("rejects an empty question", async () => {
    await assert.rejects(new DesignQuestionAgent(model(""), { read: async () => context }).ask(" "));
});
