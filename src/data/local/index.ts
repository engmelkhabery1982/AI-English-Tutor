/**
 * src/data/local/index.ts
 *
 * Local persistence placeholders.
 *
 * The MVP will use SQLite. The persistence layer is intentionally
 * abstracted behind the repository interfaces in src/repositories.
 *
 * This file defines the DB bootstrap contract only. No SQLite
 * implementation is included at this stage.
 */

/** Database adapter contract. */
export interface LocalDatabase {
  readonly adapter: 'sqlite' | 'memory' | 'other';
  init(): Promise<void>;
  close(): Promise<void>;
  readonly connected: boolean;
}

/** Factory signature for creating the local database. */
export type LocalDatabaseFactory = () => LocalDatabase;