import { z } from "zod";

// Bump this when an existing message shape changes. Additive HTTP contracts
// below do not require a version bump.
export const PROTOCOL_VERSION = "1";

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

export const messageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal(MessageType.AUTH_REQUIRED) }),
	z.object({
		type: z.literal(MessageType.AUTH_INIT),
		client_name: z.string(),
		token: z.string(),
	}),
	z.object({
		type: z.literal(MessageType.AUTH_ACK),
		client_name: z.string(),
		token: z.string(),
	}),
	z.object({ type: z.literal(MessageType.AUTH_SUCCESS) }),
	z.object({
		type: z.literal(MessageType.AUTH_FAILED),
		reason: z.string(),
	}),
	z.object({
		type: z.literal(MessageType.RESET_CLIENT_NAME),
		new_client_name: z.string(),
		token: z.string(),
	}),
	z.object({
		type: z.literal(MessageType.MESSAGE),
		payload: z.string(),
	}),
	z.object({
		type: z.literal(MessageType.ERROR),
		reason: z.string(),
	}),
]);

export type Message = z.infer<typeof messageSchema>;

export function serialize(message: Message): string {
	return JSON.stringify(message);
}

export function deserialize(raw: string): Message {
	return messageSchema.parse(JSON.parse(raw));
}

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
export type RevisionResponse = z.infer<typeof revisionResponseSchema>;

export const uploadResponseSchema = z.object({
	path: syncPathSchema,
	bytesWritten: z.number().int().safe().nonnegative(),
	revision: revisionSchema,
});
export type UploadResponse = z.infer<typeof uploadResponseSchema>;

export const deleteResponseSchema = z.object({
	path: syncPathSchema,
	revision: revisionSchema,
});
export type DeleteResponse = z.infer<typeof deleteResponseSchema>;

const httpUrlSchema = z
	.string()
	.url()
	.refine(
		(value) => value.startsWith("http://") || value.startsWith("https://"),
		"URL must use HTTP or HTTPS",
	);

export const clientInviteSchema = z.object({
	url: httpUrlSchema,
	expiresAt: z
		.string()
		.refine(
			(value) => Number.isFinite(Date.parse(value)),
			"expiresAt must be a valid date",
		),
});
export type ClientInvite = z.infer<typeof clientInviteSchema>;

export const clientArchiveBuildProgressSchema = z
	.object({
		phase: z.enum(["preparing", "archiving", "finalizing"]),
		processedFiles: z.number().int().safe().nonnegative(),
		totalFiles: z.number().int().safe().nonnegative(),
		percent: z.number().int().min(0).max(100),
		estimatedSecondsRemaining: z.number().int().safe().nonnegative().nullable(),
	})
	.refine(
		(progress) => progress.processedFiles <= progress.totalFiles,
		"processedFiles cannot exceed totalFiles",
	);
export type ClientArchiveBuildProgress = z.infer<
	typeof clientArchiveBuildProgressSchema
>;

const clientInviteBuildBaseSchema = z.object({
	buildId: z.string().uuid(),
	progress: clientArchiveBuildProgressSchema,
});

export const clientInviteBuildSchema = z.discriminatedUnion("status", [
	clientInviteBuildBaseSchema.extend({
		status: z.literal("building"),
	}),
	clientInviteBuildBaseSchema.extend({
		status: z.literal("ready"),
		invite: clientInviteSchema,
	}),
	clientInviteBuildBaseSchema.extend({
		status: z.literal("failed"),
		error: z.string().min(1),
	}),
]);
export type ClientInviteBuild = z.infer<typeof clientInviteBuildSchema>;

/** The portable settings written into a newly packaged client's data.json. */
export const clientConfigSchema = z.object({
	serverUrl: httpUrlSchema,
	clientName: z.string().min(1),
	clientSecret: z.string().min(1),
	revision: revisionSchema,
});
export type ClientConfig = z.infer<typeof clientConfigSchema>;

/** One line of the GET /inbox NDJSON transport. */
export const inboxOpSchema = z.object({
	rev: revisionSchema,
	op: z.enum(["put", "delete"]),
	path: syncPathSchema,
});
export type InboxOp = z.infer<typeof inboxOpSchema>;

export function serializeInboxNdjson(ops: readonly InboxOp[]): string {
	if (ops.length === 0) {
		return "";
	}
	return `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`;
}

export function deserializeInboxNdjson(body: string): InboxOp[] {
	return body
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => inboxOpSchema.parse(JSON.parse(line)));
}
