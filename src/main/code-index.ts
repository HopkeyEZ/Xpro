/**
 * Code Index — per-project code module index table.
 *
 * Scans project files, splits into logical chunks (functions/classes/blocks),
 * generates short descriptions via LLM, and stores a searchable index.
 *
 * Index is stored at: ~/.xpro/indexes/<projectHash>.json
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { net } from 'electron';

// ==================== Types ====================

export interface CodeChunk {
  id: number;
  filePath: string;        // relative to project root
  name: string;            // function/class/export name or block label
  description: string;     // LLM-generated short description
  startLine: number;
  endLine: number;
  code: string;            // actual source code of the chunk
  keywords: string[];      // extracted keywords for fast matching
  updatedAt: string;
}

export interface CodeIndexProfile {
  projectPath: string;
  projectHash: string;
  chunks: CodeChunk[];
  lastFullScan: string;
  version: number;
}

interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ==================== Storage ====================

const INDEX_DIR = path.join(os.homedir(), '.xpro', 'indexes');

function ensureDir() {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
}

function projectHash(projectPath: string): string {
  return crypto.createHash('sha256').update(projectPath.toLowerCase()).digest('hex').slice(0, 16);
}

function indexFilePath(hash: string): string {
  return path.join(INDEX_DIR, `${hash}.json`);
}

function loadIndex(projectPath: string): CodeIndexProfile {
  ensureDir();
  const hash = projectHash(projectPath);
  const fp = indexFilePath(hash);
  if (fs.existsSync(fp)) {
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch {}
  }
  return {
    projectPath,
    projectHash: hash,
    chunks: [],
    lastFullScan: '',
    version: 1,
  };
}

function saveIndex(profile: CodeIndexProfile) {
  ensureDir();
  const fp = indexFilePath(profile.projectHash);
  fs.writeFileSync(fp, JSON.stringify(profile, null, 2), 'utf-8');
}

// ==================== File Scanning ====================

const CODE_EXTENSIONS = new Set([
  '.ts', '.js', '.tsx', '.jsx', '.py', '.java', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.vue',
  '.svelte', '.swift', '.kt', '.scala', '.dart',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '__pycache__',
  '.next', '.nuxt', 'target', 'vendor', '.xpro',
]);

const MAX_FILE_SIZE = 100 * 1024; // 100KB max per file

function getCodeFiles(rootDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size <= MAX_FILE_SIZE) results.push(fullPath);
          } catch {}
        }
      }
    }
  }

  walk(rootDir);
  return results;
}

// ==================== Code Chunking ====================

interface RawChunk {
  name: string;
  startLine: number;
  endLine: number;
  code: string;
}

/**
 * Split a file into logical chunks based on pattern matching.
 * Handles functions, classes, exports, and falls back to fixed-size blocks.
 */
function splitFileIntoChunks(content: string, filePath: string): RawChunk[] {
  const lines = content.split('\n');
  const chunks: RawChunk[] = [];
  const ext = path.extname(filePath).toLowerCase();

  // Pattern-based splitting for common languages
  const patterns: RegExp[] = [];

  if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
    patterns.push(
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
      /^(?:export\s+)?class\s+(\w+)/,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*\{/,
      /^(?:export\s+)?interface\s+(\w+)/,
      /^(?:export\s+)?type\s+(\w+)/,
    );
  } else if (ext === '.py') {
    patterns.push(
      /^(?:async\s+)?def\s+(\w+)/,
      /^class\s+(\w+)/,
    );
  } else if (['.java', '.cs', '.kt'].includes(ext)) {
    patterns.push(
      /^\s*(?:public|private|protected|static|\s)*(?:class|interface|enum)\s+(\w+)/,
      /^\s*(?:public|private|protected|static|\s)*\w+\s+(\w+)\s*\(/,
    );
  } else if (['.go', '.rs'].includes(ext)) {
    patterns.push(
      /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/,
      /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
      /^(?:pub\s+)?struct\s+(\w+)/,
      /^type\s+(\w+)\s+(?:struct|interface)/,
    );
  }

  if (patterns.length > 0) {
    const boundaries: { name: string; line: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i];
      for (const pat of patterns) {
        const m = trimmed.match(pat);
        if (m) {
          boundaries.push({ name: m[1], line: i });
          break;
        }
      }
    }

    if (boundaries.length > 0) {
      for (let i = 0; i < boundaries.length; i++) {
        const start = boundaries[i].line;
        const end = i + 1 < boundaries.length ? boundaries[i + 1].line - 1 : lines.length - 1;
        const code = lines.slice(start, end + 1).join('\n');
        // Skip trivially small chunks
        if (code.trim().length < 20) continue;
        chunks.push({
          name: boundaries[i].name,
          startLine: start + 1,
          endLine: end + 1,
          code: code.slice(0, 2000), // cap code size
        });
      }
      return chunks;
    }
  }

  // Fallback: fixed-size blocks of 50 lines
  const BLOCK_SIZE = 50;
  const fileName = path.basename(filePath, path.extname(filePath));
  for (let i = 0; i < lines.length; i += BLOCK_SIZE) {
    const end = Math.min(i + BLOCK_SIZE, lines.length);
    const code = lines.slice(i, end).join('\n');
    if (code.trim().length < 20) continue;
    chunks.push({
      name: `${fileName}_block_${Math.floor(i / BLOCK_SIZE) + 1}`,
      startLine: i + 1,
      endLine: end,
      code: code.slice(0, 2000),
    });
  }

  return chunks;
}

// ==================== LLM Description Generation ====================

async function generateDescriptions(
  config: AiConfig,
  chunks: Array<{ name: string; filePath: string; code: string }>,
): Promise<Array<{ description: string; keywords: string[] }>> {
  const prompt = `You are a code indexer. For each code chunk below, generate:
1. A concise one-line description of what it does (in the same language as any comments, default English)
2. 3-5 search keywords someone might use to find this code

Respond as a JSON array (no markdown fences):
[{"description": "...", "keywords": ["...", "..."]}]

Code chunks:
${chunks.map((c, i) => `--- Chunk ${i + 1}: ${c.name} (${c.filePath}) ---\n${c.code.slice(0, 800)}`).join('\n\n')}`;

  const base = config.baseUrl.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;

  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.error('[CodeIndex] LLM error:', res.status);
      return chunks.map(c => ({ description: c.name, keywords: [c.name] }));
    }

    const json = await res.json() as any;
    let content = json.choices?.[0]?.message?.content || '';
    // Strip markdown fences if present
    content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const results = JSON.parse(content);
    if (Array.isArray(results) && results.length === chunks.length) {
      return results;
    }
  } catch (err) {
    console.error('[CodeIndex] LLM parse error:', err);
  }

  // Fallback
  return chunks.map(c => ({ description: c.name, keywords: [c.name] }));
}

// ==================== Public API ====================

/**
 * Build or rebuild the code index for a project.
 * Scans all code files, chunks them, and generates descriptions via LLM.
 */
export async function buildIndex(
  projectPath: string,
  config: AiConfig,
  onProgress?: (current: number, total: number) => void,
): Promise<CodeIndexProfile> {
  console.log('[CodeIndex] Building index for:', projectPath);
  const profile = loadIndex(projectPath);
  const files = getCodeFiles(projectPath);

  const allChunks: CodeChunk[] = [];
  let nextId = 1;
  const BATCH_SIZE = 10; // Process 10 chunks at a time with LLM

  const pendingBatch: Array<{ name: string; filePath: string; code: string; startLine: number; endLine: number }> = [];

  for (let fi = 0; fi < files.length; fi++) {
    const fullPath = files[fi];
    const relPath = path.relative(projectPath, fullPath).replace(/\\/g, '/');

    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch { continue; }

    const rawChunks = splitFileIntoChunks(content, fullPath);

    for (const rc of rawChunks) {
      pendingBatch.push({
        name: rc.name,
        filePath: relPath,
        code: rc.code,
        startLine: rc.startLine,
        endLine: rc.endLine,
      });

      if (pendingBatch.length >= BATCH_SIZE) {
        const descriptions = await generateDescriptions(config, pendingBatch);
        for (let i = 0; i < pendingBatch.length; i++) {
          allChunks.push({
            id: nextId++,
            filePath: pendingBatch[i].filePath,
            name: pendingBatch[i].name,
            description: descriptions[i]?.description || pendingBatch[i].name,
            startLine: pendingBatch[i].startLine,
            endLine: pendingBatch[i].endLine,
            code: pendingBatch[i].code,
            keywords: descriptions[i]?.keywords || [pendingBatch[i].name],
            updatedAt: new Date().toISOString(),
          });
        }
        pendingBatch.length = 0;
      }
    }

    if (onProgress) onProgress(fi + 1, files.length);
  }

  // Process remaining batch
  if (pendingBatch.length > 0) {
    const descriptions = await generateDescriptions(config, pendingBatch);
    for (let i = 0; i < pendingBatch.length; i++) {
      allChunks.push({
        id: nextId++,
        filePath: pendingBatch[i].filePath,
        name: pendingBatch[i].name,
        description: descriptions[i]?.description || pendingBatch[i].name,
        startLine: pendingBatch[i].startLine,
        endLine: pendingBatch[i].endLine,
        code: pendingBatch[i].code,
        keywords: descriptions[i]?.keywords || [pendingBatch[i].name],
        updatedAt: new Date().toISOString(),
      });
    }
  }

  profile.chunks = allChunks;
  profile.lastFullScan = new Date().toISOString();
  profile.version++;
  saveIndex(profile);

  console.log(`[CodeIndex] Indexed ${allChunks.length} chunks from ${files.length} files`);
  return profile;
}

/**
 * Search the code index using keyword matching (Layer 1).
 * Returns top N matching chunks sorted by relevance score.
 */
export function searchIndex(
  projectPath: string,
  query: string,
  limit: number = 5,
): CodeChunk[] {
  const profile = loadIndex(projectPath);
  if (profile.chunks.length === 0) return [];

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);

  const scored = profile.chunks.map(chunk => {
    let score = 0;

    // Name exact match (highest)
    if (chunk.name.toLowerCase() === queryLower) score += 20;
    if (chunk.name.toLowerCase().includes(queryLower)) score += 10;

    // Description match
    const descLower = chunk.description.toLowerCase();
    if (descLower.includes(queryLower)) score += 12;
    for (const w of queryWords) {
      if (descLower.includes(w)) score += 4;
    }

    // Keyword match
    for (const kw of chunk.keywords) {
      const kwLower = kw.toLowerCase();
      if (queryLower.includes(kwLower) || kwLower.includes(queryLower)) score += 8;
      for (const w of queryWords) {
        if (kwLower.includes(w) || w.includes(kwLower)) score += 3;
      }
    }

    // File path match
    const fpLower = chunk.filePath.toLowerCase();
    for (const w of queryWords) {
      if (fpLower.includes(w)) score += 2;
    }

    return { chunk, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.chunk);
}

/**
 * Get index stats for a project.
 */
export function getIndexStats(projectPath: string): { chunks: number; files: number; lastScan: string } {
  const profile = loadIndex(projectPath);
  const uniqueFiles = new Set(profile.chunks.map(c => c.filePath));
  return {
    chunks: profile.chunks.length,
    files: uniqueFiles.size,
    lastScan: profile.lastFullScan,
  };
}

/**
 * Update index for a single file (incremental).
 */
export async function updateFileIndex(
  projectPath: string,
  filePath: string,
  config: AiConfig,
): Promise<void> {
  const profile = loadIndex(projectPath);
  const relPath = path.relative(projectPath, filePath).replace(/\\/g, '/');

  // Remove old chunks for this file
  profile.chunks = profile.chunks.filter(c => c.filePath !== relPath);

  // Re-index this file
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch { saveIndex(profile); return; }

  if (content.length > MAX_FILE_SIZE) { saveIndex(profile); return; }

  const ext = path.extname(filePath).toLowerCase();
  if (!CODE_EXTENSIONS.has(ext)) { saveIndex(profile); return; }

  const rawChunks = splitFileIntoChunks(content, filePath);
  if (rawChunks.length === 0) { saveIndex(profile); return; }

  const maxId = profile.chunks.reduce((max, c) => Math.max(max, c.id), 0);
  const batch = rawChunks.map(rc => ({ name: rc.name, filePath: relPath, code: rc.code }));
  const descriptions = await generateDescriptions(config, batch);

  for (let i = 0; i < rawChunks.length; i++) {
    profile.chunks.push({
      id: maxId + i + 1,
      filePath: relPath,
      name: rawChunks[i].name,
      description: descriptions[i]?.description || rawChunks[i].name,
      startLine: rawChunks[i].startLine,
      endLine: rawChunks[i].endLine,
      code: rawChunks[i].code,
      keywords: descriptions[i]?.keywords || [rawChunks[i].name],
      updatedAt: new Date().toISOString(),
    });
  }

  profile.version++;
  saveIndex(profile);
  console.log(`[CodeIndex] Updated ${rawChunks.length} chunks for ${relPath}`);
}
