import type { Db } from '../client.js';
import type { IndexKind } from './index.js';

export interface VectorHit {
  objId: string;
  objKind: string;
  /** 余弦相似度，取值 -1 ~ 1，越大越相近 */
  score: number;
}

export interface UpsertVectorInput {
  objId: string;
  objKind: IndexKind;
  model: string;
  embedding: readonly number[];
}

/**
 * float32 数组 → BLOB。
 *
 * 存 Float32 而不是 JSON 文本：1024 维的 JSON 大约 20KB，BLOB 只要 4KB，
 * 而且读出来不用 JSON.parse，几千条全量算相似度时才不会卡。
 */
export function encodeVector(values: readonly number[]): Buffer {
  const typed = Float32Array.from(values);
  return Buffer.from(typed.buffer.slice(0));
}

/**
 * BLOB → float32 数组。
 *
 * 必须拷一份：better-sqlite3 返回的 Buffer 有时是共享内存的视图，
 * 直接在上面建 Float32Array 会随下次查询被改写，于是算出莫名其妙的相似度。
 */
export function decodeVector(blob: Buffer | Uint8Array): Float32Array {
  const source = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return new Float32Array(copy.buffer);
}

export function upsertVector(db: Db, input: UpsertVectorInput): void {
  db.prepare(
    `INSERT INTO vec_index (obj_id, obj_kind, model, dim, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (obj_id, obj_kind, model)
     DO UPDATE SET dim = excluded.dim, embedding = excluded.embedding, updated_at = excluded.updated_at`,
  ).run(
    input.objId,
    input.objKind,
    input.model,
    input.embedding.length,
    encodeVector(input.embedding),
    Date.now(),
  );
}

export function removeVector(db: Db, objId: string, objKind?: IndexKind, model?: string): void {
  const conditions = ['obj_id = ?'];
  const params: unknown[] = [objId];
  if (objKind) {
    conditions.push('obj_kind = ?');
    params.push(objKind);
  }
  if (model) {
    conditions.push('model = ?');
    params.push(model);
  }
  db.prepare(`DELETE FROM vec_index WHERE ${conditions.join(' AND ')}`).run(...params);
}

export function countVectors(db: Db, model?: string): number {
  const row = model
    ? (db.prepare('SELECT COUNT(*) AS c FROM vec_index WHERE model = ?').get(model) as { c: number })
    : (db.prepare('SELECT COUNT(*) AS c FROM vec_index').get() as { c: number });
  return row.c;
}

/**
 * 找出「还缺当前模型向量」的存活条目。
 *
 * 这是自愈机制的依据：写入时算向量是异步 HTTP 调用，可能失败（网络、限流、超时），
 * 失败不该影响落库，但也不能让这条记录永远检索不到——服务启动时按这个列表补齐。
 */
export function listUnindexedItemIds(db: Db, model: string, limit = 500): string[] {
  const rows = db
    .prepare(
      `SELECT i.id AS id
         FROM items i
         LEFT JOIN vec_index v
           ON v.obj_id = i.id AND v.obj_kind = 'item' AND v.model = ?
        WHERE i.deleted_at IS NULL AND v.obj_id IS NULL
        ORDER BY i.updated_at DESC
        LIMIT ?`,
    )
    .all(model, limit) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export interface SearchVectorsOptions {
  model: string;
  kind?: IndexKind;
  limit?: number;
  /**
   * 相似度下限，低于它的直接丢掉。
   * 语义检索总是能返回「最像的几条」，哪怕全是无关内容——没有下限，
   * 一次无关提问也必然挤进融合结果的前几名，把关键词命中的正确条目挤下去。
   *
   * 0.4 是实测出来的，不是拍的。用 qwen3.7-text-embedding 在真实数据上量过：
   * 真正相关的（换个说法的模糊提问）落在 0.68~0.83，
   * 同一语境但无关的（都是工作事务）落在 0.30~0.41。
   * 最初的 0.2 等于没设下限：问「上次那个空调的事」时库里根本没有空调记录，
   * 却照样返回了三条 0.23~0.33 的记录，模型很可能就着这些硬答。
   */
  minScore?: number;
}

/**
 * 向量检索：全量暴力算余弦。
 *
 * 不引入 sqlite-vec：个人库规模在几千到几万条，1024 维在 Node 里全量算
 * 是几十毫秒的事；而 sqlite-vec 是按平台编译的原生扩展，在 Windows 上
 * 部署麻烦得很。量真涨上来了，换掉这个函数的实现即可，调用方不用动。
 */
export function searchVectors(
  db: Db,
  query: readonly number[],
  options: SearchVectorsOptions,
): VectorHit[] {
  if (query.length === 0) return [];

  const queryVector = Float32Array.from(query);
  const queryNorm = norm(queryVector);
  if (queryNorm === 0) return [];

  const minScore = options.minScore ?? 0.4;
  const kindClause = options.kind ? 'AND obj_kind = ?' : '';
  const params: unknown[] = [options.model];
  if (options.kind) params.push(options.kind);

  const rows = db
    .prepare(`SELECT obj_id AS objId, obj_kind AS objKind, embedding FROM vec_index WHERE model = ? ${kindClause}`)
    .all(...params) as Array<{ objId: string; objKind: string; embedding: Buffer }>;

  const hits: VectorHit[] = [];

  for (const row of rows) {
    const vector = decodeVector(row.embedding);
    // 维度对不上说明是别的模型/维度留下的残留，跳过而不是报错
    if (vector.length !== queryVector.length) continue;

    const score = cosine(queryVector, queryNorm, vector);
    if (score < minScore) continue;
    hits.push({ objId: row.objId, objKind: row.objKind, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, options.limit ?? 20);
}

function norm(vector: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  return Math.sqrt(sum);
}

function cosine(left: Float32Array, leftNorm: number, right: Float32Array): number {
  let dot = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    rightNorm += right[i] * right[i];
  }
  const denominator = leftNorm * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}