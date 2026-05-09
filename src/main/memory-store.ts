/**
 * MemoryStore – Per-project persistent memory for AI agents.
 *
 * Inspired by Cloudflare Agent Memory architecture:
 *   - 4 memory types: fact, event, instruction, task
 *   - Supersession via topicKey (new facts replace old ones)
 *   - Content-addressed deduplication (SHA-256 based ID)
 *   - Pre-generated search queries for better retrieval
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

// ==================== Types ====================

export type MemoryType = 'fact' | 'event' | 'instruction' | 'task';

export interface Memory {
  id: string;
  type: MemoryType;
  topicKey: string;
  content: string;
  searchQueries: string[];
  sourceSessionId: string;
  createdAt: string;
  supersededBy: string | null;
  active: boolean;
}

export interface MemoryProfile {
  projectId: string;
  projectPath: string;
  memories: Memory[];
  createdAt: string;
  updatedAt: string;
}

// ==================== Storage ====================

const MEMORY_DIR = path.join(os.homedir(), '.xpro', 'memories');

function ensureDir() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function projectIdFromPath(projectPath: string): string {
  return crypto.createHash('sha256').update(projectPath.toLowerCase()).digest('hex').slice(0, 16);
}

function profilePath(projectId: string): string {
  return path.join(MEMORY_DIR, `${projectId}.json`);
}

function loadProfile(projectPath: string): MemoryProfile {
  ensureDir();
  const id = projectIdFromPath(projectPath);
  const fp = profilePath(id);
  if (fs.existsSync(fp)) {
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      return JSON.parse(raw);
    } catch {
      // corrupt file, start fresh
    }
  }
  return {
    projectId: id,
    projectPath,
    memories: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function saveProfile(profile: MemoryProfile): void {
  ensureDir();
  const fp = profilePath(profile.projectId);
  profile.updatedAt = new Date().toISOString();
  fs.writeFileSync(fp, JSON.stringify(profile, null, 2), 'utf-8');
}

// ==================== Memory ID ====================

function memoryId(content: string, type: MemoryType): string {
  return crypto
    .createHash('sha256')
    .update(`${type}:${content}`)
    .digest('hex')
    .slice(0, 24);
}

// ==================== Core Operations ====================

/**
 * Store memories extracted from a conversation.
 * Handles deduplication and supersession.
 */
export function storeMemories(
  projectPath: string,
  newMemories: Array<{
    type: MemoryType;
    topicKey: string;
    content: string;
    searchQueries?: string[];
    sessionId?: string;
  }>,
): { stored: number; superseded: number; duplicates: number } {
  const profile = loadProfile(projectPath);
  let stored = 0;
  let superseded = 0;
  let duplicates = 0;

  for (const mem of newMemories) {
    const id = memoryId(mem.content, mem.type);

    // Dedup: skip if exact content already exists
    if (profile.memories.some(m => m.id === id)) {
      duplicates++;
      continue;
    }

    // Supersession: for fact/instruction, supersede existing with same topicKey
    if ((mem.type === 'fact' || mem.type === 'instruction') && mem.topicKey) {
      const existing = profile.memories.find(
        m => m.type === mem.type && m.topicKey === mem.topicKey && m.active && !m.supersededBy,
      );
      if (existing) {
        existing.supersededBy = id;
        existing.active = false;
        superseded++;
      }
    }

    const memory: Memory = {
      id,
      type: mem.type,
      topicKey: mem.topicKey || '',
      content: mem.content,
      searchQueries: mem.searchQueries || [],
      sourceSessionId: mem.sessionId || '',
      createdAt: new Date().toISOString(),
      supersededBy: null,
      active: true,
    };
    profile.memories.push(memory);
    stored++;
  }

  saveProfile(profile);
  return { stored, superseded, duplicates };
}

/**
 * Recall memories relevant to a query.
 * Uses keyword matching + topicKey matching (no vector DB needed).
 */
export function recallMemories(
  projectPath: string,
  query: string,
  limit: number = 20,
): Memory[] {
  const profile = loadProfile(projectPath);
  const active = profile.memories.filter(m => m.active);

  if (active.length === 0) return [];

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  // Score each memory
  const scored = active.map(m => {
    let score = 0;
    const contentLower = m.content.toLowerCase();
    const topicLower = m.topicKey.toLowerCase();

    // TopicKey exact match (highest weight)
    if (topicLower && queryLower.includes(topicLower)) score += 10;
    if (topicLower && topicLower.includes(queryLower)) score += 8;

    // Search queries match
    for (const sq of m.searchQueries) {
      const sqLower = sq.toLowerCase();
      if (queryLower.includes(sqLower) || sqLower.includes(queryLower)) score += 6;
      // Word overlap
      const sqWords = sqLower.split(/\s+/);
      const overlap = queryWords.filter(w => sqWords.some(sw => sw.includes(w) || w.includes(sw)));
      score += overlap.length * 2;
    }

    // Content keyword match
    const contentWords = contentLower.split(/\s+/);
    const wordOverlap = queryWords.filter(w => contentWords.some(cw => cw.includes(w) || w.includes(cw)));
    score += wordOverlap.length * 1.5;

    // Type boost: facts and instructions are generally more useful
    if (m.type === 'fact') score += 1;
    if (m.type === 'instruction') score += 1.5;

    // Recency boost (newer memories slightly preferred)
    const age = Date.now() - new Date(m.createdAt).getTime();
    const dayAge = age / (1000 * 60 * 60 * 24);
    if (dayAge < 1) score += 2;
    else if (dayAge < 7) score += 1;

    return { memory: m, score };
  });

  // Sort by score descending, return top N
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score > 0).slice(0, limit).map(s => s.memory);
}

/**
 * Get all active memories for a project (for UI display).
 */
export function listMemories(projectPath: string): Memory[] {
  const profile = loadProfile(projectPath);
  return profile.memories.filter(m => m.active);
}

/**
 * Forget (deactivate) a specific memory.
 */
export function forgetMemory(projectPath: string, memoryId: string): boolean {
  const profile = loadProfile(projectPath);
  const mem = profile.memories.find(m => m.id === memoryId);
  if (!mem) return false;
  mem.active = false;
  saveProfile(profile);
  return true;
}

/**
 * Get memory stats for a project.
 */
export function getMemoryStats(projectPath: string): {
  total: number;
  active: number;
  byType: Record<MemoryType, number>;
} {
  const profile = loadProfile(projectPath);
  const active = profile.memories.filter(m => m.active);
  const byType: Record<MemoryType, number> = { fact: 0, event: 0, instruction: 0, task: 0 };
  for (const m of active) byType[m.type]++;
  return { total: profile.memories.length, active: active.length, byType };
}

/**
 * Clear all memories for a project.
 */
export function clearMemories(projectPath: string): void {
  const profile = loadProfile(projectPath);
  profile.memories = [];
  saveProfile(profile);
}
