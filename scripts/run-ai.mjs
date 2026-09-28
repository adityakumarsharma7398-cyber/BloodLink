// Runs a command with the AI service's virtualenv Python, e.g. `node scripts/run-ai.mjs dev`.
import { spawn } from 'node:child_process';
import { aiServiceDir, requireVenv, venvPython } from './python.mjs';

const commands = {
  dev: ['-m', 'uvicorn', 'app.main:app', '--reload', '--port', process.env.AI_SERVICE_PORT ?? '8000'],
  start: ['-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', process.env.AI_SERVICE_PORT ?? '8000'],
  test: ['-m', 'pytest', '-q'],
};

const mode = process.argv[2];
if (!(mode in commands)) {
  console.error(`Usage: node scripts/run-ai.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}

requireVenv();
const child = spawn(venvPython, commands[mode], { cwd: aiServiceDir, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
