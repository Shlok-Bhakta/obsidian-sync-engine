import { Dexie } from 'dexie';
import * as y from 'yjs';


type yDbRow = {
    id?: number;
    path: string;
    data: Uint8Array;
}
export class yDb extends Dexie {
    updates: Dexie.Table<yDbRow, "id">;

    constructor() {
        super('obsidian-sync-engine');
        this.version(1).stores({
            updates: '++id, path' // id is auto-incrementing primary key
        });
    }

    async insert(data: yDbRow){
        return await this.updates.add({path: data.path, data: data.data})
    }

}