export function normalizeAddress(input) {
  if (typeof input !== 'string') {
    throw new Error(`Address must be a string, got ${typeof input}`);
  }
  const trimmed = input.trim();
  const match = /^whatsapp:(\+\d{7,15})$/i.exec(trimmed);
  if (!match) {
    throw new Error(`Not a WhatsApp address: ${input}`);
  }
  return `whatsapp:${match[1]}`;
}
