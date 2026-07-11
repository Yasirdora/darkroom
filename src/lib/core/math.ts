export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const clampByte = (value: number): number => clamp(Math.round(value), 0, 255);

/** Deterministic noise in [-1, 1] for stable grain/VHS previews. */
export const seededNoise = (seed: number): number => {
  const value = Math.sin(seed * 12.9898 + 43758.5453) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
};