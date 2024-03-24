import * as vscode from "vscode";
import { GitExtension } from "./git";
import { Repo } from "./repo";
import { readFileUTF8, uriJoinPath } from "./util";

export type TreeID = `repository:${string}` | `subworktree:${string}`;

export const updateEvent = new vscode.EventEmitter<TreeID | undefined>();
const repos: Repo[] = [];

/**
 * Starts tracking a repo if it is not already tracked
 * @param rootDir The main directory which contains the `.git` directory
 */
function trackRepo(rootDir: vscode.Uri, context: vscode.ExtensionContext) {
    if (repos.find((v) => v.rootWorktree.toString(true) === rootDir.toString(true))) {
        console.log("skipping duplicate");
        return; // this is already tracked
    }
    console.log("now tracking:", rootDir.toString(true));

    repos.push(new Repo(rootDir, context));
    updateEvent.fire(undefined);
}

export function activate(context: vscode.ExtensionContext) {
    const git_extension = vscode.extensions
        .getExtension<GitExtension>("vscode.git")
        ?.exports?.getAPI(1);
    if (!git_extension) {
        vscode.window.showErrorMessage("Failed to get data from the built-in git extension.");
        throw new Error("idk");
    }

    context.subscriptions.push(
        git_extension.onDidOpenRepository(async (repository) => {
            const localDotGit = uriJoinPath(repository.rootUri, ".git");
            const localDotGitStat = await vscode.workspace.fs.stat(localDotGit);
            if (vscode.FileType.Directory & localDotGitStat.type) {
                // it is main worktree
                trackRepo(repository.rootUri, context);
            } else if (vscode.FileType.File & localDotGitStat.type) {
                // it is sub-worktree
                const text = await readFileUTF8(localDotGit);

                const rootDir = /^(?:gitdir\: )(.+)\/\.git\/worktrees\/[^\/]+\n$/.exec(text)?.[1];
                if (!rootDir) {
                    vscode.window.showErrorMessage("Parsing worktree .git file failed.");
                    throw new Error("idk");
                }

                trackRepo(localDotGit.with({ path: rootDir }), context);
            } else {
                throw new Error(".git should be a file or directory ):");
            }
        }),
        vscode.window.registerTreeDataProvider<TreeID>("git-worktrees", {
            onDidChangeTreeData: updateEvent.event,
            getTreeItem: function (element: TreeID): vscode.TreeItem | Thenable<vscode.TreeItem> {
                if (element.startsWith("subworktree:")) {
                    return new vscode.TreeItem(element);
                } else if (element.startsWith("repository:")) {
                    return new vscode.TreeItem("repo", vscode.TreeItemCollapsibleState.Expanded);
                }
                throw new Error("invalid tree item");
            },
            getChildren: function (element?: TreeID): vscode.ProviderResult<TreeID[]> {
                if (!element) {
                    const re = repos.map((r) => `repository:${r.rootWorktree.toString()}` as const);
                    return re;
                } else if (element.startsWith("subworktree:")) {
                    return [];
                } else if (element.startsWith("repository:")) {
                    const repo = repos.find(
                        (r) => `repository:${r.rootWorktree.toString()}` === element,
                    );
                    if (!repo) {
                        throw new Error(`This repository does not seem to exist: ${element}`);
                    }
                    const items: `subworktree:${string}`[] = [];
                    for (const [k, v] of repo.otherWorktrees) {
                        items.push(`subworktree:${k}`);
                    }
                    return items;
                }
                throw new Error(`Invalid tree item: ${element}`);
            },
        }),
    );
}

export function deactivate() {}
