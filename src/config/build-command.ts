import type { OptimizationConfig } from './optimization-config.js';

/** Commands run in the Linux execution workspace, using the existing build contract. */
export function commandBuild(command: string, previous: OptimizationConfig['build']): OptimizationConfig['build'] {
  return { ...previous, executable: command.trim() ? 'bash' : '', args: command.trim() ? ['-e', '-o', 'pipefail', '-c', command] : [] };
}
export function displayBuildCommand(build: OptimizationConfig['build']): string {
  if (!build.executable) return '';
  if (build.executable === 'bash' && build.args.length === 5 && build.args.slice(0, 4).join(' ') === '-e -o pipefail -c') return build.args[4];
  if (['bash', 'sh'].includes(build.executable) && ['-c', '-lc'].includes(build.args[0]) && build.args.length === 2) return build.args[1];
  const quote = (value: string) => /^[A-Za-z0-9_./:=+@%-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
  return [build.executable, ...build.args].map(quote).join(' ');
}

interface ShellWord { start: number; end: number; raw: string }

/** Only direct shell commands are rewritten; quoted scripts and heredocs remain user-owned. */
function directCommands(script: string): ShellWord[][] | null {
  if (script.includes('<<') || script.includes('`') || script.includes('$(')) return null;
  const commands: ShellWord[][] = [], words: ShellWord[] = [];
  const finish = () => { if (words.length) commands.push(words.splice(0)); };
  let i = 0;
  while (i < script.length) {
    if (script[i] === '\\' && /\r|\n/.test(script[i + 1] ?? '')) { i += script[i + 1] === '\r' ? 3 : 2; continue; }
    if (script[i] === '\n' || ';|&'.includes(script[i])) { finish(); i++; continue; }
    if (/\s/.test(script[i])) { i++; continue; }
    if (script[i] === '#') { while (i < script.length && script[i] !== '\n') i++; continue; }
    const start = i;
    let quote = '';
    while (i < script.length) {
      const c = script[i];
      if (!quote && (/\s/.test(c) || ';|&'.includes(c))) break;
      if (c === '\\' && quote !== "'") { i += 2; continue; }
      if (c === quote) quote = '';
      else if (!quote && (c === "'" || c === '"')) quote = c;
      i++;
    }
    if (quote) return null;
    words.push({ start, end: i, raw: script.slice(start, i) });
  }
  finish(); return commands;
}

function literalPath(raw: string): string | null {
  const value = /^(['"])[\s\S]*\1$/.test(raw) ? raw.slice(1, -1) : raw;
  if (!value || /[$`\\]/.test(value) || /^(?:\/|~|[A-Za-z]:)/.test(value)) return null;
  return value.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') || '.';
}

/** Isolate standard relative CMake build trees without changing compiler flags, targets or cwd. */
export function isolateCmakeBuildCommand(command: string, cwd = '.'): string {
  const commands = directCommands(command);
  if (!commands) return command;
  const edits = new Map<number, { end: number; text: string }>();
  const directories = new Map<string, string>();
  const add = (word: ShellWord, text: string) => edits.set(word.start, { end: word.end, text });
  const cmake = commands.filter(words => /^(?:[^\s'"$]+\/)?cmake$/.test(words[0].raw));
  for (const words of cmake) {
    if (words.some(word => /^--(?:build|install)$/.test(word.raw) || word.raw === '-P' || word.raw === '-E')) continue;
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      const separate = word.raw === '-B' || word.raw === '-S';
      const kind = word.raw.slice(0, 2);
      if (kind !== '-B' && kind !== '-S') continue;
      const argument = separate ? words[++i] : { ...word, start: word.start + 2, raw: word.raw.slice(2) };
      if (!argument) continue;
      const relative = literalPath(argument.raw);
      if (!relative) continue;
      if (kind === '-S') {
        if (relative === '.' && /^\.(?:\/)?$/.test(cwd)) add(argument, '"$COREPILOT_SOURCE_ROOT"');
      } else {
        if (!directories.has(relative)) directories.set(relative, directories.size === 0 ? '"$COREPILOT_BUILD_ROOT"' : `"$COREPILOT_BUILD_ROOT/tree-${directories.size + 1}"`);
        add(argument, directories.get(relative)!);
      }
    }
  }
  for (const words of cmake) {
    for (let i = 1; i < words.length - 1; i++) {
      if (!['--build', '--install'].includes(words[i].raw)) continue;
      const relative = literalPath(words[i + 1].raw);
      const destination = relative ? directories.get(relative) : undefined;
      if (destination) add(words[i + 1], destination);
    }
  }
  let result = command;
  for (const [start, edit] of [...edits].sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + edit.text + result.slice(edit.end);
  return result;
}

export function isolatedWorkspaceBuild(build: OptimizationConfig['build']): OptimizationConfig['build'] {
  const original = displayBuildCommand(build);
  const isolated = isolateCmakeBuildCommand(original, build.cwd);
  return isolated === original ? build : commandBuild(isolated, build);
}

/** Map a declared source-relative output into the CMake tree relocated for this run. */
export function isolatedCmakeArtifact(build: OptimizationConfig['build'], relativeArtifact: string): string | null {
  const commands = directCommands(displayBuildCommand(build));
  if (!commands) return null;
  const normalize = (value: string) => {
    const parts: string[] = [];
    for (const item of value.split('/')) { if (item === '..') parts.pop(); else if (item && item !== '.') parts.push(item); }
    return parts.join('/');
  };
  const directories = new Map<string, string>();
  for (const words of commands) {
    if (!/^(?:[^\s'"$]+\/)?cmake$/.test(words[0].raw) || words.some(word => /^--(?:build|install)$/.test(word.raw) || word.raw === '-P' || word.raw === '-E')) continue;
    for (let i = 1; i < words.length; i++) {
      if (!words[i].raw.startsWith('-B')) continue;
      const argument = words[i].raw === '-B' ? words[++i]?.raw : words[i].raw.slice(2);
      const directory = argument ? literalPath(argument) : null;
      if (directory && !directories.has(directory)) directories.set(directory, directories.size === 0 ? '' : `tree-${directories.size + 1}/`);
    }
  }
  const artifact = normalize(relativeArtifact);
  for (const [directory, target] of directories) {
    const prefix = normalize(`${build.cwd}/${directory}`);
    if (artifact.startsWith(prefix + '/')) return target + artifact.slice(prefix.length + 1);
  }
  return null;
}
