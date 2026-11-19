import http from 'node:http';

const windows = new Map();

function limitOf(key) {
  const match = /^sk-limit-(\d+)/.exec(key);
  return match ? Number(match[1]) : 0;
}

function allow(key) {
  const limit = limitOf(key);
  if (!limit) return true;
  const now = Date.now();
  const hits = (windows.get(key) || []).filter((t) => now - t < 60000);
  if (hits.length >= limit) {
    windows.set(key, hits);
    return false;
  }
  hits.push(now);
  windows.set(key, hits);
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res, status, payload, extra = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    ...extra
  });
  res.end(body);
}

export function startMock(port = 9101) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers.authorization || '';
    const key = auth.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';

    if (!key) return json(res, 401, { error: { message: 'missing key' } });
    if (key.startsWith('sk-bad')) {
      return json(res, 401, { error: { message: 'invalid api key' } });
    }
    if (key.startsWith('sk-500')) {
      return json(res, 500, { error: { message: 'internal error' } });
    }

    if (url.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: [{ id: 'mock-model' }] });
    }

    const body = JSON.parse((await readBody(req)) || '{}');

    if (!allow(key)) {
      return json(res, 429, { error: { message: 'rate limit' } }, { 'retry-after': '2' });
    }

    const delay = Number(process.env.MOCK_DELAY || 15);
    await new Promise((r) => setTimeout(r, delay));

    const prompt = JSON.stringify(body.messages || []).length;
    const text = `echo:${body.model}:${prompt}`;

    if (url.pathname === '/v1/messages') {
      const anthropic = {
        id: 'msg_mock' + Math.random().toString(36).slice(2, 8),
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: Math.ceil(prompt / 4), output_tokens: 12 }
      };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...anthropic, content: [] } })}\n\n`
        );
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text }
          })}\n\n`
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 12 }
          })}\n\n`
        );
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        res.end();
        return;
      }
      return json(res, 200, anthropic);
    }

    if (url.pathname === '/v1/chat/completions') {
      const completion = {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: Math.ceil(prompt / 4), completion_tokens: 12, total_tokens: Math.ceil(prompt / 4) + 12 }
      };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish = null) =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }]
          })}\n\n`;
        res.write(chunk({ role: 'assistant', content: '' }));
        for (const piece of text.match(/.{1,6}/g) || []) {
          res.write(chunk({ content: piece }));
        }
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: Math.ceil(prompt / 4), completion_tokens: 12 }
          })}\n\n`
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      return json(res, 200, completion);
    }

    return json(res, 404, { error: { message: 'not found' } });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMock(Number(process.env.PORT || 9101)).then((s) => {
    console.log('mock upstream on', s.address().port);
  });
}