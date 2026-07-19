/**
 * Test seeder: acts as an Obsidian Self-hosted LiveSync device in bucket mode,
 * using the exact commonlib code paths the plugin runs (DirectFileManipulator
 * for chunking, LiveSyncJournalReplicator/JournalSyncMinio for journal packs,
 * pack-level E2EE, path obfuscation). Used by script/test-bucket-peer.sh to
 * prove the bridge's bucket peer interoperates with plugin-written buckets.
 *
 * Subcommands:
 *   seed        - create the bucket, initialize milestone/sync-params, upload files
 *   update      - join as a fresh device, pull, then modify/add/delete files, push
 *   verify-pull - join as a fresh device, pull, print {path: content} JSON manifest
 *
 * Config via env: TEST_ENDPOINT, TEST_REGION, TEST_ACCESS_KEY, TEST_SECRET_KEY,
 * TEST_BUCKET, TEST_PASSPHRASE, TEST_OBFUSCATE_PASSPHRASE
 */
import { S3, CreateBucketCommand } from "@aws-sdk/client-s3";
import { DirectFileManipulator, type ReadyEntry } from "../lib/src/API/DirectFileManipulatorV2.ts";
import {
    DEFAULT_SETTINGS,
    E2EEAlgorithms,
    REMOTE_MINIO,
    type BucketSyncSetting,
    type RemoteDBSettings,
} from "../lib/src/common/types.ts";
import type { ObsidianLiveSyncSettings } from "../lib/src/common/types.ts";
import {
    LiveSyncJournalReplicator,
    type LiveSyncJournalReplicatorEnv,
} from "../lib/src/replication/journal/LiveSyncJournalReplicator.ts";
import { reactiveSource } from "../lib/src/dataobject/reactive.ts";
import type { SimpleStore } from "../lib/src/common/utils.ts";
/// <reference path="../untyped-modules.d.ts" />
import { PouchDB } from "../lib/src/pouchdb/pouchdb-http.ts";
import memoryAdapter from "pouchdb-adapter-memory";
import { defaultLoggerEnv, LOG_LEVEL_INFO } from "../lib/src/common/logger.ts";

defaultLoggerEnv.minLogLevel = LOG_LEVEL_INFO;
(PouchDB as any).plugin(memoryAdapter);

const endpoint = Deno.env.get("TEST_ENDPOINT") ?? "http://127.0.0.1:19000";
const region = Deno.env.get("TEST_REGION") ?? "us-east-1";
const accessKey = Deno.env.get("TEST_ACCESS_KEY") ?? "testadmin";
const secretKey = Deno.env.get("TEST_SECRET_KEY") ?? "testadmin123";
const bucket = Deno.env.get("TEST_BUCKET") ?? "lsb-test-vault";
const passphrase = Deno.env.get("TEST_PASSPHRASE") ?? "test-e2ee-passphrase";
const obfuscatePassphrase = Deno.env.get("TEST_OBFUSCATE_PASSPHRASE") ?? "test-obfuscate-passphrase";

class MemStore implements SimpleStore<any> {
    map = new Map<string, any>();
    get(key: string) {
        return Promise.resolve(this.map.get(key));
    }
    set(key: string, value: any) {
        this.map.set(key, value);
        return Promise.resolve();
    }
    delete(key: string) {
        this.map.delete(key);
        return Promise.resolve();
    }
    keys(from: string | undefined, to: string | undefined, count?: number) {
        const all = [...this.map.keys()]
            .filter((k) => (!from || k >= from) && (!to || k <= to))
            .sort();
        return Promise.resolve(count ? all.slice(0, count) : all);
    }
}

function buildSettings(): RemoteDBSettings & BucketSyncSetting & Pick<ObsidianLiveSyncSettings, "remoteType"> {
    return {
        ...DEFAULT_SETTINGS,
        remoteType: REMOTE_MINIO,
        accessKey,
        secretKey,
        bucket,
        region,
        endpoint,
        bucketPrefix: "",
        forcePathStyle: true,
        useCustomRequestHandler: false,
        bucketCustomHeaders: "",
        encrypt: true,
        passphrase,
        usePathObfuscation: true,
        useDynamicIterationCount: false,
        E2EEAlgorithm: E2EEAlgorithms.V2,
    };
}

async function buildDevice(deviceName: string) {
    const man = new DirectFileManipulator({
        url: `seed-${deviceName}-${Math.random().toString(36).slice(2)}`,
        username: "",
        password: "",
        database: "seed",
        passphrase: undefined,
        obfuscatePassphrase,
    });
    man.$$createPouchDBInstance = <T extends object>(
        name?: string,
        options?: PouchDB.Configuration.DatabaseConfiguration
    ): PouchDB.Database<T> => {
        return new (PouchDB as any)(name ?? `seed-db`, { ...options, adapter: "memory" }) as PouchDB.Database<T>;
    };
    // The replicator touches the database in its constructor; the manipulator
    // creates it asynchronously, so wait before wiring the env.
    await man.ready.promise;
    const settings = buildSettings();
    const env: LiveSyncJournalReplicatorEnv = {
        getDatabase: () => man.liveSyncLocalDB.localDatabase,
        getSettings: () => settings,
        $$isMobile: () => false,
        $$getLastPostFailedBySize: () => false,
        $$parseReplicationResult: () => Promise.resolve(),
        replicationStat: reactiveSource({
            sent: 0,
            arrived: 0,
            maxPullSeq: 0,
            maxPushSeq: 0,
            lastSyncPullSeq: 0,
            lastSyncPushSeq: 0,
            syncStatus: "NOT_CONNECTED",
        }),
        kvDB: {} as any,
        simpleStore: new MemStore(),
        $$customFetchHandler: () => undefined as any,
    };
    const replicator = new LiveSyncJournalReplicator(env);
    return { man, replicator, settings };
}

async function ensureBucketExists() {
    const s3 = new S3({
        endpoint,
        region,
        forcePathStyle: true,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
    try {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        console.log(`[seeder] bucket ${bucket} created`);
    } catch (e: any) {
        if (e?.name === "BucketAlreadyOwnedByYou" || e?.name === "BucketAlreadyExists") {
            console.log(`[seeder] bucket ${bucket} already exists`);
        } else {
            throw e;
        }
    }
}

async function putFile(man: DirectFileManipulator, path: string, content: string | Uint8Array) {
    const now = Date.now();
    const data =
        typeof content === "string" ? new Blob([content], { type: "text/plain" }) : new Blob([content as any]);
    const ok = await man.put(path, data, { ctime: now, mtime: now, size: data.size });
    if (!ok) throw new Error(`seed put failed: ${path}`);
    console.log(`[seeder] put ${path}`);
}

async function connect(replicator: LiveSyncJournalReplicator, _settings: RemoteDBSettings) {
    await replicator.initializeDatabaseForReplication();
    if (!(await replicator.checkReplicationConnectivity(false))) {
        throw new Error("checkReplicationConnectivity failed");
    }
}

const mode = Deno.args[0];
if (!mode || !["seed", "update", "verify-pull"].includes(mode)) {
    console.error("usage: seed_test_bucket.ts <seed|update|verify-pull>");
    Deno.exit(2);
}

if (mode === "seed") {
    await ensureBucketExists();
    const { man, replicator, settings } = await buildDevice("first");
    // First-time setup, like the plugin's "overwrite remote": clear the bucket,
    // upload sync parameters (PBKDF2 salt), then the milestone via the
    // compatibility check.
    await replicator.tryResetRemoteDatabase(settings);
    await connect(replicator, settings);
    await putFile(man, "notes/hello.md", "# Hello\n\nThis came from the seeder (plugin code path).\n");
    await putFile(man, "notes/日本語ノート.md", "Unicode filename test.\n");
    await putFile(man, "deep/nested/dir/leaf.md", "Deeply nested note.\n");
    await putFile(man, "binary.bin", new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]));
    const big = new Array(2000).fill("The quick brown fox jumps over the lazy dog. ").join("");
    await putFile(man, "notes/big.md", `# Big file\n\n${big}\n`);
    if (!(await replicator.replicateAllToServer(settings))) {
        throw new Error("replicateAllToServer failed");
    }
    console.log("[seeder] SEED DONE");
    Deno.exit(0);
}

if (mode === "update") {
    const { man, replicator, settings } = await buildDevice("second");
    await connect(replicator, settings);
    if (!(await replicator.replicateAllFromServer(settings))) {
        throw new Error("replicateAllFromServer failed");
    }
    await putFile(man, "notes/hello.md", "# Hello (edited)\n\nModified by the second seeder device.\n");
    await putFile(man, "added-later.md", "This file was added in the update round.\n");
    const deleted = await man.delete("deep/nested/dir/leaf.md");
    if (!deleted) throw new Error("seed delete failed");
    console.log("[seeder] deleted deep/nested/dir/leaf.md");
    if (!(await replicator.replicateAllToServer(settings))) {
        throw new Error("replicateAllToServer failed");
    }
    console.log("[seeder] UPDATE DONE");
    Deno.exit(0);
}

if (mode === "verify-pull") {
    const { man, replicator, settings } = await buildDevice("verify");
    await connect(replicator, settings);
    if (!(await replicator.replicateAllFromServer(settings))) {
        throw new Error("replicateAllFromServer failed");
    }
    const manifest: Record<string, string> = {};
    // NOTE: metaOnly:true is unusable here — upstream _enumerate() `return`s the
    // sub-generator instead of yield*-ing it, ending iteration with no results.
    for await (const doc of man.enumerateAllNormalDocs({ metaOnly: false })) {
        const entry = doc as ReadyEntry;
        if ((entry as any).deleted || (entry as any)._deleted) continue;
        const path = (entry as any).path as string;
        if (entry.type === "newnote") {
            const { decodeBinary } = await import("../lib/src/string_and_binary/convert.ts");
            manifest[path] = `<binary:${[...new Uint8Array(decodeBinary(entry.data))].join(",")}>`;
        } else {
            manifest[path] = entry.data.join("");
        }
    }
    console.log(`MANIFEST:${JSON.stringify(manifest)}`);
    console.log("[seeder] VERIFY DONE");
    Deno.exit(0);
}
