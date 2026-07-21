import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import {
  bootstrapCommitResponseSchema,
  changesResponseSchema,
  mutationResponseSchema,
  type BootstrapCommitResponse,
  type BootstrapManifest,
  type ChangesResponse,
  type Mutation,
  type MutationResponse,
  type Revision,
} from "obsidian-sync-protocol";
import { sha256 } from "./storage";

export type ClientCredentials = { serverUrl: string; clientId: string; clientSecret: string };
type RequestOptions = Omit<RequestUrlParam, "url">;

export class HttpClient {
  constructor(private readonly credentials: () => ClientCredentials) {}

  async registerInitial(displayName: string): Promise<{ clientId: string; displayName: string; clientSecret: string }> {
    return this.json("/v1/auth/register-initial", {
      method: "POST", contentType: "application/json", body: JSON.stringify({ displayName }),
    }, false) as Promise<{ clientId: string; displayName: string; clientSecret: string }>;
  }

  async rotateSecret(): Promise<string> {
    const result = await this.json("/v1/auth/rotate-secret", { method: "POST" }) as { clientSecret: string };
    return result.clientSecret;
  }

  async renameClient(displayName: string): Promise<string> {
    const result = await this.json("/v1/auth/name", {
      method: "PATCH", contentType: "application/json", body: JSON.stringify({ displayName }),
    }) as { displayName: string };
    return result.displayName;
  }

  async hasObject(hash: string): Promise<boolean> {
    const response = await this.request(`/v1/objects/${hash}`, { method: "HEAD" }, true, [404]);
    return response.status === 200;
  }

  async uploadObject(hash: string, bytes: Uint8Array): Promise<void> {
    await this.request(`/v1/objects/${hash}`, {
      method: "PUT",
      contentType: "application/octet-stream",
      body: bytes.slice().buffer,
    });
  }

  async downloadObject(hash: string): Promise<Uint8Array> {
    const response = await this.request(`/v1/objects/${hash}`, { method: "GET" });
    const bytes = new Uint8Array(response.arrayBuffer);
    if (await sha256(bytes) !== hash) throw new SyncHttpError("HASH_MISMATCH", 502, "Downloaded object failed SHA-256 verification");
    return bytes;
  }

  async changes(since: Revision, limit = 500): Promise<ChangesResponse> {
    return changesResponseSchema.parse(await this.json(`/v1/changes?since=${since}&limit=${limit}`, { method: "GET" }));
  }

  async mutate(mutations: Mutation[]): Promise<MutationResponse> {
    return mutationResponseSchema.parse(await this.json("/v1/mutations", {
      method: "POST", contentType: "application/json", body: JSON.stringify({ mutations }),
    }));
  }

  async commitInitialBootstrap(manifest: BootstrapManifest): Promise<BootstrapCommitResponse> {
    const result = await this.json(`/v1/bootstrap/initial/${manifest.bootstrapId}/manifest`, {
      method: "POST", contentType: "application/json", body: JSON.stringify({ entries: manifest.entries }),
    }, true, [409]);
    return bootstrapCommitResponseSchema.parse(result);
  }

  private async json(path: string, options: RequestOptions, authenticated = true, allowed: number[] = []): Promise<unknown> {
    const response = await this.request(path, options, authenticated, allowed);
    try { return typeof response.json === "string" ? JSON.parse(response.json) : response.json; }
    catch { throw new SyncHttpError("INVALID_RESPONSE", response.status, "Server returned malformed JSON"); }
  }

  private async request(path: string, options: RequestOptions, authenticated = true, allowed: number[] = []) {
    const credentials = this.credentials();
    const base = credentials.serverUrl.replace(/\/$/, "");
    const headers: Record<string, string> = { ...options.headers };
    if (authenticated) {
      headers.Authorization = `Bearer ${credentials.clientSecret}`;
      headers["X-Client-Id"] = credentials.clientId;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await withTimeout(requestUrl({ ...options, url: `${base}${path}`, headers, throw: false }), 30_000);
        if (response.status < 400 || allowed.includes(response.status)) return response;
        const error = responseError(response);
        if (response.status === 401 || response.status === 403 || response.status === 409 || response.status < 500) {
          throw new SyncHttpError(
            error.code ?? (response.status === 401 ? "AUTH_FAILED" : "REQUEST_REJECTED"),
            response.status,
            error.message,
          );
        }
        lastError = new SyncHttpError(error.code ?? "SERVER_ERROR", response.status, error.message);
      } catch (error) {
        if (error instanceof SyncHttpError && error.status < 500) throw error;
        lastError = error;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250 * 2 ** attempt + Math.random() * 200));
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${detail}`, { cause: lastError });
  }
}

export class SyncHttpError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

function responseError(response: RequestUrlResponse): { code?: string; message: string } {
  const fallback = response.text.slice(0, 500) || `Server returned HTTP ${response.status}`;
  let payload: unknown = response.json;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); }
    catch { return { message: fallback }; }
  }
  if (!payload || typeof payload !== "object") {
    try { payload = JSON.parse(response.text); }
    catch { return { message: fallback }; }
  }
  const record = payload as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : fallback,
  };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("HTTP request timed out")), milliseconds);
    void promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error: unknown) => { window.clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}
