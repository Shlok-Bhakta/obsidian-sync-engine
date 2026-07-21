import { z } from "zod";

export const PROTOCOL_VERSION = "2" as const;
export const MAX_REVISION = 9_223_372_036_854_775_807n;
export const revisionSchema = z.string()
  .regex(/^(0|[1-9]\d*)$/, "revision must be an unsigned decimal string")
  .refine((value) => BigInt(value) <= MAX_REVISION, "revision exceeds the server range");
export const uuidSchema = z.string().uuid();
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const mutationIdSchema = z.string().min(1).max(128);

export type Revision = z.infer<typeof revisionSchema>;
export type FileKind = "markdown" | "blob";

const INTERNAL_DIR_NAMES = new Set([".git", ".trash"]);
const WORKSPACE_FILES = new Set([
  ".obsidian/workspace",
  ".obsidian/workspace.json",
  ".obsidian/workspaces.json",
  ".obsidian/workspace-mobile.json",
]);
const CACHE_PREFIXES = [
  ".obsidian/cache/",
  ".obsidian/caches/",
  ".obsidian/index/",
];

export function normalizeVaultPath(input: string): string | null {
  if (!input || input.includes("\0") || input.includes("\\")) return null;
  if (input.startsWith("/") || /^[a-zA-Z]:/.test(input)) return null;
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

export function isSafeVaultPath(input: string): boolean {
  return normalizeVaultPath(input) !== null;
}

export type VaultScopeOptions = { pluginId?: string; configDir?: string };

export function shouldSyncVaultPath(input: string, options: VaultScopeOptions = {}): boolean {
  const path = normalizeVaultPath(input);
  if (!path) return false;
  const segments = path.split("/");
  if (segments.some((segment) => INTERNAL_DIR_NAMES.has(segment))) return false;
  if (WORKSPACE_FILES.has(path) || CACHE_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;

  const configDir = options.configDir ?? ".obsidian";
  const pluginId = options.pluginId ?? "obsidian-sync-engine";
  const ownPluginDir = `${configDir}/plugins/${pluginId}`;
  if (path === `${ownPluginDir}/data.json`) return false;
  if (
    ["sync-state", "outbox", "yjs-state", "bootstrap-staging", "tmp"].some(
      (dir) => path === `${ownPluginDir}/${dir}` || path.startsWith(`${ownPluginDir}/${dir}/`),
    )
  ) return false;
  if (path.endsWith(".tmp") || path.includes(".sync-tmp-")) return false;
  return true;
}

export const vaultPathSchema = z.string().refine(isSafeVaultPath, "unsafe vault path");
export const scopedVaultPathSchema = z.string().refine((path) => shouldSyncVaultPath(path), "path is outside sync scope");

export enum MessageType {
  AUTH = "AUTH",
  AUTH_SUCCESS = "AUTH_SUCCESS",
  REVISION_AVAILABLE = "REVISION_AVAILABLE",
  PRESENCE_UPDATE = "PRESENCE_UPDATE",
  PRESENCE_LEAVE = "PRESENCE_LEAVE",
  BOOTSTRAP_CREATE = "BOOTSTRAP_CREATE",
  BOOTSTRAP_STATUS = "BOOTSTRAP_STATUS",
  ERROR = "ERROR",
}

const relativePositionSchema = z.string().min(1).max(16_384);

export const websocketMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(MessageType.AUTH),
    clientId: uuidSchema,
    clientName: z.string().min(1).max(100),
    credential: z.string().min(16).max(1024),
    protocolVersion: z.string(),
    lastAppliedRevision: revisionSchema,
  }).strict(),
  z.object({
    type: z.literal(MessageType.AUTH_SUCCESS),
    clientId: uuidSchema,
    currentServerRevision: revisionSchema,
    bootstrapRequired: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal(MessageType.REVISION_AVAILABLE),
    latestServerRevision: revisionSchema,
  }).strict(),
  z.object({
    type: z.literal(MessageType.PRESENCE_UPDATE),
    clientId: uuidSchema.optional(),
    fileId: uuidSchema,
    path: scopedVaultPathSchema,
    anchor: relativePositionSchema,
    head: relativePositionSchema,
    name: z.string().min(1).max(100),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  }).strict(),
  z.object({ type: z.literal(MessageType.PRESENCE_LEAVE), clientId: uuidSchema }).strict(),
  z.object({
    type: z.literal(MessageType.BOOTSTRAP_CREATE),
    vaultId: z.string().min(1).max(200),
    configDir: z.string().min(1).max(200),
    pluginId: z.string().min(1).max(200),
  }).strict(),
  z.object({
    type: z.literal(MessageType.BOOTSTRAP_STATUS),
    status: z.enum(["building", "ready", "downloaded", "expired", "failed"]),
    url: z.string().url().optional(),
    expiresAt: z.string().datetime().optional(),
    safeMessage: z.string().max(500).optional(),
  }).strict(),
  z.object({
    type: z.literal(MessageType.ERROR),
    code: z.string().regex(/^[A-Z0-9_]+$/),
    safeMessage: z.string().min(1).max(500),
  }).strict(),
]);

export type WebSocketMessage = z.infer<typeof websocketMessageSchema>;
export type Message = WebSocketMessage;

export function serialize(message: WebSocketMessage): string {
  return JSON.stringify(websocketMessageSchema.parse(message));
}

export function deserialize(raw: string): WebSocketMessage {
  return websocketMessageSchema.parse(JSON.parse(raw));
}

export const mutationOperationSchema = z.enum(["create", "update", "rename", "delete", "yjs_update"]);
export type MutationOperation = z.infer<typeof mutationOperationSchema>;

export const mutationSchema = z.object({
  mutationId: mutationIdSchema,
  operation: mutationOperationSchema,
  fileId: uuidSchema,
  path: scopedVaultPathSchema,
  destinationPath: scopedVaultPathSchema.optional(),
  baseRevision: revisionSchema,
  objectHash: sha256Schema.optional(),
}).strict().superRefine((mutation, ctx) => {
  if (mutation.operation === "rename" && !mutation.destinationPath) {
    ctx.addIssue({ code: "custom", path: ["destinationPath"], message: "rename requires destinationPath" });
  }
  if (["create", "update", "yjs_update"].includes(mutation.operation) && !mutation.objectHash) {
    ctx.addIssue({ code: "custom", path: ["objectHash"], message: "content mutation requires objectHash" });
  }
  if (mutation.operation === "yjs_update" && !mutation.path.toLowerCase().endsWith(".md")) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "Yjs updates require a Markdown path" });
  }
});

export const mutationRequestSchema = z.object({ mutations: z.array(mutationSchema).min(1).max(500) }).strict();

export const conflictSchema = z.object({
  mutationId: mutationIdSchema,
  code: z.enum(["STALE_REVISION", "PATH_OCCUPIED", "FILE_NOT_FOUND", "KIND_MISMATCH"]),
  fileId: uuidSchema,
  path: scopedVaultPathSchema,
  currentRevision: revisionSchema,
  currentPath: scopedVaultPathSchema.optional(),
  currentObjectHash: sha256Schema.optional(),
  deleted: z.boolean(),
  blockingFileId: uuidSchema.optional(),
  blockingRevision: revisionSchema.optional(),
  blockingPath: scopedVaultPathSchema.optional(),
  blockingObjectHash: sha256Schema.optional(),
  blockingDeleted: z.boolean().optional(),
}).strict();

export const mutationResultSchema = z.object({
  mutationId: mutationIdSchema,
  status: z.literal("accepted"),
  revision: revisionSchema,
}).strict();

export const mutationResponseSchema = z.object({
  accepted: z.array(mutationResultSchema),
  conflicts: z.array(conflictSchema),
  currentServerRevision: revisionSchema,
}).strict();

export const syncEventSchema = z.object({
  revision: revisionSchema,
  clientId: uuidSchema,
  mutationId: mutationIdSchema,
  operation: mutationOperationSchema,
  fileId: uuidSchema,
  path: scopedVaultPathSchema,
  destinationPath: scopedVaultPathSchema.nullable(),
  objectHash: sha256Schema.nullable(),
  createdAt: z.string().datetime(),
}).strict();

export const changesResponseSchema = z.object({
  changes: z.array(syncEventSchema),
  currentServerRevision: revisionSchema,
  hasMore: z.boolean(),
}).strict();

export const bootstrapEntrySchema = z.object({
  fileId: uuidSchema,
  path: scopedVaultPathSchema,
  kind: z.enum(["markdown", "blob"]),
  objectHash: sha256Schema,
  stateVectorHash: sha256Schema.optional(),
}).strict();

export const bootstrapManifestSchema = z.object({
  bootstrapId: uuidSchema,
  entries: z.array(bootstrapEntrySchema).max(100_000),
}).strict();

export const bootstrapCommitResponseSchema = z.object({
  accepted: z.boolean(),
  snapshotRevision: revisionSchema,
  currentServerRevision: revisionSchema,
  fileRevisions: z.array(z.object({
    fileId: uuidSchema,
    revision: revisionSchema,
  }).strict()),
}).strict();

export type Mutation = z.infer<typeof mutationSchema>;
export type MutationRequest = z.infer<typeof mutationRequestSchema>;
export type MutationResult = z.infer<typeof mutationResultSchema>;
export type MutationResponse = z.infer<typeof mutationResponseSchema>;
export type Conflict = z.infer<typeof conflictSchema>;
export type SyncEvent = z.infer<typeof syncEventSchema>;
export type ChangesResponse = z.infer<typeof changesResponseSchema>;
export type BootstrapManifest = z.infer<typeof bootstrapManifestSchema>;
export type BootstrapCommitResponse = z.infer<typeof bootstrapCommitResponseSchema>;

export function compareRevisions(a: Revision, b: Revision): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
