import * as vscode from "vscode";
import { GitExtension, Ref, RefType } from "./git";
import { BasicWorktreeData, Repo } from "./repo";
import { refDisplayName, repoName, uriJoinPath, viewProgress, writeFileUTF8 } from "./util";
import { GlobalStateManager } from "./globalState";
import assert from "assert";
import { cleanPath, execute } from "./execute";
import { pickRef, pickRepository, pickWorktree } from "./quickPickers";

/** content is a stringified uri */
export type RepositoryTreeID = `repository:${string}`;
/** Content is just the file path (if necessary, assume other uri stuff is same as its repository) */
export type WorktreeTreeID = `worktree:${string}`;
export type TreeID = RepositoryTreeID | WorktreeTreeID;
function isRepositoryTreeID(treeid: TreeID | any): treeid is RepositoryTreeID {
    return typeof treeid === "string" && treeid.startsWith("repository:");
}
function isWorktreeTreeID(treeid: TreeID | any): treeid is WorktreeTreeID {
    return typeof treeid === "string" && treeid.startsWith("worktree:");
}
function repositoryTreeIDToUri(treeid: RepositoryTreeID): vscode.Uri {
    assert(isRepositoryTreeID(treeid));
    return vscode.Uri.parse(treeid.slice("repository:".length));
}
function worktreeTreeIDToPath(treeid: WorktreeTreeID): string {
    assert(isWorktreeTreeID(treeid));
    return treeid.slice("worktree:".length);
}

export const updateEvent = new vscode.EventEmitter<TreeID | undefined>();
export const repos: Repo[] = [];
function findRepo(treeid: TreeID): Repo | undefined {
    if (isRepositoryTreeID(treeid)) {
        return repos.find((r) => treeid === `repository:${r.dotgitdir.toString()}`);
    } else if (isWorktreeTreeID(treeid)) {
        const worktreeDir = worktreeTreeIDToPath(treeid);
        return repos.find((r) => r.worktrees.has(worktreeDir));
    }
    throw new Error(`Unrecognized TreeID: "${treeid}"`);
}
function findWorktree(treeid: WorktreeTreeID): BasicWorktreeData | undefined {
    const worktreePath = worktreeTreeIDToPath(treeid);
    for (const repo of repos) {
        const item = repo.worktrees.get(worktreePath);
        if (item) {
            return item;
        }
    }
    return undefined;
}

async function openTreeItem(item: WorktreeTreeID, newWindow: boolean) {
    const repo = findRepo(item);
    if (!repo) {
        throw new Error(`Was unable to find the corresponding repo for tree item "${item}"`);
    }
    const path = worktreeTreeIDToPath(item);

    await vscode.commands.executeCommand(
        "vscode.openFolder",
        repo?.dotgitdir.with({ path: cleanPath(path) }),
        {
            forceNewWindow: newWindow,
        },
    );
}

/**
 * To avoid race conditions, since it takes a bit to initialize and add a repo,
 * all current and upcoming tracked repos dotgitdirs go here
 * Make sure that checking and updating happen synchronously to avoid race conditions
 */
const trackedRepos: vscode.Uri[] = [];

/**
 * Starts tracking a repo if it is not already tracked
 * @param dotgitdir The '.git' directory for the new repository
 */
async function trackRepo(dotgitdir: vscode.Uri, context: vscode.ExtensionContext) {
    if (trackedRepos.find((v) => v.toString(true) === dotgitdir.toString(true))) {
        logger.trace("Skipping duplicate of", dotgitdir.toString(true));
        return; // this is already tracked
    }
    trackedRepos.push(dotgitdir);

    const repo = await Repo.init(dotgitdir);
    repos.push(repo);
    context.subscriptions.push(repo);
    logger.info("Now tracking repository:", dotgitdir.toString(true));
    updateEvent.fire(undefined);
}

export let gitExecutable: string;
export let logger: vscode.LogOutputChannel;
export async function activate(context: vscode.ExtensionContext) {
    logger = vscode.window.createOutputChannel("Git Worktrees View", { log: true });
    logger.info(" ==== STARTING ==== ");

    const git_extension = vscode.extensions
        .getExtension<GitExtension>("vscode.git")
        ?.exports?.getAPI(1);
    if (!git_extension) {
        throw new Error("Failed to get data from the built-in git extension.");
    }
    gitExecutable = git_extension.git.path;

    const globalStateManager = await GlobalStateManager.init(context.globalStorageUri);

    context.subscriptions.push(
        git_extension.onDidOpenRepository(async (repository) => {
            const { error, stdout, stderr } = await execute(
                gitExecutable,
                ["rev-parse", "--path-format=absolute", "--git-common-dir"],
                { cwd: repository.rootUri.path },
            );
            if (error) {
                vscode.window.showErrorMessage(stderr);
                return;
            }

            await trackRepo(repository.rootUri.with({ path: stdout.trim() }), context);
        }),
        vscode.commands.registerCommand(
            "worktrees.open-worktree-new-window",
            async (treeitem?: WorktreeTreeID) => {
                if (!isWorktreeTreeID(treeitem)) {
                    const choice = await pickWorktree("Pick Worktree to Open");
                    if (!isWorktreeTreeID(choice)) {
                        return;
                    }
                    treeitem = choice;
                }
                await openTreeItem(treeitem, true);
            },
        ),
        vscode.commands.registerCommand("worktrees.add-new-worktree", async (treeitem: TreeID) => {
            if (!treeitem) {
                const chosen = await pickRepository();
                if (!chosen) {
                    return;
                }
                treeitem = chosen;
            }
            let repo = findRepo(treeitem);
            if (!repo) {
                vscode.window.showErrorMessage(`Unable to find repository (${treeitem})`);
                return;
            }

            const ref = await pickRef(
                repo,
                "Pick branch for new worktree",
                (ref) => {
                    const fullRef = `refs/${ref.type}/${ref.ref}`;
                    for (const [, wt] of repo!.worktrees) {
                        if (wt.branch === fullRef) {
                            return false;
                        }
                    }
                    return true;
                },
                "There are no more branches to make worktrees for! Maybe you want to fetch?",
            );
            if (!ref) {
                return;
            }
            const pickedLocation = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                title: "Select Worktree Location",
                defaultUri: uriJoinPath(repo.dotgitdir, "..", ref.ref),
            });
            if (!pickedLocation) {
                return;
            }

            const { error, stderr } = await viewProgress(
                repo.executeInRepo(
                    git_extension.git.path,
                    "worktree",
                    "add",
                    cleanPath(pickedLocation[0].path),
                    ref.ref,
                ),
                "Adding worktree",
            );
            if (error) {
                throw new Error(stderr);
            }
        }),
        vscode.commands.registerCommand(
            "worktrees.remove-worktree",
            async (treeitem: WorktreeTreeID) => {
                if (!isWorktreeTreeID(treeitem)) {
                    const selected = await pickWorktree(
                        "Pick Worktree to Remove",
                        (wt, repo) => wt.order !== 0,
                        "There are no worktrees that can be removed.",
                    );
                    if (!isWorktreeTreeID(selected)) {
                        return;
                    }
                    treeitem = selected;
                }

                const worktreeDir = worktreeTreeIDToPath(treeitem);
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

                const { error, stderr } = await viewProgress(
                    repo.executeInRepo(
                        git_extension.git.path,
                        "worktree",
                        "remove",
                        cleanPath(worktreeDir),
                    ),
                    "Removing worktree",
                );
                if (error) {
                    vscode.window.showErrorMessage(stderr);
                    return;
                }
            },
        ),
        vscode.commands.registerCommand(
            "worktrees.add-pinned-repository",
            async (treeitem: RepositoryTreeID) => {
                if (!isRepositoryTreeID(treeitem)) {
                    const chosen = await pickRepository(
                        "Pin selected repository",
                        (repo) => !globalStateManager.isPinned(repo.dotgitdir),
                        "All repositories are already pinned.",
                    );
                    if (!isRepositoryTreeID(chosen)) {
                        return;
                    }
                    treeitem = chosen;
                }

                const stringUri = treeitem.slice("repository:".length);
                await globalStateManager.addPinned(stringUri);
            },
        ),
        vscode.commands.registerCommand(
            "worktrees.remove-pinned-repository",
            async (treeitem: RepositoryTreeID) => {
                if (!isRepositoryTreeID(treeitem)) {
                    const chosen = await pickRepository(
                        "Unpin selected repository",
                        (repo) => globalStateManager.isPinned(repo.dotgitdir),
                        "There are no pinned repositories.",
                    );
                    if (!isRepositoryTreeID(chosen)) {
                        return;
                    }
                    treeitem = chosen;
                }

                const stringUri = treeitem.slice("repository:".length);
                await globalStateManager.removePinned(stringUri);
            },
        ),
        vscode.commands.registerCommand("worktrees.remove-all-pins", async () => {
            await writeFileUTF8(uriJoinPath(context.globalStorageUri, "pins"), "[]");
        }),
        vscode.commands.registerCommand(
            "worktrees.fetch-repository",
            async (treeitem: RepositoryTreeID) => {
                if (!isRepositoryTreeID(treeitem)) {
                    const chosen = await pickRepository(
                        "Pin selected repository",
                        undefined,
                        "There are no available repositories to fetch.",
                    );
                    if (!isRepositoryTreeID(chosen)) {
                        return;
                    }
                    treeitem = chosen;
                }
                const repo = findRepo(treeitem);
                if (!repo) {
                    vscode.window.showErrorMessage("Was unable to find repository.");
                    return;
                }

                const { error, stdout, stderr } = await viewProgress(
                    repo.executeInRepo(git_extension.git.path, "fetch"),
                    "Running git fetch",
                );
                if (error) {
                    vscode.window.showErrorMessage(stderr);
                    return;
                } else {
                    vscode.window.showInformationMessage(stdout);
                    return;
                }
            },
        ),
        vscode.commands.registerCommand(
            "worktrees.open-in-integrated-terminal",
            async (element?: WorktreeTreeID) => {
                if (isWorktreeTreeID(element)) {
                    vscode.window
                        .createTerminal({ cwd: cleanPath(worktreeTreeIDToPath(element)) })
                        .show();
                } else {
                    const worktree = await pickWorktree();
                    if (worktree) {
                        vscode.window
                            .createTerminal({ cwd: cleanPath(worktreeTreeIDToPath(worktree)) })
                            .show();
                    }
                }
            },
        ),
        vscode.window.registerTreeDataProvider<TreeID>("git-worktrees", {
            onDidChangeTreeData: updateEvent.event,
            async getTreeItem(element: TreeID): Promise<vscode.TreeItem> {
                if (isWorktreeTreeID(element)) {
                    const worktree = findWorktree(element);
                    const treeitem = new vscode.TreeItem(
                        refDisplayName(worktree?.branch ?? worktree?.HEAD ?? "ERROR: NO DATA"),
                    );
                    treeitem.iconPath = new vscode.ThemeIcon("git-branch");
                    treeitem.contextValue = "worktrees:worktree";
                    treeitem.description = element.slice(element.lastIndexOf("/") + 1);
                    treeitem.tooltip = worktree?.HEAD ?? worktree?.branch ?? treeitem.description;

                    return treeitem;
                } else if (isRepositoryTreeID(element)) {
                    const treeitem = new vscode.TreeItem(
                        repoName(element),
                        vscode.TreeItemCollapsibleState.Expanded,
                    );
                    treeitem.iconPath = new vscode.ThemeIcon("repo");
                    const stringUri = element.slice("repository:".length);
                    treeitem.contextValue = globalStateManager.isPinned(stringUri)
                        ? "worktrees:repo-pinned"
                        : "worktrees:repo-unpinned";
                    return treeitem;
                }
                throw new Error(`Invalid tree item: ${element}`);
            },
            getChildren(element?: TreeID): vscode.ProviderResult<TreeID[]> {
                if (!element) {
                    return repos.map((r) => `repository:${r.dotgitdir.toString()}` as const);
                } else if (isWorktreeTreeID(element)) {
                    return [];
                } else if (isRepositoryTreeID(element)) {
                    const repo = findRepo(element);
                    if (!repo) {
                        throw new Error(`This repository does not seem to exist: ${element}`);
                    }
                    const items: WorktreeTreeID[] = [];
                    for (const [k, v] of repo.worktrees) {
                        if (v.HEAD) {
                            items.push(`worktree:${k}`);
                        }
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
                    ev.newPins.forEach(async (pin) => await trackRepo(pin, context));
                    updateEvent.fire(undefined);
            }
        }),
    );

    for (const repository of git_extension.repositories) {
        const { error, stdout, stderr } = await execute(
            gitExecutable,
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            { cwd: repository.rootUri.path },
        );
        if (error) {
            vscode.window.showErrorMessage(stderr);
            return;
        }

        await trackRepo(repository.rootUri.with({ path: stdout.trim() }), context);
    }

    for (const pin of globalStateManager.latestPins) {
        await trackRepo(pin, context);
    }
    logger.info("Reached the end of activate()");
}

export function deactivate() {
    logger.info("Deactivating.");
}
