// 领域类型定义

/** 标记状态：
 * active   —— 已定位在某版本的连续行上（手录、自动迁移成功或待核已选定新行）
 * pending  —— 待核：自动迁移无法唯一判定，等待舞监选择新行或废弃
 * discarded—— 已废弃：舞监确认该标记在新稿中不再保留
 */
export type MarkStatus = 'active' | 'pending' | 'discarded';

/** 待核原因 */
export type PendingReason = 'deleted_or_edited' | 'duplicate' | 'moved';

/** 匹配候选（连续行区段） */
export interface MatchCandidate {
  sceneName: string;
  sceneId: number;
  startLine: number; // 1-based
  endLine: number; // 1-based
  sameScene: boolean;
}

/** 单条原标记的迁移方案（纯函数分析结果） */
export interface MigrationPlan {
  markId: number;
  status: MarkStatus;
  pendingReason?: PendingReason;
  candidates: MatchCandidate[];
  targetSceneId?: number;
  targetStartLine?: number;
  targetEndLine?: number;
  sourceSceneName: string;
  sourceStartLine: number;
  sourceEndLine: number;
}

export interface LineDTO {
  ord: number; // 1-based
  text: string;
}

export interface SceneDTO {
  id: number;
  ord: number;
  name: string;
  lines: LineDTO[];
}

export interface MarkDTO {
  id: number;
  sceneId: number | null; // pending/discarded 未定位时为 null
  sceneName: string | null;
  startLine: number | null;
  endLine: number | null;
  label: string;
  note: string | null;
  status: MarkStatus;
  pendingReason: PendingReason | null;
  candidates: MatchCandidate[];
  sourceSceneName: string | null;
  sourceStartLine: number | null;
  sourceEndLine: number | null;
  sourceTexts: string[];
  fromMigration: boolean;
}

export interface VersionDTO {
  id: number;
  scriptId: number;
  versionNo: number;
  status: 'draft' | 'confirmed';
  baseVersionId: number | null;
  revision: number;
  confirmedAt: string | null;
  scenes: SceneDTO[];
  marks: MarkDTO[];
  pendingCount: number;
}

export interface ScriptSummary {
  id: number;
  title: string;
  createdAt: string;
  latestConfirmedVersionId: number | null;
  draftVersionId: number | null;
}
