import { z } from "zod";

/** 使用登录 Cookie 核对身份、文件权限和 MCP 凭据，不信任浏览器提供的用户身份。 */
export class PenpotSession {
    constructor(private readonly backend: URL) {}

    private async get(command: string, cookie: string, signal: AbortSignal, params: Record<string, string> = {}) {
        const url = new URL(`api/rpc/command/${command}`, this.backend);
        url.searchParams.set("_fmt", "json");
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
        const response = await fetch(url, {
            headers: { Cookie: cookie, Accept: "application/json" },
            redirect: "error",
            signal,
        });
        if (!response.ok) {
            throw new Error("登录已失效或无权读取文件，请检查登录与文件权限。");
        }
        return response.json();
    }

    async authenticate(cookie: string | undefined, signal: AbortSignal) {
        if (!cookie) {
            throw new Error("请先登录 Penpot。");
        }
        const profile = z
            .object({ id: z.string().uuid(), props: z.record(z.string(), z.unknown()).optional() })
            .parse(await this.get("get-profile", cookie, signal));
        if (profile.id === "00000000-0000-0000-0000-000000000000") {
            throw new Error("请先登录 Penpot。");
        }
        return profile;
    }

    async authorize(cookie: string, fileId: string, signal: AbortSignal) {
        const profile = await this.authenticate(cookie, signal);
        await this.get("get-file-summary", cookie, signal, { id: fileId });
        if (profile.props?.mcpEnabled !== true) {
            throw new Error("请在 Penpot 中启用 MCP 并连接当前编辑器。");
        }
        const tokens = z
            .array(
                z.object({
                    type: z.string().optional(),
                    token: z.string().optional(),
                    expiresAt: z.string().nullable().optional(),
                })
            )
            .parse(await this.get("get-access-tokens", cookie, signal));
        const token = tokens.find(
            (item) => item.type === "mcp" && item.token && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
        )?.token;
        if (!token) {
            throw new Error("没有有效的 MCP 令牌，请在 Penpot 中重新启用 MCP。");
        }
        return { profileId: profile.id, token };
    }
}
