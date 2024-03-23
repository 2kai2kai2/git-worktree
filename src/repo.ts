import * as vscode from "vscode";
import { readFileUTF8, uriJoinPath } from "./util";

async function worktreeGitdirGetDirectory(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const stats = await vscode.workspace.fs.stat(uri);
    if (!(stats.type & vscode.FileType.File)) {
        return;
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

export class Repo {
    readonly rootWorktree: vscode.Uri;
    /** The directory `.git/worktrees/<name>` to the worktree location */
    readonly otherWorktrees: Map<vscode.Uri, vscode.Uri>;

    async handleWorktreeGitdirUpdate(gitdirUri: vscode.Uri) {
        const worktreeDir = await worktreeGitdirGetDirectory(gitdirUri);
        if (!worktreeDir) {
            console.warn("Ignoring invalid content for `gitdir` file at", gitdirUri.toString());
            return;
        }
        this.otherWorktrees.set(uriJoinPath(gitdirUri, ".."), worktreeDir);
        console.log("Updated worktree location at", worktreeDir.toString());
    }

    /**
     * Handles a non-delete update of a tracked worktree info file
     * @param uri Should be in `${rootWorktree}/.git/worktrees/<*>/`
     */
    async handleUpdateWorktreeInfo(uri: vscode.Uri) {
        const split = parseWorktreeInfo(uri);
        switch (split?.fileName) {
            case undefined:
                console.warn(
                    "We received an update for a non-worktree-related file. Ignoring: ",
                    uri.toString(),
                );
                return;
            case "gitdir":
                await this.handleWorktreeGitdirUpdate(uri);
            default:
                console.warn("this is not a file we should be receiving updates for ):");
                return;
        }
    }

    constructor(root: vscode.Uri, context: vscode.ExtensionContext) {
        this.rootWorktree = root;
        this.otherWorktrees = new Map();

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(root, ".git/worktrees/*/{gitdir}"),
        );
        context.subscriptions.push(
            watcher,
            watcher.onDidCreate(this.handleUpdateWorktreeInfo),
            watcher.onDidChange(this.handleUpdateWorktreeInfo),
            watcher.onDidDelete((e) => {
                const split = parseWorktreeInfo(e);
                if (!split) {
                    return;
                }
                if (split.fileName === "gitdir") {
                    const current = this.otherWorktrees.get(split.parent);
                    if (current && this.otherWorktrees.delete(split.parent)) {
                        console.log("Deleted worktree: ", current.toString());
                    }
                }
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
}
