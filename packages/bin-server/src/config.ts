import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// 本文件位于 packages/bin-server/src 或 packages/bin-server/dist，
// 往上三级即仓库根目录，.env 与 data/ 都以此为基准定位
const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '../../..');

dotenv.config({ path: path.join(projectRoot, '.env') });

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens?: number;
}

export interface EmbedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dim: number;
}

export interface Config {
  port: number;
  host: string;
  corsOrigin: string;
  dbFile: string;
  /** 前端构建产物目录，由服务端直接托管（手机只记一个地址，也就没有跨域问题） */
  webDist: string;
  llm: LlmConfig;
  embed: EmbedConfig;
}

function optionalNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function loadConfig(): Config {
  const llmBaseUrl = process.env.LLM_BASE_URL ?? '';
  const llmApiKey = process.env.LLM_API_KEY ?? '';

  return {
    port: Number(process.env.PORT ?? 3100),
    host: process.env.HOST ?? '0.0.0.0',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    dbFile: path.resolve(projectRoot, process.env.DB_FILE ?? './data/bin.db'),
    webDist: path.resolve(projectRoot, process.env.WEB_DIST ?? './apps/web/dist'),
    llm: {
      baseUrl: llmBaseUrl,
      apiKey: llmApiKey,
      model: process.env.LLM_MODEL ?? 'deepseek-v4-flash',
      temperature: optionalNumber(process.env.LLM_TEMPERATURE) ?? 0.3,
      maxTokens: optionalNumber(process.env.LLM_MAX_TOKENS),
    },
    // 嵌入模型**不回落**到对话模型配置：两者的厂商、端点、计费都是分开的，
    // 早期版本做了回落，结果是一把只能跑对话的套餐 key 被送去打嵌入接口，
    // 每次写入都 404 而没人知道为什么。宁可明确留空，由启动日志提示"语义检索已关闭"。
    // 端点本身留空时，由 Provider 用默认值（阿里云百炼 DashScope）兜底。
    embed: {
      baseUrl: process.env.EMBED_BASE_URL ?? '',
      apiKey: process.env.EMBED_API_KEY ?? '',
      model: process.env.EMBED_MODEL ?? 'text-embedding-v4',
      dim: optionalNumber(process.env.EMBED_DIM) ?? 1024,
    },
  };
}