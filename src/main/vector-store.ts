/**
 * Vector Store — semantic search layer using embeddings.
 *
 * Uses cosine similarity for retrieval (pure JS, no native dependencies).
 * Stores embeddings at: ~/.xpro/vectors/<projectHash>.json
 *
 * This is Layer 2 in the 3-layer retrieval architecture:
 *   Layer 1: Code Index (keyword match) — fast, precise
 *   Layer 2: Vector Store (semantic match) — fuzzy, semantic
 *   Layer 3: Agent tool calls (fallback) — slow, expensive
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { net } from 'electron';

// ==================== Types ====================

interface EmbeddingEntry {
  id: number;
  filePath: string;
  name: string;
  description: string;
  startLine: number;
  endLine: number;
  embedding: number[];  // float32 vector
}

interface VectorProfile {
  projectPath: string;
  projectHash: string;
  entries: EmbeddingEntry[];
  dimension: number;
  model: string;
  updatedAt: string;
}

interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ==================== Storage ====================

const VECTOR_DIR = path.join(os.homedir(), '.xpro', 'vectors');

function ensureDir() {
  fs.mkdirSync(VECTOR_DIR, { recursive: true });
}

function getProjectHash(projectPath: string): string {
  return crypto.createHash('sha256').update(projectPath.toLowerCase()).digest('hex').slice(0, 16);
}

function vectorFilePath(hash: string): string {
  return path.join(VECTOR_DIR, `${hash}.json`);
}

function loadVectorProfile(projectPath: string): VectorProfile {
  ensureDir();
  const hash = getProjectHash(projectPath);
  const fp = vectorFilePath(hash);
  if (fs.existsSync(fp)) {
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch {}
  }
  return {
    projectPath,
    projectHash: hash,
    entries: [],
    dimension: 0,
    model: '',
    updatedAt: '',
  };
}

function saveVectorProfile(profile: VectorProfile) {
  ensureDir();
  const fp = vectorFilePath(profile.projectHash);
  fs.writeFileSync(fp, JSON.stringify(profile), 'utf-8'); // no pretty print to save space
}

// ==================== Embedding API ====================

/**
 * Get embeddings from API. Supports OpenAI and DeepSeek embedding endpoints.
 */
async function getEmbeddings(
  config: AiConfig,
  texts: string[],
): Promise<number[][]> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const url = `${base}/embeddings`;

  // Determine embedding model
  let embeddingModel = 'text-embedding-3-small';
  if (base.includes('deepseek')) {
    // DeepSeek doesn't have embedding API yet, fall back to simple hash-based pseudo-embeddings
    return texts.map(t => textToSimpleVector(t));
  }

  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: embeddingModel,
        input: texts,
      }),
    });

    if (!res.ok) {
      console.error('[VectorStore] Embedding API error:', res.status);
      return texts.map(t => textToSimpleVector(t));
    }

    const json = await res.json() as any;
    const data = json.data as Array<{ embedding: number[] }>;
    return data.map(d => d.embedding);
  } catch (err) {
    console.error('[VectorStore] Embedding fetch error:', err);
    return texts.map(t => textToSimpleVector(t));
  }
}

/**
 * Fallback: Simple TF-based pseudo-embedding for when no embedding API is available.
 * Uses character n-gram hashing to create a fixed-dimension vector.
 */
function textToSimpleVector(text: string, dim: number = 256): number[] {
  const vec = new Float32Array(dim);
  const lower = text.toLowerCase();

  // Character trigram hashing
  for (let i = 0; i < lower.length - 2; i++) {
    const trigram = lower.slice(i, i + 3);
    const hash = simpleHash(trigram);
    const idx = Math.abs(hash) % dim;
    vec[idx] += 1;
  }

  // Word-level features
  const words = lower.split(/\W+/).filter(w => w.length > 2);
  for (const w of words) {
    const hash = simpleHash(w);
    const idx = Math.abs(hash) % dim;
    vec[idx] += 2; // Words are weighted higher
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const result: number[] = [];
  for (let i = 0; i < dim; i++) result.push(vec[i] / norm);

  return result;
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash;
}

// ==================== Cosine Similarity ====================

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ==================== Public API ====================

export interface VectorSearchResult {
  filePath: string;
  name: string;
  description: string;
  startLine: number;
  endLine: number;
  score: number;
}

/**
 * Build vector embeddings for code chunks from the code index.
 */
export async function buildVectors(
  projectPath: string,
  chunks: Array<{ id: number; filePath: string; name: string; description: string; startLine: number; endLine: number; code: string }>,
  config: AiConfig,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  console.log(`[VectorStore] Building vectors for ${chunks.length} chunks`);
  const profile = loadVectorProfile(projectPath);
  profile.entries = [];

  const BATCH_SIZE = 20;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    // Combine description + name + code snippet for better embedding
    const texts = batch.map(c => `${c.name}: ${c.description}\n${c.code.slice(0, 500)}`);
    const embeddings = await getEmbeddings(config, texts);

    for (let j = 0; j < batch.length; j++) {
      profile.entries.push({
        id: batch[j].id,
        filePath: batch[j].filePath,
        name: batch[j].name,
        description: batch[j].description,
        startLine: batch[j].startLine,
        endLine: batch[j].endLine,
        embedding: embeddings[j],
      });
    }

    if (onProgress) onProgress(Math.min(i + BATCH_SIZE, chunks.length), chunks.length);
  }

  profile.dimension = profile.entries[0]?.embedding.length || 256;
  profile.model = config.baseUrl.includes('deepseek') ? 'simple-hash' : 'text-embedding-3-small';
  profile.updatedAt = new Date().toISOString();
  saveVectorProfile(profile);

  console.log(`[VectorStore] Stored ${profile.entries.length} vectors (dim=${profile.dimension})`);
}

/**
 * Semantic search: find chunks similar to the query (Layer 2).
 */
export async function vectorSearch(
  projectPath: string,
  query: string,
  config: AiConfig,
  limit: number = 5,
): Promise<VectorSearchResult[]> {
  const profile = loadVectorProfile(projectPath);
  if (profile.entries.length === 0) return [];

  // Get query embedding
  const [queryVec] = await getEmbeddings(config, [query]);
  if (!queryVec || queryVec.length === 0) return [];

  // Compute similarities
  const scored = profile.entries.map(entry => ({
    filePath: entry.filePath,
    name: entry.name,
    description: entry.description,
    startLine: entry.startLine,
    endLine: entry.endLine,
    score: cosineSimilarity(queryVec, entry.embedding),
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter(s => s.score > 0.1); // minimum threshold
}

/**
 * Get vector store stats.
 */
export function getVectorStats(projectPath: string): { entries: number; dimension: number; model: string } {
  const profile = loadVectorProfile(projectPath);
  return {
    entries: profile.entries.length,
    dimension: profile.dimension,
    model: profile.model,
  };
}
