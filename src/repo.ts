import * as vscode from "vscode";
import { readFileUTF8, uriJoinPath } from "./util";
import { updateEvent } from "./extension";
import { ExecuteResult, execute } from "./execute";
import { Ref, RefType } from "./git";

async function parseGitdirFile(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const stats = await vscode.workspace.fs.stat(uri);
    if (!(stats.type & vscode.FileType.File)) {
        return undefined;
    }

    const text = await readFileUTF8(uri);

    const regex = new RegExp(/^(.+)\/\.git\n$/);
    const path = regex.exec(text)?.[1];
    if (!path) {
        return undefined;
    }
    return uri.with({ path });
}

async function parseWorktreeHEADReadable(uri: vscode.Uri): Promise<string | undefined> {
    const stats = await vscode.workspace.fs.stat(uri);
    if (!(stats.type & vscode.FileType.File)) {
        return undefined;
    }

    const text = await readFileUTF8(uri);
    const match = /^ref: \/?refs\/[^/]+\/(.+)\s*$/.exec(text);
    if (match) {
        return match[1];
    }
    return text.trim();
}

/**
 * @param uri The uri of the file `<**>/.git/worktrees/<dir>/<**>`
 * @returns `"<**>/.git/worktrees/<dir>"`
 */
function parseWorktreeInfoDir(uri: vscode.Uri): undefined | vscode.Uri {
    const split = /^(.*\/\.git\/worktrees\/[^/\s]+)/.exec(uri.path);
    if (!split) {
        return undefined;
    }

    return uri.with({ path: split[1] });
}

export interface SubWorktreeInfo {
    /** The location of the worktree (from `.git/worktrees/<*>/gitdir`, without `.git` at the end of the path) */
    dir: vscode.Uri;
    /** The branch/tag/commit that the worktree is on */
    ref: string;
}

export class Repo implements vscode.Disposable {
    readonly rootWorktree: vscode.Uri;
    /** The directory `.git/worktrees/<name>` to the worktree location */
    readonly otherWorktrees: Map<string, SubWorktreeInfo>;
    private readonly subscriptions: vscode.Disposable[] = [];

    updateTreeItem() {
        console.log("Triggered repository tree item update");
        updateEvent.fire(`repository:${this.rootWorktree.toString()}`);
    }

    /**
     * Handles a non-delete update of a tracked worktree info file
     * @param uri Should be in `${rootWorktree}/.git/**`
     */
    async handleUpdateWorktreeInfo(uri: vscode.Uri) {
        const infoDir = parseWorktreeInfoDir(uri);
        if (!infoDir || infoDir.scheme !== "file") {
            return;
        }
        const dir = await parseGitdirFile(uriJoinPath(infoDir, "gitdir"));
        if (!dir) {
            console.error("Found invalid content for `gitdir` file in", infoDir.toString());
            return;
        }
        const ref = await parseWorktreeHEADReadable(uriJoinPath(infoDir, "HEAD"));
        if (!ref) {
            console.error("Was unable to read `HEAD` file in", infoDir.toString());
            return;
        }

        this.otherWorktrees.set(infoDir.toString(), { dir, ref });
        console.log("Updated worktree location at", dir.toString());
        this.updateTreeItem();
    }

    constructor(root: vscode.Uri) {
        this.rootWorktree = root;
        this.otherWorktrees = new Map();

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(root, ".git/**"),
        );
        this.subscriptions.push(
            watcher,
            watcher.onDidCreate(async (uri) => this.handleUpdateWorktreeInfo(uri)),
            watcher.onDidChange(async (uri) => this.handleUpdateWorktreeInfo(uri)),
            watcher.onDidDelete((e) => {
                if (e.scheme !== "file") {
                    return;
                } else if (
                    e.toString() === uriJoinPath(this.rootWorktree, ".git/worktrees").toString()
                ) {
                    this.otherWorktrees.clear();
                    console.log("All sub-worktrees deleted for", this.rootWorktree.toString());
                } else {
                    const current = this.otherWorktrees.get(e.toString());
                    if (current && this.otherWorktrees.delete(e.toString())) {
                        console.log("Deleted worktree: ", current.toString());
                    }
                }
                this.updateTreeItem();
            }),
        );

        // load initial
        const a = async () => {
            const gitDir = uriJoinPath(this.rootWorktree, ".git");
            const gitDirContents = await vscode.workspace.fs.readDirectory(gitDir);
            if (
                !gitDirContents.find(
                    ([name, filetype]) =>
                        name === "worktrees" && filetype & vscode.FileType.Directory,
                )
            ) {
                return;
            }

            const worktreesDir = uriJoinPath(this.rootWorktree, ".git/worktrees");
            const worktreesDirContents = await vscode.workspace.fs.readDirectory(worktreesDir);
            console.log("Found sub-worktrees info: ", worktreesDirContents);
            for (const [dir, dirType] of worktreesDirContents) {
                if (!(dirType & vscode.FileType.Directory)) {
                    continue;
                }

                const worktreeInfoPath = uriJoinPath(this.rootWorktree, ".git/worktrees", dir);
                this.handleUpdateWorktreeInfo(worktreeInfoPath);
            }
        };
        a();
    }
    dispose() {
        this.subscriptions.forEach((d) => d.dispose());
        this.subscriptions.splice(0, this.subscriptions.length);
    }

    async executeInRepo(file: string, ...args: string[]): Promise<ExecuteResult> {
        return await execute(file, args, { cwd: this.rootWorktree.path });
    }
}
