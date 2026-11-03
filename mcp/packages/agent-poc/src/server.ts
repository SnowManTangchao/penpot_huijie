import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AgentHttpServer } from "./AgentHttpServer";
import { CompatibleImageProvider } from "./AdvancedDesignService";
import { z } from "zod";

async function main() {
    let apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey && process.env.OPENCODE_AUTH_FILE) {
        const auth = JSON.parse(await readFile(process.env.OPENCODE_AUTH_FILE, "utf8"));
        if (auth["opencode-go"]?.type === "api") {
            apiKey = auth["opencode-go"].key;
        }
    }
    const modelIds = [
        ...new Set(
            (process.env.AI_MODELS ?? process.env.AI_MODEL ?? "")
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean)
        ),
    ];
    if (!apiKey || modelIds.length === 0 || !process.env.PENPOT_AGENT_ORIGIN) {
        throw new Error("请配置 AI_MODEL/AI_MODELS、服务端密钥和 PENPOT_AGENT_ORIGIN。");
    }
    const provider = createOpenAICompatible({
        name: "penpot-native-agent",
        apiKey,
        baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        headers: { "User-Agent": "penpot-native-agent/0.1.0", "x-opencode-session": randomUUID() },
    });
    const app = new AgentHttpServer({
        reasoning: z.enum(["low", "medium", "high"]).optional().parse(process.env.AI_REASONING_EFFORT),
        origin: new URL(process.env.PENPOT_AGENT_ORIGIN).origin,
        backend: new URL(process.env.PENPOT_BACKEND_URL ?? "http://127.0.0.1:6060/"),
        mcp: new URL(process.env.PENPOT_AGENT_MCP_URL ?? "http://localhost:4401/mcp/agent"),
        models: new Map(modelIds.map((id) => [id, provider.chatModel(id)])),
        ...(process.env.AI_IMAGE_MODEL
            ? {
                  imageProvider: new CompatibleImageProvider(
                      new URL(
                          process.env.AI_IMAGE_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/"
                      ),
                      process.env.AI_IMAGE_API_KEY ?? apiKey,
                      process.env.AI_IMAGE_MODEL,
                      process.env.AI_IMAGE_LICENSE ?? "依模型供应商条款；使用前核对商用与参考图权利"
                  ),
              }
            : {}),
    });
    app.server.listen(Number(process.env.PENPOT_AGENT_PORT ?? 4404), "127.0.0.1", () =>
        console.log("Penpot 原生 AI 服务已启动。")
    );
}

main().catch(() => {
    console.error("AI 服务启动失败，请检查服务端模型配置。");
    process.exitCode = 1;
});
