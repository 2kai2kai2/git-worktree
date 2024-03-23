import * as vscode from "vscode";
import { GitExtension } from "./git";
import { Repo } from "./repo";
import { readFileUTF8, uriJoinPath } from "./util";

const e = new vscode.EventEmitter<1>();
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
}

export function activate(context: vscode.ExtensionContext) {
    const git_extension = vscode.extensions
        .getExtension<GitExtension>("vscode.git")
        ?.exports?.getAPI(1);
    if (!git_extension) {
        vscode.window.showErrorMessage("Failed to get data from the built-in git extension.");
        throw new Error("idk");
    }

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
    });
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("git-worktrees", {
            onDidChangeTreeData: e.event,
            getTreeItem: function (element: unknown): vscode.TreeItem | Thenable<vscode.TreeItem> {
                throw new Error("Function not implemented.");
            },
            getChildren: function (element?: unknown): vscode.ProviderResult<unknown[]> {
                throw new Error("Function not implemented.");
            },
        }),
    );
}

export function deactivate() {}
