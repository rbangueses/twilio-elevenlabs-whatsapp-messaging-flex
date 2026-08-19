import { describe, it, expect } from 'vitest';
import {
  buildAgentCreatePayload,
  resolveRelayHost,
  runCreateWhatsAppAgent,
} from '../../../scripts/create-whatsapp-agent.js';

describe('create WhatsApp agent script', () => {
  it('builds a WhatsApp-only agent payload with only the created tool id attached', () => {
    const payload = buildAgentCreatePayload({
      name: 'Acme Support WhatsApp',
      prompt: 'You are concise.',
      toolId: 'tool_123',
      llm: 'gemini-2.0-flash',
    });

    expect(payload).toEqual({
      name: 'Acme Support WhatsApp',
      tags: ['twilio', 'whatsapp', 'flex'],
      conversation_config: {
        agent: {
          prompt: {
            prompt: 'You are concise.',
            llm: 'gemini-2.0-flash',
            tool_ids: ['tool_123'],
          },
        },
      },
    });
    expect(payload.conversation_config.agent.prompt.tools).toBeUndefined();
  });

  it('resolves relay host from explicit value, RELAY_HOST, then PUBLIC_BASE_URL', () => {
    expect(resolveRelayHost({ relayHost: 'example.ngrok.app', env: {} })).toBe('example.ngrok.app');
    expect(resolveRelayHost({ env: { RELAY_HOST: 'env.ngrok.app' } })).toBe('env.ngrok.app');
    expect(resolveRelayHost({ env: { PUBLIC_BASE_URL: 'https://base.ngrok.app' } })).toBe('base.ngrok.app');
  });

  it('creates env vars, the WhatsApp tool, and a fresh WhatsApp-only agent', async () => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({
        url: url.toString(),
        method: options.method ?? 'GET',
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      if (url.toString().endsWith('/environment-variables') && !options.method) {
        return jsonResponse({ environment_variables: [] });
      }
      if (url.toString().endsWith('/secrets')) {
        return jsonResponse({ secret_id: 'secret_123' });
      }
      if (url.toString().endsWith('/environment-variables')) {
        return jsonResponse({ ok: true });
      }
      if (url.toString().endsWith('/tools')) {
        return jsonResponse({ id: 'tool_123' });
      }
      if (url.toString().endsWith('/agents/create')) {
        return jsonResponse({ agent_id: 'agent_123' });
      }
      throw new Error(`unexpected call: ${url}`);
    };

    const result = await runCreateWhatsAppAgent({
      apiKey: 'xi_test',
      handoffToken: 'handoff_secret',
      relayHost: 'example.ngrok.app',
      promptPath: 'examples/elevenlabs/agent-prompt-whatsapp.md',
      toolPath: 'examples/elevenlabs/escalate-to-flex-tool.example.json',
      name: 'Acme Support WhatsApp',
      fetchImpl,
      log: () => {},
    });

    expect(result).toEqual({
      agentId: 'agent_123',
      toolId: 'tool_123',
      createdRelayHostEnv: true,
      createdRelayAuthorizationEnv: true,
    });

    const agentCall = calls.find((call) => call.url.endsWith('/agents/create'));
    expect(agentCall.body.conversation_config.agent.prompt.tool_ids).toEqual(['tool_123']);
    expect(agentCall.body.conversation_config.agent.prompt.tools).toBeUndefined();
    expect(JSON.stringify(agentCall.body)).not.toContain('parent_call_sid');
  });
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}
