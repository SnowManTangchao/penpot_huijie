import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { CompatibleImageProvider } from "./AdvancedDesignService";
import { imageGenerationSchema } from "@penpot/mcp-common";

const png = {
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
    width: 1,
    height: 1,
};

test("image adapter sends bounded generation and masked edit requests to the configured endpoint", async () => {
    const received: { path: string; type: string; body: string }[] = [];
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        received.push({
            path: req.url!,
            type: req.headers["content-type"]!,
            body: Buffer.concat(chunks).toString("utf8"),
        });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ b64_json: png.data }], usage: { total_tokens: 10 } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const provider = new CompatibleImageProvider(
        new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`),
        "test-key",
        "test-model",
        "test-only"
    );
    const request = imageGenerationSchema.parse({ prompt: "替换背景", size: "1024x1024", quality: "low", count: 1 });
    try {
        const result = await provider.generate(request, AbortSignal.timeout(5000));
        assert.deepEqual(result.images, [png]);
        assert.equal(received[0].path, "/v1/images/generations");
        assert.equal(JSON.parse(received[0].body).model, "test-model");
        await provider.generate({ ...request, reference: png, mask: png }, AbortSignal.timeout(5000));
        assert.equal(received[1].path, "/v1/images/edits");
        assert.match(received[1].type, /^multipart\/form-data/);
        assert.match(received[1].body, /filename="reference.png"/);
        assert.match(received[1].body, /filename="mask.png"/);
        assert.equal(imageGenerationSchema.safeParse({ ...request, mask: png }).success, false);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("image adapter refuses URL-only responses without downloading the supplied URL", async () => {
    const server = createServer((_req, res) =>
        res.end(JSON.stringify({ data: [{ url: "http://127.0.0.1/private" }] }))
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        const provider = new CompatibleImageProvider(
            new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/`),
            "test-key",
            "test-model",
            "test-only"
        );
        await assert.rejects(
            provider.generate(
                imageGenerationSchema.parse({ prompt: "山", size: "1024x1024", quality: "low", count: 1 }),
                AbortSignal.timeout(5000)
            )
        );
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
