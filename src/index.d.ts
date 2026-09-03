export interface InValue {
  toString(): string;
}

export type InArgs = InValue[] | Record<string, InValue> | undefined;

export interface InStatement {
  sql: string;
  args?: InValue[] | Record<string, InValue>;
}

export interface Row {
  [columnName: string]: any;
  length: never;
}

export interface ResultSet {
  rows: Row[];
  columns: string[];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
  toJSON(): any;
}

export interface Transaction {
  execute(stmt: string | InStatement): Promise<ResultSet>;
  commit(): Promise<ResultSet>;
  rollback(): Promise<ResultSet>;
  close(): void;
}

export interface Client {
  execute(stmt: string | InStatement): Promise<ResultSet>;
  batch(stmts: Array<string | InStatement>): Promise<ResultSet[]>;
  transaction(mode?: 'deferred' | 'write' | 'read'): Promise<Transaction>;
  sync(): Promise<void>;
  close(): void;
  closed: boolean;
  protocol: string;
}

export interface Config {
  url?: string;
  debug?: boolean;
  snapshotIntervalMs?: number;
}

export function createClient(config?: Config): Client;
export default { createClient };
