import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const varsFile = new URL('../.dev.vars', import.meta.url);
const binding = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_ASTRO_DB';
let local = {};
try {
  if (existsSync(varsFile)) local = parseEnv(readFileSync(varsFile, 'utf8'));
} catch {
  console.error('Não foi possível ler .dev.vars. Confira o formato das variáveis.');
  process.exit(1);
}

const env = { ...process.env };
if (!env[binding] && local[binding]?.trim()) env[binding] = local[binding];
if (!env[binding]) {
  console.warn('Conexão local do Astro pendente: preencha a variável Hyperdrive em .dev.vars.');
}

const child = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
  'dev', ...process.argv.slice(2),
], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', () => {
  console.error('Não foi possível iniciar o Wrangler. Execute npm ci --ignore-scripts.');
  process.exitCode = 1;
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { child.kill(signal); });
}
