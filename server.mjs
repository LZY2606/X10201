// 开发服务器：以 Vite 中间件模式启动，加载 SQLite API 插件。
// 用法：npm run dev -- --host 127.0.0.1 --port 5261 --strictPort
import { createServer } from 'vite';
import { apiPlugin } from './src/server/api.mjs';

function parseArg(name, fallback) {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  if (args.includes(`--${name}`)) return true;
  return fallback;
}

const host = parseArg('host', '127.0.0.1');
const port = Number(parseArg('port', '5261'));
const strictPort = process.argv.includes('--strictPort');

const server = await createServer({
  root: new URL('./src/web', import.meta.url).pathname,
  configFile: false,
  server: { host, port, strictPort },
  plugins: [apiPlugin()]
});

await server.listen();
server.printUrls();
