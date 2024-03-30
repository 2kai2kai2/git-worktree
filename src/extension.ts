import * as vscode from "vscode";
import { GitExtension, Ref, RefType } from "./git";
import { Repo, SubWorktreeInfo } from "./repo";
import { readFileUTF8, uriJoinPath } from "./util";
import { GlobalStateManager } from "./globalState";

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
function findSubworktree(treeid: SubworktreeTreeID): SubWorktreeInfo | undefined {
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
        path = findSubworktree(item)?.dir;
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

export async function activate(context: vscode.ExtensionContext) {
    const git_extension = vscode.extensions
        .getExtension<GitExtension>("vscode.git")
        ?.exports?.getAPI(1);
    if (!git_extension) {
        throw new Error("Failed to get data from the built-in git extension.");
    }

    const globalStateManager = await GlobalStateManager.init(context.globalStorageUri);

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
                    return;
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
                    vscode.window.showErrorMessage("Repository must be specified");
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
                        label: "Local",
                        kind: vscode.QuickPickItemKind.Separator,
                    },
                    ...refs
                        .filter((r) => r.type === RefType.Head)
                        .map<vscode.QuickPickItem & { ref: Ref }>((r) => ({
                            label: r.name ?? "UNKNOWN NAME",
                            description: r.commit,
                            ref: r,
                        })),
                    {
                        label: "Remote",
                        kind: vscode.QuickPickItemKind.Separator,
                    },
                    ...refs
                        .filter((r) => r.type === RefType.RemoteHead)
                        .map<vscode.QuickPickItem & { ref: Ref }>((r) => ({
                            label: r.name ?? "UNKNOWN NAME",
                            description: r.commit,
                            ref: r,
                        })),
                    {
                        label: "Tags",
                        kind: vscode.QuickPickItemKind.Separator,
                    },
                    ...refs
                        .filter((r) => r.type === RefType.Tag)
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

                const { error, stderr } = await repo.executeInRepo(
                    git_extension.git.path,
                    "worktree",
                    "add",
                    pickedLocation[0].path,
                    ref.name ?? ref.commit ?? "",
                );
                if (error) {
                    vscode.window.showErrorMessage(stderr);
                    return;
                }
            },
        ),
        vscode.commands.registerCommand(
            "git-worktree.remove-worktree",
            async (treeitem: SubworktreeTreeID) => {
                if (!isSubworktreeTreeID(treeitem)) {
                    vscode.window.showErrorMessage("Valid sub-worktree must be specified");
                }

                const location = findSubworktree(treeitem)?.dir;
                if (!location) {
                    throw new Error("Failed to lookup the location of the specified worktree.");
                }
                const repo = findRepo(treeitem);
                if (!repo) {
                    throw new Error(
                        "Failed to lookup the repository that this worktree belongs to.",
                    );
                }

                const confirm = await vscode.window.showWarningMessage(
                    "Are you sure you want to remove the worktree? This will delete the directory unless it is dirty or locked.",
                    "No",
                    "Yes",
                );
                if (confirm !== "Yes") {
                    return;
                }

                const { error, stderr } = await repo.executeInRepo(
                    git_extension.git.path,
                    "worktree",
                    "remove",
                    location.path,
                );
                if (error) {
                    vscode.window.showErrorMessage(stderr);
                    return;
                }
            },
        ),
        vscode.commands.registerCommand(
            "git-worktree.add-pinned-repository",
            async (treeitem: RepositoryTreeID) => {
                if (!isRepositoryTreeID(treeitem)) {
                    vscode.window.showErrorMessage("Valid treeitem repository must be specified");
                    return;
                }

                const stringUri = treeitem.slice("repository:".length);
                await globalStateManager.addPinned(stringUri);
            },
        ),
        vscode.commands.registerCommand(
            "git-worktree.remove-pinned-repository",
            async (treeitem: RepositoryTreeID) => {
                if (!isRepositoryTreeID(treeitem)) {
                    vscode.window.showErrorMessage("Valid treeitem repository must be specified");
                    return;
                }

                const stringUri = treeitem.slice("repository:".length);
                await globalStateManager.removePinned(stringUri);
            },
        ),
        vscode.commands.registerCommand(
            "git-worktree.fetch-repository",
            async (treeitem: RepositoryTreeID) => {
                const repo = findRepo(treeitem);
                if (!repo) {
                    vscode.window.showErrorMessage("Valid treeitem repository must be specified");
                    return;
                }
                const { error, stdout, stderr } = await vscode.window.withProgress(
                    {
                        location: { viewId: "git-worktrees" },
                        title: "Running git fetch",
                    },
                    async () => await repo.executeInRepo(git_extension.git.path, "fetch"),
                );
                console.log([error, stdout, stderr]);
                if (error) {
                    vscode.window.showErrorMessage(stderr);
                    return;
                } else {
                    vscode.window.showInformationMessage(stdout);
                    return;
                }
            },
        ),
        vscode.window.registerTreeDataProvider<TreeID>("git-worktrees", {
            onDidChangeTreeData: updateEvent.event,
            async getTreeItem(element: TreeID): Promise<vscode.TreeItem> {
                if (isSubworktreeTreeID(element)) {
                    const treeitem = new vscode.TreeItem(
                        findSubworktree(element)?.ref ?? "UNKNOWN REF",
                    );
                    treeitem.iconPath = new vscode.ThemeIcon("git-branch");
                    treeitem.contextValue = "git-subworktree";
                    treeitem.description = element.slice(element.lastIndexOf("/") + 1);

                    return treeitem;
                } else if (isRepositoryTreeID(element)) {
                    const repoName = element.slice(element.lastIndexOf("/") + 1);
                    const treeitem = new vscode.TreeItem(
                        repoName,
                        vscode.TreeItemCollapsibleState.Expanded,
                    );
                    treeitem.iconPath = new vscode.ThemeIcon("repo");
                    const stringUri = element.slice("repository:".length);
                    treeitem.contextValue = globalStateManager.isPinned(stringUri)
                        ? "git-repository-pinned"
                        : "git-repository-unpinned";
                    return treeitem;
                }
                throw new Error(`Invalid tree item: ${element}`);
            },
            getChildren(element?: TreeID): vscode.ProviderResult<TreeID[]> {
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
        globalStateManager,
        globalStateManager.event((ev) => {
            switch (ev.type) {
                case "pins_changed":
                    ev.newPins.forEach((pin) => trackRepo(pin, context));
                    updateEvent.fire(undefined);
            }
        }),
    );

    for (const pin of globalStateManager.latestPins) {
        trackRepo(pin, context);
    }
}

export function deactivate() {}
