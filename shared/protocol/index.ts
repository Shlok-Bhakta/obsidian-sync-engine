import { z } from "zod";
// handles all the serialization and deserialization of the messages and the data types
// bump this when anything changes in the file. assume every change is breaking
export const PROTOCOL_VERSION = "1";
export function serialize(message: Message): string {
    // turn the Message into a string of any kind (can even experiment with raw binary formats maybe later)
    return JSON.stringify(message);
}

export function deserialize(raw: string): Message {
  return messageSchema.parse(JSON.parse(raw));
}

export enum MessageType {
    AUTH_REQUIRED = "auth_required",
    AUTH_INIT = "auth_init",
    AUTH_ACK = "auth_ack",
    AUTH_SUCCESS = "auth_success",
    AUTH_FAILED = "auth_failed",
    RESET_CLIENT_NAME = "reset_client_name",
    MESSAGE = "message",
    ERROR = "error",
}

export const messageSchema = z.discriminatedUnion('type', [
  z.object({ 
    type: z.literal(MessageType.AUTH_REQUIRED) }),
  z.object({ 
    type: z.literal(MessageType.AUTH_INIT), 
    client_name: z.string(),
    token: z.string()}),
  z.object({ 
    type: z.literal(MessageType.AUTH_ACK), 
    client_name: z.string(),
    token: z.string() }),
  z.object({ 
    type: z.literal(MessageType.AUTH_SUCCESS) }),
  z.object({ 
    type: z.literal(MessageType.AUTH_FAILED), 
    reason: z.string() }),
  z.object({
    type: z.literal(MessageType.RESET_CLIENT_NAME),
    new_client_name: z.string(),
    token: z.string()
  }),
  z.object({ 
    type: z.literal(MessageType.MESSAGE), 
    payload: z.string() }),
  z.object({ 
    type: z.literal(MessageType.ERROR), 
    reason: z.string() }),
]);

export type Message = z.infer<typeof messageSchema>;

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;
export const CLIENT_DATA_PATH =
  ".obsidian/plugins/obsidian-sync-engine/data.json";

/** Product-wide path policy: sync the vault except this client's credentials. */
export function isCanonicalSyncPath(path: string): boolean {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    WINDOWS_DRIVE_RE.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return (
    segments.every(
      (segment) =>
        segment.length > 0 && segment !== "." && segment !== "..",
    ) && path !== CLIENT_DATA_PATH
  );
}

export const syncPathSchema = z
  .string()
  .refine(isCanonicalSyncPath, "Path must be canonical user-vault content");

export const revisionSchema = z.number().int().safe().nonnegative();

export const revisionResponseSchema = z.object({
  revision: revisionSchema,
});

/**
 * One line of the inbox NDJSON transport (both the wire shape returned by
 * `GET /inbox` and what the plugin parses it back into). Additive: does not
 * change `messageSchema`, so it does not require bumping PROTOCOL_VERSION.
 */
export const inboxOpSchema = z.object({
	rev: revisionSchema,
	op: z.enum(["put", "delete"]),
	path: syncPathSchema,
});

export type InboxOp = z.infer<typeof inboxOpSchema>;
