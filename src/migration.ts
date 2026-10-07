/** 标记迁移匹配：仅当新稿同名场景内文本连续且唯一匹配时自动迁移，其余一律待核。 */

export interface SceneForMatch {
  id: number;
  name: string;
  lines: { position: number; text: string }[];
}

export type PendingReason = 'duplicate' | 'cross_scene' | 'deleted_or_modified';

export type LocateResult =
  | { status: 'auto'; sceneId: number; start: number; end: number }
  | { status: 'pending'; reason: PendingReason };

export function locateMarker(
  baseSceneName: string,
  covered: string[],
  newScenes: SceneForMatch[],
): LocateResult {
  const len = covered.length;
  const findIn = (scenes: SceneForMatch[]): { sceneId: number; start: number }[] => {
    const hits: { sceneId: number; start: number }[] = [];
    for (const sc of scenes) {
      for (let i = 0; i + len <= sc.lines.length; i++) {
        let ok = true;
        for (let j = 0; j < len; j++) {
          if (sc.lines[i + j].text !== covered[j]) { ok = false; break; }
        }
        if (ok) hits.push({ sceneId: sc.id, start: sc.lines[i].position });
      }
    }
    return hits;
  };

  const sameName = newScenes.filter((s) => s.name === baseSceneName);
  const hits = findIn(sameName);
  if (hits.length === 1) {
    const h = hits[0];
    return { status: 'auto', sceneId: h.sceneId, start: h.start, end: h.start + len - 1 };
  }
  if (hits.length > 1) return { status: 'pending', reason: 'duplicate' };

  const cross = findIn(newScenes.filter((s) => s.name !== baseSceneName));
  if (cross.length > 0) return { status: 'pending', reason: 'cross_scene' };
  return { status: 'pending', reason: 'deleted_or_modified' };
}
