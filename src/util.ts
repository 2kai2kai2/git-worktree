import path from "path";
import * as vscode from "vscode";

export async function readFileUTF8(uri: vscode.Uri): Promise<string> {
    return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
}
export async function writeFileUTF8(uri: vscode.Uri, text: string) {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

export function uriJoinPath(uri: vscode.Uri, ...paths: string[]): vscode.Uri {
    return uri.with({
        path: path.join(uri.path, ...paths),
    });
}
