import type { DirectFileManipulatorOptions } from "./lib/src/API/DirectFileManipulator.ts";

export interface Config {
    peers: PeerConf[];
}
export type PeerConf = PeerStorageConf | PeerCouchDBConf | PeerBucketConf;

export interface PeerStorageConf {
    scanOfflineChanges?: boolean;
    type: "storage";
    group?: string;
    name: string;
    baseDir: string;
    processor?: {
        cmd: string,
        args: string[]
    }
    useChokidar?: boolean;
}
export interface PeerCouchDBConf extends DirectFileManipulatorOptions {
    /** Glob patterns for i:-prefixed (internal) files to sync, e.g. [".claude/**"] */
    includeInternal?: string[];
    type: "couchdb";
    useRemoteTweaks?: true;
    group?: string;
    name: string;
    database: string;
    username: string;
    password: string;
    url: string;
    customChunkSize?: number;
    minimumChunkSize?: number;
    passphrase: string;
    obfuscatePassphrase: string;
    baseDir: string;
}



/**
 * Peer for a Self-hosted LiveSync Object-Storage backend (S3 / R2 / MinIO —
 * "bucket synchronisation" / journal sync).
 */
export interface PeerBucketConf {
    type: "bucket";
    name: string;
    group?: string;
    baseDir: string;
    /**
     * "pull": bucket -> hub only; writes from other peers are ignored (safe default).
     * "sync": bidirectional; local changes are packed and uploaded to the bucket.
     */
    direction?: "pull" | "sync";
    /** S3-compatible endpoint URL. Leave empty for AWS S3 (uses `region`). */
    endpoint?: string;
    region?: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
    /** Key prefix inside the bucket (must match the plugin's setting). */
    bucketPrefix?: string;
    /** Path-style addressing; usually true for MinIO/self-hosted, false for AWS. */
    forcePathStyle?: boolean;
    /** Extra request headers, same format as the plugin ("Header: value" lines). */
    bucketCustomHeaders?: string;
    /** E2EE passphrase (journal packs in the bucket are encrypted with this). */
    passphrase?: string;
    /** Path obfuscation passphrase; if the vault uses it, required here too. */
    obfuscatePassphrase?: string;
    /** "" = V1(legacy), "v2" = AES-256-GCM w/HKDF (plugin default), "forceV1". */
    E2EEAlgorithm?: "" | "v2" | "forceV1";
    useDynamicIterationCount?: boolean;
    /** Adopt chunking/E2EE tweaks advertised by the bucket milestone. Default true. */
    useRemoteTweaks?: boolean;
    /** Path of the persistent local replica DB. Default: ./dat/bucket-<name> */
    localDatabase?: string;
    /** Poll interval in seconds (object storage has no push channel). Default 30. */
    syncIntervalSeconds?: number;
    /** Glob patterns for i:-prefixed (internal) files to sync, e.g. [".claude/**"] */
    includeInternal?: string[];
    // Chunking tweaks; normally adopted from the bucket via useRemoteTweaks.
    customChunkSize?: number;
    minimumChunkSize?: number;
    enableCompression?: boolean;
    handleFilenameCaseSensitive?: boolean;
    doNotUseFixedRevisionForChunks?: boolean;
    enableChunkSplitterV2?: boolean;
    chunkSplitterVersion?: any;
    hashAlg?: any;
    useEden?: boolean;
    maxChunksInEden?: number;
    maxTotalLengthInEden?: number;
    maxAgeInEden?: number;
}

export function isCouchDBPeer(peer: PeerConf): peer is PeerCouchDBConf {
    return peer.type == "couchdb";
}

export function isBucketPeer(peer: PeerConf): peer is PeerBucketConf {
    return peer.type == "bucket";
}

export function isStoragePeer(peer: PeerConf): peer is PeerStorageConf {
    return peer.type == "storage";
}

export type FileData = {
    ctime: number;
    mtime: number;
    size: number;
    data: string[] | Uint8Array<ArrayBuffer>;
    deleted?: boolean;
}