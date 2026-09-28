// Creates ai-service/.venv (if missing) and installs requirements.txt into it.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { aiServiceDir, venvPython } from './python.mjs';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: aiServiceDir, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(venvPython)) {
  const systemPython = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  console.log(`Creating virtualenv with ${systemPython}…`);
  run(systemPython, ['-m', 'venv', '.venv']);
}

run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
run(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
