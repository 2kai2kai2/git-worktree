import * as cp from "child_process";

type ExecuteResult = {
    error: cp.ExecException | null;
    stdout: string;
    stderr: string;
};
/** WARNING: this is really powerful. Be careful. Don't get pwned. */
export function execute(cmd: string): Promise<ExecuteResult> {
    return new Promise((res) => {
        cp.exec(cmd, (error, stdout, stderr) => res({ error, stdout, stderr }));
    });
}
