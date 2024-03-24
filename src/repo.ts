import * as vscode from "vscode";
import { readFileUTF8, uriJoinPath } from "./util";
import { updateEvent } from "./extension";

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
     * @param uri Should be in `${rootWorktree}/.git/worktrees/<*>/`
     */
    async handleUpdateWorktreeInfo(uri: vscode.Uri) {
        const split = parseWorktreeInfo(uri);
        switch (split?.fileName) {
            case "gitdir":
                await this.handleWorktreeGitdirUpdate(uri);
                return;
            default:
                // this is an untracked file matching `.git/worktrees/*/**`
                return;
        }
    }

    constructor(root: vscode.Uri) {
        this.rootWorktree = root;
        this.otherWorktrees = new Map();

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(root, ".git/worktrees/**"),
        );
        this.subscriptions.push(
            watcher,
            watcher.onDidCreate(async (uri) => this.handleUpdateWorktreeInfo(uri)),
            watcher.onDidChange(async (uri) => this.handleUpdateWorktreeInfo(uri)),
            watcher.onDidDelete((e) => {
                const current = this.otherWorktrees.get(e.toString());
                if (current && this.otherWorktrees.delete(e.toString())) {
                    console.log("Deleted worktree: ", current.toString());
                }
                this.updateTreeItem();
            }),
        );

        // load initial
        vscode.workspace.fs
            .readDirectory(uriJoinPath(this.rootWorktree, ".git/worktrees"))
            .then((worktreeDirs) => {
                console.log("Found sub-worktrees info: ", worktreeDirs);
                for (const [dir, dirType] of worktreeDirs) {
                    if (!(dirType & vscode.FileType.Directory)) {
                        continue;
                    }

                    const gitdirPath = uriJoinPath(
                        this.rootWorktree,
                        `.git/worktrees/${dir}/gitdir`,
                    );
                    this.handleWorktreeGitdirUpdate(gitdirPath);
                }
            });
    }
    dispose() {
        this.subscriptions.forEach((d) => d.dispose());
        this.subscriptions.splice(0, this.subscriptions.length);
    }
}
