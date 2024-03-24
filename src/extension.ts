import * as vscode from "vscode";
import { GitExtension, Ref, RefType } from "./git";
import { Repo } from "./repo";
import { readFileUTF8, uriJoinPath } from "./util";
import { execute } from "./execute";

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
        vscode.commands.registerCommand(
            "git-worktree.add-new-worktree",
            async (treeitem: TreeID) => {
                if (!treeitem) {
                    throw new Error("Repository must be specified");
                }
                let repo = findRepo(treeitem);
                if (!repo) {
                    throw new Error(`Unable to find repository (${treeitem})`);
                }
                const gitExtensionRepo = git_extension.getRepository(repo.rootWorktree);
                if (!gitExtensionRepo) {
                    throw new Error(
                        `Failed to get repository data (${repo.rootWorktree.toString()})`,
                    );
                }
                const refs = await gitExtensionRepo.getRefs({});

                const quickpickItems: (vscode.QuickPickItem & { ref?: Ref })[] = [
                    {
                        label: "local",
                        kind: vscode.QuickPickItemKind.Separator,
                    },
                    ...refs
                        .filter((r) => r.type === RefType.Head)
                        .map<vscode.QuickPickItem & { ref: Ref }>((r) => ({
                            label: r.name ?? "UNKNOWN NAME",
                            description: r.commit,
                            ref: r,
                        })),
                ];
                const ref = (await vscode.window.showQuickPick(quickpickItems))?.ref;
                if (!ref || !(ref.name || ref.commit)) {
                    return;
                }
                const pickedLocation = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    title: "Select Worktree Location",
                    defaultUri: uriJoinPath(repo.rootWorktree, ref.name ?? ""),
                });
                if (!pickedLocation) {
                    return;
                }

                const command = `(cd ${repo.rootWorktree.path} && ${git_extension.git.path} worktree add ${pickedLocation[0].path} ${ref.name ?? ref.commit})`;
                const { error, stderr } = await execute(command);
                if (error) {
                    vscode.window
                        .showErrorMessage(
                            "oopies! that probably didn't work.",
                            "Show Command Result",
                        )
                        .then((v) => {
                            if (v) {
                                vscode.workspace.openTextDocument({
                                    language: "text",
                                    content: `${command}\n${stderr}`,
                                });
                            }
                        });
                    return;
                }
            },
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
