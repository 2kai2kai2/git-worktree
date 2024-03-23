import * as cp from "child_process";
import * as util from "util";

/** WARNING: this is really powerful. Be careful. Don't get pwned. */
export const execute = util.promisify(cp.exec);
