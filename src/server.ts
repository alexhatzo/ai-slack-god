import express from 'express';
import { slackRouter } from './routes/slack.js';

const app = express();
const port = process.env.PORT || 3000;

// Mount Slack route BEFORE global JSON parser so it can capture raw body
// for HMAC signature verification.
app.use('/api/slack', slackRouter);

app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
