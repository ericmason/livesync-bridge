import { DirectFileManipulator, type FileInfo, type MetaEntry, type ReadyEntry } from "./lib/src/API/DirectFileManipulatorV2.ts";
import {
    DEFAULT_SETTINGS,
    DEVICE_ID_PREFERRED,
    E2EEAlgorithms,
    LOG_LEVEL_NOTICE,
    REMOTE_MINIO,
    TweakValuesTemplate,
    type BucketSyncSetting,
    type EntryMilestoneInfo,
    type FilePathWithPrefix,
    type RemoteDBSettings,
    type TweakValues,
} from "./lib/src/common/types.ts";
import type { ObsidianLiveSyncSettings } from "./lib/src/common/types.ts";
import { PeerBucketConf, FileData } from "./types.ts";
import { decodeBinary } from "./lib/src/string_and_binary/convert.ts";
import { isPlainText } from "./lib/src/string_and_binary/path.ts";
import { DispatchFun, Peer, PeerHealth } from "./Peer.ts";
import { createBinaryBlob, createTextBlob, extractObject, isDocContentSame, unique } from "./lib/src/common/utils.ts";
import { minimatch } from "minimatch";
import { promiseWithResolver } from "octagonal-wheels/promises";
import {
    LiveSyncJournalReplicator,
    type LiveSyncJournalReplicatorEnv,
} from "./lib/src/replication/journal/LiveSyncJournalReplicator.ts";
import { reactiveSource } from "./lib/src/dataobject/reactive.ts";
import type { KeyValueDatabase } from "./lib/src/interfaces/KeyValueDatabase.ts";
import { SimpleStoreFile } from "./SimpleStoreFile.ts";
// Importing LocalPouchDB also registers the persistent "leveldb" adapter on
// the shared PouchDB build before any manipulator creates a database.
import { PouchDB as LocalPouchDB } from "./LocalPouchDB.ts";

const MILESTONE_KEY = "_00000000-milestone.json";

/**
 * A peer that synchronizes with a Self-hosted LiveSync bucket (Object Storage
 * such as S3 / R2 / MinIO, "journal sync").
 *
 * Unlike CouchDB there is no server-side database to query: the bucket holds a
 * journal of packed document batches. So this peer keeps a local PouchDB
 * replica (leveldb-backed, persistent across restarts), lets the commonlib's
 * JournalSyncMinio apply/pack journals against it, and watches that replica's
 * changes feed to dispatch files to the hub — the same shape as PeerCouchDB,
 * with the local replica standing in for the remote CouchDB.
 *
 * The local replica stores documents exactly as the plugin does locally
 * (plaintext data, obfuscated IDs when path obfuscation is enabled); E2EE is
 * applied by JournalSyncMinio at the pack level, matching the plugin.
 */
export class PeerBucket extends Peer {
    man!: DirectFileManipulator;
    declare config: PeerBucketConf;
    replicator!: LiveSyncJournalReplicator;
    private simpleStore = new SimpleStoreFile(this.storeDir());
    private _started = promiseWithResolver<void>();
    private _connected = false;
    private _remoteInitialized = false;
    private _syncTimer: ReturnType<typeof setTimeout> | undefined;
    private _stopped = false;
    private _syncRunning = false;

    constructor(conf: PeerBucketConf, dispatcher: DispatchFun) {
        super(conf, dispatcher);
    }

    private storeDir() {
        return `${this.localDatabasePath()}-store`;
    }
    private localDatabasePath() {
        return (this.config as PeerBucketConf).localDatabase || `./dat/bucket-${(this.config as PeerBucketConf).name}`;
    }
    private get direction(): "pull" | "sync" {
        return this.config.direction ?? "pull";
    }
    private get syncIntervalMs() {
        return Math.max(5, this.config.syncIntervalSeconds ?? 30) * 1000;
    }

    /**
     * The full settings object handed to the journal replicator/client.
     * Pack-level E2EE (encrypt/passphrase) lives HERE — not on the local
     * replica, which stays plaintext like the plugin's own local database.
     */
    buildRemoteSettings(): RemoteDBSettings & BucketSyncSetting & Pick<ObsidianLiveSyncSettings, "remoteType"> {
        const c = this.config;
        return {
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_MINIO,
            accessKey: c.accessKey,
            secretKey: c.secretKey,
            bucket: c.bucket,
            region: c.region ?? "",
            endpoint: c.endpoint ?? "",
            bucketPrefix: c.bucketPrefix ?? "",
            forcePathStyle: c.forcePathStyle ?? false,
            useCustomRequestHandler: false,
            bucketCustomHeaders: c.bucketCustomHeaders ?? "",
            encrypt: c.passphrase ? true : false,
            passphrase: c.passphrase ?? "",
            usePathObfuscation: c.obfuscatePassphrase ? true : false,
            useDynamicIterationCount: c.useDynamicIterationCount ?? false,
            E2EEAlgorithm: c.E2EEAlgorithm ?? E2EEAlgorithms.V2,
            minimumChunkSize: c.minimumChunkSize ?? DEFAULT_SETTINGS.minimumChunkSize,
            customChunkSize: c.customChunkSize ?? DEFAULT_SETTINGS.customChunkSize,
            enableCompression: c.enableCompression ?? DEFAULT_SETTINGS.enableCompression,
            useEden: c.useEden ?? DEFAULT_SETTINGS.useEden,
            maxChunksInEden: c.maxChunksInEden ?? DEFAULT_SETTINGS.maxChunksInEden,
            maxTotalLengthInEden: c.maxTotalLengthInEden ?? DEFAULT_SETTINGS.maxTotalLengthInEden,
            maxAgeInEden: c.maxAgeInEden ?? DEFAULT_SETTINGS.maxAgeInEden,
            enableChunkSplitterV2: c.enableChunkSplitterV2 ?? DEFAULT_SETTINGS.enableChunkSplitterV2,
            chunkSplitterVersion: c.chunkSplitterVersion ?? DEFAULT_SETTINGS.chunkSplitterVersion,
            hashAlg: c.hashAlg ?? DEFAULT_SETTINGS.hashAlg,
            handleFilenameCaseSensitive: c.handleFilenameCaseSensitive ?? DEFAULT_SETTINGS.handleFilenameCaseSensitive,
            doNotUseFixedRevisionForChunks:
                c.doNotUseFixedRevisionForChunks ?? DEFAULT_SETTINGS.doNotUseFixedRevisionForChunks,
        };
    }

    private _buildManipulator(): void {
        const prev = this.man as DirectFileManipulator | undefined;
        const localPath = this.localDatabasePath();
        this.man = new DirectFileManipulator({
            // `url` doubles as the local database path prefix; there is no remote
            // CouchDB here. Note: NO passphrase — the local replica is plaintext,
            // exactly like the plugin's local database. E2EE happens per journal
            // pack inside JournalSyncMinio.
            url: localPath,
            username: "",
            password: "",
            database: this.config.name,
            passphrase: undefined,
            obfuscatePassphrase: this.config.obfuscatePassphrase || undefined,
            customChunkSize: this.config.customChunkSize,
            minimumChunkSize: this.config.minimumChunkSize,
            hashAlg: this.config.hashAlg,
            useEden: this.config.useEden,
            maxChunksInEden: this.config.maxChunksInEden,
            maxTotalLengthInEden: this.config.maxTotalLengthInEden,
            maxAgeInEden: this.config.maxAgeInEden,
            enableChunkSplitterV2: this.config.enableChunkSplitterV2,
            enableCompression: this.config.enableCompression,
            handleFilenameCaseSensitive: this.config.handleFilenameCaseSensitive,
            doNotUseFixedRevisionForChunks: this.config.doNotUseFixedRevisionForChunks,
            chunkSplitterVersion: this.config.chunkSplitterVersion,
        });
        this.man.$$createPouchDBInstance = <T extends object>(
            name?: string,
            options?: PouchDB.Configuration.DatabaseConfiguration
        ): PouchDB.Database<T> => {
            return new LocalPouchDB(name ?? `${localPath}-livesync-v2`, {
                ...options,
                adapter: "leveldb",
            }) as PouchDB.Database<T>;
        };
        this.man.since = this.getSetting("since") || "now";
        if (prev) void prev.close().catch(() => {});
    }

    private _buildReplicator() {
        const settings = () => this.buildRemoteSettings();
        const getDb = () => this.man.liveSyncLocalDB.localDatabase;
        const env: LiveSyncJournalReplicatorEnv = {
            getDatabase: () => getDb(),
            getSettings: () => settings(),
            $$isMobile: () => false,
            $$getLastPostFailedBySize: () => false,
            // Arrived documents are picked up via the local replica's changes
            // feed (beginWatch), the same path PeerCouchDB uses — nothing to do here.
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
            kvDB: makeUnusedKvDBStub(),
            simpleStore: this.simpleStore,
            $$customFetchHandler: () => undefined as any,
        };
        this.replicator = new LiveSyncJournalReplicator(env);
    }

    private _waitReady(timeoutMs: number): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Local database init timed out")), timeoutMs);
        });
        return Promise.race([this.man.ready.promise as Promise<void>, timeout]).finally(() => {
            if (timer !== undefined) clearTimeout(timer);
        });
    }

    async start(): Promise<void> {
        let attempt = 0;
        for (;;) {
            if (this._stopped) return;
            try {
                await this._connect();
                if (attempt > 0) {
                    this.normalLog(`Connected to bucket after ${attempt} retr${attempt === 1 ? "y" : "ies"}.`, LOG_LEVEL_NOTICE);
                }
                this._connected = true;
                this._started.resolve();
                this._scheduleSync(this.syncIntervalMs);
                return;
            } catch (e) {
                attempt++;
                const delay = Math.min(60000, 1000 * 2 ** Math.min(attempt - 1, 5));
                this.normalLog(`Bucket connect attempt ${attempt} failed; retrying in ${delay / 1000}s.`, LOG_LEVEL_NOTICE);
                this.debugLog(`${e instanceof Error ? (e.stack ?? e.message) : e}`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    private async _connect(): Promise<void> {
        this._buildManipulator();
        await this._waitReady(15000);
        this._buildReplicator();
        await this.replicator.initializeDatabaseForReplication();

        if (!(await this.replicator.client.isAvailable())) {
            throw new Error("Bucket is not reachable");
        }

        // The bridge never initializes an empty bucket: the vault (and its
        // milestone, sync parameters and preferred tweaks) must be created by a
        // real device first. Otherwise the bridge would register ITS defaults as
        // the bucket's preferred tweak values before any actual vault exists.
        const milestone = await this.replicator.client.downloadJson<EntryMilestoneInfo>(MILESTONE_KEY);
        if (!milestone) {
            this.normalLog(
                `Bucket is empty (not initialized by any device yet). Waiting for a device to set up the vault...`,
                LOG_LEVEL_NOTICE
            );
            this._remoteInitialized = false;
            // Not an error: begin polling; each poll re-checks for the milestone.
            return;
        }
        await this._prepareForMilestone(milestone);
        this._remoteInitialized = true;

        await this._syncOnce();
        this._beginWatch();
    }

    /** Adopt remote tweaks and detect a rebuilt bucket (created stamp changed). */
    private async _prepareForMilestone(milestone: EntryMilestoneInfo): Promise<void> {
        if (this.config.useRemoteTweaks !== false) {
            const tweaks = milestone.tweak_values?.[DEVICE_ID_PREFERRED] as TweakValues | undefined;
            if (tweaks) {
                const orgConf = { ...this.config } as Record<string, any>;
                const adoptable = extractObject(TweakValuesTemplate, { ...TweakValuesTemplate, ...tweaks }) as Record<
                    string,
                    any
                >;
                if (adoptable.encrypt && !this.config.passphrase) {
                    throw new Error("Remote bucket is encrypted but no passphrase provided.");
                }
                if (adoptable.usePathObfuscation && !this.config.obfuscatePassphrase) {
                    throw new Error("Remote bucket uses path obfuscation but no obfuscatePassphrase provided.");
                }
                const conf = this.config as Record<string, any>;
                for (const key of Object.keys(TweakValuesTemplate)) {
                    if (key === "encrypt" || key === "usePathObfuscation") continue; // driven by passphrases
                    if (key in adoptable) conf[key] = adoptable[key];
                }
                const diff = unique([...Object.keys(TweakValuesTemplate)]).filter((k) => orgConf[k] != conf[k]);
                if (diff.length > 0) {
                    this.normalLog(`Remote tweaks adopted --->`);
                    for (const diffKey of diff) {
                        this.normalLog(`${diffKey}\t: ${orgConf[diffKey]} \t : ${conf[diffKey]}`);
                    }
                    this.normalLog(`<--- Remote tweaks adopted`);
                    this.man.options = { ...this.man.options, ...extractManipulatorOptions(this.config) };
                    await this.man.liveSyncLocalDB.initializeDatabase();
                }
            }
        }
        const created = `${milestone.created}`;
        const known = this.getSetting("remote-created");
        if (known !== created) {
            if (known) {
                this.normalLog(
                    `Remote bucket looks like rebuilt (created ${known} -> ${created}). Resetting the local replica and fetching from scratch.`,
                    LOG_LEVEL_NOTICE
                );
                await this._resetLocalReplica();
            } else {
                // First connect against this bucket: replay the replica's changes
                // feed from the beginning so everything already-synced gets
                // dispatched to the hub (the watch otherwise starts at "now",
                // which is after the initial journal application).
                this.normalLog(`Fresh connection; dispatching from the beginning.`);
                this.man.since = "";
                this.setSetting("since", "");
            }
        }
        this.setSetting("remote-created", created);
    }

    private async _resetLocalReplica(): Promise<void> {
        this.man.endWatch();
        await this.replicator.client.resetCheckpointInfo();
        await this.replicator.client.resetAllCaches();
        await this.man.liveSyncLocalDB.localDatabase.destroy();
        this.setSetting("since", "");
        // Rebuild everything on top of the fresh (empty) database.
        this._buildManipulator();
        this.man.since = "";
        await this._waitReady(15000);
        this._buildReplicator();
        await this.replicator.initializeDatabaseForReplication();
    }

    private _scheduleSync(afterMs: number) {
        if (this._stopped) return;
        if (this._syncTimer !== undefined) clearTimeout(this._syncTimer);
        this._syncTimer = setTimeout(() => {
            void this._syncTick();
        }, afterMs);
    }

    private async _syncTick() {
        try {
            if (!this._remoteInitialized) {
                // Still waiting for a device to initialize the bucket.
                const milestone = await this.replicator.client.downloadJson<EntryMilestoneInfo>(MILESTONE_KEY);
                if (milestone) {
                    await this._prepareForMilestone(milestone);
                    this._remoteInitialized = true;
                    await this._syncOnce();
                    this._beginWatch();
                }
            } else {
                await this._syncOnce();
            }
        } catch (e) {
            this.normalLog(`Sync cycle failed: ${e instanceof Error ? e.message : e}`, LOG_LEVEL_NOTICE);
            this.debugLog(`${e instanceof Error ? (e.stack ?? e.message) : e}`);
        } finally {
            this._scheduleSync(this.syncIntervalMs);
        }
    }

    private async _syncOnce(): Promise<void> {
        if (this._syncRunning) return;
        this._syncRunning = true;
        try {
            const settings = this.buildRemoteSettings();
            if (this.direction === "sync") {
                await this.replicator.openReplication(settings, false, false, false);
            } else {
                await this.replicator.replicateAllFromServer(settings, false);
            }
        } finally {
            this._syncRunning = false;
        }
    }

    private _beginWatch() {
        const baseDir = this.toLocalPath("");
        this.man.beginWatch(async (entry) => {
            const d = entry.type == "plain" ? entry.data : new Uint8Array(decodeBinary(entry.data));
            let path = entry.path.substring(baseDir.length);
            if (path.startsWith("/")) {
                path = path.substring(1);
            }
            if (path.startsWith("i:")) {
                path = path.substring(2);
            }
            if (entry.deleted || entry._deleted) {
                this.sendLog(`${path} delete detected`);
                await this.dispatchDeleted(path);
            } else {
                const docData = {
                    ctime: entry.ctime,
                    mtime: entry.mtime,
                    size: entry.size,
                    deleted: entry.deleted || entry._deleted,
                    data: d,
                };
                this.sendLog(`${path} change detected`);
                await this.dispatch(path, docData);
            }
        }, (entry) => {
            this.setSetting("since", this.man.since);
            if (entry.path.indexOf(":") !== -1) {
                if (this.config.includeInternal && entry.path.startsWith("i:")) {
                    const stripped = entry.path.substring(2);
                    return this.config.includeInternal.some((pattern) => minimatch(stripped, pattern, { dot: true }));
                }
                return false;
            }
            return entry.path.startsWith(baseDir);
        });
    }

    async dispatch(path: string, data: FileData | false) {
        if (data === false) return;
        if (!(await this.isRepeating(path, data))) {
            await this.dispatchToHub(this, this.toGlobalPath(path), data);
        }
    }
    async dispatchDeleted(path: string) {
        if (!(await this.isRepeating(path, false))) {
            await this.dispatchToHub(this, this.toGlobalPath(path), false);
        }
    }

    async delete(pathSrc: string): Promise<boolean> {
        if (this.direction === "pull") {
            this.receiveLog(` ${pathSrc} delete ignored (bucket peer is pull-only; set "direction": "sync" to write back)`);
            return false;
        }
        await this._started.promise;
        const path = this.toLocalPath(pathSrc);
        if (await this.isRepeating(pathSrc, false)) {
            return false;
        }
        const r = await this.man.delete(path);
        if (r) {
            this.receiveLog(` ${path} deleted`);
            this._requestPushSoon();
        } else {
            this.receiveLog(` ${path} delete failed`, LOG_LEVEL_NOTICE);
        }
        return r;
    }

    async put(pathSrc: string, data: FileData): Promise<boolean> {
        if (this.direction === "pull") {
            this.receiveLog(` ${pathSrc} write ignored (bucket peer is pull-only; set "direction": "sync" to write back)`);
            return false;
        }
        await this._started.promise;
        const path = this.toLocalPath(pathSrc);
        if (await this.isRepeating(pathSrc, data)) {
            return false;
        }
        const type = isPlainText(path) ? "plain" : "newnote";
        const info: FileInfo = {
            ctime: data.ctime,
            mtime: data.mtime,
            size: data.size,
        };
        const saveData = data.data instanceof Uint8Array ? createBinaryBlob(data.data) : createTextBlob(data.data);
        const old = (await this.man.get(path as FilePathWithPrefix, true)) as false | MetaEntry;
        if (old && Math.abs(this.compareDate(info, old)) < 3600) {
            const oldDoc = await this.man.getByMeta(old);
            if (oldDoc && "data" in oldDoc) {
                const d =
                    oldDoc.type == "plain"
                        ? createTextBlob(oldDoc.data)
                        : createBinaryBlob(new Uint8Array(decodeBinary(oldDoc.data)));
                if (await isDocContentSame(d, saveData)) {
                    this.normalLog(` Skipped (Same) ${path} `);
                    return false;
                }
            }
        }
        const r = await this.man.put(path, saveData, info, type);
        if (r) {
            this.receiveLog(` ${path} saved`);
            this._requestPushSoon();
        } else {
            this.receiveLog(` ${path} ignored`);
        }
        return r;
    }

    // Local writes only reach the bucket when a sync cycle packs and uploads
    // them. Pull the next cycle closer so edits don't idle for a full interval.
    private _pushDebounce: ReturnType<typeof setTimeout> | undefined;
    private _requestPushSoon() {
        if (this.direction !== "sync") return;
        if (this._pushDebounce !== undefined) clearTimeout(this._pushDebounce);
        this._pushDebounce = setTimeout(() => {
            this._pushDebounce = undefined;
            this._scheduleSync(0);
        }, 3000);
    }

    async get(pathSrc: FilePathWithPrefix): Promise<false | FileData> {
        await this._started.promise;
        const path = this.toLocalPath(pathSrc) as FilePathWithPrefix;
        const ret = (await this.man.get(path)) as false | ReadyEntry;
        if (ret === false) {
            return false;
        }
        return {
            ctime: ret.ctime,
            mtime: ret.mtime,
            data: ret.type == "newnote" ? new Uint8Array(decodeBinary(ret.data)) : ret.data,
            size: ret.size,
            deleted: ret.deleted,
        };
    }

    async stop(): Promise<void> {
        this._stopped = true;
        if (this._syncTimer !== undefined) clearTimeout(this._syncTimer);
        if (this._pushDebounce !== undefined) clearTimeout(this._pushDebounce);
        this.man?.endWatch();
        this.replicator?.closeReplication();
        await this.man?.close().catch(() => {});
    }

    override health(): PeerHealth {
        const watching = this.man?.watching === true;
        const syncing = this._connected && (watching || !this._remoteInitialized);
        return {
            name: this.config.name,
            type: "bucket",
            ok: syncing,
            detail: !this._connected
                ? "connecting"
                : watching
                    ? "watching"
                    : !this._remoteInitialized
                        ? "connected (bucket not initialized)"
                        : "reconnecting",
            backendUp: syncing,
            restartWorthy: false,
        };
    }
    override async checkBackendUp(): Promise<boolean> {
        try {
            return await this.replicator.client.isAvailable();
        } catch {
            return false;
        }
    }
}

// The journal path never touches kvDB (it is part of the wider replicator env
// interface, used by other subsystems). Keep a loud stub so an unexpected use
// surfaces immediately instead of corrupting state silently.
function makeUnusedKvDBStub(): KeyValueDatabase {
    const bang = () => {
        throw new Error("kvDB is not available in the bucket peer");
    };
    return {
        get: bang,
        set: bang,
        del: bang,
        clear: bang,
        keys: bang,
        close: () => {},
        destroy: bang,
    } as unknown as KeyValueDatabase;
}

function extractManipulatorOptions(c: PeerBucketConf) {
    return {
        customChunkSize: c.customChunkSize,
        minimumChunkSize: c.minimumChunkSize,
        hashAlg: c.hashAlg,
        useEden: c.useEden,
        maxChunksInEden: c.maxChunksInEden,
        maxTotalLengthInEden: c.maxTotalLengthInEden,
        maxAgeInEden: c.maxAgeInEden,
        enableChunkSplitterV2: c.enableChunkSplitterV2,
        enableCompression: c.enableCompression,
        handleFilenameCaseSensitive: c.handleFilenameCaseSensitive,
        doNotUseFixedRevisionForChunks: c.doNotUseFixedRevisionForChunks,
        chunkSplitterVersion: c.chunkSplitterVersion,
    };
}
