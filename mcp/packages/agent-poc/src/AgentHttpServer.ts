import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { LanguageModel } from "ai";
import { NativeDesignAgent, chatRequestSchema, type AgentEvent } from "./NativeDesignAgent";
import { McpDesignContextSource } from "./McpDesignContextSource";
import { PenpotSession } from "./PenpotSession";

export interface AgentServerOptions {
    origin: string;
    backend: URL;
    mcp: URL;
    models: Map<string, LanguageModel>;
}

/** 同源的原生助手入口；仅在内存处理当前请求，不保存聊天、设计数据或凭据。 */
export class AgentHttpServer {
    readonly server = createServer((req, res) => {
        void this.handle(req, res);
    });
    private readonly sessions: PenpotSession;
    private readonly active = new Set<string>();

    constructor(private readonly options: AgentServerOptions) {
        this.sessions = new PenpotSession(options.backend);
        if (options.mcp.pathname !== "/mcp/agent") {
            throw new Error("原生助手必须使用 /mcp/agent 只读入口。");
        }
        this.server.requestTimeout = 15_000;
        this.server.headersTimeout = 10_000;
    }

    private async send(res: ServerResponse, event: AgentEvent, signal: AbortSignal) {
        if (res.destroyed) {
            throw new Error("连接已关闭");
        }
        if (!res.write(JSON.stringify(event) + "\n")) {
            await once(res, "drain", { signal });
        }
    }

    private async handle(req: IncomingMessage, res: ServerResponse) {
        const controller = new AbortController();
        let source: McpDesignContextSource | undefined;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
        res.on("close", () => {
            controller.abort();
            void source?.close().catch(() => undefined);
        });
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        let owner: string | undefined;
        let stage = "请检查登录状态、文件权限和 MCP 连接。";
        try {
            const config = req.method === "GET" && req.url === "/api/agent/config";
            const chat = req.method === "POST" && req.url === "/api/agent/chat";
            if (!config && !chat) {
                res.writeHead(404).end();
                return;
            }
            if (
                (chat && req.headers.origin !== this.options.origin) ||
                (req.headers.origin && req.headers.origin !== this.options.origin) ||
                (req.headers["sec-fetch-site"] &&
                    !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))
            ) {
                res.writeHead(403).end();
                return;
            }
            if (config) {
                await this.sessions.authenticate(req.headers.cookie, signal);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ models: [...this.options.models.keys()] }));
                return;
            }
            if (!req.headers["content-type"]?.startsWith("application/json")) {
                res.writeHead(415).end();
                return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > 64_000) {
                    res.writeHead(413).end();
                    return;
                }
                chunks.push(chunk);
            }
            stage = "请求无效，请缩短对话或重新打开 AI 面板。";
            const request = chatRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            const model = this.options.models.get(request.model);
            if (!model) {
                throw new Error("模型未配置");
            }
            stage = "请检查登录状态、文件读权限，并启用 MCP。";
            const session = await this.sessions.authorize(req.headers.cookie ?? "", request.fileId, signal);
            if (this.active.has(session.profileId) || this.active.size >= 32) {
                res.writeHead(429).end();
                return;
            }
            owner = session.profileId;
            this.active.add(owner);
            source = new McpDesignContextSource({ fileId: request.fileId, pageId: request.pageId }, request.sessionId);
            stage = "无法读取当前设计。请确认 MCP 已连接、服务使用多用户模式，且页面和选区未改变。";
            await source.connect(this.options.mcp, session.token);
            res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
            await this.send(res, { type: "tool", name: "get_current_design_context", status: "running" }, signal);
            for await (const event of new NativeDesignAgent(model, source).answer(request, signal)) {
                if (event.type === "context") {
                    await this.send(
                        res,
                        { type: "tool", name: "get_current_design_context", status: "complete" },
                        signal
                    );
                    stage = "模型回答失败或图层引用无效，请重试；也可切换已配置的模型。";
                }
                await this.send(res, event, signal);
            }
            res.end();
        } catch {
            // 不回显 SDK 或后端原始异常，防止泄露请求头、密钥和设计数据。
            if (!res.destroyed) {
                if (!res.headersSent) {
                    res.writeHead(400, { "Content-Type": "application/x-ndjson; charset=utf-8" });
                }
                res.end(JSON.stringify({ type: "error", message: stage }) + "\n");
            }
        } finally {
            controller.abort();
            if (owner) {
                this.active.delete(owner);
            }
            await source?.close().catch(() => undefined);
        }
    }
}
