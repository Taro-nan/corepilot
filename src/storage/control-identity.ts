import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isControlIdentityId, type ControlIdentity } from '../contracts/control-identity.js';

export const CONTROL_DATA_IDENTITY_FILE = '.corepilot-control-data-identity.json';
const unavailable = '无法核对控制端数据库与数据目录身份。请恢复原目录标识；若确为新目录，请由维护者按部署指南明确初始化。';

interface IdentityDatabase {
  readControlDatabaseIdentity(): string | null;
  initializeControlDatabaseIdentity(): string;
}

function readDataIdentity(filename: string): string | null {
  let contents: string;
  try { contents = fs.readFileSync(filename, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let value: unknown;
  try { value = JSON.parse(contents); } catch { throw new Error(unavailable); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(unavailable);
  const marker = value as { version?: unknown; data_root_id?: unknown };
  if (marker.version !== 1 || !isControlIdentityId(marker.data_root_id)) throw new Error(unavailable);
  return marker.data_root_id;
}

/** Publish complete bytes without replacing another process's marker. */
function initializeDataIdentity(filename: string): string {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const id = randomUUID();
  try {
    const file = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(file, JSON.stringify({ version: 1, data_root_id: id }) + '\n'); fs.fsyncSync(file); }
    finally { fs.closeSync(file); }
    try { fs.linkSync(temporary, filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const result = readDataIdentity(filename);
    if (!result) throw new Error(unavailable);
    return result;
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Control identity is independent of Runner and artifact identities. */
export class ControlIdentityGuard {
  private constructor(private readonly db: IdentityDatabase, private readonly marker: string, private readonly initial: ControlIdentity | null) {}

  static initialize(db: IdentityDatabase, dataDir: string, options: { initializeNewDataDir?: boolean } = {}): ControlIdentityGuard {
    const marker = path.join(path.resolve(dataDir), CONTROL_DATA_IDENTITY_FILE);
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
      const existingDb = db.readControlDatabaseIdentity();
      let dataRoot = readDataIdentity(marker);
      // An initialized DB cannot distinguish a lost marker from a new directory.
      if (!dataRoot && existingDb && !options.initializeNewDataDir) return new ControlIdentityGuard(db, marker, null);
      if (!dataRoot) dataRoot = initializeDataIdentity(marker);
      const database = existingDb ?? db.initializeControlDatabaseIdentity();
      return new ControlIdentityGuard(db, marker, { database_id: database, data_root_id: dataRoot });
    } catch { return new ControlIdentityGuard(db, marker, null); }
  }

  current(): ControlIdentity {
    if (!this.initial) throw new Error(unavailable);
    try {
      const database = this.db.readControlDatabaseIdentity();
      const dataRoot = readDataIdentity(this.marker);
      if (database !== this.initial.database_id || dataRoot !== this.initial.data_root_id) throw new Error(unavailable);
      return { ...this.initial };
    } catch { throw new Error(unavailable); }
  }
}
