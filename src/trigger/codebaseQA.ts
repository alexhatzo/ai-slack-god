import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger, task } from '@trigger.dev/sdk/v3';
import {
  GoogleGenerativeAI,
  SchemaType,
  type FunctionDeclaration,
  type FunctionResponsePart,
  type GenerateContentCandidate,
  type GenerateContentResult,
  type Part,
} from '@google/generative-ai';
import { postThreadReply } from '../services/slackClient.js';
import {
  REPOS,
  REPO_SHORT_NAMES,
  buildSystemPrompt,
  AI_MODEL,
  MAX_TURNS,
  TASK_CONFIG,
} from '../config.js';

// ── Function declarations for AI ─────────────────────────────────────────────

const functionDeclarations: FunctionDeclaration[] = [
  {
    name: 'read_file',
    description:
      'Read the full contents of a file from a cloned repo. Returns the file text with line numbers.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        repo: {
          type: SchemaType.STRING,
          description: `Repository short name: ${REPO_SHORT_NAMES.join(', ')}`,
        },
        path: {
          type: SchemaType.STRING,
          description: 'Relative path within the repo, e.g. src/index.ts',
        },
      },
      required: ['repo', 'path'],
    },
  },
  {
    name: 'grep_codebase',
    description:
      'Search for a regex pattern across repo files using ripgrep. Returns matching lines with file:line context.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        pattern: {
          type: SchemaType.STRING,
          description: 'Regex search pattern (ripgrep syntax)',
        },
        repo: {
          type: SchemaType.STRING,
          description: `Optional: restrict to one repo (${REPO_SHORT_NAMES.join(', ')}). Omit to search all.`,
        },
        file_glob: {
          type: SchemaType.STRING,
          description: 'Optional file glob filter, e.g. "*.ts" or "*.sql"',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_dir',
    description:
      'List files and directories at a given path in a cloned repo.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        repo: {
          type: SchemaType.STRING,
          description: `Repository short name: ${REPO_SHORT_NAMES.join(', ')}`,
        },
        path: {
          type: SchemaType.STRING,
          description: 'Relative directory path within the repo. Defaults to repo root.',
        },
      },
      required: ['repo'],
    },
  },
];

// ── Tool implementations ─────────────────────────────────────────────────────

function validateRepo(repo: string): void {
  if (!REPO_SHORT_NAMES.includes(repo)) {
    throw new Error(`Invalid repo "${repo}". Must be one of: ${REPO_SHORT_NAMES.join(', ')}`);
  }
}

function repoRoot(baseDir: string, repo: string): string {
  validateRepo(repo);
  const resolved = path.resolve(baseDir, repo);
  if (!fs.existsSync(resolved)) throw new Error(`Repo not found: ${repo}`);
  return resolved;
}

function assertContained(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path traversal blocked');
}

const MAX_READ_FILE_BYTES = 512_000; // 500KB — avoid loading huge bundles into memory

function execReadFile(baseDir: string, repo: string, filePath: string): string {
  const root = repoRoot(baseDir, repo);
  const abs = path.resolve(root, filePath);
  assertContained(root, abs);
  if (!fs.existsSync(abs)) return `Error: file not found — ${filePath}`;
  const { size } = fs.statSync(abs);
  if (size > MAX_READ_FILE_BYTES) {
    const sizeKB = Math.round(size / 1024);
    return `Error: file too large (${sizeKB}KB). Try grep_codebase to find specific content instead.`;
  }
  return fs.readFileSync(abs, 'utf-8')
    .split('\n')
    .map((line, i) => `${i + 1}|${line}`)
    .join('\n');
}

function execGrep(baseDir: string, pattern: string, repo?: string, fileGlob?: string): string {
  const targets = repo ? (validateRepo(repo), [repo]) : [...REPO_SHORT_NAMES];
  const results: string[] = [];

  for (const r of targets) {
    const root = repoRoot(baseDir, r);
    const args = ['--no-heading', '--line-number', '--max-count', '80'];
    if (fileGlob) args.push('--glob', fileGlob);
    args.push('--', pattern);

    try {
      const out = execFileSync('rg', args, {
        cwd: root, encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: 15_000,
      });
      results.push(out.split('\n').filter(Boolean).map((l) => `${r}/${l}`).join('\n'));
    } catch (err: any) {
      if (err?.status === 1) continue;
      throw err;
    }
  }

  return results.join('\n') || 'No matches found.';
}

function execListDir(baseDir: string, repo: string, dirPath?: string): string {
  const root = repoRoot(baseDir, repo);
  const abs = path.resolve(root, dirPath || '.');
  assertContained(root, abs);
  if (!fs.existsSync(abs)) return `Error: directory not found — ${dirPath}`;
  return fs.readdirSync(abs, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .join('\n');
}

// ── Clone helper ─────────────────────────────────────────────────────────────

function redactToken(text: string): string {
  return text.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
}

function cloneRepos(baseDir: string): void {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');

  fs.mkdirSync(baseDir, { recursive: true });

  const askpass = path.join(baseDir, '.git-askpass.sh');
  fs.writeFileSync(askpass, '#!/bin/sh\necho "$GIT_TOKEN"\n', { mode: 0o700 });

  const cloneEnv = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TOKEN: token,
    GIT_TERMINAL_PROMPT: '0',
  };

  for (const repo of REPOS) {
    const dest = path.join(baseDir, repo.shortName);
    if (fs.existsSync(dest)) continue;

    logger.info(`Cloning ${repo.fullName}…`);
    try {
      execFileSync(
        'git',
        ['clone', '--depth', '1', `https://x-access-token@github.com/${repo.fullName}.git`, repo.shortName],
        { cwd: baseDir, stdio: 'pipe', timeout: 60_000, env: cloneEnv },
      );
    } catch (err: any) {
      throw new Error(`Failed to clone ${repo.fullName}: ${redactToken(err.message || String(err))}`);
    }
  }
}

// ── AI agentic loop ──────────────────────────────────────────────────────────

enum BlockReason {
  SAFETY = 'SAFETY',
  MAX_TOKENS = 'MAX_TOKENS',
  RECITATION = 'RECITATION',
  BLOCKED = 'BLOCKED',
  NO_CANDIDATES = 'NO_CANDIDATES',
  UNKNOWN = 'UNKNOWN',
}

interface CandidateCheck {
  candidate: GenerateContentCandidate | null;
  blocked: boolean;
  reason: BlockReason | null;
}

function extractText(result: GenerateContentResult): string | null {
  try { return result.response.text() || null; } catch { return null; }
}

function friendlyReason(reason: BlockReason | null): string {
  switch (reason) {
    case BlockReason.SAFETY: return 'I can\'t answer that due to safety policies.';
    case BlockReason.MAX_TOKENS: return 'The response was too long — try simplifying your question.';
    case BlockReason.RECITATION: return 'I can\'t reproduce that content due to content policies.';
    case BlockReason.BLOCKED: return 'The question was blocked by content filters.';
    case BlockReason.NO_CANDIDATES: return 'No response was generated. Try rephrasing.';
    default: return 'An unexpected issue occurred.';
  }
}

function toBlockReason(finishReason: string | undefined): BlockReason {
  switch (finishReason) {
    case 'SAFETY': return BlockReason.SAFETY;
    case 'MAX_TOKENS': return BlockReason.MAX_TOKENS;
    case 'RECITATION': return BlockReason.RECITATION;
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII': return BlockReason.BLOCKED;
    default: return BlockReason.UNKNOWN;
  }
}

function checkCandidate(result: GenerateContentResult): CandidateCheck {
  const pf = result.response.promptFeedback;
  if (pf?.blockReason) return { candidate: null, blocked: true, reason: BlockReason.BLOCKED };

  const candidate = result.response.candidates?.[0] ?? null;
  if (!candidate) return { candidate: null, blocked: true, reason: BlockReason.NO_CANDIDATES };

  const fr = candidate.finishReason;
  const hasFn = candidate.content?.parts?.some((p: Part) => 'functionCall' in p);
  if (fr && fr !== 'STOP' && !hasFn) return { candidate, blocked: true, reason: toBlockReason(fr) };

  return { candidate, blocked: false, reason: null };
}

async function runAgenticLoop(baseDir: string, question: string): Promise<string> {
  const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY not set');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: AI_MODEL,
    systemInstruction: buildSystemPrompt(),
    tools: [{ functionDeclarations }],
  });

  const chat = model.startChat();
  let result = await chat.sendMessage(question);
  let { candidate, blocked, reason } = checkCandidate(result);

  if (blocked) {
    logger.warn('Initial response blocked', { reason });
    return `I wasn't able to answer this question. ${friendlyReason(reason)}`;
  }

  let actualTurns = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const functionCalls = candidate?.content?.parts?.filter((p: Part) => 'functionCall' in p);
    if (!functionCalls || functionCalls.length === 0) break;

    actualTurns = turn + 1;
    const functionResponses: FunctionResponsePart[] = [];

    for (const part of functionCalls) {
      if (!('functionCall' in part) || !part.functionCall) continue;
      const { name } = part.functionCall;
      const raw = part.functionCall.args;
      const args: Record<string, unknown> =
        typeof raw === 'string' ? JSON.parse(raw) :
        (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
      let toolResult: string;

      logger.info(`Tool call [turn ${turn + 1}/${MAX_TURNS}]: ${name}`, { args });

      try {
        switch (name) {
          case 'read_file': {
            const repo = typeof args.repo === 'string' ? args.repo : '';
            const fp = typeof args.path === 'string' ? args.path : '';
            if (!repo || !fp) { toolResult = 'Error: read_file requires repo and path'; break; }
            toolResult = execReadFile(baseDir, repo, fp);
            break;
          }
          case 'grep_codebase': {
            const pattern = typeof args.pattern === 'string' ? args.pattern : '';
            const repo = typeof args.repo === 'string' ? args.repo : undefined;
            const glob = typeof args.file_glob === 'string' ? args.file_glob : undefined;
            if (!pattern) { toolResult = 'Error: grep_codebase requires pattern'; break; }
            toolResult = execGrep(baseDir, pattern, repo, glob);
            break;
          }
          case 'list_dir': {
            const repo = typeof args.repo === 'string' ? args.repo : '';
            const dp = typeof args.path === 'string' ? args.path : undefined;
            if (!repo) { toolResult = 'Error: list_dir requires repo'; break; }
            toolResult = execListDir(baseDir, repo, dp);
            break;
          }
          default:
            toolResult = `Unknown function: ${name}`;
        }
      } catch (err) {
        toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      if (toolResult.length > 30_000) toolResult = toolResult.slice(0, 30_000) + '\n…[truncated]';

      functionResponses.push({ functionResponse: { name, response: { result: toolResult } } });
    }

    result = await chat.sendMessage(functionResponses);
    ({ candidate, blocked, reason } = checkCandidate(result));

    if (blocked) {
      logger.warn(`Blocked at turn ${turn + 1}`, { reason });
      return `I found some relevant code but my response was cut short. ${friendlyReason(reason)}`;
    }
  }

  const text = extractText(result);
  if (!text) {
    logger.warn('No text output', { turns: actualTurns, finishReason: candidate?.finishReason });
    return 'I searched the codebase but wasn\'t able to formulate an answer. Try rephrasing the question.';
  }

  return text;
}

// ── Trigger.dev task ─────────────────────────────────────────────────────────

interface CodebaseQAPayload {
  question: string;
  channel: string;
  threadTs: string;
  user: string;
}

export const codebaseQA = task({
  id: TASK_CONFIG.id,
  machine: TASK_CONFIG.machine,
  maxDuration: TASK_CONFIG.maxDuration,
  queue: TASK_CONFIG.queue,
  retry: { maxAttempts: 1 },
  run: async (payload: CodebaseQAPayload) => {
    const { question, channel, threadTs, user } = payload;
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-qa-'));

    try {
      logger.info('Starting codebase Q&A', { question, user });

      cloneRepos(baseDir);
      logger.info('Repos cloned');

      const answer = await runAgenticLoop(baseDir, question);
      logger.info('AI loop complete', { answerLength: answer.length });

      await postThreadReply(channel, threadTs, answer);
      logger.info('Reply posted to Slack');

      return { success: true, answerLength: answer.length };
    } catch (err) {
      const msg = redactToken(err instanceof Error ? err.message : String(err));
      logger.error('codebase-qa failed', { error: msg });

      try {
        await postThreadReply(channel, threadTs, 'Sorry, something went wrong while searching the codebase.');
      } catch { /* best-effort */ }

      throw err;
    } finally {
      try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  },
});
