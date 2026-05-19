import { sql } from "bun";

type SqlClient = typeof sql;
type LargeObjectWriteResult = {
    oid: number;
    byteSize: number;
};

export async function createLargeObject(data: Uint8Array | ReadableStream<Uint8Array>, tx: SqlClient = sql): Promise<LargeObjectWriteResult> {
    if (data instanceof Uint8Array) {
        return createLargeObjectFromBytes(data, tx);
    }
    const oidRows = await tx<{ oid: number }[]>`
        SELECT lo_create(0) AS oid;
    `;
    const oid = oidRows[0]!.oid;
    const fdRows = await tx<{ fd: number }[]>`
        SELECT lo_open(${oid}, 131072) AS fd;
    `;
    const fd = fdRows[0]!.fd;
    let byteSize = 0;
    let failed = false;
    try {
        const reader = data.getReader();
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
                break;
            }
            if (chunk.value.byteLength === 0) {
                continue;
            }
            byteSize += chunk.value.byteLength;
            await tx`SELECT lowrite(${fd}, ${chunk.value});`;
        }
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        await tx`SELECT lo_close(${fd});`;
        if (failed) {
            await unlinkLargeObject(oid, tx);
        }
    }
    return { oid, byteSize };
}

async function createLargeObjectFromBytes(data: Uint8Array, tx: SqlClient = sql): Promise<LargeObjectWriteResult> {
    const rows = await tx<{ oid: number }[]>`
        SELECT lo_from_bytea(0, ${data}) AS oid;
    `;
    return { oid: rows[0]!.oid, byteSize: data.byteLength };
}

export async function readLargeObject(oid: number, tx: SqlClient = sql): Promise<Uint8Array> {
    const rows = await tx<{ data: Uint8Array }[]>`
        SELECT lo_get(${oid}) AS data;
    `;
    return rows[0]?.data ?? new Uint8Array();
}

export async function readLargeObjectRange(
    oid: number,
    offset: number,
    length: number,
    tx: SqlClient = sql,
): Promise<Uint8Array> {
    const rows = await tx<{ data: Uint8Array }[]>`
        SELECT lo_get(${oid}, ${offset}, ${length}) AS data;
    `;
    return rows[0]?.data ?? new Uint8Array();
}

export async function unlinkLargeObject(oid: number | null | undefined, tx: SqlClient = sql): Promise<void> {
    if (!oid) {
        return;
    }
    await tx`SELECT lo_unlink(${oid});`;
}
