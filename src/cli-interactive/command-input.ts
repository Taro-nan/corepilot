/** Tokenize workbench commands without a shell; preserve Windows paths. */
export function parseWorkbenchInput(input: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '\\' && quote === '"' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
      token += input[++i]; started = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char; started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = ''; started = false;
    } else { token += char; started = true; }
  }
  if (quote) throw new Error('命令中存在未闭合的引号。');
  if (started) tokens.push(token);
  return tokens;
}
