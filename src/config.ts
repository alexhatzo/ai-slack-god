/**
 * Central configuration — edit this file to adapt the bot to your codebase.
 */

export interface RepoConfig {
  /** GitHub org/repo path, e.g. "acme/backend" */
  fullName: string;
  /** Short name used in tool calls, e.g. "backend" */
  shortName: string;
  /** One-line description for the AI system prompt */
  description: string;
}

/**
 * Add your repositories here. The bot will clone all of them and give the AI
 * tools to search across them.
 */
export const REPOS: RepoConfig[] = [
  {
    fullName: 'yourorg/your-api',
    shortName: 'your-api',
    description: 'Node.js backend: REST API, database, background jobs.',
  },
  {
    fullName: 'yourorg/your-web',
    shortName: 'your-web',
    description: 'React frontend: UI components, pages, state management.',
  },
  // Add more repos as needed
];

export const REPO_SHORT_NAMES = REPOS.map((r) => r.shortName);

/**
 * System prompt — describes your codebase to the AI so it knows where to look.
 * The repo list is injected automatically from REPOS above.
 */
export function buildSystemPrompt(): string {
  const repoList = REPOS.map((r) => `- ${r.shortName} — ${r.description}`).join('\n');

  return `You are a codebase expert. The user is asking a question about the code.

You have three tools: read_file, grep_codebase, and list_dir. Use them iteratively to find the answer.

Repositories (use these short names with the tools):
${repoList}

Search strategy:
- If unsure which repo to look in, start with grep_codebase across ALL repos (omit the repo param) to locate the relevant code, then drill into the specific repo.
- Some features span multiple repos. Search across all repos when the question involves end-to-end behavior.

Rules:
- Answer in plain English — the audience may not be engineers.
- Always cite the exact repo, file path, and line number where you found the answer.
- If a hardcoded value controls the behavior, state the value and explain what changing it would do.
- Be concise. Aim for 2-4 short paragraphs max.
- If you cannot find the answer after a thorough search, say so honestly.`;
}

/** Gemini model to use */
export const AI_MODEL = 'gemini-2.5-flash';

/** Max agentic tool-call turns before forcing a final answer */
export const MAX_TURNS = 15;

/** Trigger.dev task config */
export const TASK_CONFIG = {
  id: 'codebase-qa',
  machine: 'small-1x' as const,
  maxDuration: 120,
  queue: { name: 'slack-qa', concurrencyLimit: 3 },
};
