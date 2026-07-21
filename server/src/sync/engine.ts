import { sql } from "bun";
import * as Y from "yjs";
import {
  type Conflict,
  type Mutation,
  type MutationResponse,
  type MutationResult,
  type Revision,
} from "obsidian-sync-protocol";
import { objectStore, type ObjectStore } from "../storage/object_store";

type FileRow = {
  id: string;
  current_path: string;
  kind: "markdown" | "blob";
  deleted: boolean;
  current_revision: string;
  object_hash: string | null;
  yjs_state_hash: string | null;
};

type EventRow = {
  revision: string;
  mutation_id: string;
};

export class SyncEngine {
  private revisionListeners = new Set<(revision: Revision) => void>();

  constructor(private readonly store: ObjectStore = objectStore) {}

  onRevision(listener: (revision: Revision) => void): () => void {
    this.revisionListeners.add(listener);
    return () => this.revisionListeners.delete(listener);
  }

  publishRevision(revision: Revision): void {
    for (const listener of this.revisionListeners) listener(revision);
  }

  async currentRevision(): Promise<Revision> {
    const [row] = await sql<{ revision: string }[]>`
      SELECT COALESCE(MAX(revision), 0)::text AS revision FROM sync_events
    `;
    return row?.revision ?? "0";
  }

  async bootstrapRequired(): Promise<boolean> {
    const [row] = await sql<{ bootstrap_state: string }[]>`SELECT bootstrap_state FROM server_meta WHERE singleton = TRUE`;
    return row?.bootstrap_state !== "committed";
  }

  async applyMutations(clientId: string, mutations: Mutation[]): Promise<MutationResponse> {
    const accepted: MutationResult[] = [];
    const conflicts: Conflict[] = [];
    for (const mutation of mutations) {
      const result = await this.applyOne(clientId, mutation);
      if ("status" in result) accepted.push(result);
      else conflicts.push(result);
    }
    const currentServerRevision = await this.currentRevision();
    if (accepted.length > 0) {
      this.publishRevision(currentServerRevision);
    }
    return { accepted, conflicts, currentServerRevision };
  }

  private async applyOne(clientId: string, mutation: Mutation): Promise<MutationResult | Conflict> {
    const referencedHash = mutation.objectHash;
    if (referencedHash && !(await this.store.has(referencedHash))) {
      return {
        mutationId: mutation.mutationId,
        code: "FILE_NOT_FOUND",
        fileId: mutation.fileId,
        path: mutation.path,
        currentRevision: mutation.baseRevision,
        deleted: false,
      };
    }

    let canonicalYjsHash: string | null = null;
    const outcome = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(73194522)`;
      const [duplicate] = await tx<EventRow[]>`
        SELECT revision::text, mutation_id
        FROM sync_events WHERE client_id = ${clientId} AND mutation_id = ${mutation.mutationId}
      `;
      if (duplicate) return { mutationId: duplicate.mutation_id, status: "accepted" as const, revision: duplicate.revision };

      const rows = await tx<FileRow[]>`
        SELECT id, current_path, kind, deleted, current_revision::text, object_hash, yjs_state_hash
        FROM files WHERE id = ${mutation.fileId} FOR UPDATE
      `;
      const file = rows[0];

      if (mutation.operation === "create") {
        if (file && !file.deleted) return this.conflict(mutation, "STALE_REVISION", file);
        const occupied = await tx<FileRow[]>`
          SELECT id, current_path, kind, deleted, current_revision::text, object_hash, yjs_state_hash
          FROM files WHERE current_path = ${mutation.path} AND deleted = FALSE FOR UPDATE
        `;
        if (occupied[0] && occupied[0].id !== mutation.fileId) return this.conflict(mutation, "PATH_OCCUPIED", occupied[0]);
        const kind = mutation.path.toLowerCase().endsWith(".md") ? "markdown" : "blob";
        if (!mutation.objectHash) throw new Error("validated create mutation is missing objectHash");
        if (kind === "markdown") canonicalYjsHash = await this.compactYjs(null, mutation.objectHash);
        const revision = await this.nextRevision(tx);
        await tx`
          INSERT INTO files(id, current_path, kind, deleted, current_revision, object_hash, yjs_state_hash)
          VALUES (${mutation.fileId}, ${mutation.path}, ${kind}, FALSE, ${revision},
            ${kind === "blob" ? mutation.objectHash : null}, ${kind === "markdown" ? canonicalYjsHash : null})
          ON CONFLICT (id) DO UPDATE SET current_path = EXCLUDED.current_path, kind = EXCLUDED.kind,
            deleted = FALSE, current_revision = EXCLUDED.current_revision, object_hash = EXCLUDED.object_hash,
            yjs_state_hash = EXCLUDED.yjs_state_hash, updated_at = NOW()
        `;
        return this.insertEvent(tx, clientId, mutation, revision);
      }

      if (!file) return this.missingConflict(mutation);
      if (file.deleted && mutation.operation !== "rename") return this.conflict(mutation, "STALE_REVISION", file);

      if (mutation.operation === "yjs_update") {
        if (file.kind !== "markdown") return this.conflict(mutation, "KIND_MISMATCH", file);
        if (!mutation.objectHash) throw new Error("validated Yjs mutation is missing objectHash");
        canonicalYjsHash = await this.compactYjs(file.yjs_state_hash, mutation.objectHash);
        const revision = await this.nextRevision(tx);
        await tx`UPDATE files SET yjs_state_hash = ${canonicalYjsHash}, current_revision = ${revision}, updated_at = NOW() WHERE id = ${file.id}`;
        return this.insertEvent(tx, clientId, mutation, revision);
      }

      if (file.current_revision !== mutation.baseRevision) return this.conflict(mutation, "STALE_REVISION", file);

      if (mutation.operation === "update") {
        if (file.kind !== "blob") return this.conflict(mutation, "KIND_MISMATCH", file);
        const revision = await this.nextRevision(tx);
        await tx`UPDATE files SET object_hash = ${mutation.objectHash}, current_revision = ${revision}, updated_at = NOW() WHERE id = ${file.id}`;
        return this.insertEvent(tx, clientId, mutation, revision);
      }

      if (mutation.operation === "rename") {
        const destination = mutation.destinationPath!;
        const occupied = await tx<FileRow[]>`
          SELECT id, current_path, kind, deleted, current_revision::text, object_hash, yjs_state_hash
          FROM files WHERE current_path = ${destination} AND deleted = FALSE AND id <> ${file.id} FOR UPDATE
        `;
        if (occupied[0]) return this.pathConflict(mutation, file, occupied[0]);
        const revision = await this.nextRevision(tx);
        await tx`UPDATE files SET current_path = ${destination}, deleted = FALSE, current_revision = ${revision}, updated_at = NOW() WHERE id = ${file.id}`;
        return this.insertEvent(tx, clientId, mutation, revision);
      }

      const revision = await this.nextRevision(tx);
      await tx`UPDATE files SET deleted = TRUE, current_revision = ${revision}, updated_at = NOW() WHERE id = ${file.id}`;
      return this.insertEvent(tx, clientId, mutation, revision);
    });

    if ("status" in outcome) {
      if (referencedHash) await this.store.markReferenced(referencedHash);
      if (canonicalYjsHash) await this.store.markReferenced(canonicalYjsHash);
    }
    return outcome;
  }

  private async compactYjs(currentHash: string | null, updateHash: string): Promise<string> {
    const doc = new Y.Doc();
    if (currentHash) Y.applyUpdate(doc, await this.store.read(currentHash));
    try { Y.applyUpdate(doc, await this.store.read(updateHash)); }
    catch { throw new InvalidMutationError("INVALID_YJS_UPDATE", "The referenced object is not a valid Yjs update"); }
    return this.store.putBytes(Y.encodeStateAsUpdate(doc), "staged");
  }

  private async nextRevision(tx: any): Promise<Revision> {
    const [row] = await tx<{ revision: Revision }[]>`SELECT nextval('global_revision')::text AS revision`;
    if (!row) throw new Error("failed to allocate revision");
    return row.revision;
  }

  private async insertEvent(tx: any, clientId: string, mutation: Mutation, revision: Revision): Promise<MutationResult> {
    const result: MutationResult = { mutationId: mutation.mutationId, status: "accepted", revision };
    await tx`
      INSERT INTO sync_events(revision, client_id, mutation_id, operation, file_id, path, destination_path, object_hash, result_json)
      VALUES (${revision}, ${clientId}, ${mutation.mutationId}, ${mutation.operation}, ${mutation.fileId}, ${mutation.path},
        ${mutation.destinationPath ?? null}, ${mutation.objectHash ?? null}, ${JSON.stringify(result)}::jsonb)
    `;
    await tx`UPDATE server_meta SET current_snapshot_revision = ${revision}, updated_at = NOW() WHERE singleton = TRUE`;
    return result;
  }

  private missingConflict(mutation: Mutation): Conflict {
    return {
      mutationId: mutation.mutationId,
      code: "FILE_NOT_FOUND",
      fileId: mutation.fileId,
      path: mutation.path,
      currentRevision: "0",
      deleted: true,
    };
  }

  private conflict(mutation: Mutation, code: Conflict["code"], file: FileRow): Conflict {
    return {
      mutationId: mutation.mutationId,
      code,
      fileId: file.id,
      path: mutation.path,
      currentRevision: file.current_revision,
      currentPath: file.current_path,
      currentObjectHash: file.kind === "markdown" ? file.yjs_state_hash ?? undefined : file.object_hash ?? undefined,
      deleted: file.deleted,
    };
  }

  private pathConflict(mutation: Mutation, file: FileRow, blocking: FileRow): Conflict {
    return {
      ...this.conflict(mutation, "PATH_OCCUPIED", file),
      blockingFileId: blocking.id,
      blockingRevision: blocking.current_revision,
      blockingPath: blocking.current_path,
      blockingObjectHash: blocking.kind === "markdown" ? blocking.yjs_state_hash ?? undefined : blocking.object_hash ?? undefined,
      blockingDeleted: blocking.deleted,
    };
  }
}

export const syncEngine = new SyncEngine();

export class InvalidMutationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
