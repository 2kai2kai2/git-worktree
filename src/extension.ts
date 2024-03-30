import * as vscode from "vscode";
import { GitExtension, Ref, RefType } from "./git";
import { BasicWorktreeData, Repo } from "./repo";
import { readFileUTF8, refDisplayName, uriJoinPath, writeFileUTF8 } from "./util";
import { GlobalStateManager } from "./globalState";
import assert from "assert";
import { execute } from "./execute";

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
const repos: Repo[] = [];
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

    await vscode.commands.executeCommand("vscode.openFolder", repo?.dotgitdir.with({ path }), {
        forceNewWindow: newWindow,
    });
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
        logger.info("Skipping duplicate");
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
            "git-worktree.open-worktree-new-window",
            async (treeitem?: TreeID) => {
                if (isWorktreeTreeID(treeitem)) {
                    await openTreeItem(treeitem, true);
                }
            },
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
                const gitExtensionRepo = git_extension.getRepository(repo.dotgitdir);
                if (!gitExtensionRepo) {
                    throw new Error(`Failed to get repository data (${repo.dotgitdir.toString()})`);
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
                    defaultUri: uriJoinPath(repo.dotgitdir, "..", ref.name ?? ""),
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
            async (treeitem: WorktreeTreeID) => {
                if (!isWorktreeTreeID(treeitem)) {
                    vscode.window.showErrorMessage("Valid worktree must be specified");
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

                const { error, stderr } = await repo.executeInRepo(
                    git_extension.git.path,
                    "worktree",
                    "remove",
                    worktreeDir,
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
        vscode.commands.registerCommand("git-worktree.remove-all-pins", async () => {
            await writeFileUTF8(uriJoinPath(context.globalStorageUri, "pins"), "[]");
        }),
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
                if (isWorktreeTreeID(element)) {
                    const worktree = findWorktree(element);
                    const treeitem = new vscode.TreeItem(
                        refDisplayName(worktree?.branch ?? worktree?.HEAD ?? "ERROR: NO DATA"),
                    );
                    treeitem.iconPath = new vscode.ThemeIcon("git-branch");
                    treeitem.contextValue = "git-worktree:worktree";
                    treeitem.description = element.slice(element.lastIndexOf("/") + 1);
                    treeitem.tooltip = worktree?.HEAD ?? worktree?.branch ?? treeitem.description;

                    return treeitem;
                } else if (isRepositoryTreeID(element)) {
                    const repoName = /\/([^/]+)\/[^/]+\/?$/.exec(element)?.[1];
                    const treeitem = new vscode.TreeItem(
                        repoName ?? "/",
                        vscode.TreeItemCollapsibleState.Expanded,
                    );
                    treeitem.iconPath = new vscode.ThemeIcon("repo");
                    const stringUri = element.slice("repository:".length);
                    treeitem.contextValue = globalStateManager.isPinned(stringUri)
                        ? "git-worktree:repo-pinned"
                        : "git-worktree:repo-unpinned";
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
