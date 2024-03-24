import * as vscode from "vscode";
import { readFileUTF8, uriJoinPath } from "./util";
import { updateEvent } from "./extension";
import { ExecuteResult, execute } from "./execute";

async function worktreeGitdirGetDirectory(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
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

/**
 * @param uri The uri of the file `<**>/.git/worktrees/<dir>/<fileName>`
 * @returns `{ parent: "<**>/.git/worktrees/<dir>", fileName: "<fileName>" }`
 */
function parseWorktreeInfo(uri: vscode.Uri): undefined | { parent: vscode.Uri; fileName: string } {
    const split = /^(.*\/\.git\/worktrees\/[^/]+)\/([^\/]+)$/.exec(uri.path);
    if (!split) {
        return undefined;
    }
    return {
        parent: uri.with({ path: split[1] }),
        fileName: split[2],
    };
}

export class Repo implements vscode.Disposable {
    readonly rootWorktree: vscode.Uri;
    /** The directory `.git/worktrees/<name>` to the worktree location */
    readonly otherWorktrees: Map<string, vscode.Uri>;
    private readonly subscriptions: vscode.Disposable[] = [];

    updateTreeItem() {
        console.log("Triggered repository tree item update");
        updateEvent.fire(`repository:${this.rootWorktree.toString()}`);
    }

    async handleWorktreeGitdirUpdate(gitdirUri: vscode.Uri) {
        const worktreeDir = await worktreeGitdirGetDirectory(gitdirUri);
        if (!worktreeDir) {
            console.warn("Ignoring invalid content for `gitdir` file at", gitdirUri.toString());
            return;
        }
        this.otherWorktrees.set(uriJoinPath(gitdirUri, "..").toString(), worktreeDir);
        console.log("Updated worktree location at", worktreeDir.toString());
        this.updateTreeItem();
    }

    /**
     * Handles a non-delete update of a tracked worktree info file
     * @param uri Should be in `${rootWorktree}/.git/**`
     */
    async handleUpdateWorktreeInfo(uri: vscode.Uri) {
        const split = parseWorktreeInfo(uri);
        switch (split?.fileName) {
            case "gitdir":
                await this.handleWorktreeGitdirUpdate(uri);
                return;
            default:
                // ignore other files
                return;
        }
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
                if (e.toString() === uriJoinPath(this.rootWorktree, ".git/worktrees").toString()) {
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

                const gitdirPath = uriJoinPath(this.rootWorktree, `.git/worktrees/${dir}/gitdir`);
                this.handleWorktreeGitdirUpdate(gitdirPath);
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
