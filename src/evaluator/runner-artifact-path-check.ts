import path from 'node:path';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fileId = (value: unknown): value is { device: string; inode: string } => object(value) &&
  typeof value.device === 'string' && /^\d+$/.test(value.device) && typeof value.inode === 'string' && /^\d+$/.test(value.inode);
const absolute = (value: unknown): value is string => typeof value === 'string' && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
const samePath = (left: string, right: string): boolean => {
  const api = /^[a-z]:[\\/]/i.test(right) || right.includes('\\') ? path.win32 : path.posix;
  return api.resolve(left) === api.resolve(right);
};

/** Validate a Runner's retained file-identity check, not the evaluator's claim that it called a symbol. */
export function runnerArtifactPathCheckMatches(identity: unknown, check: unknown, api: string, expectedPath?: string): boolean {
  if (!object(identity) || !object(check) || !absolute(check.planned_path) || !absolute(check.input_realpath) || !fileId(check.input_file_id) ||
      expectedPath !== undefined && (!absolute(expectedPath) || !samePath(check.planned_path, expectedPath))) return false;
  const inputId = check.input_file_id, inputRealpath = check.input_realpath;
  const apiKey = `resolved_${api.replace(/[^A-Za-z0-9_]/g, '_')}_path`;
  const resolvedFields = ['resolved_symbol_path', apiKey].filter((key, index, fields) => fields.indexOf(key) === index && Object.hasOwn(identity, key));
  if (!resolvedFields.length) return false;
  const fields = [...(Object.hasOwn(identity, 'input_path') ? ['input_path'] : []), ...resolvedFields];
  if (!Array.isArray(check.reported_paths) || check.reported_paths.length !== fields.length) return false;
  const reportedPaths: unknown[] = check.reported_paths;
  return fields.every(field => absolute(identity[field]) && reportedPaths.some(entry => {
    if (!object(entry) || entry.field !== field || entry.path !== identity[field] || !absolute(entry.realpath) || !fileId(entry.file_id)) return false;
    const comparable = entry.file_id.device !== '0' && entry.file_id.inode !== '0' && inputId.device !== '0' && inputId.inode !== '0';
    return comparable ? entry.file_id.device === inputId.device && entry.file_id.inode === inputId.inode : samePath(entry.realpath, inputRealpath);
  }));
}
