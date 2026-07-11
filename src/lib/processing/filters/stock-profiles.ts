import type { FilterCategory, FilterDefinition } from '../../core/types';
import { buildLut } from '../lut';
import { curve, dye, renderFilmPixel, type FilmStockProfile } from './film-model';

const stock = (profile: FilmStockProfile): FilmStockProfile => profile;

// ─── Kodak ───────────────────────────────────────────────────────────────────

const KODAK_STOCKS: FilmStockProfile[] = [
  stock({
    id: 'portra400',
    label: 'Portra 400',
    category: 'kodak',
    description: 'Portrait negative · Frontier scan · wide latitude',
    curves: {
      r: curve({ gamma: 0.92, toe: 0.1, toeLift: 0.05, shoulder: 0.84, shoulderStr: 0.4, gain: 1.02 }),
      g: curve({ gamma: 0.94, toe: 0.1, toeLift: 0.04, shoulder: 0.85, shoulderStr: 0.38 }),
      b: curve({ gamma: 0.9, toe: 0.11, toeLift: 0.06, shoulder: 0.83, shoulderStr: 0.42, gain: 0.98 }),
    },
    dyeMatrix: dye([1.03, 0.01, -0.02], [-0.01, 0.99, 0.02], [-0.04, 0.02, 1.02]),
    scanner: 'frontier',
    shadowHue: 195, shadowTint: 0.14, highlightHue: 38, highlightTint: 0.1,
    latitude: 0.95, saturation: 1.03, vibrance: 0.05, halation: 0.04, halationWarmth: 0.75,
    grain: { amount: 18, warmth: 0.55, size: 0.45 },
  }),
  stock({
    id: 'portra160',
    label: 'Portra 160',
    category: 'kodak',
    description: 'Fine grain portrait · soft pastels',
    curves: {
      r: curve({ gamma: 0.96, toe: 0.09, toeLift: 0.04, shoulder: 0.86, shoulderStr: 0.45 }),
      g: curve({ gamma: 0.97, toe: 0.09, toeLift: 0.035, shoulder: 0.87, shoulderStr: 0.42 }),
      b: curve({ gamma: 0.95, toe: 0.1, toeLift: 0.045, shoulder: 0.85, shoulderStr: 0.44 }),
    },
    dyeMatrix: dye([1.02, 0.01, -0.01], [0, 0.99, 0.01], [-0.03, 0.01, 1.01]),
    scanner: 'frontier',
    shadowHue: 200, shadowTint: 0.1, highlightHue: 40, highlightTint: 0.08,
    latitude: 0.92, saturation: 0.96, vibrance: 0.03, halation: 0.03, halationWarmth: 0.7,
    grain: { amount: 10, warmth: 0.5, size: 0.35 },
  }),
  stock({
    id: 'portra800',
    label: 'Portra 800',
    category: 'kodak',
    description: 'High-speed portrait · warm pushed',
    curves: {
      r: curve({ gamma: 0.88, toe: 0.11, toeLift: 0.055, shoulder: 0.8, shoulderStr: 0.32, gain: 1.04 }),
      g: curve({ gamma: 0.9, toe: 0.1, toeLift: 0.05, shoulder: 0.81, shoulderStr: 0.3 }),
      b: curve({ gamma: 0.86, toe: 0.12, toeLift: 0.06, shoulder: 0.79, shoulderStr: 0.34 }),
    },
    dyeMatrix: dye([1.04, 0.01, -0.02], [-0.02, 0.98, 0.02], [-0.05, 0.02, 1.01]),
    scanner: 'noritsu',
    shadowHue: 192, shadowTint: 0.12, highlightHue: 35, highlightTint: 0.12,
    latitude: 0.88, saturation: 1.05, vibrance: 0.06, halation: 0.05, halationWarmth: 0.8,
    grain: { amount: 32, warmth: 0.6, size: 0.55 },
  }),
  stock({
    id: 'gold200',
    label: 'Gold 200',
    category: 'kodak',
    description: 'Consumer negative · golden warmth',
    curves: {
      r: curve({ gamma: 0.98, toe: 0.07, toeLift: 0.07, shoulder: 0.88, shoulderStr: 0.5, gain: 1.05 }),
      g: curve({ gamma: 1.0, toe: 0.07, toeLift: 0.06, shoulder: 0.89, shoulderStr: 0.48, gain: 1.02 }),
      b: curve({ gamma: 1.02, toe: 0.08, toeLift: 0.05, shoulder: 0.9, shoulderStr: 0.52, gain: 0.95 }),
    },
    dyeMatrix: dye([1.05, 0.02, -0.03], [0.01, 1.01, -0.01], [-0.02, 0, 0.97]),
    scanner: 'noritsu',
    shadowHue: 40, shadowTint: 0.12, highlightHue: 45, highlightTint: 0.14,
    latitude: 0.75, saturation: 1.06, vibrance: 0.08, halation: 0.03, halationWarmth: 0.85,
    grain: { amount: 22, warmth: 0.7, size: 0.5 },
  }),
  stock({
    id: 'ektar100',
    label: 'Ektar 100',
    category: 'kodak',
    description: 'Ultra-vivid negative · deep blacks',
    curves: {
      r: curve({ gamma: 0.82, toe: 0.06, toeLift: 0.02, shoulder: 0.88, shoulderStr: 0.22, gain: 1.04 }),
      g: curve({ gamma: 0.84, toe: 0.06, toeLift: 0.02, shoulder: 0.89, shoulderStr: 0.2 }),
      b: curve({ gamma: 0.8, toe: 0.07, toeLift: 0.02, shoulder: 0.87, shoulderStr: 0.24, gain: 1.05 }),
    },
    dyeMatrix: dye([1.06, -0.02, -0.03], [-0.02, 1.04, -0.02], [-0.04, -0.01, 1.06]),
    scanner: 'frontier',
    shadowHue: 210, shadowTint: 0.06, highlightHue: 48, highlightTint: 0.06,
    latitude: 0.65, saturation: 1.15, vibrance: 0.1, halation: 0.02, halationWarmth: 0.65,
    grain: { amount: 8, warmth: 0.45, size: 0.3 },
  }),
  stock({
    id: 'ultramax400',
    label: 'UltraMax 400',
    category: 'kodak',
    description: 'Consumer · punchy neutral-warm',
    curves: {
      r: curve({ gamma: 0.9, toe: 0.09, toeLift: 0.045, shoulder: 0.83, shoulderStr: 0.35 }),
      g: curve({ gamma: 0.92, toe: 0.09, toeLift: 0.04, shoulder: 0.84, shoulderStr: 0.33 }),
      b: curve({ gamma: 0.88, toe: 0.1, toeLift: 0.05, shoulder: 0.82, shoulderStr: 0.36 }),
    },
    dyeMatrix: dye([1.02, 0.01, -0.01], [0, 1, 0.01], [-0.03, 0.01, 1.02]),
    scanner: 'noritsu',
    shadowHue: 210, shadowTint: 0.08, highlightHue: 42, highlightTint: 0.08,
    latitude: 0.78, saturation: 1.06, vibrance: 0.07, halation: 0.03, halationWarmth: 0.7,
    grain: { amount: 24, warmth: 0.55, size: 0.5 },
  }),
  stock({
    id: 'vision3_250d',
    label: 'Vision3 250D',
    category: 'kodak',
    description: 'Daylight cinema negative · 250D',
    curves: {
      r: curve({ gamma: 0.9, toe: 0.09, toeLift: 0.04, shoulder: 0.83, shoulderStr: 0.38 }),
      g: curve({ gamma: 0.92, toe: 0.09, toeLift: 0.035, shoulder: 0.84, shoulderStr: 0.36 }),
      b: curve({ gamma: 0.88, toe: 0.1, toeLift: 0.05, shoulder: 0.82, shoulderStr: 0.4, gain: 0.99 }),
    },
    dyeMatrix: dye([1.02, 0, -0.02], [-0.01, 1, 0.02], [-0.04, 0.01, 1.03]),
    scanner: 'ecn2',
    shadowHue: 205, shadowTint: 0.12, highlightHue: 48, highlightTint: 0.08,
    latitude: 0.9, saturation: 0.98, vibrance: 0.04, halation: 0.04, halationWarmth: 0.72,
    grain: { amount: 14, warmth: 0.5, size: 0.4 },
  }),
  stock({
    id: 'exr200t_5293',
    label: 'EXR 200T 5293',
    category: 'kodak',
    description: 'Tungsten cinema · ECN-2 · 5293',
    curves: {
      r: curve({ gamma: 0.91, toe: 0.1, toeLift: 0.04, shoulder: 0.81, shoulderStr: 0.42, gain: 1.01 }),
      g: curve({ gamma: 0.93, toe: 0.1, toeLift: 0.035, shoulder: 0.82, shoulderStr: 0.4 }),
      b: curve({ gamma: 0.87, toe: 0.12, toeLift: 0.055, shoulder: 0.8, shoulderStr: 0.44, gain: 1.03 }),
    },
    dyeMatrix: dye([1.02, 0.01, -0.03], [-0.02, 0.97, 0.04], [-0.07, 0.02, 1.05]),
    scanner: 'ecn2',
    shadowHue: 196, shadowTint: 0.18, highlightHue: 38, highlightTint: 0.1,
    latitude: 0.93, saturation: 0.95, vibrance: 0.03, halation: 0.05, halationWarmth: 0.88,
    grain: { amount: 12, warmth: 0.48, size: 0.38 },
  }),
];

// ─── Fuji ──────────────────────────────────────────────────────────────────────

const FUJI_STOCKS: FilmStockProfile[] = [
  stock({
    id: 'pro400h',
    label: 'Pro 400H',
    category: 'fuji',
    description: 'Portrait negative · cyan-green shadows',
    curves: {
      r: curve({ gamma: 0.96, toe: 0.1, toeLift: 0.055, shoulder: 0.85, shoulderStr: 0.48 }),
      g: curve({ gamma: 0.95, toe: 0.1, toeLift: 0.05, shoulder: 0.86, shoulderStr: 0.45 }),
      b: curve({ gamma: 0.93, toe: 0.11, toeLift: 0.06, shoulder: 0.84, shoulderStr: 0.5, gain: 1.01 }),
    },
    dyeMatrix: dye([0.98, 0.02, 0.02], [0.02, 1.02, 0.02], [-0.02, 0.04, 1]),
    scanner: 'frontier',
    shadowHue: 172, shadowTint: 0.15, highlightHue: 55, highlightTint: 0.06,
    latitude: 0.94, saturation: 0.9, vibrance: 0.04, halation: 0.03, halationWarmth: 0.65,
    grain: { amount: 16, warmth: 0.4, size: 0.42 },
  }),
  stock({
    id: 'superia400',
    label: 'Superia 400',
    category: 'fuji',
    description: 'Consumer · vivid greens',
    curves: {
      r: curve({ gamma: 0.9, toe: 0.09, toeLift: 0.04, shoulder: 0.83, shoulderStr: 0.34 }),
      g: curve({ gamma: 0.86, toe: 0.09, toeLift: 0.04, shoulder: 0.84, shoulderStr: 0.32, gain: 1.03 }),
      b: curve({ gamma: 0.9, toe: 0.1, toeLift: 0.045, shoulder: 0.82, shoulderStr: 0.35 }),
    },
    dyeMatrix: dye([1, 0.01, 0], [0.02, 1.04, 0.01], [-0.01, 0.02, 1.02]),
    scanner: 'frontier',
    shadowHue: 185, shadowTint: 0.08, highlightHue: 50, highlightTint: 0.07,
    latitude: 0.8, saturation: 1.08, vibrance: 0.09, halation: 0.03, halationWarmth: 0.7,
    grain: { amount: 26, warmth: 0.45, size: 0.52 },
  }),
  stock({
    id: 'velvia50',
    label: 'Velvia 50',
    category: 'fuji',
    description: 'Slide · hyper-saturated landscape',
    curves: {
      r: curve({ gamma: 0.78, toe: 0.05, toeLift: 0.015, shoulder: 0.9, shoulderStr: 0.18, gain: 1.05 }),
      g: curve({ gamma: 0.76, toe: 0.05, toeLift: 0.015, shoulder: 0.91, shoulderStr: 0.16, gain: 1.06 }),
      b: curve({ gamma: 0.74, toe: 0.06, toeLift: 0.02, shoulder: 0.89, shoulderStr: 0.2, gain: 1.04 }),
    },
    dyeMatrix: dye([1.06, -0.03, -0.03], [-0.02, 1.08, -0.04], [-0.04, -0.02, 1.1]),
    scanner: 'neutral',
    shadowHue: 200, shadowTint: 0.04, highlightHue: 60, highlightTint: 0.05,
    latitude: 0.55, saturation: 1.22, vibrance: 0.12, halation: 0.02, halationWarmth: 0.6,
    grain: { amount: 6, warmth: 0.35, size: 0.25 },
  }),
  stock({
    id: 'provia100f',
    label: 'Provia 100F',
    category: 'fuji',
    description: 'Slide · neutral vivid',
    curves: {
      r: curve({ gamma: 0.84, toe: 0.06, toeLift: 0.025, shoulder: 0.88, shoulderStr: 0.25 }),
      g: curve({ gamma: 0.85, toe: 0.06, toeLift: 0.025, shoulder: 0.89, shoulderStr: 0.23 }),
      b: curve({ gamma: 0.83, toe: 0.07, toeLift: 0.03, shoulder: 0.87, shoulderStr: 0.27 }),
    },
    dyeMatrix: dye([1.03, -0.01, -0.02], [-0.01, 1.03, -0.01], [-0.02, -0.01, 1.04]),
    scanner: 'neutral',
    shadowHue: 210, shadowTint: 0.06, highlightHue: 45, highlightTint: 0.05,
    latitude: 0.7, saturation: 1.1, vibrance: 0.07, halation: 0.02, halationWarmth: 0.65,
    grain: { amount: 5, warmth: 0.35, size: 0.22 },
  }),
  stock({
    id: 'eterna',
    label: 'Eterna',
    category: 'fuji',
    description: 'Cinema negative · muted soft',
    curves: {
      r: curve({ gamma: 0.98, toe: 0.1, toeLift: 0.05, shoulder: 0.86, shoulderStr: 0.45 }),
      g: curve({ gamma: 0.99, toe: 0.1, toeLift: 0.045, shoulder: 0.87, shoulderStr: 0.42 }),
      b: curve({ gamma: 0.96, toe: 0.11, toeLift: 0.055, shoulder: 0.85, shoulderStr: 0.46 }),
    },
    dyeMatrix: dye([1, 0.01, 0.01], [0.01, 0.99, 0.02], [-0.02, 0.02, 1.01]),
    scanner: 'ecn2',
    shadowHue: 195, shadowTint: 0.1, highlightHue: 40, highlightTint: 0.05,
    latitude: 0.88, saturation: 0.86, vibrance: 0.02, halation: 0.03, halationWarmth: 0.68,
    grain: { amount: 10, warmth: 0.42, size: 0.36 },
  }),
  stock({
    id: 'classic_chrome',
    label: 'Classic Chrome',
    category: 'fuji',
    description: 'Documentary · subdued chroma',
    curves: {
      r: curve({ gamma: 1.02, toe: 0.09, toeLift: 0.055, shoulder: 0.87, shoulderStr: 0.5 }),
      g: curve({ gamma: 1.03, toe: 0.09, toeLift: 0.05, shoulder: 0.88, shoulderStr: 0.48 }),
      b: curve({ gamma: 1.01, toe: 0.1, toeLift: 0.055, shoulder: 0.86, shoulderStr: 0.52 }),
    },
    dyeMatrix: dye([1, 0.01, 0], [0.01, 0.99, 0.01], [-0.02, 0.02, 1]),
    scanner: 'neutral',
    shadowHue: 180, shadowTint: 0.08, highlightHue: 35, highlightTint: 0.04,
    latitude: 0.82, saturation: 0.78, vibrance: 0.02, halation: 0.02, halationWarmth: 0.6,
    grain: { amount: 14, warmth: 0.4, size: 0.4 },
  }),
  stock({
    id: 'acros100',
    label: 'Acros 100',
    category: 'fuji',
    description: 'B&W negative · warm fine grain',
    curves: {
      r: curve({ gamma: 0.95, toe: 0.08, toeLift: 0.04, shoulder: 0.86, shoulderStr: 0.4 }),
      g: curve({ gamma: 0.95, toe: 0.08, toeLift: 0.04, shoulder: 0.86, shoulderStr: 0.4 }),
      b: curve({ gamma: 0.95, toe: 0.08, toeLift: 0.04, shoulder: 0.86, shoulderStr: 0.4 }),
    },
    dyeMatrix: dye([0.36, 0.48, 0.16], [0.36, 0.48, 0.16], [0.36, 0.48, 0.16]),
    scanner: 'neutral',
    shadowHue: 30, shadowTint: 0.04, highlightHue: 40, highlightTint: 0.03,
    latitude: 0.85, saturation: 0, vibrance: 0, halation: 0.03, halationWarmth: 0.7,
    grain: { amount: 8, warmth: 0.55, size: 0.3 },
  }),
];

// ─── Cinema ──────────────────────────────────────────────────────────────────

const CINEMA_STOCKS: FilmStockProfile[] = [
  stock({
    id: 'tealOrange',
    label: 'Teal & Orange',
    category: 'cinema',
    description: 'Blockbuster DI · teal shadows warm highlights',
    curves: {
      r: curve({ gamma: 0.88, toe: 0.09, toeLift: 0.035, shoulder: 0.83, shoulderStr: 0.34 }),
      g: curve({ gamma: 0.9, toe: 0.09, toeLift: 0.03, shoulder: 0.84, shoulderStr: 0.32 }),
      b: curve({ gamma: 0.86, toe: 0.1, toeLift: 0.045, shoulder: 0.82, shoulderStr: 0.36, gain: 1.02 }),
    },
    dyeMatrix: dye([1.01, 0, -0.02], [-0.01, 1, 0.01], [-0.03, 0.01, 1.04]),
    scanner: 'ecn2',
    shadowHue: 192, shadowTint: 0.2, highlightHue: 28, highlightTint: 0.14,
    latitude: 0.85, saturation: 1.04, vibrance: 0.05, halation: 0.04, halationWarmth: 0.82,
  }),
  stock({
    id: 'bleachBypass',
    label: 'Bleach Bypass',
    category: 'cinema',
    description: 'Silver retention · low sat high contrast',
    curves: {
      r: curve({ gamma: 0.78, toe: 0.07, toeLift: 0.02, shoulder: 0.9, shoulderStr: 0.15 }),
      g: curve({ gamma: 0.78, toe: 0.07, toeLift: 0.02, shoulder: 0.9, shoulderStr: 0.15 }),
      b: curve({ gamma: 0.78, toe: 0.07, toeLift: 0.02, shoulder: 0.9, shoulderStr: 0.15 }),
    },
    dyeMatrix: dye([1.04, 0.02, 0.02], [0.02, 1.04, 0.02], [0.02, 0.02, 1.04]),
    scanner: 'neutral',
    shadowHue: 210, shadowTint: 0.04, highlightHue: 45, highlightTint: 0.04,
    latitude: 0.6, saturation: 0.52, vibrance: 0, halation: 0.02, halationWarmth: 0.5,
  }),
  stock({
    id: 'goldenHour',
    label: 'Golden Hour',
    category: 'cinema',
    description: 'Amber highlight wash',
    curves: {
      r: curve({ gamma: 0.94, toe: 0.09, toeLift: 0.05, shoulder: 0.84, shoulderStr: 0.38, gain: 1.03 }),
      g: curve({ gamma: 0.96, toe: 0.09, toeLift: 0.045, shoulder: 0.85, shoulderStr: 0.36 }),
      b: curve({ gamma: 0.98, toe: 0.1, toeLift: 0.04, shoulder: 0.86, shoulderStr: 0.4, gain: 0.96 }),
    },
    dyeMatrix: dye([1.03, 0.01, -0.02], [0, 1, 0], [-0.02, 0, 0.98]),
    scanner: 'noritsu',
    shadowHue: 220, shadowTint: 0.06, highlightHue: 35, highlightTint: 0.16,
    latitude: 0.88, saturation: 1.06, vibrance: 0.07, halation: 0.06, halationWarmth: 0.92,
  }),
  stock({
    id: 'moodyDesat',
    label: 'Moody Desat',
    category: 'cinema',
    description: 'Crushed shadows · desaturated',
    curves: {
      r: curve({ gamma: 0.85, toe: 0.12, toeLift: 0.02, shoulder: 0.8, shoulderStr: 0.3 }),
      g: curve({ gamma: 0.87, toe: 0.11, toeLift: 0.02, shoulder: 0.81, shoulderStr: 0.28 }),
      b: curve({ gamma: 0.83, toe: 0.12, toeLift: 0.025, shoulder: 0.79, shoulderStr: 0.32 }),
    },
    dyeMatrix: dye([1, 0, 0], [0, 1, 0], [0, 0, 1.02]),
    scanner: 'ecn2',
    shadowHue: 210, shadowTint: 0.12, highlightHue: 40, highlightTint: 0.04,
    latitude: 0.75, saturation: 0.7, vibrance: 0, halation: 0.02, halationWarmth: 0.6,
  }),
  stock({
    id: 'noirTeal',
    label: 'Noir Teal',
    category: 'cinema',
    description: 'Near-monochrome · teal shadows',
    curves: {
      r: curve({ gamma: 0.82, toe: 0.11, toeLift: 0.025, shoulder: 0.82, shoulderStr: 0.28 }),
      g: curve({ gamma: 0.84, toe: 0.1, toeLift: 0.03, shoulder: 0.83, shoulderStr: 0.26 }),
      b: curve({ gamma: 0.8, toe: 0.12, toeLift: 0.04, shoulder: 0.81, shoulderStr: 0.3, gain: 1.02 }),
    },
    dyeMatrix: dye([0.9, 0.05, 0.05], [0.05, 0.95, 0.05], [0.02, 0.05, 1.08]),
    scanner: 'ecn2',
    shadowHue: 188, shadowTint: 0.22, highlightHue: 200, highlightTint: 0.06,
    latitude: 0.7, saturation: 0.42, vibrance: 0, halation: 0.02, halationWarmth: 0.55,
  }),
  stock({
    id: 'sunsetGlow',
    label: 'Sunset Glow',
    category: 'cinema',
    description: 'Magenta highlights · warm fill',
    curves: {
      r: curve({ gamma: 0.93, toe: 0.09, toeLift: 0.05, shoulder: 0.83, shoulderStr: 0.36, gain: 1.02 }),
      g: curve({ gamma: 0.95, toe: 0.09, toeLift: 0.045, shoulder: 0.84, shoulderStr: 0.34 }),
      b: curve({ gamma: 0.97, toe: 0.1, toeLift: 0.04, shoulder: 0.85, shoulderStr: 0.38 }),
    },
    dyeMatrix: dye([1.02, 0.01, 0], [0, 0.99, 0.01], [-0.01, 0.01, 1.01]),
    scanner: 'noritsu',
    shadowHue: 25, shadowTint: 0.1, highlightHue: 318, highlightTint: 0.14,
    latitude: 0.86, saturation: 1.06, vibrance: 0.07, halation: 0.05, halationWarmth: 0.9,
  }),
  stock({
    id: 'forestMist',
    label: 'Forest Mist',
    category: 'cinema',
    description: 'Cool greens · airy lift',
    curves: {
      r: curve({ gamma: 1.0, toe: 0.1, toeLift: 0.055, shoulder: 0.87, shoulderStr: 0.48 }),
      g: curve({ gamma: 0.98, toe: 0.1, toeLift: 0.05, shoulder: 0.86, shoulderStr: 0.46, gain: 1.01 }),
      b: curve({ gamma: 0.96, toe: 0.11, toeLift: 0.055, shoulder: 0.85, shoulderStr: 0.5 }),
    },
    dyeMatrix: dye([0.99, 0.01, 0.01], [0.01, 1.02, 0.02], [-0.01, 0.02, 1.01]),
    scanner: 'neutral',
    shadowHue: 185, shadowTint: 0.08, highlightHue: 60, highlightTint: 0.05,
    latitude: 0.9, saturation: 0.8, vibrance: 0.03, halation: 0.02, halationWarmth: 0.6,
  }),
  stock({
    id: 'copperTone',
    label: 'Copper Tone',
    category: 'cinema',
    description: 'Copper highlights · brown shadows',
    curves: {
      r: curve({ gamma: 0.9, toe: 0.1, toeLift: 0.04, shoulder: 0.82, shoulderStr: 0.34, gain: 1.03 }),
      g: curve({ gamma: 0.94, toe: 0.1, toeLift: 0.035, shoulder: 0.84, shoulderStr: 0.32 }),
      b: curve({ gamma: 0.96, toe: 0.11, toeLift: 0.03, shoulder: 0.85, shoulderStr: 0.36, gain: 0.97 }),
    },
    dyeMatrix: dye([1.04, 0.01, -0.03], [0.01, 0.96, 0.01], [-0.05, 0, 0.97]),
    scanner: 'noritsu',
    shadowHue: 18, shadowTint: 0.14, highlightHue: 25, highlightTint: 0.14,
    latitude: 0.82, saturation: 0.92, vibrance: 0.03, halation: 0.04, halationWarmth: 0.85,
  }),
];

// ─── B&W ─────────────────────────────────────────────────────────────────────

const BW_STOCKS: FilmStockProfile[] = [
  stock({
    id: 'trix400',
    label: 'Tri-X 400',
    category: 'bw',
    description: 'Classic B&W · high contrast',
    curves: {
      r: curve({ gamma: 0.82, toe: 0.08, toeLift: 0.02, shoulder: 0.86, shoulderStr: 0.28 }),
      g: curve({ gamma: 0.82, toe: 0.08, toeLift: 0.02, shoulder: 0.86, shoulderStr: 0.28 }),
      b: curve({ gamma: 0.82, toe: 0.08, toeLift: 0.02, shoulder: 0.86, shoulderStr: 0.28 }),
    },
    dyeMatrix: dye([0.32, 0.5, 0.18], [0.32, 0.5, 0.18], [0.32, 0.5, 0.18]),
    scanner: 'neutral',
    shadowHue: 0, shadowTint: 0, highlightHue: 0, highlightTint: 0,
    latitude: 0.72, saturation: 0, vibrance: 0, halation: 0.02, halationWarmth: 0.5,
    grain: { amount: 38, warmth: 0.5, size: 0.6 },
  }),
  stock({
    id: 'hp5Plus',
    label: 'HP5 Plus',
    category: 'bw',
    description: 'Ilford · wide tonal range',
    curves: {
      r: curve({ gamma: 0.9, toe: 0.09, toeLift: 0.04, shoulder: 0.85, shoulderStr: 0.38 }),
      g: curve({ gamma: 0.9, toe: 0.09, toeLift: 0.04, shoulder: 0.85, shoulderStr: 0.38 }),
      b: curve({ gamma: 0.9, toe: 0.09, toeLift: 0.04, shoulder: 0.85, shoulderStr: 0.38 }),
    },
    dyeMatrix: dye([0.34, 0.48, 0.18], [0.34, 0.48, 0.18], [0.34, 0.48, 0.18]),
    scanner: 'neutral',
    shadowHue: 0, shadowTint: 0, highlightHue: 0, highlightTint: 0,
    latitude: 0.88, saturation: 0, vibrance: 0, halation: 0.02, halationWarmth: 0.5,
    grain: { amount: 30, warmth: 0.48, size: 0.55 },
  }),
  stock({
    id: 'delta100',
    label: 'Delta 100',
    category: 'bw',
    description: 'Fine grain · smooth tones',
    curves: {
      r: curve({ gamma: 0.95, toe: 0.08, toeLift: 0.035, shoulder: 0.87, shoulderStr: 0.42 }),
      g: curve({ gamma: 0.95, toe: 0.08, toeLift: 0.035, shoulder: 0.87, shoulderStr: 0.42 }),
      b: curve({ gamma: 0.95, toe: 0.08, toeLift: 0.035, shoulder: 0.87, shoulderStr: 0.42 }),
    },
    dyeMatrix: dye([0.33, 0.51, 0.16], [0.33, 0.51, 0.16], [0.33, 0.51, 0.16]),
    scanner: 'neutral',
    shadowHue: 0, shadowTint: 0, highlightHue: 0, highlightTint: 0,
    latitude: 0.85, saturation: 0, vibrance: 0, halation: 0.01, halationWarmth: 0.5,
    grain: { amount: 10, warmth: 0.45, size: 0.28 },
  }),
  stock({
    id: 'noirHigh',
    label: 'Noir High',
    category: 'bw',
    description: 'Crushed blacks · stark',
    curves: {
      r: curve({ gamma: 0.75, toe: 0.1, toeLift: 0.01, shoulder: 0.88, shoulderStr: 0.2 }),
      g: curve({ gamma: 0.75, toe: 0.1, toeLift: 0.01, shoulder: 0.88, shoulderStr: 0.2 }),
      b: curve({ gamma: 0.75, toe: 0.1, toeLift: 0.01, shoulder: 0.88, shoulderStr: 0.2 }),
    },
    dyeMatrix: dye([0.3, 0.52, 0.18], [0.3, 0.52, 0.18], [0.3, 0.52, 0.18]),
    scanner: 'neutral',
    shadowHue: 0, shadowTint: 0, highlightHue: 0, highlightTint: 0,
    latitude: 0.55, saturation: 0, vibrance: 0, halation: 0.01, halationWarmth: 0.45,
    grain: { amount: 28, warmth: 0.45, size: 0.5 },
  }),
];

// ─── Magic Portrait (skin-safe one-tap looks) ────────────────────────────────

const portraitLook = (
  id: FilmStockProfile['id'],
  label: string,
  description: string,
  opts: Partial<FilmStockProfile>,
): FilmStockProfile =>
  stock({
    id,
    label,
    category: 'portrait',
    description,
    skinPreserve: true,
    stylized: true,
    curves: {
      r: curve({ gamma: opts.curves?.r?.gamma ?? 0.96, toeLift: 0.05 }),
      g: curve({ gamma: opts.curves?.g?.gamma ?? 0.96, toeLift: 0.05 }),
      b: curve({ gamma: opts.curves?.b?.gamma ?? 0.96, toeLift: 0.05 }),
    },
    dyeMatrix: dye([1, 0, 0], [0, 1, 0], [0, 0, 1]),
    scanner: 'neutral',
    shadowHue: 28,
    shadowTint: 0.05,
    highlightHue: 38,
    highlightTint: 0.06,
    latitude: 0.88,
    saturation: 0.98,
    vibrance: 0.03,
    halation: 0.03,
    halationWarmth: 0.75,
    ...opts,
  });

const PORTRAIT_STOCKS: FilmStockProfile[] = [
  portraitLook('magicNatural', 'Natural', 'Clean skin tones · soft contrast · neutral WB', {
    scanner: 'frontier',
    latitude: 0.92,
    saturation: 0.97,
    vibrance: 0.02,
    halation: 0.02,
  }),
  portraitLook('magicGlow', 'Glow', 'Soft highlight bloom · lifted shadows', {
    scanner: 'noritsu',
    latitude: 0.9,
    saturation: 0.96,
    vibrance: 0.02,
    halation: 0.08,
    halationWarmth: 0.88,
    curves: {
      r: curve({ gamma: 0.98, toeLift: 0.065 }),
      g: curve({ gamma: 0.99, toeLift: 0.065 }),
      b: curve({ gamma: 1.0, toeLift: 0.06 }),
    },
  }),
  portraitLook('magicGolden', 'Golden', 'Warm skin · creamy highlights', {
    scanner: 'noritsu',
    shadowHue: 32,
    shadowTint: 0.06,
    highlightHue: 38,
    highlightTint: 0.12,
    saturation: 1.02,
    vibrance: 0.04,
    halation: 0.06,
    halationWarmth: 0.92,
  }),
  portraitLook('magicCool', 'Cool Edit', 'Blue shadow lift · editorial cool', {
    scanner: 'frontier',
    shadowHue: 205,
    shadowTint: 0.1,
    highlightHue: 200,
    highlightTint: 0.05,
    saturation: 0.92,
    vibrance: 0.02,
    curves: {
      r: curve({ gamma: 0.94 }),
      g: curve({ gamma: 0.96 }),
      b: curve({ gamma: 0.92, gain: 1.02 }),
    },
  }),
  portraitLook('magicMatte', 'Matte', 'Low saturation · lifted blacks', {
    latitude: 0.82,
    saturation: 0.82,
    vibrance: 0,
    curves: {
      r: curve({ gamma: 1.03, toeLift: 0.07 }),
      g: curve({ gamma: 1.04, toeLift: 0.07 }),
      b: curve({ gamma: 1.05, toeLift: 0.07 }),
    },
  }),
  portraitLook('magicStudio', 'Studio', 'Neutral backdrop feel · punchy mids', {
    scanner: 'neutral',
    latitude: 0.78,
    saturation: 0.94,
    vibrance: 0.02,
    curves: {
      r: curve({ gamma: 0.9 }),
      g: curve({ gamma: 0.9 }),
      b: curve({ gamma: 0.9 }),
    },
    shadowTint: 0.03,
    highlightTint: 0.04,
  }),
  portraitLook('magicSunset', 'Sunset Portrait', 'Warm rim · soft highlight rolloff', {
    scanner: 'noritsu',
    shadowHue: 22,
    shadowTint: 0.08,
    highlightHue: 32,
    highlightTint: 0.14,
    saturation: 1.0,
    halation: 0.07,
    halationWarmth: 0.9,
  }),
  portraitLook('magicNight', 'Night Out', 'Contrast · subtle magenta shadows', {
    scanner: 'frontier',
    shadowHue: 318,
    shadowTint: 0.08,
    highlightHue: 35,
    highlightTint: 0.08,
    latitude: 0.72,
    saturation: 0.96,
    curves: {
      r: curve({ gamma: 0.88 }),
      g: curve({ gamma: 0.9 }),
      b: curve({ gamma: 0.88 }),
    },
  }),
  portraitLook('magicBwPortrait', 'Clean B&W', 'Acros-inspired · soft toe · skin-safe', {
    saturation: 0,
    vibrance: 0,
    dyeMatrix: dye([0.34, 0.5, 0.16], [0.34, 0.5, 0.16], [0.34, 0.5, 0.16]),
    curves: {
      r: curve({ gamma: 0.94, toeLift: 0.045 }),
      g: curve({ gamma: 0.94, toeLift: 0.045 }),
      b: curve({ gamma: 0.94, toeLift: 0.045 }),
    },
    halation: 0.02,
  }),
  portraitLook('magicVintage', 'Vintage Selfie', 'Reyes/Valencia hybrid · skin-safe fade', {
    scanner: 'noritsu',
    shadowHue: 28,
    shadowTint: 0.07,
    highlightHue: 38,
    highlightTint: 0.1,
    saturation: 0.86,
    latitude: 0.75,
    curves: {
      r: curve({ gamma: 1.02, toeLift: 0.065 }),
      g: curve({ gamma: 1.03, toeLift: 0.065 }),
      b: curve({ gamma: 1.04, toeLift: 0.065 }),
    },
  }),
  portraitLook('magicBright', 'Bright', 'High-key · airy lifted portrait', {
    scanner: 'noritsu',
    latitude: 0.95,
    saturation: 0.9,
    curves: {
      r: curve({ gamma: 1.04, toeLift: 0.08 }),
      g: curve({ gamma: 1.05, toeLift: 0.08 }),
      b: curve({ gamma: 1.06, toeLift: 0.08 }),
    },
    halation: 0.05,
    halationWarmth: 0.82,
  }),
  portraitLook('magicMoody', 'Moody', 'Crushed shadows · preserved skin hue', {
    scanner: 'ecn2',
    shadowHue: 210,
    shadowTint: 0.1,
    highlightHue: 35,
    highlightTint: 0.06,
    latitude: 0.8,
    saturation: 0.88,
    vibrance: 0.01,
    curves: {
      r: curve({ gamma: 0.86, toe: 0.1, toeLift: 0.03 }),
      g: curve({ gamma: 0.88, toe: 0.1, toeLift: 0.03 }),
      b: curve({ gamma: 0.84, toe: 0.11, toeLift: 0.035 }),
    },
  }),
];

// ─── Social & Classic (stylized, lighter model) ──────────────────────────────

const stylized = (
  id: FilmStockProfile['id'],
  label: string,
  category: FilterCategory,
  description: string,
  opts: Partial<FilmStockProfile>,
): FilmStockProfile =>
  stock({
    id,
    label,
    category,
    description,
    stylized: true,
    skinPreserve: true,
    curves: {
      r: curve({ gamma: opts.curves?.r?.gamma ?? 0.94 }),
      g: curve({ gamma: opts.curves?.g?.gamma ?? 0.94 }),
      b: curve({ gamma: opts.curves?.b?.gamma ?? 0.94 }),
    },
    dyeMatrix: dye([1, 0, 0], [0, 1, 0], [0, 0, 1]),
    scanner: 'neutral',
    shadowHue: 200,
    shadowTint: 0.06,
    highlightHue: 40,
    highlightTint: 0.06,
    latitude: 0.5,
    saturation: 0.95,
    vibrance: 0.03,
    halation: 0.02,
    halationWarmth: 0.7,
    ...opts,
  });

const SOCIAL_STOCKS: FilmStockProfile[] = [
  stylized('juno', 'Juno', 'social', 'Warm punch · boosted mids', {
    curves: { r: curve({ gamma: 0.9 }), g: curve({ gamma: 0.92 }), b: curve({ gamma: 0.94 }) },
    scanner: 'noritsu', shadowHue: 30, shadowTint: 0.06, highlightHue: 45, highlightTint: 0.1,
    saturation: 1.04, vibrance: 0.05,
  }),
  stylized('lark', 'Lark', 'social', 'Bright · lifted shadows', {
    curves: { r: curve({ gamma: 1.02, toeLift: 0.06 }), g: curve({ gamma: 1.02, toeLift: 0.06 }), b: curve({ gamma: 1.02, toeLift: 0.06 }) },
    saturation: 0.9, latitude: 0.7,
  }),
  stylized('gingham', 'Gingham', 'social', 'Soft vintage · cool fade', {
    curves: { r: curve({ gamma: 1.0 }), g: curve({ gamma: 1.01 }), b: curve({ gamma: 0.98, gain: 1.02 }) },
    shadowHue: 195, shadowTint: 0.1, saturation: 0.86,
  }),
  stylized('reyes', 'Reyes', 'social', 'Washed matte · warm blacks', {
    curves: { r: curve({ gamma: 1.04, toeLift: 0.07 }), g: curve({ gamma: 1.05, toeLift: 0.07 }), b: curve({ gamma: 1.06, toeLift: 0.07 }) },
    scanner: 'noritsu', shadowHue: 28, shadowTint: 0.07, saturation: 0.8, latitude: 0.65,
  }),
  stylized('hudson', 'Hudson', 'social', 'Icy cool · cyan shadows', {
    curves: { r: curve({ gamma: 0.92 }), g: curve({ gamma: 0.94 }), b: curve({ gamma: 0.9, gain: 1.03 }) },
    scanner: 'frontier', shadowHue: 195, shadowTint: 0.11, saturation: 0.88,
  }),
  stylized('sierra', 'Sierra', 'social', 'Soft matte · muted warmth', {
    curves: { r: curve({ gamma: 1.02 }), g: curve({ gamma: 1.03 }), b: curve({ gamma: 1.04 }) },
    saturation: 0.84, latitude: 0.6,
  }),
  stylized('stinson', 'Stinson', 'social', 'Subtle fade · low contrast', {
    curves: { r: curve({ gamma: 1.05 }), g: curve({ gamma: 1.05 }), b: curve({ gamma: 1.05 }) },
    saturation: 0.88,
  }),
  stylized('crema', 'Crema', 'social', 'Creamy fade · lifted shadows', {
    curves: { r: curve({ gamma: 1.0, toeLift: 0.06 }), g: curve({ gamma: 1.01, toeLift: 0.06 }), b: curve({ gamma: 1.02, toeLift: 0.05 }) },
    scanner: 'noritsu', highlightHue: 38, highlightTint: 0.12, saturation: 0.86, halation: 0.05,
  }),
  stylized('ludwig', 'Ludwig', 'social', 'Warm highlight glow', {
    highlightHue: 38, highlightTint: 0.14, saturation: 1.02, halation: 0.06, halationWarmth: 0.85,
  }),
  stylized('amaro', 'Amaro', 'social', 'Warm · faded edges feel', {
    scanner: 'noritsu', saturation: 1.02, vibrance: 0.04,
  }),
];

const CLASSIC_STOCKS: FilmStockProfile[] = [
  stylized('vintage', 'Vintage', 'classic', 'Faded warmth · lifted shadows', {
    scanner: 'noritsu', shadowHue: 35, shadowTint: 0.1, saturation: 0.82, latitude: 0.55,
  }),
  stylized('1977', '1977', 'classic', 'Retro fade · warm mids', {
    scanner: 'noritsu', highlightHue: 40, highlightTint: 0.1,
  }),
  stylized('aden', 'Aden', 'classic', 'Cool matte · soft pastels', {
    curves: { r: curve({ gamma: 0.98 }), g: curve({ gamma: 0.99 }), b: curve({ gamma: 0.96, gain: 1.02 }) },
    shadowHue: 195, shadowTint: 0.1, saturation: 0.88,
  }),
  stylized('moon', 'Moon', 'classic', 'Cool silver · low saturation', {
    curves: { r: curve({ gamma: 0.9 }), g: curve({ gamma: 0.92 }), b: curve({ gamma: 0.88, gain: 1.03 }) },
    saturation: 0.55,
  }),
  stylized('rise', 'Rise', 'classic', 'Golden hour glow', {
    scanner: 'noritsu', highlightHue: 35, highlightTint: 0.12, saturation: 1.02, halation: 0.06, halationWarmth: 0.88,
  }),
  stylized('willow', 'Willow', 'classic', 'Soft monochrome wash', {
    saturation: 0.15, dyeMatrix: dye([0.33, 0.5, 0.17], [0.33, 0.5, 0.17], [0.33, 0.5, 0.17]),
  }),
  stylized('lofi', 'Lofi', 'classic', 'Punchy contrast · gritty color', {
    curves: { r: curve({ gamma: 0.86 }), g: curve({ gamma: 0.86 }), b: curve({ gamma: 0.86 }) },
    saturation: 1.08, vibrance: 0.08,
  }),
  stylized('vesper', 'Vesper', 'classic', 'Evening warmth · soft rolloff', {
    scanner: 'noritsu', shadowHue: 220, shadowTint: 0.08, highlightHue: 35, highlightTint: 0.1,
  }),
  stylized('clarendon', 'Clarendon', 'classic', 'High contrast · vivid color', {
    curves: { r: curve({ gamma: 0.84 }), g: curve({ gamma: 0.84 }), b: curve({ gamma: 0.84 }) },
    saturation: 1.08, vibrance: 0.07,
  }),
  stylized('valencia', 'Valencia', 'classic', 'Warm fade · creamy highlights', {
    scanner: 'noritsu', shadowHue: 30, shadowTint: 0.08, saturation: 0.92,
  }),
  stylized('nashville', 'Nashville', 'classic', 'Pink lift · warm vintage', {
    scanner: 'noritsu', shadowHue: 320, shadowTint: 0.05, saturation: 0.86,
  }),
];

export const ALL_STOCK_PROFILES: FilmStockProfile[] = [
  ...PORTRAIT_STOCKS,
  ...KODAK_STOCKS,
  ...FUJI_STOCKS,
  ...CINEMA_STOCKS,
  ...SOCIAL_STOCKS,
  ...CLASSIC_STOCKS,
  ...BW_STOCKS,
];

export const profileToFilter = (profile: FilmStockProfile): FilterDefinition => ({
  id: profile.id,
  label: profile.label,
  category: profile.category,
  description: profile.description,
  grain: profile.grain,
  buildLut: () =>
    buildLut((r, g, b) => {
      const [tr, tg, tb] = renderFilmPixel(r, g, b, profile);
      return [tr, tg, tb];
    }),
});