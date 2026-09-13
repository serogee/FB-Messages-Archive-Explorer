import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const host = '127.0.0.1';
const port = 4173;
const server = await createServer({
  configFile: 'vite.config.ts',
  logLevel: 'error',
  server: { host, port, strictPort: true },
});

try {
  await server.listen();
  const playwright = spawn(
    process.execPath,
    ['./node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)],
    { cwd: process.cwd(), stdio: 'inherit' },
  );
  const exitCode = await new Promise((resolve, reject) => {
    playwright.once('error', reject);
    playwright.once('exit', code => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await server.close();
}
