import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { WebSocket } from "ws";
import { PenpotMcpServer } from "./PenpotMcpServer";

const scope = {
    fileId: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
};
const context = {
    file: { id: scope.fileId, name: "测试", revision: 1 },
    page: { id: scope.pageId, name: "当前页面" },
    selectedIds: [],
    selectionCount: 0,
    shapes: [],
    truncated: false,
};
let server: PenpotMcpServer;
let client: Client;
let socket: WebSocket;
let previousEnv: NodeJS.ProcessEnv;
let nextPort = 18_600;

beforeEach(async () => {
    previousEnv = { ...process.env };
    process.env.PENPOT_MCP_SERVER_HOST = "127.0.0.1";
    process.env.PENPOT_MCP_SERVER_PORT = String(nextPort++);
    process.env.PENPOT_MCP_WEBSOCKET_PORT = String(nextPort++);
    process.env.PENPOT_MCP_DEVENV = "false";
    process.env.PENPOT_MCP_REPL_ENABLE = "false";
    delete process.env.PENPOT_MCP_REDIS_URI;
    delete process.env.PENPOT_MCP_AUTH_URI;
    server = new PenpotMcpServer(true);
    await server.start();
    socket = new WebSocket(`ws://127.0.0.1:${server.webSocketPort}?userToken=alice`);
    await once(socket, "open");
    const initialized = once(socket, "message", { signal: AbortSignal.timeout(3000) });
    socket.send(
        JSON.stringify({
            type: "initialize",
            session: { sessionId: "design-tab", fileId: scope.fileId, fileName: "测试" },
        })
    );
    await initialized;
    client = new Client({ name: "context-test", version: "1" });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
            requestInit: { headers: { Authorization: "Bearer alice" } },
        })
    );
});

afterEach(async () => {
    socket?.terminate();
    await client?.close();
    await server?.stop();
    process.env = previousEnv;
});

test("reads the registered context tool over HTTP and dispatches a fixed task over WebSocket", async () => {
    socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString());
        assert.equal(request.task, "getDesignContext");
        assert.deepEqual(request.params, scope);
        assert.equal("code" in request.params, false);
        socket.send(JSON.stringify({ id: request.id, success: true, data: context }));
    });
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "get_current_design_context"));
    const result = await client.callTool({
        name: "get_current_design_context",
        arguments: { ...scope, sessionId: "design-tab" },
    });
    const content = result.content[0];
    assert.equal(content.type, "text");
    if (content.type === "text") {
        assert.deepEqual(JSON.parse(content.text), context);
    }
});

test("rejects plugin context belonging to another page", async () => {
    socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString());
        socket.send(
            JSON.stringify({
                id: request.id,
                success: true,
                data: { ...context, page: { id: scope.fileId, name: "其他页面" } },
            })
        );
    });
    const result = await client.callTool({ name: "get_current_design_context", arguments: scope });
    assert.match(JSON.stringify(result), /上下文范围与请求不符/);
    assert.doesNotMatch(JSON.stringify(result), /其他页面/);
});

test("refuses to route a read to a session not owned by the authenticated user", async () => {
    const result = await client.callTool({
        name: "get_current_design_context",
        arguments: { ...scope, sessionId: "bob-tab" },
    });
    assert.match(JSON.stringify(result), /not connected/);
});
