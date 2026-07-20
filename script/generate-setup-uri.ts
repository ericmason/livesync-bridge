/**
 * Generate a Self-hosted LiveSync "Setup URI" for an Object Storage (bucket)
 * remote, without needing an already-configured device.
 *
 * The Setup URI is the plugin's settings JSON encrypted with a short transport
 * passphrase (the same scheme as the plugin's own "Copy setup URI" command and
 * upstream's utils/flyio/generate_setupuri.ts). Open it on any device with the
 * plugin's "Open setup URI" command and enter the transport passphrase.
 *
 * All values come from the environment; nothing is written to disk. The URI is
 * printed to STDOUT (redirect it to a file); status goes to STDERR.
 *
 *   bucket=my-vault-bucket region=us-east-1 accessKey=... secretKey=... \
 *   passphrase='vault E2EE passphrase' uriPassphrase='transport words' \
 *   deno run -A script/generate-setup-uri.ts > setup-uri.txt
 *
 * Optional: endpoint (empty for AWS S3), bucketPrefix, forcePathStyle=true,
 * useCustomRequestHandler=true.
 */
import { encrypt, decrypt } from "octagonal-wheels/encryption/encryption";

const env = (k: string, fallback?: string): string => {
    const v = Deno.env.get(k) ?? fallback;
    if (v === undefined) {
        console.error(`Missing required environment variable: ${k}`);
        Deno.exit(1);
    }
    return v;
};

const uriPassphrase = env("uriPassphrase");
const conf = {
    remoteType: "MINIO",
    endpoint: env("endpoint", ""),
    region: env("region", ""),
    accessKey: env("accessKey"),
    secretKey: env("secretKey"),
    bucket: env("bucket"),
    bucketPrefix: env("bucketPrefix", ""),
    forcePathStyle: env("forcePathStyle", "") === "true",
    useCustomRequestHandler: env("useCustomRequestHandler", "") === "true",
    encrypt: true,
    passphrase: env("passphrase"),
    usePathObfuscation: env("usePathObfuscation", "true") === "true",
    syncOnStart: true,
    syncOnFileOpen: true,
    periodicReplication: true,
    batchSave: true,
    handleFilenameCaseSensitive: false,
    doNotUseFixedRevisionForChunks: false,
    settingVersion: 10,
};

const encrypted = await encrypt(JSON.stringify(conf), uriPassphrase, false);
// Verify the URI decrypts back to the exact same settings before handing it out.
const restored = JSON.parse(await decrypt(encrypted, uriPassphrase, false));
if (JSON.stringify(restored) !== JSON.stringify(conf)) {
    console.error("Round-trip verification FAILED");
    Deno.exit(1);
}
console.error(`Round-trip decrypt OK (bucket: ${conf.bucket})`);
console.log(`obsidian://setuplivesync?settings=${encodeURIComponent(encrypted)}`);
