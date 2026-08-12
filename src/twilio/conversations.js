const PARTICIPANT_EXISTS = new Set([50433, 50438]);

export function createConversationsClient({ twilioClient, botIdentity }) {
  function conv(sid) {
    return twilioClient.conversations.v1.conversations(sid);
  }

  return {
    async ensureBotParticipant(conversationSid) {
      try {
        await conv(conversationSid).participants.create({ identity: botIdentity });
      } catch (err) {
        if (err.status === 409 || PARTICIPANT_EXISTS.has(err.code)) return;
        throw err;
      }
    },

    async writeBotMessage({ conversationSid, body }) {
      const message = await conv(conversationSid).messages.create({
        author: botIdentity,
        body,
      });
      return message.sid;
    },
  };
}
