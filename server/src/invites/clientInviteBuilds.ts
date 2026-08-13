import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type {
	ClientArchiveBuildProgress,
	ClientInvite,
	ClientInviteBuild,
} from "obsidian-sync-protocol";
import {
	type ClientAuthorizer,
	getClientIdFromAuthorization,
	requireClientId,
} from "../auth/auth";
import { serverLogger, type Logger } from "../logger";
import {
	objectStore,
	type ClientArchiveProgressSnapshot,
	type ObjectStore,
} from "../object/object_store";
import { createInvite } from "./clientInvites";

const BUILD_RETENTION_MS = 10 * 60 * 1000;

type StoredBuild = {
	ownerClientId: string;
	state: ClientInviteBuild;
};

function publicProgress(
	progress: ClientArchiveProgressSnapshot,
	startedAt: number,
	nowMs: number,
): ClientArchiveBuildProgress {
	let percent = 0;
	if (progress.phase === "preparing") {
		percent = 2;
	} else if (progress.phase === "archiving") {
		const fileRatio =
			progress.totalFiles === 0
				? 1
				: Math.min(progress.processedFiles / progress.totalFiles, 1);
		percent = 5 + Math.floor(fileRatio * 85);
	} else {
		percent = 95;
	}

	const elapsedMs = Math.max(nowMs - startedAt, 0);
	const estimatedSecondsRemaining =
		percent >= 5 && percent < 95 && elapsedMs >= 100
			? Math.max(1, Math.round((elapsedMs / percent) * (100 - percent) / 1000))
			: null;
	return {
		phase: progress.phase,
		processedFiles: progress.processedFiles,
		totalFiles: progress.totalFiles,
		percent,
		estimatedSecondsRemaining,
	};
}

function noStoreHeaders(): Record<string, string> {
	return { "Cache-Control": "no-store" };
}

export function registerClientInviteBuildRoutes(
	app: Hono,
	store: ObjectStore = objectStore,
	authorize: ClientAuthorizer = getClientIdFromAuthorization,
	injectedLogger: Logger = serverLogger,
	now: () => Date = () => new Date(),
	nowMs: () => number = () => Date.now(),
) {
	const logger = injectedLogger.child("client_invite_build_routes");
	const builds = new Map<string, StoredBuild>();
	const activeBuildByClient = new Map<string, string>();

	const startBuild = (
		ownerClientId: string,
		serverUrl: string,
	): ClientInviteBuild => {
		const activeBuildId = activeBuildByClient.get(ownerClientId);
		const activeBuild = activeBuildId ? builds.get(activeBuildId) : undefined;
		if (activeBuild?.state.status === "building") {
			logger.info("start.reused", { ownerClientId, buildId: activeBuildId });
			return activeBuild.state;
		}

		const buildId = randomUUID();
		const startedAt = nowMs();
		const initialProgress: ClientArchiveBuildProgress = {
			phase: "preparing",
			processedFiles: 0,
			totalFiles: 0,
			percent: 0,
			estimatedSecondsRemaining: null,
		};
		const stored: StoredBuild = {
			ownerClientId,
			state: { buildId, status: "building", progress: initialProgress },
		};
		builds.set(buildId, stored);
		activeBuildByClient.set(ownerClientId, buildId);
		logger.info("start.accepted", { ownerClientId, buildId, serverUrl });

		void createInvite({
			store,
			serverUrl,
			ownerClientId,
			logger,
			now,
			onProgress: (progress) => {
				if (stored.state.status !== "building") return;
				const nextProgress = publicProgress(progress, startedAt, nowMs());
				stored.state = {
					...stored.state,
					progress: {
						...nextProgress,
						percent: Math.max(stored.state.progress.percent, nextProgress.percent),
					},
				};
			},
		}).then(
			(invite) => {
				const readyInvite: ClientInvite = {
					url: `${serverUrl}/client-invites/${invite.token}`,
					expiresAt: invite.expiresAt.toISOString(),
				};
				stored.state = {
					buildId,
					status: "ready",
					progress: {
						...stored.state.progress,
						phase: "finalizing",
						percent: 100,
						estimatedSecondsRemaining: 0,
					},
					invite: readyInvite,
				};
				activeBuildByClient.delete(ownerClientId);
				logger.info("build.completed", { ownerClientId, buildId });
			},
			(error) => {
				stored.state = {
					buildId,
					status: "failed",
					progress: stored.state.progress,
					error: "Archive build failed. Try again.",
				};
				activeBuildByClient.delete(ownerClientId);
				logger.error("build.failed", { ownerClientId, buildId, error });
			},
		).finally(() => {
			const cleanup = setTimeout(() => builds.delete(buildId), BUILD_RETENTION_MS);
			cleanup.unref?.();
		});

		return stored.state;
	};

	return app
		.post("/client-invite-builds", async (c) => {
			const ownerClientId = await requireClientId(c, authorize, logger);
			if (ownerClientId instanceof Response) return ownerClientId;
			const serverUrl = new URL(c.req.url).origin;
			return c.json(startBuild(ownerClientId, serverUrl), 202, noStoreHeaders());
		})
		.get("/client-invite-builds/:buildId", async (c) => {
			const ownerClientId = await requireClientId(c, authorize, logger);
			if (ownerClientId instanceof Response) return ownerClientId;
			const buildId = c.req.param("buildId");
			const build = builds.get(buildId);
			if (!build || build.ownerClientId !== ownerClientId) {
				logger.warn("status.not_found", { ownerClientId, buildId });
				return c.json({ error: "Archive build not found" }, 404, noStoreHeaders());
			}
			return c.json(build.state, 200, noStoreHeaders());
		});
}
