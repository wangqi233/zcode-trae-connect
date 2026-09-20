import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { anthropicToOpenAIMessages, llmUtilsChunkToAnthropic } = require('../../src/anthropic-format');

const imgBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
};

describe('anthropicToOpenAIMessages image handling', () => {
  it('preserves image blocks as structured array content', () => {
    const out = anthropicToOpenAIMessages([
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, imgBlock] },
    ]);
    expect(out).toHaveLength(1);
    expect(Array.isArray(out[0].content)).toBe(true);
    expect(out[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
  });

  it('image-only message produces array without empty text part', () => {
    const out = anthropicToOpenAIMessages([{ role: 'user', content: [imgBlock] }]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
  });

  it('text-only content stays a plain string (no regression)', () => {
    const out = anthropicToOpenAIMessages([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(out[0].content).toBe('hello');
  });

  it('plain string content passes through unchanged', () => {
    const out = anthropicToOpenAIMessages([{ role: 'user', content: 'hi' }]);
    expect(out[0].content).toBe('hi');
  });

  it('tool_use and tool_result still convert alongside images', () => {
    const out = anthropicToOpenAIMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          imgBlock,
        ],
      },
    ]);
    expect(out[0].role).toBe('assistant');
    expect(out[0].content).toContain('let me check');
    expect(out[0].content).toContain('<toolcall>');
    // tool_result becomes its own user message; image stays with the user message
    const toolResultMsg = out.find(m => typeof m.content === 'string' && m.content.includes('<tool_result'));
    expect(toolResultMsg).toBeTruthy();
    expect(toolResultMsg.content).toContain('for="t1"');
    const imgMsg = out.find(m => Array.isArray(m.content));
    expect(imgMsg.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
  });
});

describe('llmUtilsChunkToAnthropic stop_reason mapping', () => {
  it('maps finish_reason length to max_tokens', () => {
    const r = llmUtilsChunkToAnthropic({ type: 'done', finish_reason: 'length' }, 'msg_t1', 'glm-5.2', null);
    expect(r.state.stopReason).toBe('max_tokens');
  });

  it('maps finish_reason max_tokens to max_tokens', () => {
    const r = llmUtilsChunkToAnthropic({ type: 'done', finish_reason: 'max_tokens' }, 'msg_t2', 'glm-5.2', null);
    expect(r.state.stopReason).toBe('max_tokens');
  });

  it('keeps end_turn for normal stop', () => {
    const r = llmUtilsChunkToAnthropic({ type: 'done', finish_reason: 'stop' }, 'msg_t3', 'glm-5.2', null);
    expect(r.state.stopReason).toBe('end_turn');
  });
});
