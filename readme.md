# LiveSync Bridge

![screenshot](https://github.com/vrtmrz/livesync-bridge/assets/45774780/457f8909-14e4-4d86-bcf9-24fad7d3342a)

## What is this?

This is a custom replicator between Self-hosted LiveSync remote vaults and
storage. **The Unified Version of filesystem-livesync and livesync-classroom**.

A Vault or storage can be synchronised with vaults or storage. You can even combine them. Of course, different passphrases for each vault could be used.
And, you can synchronize documents under the specified folder on the vault, to another vault's specified one.

Of course, it is multi-directional!

# How to use

## Prerequisites

- [Deno](https://deno.com/) is required.

## Simply run

1. Clone the GitHub Repository

```git
git clone --recursive https://github.com/vrtmrz/livesync-bridge
```

2. Open the config file dat/config.sample.json, edit and save to
   dat/config.json. (You do not have to worry, the sample is in the following
   section).
3. Simply run like this.

```bash
$ deno install
$ deno task run
```

Note: If you want to scan all storage and databases from the beginning, please run with `--reset`.

# Docker Instructions

1. Clone the GitHub Repository

```git
git clone https://github.com/vrtmrz/livesync-bridge
```

2. Open the config file dat/config.sample.json, edit and save to
   dat/config.json. (The storage folder has to start with "data/" to be in the volume)

3. Simply run like this.
```bash
docker compose up -d
```


# Configuration

The configuration file consists of the following structure.

```jsonc
{
  "peers": [
    {
      "type": "couchdb", // Type should be `couchdb`, `bucket` or `storage`
      "name": "test1", // Should be unique
      "group": "main", // we can omit this.
      "database": "test",
      "username": "admin",
      "password": "password",
      "url": "http://localhost:5984",
      "customChunkSize": 100,
      "minimumChunkSize": 20,
      "passphrase": "passphrase", // E2EE passphrase, if you do not enabled, leave it blank.
      "obfuscatePassphrase": "passphrase", // Path obfuscation passphrase, if you do not enabled, leave it blank. if enabled, set the same value of passphrase.
      "baseDir": "blog/", // Sharing folder
      "includeInternal": [".claude/**"], // Opt-in glob patterns for internal/hidden files (see caution below). Omit to keep the default of skipping them.
      "useRemoteTweaks":true // Overwrite customChunkSize or minimumChunkSize, and check configuration matches
    },
    {
      "type": "couchdb",
      "name": "test2", // We can even synchronise the same databases as long as they have different names in here.
      "group": "main", // we can omit this.
      "database": "test2",
      "username": "admin",
      "passphrase": "passphrase",
      "password": "password",
      "url": "http://localhost:5984",
      "customChunkSize": 100,
      "minimumChunkSize": 20,
      "obfuscatePassphrase": "passphrase",
      "baseDir": "xxxx/",
    },
    {
      "type": "bucket", // An Object Storage (S3 / R2 / MinIO) remote — "Bucket synchronisation".
      "name": "bucket-test1",
      "group": "main", // we can omit this.
      "endpoint": "http://localhost:9000", // S3-compatible endpoint. Leave empty ("") for AWS S3.
      "region": "us-east-1",
      "accessKey": "accessKey",
      "secretKey": "secretKey",
      "bucket": "vault-bucket",
      "bucketPrefix": "", // Key prefix; must match the plugin's setting.
      "forcePathStyle": true, // Usually true for MinIO/self-hosted, false for AWS/R2.
      "passphrase": "passphrase", // E2EE passphrase, if you do not enabled, leave it blank.
      "obfuscatePassphrase": "passphrase", // Path obfuscation passphrase, same rule as couchdb peers.
      "baseDir": "", // Sharing folder, same semantics as couchdb peers.
      "direction": "pull", // "pull" (bucket -> others only; the safe default) or "sync" (bidirectional).
      "syncIntervalSeconds": 30, // Object storage has no change feed; the bridge polls the journal.
      "localDatabase": "./dat/bucket-test1" // Where the persistent local replica lives. Can be omitted.
    },
    {
      "type": "storage",
      "name": "storage-test1",
      "group": "main", // we can omit this.
      "baseDir": "./vault/", // The folder which have been synchronised.
      "processor": { // The processor configuration. You can omit this.
        "cmd": "script/test.sh",  // The programme which run at file modification or deletion.
        "args": [ "$filename", "$mode" ] 
        // The modified file is set to $filename. The mode is set to `deleted` or `modified`. 
        // $filename and $mode have been set also in environment variables.
      },
      "scanOfflineChanges": true,
      "useChokidar":false, // We are using `Deno.watch` now, if you have trouble in Linux, please enable this.
    }
  ]
}
```

## Synchronising internal/hidden files

By default, the bridge skips all of Self-hosted LiveSync's internal documents — the ones stored with an `i:` prefix, such as files inside hidden folders like `.obsidian/`, `.claude/`, and other tool configuration directories. These are normally left out of the sync.

The optional `includeInternal` field opts specific internal paths back in. It takes an array of [minimatch](https://github.com/isaacs/minimatch) glob patterns that are matched against the path **after** the `i:` prefix is stripped:

```jsonc
{
  "type": "couchdb",
  "name": "test1",
  // ...
  "baseDir": "blog/",
  "includeInternal": [".claude/**"] // Sync everything under .claude/
}
```

A document is included when its de-prefixed path matches any one of the patterns. Patterns are matched with the `dot` option, so leading-dot folders such as `.claude/` are matched as expected.

> [!CAUTION]
> This synchronises files that are normally hidden and internal. Such folders often hold tool configuration that can contain machine-specific paths, local settings, or secrets. Only include patterns you genuinely intend to share, and review what they match before enabling. The option is opt-in: leave it out to keep the default behaviour, where all internal/hidden files are skipped.

## Object Storage (bucket) peers

`"type": "bucket"` connects the bridge to a Self-hosted LiveSync **Object
Storage** remote (Minio, S3, R2, ... — the plugin's "Bucket synchronisation" /
journal sync). This lets you mirror a bucket-backed vault to plain files on a
headless machine, with no CouchDB anywhere.

How it works: object storage has no queryable database — the bucket holds a
journal of packed document batches. The bridge therefore keeps a small
**persistent local replica** (a LevelDB-backed PouchDB, at `localDatabase`,
default `./dat/bucket-<name>`) and lets the plugin's own journal-sync code
apply and create journal packs against it. E2EE and path obfuscation behave
exactly as in the plugin: journal packs in the bucket are encrypted with
`passphrase`, and document IDs are obfuscated with `obfuscatePassphrase`.

Points worth knowing:

- **`direction`**: `"pull"` (default) only reads from the bucket; writes coming
  from other peers are rejected with a log message. Set `"sync"` for
  bidirectional synchronisation once you trust the setup.
- **Polling**: buckets cannot push change notifications, so the bridge polls
  every `syncIntervalSeconds` (default 30). Local file changes in `"sync"` mode
  trigger an upload shortly after they happen.
- **The bridge never initialises an empty bucket.** Set the vault up from a
  real device (Obsidian) first; the bridge waits until the bucket has a
  milestone and then joins like any other device.
- **Tweaks are adopted automatically** from the bucket's preferred settings
  (chunk sizes, splitter, compression...), like `useRemoteTweaks` for couchdb
  peers. Disable with `"useRemoteTweaks": false` if you really need to.
- If the bucket is rebuilt from a device ("Fresh start" / overwrite), the
  bridge detects the changed creation stamp, resets its local replica, and
  fetches everything from scratch.
- Keep the `localDatabase` and `dat/` directories persistent between runs;
  they carry the replica and the journal checkpoints. Deleting them is safe
  but causes a full re-download on the next start.

An integration test covering plugin-compatibility end-to-end (seed from the
plugin code path -> pull; edits -> incremental pull; bridge write -> verified
readable by a fresh plugin-side replica) is available:

```bash
./script/test-bucket-peer.sh   # requires deno and minio (or docker)
```

### Generating a Setup URI without a configured device

Normally the plugin's *Copy setup URI* command requires an already-configured
vault. `script/generate-setup-uri.ts` produces one headlessly for a bucket
remote (same scheme as upstream's `utils/flyio/generate_setupuri.ts`), so every
device — including the first — can be set up with *Open setup URI* + a short
transport passphrase instead of typing S3 credentials into the settings UI:

```bash
bucket=my-vault-bucket region=us-east-1 accessKey=... secretKey=... \
passphrase='vault E2EE passphrase' uriPassphrase='transport words' \
deno run -A script/generate-setup-uri.ts > setup-uri.txt
```

### Preparing the bucket (AWS S3 example)

The bridge works with whatever bucket the plugin already uses — nothing extra
is required. If you are creating the bucket from scratch, this is a sensible,
least-privilege setup (adapt the ideas for R2/MinIO):

```bash
aws s3api create-bucket --bucket my-vault-bucket
# Keep it private, and keep old versions around as an undo button:
aws s3api put-public-access-block --bucket my-vault-bucket \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket my-vault-bucket \
  --versioning-configuration Status=Enabled
# Optional: stop noncurrent versions from accumulating forever.
aws s3api put-bucket-lifecycle-configuration --bucket my-vault-bucket \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-noncurrent","Status":"Enabled","Filter":{},
    "NoncurrentVersionExpiration":{"NoncurrentDays":30},
    "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
```

A dedicated IAM user scoped to just this bucket needs only:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
            "Resource": "arn:aws:s3:::my-vault-bucket"
        },
        {
            "Effect": "Allow",
            "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            "Resource": "arn:aws:s3:::my-vault-bucket/*"
        }
    ]
}
```

**CORS:** the *bridge* needs none — CORS is a browser-engine concern and the
bridge is a server-side process. The **Obsidian app** does need it (it calls
S3 from inside an Electron/Capacitor page), so if the plugin cannot connect,
add a CORS rule on the bucket allowing origins `app://obsidian.md`,
`capacitor://localhost` and `http://localhost` with methods
`GET, PUT, POST, DELETE, HEAD`, all headers, exposing `ETag`. This is not
access control — authentication is still the access key; it only tells the
app's embedded browser the bucket may be talked to.

### Troubleshooting bucket peers

- **"Bucket is empty (not initialized by any device yet)"** — by design. The
  bridge never creates the vault; run the plugin's setup against the bucket
  first, and the bridge joins on its next poll.
- **"Remote bucket is encrypted but no passphrase provided"** (or garbage /
  decryption errors) — the bucket's preferred settings say E2EE (or path
  obfuscation) is on; set the same `passphrase` / `obfuscatePassphrase` the
  vault uses.
- **Writes are logged as "ignored (bucket peer is pull-only)"** — that is the
  `direction: "pull"` safety default; set `"direction": "sync"` to write back.
- **Files exist in the vault but never appear** — check `baseDir`: like
  couchdb peers, only documents under `baseDir` are synchronised, and internal
  (`i:`-prefixed) files need `includeInternal` patterns.
- **Start over from scratch** — stop the bridge, delete the peer's
  `localDatabase` directory (default `./dat/bucket-<name>` plus the
  `...-store` directory next to it), and start with `--reset`. The bridge
  re-downloads the whole journal and re-dispatches everything; peers
  compare content before writing, so this is safe.

## Realistic example

| name                       | database_uri / path                       | CouchDB username | CouchDB password | vault E2EE passphrase | baseDir  |
| -------------------------- | ----------------------------------------- | ---------------- | ---------------- | --------------------- | -------- |
| private vault of Cornbread | http://localhost:5984/classroom_cornbread | cornbread        | tackle           | glucose               | shared/  |
| shared vault               | http://localhost:5984/classroom_shared    | common_user      | resu_nommoc      | cocoa                 |          |
| private vault of Vanilla   | http://localhost:5984/classroom_vanilla   | vanilla          | liberty          | smock                 | kyouyuu/ |
| storage                    | ./vault/                                  |                  |                  |                       |          |

Cornbread's every document under "shared" is synchronized with the top of the
shared vault:

| Cornbread          | shared            |
| ------------------ | ----------------- |
| document1          | _Not transferred_ |
| document2          | _Not transferred_ |
| shared/shared_doc1 | shared_doc1       |
| shared/sub/sub_doc | sub/sub_doc       |

Vanilla's every document under "kyouyuu" is synchronized with the top of the
shared vault:

| Vanilla                  | shared            |
| ------------------------ | ----------------- |
| documentA                | _Not transferred_ |
| documentB                | _Not transferred_ |
| kyouyuu/some_doc         | some_doc          |
| kyouyuu/sub/some_sub_doc | sub/some_sub_doc  |

Totally, all files are synchronized like this:

| Cornbread               | shared            | Vanilla                  |
| ----------------------- | ----------------- | ------------------------ |
| document1               | _Not transferred_ |                          |
| document2               | _Not transferred_ |                          |
|                         | _Not transferred_ | documentA                |
|                         | _Not transferred_ | documentB                |
| shared/shared_doc1      | shared_doc1       | kyouyuu/shared_doc1      |
| shared/some_doc         | some_doc          | kyouyuu/some_doc         |
| shared/sub/some_sub_doc | sub/some_sub_doc  | kyouyuu/sub/some_sub_doc |
| shared/sub/sub_doc      | sub/sub_doc       | kyouyuu/sub/sub_doc      |

... with the configuration below:

````jsonc
{
  "peers": [
    {
      "type": "couchdb", // Type should be `couchdb`, `bucket` or `storage`
      "name": "cornbread", // Should be unique
      "url": "http://localhost:5984",
      "database": "classroom_cornbread",
      "username": "cornbread",
      "password": "tackle",
      "passphrase": "glucose", // E2EE passphrase, if you do not enabled, leave it blank.
      "obfuscatePassphrase": "glucose", // Path obfuscation passphrase, if you do not enabled, leave it blank. if enabled, set the same value of passphrase.
      "customChunkSize": 100,
      "minimumChunkSize": 20,
      "baseDir": "shared/" // Sharing folder
    },
    {
      "type": "couchdb", // Type should be `couchdb`, `bucket` or `storage`
      "name": "shared", // Should be unique
      "url": "http://localhost:5984",
      "database": "classroom_shared",
      "username": "common_user",
      "password": "resu_nommoc",
      "passphrase": "cocoa", // E2EE passphrase, if you do not enabled, leave it blank.
      "obfuscatePassphrase": "cocoa", // Path obfuscation passphrase, if you do not enabled, leave it blank. if enabled, set the same value of passphrase.
      "customChunkSize": 100,
      "minimumChunkSize": 20,
      "baseDir": "" // Sharing folder
    },
    {
      "type": "couchdb",
      "name": "vanilla", // We can even synchronise the same databases as long as they have different names in here.
      "url": "http://localhost:5984",
      "database": "classroom_vanilla",
      "username": "vanilla",
      "password": "liberty",
      "passphrase": "smock",
      "obfuscatePassphrase": "smock",
      "customChunkSize": 100,
      "minimumChunkSize": 20,
      "baseDir": "kyouyuu/"
    },
    {
      "type": "storage",
      "name": "storage-test1",
      "baseDir": "./vault/" // The folder which have been synchronised.
    }
  ]
}
````
