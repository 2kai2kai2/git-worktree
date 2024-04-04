import * as cp from "child_process";
import { ObjectEncodingOptions } from "fs";
import { logger } from "./extension";

/**
 * For any place a normalized path is needed.
 *
 * Mostly because windows and other operating systems seem to disagree on a leading slash.
 */
export function cleanPath(path: string): string {
    if (process.platform === "win32") {
        let i = 0;
        for (; i < path.length && (path[i] === "/" || path[i] === "\\"); i++) {}
        return path.slice(i);
    }
    return path;
}

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
    const _file = cleanPath(file);
    const _options = { ...options };
    _options.cwd = _options.cwd ? cleanPath(_options.cwd.toString()) : undefined;

    return new Promise((res) => {
        logger.trace("[EXECUTE]", _options, [_file, ...args]);
        cp.execFile(_file, args, _options, (error, stdout, stderr) => {
            if (error) {
                logger.warn("[RESULT]", { error, stdout, stderr });
            } else {
                logger.trace("[RESULT]", { error, stdout, stderr });
            }
            res({ error, stdout, stderr });
        });
    });
}
