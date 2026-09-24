export { openDb, schemaSql, SCHEMA_VERSION } from './db.ts';
export { discoverLocal, writeDiscoverToDb } from './discover.ts';
export type { DiscoverDep, DiscoverModel, DiscoverPackage, DiscoverRepo } from './discover.ts';
export { runWitness } from './witness.ts';
export type { RunWitnessOptions, WitnessCounts, WitnessDiscoverInput } from './witness.ts';
