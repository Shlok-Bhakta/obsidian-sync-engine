import type { DataAdapter } from "obsidian";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

export async function ensureDirectory(adapter: DataAdapter, path: string): Promise<void> {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) {
      try { await adapter.mkdir(current); }
      catch (error) { if (!(await adapter.exists(current))) throw error; }
    }
  }
}

export async function atomicWrite(adapter: DataAdapter, path: string, data: string): Promise<void> {
  const normalized = normalizePath(path);
  await ensureDirectory(adapter, normalized.slice(0, normalized.lastIndexOf("/")));
  const temp = `${normalized}.sync-tmp-${crypto.randomUUID()}`;
  await adapter.write(temp, data);
  try {
    if (await adapter.exists(normalized)) await adapter.remove(normalized);
    await adapter.rename(temp, normalized);
  } catch (error) {
    if (await adapter.exists(temp)) await adapter.remove(temp);
    throw error;
  }
}

export async function atomicWriteBinary(adapter: DataAdapter, path: string, data: ArrayBuffer): Promise<void> {
  const normalized = normalizePath(path);
  await ensureDirectory(adapter, normalized.slice(0, normalized.lastIndexOf("/")));
  const temp = `${normalized}.sync-tmp-${crypto.randomUUID()}`;
  await adapter.writeBinary(temp, data);
  try {
    if (await adapter.exists(normalized)) await adapter.remove(normalized);
    await adapter.rename(temp, normalized);
  } catch (error) {
    if (await adapter.exists(temp)) await adapter.remove(temp);
    throw error;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
