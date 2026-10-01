import OpenAI from 'openai';

/** 初始化嵌入 Provider 需要的配置 */
export interface EmbeddingProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  /** 期望的向量维度。显式指定，避免换模型后维度对不上却毫无察觉 */
  dimensions?: number;
  /** 单次请求最多带几条文本。厂商限制不一，默认 10（阿里云百炼的上限） */
  batchSize?: number;
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'text-embedding-v4';
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_RETRIES = 2;

/**
 * 单条文本的字符上限。
 *
 * 不截断的后果是整批失败：厂商按 token 上限处理超长输入时可能直接返回 400，
 * 而一批里只要有一条超长，同批其它条也拿不到向量。
 * M3 接入长文档后这个上限会真正被撞到，所以现在就设好。
 */
const MAX_CHARS = 4000;

/**
 * 通用 OpenAI 兼容嵌入 Provider。
 *
 * 与对话 Provider 分开成两个类：两者的参数、返回结构、失败模式都不一样
 * （对话是流式长连接，嵌入是短请求批量），塞进一个类只会互相污染。
 */
export class OpenAICompatibleEmbeddingProvider {
  readonly name: string;

  /** 实际使用的模型名，仓储层把它写进 vec_index.model，换模型后旧向量自然失效 */
  readonly model: string;

  private readonly client: OpenAI;

  private readonly dimensions?: number;

  private readonly batchSize: number;

  constructor(config: EmbeddingProviderConfig & { name?: string }) {
    this.name = config.name ?? 'embedding';
    this.model = config.defaultModel ?? DEFAULT_MODEL;
    this.dimensions = config.dimensions;
    this.batchSize = Math.max(1, config.batchSize ?? 10);

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl ?? DEFAULT_BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
  }

  get expectedDimensions(): number | undefined {
    return this.dimensions;
  }

  /**
   * 批量求向量。
   * 内部按 batchSize 切片，调用方给多少条都行，返回顺序与入参一一对应。
   */
  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize).map(clip);

      try {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: batch,
          // 不传 dimensions 时由模型给默认维度，这里只在配置了才传
          ...(this.dimensions ? { dimensions: this.dimensions } : {}),
        });

        // 不假设返回顺序与入参一致，按 index 重新排好
        const ordered = [...response.data].sort((a, b) => a.index - b.index);
        results.push(...ordered.map((row) => row.embedding as number[]));
      } catch (error) {
        console.error(`[${this.name}] 嵌入失败（model=${this.model}, 本批 ${batch.length} 条）:`, error);
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    return results;
  }

  /** 单条求向量，检索时用 */
  async embedOne(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    if (!vector || vector.length === 0) {
      throw new Error(`${this.name}: 嵌入返回为空`);
    }
    return vector;
  }
}

function clip(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > MAX_CHARS ? normalized.slice(0, MAX_CHARS) : normalized;
}