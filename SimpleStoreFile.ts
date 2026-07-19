import { join } from "@std/path";
import type { SimpleStore } from "./lib/src/common/utils.ts";

// Byte markers so binary payloads (journal packs queued by Trench, up to ~10MB)
// round-trip untouched while everything else goes through JSON. Sets inside
// stored objects (CheckPointInfo) are serialized as arrays; the checkpoint
// reader re-materializes them, so no custom reviver is needed on the way out.
const MARKER_JSON = 0x00;
const MARKER_BINARY = 0x01;

function jsonReplacer(_key: string, value: unknown) {
    if (value instanceof Set) return [...value];
    if (value instanceof Map) return Object.fromEntries(value);
    return value;
}

/**
 * A file-backed SimpleStore for Deno.
 * One key = one file. Values are either raw binary (Uint8Array) or JSON.
 * Deno.Kv is unsuitable here: its 64KiB value limit rejects journal packs.
 */
export class SimpleStoreFile implements SimpleStore<any> {
    private dir: string;
    private ready: Promise<void>;
    constructor(dir: string) {
        this.dir = dir;
        this.ready = Deno.mkdir(dir, { recursive: true }).catch(() => {});
    }
    private fileFor(key: string) {
        // encodeURIComponent keeps keys reversible and filesystem-safe ("/" etc.).
        return join(this.dir, encodeURIComponent(key));
    }
    async get(key: string): Promise<any> {
        await this.ready;
        let buf: Uint8Array;
        try {
            buf = await Deno.readFile(this.fileFor(key));
        } catch (e) {
            if (e instanceof Deno.errors.NotFound) return undefined;
            throw e;
        }
        if (buf.length === 0) return undefined;
        const body = buf.subarray(1);
        if (buf[0] === MARKER_BINARY) return body.slice();
        return JSON.parse(new TextDecoder().decode(body));
    }
    async set(key: string, value: any): Promise<void> {
        await this.ready;
        let out: Uint8Array;
        if (value instanceof Uint8Array) {
            out = new Uint8Array(value.length + 1);
            out[0] = MARKER_BINARY;
            out.set(value, 1);
        } else {
            const body = new TextEncoder().encode(JSON.stringify(value, jsonReplacer));
            out = new Uint8Array(body.length + 1);
            out[0] = MARKER_JSON;
            out.set(body, 1);
        }
        // Write-then-rename so a crash mid-write can't leave a torn value.
        const path = this.fileFor(key);
        const tmp = `${path}.tmp`;
        await Deno.writeFile(tmp, out);
        await Deno.rename(tmp, path);
    }
    async delete(key: string): Promise<void> {
        await this.ready;
        try {
            await Deno.remove(this.fileFor(key));
        } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
    }
    async keys(from: string | undefined, to: string | undefined, count?: number): Promise<string[]> {
        await this.ready;
        const out: string[] = [];
        for await (const entry of Deno.readDir(this.dir)) {
            if (!entry.isFile || entry.name.endsWith(".tmp")) continue;
            const key = decodeURIComponent(entry.name);
            if (from && key < from) continue;
            if (to && key > to) continue;
            out.push(key);
        }
        out.sort();
        return count ? out.slice(0, count) : out;
    }
}
