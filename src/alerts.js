import { state } from './store.js';

const lastSent = new Map();
const THROTTLE_MS = 60000;

export async function emit(event, payload = {}) {
  const { webhookUrl, webhookEvents } = state.settings;
  if (!webhookUrl) return;
  if (Array.isArray(webhookEvents) && webhookEvents.length && !webhookEvents.includes(event)) return;

  const dedupeKey = event + ':' + (payload.keyId || payload.label || '');
  const now = Date.now();
  if (now - (lastSent.get(dedupeKey) || 0) < THROTTLE_MS) return;
  lastSent.set(dedupeKey, now);

  const text = format(event, payload);
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, text, at: new Date().toISOString(), ...payload }),
      signal: AbortSignal.timeout(6000)
    });
  } catch {
    /* webhook is best-effort */
  }
}

function format(event, payload) {
  switch (event) {
    case 'key-down':
      return `HYDRA: key "${payload.label}" disabled after ${payload.fails} failures — ${payload.error || 'no details'}`;
    case 'pool-exhausted':
      return `HYDRA: no upstream key could serve "${payload.model}" (${payload.attempts} attempts)`;
    default:
      return `HYDRA: ${event}`;
  }
}