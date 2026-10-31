import { Task, TaskHandler } from "../TaskHandler";
import { DesignEditor } from "../DesignEditor";
import { executeDesignPlanSchema } from "../../../common/src/DesignEdits";

/** 计划和执行共用同一实例，插件重载后旧计划自动失效。 */
export class DesignEditTaskHandler extends TaskHandler {
    readonly taskType = "designEdit";
    private readonly editor = new DesignEditor(penpot);

    constructor() {
        super();
        penpot.on("pagechange", () => this.editor.invalidate());
        penpot.on("filechange", () => this.editor.invalidate());
        penpot.on("selectionchange", () => this.editor.invalidate());
    }

    async handle(task: Task): Promise<void> {
        const { action, input } = task.params;
        switch (action) {
            case "cancel":
                this.editor.cancel(executeDesignPlanSchema.parse(input).planId);
                task.sendSuccess({ status: "cancelled" });
                break;
            case "prepare":
                task.sendSuccess(this.editor.prepare(input));
                break;
            case "execute":
                task.sendSuccess(await this.editor.execute(input));
                break;
            default:
                throw new Error("不支持的设计操作。");
        }
    }
}
