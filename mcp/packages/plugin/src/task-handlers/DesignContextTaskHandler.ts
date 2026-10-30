import {
    designContextInputSchema,
    designContextSchema,
    type DesignContextInput,
} from "../../../common/src/DesignContext.ts";
import { Task, TaskHandler } from "../TaskHandler";
import { DesignContextReader } from "../DesignContextReader";

/** 固定只读任务，与任意 JavaScript 执行通道分开。 */
export class DesignContextTaskHandler extends TaskHandler<DesignContextInput> {
    readonly taskType = "getDesignContext";

    async handle(task: Task<DesignContextInput>): Promise<void> {
        const scope = designContextInputSchema.parse(task.params);
        task.sendSuccess(designContextSchema.parse(new DesignContextReader(penpot).read(scope)));
    }
}
