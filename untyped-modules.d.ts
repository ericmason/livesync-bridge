// Minimal declarations for npm packages that ship no types.
declare module "pouchdb-adapter-leveldb-core" {
    const CoreLevelPouch: any;
    export default CoreLevelPouch;
}
declare module "leveldown" {
    const leveldown: any;
    export default leveldown;
}
declare module "pouchdb-adapter-memory" {
    const memoryAdapter: any;
    export default memoryAdapter;
}
