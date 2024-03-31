import * as vscode from "vscode";
import { WorktreeTreeID, RepositoryTreeID, repos, gitExecutable, logger } from "./extension";
import { BasicWorktreeData, Repo } from "./repo";
import { refDisplayName, repoName } from "./util";

type pickWorktreeItem = vscode.QuickPickItem & { worktree: WorktreeTreeID };
export async function pickWorktree(
    title: string = "Pick Worktree",
    filter: (worktree: Readonly<BasicWorktreeData>, repo: Readonly<Repo>) => boolean = () => true,
): Promise<WorktreeTreeID | undefined> {
    const picked = await vscode.window.showQuickPick<pickWorktreeItem>(
        repos.flatMap((repo) =>
            Array.from(repo.worktrees)
                .filter(([_, wt]) => filter(wt, repo))
                .map<pickWorktreeItem>(([_, wt]) => ({
                    worktree: `worktree:${wt.worktree}`,
                    label: refDisplayName(wt.branch ?? wt.HEAD ?? "NO NAME"),
                    description: wt.worktree,
                })),
        ),
        {
            canPickMany: false,
            title,
        },
    );
    return picked?.worktree;
}

type pickRepositoryItem = vscode.QuickPickItem & { repository: RepositoryTreeID };
export async function pickRepository(
    title: string = "Pick Repository",
    filter: (repo: Readonly<Repo>) => boolean = () => true,
): Promise<RepositoryTreeID | undefined> {
    const picked = await vscode.window.showQuickPick<pickRepositoryItem>(
        repos.filter(filter).map((repo) => ({
            repository: `repository:${repo.dotgitdir.toString()}`,
            label: repoName(repo.dotgitdir),
            description: repo.dotgitdir.path,
        })),
        {
            canPickMany: false,
            title,
        },
    );
    return picked?.repository;
}

export interface Ref {
    /** The commit hash */
    hash: string;
    /** The type, e.g. "heads", "remotes", or "tags" */
    type: string;
    /** The ref name, e.g. "main" or "origin/main" */
    ref: string;
}
type pickRefItem = vscode.QuickPickItem &
    ({ kind: vscode.QuickPickItemKind.Separator; ref?: Ref } | { ref: Ref });
export async function pickRef(
    repo: Readonly<Repo>,
    title: string = "Pick Ref",
    filter: (ref: Ref) => boolean = () => true,
): Promise<Ref | undefined> {
    const {
        error: showRefErr,
        stdout: showRefStdout,
        stderr: showRefStderr,
    } = await repo.executeInRepo(gitExecutable, "show-ref");
    if (showRefErr) {
        throw new Error(showRefStderr);
    }
    const refs = showRefStdout
        .trim()
        .split("\n")
        .flatMap((r) => {
            if (r.includes("refs/stash")) {
                return [];
            }
            const result = /^([\da-fA-F]{40}) refs\/([^/]+)\/(.*)$/.exec(r.trim());
            if (!result) {
                logger.warn("Unable to parse ref:", r);
                return [];
            }
            return {
                hash: result[1],
                type: result[2],
                ref: result[3],
            } as const;
        })
        .filter(filter);

    const quickpickItems: pickRefItem[] = [
        {
            label: "Local",
            kind: vscode.QuickPickItemKind.Separator,
        },
        ...refs
            .filter((r) => r.type === "heads")
            .map<pickRefItem>((r) => ({
                label: r.ref ?? "UNKNOWN NAME",
                description: r.hash,
                ref: r,
            })),
        {
            label: "Remote",
            kind: vscode.QuickPickItemKind.Separator,
        },
        ...refs
            .filter((r) => r.type === "remotes")
            .map<pickRefItem>((r) => ({
                label: r.ref ?? "UNKNOWN NAME",
                description: r.hash,
                ref: r,
            })),
        {
            label: "Tags",
            kind: vscode.QuickPickItemKind.Separator,
        },
        ...refs
            .filter((r) => r.type === "tags")
            .map<pickRefItem>((r) => ({
                label: r.ref ?? "UNKNOWN NAME",
                description: r.hash,
                ref: r,
            })),
    ];
    const result = await vscode.window.showQuickPick(quickpickItems);
    return result?.ref!;
}
