import * as cp from "child_process";
import { ObjectEncodingOptions } from "fs";

export type ExecuteResult = {
    error: cp.ExecFileException | null;
    stdout: string;
    stderr: string;
};
/** WARNING: this is really powerful. Be careful. Don't get pwned. */
export function execute(
    file: string,
    args: string[],
    options: ObjectEncodingOptions & cp.ExecFileOptions,
): Promise<ExecuteResult> {
    return new Promise((res) => {
        console.log("[EXECUTE]", [file, ...args]);
        cp.execFile(file, args, options, (error, stdout, stderr) => res({ error, stdout, stderr }));
    });
}
