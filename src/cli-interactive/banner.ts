import { VERSION } from '../version.js';
import { buildLogo } from './homepage.js';

export const BANNER_LINES: readonly string[] = [
  '',
  ...buildLogo().map(line => '  ' + line),
  '',
];

export function bannerText(): string {
  return [...BANNER_LINES, `  CorePilot v${VERSION}`, ''].join('\n');
}
