import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

/**
 * Injectable shape of Obsidian's requestUrl. Keeping the runtime value outside
 * shared HTTP modules lets their tests run without the Obsidian renderer.
 */
export type HttpRequestFn = (
	params: RequestUrlParam,
) => Promise<RequestUrlResponse>;
