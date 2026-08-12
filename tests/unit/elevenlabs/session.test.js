import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSession } from '../../../src/elevenlabs/session.js';

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
  }
  send(msg) { this.sent.push(msg); }
  close() { this.emit('close'); }
  simulateOpen() { this.readyState = 1; this.emit('open'); }
  simulateMessage(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

describe('elevenlabs session', () => {
  it('sends conversation_initiation_client_data on open and resolves with conversation id', async () => {
    const ws = new FakeWs();
    const session = createSession({
      url: 'wss://example',
      apiKey: 'xi',
      agentId: 'a1',
      wsFactory: () => ws,
    });

    const openPromise = session.open({ twilioConversationSid: 'CH1' });
    ws.simulateOpen();
    ws.simulateMessage({ type: 'conversation_initiation_metadata', conversation_id: 'conv_1' });

    const result = await openPromise;
    expect(result.elevenlabsConversationId).toBe('conv_1');

    const init = JSON.parse(ws.sent[0]);
    expect(init.type).toBe('conversation_initiation_client_data');
    expect(init.dynamic_variables.twilioConversationSid).toBe('CH1');
  });

  it('routes agent_response and tool_call events to subscribers', async () => {
    const ws = new FakeWs();
    const session = createSession({
      url: 'wss://example', apiKey: 'xi', agentId: 'a1', wsFactory: () => ws,
    });
    const openPromise = session.open({});
    ws.simulateOpen();
    ws.simulateMessage({ type: 'conversation_initiation_metadata', conversation_id: 'conv_1' });
    await openPromise;

    const responses = [];
    const tools = [];
    session.onAgentResponse((r) => responses.push(r));
    session.onToolCall((t) => tools.push(t));

    ws.simulateMessage({ type: 'agent_response', agent_response_event: { agent_response: 'hi' } });
    ws.simulateMessage({ type: 'client_tool_call', client_tool_call: { tool_name: 'escalate_to_flex', tool_call_id: 't1', parameters: {} } });

    expect(responses).toEqual(['hi']);
    expect(tools[0].tool_name).toBe('escalate_to_flex');
  });

  it('replies to ping frames with pong', async () => {
    const ws = new FakeWs();
    const session = createSession({
      url: 'wss://example', apiKey: 'xi', agentId: 'a1', wsFactory: () => ws,
    });
    const openPromise = session.open({});
    ws.simulateOpen();
    ws.simulateMessage({ type: 'conversation_initiation_metadata', conversation_id: 'conv_1' });
    await openPromise;
    ws.sent.length = 0;

    ws.simulateMessage({ type: 'ping', ping_event: { event_id: 42 } });
    const reply = JSON.parse(ws.sent[0]);
    expect(reply).toEqual({ type: 'pong', event_id: 42 });
  });
});
