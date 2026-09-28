// Cross-platform helpers for the AI service's Python virtual environment.
import { existsSync } from 'node:fs';
import path from 'node:path';

export const aiServiceDir = path.resolve(import.meta.dirname, '..', 'ai-service');

export const venvPython =
  process.platform === 'win32'
    ? path.join(aiServiceDir, '.venv', 'Scripts', 'python.exe')
    : path.join(aiServiceDir, '.venv', 'bin', 'python');

export function requireVenv() {
  if (!existsSync(venvPython)) {
    console.error('AI service virtualenv not found. Run `npm run setup` first.');
    process.exit(1);
  }
}
