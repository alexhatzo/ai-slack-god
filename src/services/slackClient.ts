import { WebClient } from '@slack/web-api';

let _client: WebClient | null = null;

function getClient(): WebClient {
  if (!_client) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error('SLACK_BOT_TOKEN is not set');
    _client = new WebClient(token);
  }
  return _client;
}

export async function postThreadReply(
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  const client = getClient();
  const safeText = text?.trim() || 'Sorry, I couldn\u2019t generate a response.';
  await client.chat.postMessage({ channel, thread_ts: threadTs, text: safeText });
}
