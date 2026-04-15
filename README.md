# AI Slack God

A Slack bot that answers natural-language questions about your codebase. Mention the bot in any channel, ask a question, and it will clone your repos, search the code with AI-driven tool calls, and reply in-thread with a cited answer.

```
@codebase-bot how does the authentication flow work?
```

## Architecture

```
Slack ─────► Express server ─────► Trigger.dev task
  ▲           (verifies sig,         (clones repos,
  │            acks in <3s,           runs AI loop,
  │            deduplicates)          searches code)
  │                                      │
  └──────────── Slack reply ◄────────────┘
```

**Three main pieces:**

| Component | File | What it does |
|---|---|---|
| **Webhook** | `src/routes/slack.ts` | Receives Slack events, verifies HMAC signatures, deduplicates retries, triggers the background task |
| **AI Task** | `src/trigger/codebaseQA.ts` | Clones repos, runs an agentic loop (AI calls `read_file`, `grep_codebase`, `list_dir` iteratively), posts the answer back to Slack |
| **Config** | `src/config.ts` | Central place to define your repos, system prompt, model, and task settings |

The AI is given three tools and decides how to use them:
- **`read_file`** — reads a file with line numbers
- **`grep_codebase`** — searches across repos with ripgrep
- **`list_dir`** — lists directory contents

It typically does 3-8 tool calls per question: grepping to find relevant files, reading them, then synthesizing an answer.

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. **OAuth & Permissions** → add Bot Token Scopes:
   - `app_mentions:read`
   - `chat:write`
3. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`)
4. **Basic Information** → copy the **Signing Secret**
5. **Event Subscriptions** → Enable Events → set Request URL to `https://your-domain.com/api/slack/events`
6. **Subscribe to bot events** → add `app_mention`

### 2. Create a GitHub PAT

1. [github.com/settings/tokens](https://github.com/settings/tokens) → **Fine-grained tokens**
2. Select the repos you want the bot to search
3. Permissions: **Contents → Read-only**
4. Copy the token

### 3. Get a Gemini API Key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Create a key → copy it

### 4. Set Up Trigger.dev

1. Create an account at [trigger.dev](https://trigger.dev)
2. Create a project → copy the **Secret Key**
3. Update `trigger.config.ts` with your project ID

### 5. Configure Your Repos

Edit `src/config.ts` to list your repositories:

```typescript
export const REPOS: RepoConfig[] = [
  {
    fullName: 'yourorg/backend',
    shortName: 'backend',
    description: 'Node.js API server with Express and PostgreSQL.',
  },
  {
    fullName: 'yourorg/frontend',
    shortName: 'frontend',
    description: 'React app with Vite and TailwindCSS.',
  },
];
```

Customize the `buildSystemPrompt()` function to describe your codebase — the more context you give the AI about your repos, the better it performs.

### 6. Install & Run

```bash
cp .env.example .env
# Fill in all values in .env

npm install
npm run build

# In one terminal: start the Express server
npm start

# In another terminal: start the Trigger.dev worker
npm run trigger:dev
```

For local development, use [ngrok](https://ngrok.com) to expose your local server to Slack:

```bash
ngrok http 3000
# Use the ngrok URL as your Slack Event Subscription URL
```

### 7. Deploy

**Express server** — deploy anywhere that runs Node.js (Heroku, Railway, Fly.io, AWS, etc.). Set all env vars from `.env.example`.

**Trigger.dev worker** — deploy with:

```bash
npm run trigger:deploy
```

Set `SLACK_BOT_TOKEN`, `GITHUB_TOKEN`, and `GOOGLE_AI_STUDIO_API_KEY` as environment variables in your Trigger.dev dashboard (they run in the Trigger.dev cloud, not on your server).

## Key Decisions & Alternatives

### AI Provider: Gemini vs Anthropic vs OpenAI

**We chose:** Google Gemini (`gemini-2.5-flash`)

**Why:**
- Native function calling that works well for agentic tool-use loops
- `gemini-2.5-flash` is fast and cheap while still being capable enough for code comprehension
- Large context window handles big file reads without truncation issues

**Alternatives:**
- **Anthropic Claude** — excellent at code understanding, arguably the best at nuanced reasoning about code. You'd swap `@google/generative-ai` for Anthropic's SDK and convert `functionDeclarations` to Claude's `tools` format. Claude uses a different tool-calling protocol (XML-based tool use) but the concept is identical. Claude Sonnet would be a strong choice here.
- **OpenAI GPT-4o** — also supports function calling natively with a similar loop structure. The main differences are the SDK (`openai` package) and the function call format. GPT-4o is more expensive per token than Gemini Flash but very capable.
- **Self-hosted / Ollama** — possible with models that support tool calling (e.g., Llama 3.1+, Qwen2.5), but quality drops significantly for complex multi-hop code searches.

To switch providers, you'd primarily need to:
1. Swap the SDK and change `runAgenticLoop()` in `src/trigger/codebaseQA.ts`
2. Convert the `functionDeclarations` array to the provider's tool format
3. Adjust the response parsing (each provider returns function calls differently)

The tool implementations (`execReadFile`, `execGrep`, `execListDir`) and everything else stays the same.

### Background Tasks: Trigger.dev vs Lambda vs BullMQ

**We chose:** [Trigger.dev](https://trigger.dev)

**Why:**
- Zero infrastructure to manage — tasks run in their cloud
- Built-in logging, retry, and observability dashboard
- Easy to define tasks as TypeScript functions
- Generous free tier for low-volume usage
- The task needs up to 2 minutes (cloning + multiple AI round-trips), which is too long for a synchronous HTTP request but perfect for a background task

**Alternatives:**
- **AWS Lambda** — you'd replace the Trigger.dev task with a Lambda function invoked via SQS or direct invocation. Caveats: Lambda has a 15-min timeout (fine) but a 512MB `/tmp` limit (could be tight for large repos). You'd need to set up the Lambda, IAM roles, and deployment pipeline yourself. No built-in dashboard for monitoring task runs.
- **BullMQ + Redis** — a self-hosted job queue. Your Express server would enqueue the job, and a separate worker process would pick it up. More control and no third-party dependency, but you manage the worker processes, Redis, and monitoring yourself.
- **Inngest** — similar to Trigger.dev (managed background functions). Worth comparing pricing and feature sets. Very similar developer experience.
- **QStash (Upstash)** — lightweight HTTP-based queue. Good if your task can be expressed as an HTTP endpoint. Simpler than Trigger.dev but fewer built-in features.

### Hosting: Heroku vs Railway vs Fly.io

**We chose:** Heroku (for the Express server)

The Express server is stateless and lightweight — it just verifies signatures and triggers the task. Any Node.js host works. The actual heavy lifting (cloning, AI calls) happens in Trigger.dev's cloud.

**Alternatives:**
- **Railway** — similar to Heroku, one-click deploy from GitHub, generous free tier
- **Fly.io** — edge deployment, great for latency-sensitive apps (not critical here since Slack is async)
- **Vercel** — if you converted the Express route to a serverless function. Works but adds cold-start latency.
- **Self-hosted (VPS)** — cheapest option, most control, most ops work

### Code Search: ripgrep vs GitHub API vs Embeddings

**We chose:** Clone repos + search locally with ripgrep

**Why:**
- Full control over search — the AI can read any file, search with regex, list directories
- No rate limits or API quotas (beyond the initial clone)
- Works with private repos using a PAT
- ripgrep is extremely fast (sub-second searches on large codebases)
- Shallow clone (`--depth 1`) keeps clone times reasonable

**Alternatives:**
- **GitHub Code Search API** — no cloning needed, but limited to public repos (or GitHub Enterprise), slower, and the AI can't read arbitrary files. Rate limits can be an issue.
- **Pre-built vector embeddings** — embed your codebase into a vector DB (Pinecone, Chroma, Weaviate) and do semantic search. Better for "fuzzy" questions but requires maintaining an embedding pipeline. More infrastructure complexity. Could be combined with the current approach for a hybrid search.
- **Language server / AST analysis** — parse the code structurally instead of text search. Much more sophisticated but dramatically more complex to build and maintain.

### Deduplication: In-Memory vs Redis

**We chose:** In-memory `Map` (with an upgrade path to Redis)

This project ships with a simple in-memory cache for deduplication. It works fine for a single-instance deployment. If you scale to multiple instances, switch to Redis `SET ... NX`:

```typescript
const redis = getRedisClient();
const wasSet = await redis.set(`slack-qa-dedup:${eventId}`, '1', { NX: true, EX: 300 });
if (!wasSet) return; // duplicate
```

### Security Decisions

- **Slack signature verification** — HMAC-SHA256 with timing-safe comparison. Never skip this in production. The `SLACK_SKIP_VERIFICATION` escape hatch exists only for local development.
- **Path traversal protection** — `path.relative()` checks prevent the AI's tool calls from reading files outside the cloned repos (e.g., `../../etc/passwd`).
- **Command injection prevention** — `execFileSync` with argument arrays instead of `execSync` with string interpolation. The AI controls the arguments, so this is critical.
- **Token hygiene** — `GITHUB_TOKEN` is passed via `GIT_ASKPASS` (not embedded in the clone URL) and redacted from any error messages before they reach Slack.

## Cost Estimate

For a team of ~10 asking ~20 questions/day:

| Service | Monthly cost |
|---|---|
| Gemini Flash API | ~$2-5 (very cheap per call) |
| Trigger.dev | Free tier covers this |
| Heroku / Railway | $5-7 (basic dyno/plan) |
| **Total** | **~$7-12/month** |

## Project Structure

```
ai-slack-god/
├── src/
│   ├── config.ts              # Repos, system prompt, model settings
│   ├── server.ts              # Express server entry point
│   ├── routes/
│   │   └── slack.ts           # Slack webhook handler
│   ├── services/
│   │   └── slackClient.ts     # Slack Web API wrapper
│   └── trigger/
│       └── codebaseQA.ts      # Trigger.dev task (clone + AI loop)
├── trigger.config.ts          # Trigger.dev project config
├── .env.example               # Required environment variables
├── package.json
└── tsconfig.json
```

## Troubleshooting

**Bot doesn't respond:**
- Check that Event Subscriptions are enabled and the URL is verified
- Verify `app_mentions:read` and `chat:write` scopes are added
- Check your Express server logs for incoming requests
- Make sure the bot is invited to the channel (`/invite @botname`)

**"no_text" error:**
- The AI returned an empty response. The bot has a fallback for this, but if it persists, check your `GOOGLE_AI_STUDIO_API_KEY` and that the model name in `config.ts` is valid.

**Clone failures:**
- Verify `GITHUB_TOKEN` has `Contents: Read` on all repos listed in `config.ts`
- Check that repo names in `config.ts` match exactly (case-sensitive)

**Trigger.dev task not running:**
- Ensure `TRIGGER_SECRET_KEY` is set on your Express server
- Run `npm run trigger:dev` locally or `npm run trigger:deploy` for production
- Set `SLACK_BOT_TOKEN`, `GITHUB_TOKEN`, and `GOOGLE_AI_STUDIO_API_KEY` in Trigger.dev's environment variables
