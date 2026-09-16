// Type declarations for sql.js
declare module 'sql.js' {
  interface SqlJsDatabase {
    exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
    run(sql: string, params?: unknown[]): void;
    prepare(sql: string): SqlJsStatement;
    getRowsModified(): number;
    lastInsertRowid: number;
    close(): void;
  }

  interface SqlJsStatement {
    bind(params?: unknown[]): void;
    step(): boolean;
    get(): unknown[];
    getAsObject(): Record<string, unknown>;
    free(): void;
    reset(): void;
  }

  interface SqlJsModule {
    Database: { new (): SqlJsDatabase };
  }

  const createSqlJs: () => Promise<SqlJsModule>;
  export default createSqlJs;
}