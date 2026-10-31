import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { McpDesignContextSource } from "./McpDesignContextSource";

test("old plugin rejection of the radius tool asks the user to refresh instead of blaming the plan", async () => {
    const server = createServer(async (req, res) => {
        if (req.method !== "POST") {
            res.writeHead(405).end();
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const request = JSON.parse(Buffer.concat(chunks).toString());
        if (request.id === undefined) {
            res.writeHead(202).end();
            return;
        }
        const result =
            request.method === "initialize"
                ? {
                      protocolVersion: request.params.protocolVersion,
                      capabilities: { tools: {} },
                      serverInfo: { name: "legacy-plugin-bridge", version: "1" },
                  }
                : {
                      content: [
                          {
                              type: "text",
                              text:
                                  'Tool execution failed: Error handling task: [{"code":"invalid_union",' +
                                  '"note":"No matching discriminator","discriminator":"tool","path":["operations",0,"tool"]}]',
                          },
                      ],
                  };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const scope = {
        fileId: "11111111-1111-4111-8111-111111111111",
        pageId: "22222222-2222-4222-8222-222222222222",
        selectedIds: [],
        selectionCount: 0,
    };
    const source = new McpDesignContextSource(scope, "legacy-tab");
    try {
        await source.connect(new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp/agent`));
        await assert.rejects(
            source.prepare(scope, [{ tool: "set_corner_radius", shapeId: scope.fileId, borderRadius: 8 }]),
            (error) => error instanceof Error && /插件版本过旧/.test(error.message) && /刷新/.test(error.message)
        );
    } finally {
        await source.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
