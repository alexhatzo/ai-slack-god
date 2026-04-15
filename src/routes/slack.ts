import crypto from 'crypto';
import express from 'express';
import { tasks } from '@trigger.dev/sdk/v3';
import { postThreadReply } from '../services/slackClient.js';
import { TASK_CONFIG } from '../config.js';

export const slackRouter = express.Router();

const DEDUP_CACHE = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000;

function pruneCache() {
  const now = Date.now();
  for (const [key, ts] of DEDUP_CACHE) {
    if (now - ts > DEDUP_TTL_MS) DEDUP_CACHE.delete(key);
  }
}

function verifySlackSignature(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!signingSecret) {
    if (process.env.NODE_ENV !== 'production' && process.env.SLACK_SKIP_VERIFICATION === 'true') {
      console.warn('[SLACK] Skipping signature verification (SLACK_SKIP_VERIFICATION=true)');
      next();
      return;
    }
    console.error('[SLACK] SLACK_SIGNING_SECRET not set — rejecting');
    res.status(401).json({ error: 'Signing secret not configured' });
    return;
  }

  const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
  const slackSig = req.headers['x-slack-signature'] as string | undefined;

  if (!timestamp || !slackSig) {
    res.status(401).json({ error: 'Missing signature' });
    return;
  }

  if (Number(timestamp) < Math.floor(Date.now() / 1000) - 300) {
    res.status(401).json({ error: 'Request too old' });
    return;
  }

  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!rawBody) {
    res.status(500).json({ error: 'Cannot verify signature' });
    return;
  }

  const baseString = `v0:${timestamp}:${rawBody.toString('utf8')}`;
  const computed = `v0=${crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex')}`;

  const computedBuf = Buffer.from(computed);
  const sigBuf = Buffer.from(slackSig);

  if (computedBuf.length !== sigBuf.length || !crypto.timingSafeEqual(computedBuf, sigBuf)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  next();
}

slackRouter.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

slackRouter.post('/events', verifySlackSignature, async (req, res) => {
  const { type } = req.body;

  if (type === 'url_verification') {
    res.json({ challenge: req.body.challenge });
    return;
  }

  if (type !== 'event_callback') {
    res.status(200).send();
    return;
  }

  const event = req.body.event;
  if (event?.type !== 'app_mention') {
    res.status(200).send();
    return;
  }

  // Ack immediately — Slack retries if no 200 within 3 s
  res.status(200).send();

  if (typeof event.text !== 'string' || !event.text.trim()) return;

  const question = event.text.replace(/^<@[A-Z0-9]+>\s*/i, '').trim();
  if (!question) return;

  // In-memory dedup (replace with Redis SET NX if you have Redis)
  const eventId = req.body.event_id || event.ts;
  pruneCache();
  if (DEDUP_CACHE.has(eventId)) {
    console.log(`[SLACK] Duplicate event ${eventId} — skipping`);
    return;
  }
  DEDUP_CACHE.set(eventId, Date.now());

  console.log(`[SLACK] Triggering ${TASK_CONFIG.id}`, { question: question.slice(0, 80) });

  try {
    await tasks.trigger(TASK_CONFIG.id, {
      question,
      channel: event.channel,
      threadTs: event.thread_ts || event.ts,
      user: event.user,
    });
  } catch (err) {
    console.error('[SLACK] Failed to trigger task', err);
    try {
      await postThreadReply(
        event.channel,
        event.thread_ts || event.ts,
        "Sorry — I couldn't process your request right now.",
      );
    } catch { /* best-effort */ }
  }
});
