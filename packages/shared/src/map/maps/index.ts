import type { MapData } from '../types';
import { scrimSmall } from './scrim_small';

export const maps: Record<string, MapData> = {
  [scrimSmall.id]: scrimSmall,
};

export function getMap(id: string): MapData {
  const m = maps[id];
  if (!m) throw new Error(`Unknown map "${id}" (have: ${Object.keys(maps).join(', ')})`);
  return m;
}
