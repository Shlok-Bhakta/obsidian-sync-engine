export async function sleep(ms: number): Promise<void> {
	await Bun.sleep(ms);
}

export type WaitOptions = {
	timeoutMs?: number;
	intervalMs?: number;
	label?: string;
};

/**
 * Poll until `fn` returns a truthy value (or true). Throws with label on timeout.
 */
export async function waitFor<T>(
	fn: () => Promise<T | false | null | undefined>,
	options: WaitOptions = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const intervalMs = options.intervalMs ?? 500;
	const label = options.label ?? "condition";
	const start = Date.now();
	let lastError: unknown;

	while (Date.now() - start < timeoutMs) {
		try {
			const value = await fn();
			if (value) {
				return value as T;
			}
		} catch (error) {
			lastError = error;
		}
		await sleep(intervalMs);
	}

	const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "");
	throw new Error(
		`Timed out after ${timeoutMs}ms waiting for ${label}${detail ? `: ${detail}` : ""}`,
	);
}

export async function waitForFile(
	path: string,
	options: WaitOptions = {},
): Promise<string> {
	return waitFor(
		async () => {
			const file = Bun.file(path);
			if (await file.exists()) {
				return await file.text();
			}
			return false;
		},
		{ ...options, label: options.label ?? `file ${path}` },
	);
}

export async function waitForFileAbsent(
	path: string,
	options: WaitOptions = {},
): Promise<void> {
	await waitFor(
		async () => {
			const exists = await Bun.file(path).exists();
			return !exists;
		},
		{ ...options, label: options.label ?? `absence of ${path}` },
	);
}
