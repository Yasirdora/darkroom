import type { FilterId } from './core/types';
import { FILTER_PRESETS } from './processing/filters';

/** Matches coloristic.org `look-bridge.ts` query parameters. */
export interface BridgeParams {
  look?: FilterId;
  palette: string[];
  name?: string;
}

const HEX6 = /^[0-9A-Fa-f]{6}$/;

export function isValidFilterId(id: string): id is FilterId {
  return FILTER_PRESETS.some((preset) => preset.id === id);
}

function normalizeHexToken(token: string): string | null {
  const raw = token.trim().replace(/^#/, '');
  if (!HEX6.test(raw)) return null;
  return `#${raw.toUpperCase()}`;
}

/** Parse `?look=&palette=&name=` from Coloristic generator / film hub. */
export function parseBridgeParams(search: string): BridgeParams {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const lookRaw = params.get('look')?.trim();
  const look = lookRaw && isValidFilterId(lookRaw) ? lookRaw : undefined;

  const paletteRaw = params.get('palette')?.trim();
  const palette = paletteRaw
    ? paletteRaw
        .split(',')
        .map(normalizeHexToken)
        .filter((hex): hex is string => hex != null)
    : [];

  const name = params.get('name')?.trim() || undefined;

  return { look, palette, name };
}

export function hasBridgeParams(params: BridgeParams): boolean {
  return Boolean(params.look || params.palette.length > 0 || params.name);
}