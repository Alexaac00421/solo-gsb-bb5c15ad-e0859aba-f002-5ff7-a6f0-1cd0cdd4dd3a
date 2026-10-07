// 标记迁移分析（纯函数，可独立测试）
// 规则：
//   - 仅在“同名场”内做连续行文本序列的精确匹配；不跨场猜测归属。
//   - 同一场内文本连续且【唯一】匹配 => 自动迁移 (active)。
//   - 同名场存在多处匹配 => 待核 duplicate，候选全部列出由用户选择。
//   - 同名场无匹配，但其它场有匹配 => 待核 moved（疑似跨场移动，不自动跟随）。
//   - 任何地方都无匹配 => 待核 deleted_or_edited（删除或文本被改动）。
import type { MatchCandidate, MigrationPlan } from './types.js';

export interface SourceMarkInput {
  id: number;
  sceneName: string;
  startLine: number; // 1-based
  endLine: number; // 1-based
}

export interface NewSceneInput {
  id: number;
  ord: number;
  name: string;
  lines: string[];
}

/** 在一场的文本中找出 needle 连续块的全部出现位置（1-based 起、止行号） */
function findOccurrences(haystack: string[], needle: string[]): Array<[number, number]> {
  const hits: Array<[number, number]> = [];
  if (needle.length === 0 || haystack.length < needle.length) return hits;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push([i + 1, i + needle.length]);
  }
  return hits;
}

export function planMigrations(
  marks: SourceMarkInput[],
  sourceSceneLines: Map<string, string[]>,
  newScenes: NewSceneInput[],
): MigrationPlan[] {
  const plans: MigrationPlan[] = [];

  for (const mark of marks) {
    const sourceLines = sourceSceneLines.get(mark.sceneName) ?? [];
    // 源行文本（基准版，越界时截断，理论上数据已校验）
    const needle = sourceLines.slice(mark.startLine - 1, mark.endLine);

    const sameNameCandidates: MatchCandidate[] = [];
    const otherCandidates: MatchCandidate[] = [];

    for (const scene of newScenes) {
      const hits = findOccurrences(scene.lines, needle);
      for (const [start, end] of hits) {
        const candidate: MatchCandidate = {
          sceneId: scene.id,
          sceneName: scene.name,
          startLine: start,
          endLine: end,
          sameScene: scene.name === mark.sceneName,
        };
        if (candidate.sameScene) sameNameCandidates.push(candidate);
        else otherCandidates.push(candidate);
      }
    }

    const plan: MigrationPlan = {
      markId: mark.id,
      status: 'pending',
      candidates: [],
      sourceSceneName: mark.sceneName,
      sourceStartLine: mark.startLine,
      sourceEndLine: mark.endLine,
    };

    if (sameNameCandidates.length === 1) {
      // 同场内连续且唯一精确匹配 => 自动迁移
      const c = sameNameCandidates[0];
      plan.status = 'active';
      plan.targetSceneId = c.sceneId;
      plan.targetStartLine = c.startLine;
      plan.targetEndLine = c.endLine;
      // 同名场唯一即定案，跨场的其它出现不再展示，避免诱导跨场猜测
    } else if (sameNameCandidates.length > 1) {
      // 同场重复匹配 => 不猜测
      plan.status = 'pending';
      plan.pendingReason = 'duplicate';
      plan.candidates = sameNameCandidates;
    } else if (otherCandidates.length > 0) {
      // 同场无匹配、其它场出现 => 疑似跨场移动
      plan.status = 'pending';
      plan.pendingReason = 'moved';
      plan.candidates = otherCandidates;
    } else {
      // 全稿无匹配 => 删除或被改动
      plan.status = 'pending';
      plan.pendingReason = 'deleted_or_edited';
      plan.candidates = [];
    }

    plans.push(plan);
  }

  return plans;
}
