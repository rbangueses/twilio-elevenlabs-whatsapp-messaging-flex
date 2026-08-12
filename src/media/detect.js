export function detectMedia(webhookBody) {
  const raw = webhookBody?.Media;
  if (!raw) return { hasMedia: false, count: 0 };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const arr = Array.isArray(parsed) ? parsed : [];
    return { hasMedia: arr.length > 0, count: arr.length };
  } catch {
    return { hasMedia: true, count: 1 };
  }
}
