import path from "path";
import * as vscode from "vscode";
import { RepositoryTreeID } from "./extension";

export async function readFileUTF8(uri: vscode.Uri): Promise<string> {
    return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
}
export async function writeFileUTF8(uri: vscode.Uri, text: string) {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

export function uriJoinPath(uri: vscode.Uri, ...paths: string[]): vscode.Uri {
    return uri.with({
        path: path.posix.join(uri.path, ...paths),
    });
}

/**
 * Produces a displayable version of a ref or commit hash
 *
 * @example
 * refOrDisplayName("2a29b70f140b7bbebc42e0c95f3a7e294ae92e6c") === "2a29b70"
 * refOrDisplayName("refs/heads/main") === "main"
 */
export function refDisplayName(refOrHash: string): string {
    if (/^[\da-fA-F]{40}$/.test(refOrHash)) {
        return refOrHash.slice(0, 8);
    }

    const refMatch = /^\/?refs\/[^/]+\/(.+)$/.exec(refOrHash)?.[1];
    if (refMatch) {
        return refMatch;
    }

    console.warn("Failed to generate a display name for", refOrHash);
    return refOrHash;
}

export function repoName(repo: vscode.Uri | RepositoryTreeID): string {
    if (typeof repo === "string") {
        return /\/([^/]+)\/[^/]+\/?$/.exec(repo)?.[1] ?? "/";
    } else {
        return /\/([^/]+)\/[^/]+\/?$/.exec(repo.path)?.[1] ?? "/";
    }
}

export async function viewProgress<T>(
    callback: Promise<T> | Parameters<typeof vscode.window.withProgress<T>>[1],
    title?: string,
): Promise<T> {
    return await vscode.window.withProgress(
        {
            location: { viewId: "git-worktrees" },
            title,
        },
        typeof callback === "function" ? callback : async () => await callback,
    );
}
