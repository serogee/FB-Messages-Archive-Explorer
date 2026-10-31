import { spawn } from 'node:child_process';
import { createServer, preview } from 'vite';

const host = '127.0.0.1';
const port = 4173;
const args = process.argv.slice(2);
const development = args.includes('--dev');
const settings = {
  configFile: 'vite.config.ts',
  logLevel: 'error',
};
// npm run test:e2e builds first; CI also builds before invoking this runner.
const server = development
  ? await createServer({ ...settings, server: { host, port, strictPort: true } })
  : await preview({ ...settings, preview: { host, port, strictPort: true } });

try {
  if (development) await server.listen();
  const playwright = spawn(
    process.execPath,
    ['./node_modules/@playwright/test/cli.js', 'test', ...args.filter(arg => arg !== '--dev')],
    { cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, E2E_PRODUCTION: development ? '' : '1' } },
  );
  const exitCode = await new Promise((resolve, reject) => {
    playwright.once('error', reject);
    playwright.once('exit', code => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  if (development) await server.close();
  else await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
