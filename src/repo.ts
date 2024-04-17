import * as vscode from "vscode";
import { gitExecutable, logger, updateEvent } from "./extension";
import { ExecuteResult, execute } from "./execute";

export interface BasicWorktreeData {
    /** The location of the worktree (e.g. `/myprojects/supercoolproject/worktree1`) */
    worktree: string;
    /** The hash of the current HEAD of the worktree. If there is no head, this worktree should be bare, and does not need to be displayed. */
    HEAD?: string;
    /** Should exist if HEAD is not present. */
    bare?: string;
    /** The current branch of the worktree, or undefined if detached */
    branch?: string;
    /** If undefined, it is not locked. If it is a string, it contains the reason (or empty string if unspecified) */
    locked?: string;
    /** If undefined, it is not prunable. If it is a string, it contains the reason (or empty string if unspecified) */
    prunable?: string;
    order: number;
}
function isValidBasicWorktreeData(item: object): item is BasicWorktreeData {
    return "worktree" in item && "HEAD" in item;
}

export class Repo implements vscode.Disposable {
    /** The location of the .git directory */
    readonly dotgitdir: vscode.Uri;
    /** The directory `.git/worktrees/<name>` to the worktree location */
    private _worktrees: Map<string, BasicWorktreeData>;
    get worktrees(): ReadonlyMap<string, BasicWorktreeData> {
        return this._worktrees;
    }
    private readonly subscriptions: vscode.Disposable[] = [];

    updateTreeItem() {
        logger.trace("Triggered repository tree item update", this.dotgitdir.toString());
        updateEvent.fire(`repository:${this.dotgitdir.toString()}`);
    }

    private async getBasicWorktreeData(): Promise<BasicWorktreeData[]> {
        const { error, stdout, stderr } = await this.executeInRepo(
            gitExecutable,
            "worktree",
            "list",
            "--porcelain",
            "-z",
        );
        if (error) {
            throw new Error(stderr);
        }

        const worktreeRecords = stdout.split("\0\0").filter((v) => v.length > 0);
        const wt: BasicWorktreeData[] = [];
        for (let i = 0; i < worktreeRecords.length; i++) {
            const items = worktreeRecords[i].split("\0");
            const entries: Record<string, string> = {};
            for (const item of items) {
                const spaceIndex = item.indexOf(" ");
                if (spaceIndex < 0) {
                    entries[item] = "";
                } else {
                    entries[item.slice(0, spaceIndex)] = item.slice(spaceIndex + 1);
                }
            }
            if ("bare" in entries) {
                continue;
            }
            if (!isValidBasicWorktreeData(entries)) {
                throw new Error(
                    `When parsing worktrees, found invalid record: ${JSON.stringify(entries)}`,
                );
            }
            entries.order = i;
            wt.push(entries);
        }
        return wt;
    }

    /**
     * Handles a non-delete update of a tracked worktree info file
     * @param uri Should be in `${rootWorktree}/.git/**`
     */
    async handleUpdateWorktreeInfo(uri: vscode.Uri) {
        if (uri.scheme !== "file") {
            logger.warn("Updates on a non-`file://` uri");
            return;
        }

        const newWorktrees = await this.getBasicWorktreeData();
        this._worktrees = new Map();
        for (const wt of newWorktrees) {
            this._worktrees.set(wt.worktree, wt);
        }
        this.updateTreeItem();
    }

    constructor(dotgitdir: vscode.Uri) {
        this.dotgitdir = dotgitdir;
        this._worktrees = new Map();

        const pattern = new vscode.RelativePattern(
            dotgitdir,
            "{.,config,HEAD,packed-refs,FETCH_HEAD,worktrees,worktrees/*,worktrees/*/HEAD,refs/**}",
        );
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        logger.trace("Now watching", pattern);
        this.subscriptions.push(
            watcher,
            watcher.onDidCreate(async (uri) => await this.handleUpdateWorktreeInfo(uri)),
            watcher.onDidChange(async (uri) => await this.handleUpdateWorktreeInfo(uri)),
            watcher.onDidDelete(async (uri) => await this.handleUpdateWorktreeInfo(uri)),
        );
    }

    static async init(dotgitdir: vscode.Uri): Promise<Repo> {
        const ret = new Repo(dotgitdir);
        const worktrees = await ret.getBasicWorktreeData();
        for (const worktree of worktrees) {
            ret._worktrees.set(worktree.worktree, worktree);
        }
        return ret;
    }

    dispose() {
        logger.trace("Disposing of repo");
        this.subscriptions.forEach((d) => d.dispose());
        this.subscriptions.splice(0, this.subscriptions.length);
    }

    async executeInRepo(file: string, ...args: string[]): Promise<ExecuteResult> {
        return await execute(file, args, { cwd: this.dotgitdir.path });
    }
}
