import * as vscode from "vscode";
import { GitExtension } from "./git";
import { Repo } from "./repo";
import { readFileUTF8, uriJoinPath } from "./util";

export type RepositoryTreeID = `repository:${string}`;
export type SubworktreeTreeID = `subworktree:${string}`;
export type TreeID = RepositoryTreeID | SubworktreeTreeID;
function isRepositoryTreeID(treeid: TreeID | any): treeid is RepositoryTreeID {
    return typeof treeid === "string" && treeid.startsWith("repository:");
}
function isSubworktreeTreeID(treeid: TreeID | any): treeid is SubworktreeTreeID {
    return typeof treeid === "string" && treeid.startsWith("subworktree:");
}

export const updateEvent = new vscode.EventEmitter<TreeID | undefined>();
const repos: Repo[] = [];
function findRepo(treeid: TreeID): Repo | undefined {
    if (isRepositoryTreeID(treeid)) {
        return repos.find((r) => treeid === `repository:${r.rootWorktree.toString()}`);
    } else {
        for (const repo of repos) {
            if (repo.otherWorktrees.has(treeid.slice("subworktree:".length))) {
                return repo;
            }
        }
    }
    return undefined;
}
function findSubworktreeDir(treeid: SubworktreeTreeID): vscode.Uri | undefined {
    const uriString = treeid.slice("subworktree:".length);
    for (const repo of repos) {
        const item = repo.otherWorktrees.get(uriString);
        if (item) {
            return item;
        }
    }
    return undefined;
}

async function openTreeItem(item: TreeID | undefined, newWindow: boolean) {
    let path: vscode.Uri | undefined = undefined;
    if (isRepositoryTreeID(item)) {
        path = vscode.Uri.parse(item.slice("repository:".length));
    } else if (isSubworktreeTreeID(item)) {
        path = findSubworktreeDir(item);
    } else {
        // todo: let them pick
    }

    await vscode.commands.executeCommand("vscode.openFolder", path, { forceNewWindow: newWindow });
}

/**
 * Starts tracking a repo if it is not already tracked
 * @param rootDir The main directory which contains the `.git` directory
 */
function trackRepo(rootDir: vscode.Uri, context: vscode.ExtensionContext) {
    if (repos.find((v) => v.rootWorktree.toString(true) === rootDir.toString(true))) {
        console.log("Skipping duplicate");
        return; // this is already tracked
    }
    console.log("Now tracking repository:", rootDir.toString(true));

    const repo = new Repo(rootDir);
    repos.push(repo);
    context.subscriptions.push(repo);
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

                const rootDir = /^gitdir\: (.+)\/\.git\/worktrees\/[^\/]+\n$/.exec(text)?.[1];
                if (!rootDir) {
                    vscode.window.showErrorMessage("Parsing worktree .git file failed.");
                    throw new Error("idk");
                }

                trackRepo(localDotGit.with({ path: rootDir }), context);
            } else {
                throw new Error(".git should be a file or directory ):");
            }
        }),
        vscode.commands.registerCommand(
            "git-worktree.open-worktree-new-window",
            async (treeitem?: TreeID) => await openTreeItem(treeitem, true),
        ),
        vscode.window.registerTreeDataProvider<TreeID>("git-worktrees", {
            onDidChangeTreeData: updateEvent.event,
            getTreeItem: function (element: TreeID): vscode.TreeItem | Thenable<vscode.TreeItem> {
                if (isSubworktreeTreeID(element)) {
                    const worktreeName = element.slice(element.lastIndexOf("/") + 1);
                    const treeitem = new vscode.TreeItem(worktreeName);
                    treeitem.iconPath = new vscode.ThemeIcon("git-branch");
                    treeitem.contextValue = "git-subworktree";
                    return treeitem;
                } else if (isRepositoryTreeID(element)) {
                    const repoName = element.slice(element.lastIndexOf("/") + 1);
                    const treeitem = new vscode.TreeItem(
                        repoName,
                        vscode.TreeItemCollapsibleState.Expanded,
                    );
                    treeitem.iconPath = new vscode.ThemeIcon("repo");
                    treeitem.contextValue = "git-mainworktree";
                    return treeitem;
                }
                throw new Error(`Invalid tree item: ${element}`);
            },
            getChildren: function (element?: TreeID): vscode.ProviderResult<TreeID[]> {
                if (!element) {
                    return repos.map((r) => `repository:${r.rootWorktree.toString()}` as const);
                } else if (isSubworktreeTreeID(element)) {
                    return [];
                } else if (isRepositoryTreeID(element)) {
                    const repo = findRepo(element);
                    if (!repo) {
                        throw new Error(`This repository does not seem to exist: ${element}`);
                    }
                    const items: SubworktreeTreeID[] = [];
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
