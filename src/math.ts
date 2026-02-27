export const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export const clampByte = (value: number): number => clamp(Math.round(value), 0, 255);

export const lerp = (from: number, to: number, amount: number): number =>
  from + (to - from) * amount;

export const seededNoise = (seed: number): number => {
  const value = Math.sin(seed * 12.9898 + 43_758.5453) * 43_758.5453;
  return (value - Math.floor(value)) * 2 - 1;
};

export const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
