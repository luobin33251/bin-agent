import path from 'node:path';
import { OpenAICompatibleProvider } from '@bin/ai';
import { Agent } from '@bin/core';
import { closeDatabase, initDatabase, listAppliedMigrations } from '@bin/db';
import { createApp, isWebServed } from './app.js';
import { loadConfig, projectRoot } from './config.js';
import { createEmbedder, createMemoryVectors } from './memory/vectors.js';
import { buildSystemPrompt } from './prompts/base.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerVaultRoutes } from './routes/vault.js';
import { createCorrectMemoryTool } from './tools/correct-memory.js';
import { createDeleteMemoryTool } from './tools/delete-memory.js';
import { createMergeMemoryTool } from './tools/merge-memory.js';
import { createRestoreMemoryTool } from './tools/restore-memory.js';
import { createSaveMemoryTool } from './tools/save-memory.js';
import { createSearchMemoryTool } from './tools/search-memory.js';

async function start(): Promise<void> {
  const config = loadConfig();

  // 1. 数据层：打开 SQLite 并跑迁移
  const db = initDatabase(config.dbFile);
  console.log(`[DB] 就绪: ${config.dbFile}`);
  console.log(`[DB] 已应用迁移: ${listAppliedMigrations(db).join(', ') || '(无)'}`);

  // 2. LLM Provider
  const provider = new OpenAICompatibleProvider({
    name: 'llm',
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    defaultModel: config.llm.model,
  });

  // 3. 嵌入 Provider + 向量索引器
  const vectors = createMemoryVectors(createEmbedder(config.embed));
  if (vectors.ready) {
    console.log(`[向量] 已启用语义检索: ${config.embed.model}（${config.embed.dim} 维）`);
  } else {
    console.warn('[向量] 未配置 EMBED_API_KEY，语义检索关闭，检索退化为纯关键词');
  }

  // 4. Agent
  const agent = new Agent(provider, {
    // 这里只是兜底；每次请求路由会重新现算，以带上当前的日期
    systemPrompt: buildSystemPrompt(),
    temperature: config.llm.temperature,
    maxTokens: config.llm.maxTokens,
  });
  agent.registerTool(createSearchMemoryTool({ vectors }));
  agent.registerTool(createSaveMemoryTool({ vectors }));
  agent.registerTool(createCorrectMemoryTool({ vectors }));
  agent.registerTool(createMergeMemoryTool({ vectors }));
  agent.registerTool(createDeleteMemoryTool());
  agent.registerTool(createRestoreMemoryTool({ vectors }));
  console.log(`[Agent] 已注册工具: ${agent.getRegisteredToolNames().join(', ') || '(无)'}`);

  // 5. Web 服务
  const app = await createApp(config, { config });
  registerChatRoutes(app, agent, config);
  registerVaultRoutes(app);

  await app.listen({ port: config.port, host: config.host });
  console.log(`[Server] 已启动: http://localhost:${config.port}`);

  // 手机访问走的就是这一个地址：前端产物已由本服务托管
  if (isWebServed(config)) {
    console.log(`[Web] 前端已托管: ${path.relative(projectRoot, config.webDist)}（手机访问用本机内网 IP + 上面的端口）`);
  } else {
    console.warn('[Web] 未找到前端构建产物，只提供接口。先跑 pnpm build:web 再启动即可单端口访问');
  }

  // 6. 启动自检：补齐漏算的向量（后台跑，失败不影响服务可用）
  if (vectors.ready) {
    void vectors
      .backfill()
      .then(({ scanned, embedded, failed }) => {
        if (scanned === 0) return;
        const tail = failed > 0 ? `，${failed} 条失败（下次启动会重试）` : '';
        console.log(`[向量] 启动自检：补算 ${embedded}/${scanned} 条${tail}`);
      })
      .catch((error) => console.warn('[向量] 启动自检失败:', error));
  }

  const shutdown = async () => {
    await app.close();
    closeDatabase();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('[Server] 启动失败:', error);
  process.exit(1);
});