import { Dexie } from 'dexie';
import * as y from 'yjs';
import { outboxData, Path } from '../../../shared/types';



export class yDb extends Dexie {

    private outbox !: Dexie.Table<outboxData, number>;
    constructor() {
        super('obsidian-sync-engine');
        this.version(1).stores({
            updates: '++id, path'
        });
        this.version(2).stores({
            updates: null,
            outbox: '++id, fileid, operation, data',
            inbox: '++id, fileid, operation, data'
        });
        this.version(3).stores({
            outbox: '++id, fileid, operation, data, created',
            inbox: '++id, fileid, operation, data, updated'
        });
        this.version(4).stores({
            outbox: '++id, fileId, operation, data, created',
            inbox: '++id, fileId, operation, data, updated'
        });
        this.version(5).stores({
            outbox: '++id, fileId, operation, created',
            inbox: '++id, fileId, operation, updated'
        });
    }

    // async insert(data: yDbRow){
    //     return await this.updates.add({path: data.path, data: data.data})
    // }

    public putInOutbox(row: outboxData){
        // return outbox.add()
        // console.log("putting in outbox" + JSON.stringify(row));
        return this.outbox.add(row);
    }

    public getFirstOutbox(){
        return this.outbox.orderBy("created").first();
    }

    public removeOutbox(id: number){
        return this.outbox.delete(id);
    }
}
