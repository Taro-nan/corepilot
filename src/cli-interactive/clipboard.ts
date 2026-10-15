import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Read the system clipboard for terminals that send Ctrl+V as a control byte. */
export async function readClipboardText(): Promise<string> {
  const command = process.platform === 'win32'
    ? { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'] }
    : process.platform === 'darwin'
      ? { file: 'pbpaste', args: [] }
      : { file: 'xclip', args: ['-selection', 'clipboard', '-o'] };
  try {
    const result = await execFileAsync(command.file, command.args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    throw new Error(`无法读取系统剪贴板：${(error as Error).message}`);
  }
}
