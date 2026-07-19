// Registers a persistent local "leveldb" adapter on the shared PouchDB build.
//
// pouchdb-adapter-leveldb cannot be used directly: it hard-depends on
// leveldown@5, whose prebuilt binaries predate the N-API multi-arch layout and
// fail to load under Deno ("No native build was found"). leveldown@6 ships
// universal darwin/linux N-API prebuilds that Deno loads fine, so we wire it
// into pouchdb-adapter-leveldb-core ourselves — exactly what
// pouchdb-adapter-leveldb does, minus the pinned leveldown.
/// <reference path="./untyped-modules.d.ts" />
import { PouchDB } from "./lib/src/pouchdb/pouchdb-http.ts";
import CoreLevelPouch from "pouchdb-adapter-leveldb-core";
import leveldown from "leveldown";

function LevelDbPouch(this: any, opts: any, callback: any) {
    return (CoreLevelPouch as any).call(this, { db: leveldown, ...opts }, callback);
}
(LevelDbPouch as any).valid = () => true;
(LevelDbPouch as any).use_prefix = false;
(PouchDB as any).adapter("leveldb", LevelDbPouch, true);

export { PouchDB };
