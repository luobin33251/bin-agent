import { OpenAICompatibleEmbeddingProvider } from '@bin/ai';
import { getDatabase, getItemIndexText, listUnindexedItemIds, upsertVector } from '@bin/db';
import type { EmbedConfig } from '../config.js';

/**
 * 按配置造嵌入 Provider。没配 Key 就返回 null——这不是错误状态，
 * 而是「语义检索关闭，只用关键词」的正常降级，服务照常可用。
 */
export function createEmbedder(config: EmbedConfig): OpenAICompatibleEmbeddingProvider | null {
  if (!config.apiKey) return null;

  return new OpenAICompatibleEmbeddingProvider({
    name: 'embedding',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl || undefined,
    defaultModel: config.model,
    dimensions: config.dim,
  });
}

export interface BackfillResult {
  /** 本次扫描到「缺向量」的条目数 */
  scanned: number;
  embedded: number;
  failed: number;
}

export interface MemoryVectors {
  /** 是否具备语义检索能力。没配嵌入 Key 时为 false，检索自动退化成纯关键词 */
  readonly ready: boolean;
  readonly model: string;
  /** 给单条条目补算向量，失败返回 false（不影响落库，等自检重试） */
  indexItem(itemId: string): Promise<boolean>;
  /** 给查询文本求向量，失败返回 null */
  embedQuery(text: string): Promise<number[] | null>;
  /** 补齐所有缺向量的条目，返回补齐结果 */
  backfill(options?: { limit?: number }): Promise<BackfillResult>;
}

/**
 * 记忆的向量索引器。
 *
 * 为什么需要它，而不是在写入工具里直接调嵌入接口：
 * 「算向量」这件事发生在四个地方（新增、纠正、合并、恢复），
 * 而且每处都要遵守同一套规矩——失败不能影响落库、模型名要一致、
 * 文本要和 FTS 索引用的是同一份。分散在四个工具里，迟早会漏一处。
 */
export function createMemoryVectors(
  embedder: OpenAICompatibleEmbeddingProvider | null,
): MemoryVectors {
  const model = embedder?.model ?? '';
  const ready = embedder !== null;

  return {
    ready,
    model,

    async indexItem(itemId: string): Promise<boolean> {
      if (!embedder) return false;

      const db = getDatabase();
      const text = getItemIndexText(db, itemId);
      if (!text) return false;

      try {
        const [vector] = await embedder.embed([text]);
        if (!vector || vector.length === 0) return false;
        upsertVector(db, { objId: itemId, objKind: 'item', model, embedding: vector });
        return true;
      } catch (error) {
        // 落库已经完成，这里失败只意味着「暂时只能靠关键词找到它」，
        // 不该把整次写入变成失败——用户会以为信息没存进去
        console.warn(`[向量] 条目 ${itemId} 嵌入失败，留给启动自检重试:`, message(error));
        return false;
      }
    },

    async embedQuery(text: string): Promise<number[] | null> {
      if (!embedder) return null;
      const trimmed = text.trim();
      if (!trimmed) return null;

      try {
        return await embedder.embedOne(trimmed);
      } catch (error) {
        console.warn('[向量] 查询嵌入失败，本次退化为纯关键词检索:', message(error));
        return null;
      }
    },

    async backfill(options: { limit?: number } = {}): Promise<BackfillResult> {
      if (!embedder) return { scanned: 0, embedded: 0, failed: 0 };

      const db = getDatabase();
      const ids = listUnindexedItemIds(db, model, options.limit ?? 500);
      if (ids.length === 0) return { scanned: 0, embedded: 0, failed: 0 };

      const pending = ids
        .map((id) => ({ id, text: getItemIndexText(db, id) }))
        .filter((row): row is { id: string; text: string } => Boolean(row.text));

      let embedded = 0;
      // 取不到文本的（恰好在这一刻被删掉）也算失败，会留在下次自检的名单里
      let failed = ids.length - pending.length;

      // 分批而不是一次性全送去：嵌入接口按条数限流，几十条一批失败一次就整批白跑
      const chunkSize = 20;
      for (let start = 0; start < pending.length; start += chunkSize) {
        const chunk = pending.slice(start, start + chunkSize);
        try {
          const vectors = await embedder.embed(chunk.map((row) => row.text));
          let written = 0;
          chunk.forEach((row, index) => {
            const vector = vectors[index];
            if (!vector || vector.length === 0) return;
            upsertVector(db, { objId: row.id, objKind: 'item', model, embedding: vector });
            written += 1;
          });
          embedded += written;
          failed += chunk.length - written;
        } catch (error) {
          failed += chunk.length;
          console.warn(`[向量] 回填第 ${start + 1}~${start + chunk.length} 条失败:`, message(error));
        }
      }

      return { scanned: ids.length, embedded, failed };
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}