import { closeDatabase, countItems, countVectors, initDatabase } from '@bin/db';
import { loadConfig } from '../config.js';
import { createEmbedder, createMemoryVectors } from '../memory/vectors.js';

/**
 * 手动回填向量索引。
 *
 * 平时不需要跑：写入时同步算，服务启动也会自检补算。
 * 它的用处是——换嵌入模型、改了索引文本的拼法之后主动重建，
 * 以及怀疑向量索引状态不对时，用一条命令看清楚。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = initDatabase(config.dbFile);
  const vectors = createMemoryVectors(createEmbedder(config.embed));

  console.log(`[回填] 库: ${config.dbFile}`);
  console.log(`[回填] 条目 ${countItems(db)} 条，向量 ${countVectors(db)} 条`);

  if (!vectors.ready) {
    console.error('[回填] 未配置 EMBED_API_KEY，无法计算向量。请在 .env 里填好再跑。');
    closeDatabase();
    process.exitCode = 1;
    return;
  }

  console.log(`[回填] 嵌入模型: ${vectors.model}（${config.embed.dim} 维）`);

  const started = Date.now();
  const result = await vectors.backfill({ limit: 5000 });
  const elapsed = Date.now() - started;

  console.log(
    `[回填] 缺向量 ${result.scanned} 条 → 成功 ${result.embedded} 条，失败 ${result.failed} 条，耗时 ${elapsed}ms`,
  );
  console.log(`[回填] 现在库里向量共 ${countVectors(db)} 条`);

  closeDatabase();
}

main().catch((error) => {
  console.error('[回填] 失败:', error);
  process.exit(1);
});