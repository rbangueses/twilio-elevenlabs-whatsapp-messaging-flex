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
});
