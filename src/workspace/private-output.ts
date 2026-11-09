import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Publish complete private bytes without ever replacing an existing destination. */
export function writeNewPrivateFile(filename: string, bytes: Buffer): void {
  const destination = path.resolve(filename);
  const temporary = path.join(path.dirname(destination), `.corepilot-review-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); created = true;
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.linkSync(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('输出文件已存在，未覆盖；请选择新的文件名。');
    throw new Error('无法创建待审阅包；请检查输出目录权限和文件系统是否支持排他创建。');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) fs.unlinkSync(temporary);
  }
}
