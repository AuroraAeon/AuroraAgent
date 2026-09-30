/** mention-items.mjs 的类型声明（实现是零依赖纯函数，Node 测试直接 import 同一份）。 */
import type { SkillRow } from './types';

export type MentionItem =
  | { kind: 'file'; key: string; label: string }
  | { kind: 'skill'; key: string; label: string; desc: string }
  | { kind: 'problems'; key: string; label: string; at: string; errKind: string; text: string }
  | { kind: 'terminal'; key: string; label: string; at: string; text: string };

/** 一条「观察」（问题 / 跑过的命令）：后端 /api/agent/observations 的行形状 */
export type ObservationItem = { id: string; label: string; at: string; kind: string; text: string };

export declare const MENTION_FILE_LIMIT: number;
export declare const MENTION_OBSERVATION_LIMIT: number;
export declare const MENTION_SKILL_LIMIT: number;

export declare function normalizeObservation(raw: unknown): ObservationItem;

export declare function buildMentionItems(
  files: readonly string[],
  skills: readonly SkillRow[],
  problems: readonly ObservationItem[],
  terminal: readonly ObservationItem[],
  query: string,
): MentionItem[];
