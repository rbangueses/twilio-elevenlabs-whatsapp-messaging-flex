export function createSessionManager({ sessionFactory, idleTimeoutMs }) {
  const sessions = new Map();
  const timers = new Map();

  function armIdleTimer(sid) {
    clearTimeout(timers.get(sid));
    const t = setTimeout(() => {
      const s = sessions.get(sid);
      if (s) {
        s.close();
        sessions.delete(sid);
      }
      timers.delete(sid);
    }, idleTimeoutMs);
    timers.set(sid, t);
  }

  return {
    async getOrOpen({ conversationSid, dynamicVariables }) {
      let session = sessions.get(conversationSid);
      if (session) {
        armIdleTimer(conversationSid);
        return session;
      }
      session = sessionFactory({ conversationSid });
      await session.open(dynamicVariables);
      const wrappedSend = session.sendUserMessage.bind(session);
      session.sendUserMessage = (text) => {
        armIdleTimer(conversationSid);
        wrappedSend(text);
      };
      sessions.set(conversationSid, session);
      armIdleTimer(conversationSid);
      return session;
    },

    close(conversationSid) {
      const s = sessions.get(conversationSid);
      if (s) {
        s.close();
        sessions.delete(conversationSid);
      }
      clearTimeout(timers.get(conversationSid));
      timers.delete(conversationSid);
    },

    size() { return sessions.size; },
  };
}
