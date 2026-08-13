import { describe, it, expect, vi } from 'vitest';
import { createConversationsClient } from '../../../src/twilio/conversations.js';

function mockTwilio({ participantsCreate, messagesCreate }) {
  return {
    conversations: {
      v1: {
        conversations: (sid) => ({
          participants: { create: participantsCreate },
          messages: { create: messagesCreate },
          _sid: sid,
        }),
      },
    },
  };
}

function mockTwilioWithService({ participantsCreate, messagesCreate, serviceSid }) {
  const serviceConversations = vi.fn((sid) => ({
    participants: { create: participantsCreate },
    messages: { create: messagesCreate },
    _sid: sid,
  }));
  const services = vi.fn((sid) => ({
    conversations: serviceConversations,
    _sid: sid,
  }));
  return {
    twilioClient: {
      conversations: {
        v1: {
          services,
          conversations: vi.fn(() => { throw new Error('should not use default path when serviceSid provided'); }),
        },
      },
    },
    services,
    serviceConversations,
  };
}

describe('conversations client', () => {
  it('ensures the bot participant once and swallows 409', async () => {
    const err = Object.assign(new Error('exists'), { status: 409, code: 50433 });
    const participantsCreate = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ sid: 'MB1' });
    const client = createConversationsClient({
      twilioClient: mockTwilio({ participantsCreate, messagesCreate: vi.fn() }),
      botIdentity: 'bot',
    });

    await client.ensureBotParticipant('CH1');
    await client.ensureBotParticipant('CH2');
    expect(participantsCreate).toHaveBeenCalledTimes(2);
    expect(participantsCreate.mock.calls[0][0]).toEqual({ identity: 'bot' });
  });

  it('writes a bot message with the bot identity as author', async () => {
    const messagesCreate = vi.fn().mockResolvedValue({ sid: 'IM1' });
    const client = createConversationsClient({
      twilioClient: mockTwilio({
        participantsCreate: vi.fn().mockResolvedValue({}),
        messagesCreate,
      }),
      botIdentity: 'bot',
    });

    const sid = await client.writeBotMessage({
      conversationSid: 'CH1',
      body: 'hello',
      correlationId: 'c1',
    });

    expect(sid).toBe('IM1');
    expect(messagesCreate).toHaveBeenCalledWith({
      author: 'bot',
      body: 'hello',
    });
  });

  it('routes through .services(sid) when conversationsServiceSid is provided — ensureBotParticipant', async () => {
    const participantsCreate = vi.fn().mockResolvedValue({ sid: 'MB2' });
    const messagesCreate = vi.fn();
    const { twilioClient, services, serviceConversations } = mockTwilioWithService({
      participantsCreate,
      messagesCreate,
      serviceSid: 'IS_test',
    });
    const client = createConversationsClient({
      twilioClient,
      botIdentity: 'bot',
      conversationsServiceSid: 'IS_test',
    });

    await client.ensureBotParticipant('CH1');

    expect(services).toHaveBeenCalledWith('IS_test');
    expect(serviceConversations).toHaveBeenCalledWith('CH1');
    expect(participantsCreate).toHaveBeenCalledWith({ identity: 'bot' });
  });

  it('routes through .services(sid) when conversationsServiceSid is provided — writeBotMessage', async () => {
    const messagesCreate = vi.fn().mockResolvedValue({ sid: 'IM2' });
    const { twilioClient, services, serviceConversations } = mockTwilioWithService({
      participantsCreate: vi.fn(),
      messagesCreate,
      serviceSid: 'IS_test',
    });
    const client = createConversationsClient({
      twilioClient,
      botIdentity: 'bot',
      conversationsServiceSid: 'IS_test',
    });

    const sid = await client.writeBotMessage({ conversationSid: 'CH1', body: 'hi' });

    expect(sid).toBe('IM2');
    expect(services).toHaveBeenCalledWith('IS_test');
    expect(serviceConversations).toHaveBeenCalledWith('CH1');
    expect(messagesCreate).toHaveBeenCalledWith({ author: 'bot', body: 'hi' });
  });
});
