import { AgentError } from "./AgentError";
import { type DesignPlan, type DesignExecution, type EditScope } from "@penpot/mcp-common";

interface Entry {
    owner: string;
    sessionId: string;
    scope: EditScope;
    plan: DesignPlan;
    state: "pending" | "cancelled" | "executing" | "done" | "unknown";
    result?: DesignExecution;
}

/** 确认权留在同源 HTTP 服务；绑定账号、会话和不可变计划，未知结果禁止重放。 */
export class DesignPlanStore {
    private readonly entries = new Map<string, Entry>();

    add(owner: string, sessionId: string, scope: EditScope, plan: DesignPlan): void {
        for (const [id, entry] of this.entries) {
            if (entry.plan.expiresAt <= Date.now()) {
                this.entries.delete(id);
            }
        }
        if (this.entries.size >= 256) {
            throw new AgentError("待确认计划过多，请稍后重试。");
        }
        this.entries.set(plan.id, { owner, sessionId, scope, plan, state: "pending" });
    }

    private get(owner: string, sessionId: string, scope: EditScope, id: string): Entry {
        const entry = this.entries.get(id);
        if (
            !entry ||
            entry.owner !== owner ||
            entry.sessionId !== sessionId ||
            JSON.stringify(entry.scope) !== JSON.stringify(scope) ||
            entry.plan.expiresAt <= Date.now()
        ) {
            throw new AgentError("计划已过期或不属于当前账号、会话和页面，请重新生成。");
        }
        return entry;
    }

    cancel(owner: string, sessionId: string, scope: EditScope, id: string): void {
        const entry = this.get(owner, sessionId, scope, id);
        if (entry.state !== "pending" && entry.state !== "cancelled") {
            throw new AgentError("计划已开始执行，无法取消。");
        }
        entry.state = "cancelled";
    }

    async execute(
        owner: string,
        sessionId: string,
        scope: EditScope,
        id: string,
        execute: () => Promise<DesignExecution>
    ): Promise<DesignExecution> {
        const entry = this.get(owner, sessionId, scope, id);
        if (entry.result) {
            return entry.result;
        }
        if (entry.state !== "pending") {
            throw new AgentError("计划已取消、正在执行或结果未知；请检查画布，不会重复执行。");
        }
        entry.state = "executing";
        try {
            entry.result = await execute();
            entry.state = "done";
            return entry.result;
        } catch (error) {
            entry.state = "unknown";
            throw error;
        }
    }
}
