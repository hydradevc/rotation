function safeParse(value) {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { _raw: value };
  }
}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.type === 'input_text') return part.text || '';
        return '';
      })
      .join('\n');
  }
  return String(content);
}

function openAIContentToBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content) }];
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push({ type: 'text', text: part });
    } else if (part?.type === 'text' || part?.type === 'input_text') {
      blocks.push({ type: 'text', text: part.text || '' });
    } else if (part?.type === 'image_url') {
      const url = part.image_url?.url || '';
      const match = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (match) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      } else if (url) {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}

function anthropicBlockToOpenAIContent(blocks) {
  const parts = [];
  for (const block of blocks || []) {
    if (block?.type === 'text') parts.push({ type: 'text', text: block.text || '' });
    else if (block?.type === 'image') {
      if (block.source?.type === 'base64') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
        });
      } else if (block.source?.url) {
        parts.push({ type: 'image_url', image_url: { url: block.source.url } });
      }
    }
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

function mergeConsecutive(messages) {
  const out = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content.push(...msg.content);
    } else {
      out.push({ role: msg.role, content: [...msg.content] });
    }
  }
  return out;
}

export function openaiToAnthropic(body) {
  const out = { model: body.model };
  const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? 4096;
  out.max_tokens = maxTokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.metadata?.user_id) out.metadata = { user_id: body.metadata.user_id };

  const systemParts = [];
  const messages = [];

  for (const msg of body.messages || []) {
    if (msg.role === 'system' || msg.role === 'developer') {
      systemParts.push(textOf(msg.content));
      continue;
    }
    if (msg.role === 'tool' || msg.role === 'function') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || msg.name, content: textOf(msg.content) }]
      });
      continue;
    }
    const content = openAIContentToBlocks(msg.content);
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name || call.name || 'tool',
          input: safeParse(call.function?.arguments ?? call.arguments)
        });
      }
    }
    messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content });
  }

  out.messages = mergeConsecutive(messages);
  if (systemParts.length) out.system = systemParts.join('\n\n');
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t.type === 'function' || t.function)
      .map((t) => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || '',
        input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} }
      }));
    if (body.tool_choice) {
      const choice = body.tool_choice;
      if (choice === 'auto') out.tool_choice = { type: 'auto' };
      else if (choice === 'required') out.tool_choice = { type: 'any' };
      else if (choice === 'none') out.tool_choice = { type: 'none' };
      else if (choice.function?.name) out.tool_choice = { type: 'tool', name: choice.function.name };
    }
  }
  if (body.stream) out.stream = true;
  return out;
}

export function anthropicToOpenAI(body) {
  const out = { model: body.model };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;

  const messages = [];
  if (body.system) {
    messages.push({ role: 'system', content: textOf(body.system) });
  }
  for (const msg of body.messages || []) {
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    if (msg.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const block of blocks) {
        if (block?.type === 'text') textParts.push(block.text || '');
        else if (block?.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
          });
        }
      }
      const message = { role: 'assistant', content: textParts.join('\n') || null };
      if (toolCalls.length) message.tool_calls = toolCalls;
      messages.push(message);
      continue;
    }
    const userParts = [];
    const toolResults = [];
    for (const block of blocks) {
      if (block?.type === 'tool_result') {
        toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content: textOf(block.content) });
      } else if (block?.type === 'text' || block?.type === 'image') {
        userParts.push(block);
      }
    }
    if (toolResults.length) messages.push(...toolResults);
    if (userParts.length) messages.push({ role: 'user', content: anthropicBlockToOpenAIContent(userParts) });
  }
  out.messages = messages;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} }
    }));
    const choice = body.tool_choice;
    if (choice?.type === 'auto') out.tool_choice = 'auto';
    else if (choice?.type === 'any') out.tool_choice = 'required';
    else if (choice?.type === 'tool') out.tool_choice = { type: 'function', function: { name: choice.name } };
  }
  if (body.stream) out.stream = true;
  return out;
}

const FINISH_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn'
};

export function openaiResponseToAnthropic(o, model) {
  const choice = o.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  for (const call of message.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function?.name || 'tool',
      input: safeParse(call.function?.arguments)
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: o.id?.startsWith('msg_') ? o.id : 'msg_' + Math.random().toString(36).slice(2, 14),
    type: 'message',
    role: 'assistant',
    model: o.model || model,
    content,
    stop_reason: FINISH_MAP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: o.usage?.prompt_tokens ?? 0,
      output_tokens: o.usage?.completion_tokens ?? 0
    }
  };
}

export function anthropicResponseToOpenAI(a, model) {
  const text = (a.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolCalls = (a.content || [])
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
    }));
  const finish =
    a.stop_reason === 'max_tokens'
      ? 'length'
      : a.stop_reason === 'tool_use'
        ? 'tool_calls'
        : 'stop';
  const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: 'chatcmpl-' + String(a.id || '').replace(/^msg_/, '').slice(0, 24),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: a.model || model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: a.usage?.input_tokens ?? 0,
      completion_tokens: a.usage?.output_tokens ?? 0,
      total_tokens: (a.usage?.input_tokens ?? 0) + (a.usage?.output_tokens ?? 0)
    }
  };
}

export function syntheticAnthropicStream(anthropic, model) {
  const events = [];
  const msgId = anthropic.id;
  events.push(
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: anthropic.model || model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: anthropic.usage?.input_tokens ?? 0, output_tokens: 0 }
      }
    })}\n\n`
  );
  let index = 0;
  for (const block of anthropic.content || []) {
    if (block.type === 'text') {
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' }
        })}\n\n`
      );
      if (block.text) {
        events.push(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: block.text }
          })}\n\n`
        );
      }
      events.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
      index += 1;
    } else if (block.type === 'tool_use') {
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
        })}\n\n`
      );
      events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }
        })}\n\n`
      );
      events.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
      index += 1;
    }
  }
  events.push(
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: anthropic.stop_reason || 'end_turn', stop_sequence: null },
      usage: { output_tokens: anthropic.usage?.output_tokens ?? 0 }
    })}\n\n`
  );
  events.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  return events.join('');
}

export function syntheticOpenAIStream(openai, model) {
  const choice = openai.choices?.[0] || {};
  const message = choice.message || {};
  const id = openai.id || 'chatcmpl-' + Math.random().toString(36).slice(2, 12);
  const created = openai.created || Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model: openai.model || model };
  const events = [];
  events.push(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: message.content || '' }, finish_reason: null }]
    })}\n\n`
  );
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((call, i) => {
      events.push(
        `data: ${JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: i,
                    id: call.id,
                    type: 'function',
                    function: { name: call.function?.name, arguments: call.function?.arguments }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        })}\n\n`
      );
    });
  }
  events.push(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }],
      usage: openai.usage
    })}\n\n`
  );
  events.push('data: [DONE]\n\n');
  return events.join('');
}