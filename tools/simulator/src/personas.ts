import { PLAYER_COLORS, createRng } from '@puzzlelove/shared';

export interface Persona {
  clientId: string;
  name: string;
  color: string;
  /** 0..1: how often the player lines pieces up correctly. */
  skill: number;
  /** Relative chance of showing up; a few regulars play much more than most. */
  weight: number;
  sessionMinutes: number;
}

const BOT_NAMES = ['Nova', 'Pixel', 'Tango', 'Kiwi', 'Luna', 'Orbit', 'Mango', 'Echo', 'Coral', 'Zeta', 'Nube', 'Chispa'];

/** Live bots in production. Names and ids make them obvious to players and easy to filter in the pipeline. */
export const BOT_PERSONAS: Persona[] = BOT_NAMES.map((n, i) => {
  const rng = createRng(1000 + i);
  return {
    clientId: `bot-${n.toLowerCase()}`,
    name: `🤖 ${n}`,
    color: PLAYER_COLORS[i % PLAYER_COLORS.length],
    skill: 0.4 + rng() * 0.45,
    weight: 1,
    sessionMinutes: 6 + rng() * 10,
  };
});

const FIRST_NAMES = [
  'Sofía', 'Mateo', 'Valentina', 'Santiago', 'Regina', 'Diego', 'Camila', 'Emiliano', 'Ximena', 'Leonardo',
  'Renata', 'Sebastián', 'Mariana', 'Iker', 'Fernanda', 'Daniel', 'Andrea', 'Rodrigo', 'Paula', 'Emilio',
  'Lucía', 'Adrián', 'Daniela', 'Gael', 'Isabella', 'Julián', 'Natalia', 'Tomás', 'Victoria', 'Alan',
];

/** Synthetic player population for backfill (flagged is_synthetic in the database). */
export function syntheticPopulation(size: number, seed: number): Persona[] {
  const rng = createRng(seed);
  return Array.from({ length: size }, (_, i) => ({
    clientId: `sim-${String(i + 1).padStart(4, '0')}`,
    name: `${FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]} ${String.fromCharCode(65 + Math.floor(rng() * 26))}.`,
    color: PLAYER_COLORS[Math.floor(rng() * PLAYER_COLORS.length)],
    skill: Math.min(0.9, Math.max(0.2, 0.55 + (rng() - 0.5) * 0.6)),
    // Zipf-like: player 1 is ~10x more active than player 10.
    weight: 1 / (i + 1) ** 0.9,
    sessionMinutes: 4 + rng() * 14,
  }));
}
