import { MAX_NAME_LENGTH, PLAYER_COLORS } from '@puzzlelove/shared';

export interface LocalPlayer {
  name: string;
  color: string;
  clientId: string;
}

const KEY = 'pl.player';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode); ignore */
  }
}

export function readBool(key: string, fallback: boolean) {
  const v = safeGet(key);
  return v === null ? fallback : v === '1';
}

function newClientId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export function randomColor() {
  return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

export function loadPlayer(): LocalPlayer | null {
  try {
    const raw = safeGet(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<LocalPlayer>;
    if (!p.name || !p.color || !p.clientId) return null;
    return { name: p.name.slice(0, MAX_NAME_LENGTH), color: p.color, clientId: p.clientId };
  } catch {
    return null;
  }
}

export function savePlayer(name: string, color: string): LocalPlayer {
  const existing = loadPlayer();
  const player = { name: name.trim().slice(0, MAX_NAME_LENGTH), color, clientId: existing?.clientId ?? newClientId() };
  safeSet(KEY, JSON.stringify(player));
  return player;
}
