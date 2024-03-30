import * as vscode from "vscode";
import { readFileUTF8, uriJoinPath, writeFileUTF8 } from "./util";
import assert from "assert";

interface GlobalStateEventBase {
    type: GlobalStateEvent["type"];
}

export interface GlobalStatePinsChangedEvent extends GlobalStateEventBase {
    type: "pins_changed";
    readonly newPins: readonly vscode.Uri[];
}

export type GlobalStateEvent = GlobalStatePinsChangedEvent;

export class GlobalStateManager
    extends vscode.EventEmitter<GlobalStateEvent>
    implements vscode.Disposable
{
    private sub: vscode.Disposable[] = [];
    private uri: vscode.Uri;
    private _latestPins: vscode.Uri[] = [];
    get latestPins(): readonly vscode.Uri[] {
        return this._latestPins;
    }
    private async writePins(pins: readonly (string | vscode.Uri)[]) {
        const pinsUri = uriJoinPath(this.uri, "pins");
        await writeFileUTF8(pinsUri, JSON.stringify(pins.map((uri) => uri.toString())));
        console.log("Updated pins");
    }
    isPinned(uri: string | vscode.Uri): boolean {
        return this.latestPins.some((pin) => pin.toString() === uri.toString());
    }
    async addPinned(...uris: (string | vscode.Uri)[]) {
        const stringUris = uris.map((u) => u.toString());
        const toAdd = stringUris.filter((u) => !this.isPinned(u));
        if (toAdd.length === 0) {
            return;
        }
        await this.writePins([...this.latestPins, ...toAdd]);
    }
    async removePinned(...uris: (string | vscode.Uri)[]) {
        const stringUris = uris.map((u) => u.toString());
        const filtered = this.latestPins.filter((pin) => !stringUris.includes(pin.toString()));
        if (filtered.length >= this.latestPins.length) {
            return;
        }
        await this.writePins(filtered);
    }

    private constructor(globalStorageUri: vscode.Uri) {
        super();

        if (!vscode.workspace.fs.isWritableFileSystem(globalStorageUri.scheme)) {
            console.warn(
                "WARNING: Global state file system is not writable. Any changes made by this workspace will be lost.",
            );
        }

        this.uri = globalStorageUri;
    }

    /** Updates the pins to the latest. Does not emit events. */
    private async updatePins() {
        const pinsUri = uriJoinPath(this.uri, "pins");
        try {
            const pinsRaw = await readFileUTF8(pinsUri);
            const pinsJson: string[] = JSON.parse(pinsRaw);
            assert(Array.isArray(pinsJson));
            pinsJson.forEach((item) => assert(typeof item === "string"));
            this._latestPins = pinsJson.map((p) => vscode.Uri.parse(p));
        } catch {
            this._latestPins = [];
            await writeFileUTF8(pinsUri, "[]");
        }
    }

    static async init(globalStorageUri: vscode.Uri): Promise<GlobalStateManager> {
        const ret = new GlobalStateManager(globalStorageUri);

        await vscode.workspace.fs.createDirectory(ret.uri);
        await ret.updatePins();
        console.log(
            "Initial pins",
            ret.latestPins.map((pin) => pin.toString()),
        );

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(ret.uri, "{pins}"),
            true,
            false,
            true,
        );
        ret.sub.push(
            watcher,
            watcher.onDidChange(async (uri) => {
                const filename = uri.path.slice(uri.path.lastIndexOf("/") + 1);
                switch (filename) {
                    case "pins":
                        await ret.updatePins();
                        ret.fire({
                            type: "pins_changed",
                            newPins: ret._latestPins,
                        });
                        console.log(
                            "Pins changed",
                            ret._latestPins.map((uri) => uri.toString()),
                        );
                        return;
                    default:
                        // ignore other files
                        return;
                }
            }),
        );

        return ret;
    }

    dispose(): void {
        this.sub.forEach((d) => d.dispose());
    }
}
