import type { DataAdapter } from "obsidian";
import * as Y from "yjs";
import { atomicWrite, atomicWriteBinary, bytesToBase64 } from "../sync/storage";

export class YjsStateStore {
  constructor(private readonly adapter: DataAdapter, private readonly directory: string) {}

  async load(fileId: string): Promise<Uint8Array | null> {
    const path = `${this.directory}/${fileId}.bin`;
    if (!(await this.adapter.exists(path))) return null;
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  async save(fileId: string, doc: Y.Doc): Promise<void> {
    const update = Y.encodeStateAsUpdate(doc);
    const vector = Y.encodeStateVector(doc);
    await atomicWriteBinary(this.adapter, `${this.directory}/${fileId}.bin`, update.slice().buffer);
    await atomicWrite(this.adapter, `${this.directory}/${fileId}.json`, JSON.stringify({
      stateVector: bytesToBase64(vector),
      updatedAt: new Date().toISOString(),
    }));
  }

  async apply(fileId: string, update: Uint8Array): Promise<{ doc: Y.Doc; text: string }> {
    const doc = new Y.Doc();
    const current = await this.load(fileId);
    if (current) Y.applyUpdate(doc, current);
    Y.applyUpdate(doc, update);
    await this.save(fileId, doc);
    return { doc, text: doc.getText("content").toJSON() };
  }

  async remove(fileId: string): Promise<void> {
    for (const suffix of ["bin", "json"]) {
      const path = `${this.directory}/${fileId}.${suffix}`;
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
    }
  }
}
