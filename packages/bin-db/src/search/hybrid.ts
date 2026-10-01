import type { SearchHit } from './index.js';

export type MatchSource = 'keyword' | 'semantic';

export interface RankedList {
  source: MatchSource;
  hits: SearchHit[];
}

export interface FusedHit {
  objId: string;
  objKind: string;
  score: number;
  /** 这条结果是被哪几路召回的，便于排查「为什么它排这么前」 */
  sources: MatchSource[];
}

/**
 * RRF（Reciprocal Rank Fusion）融合两路检索结果。
 *
 * 为什么不把两路的分数加权平均：FTS 的 bm25 是负数、余弦相似度是 -1~1，
 * 量纲完全不同，要加权就得先归一化，而归一化系数只能靠试——换个查询就失效。
 * RRF 只看名次不看分数，天然免调参，是混合检索里的常规做法。
 *
 * k 取 60（原论文经验值）：它的作用是压低头部名次的差距——
 * k 越小，第 1 名与第 2 名的分差越大，融合结果越偏向某一路的榜首；
 * k 越大，两路的名次越接近等权。60 是「既尊重榜首、又不让单路主导」的折中。
 */
export function fuseRanked(
  lists: RankedList[],
  options: { k?: number; limit?: number } = {},
): FusedHit[] {
  const k = options.k ?? 60;
  const table = new Map<string, FusedHit>();

  for (const list of lists) {
    list.hits.forEach((hit, index) => {
      const key = `${hit.objKind}:${hit.objId}`;
      const entry = table.get(key) ?? { objId: hit.objId, objKind: hit.objKind, score: 0, sources: [] };
      entry.score += 1 / (k + index + 1);
      if (!entry.sources.includes(list.source)) entry.sources.push(list.source);
      table.set(key, entry);
    });
  }

  return [...table.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 30);
}