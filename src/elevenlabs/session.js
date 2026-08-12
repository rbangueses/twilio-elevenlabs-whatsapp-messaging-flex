export function createSession({ url, apiKey, agentId, wsFactory }) {
  const listeners = { agentResponse: [], toolCall: [], close: [] };
  let ws = null;
  let elevenlabsConversationId = null;

  function emit(kind, payload) {
    for (const l of listeners[kind]) l(payload);
  }

  return {
    open(dynamicVariables = {}) {
      const target = `${url}?agent_id=${encodeURIComponent(agentId)}`;
      ws = wsFactory(target, { headers: { 'xi-api-key': apiKey } });

      return new Promise((resolve, reject) => {
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'conversation_initiation_client_data',
              dynamic_variables: dynamicVariables,
            }),
          );
        });

        ws.on('message', (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          switch (msg.type) {
            case 'conversation_initiation_metadata':
              elevenlabsConversationId = msg.conversation_id;
              resolve({ elevenlabsConversationId });
              return;
            case 'ping':
              ws.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event.event_id }));
              return;
            case 'agent_response':
              emit('agentResponse', msg.agent_response_event.agent_response);
              return;
            case 'client_tool_call':
              emit('toolCall', msg.client_tool_call);
              return;
          }
        });

        ws.on('close', () => emit('close'));
        ws.on('error', (err) => reject(err));
      });
    },

    sendUserMessage(text) {
      if (!ws) throw new Error('session not open');
      ws.send(JSON.stringify({ type: 'user_message', text }));
    },

    onAgentResponse(fn) { listeners.agentResponse.push(fn); },
    onToolCall(fn) { listeners.toolCall.push(fn); },
    onClose(fn) { listeners.close.push(fn); },
    close() { ws?.close(); },
    get conversationId() { return elevenlabsConversationId; },
  };
}
