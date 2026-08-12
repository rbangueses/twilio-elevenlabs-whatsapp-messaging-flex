export function createFlexClient({ twilioClient, flexConfig }) {
  return {
    async createInteraction({
      conversationSid,
      customerAddress,
      businessAddress,
      intent,
      reason,
      summary,
      elevenlabsConversationId,
      handoffId,
      priority,
    }) {
      const attributes = {
        channelType: 'whatsapp',
        direction: 'inbound',
        name: customerAddress,
        from: customerAddress,
        customerAddress,
        customerName: customerAddress,
        businessAddress,
        conversationSid,
        elevenlabsConversationId,
        handoffId,
        reason,
        intent,
        summary,
      };
      if (typeof priority === 'number') attributes.priority = priority;

      const created = await twilioClient.flexApi.v1.interaction.create({
        channel: {
          type: 'whatsapp',
          initiated_by: 'customer',
          properties: { media_channel_sid: conversationSid },
        },
        routing: {
          properties: {
            workspace_sid: flexConfig.workspaceSid,
            workflow_sid: flexConfig.workflowSid,
            task_channel_unique_name: flexConfig.taskChannelUniqueName,
            attributes,
          },
        },
      });

      return {
        interactionSid: created.sid,
        taskSid: created.routing?.properties?.sid ?? null,
      };
    },
  };
}
