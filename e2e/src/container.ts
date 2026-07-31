/**
 * Container CLI used by the e2e harness.
 * Local default: podman. GitHub Actions: set CONTAINER_BIN=docker.
 */
export const CONTAINER_BIN = process.env.CONTAINER_BIN ?? "podman";

export function hostGateway(): string {
	if (process.env.E2E_HOST_GATEWAY) {
		return process.env.E2E_HOST_GATEWAY;
	}
	return CONTAINER_BIN === "docker"
		? "host.docker.internal"
		: "host.containers.internal";
}

/** Extra `run` args needed so containers can reach the host-published sync server. */
export function hostGatewayRunArgs(): string[] {
	if (CONTAINER_BIN === "docker") {
		return ["--add-host=host.docker.internal:host-gateway"];
	}
	return [];
}
