import { describe, it, expect, vi } from 'vitest';
import { createFlexClient } from '../../../src/handoff/flex.js';

describe('flex client', () => {
  it('POSTs the canonical Interaction shape and returns interaction+task sids', async () => {
    const create = vi.fn().mockResolvedValue({
      sid: 'KDinteraction',
      routing: { properties: { sid: 'WTtaskSid' } },
    });
    const twilioClient = { flexApi: { v1: { interaction: { create } } } };
    const client = createFlexClient({
      twilioClient,
      flexConfig: {
        workspaceSid: 'WSx',
        workflowSid: 'WWx',
        taskChannelUniqueName: 'chat',
      },
    });

    const result = await client.createInteraction({
      conversationSid: 'CH1',
      customerAddress: 'whatsapp:+15551234567',
      businessAddress: 'whatsapp:+14155238886',
      intent: 'billing_dispute',
      reason: 'explicit_human_request',
      summary: 'Customer disputes charge.',
      elevenlabsConversationId: 'conv_1',
      handoffId: 'handoff_CH1_1',
    });

    expect(result).toEqual({ interactionSid: 'KDinteraction', taskSid: 'WTtaskSid' });
    const [args] = create.mock.calls[0];
    expect(args.channel.type).toBe('whatsapp');
    expect(args.channel.initiated_by).toBe('customer');
    expect(args.channel.properties.media_channel_sid).toBe('CH1');
    const attrs = args.routing.properties.attributes;
    expect(attrs).toEqual({
      channelType: 'whatsapp',
      direction: 'inbound',
      name: 'whatsapp:+15551234567',
      from: 'whatsapp:+15551234567',
      customerAddress: 'whatsapp:+15551234567',
      customerName: 'whatsapp:+15551234567',
      businessAddress: 'whatsapp:+14155238886',
      conversationSid: 'CH1',
      elevenlabsConversationId: 'conv_1',
      handoffId: 'handoff_CH1_1',
      reason: 'explicit_human_request',
      intent: 'billing_dispute',
      summary: 'Customer disputes charge.',
    });
  });

  it('omits elevenlabsConversationId when not provided', async () => {
    const create = vi.fn().mockResolvedValue({
      sid: 'KDx',
      routing: { properties: { sid: 'WTx' } },
    });
    const twilioClient = { flexApi: { v1: { interaction: { create } } } };
    const client = createFlexClient({
      twilioClient,
      flexConfig: { workspaceSid: 'WSx', workflowSid: 'WWx', taskChannelUniqueName: 'chat' },
    });
    await client.createInteraction({
      conversationSid: 'CH1',
      customerAddress: 'whatsapp:+15551234567',
      businessAddress: 'whatsapp:+14155238886',
      intent: 'x', reason: 'y', summary: 'z',
      handoffId: 'h1',
    });
    const attrs = create.mock.calls[0][0].routing.properties.attributes;
    expect('elevenlabsConversationId' in attrs).toBe(false);
  });

  it('passes numeric priority through to the interaction attributes', async () => {
    const create = vi.fn().mockResolvedValue({ sid: 'KDx', routing: { properties: { sid: 'WTx' } } });
    const twilioClient = { flexApi: { v1: { interaction: { create } } } };
    const client = createFlexClient({
      twilioClient,
      flexConfig: { workspaceSid: 'WSx', workflowSid: 'WWx', taskChannelUniqueName: 'chat' },
    });
    await client.createInteraction({
      conversationSid: 'CH1',
      customerAddress: 'whatsapp:+15551234567',
      businessAddress: 'whatsapp:+14155238886',
      intent: 'x', reason: 'y', summary: 'z',
      handoffId: 'h1',
      priority: 8,
    });
    const attrs = create.mock.calls[0][0].routing.properties.attributes;
    expect(attrs.priority).toBe(8);
  });
});
