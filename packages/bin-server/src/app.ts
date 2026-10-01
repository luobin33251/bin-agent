import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';

export interface AppContext {
  config: Config;
}

export async function createApp(config: Config, _context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: config.corsOrigin });

  app.get('/health', async () => ({ status: 'ok' }));

  /**
   * 托管前端构建产物。
   *
   * 为什么要由后端托管，而不是继续用 Vite dev server：
   * 手机访问时记两个地址（5173 + 3100）既麻烦又绕不开跨域；单端口之后
   * `http://<你的电脑>:3100` 就是全部入口。
   * 没构建过（找不到 index.html）时不注册，服务照常起——本地开发仍然走 Vite。
   */
  const indexFile = path.join(config.webDist, 'index.html');
  const hasWeb = fs.existsSync(indexFile);

  if (hasWeb) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });

    /**
     * SPA 兜底：前端只有一页，任何非 /api 的路径都回 index.html，
     * 否则刷新 `/anything` 会 404。
     * /api 必须显式排除，不然打错的接口会返回一坨 HTML，排查时更费劲。
     */
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: `接口不存在: ${request.method} ${request.url}` });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return reply.status(404).send({ error: '不支持的请求方法' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    reply.status(error.statusCode ?? 500).send({ error: error.message ?? '内部服务器错误' });
  });

  return app;
}

export function isWebServed(config: Config): boolean {
  return fs.existsSync(path.join(config.webDist, 'index.html'));
}