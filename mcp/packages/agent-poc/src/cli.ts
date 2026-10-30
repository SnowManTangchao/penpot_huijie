import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { designContextInputSchema } from "@penpot/mcp-common";
import { DesignQuestionAgent } from "./DesignQuestionAgent";
import { McpDesignContextSource } from "./McpDesignContextSource";

async function main() {
    const scope = designContextInputSchema.parse({
        fileId: process.env.PENPOT_FILE_ID,
        pageId: process.env.PENPOT_PAGE_ID,
    });
    const source = new McpDesignContextSource(scope, process.env.PENPOT_SESSION_ID);
    const question = process.argv.slice(2).join(" ");
    const inspect = question === "--context";
    const modelId = process.env.AI_MODEL;
    let apiKey = process.env.OPENAI_API_KEY;
    if (!inspect && !apiKey && process.env.OPENCODE_AUTH_FILE) {
        const auth = JSON.parse(await readFile(process.env.OPENCODE_AUTH_FILE, "utf8"));
        const credential = auth["opencode-go"];
        if (credential?.type === "api" && typeof credential.key === "string") {
            apiKey = credential.key;
        }
    }
    if (!inspect && (!modelId || !apiKey || !question.trim())) {
        throw new Error("请配置 AI_MODEL、OPENAI_API_KEY，并提供设计问题；仅核对上下文可使用 --context。");
    }
    try {
        await source.connect(
            new URL(process.env.PENPOT_MCP_URL ?? "http://localhost:4401/mcp"),
            process.env.PENPOT_MCP_TOKEN
        );
        if (inspect) {
            console.log(JSON.stringify(await source.read(), null, 2));
        } else {
            const provider = createOpenAICompatible({
                name: "penpot-agent-poc",
                apiKey,
                baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
                headers: {
                    "User-Agent": "penpot-design-agent-poc/0.1.0",
                    "x-opencode-session": randomUUID(),
                },
            });
            const result = await new DesignQuestionAgent(provider.chatModel(modelId!), source).ask(question);
            console.log(JSON.stringify(result, null, 2));
        }
    } finally {
        await source.close();
    }
}

main().catch(() => {
    // 不输出 SDK 异常对象，避免请求头或密钥出现在终端日志中。
    console.error("PoC 失败。请检查环境变量、MCP 插件连接、当前文件/页面和模型的 Tool Calling 支持。");
    process.exitCode = 1;
});
