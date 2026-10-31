import type { Penpot, Shape } from "@penpot/plugin-types";
import {
    editScopeSchema,
    prepareDesignPlanSchema,
    executeDesignPlanSchema,
    type DesignPlan,
    type DesignExecution,
    type DesignOperation,
    type EditScope,
    type EditSnapshot,
} from "../../common/src/DesignEdits.ts";

interface PendingPlan {
    scope: EditScope;
    plan: DesignPlan;
    result?: DesignExecution;
    invalid: boolean;
    executing?: boolean;
    generation: number;
    listeners: ReturnType<Penpot["on"]>[];
}

/** 在插件内保存预览，确认时重新核验并执行固定操作；失败不自动重试或回滚。 */
export class DesignEditor {
    private readonly plans = new Map<string, PendingPlan>();
    private readonly api: Penpot;
    private generation = 0;
    private running = false;

    constructor(api: Penpot) {
        this.api = api;
    }

    invalidate(): void {
        this.generation++;
        for (const entry of this.plans.values()) {
            entry.invalid = true;
            this.removeListeners(entry);
        }
    }

    cancel(id: string): void {
        const entry = this.plans.get(id);
        if (entry?.executing || entry?.result) {
            throw new Error("计划已开始执行，无法取消。");
        }
        if (entry) {
            this.removeListeners(entry);
        }
        this.plans.delete(id);
    }

    private removeListeners(entry: PendingPlan): void {
        for (const id of entry.listeners) {
            this.api.off(id);
        }
        entry.listeners = [];
    }

    private assertScope(scope: EditScope): void {
        editScopeSchema.parse(scope);
        if (
            this.api.currentFile?.id !== scope.fileId ||
            this.api.currentPage?.id !== scope.pageId ||
            this.api.selection.length !== scope.selectionCount ||
            this.api.selection
                .map((s) => s.id)
                .sort()
                .join() !== [...scope.selectedIds].sort().join()
        ) {
            throw new Error("文件、页面或选区已改变，请重新生成计划。");
        }
    }

    private getShape(id: string): Shape {
        const shape = this.api.currentPage?.getShapeById(id);
        if (!shape || shape.id === this.api.currentPage?.root.id) {
            throw new Error("目标已删除或不属于当前页面。");
        }
        return shape;
    }

    private getSnapshot(shape: Shape): EditSnapshot {
        return JSON.parse(
            JSON.stringify({
                id: shape.id,
                name: shape.name,
                type: shape.type,
                parentId: shape.parent?.id ?? null,
                x: shape.x,
                y: shape.y,
                width: shape.width,
                height: shape.height,
                hidden: shape.hidden,
                blocked: shape.blocked,
                fills: shape.fills,
                ...(shape.type === "rectangle"
                    ? {
                          cornerRadii: [
                              shape.borderRadiusTopLeft ?? 0,
                              shape.borderRadiusTopRight ?? 0,
                              shape.borderRadiusBottomRight ?? 0,
                              shape.borderRadiusBottomLeft ?? 0,
                          ],
                      }
                    : {}),
                ...(shape.type === "text"
                    ? { text: shape.characters, fontFamily: shape.fontFamily, fontSize: shape.fontSize }
                    : {}),
            })
        );
    }

    prepare(input: unknown): DesignPlan {
        if (this.running) {
            throw new Error("已有计划正在执行，请稍后重试。");
        }
        const request = prepareDesignPlanSchema.extend({ planId: executeDesignPlanSchema.shape.planId }).parse(input);
        const scope = editScopeSchema.parse({
            fileId: request.fileId,
            pageId: request.pageId,
            selectedIds: request.selectedIds,
            selectionCount: request.selectionCount,
        });
        this.assertScope(scope);
        for (const [id, entry] of this.plans) {
            if (entry.plan.expiresAt <= Date.now()) {
                this.removeListeners(entry);
                this.plans.delete(id);
            }
        }
        if (this.plans.size >= 64) {
            throw new Error("待确认计划过多，请稍后重试。");
        }
        const targets = new Map<string, EditSnapshot>();
        for (const op of request.operations) {
            if ("shapeId" in op) {
                const shape = this.getShape(op.shapeId);
                if (
                    shape.blocked ||
                    shape.hidden ||
                    (op.tool === "set_text" && shape.type !== "text") ||
                    (op.tool === "set_corner_radius" && shape.type !== "rectangle")
                ) {
                    throw new Error("目标已锁定、隐藏或类型不符。");
                }
                targets.set(shape.id, this.getSnapshot(shape));
            }
        }
        const plan: DesignPlan = {
            id: request.planId,
            expiresAt: Date.now() + 300_000,
            outsideSelection: request.operations.some(
                (op) => !("shapeId" in op) || !scope.selectedIds.includes(op.shapeId)
            ),
            operations: request.operations,
            targets: [...targets.values()],
        };
        const entry: PendingPlan = { scope, plan, invalid: false, generation: this.generation, listeners: [] };
        entry.listeners = plan.targets.map((target) =>
            this.api.on(
                "shapechange",
                () => {
                    entry.invalid = true;
                    this.removeListeners(entry);
                },
                { shapeId: target.id }
            )
        );
        this.plans.set(plan.id, entry);
        return plan;
    }

    async execute(input: unknown): Promise<DesignExecution> {
        const request = executeDesignPlanSchema.parse(input);
        const entry = this.plans.get(request.planId);
        if (!entry || entry.plan.expiresAt <= Date.now()) {
            throw new Error("计划已失效，请重新生成。");
        }
        const scope = editScopeSchema.parse({
            fileId: request.fileId,
            pageId: request.pageId,
            selectedIds: request.selectedIds,
            selectionCount: request.selectionCount,
        });
        if (JSON.stringify(scope) !== JSON.stringify(entry.scope)) {
            throw new Error("计划范围不符。");
        }
        if (entry.executing) {
            throw new Error("计划正在执行，请勿重复确认。");
        }
        if (entry.result) {
            return entry.result;
        }
        if (this.running) {
            throw new Error("已有计划正在执行。");
        }
        if (entry.invalid) {
            throw new Error("上下文已改变，计划已失效。");
        }
        entry.invalid = true;
        this.removeListeners(entry);
        this.assertScope(scope);
        for (const before of entry.plan.targets) {
            if (JSON.stringify(this.getSnapshot(this.getShape(before.id))) !== JSON.stringify(before)) {
                throw new Error("目标对象已修改，请重新生成计划。");
            }
        }
        const result: DesignExecution = { planId: entry.plan.id, status: "failed", steps: [] };
        entry.result = result;
        entry.executing = true;
        this.running = true;
        const expected = new Map(entry.plan.targets.map((target) => [target.id, target]));
        const oldFlag = this.api.flags.throwValidationErrors;
        let block: Symbol | undefined;
        let stopped = false;
        const started = Date.now();
        try {
            block = this.api.history.undoBlockBegin();
            this.api.flags.throwValidationErrors = true;
            for (const op of entry.plan.operations) {
                if (stopped) {
                    result.steps.push({ tool: op.tool, status: "skipped", message: "前一步失败，已停止。" });
                    continue;
                }
                let shape: Shape | undefined;
                let before: EditSnapshot | null = null;
                try {
                    if (Date.now() - started >= 10000) {
                        throw new Error("本轮操作超时");
                    }
                    this.assertScope(scope);
                    if (entry.generation !== this.generation) {
                        throw new Error("上下文已改变");
                    }
                    shape = "shapeId" in op ? this.getShape(op.shapeId) : undefined;
                    before = shape ? this.getSnapshot(shape) : null;
                    if (shape && JSON.stringify(before) !== JSON.stringify(expected.get(shape.id))) {
                        throw new Error("目标已修改");
                    }
                    if (!shape) {
                        switch (op.tool) {
                            case "create_rectangle":
                                shape = this.api.createRectangle();
                                break;
                            case "create_frame":
                                shape = this.api.createBoard();
                                break;
                            case "create_text":
                                shape = this.api.createText(op.text) ?? undefined;
                                break;
                        }
                        if (!shape) {
                            throw new Error("创建失败");
                        }
                        const root = this.api.currentPage!.root;
                        if ("appendChild" in root) {
                            root.appendChild(shape);
                        }
                    }
                    this.apply(shape, op);
                    await this.waitForLayout();
                    this.assertScope(scope);
                    if (entry.generation !== this.generation) {
                        throw new Error("上下文已改变");
                    }
                    const after = this.getSnapshot(this.getShape(shape.id));
                    if (!this.matches(after, op)) {
                        throw new Error("回读不符");
                    }
                    result.steps.push({ tool: op.tool, status: "success", shapeId: shape.id, before, after });
                    expected.set(shape.id, after);
                } catch {
                    stopped = true;
                    result.steps.push({
                        tool: op.tool,
                        status: "failed",
                        shapeId: shape?.id,
                        before,
                        after: shape && this.api.currentPage?.getShapeById(shape.id) ? this.getSnapshot(shape) : null,
                        message: "执行或回读验证失败，当前步骤可能已产生修改。请检查画布；可使用原生撤销。",
                    });
                }
            }
        } finally {
            this.api.flags.throwValidationErrors = oldFlag;
            entry.executing = false;
            this.running = false;
            if (block) {
                this.api.history.undoBlockFinish(block);
            }
        }
        result.status = stopped ? (result.steps.some((s) => s.status === "success") ? "partial" : "failed") : "success";
        return result;
    }

    private async waitForLayout(): Promise<void> {
        const api = this.api as Penpot & { waitForLayoutUpdate?: (timeout?: number) => Promise<void> };
        if (api.waitForLayoutUpdate) {
            await api.waitForLayoutUpdate(5000);
        }
    }

    private apply(shape: Shape, op: DesignOperation): void {
        if ("borderRadius" in op && op.borderRadius !== undefined && shape.type === "rectangle") {
            shape.borderRadius = op.borderRadius;
        }
        if (op.tool === "set_text" && shape.type === "text") {
            shape.characters = op.text;
        }
        if ("name" in op) {
            shape.name = op.name;
        }
        if ("width" in op) {
            shape.resize(op.width, op.height);
            shape.x = op.x;
            shape.y = op.y;
        }
        if ("color" in op) {
            shape.fills = [{ fillColor: op.color.toUpperCase(), fillOpacity: op.opacity }];
        }
        if (op.tool === "create_text" && shape.type === "text") {
            shape.fontFamily = op.fontFamily;
            shape.fontSize = String(op.fontSize);
            shape.growType = "fixed";
        }
    }

    private matches(after: EditSnapshot, op: DesignOperation): boolean {
        const close = (a: number, b: number) => Math.abs(a - b) < 0.01;
        return (
            (!("borderRadius" in op) ||
                op.borderRadius === undefined ||
                (after.cornerRadii?.length === 4 &&
                    after.cornerRadii.every((value) => close(value, op.borderRadius!)))) &&
            (!("text" in op) || after.text === op.text) &&
            (!("width" in op) ||
                (close(after.x, op.x) &&
                    close(after.y, op.y) &&
                    close(after.width, op.width) &&
                    close(after.height, op.height))) &&
            (!("color" in op) ||
                (after.fills.length === 1 &&
                    String(after.fills[0].fillColor).toLowerCase() === op.color.toLowerCase() &&
                    close(Number(after.fills[0].fillOpacity), op.opacity))) &&
            (!("name" in op) || after.name === op.name) &&
            (op.tool !== "create_text" ||
                (after.fontFamily === op.fontFamily && Number(after.fontSize) === op.fontSize))
        );
    }
}
