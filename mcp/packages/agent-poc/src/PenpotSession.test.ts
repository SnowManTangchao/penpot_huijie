import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { PenpotSession } from "./PenpotSession";
import { AgentHttpServer } from "./AgentHttpServer";

test("binds backend identity and file permission to the login Cookie, never browser credentials", async () => {
    const backend = createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (!["auth=alice", "auth=expired"].includes(req.headers.cookie ?? "")) {
            res.writeHead(401).end("{}");
            return;
        }
        if (req.url?.includes("get-profile")) {
            res.end(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", props: { mcpEnabled: true } }));
        } else if (req.url?.includes("get-file-summary")) {
            if (new URL(req.url, "http://localhost").searchParams.get("id") !== "alice-file") {
                res.writeHead(404).end("{}");
            } else {
                res.end("{}");
            }
        } else if (req.url?.includes("get-file")) {
            res.end(JSON.stringify({ permissions: { canEdit: req.headers.cookie === "auth=alice" } }));
        } else {
            res.end(
                JSON.stringify([
                    { type: "mcp", token: "expired", expiresAt: "2000-01-01" },
                    ...(req.headers.cookie === "auth=alice" ? [{ type: "mcp", token: "alice-secret" }] : []),
                ])
            );
        }
    });
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    const address = backend.address() as { port: number };
    const url = new URL(`http://127.0.0.1:${address.port}/`);
    const sessions = new PenpotSession(url);
    const signal = AbortSignal.timeout(5000);
    try {
        assert.deepEqual(await sessions.authorize("auth=alice", "alice-file", signal), {
            profileId: "11111111-1111-4111-8111-111111111111",
            token: "alice-secret",
        });
        assert.equal((await sessions.authorize("auth=alice", "alice-file", signal, true)).token, "alice-secret");
        await assert.rejects(sessions.authorize("auth=expired", "alice-file", signal, true), /编辑权限/);
        await assert.rejects(sessions.authorize("auth=alice", "bob-file", signal), /无权/);
        await assert.rejects(sessions.authorize("auth=expired", "alice-file", signal), /有效/);
        await assert.rejects(sessions.authenticate("auth=bob", signal));
        await assert.rejects(sessions.authenticate(undefined, signal), /登录/);
        const agent = new AgentHttpServer({
            origin: "https://penpot.example",
            backend: url,
            mcp: new URL("http://localhost:4401/mcp/agent"),
            models: new Map(),
        });
        agent.server.listen(0, "127.0.0.1");
        await once(agent.server, "listening");
        const agentUrl = `http://127.0.0.1:${(agent.server.address() as { port: number }).port}`;
        try {
            const config = await fetch(agentUrl + "/api/agent/config", { headers: { Cookie: "auth=alice" } });
            assert.deepEqual(await config.json(), { models: [] });
            for (const path of ["chat", "confirm", "cancel"]) {
                const rejected = await fetch(agentUrl + "/api/agent/" + path, {
                    method: "POST",
                    headers: { Origin: "https://evil.example", Cookie: "auth=alice" },
                });
                assert.equal(rejected.status, 403);
            }
            const anonymous = await fetch(agentUrl + "/api/agent/config");
            assert.equal(anonymous.status, 400);
            assert.doesNotMatch(await anonymous.text(), /alice-secret|auth=alice/);
        } finally {
            await new Promise<void>((resolve) => agent.server.close(() => resolve()));
        }
    } finally {
        await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
});
