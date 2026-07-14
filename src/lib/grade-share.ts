import type { Adjustments, Curves, EditState, FilterId, InputProfileId } from './core/types';
import { DEFAULT_ADJUSTMENTS, DEFAULT_CURVES, DEFAULT_EDIT_STATE } from './editor/constants';
import { isValidFilterId } from './look-bridge';
import { FILTER_PRESETS } from './processing/filters/presets';

/** Compact, URL-safe grade payload (no images or reference stats). */
export interface GradeSharePayload {
  a?: Partial<Adjustments>;
  f?: FilterId;
  fi?: number;
  c?: Curves;
  ip?: InputProfileId;
  ie?: number;
  il?: 0 | 1;
}

const INPUT_PROFILES = new Set<InputProfileId>([
  'standard',
  'rec709',
  'display-p3',
  'arri-logc3',
  'red-log3g10',
  's-log3',
  'bmd-film-gen4',
  'bmd-film-gen5',
  'davinci-intermediate',
  'c-log3',
  'v-log',
  'flat',
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pruneAdjustments = (adjustments: Adjustments): Partial<Adjustments> | undefined => {
  const partial: Partial<Adjustments> = {};
  for (const key of Object.keys(DEFAULT_ADJUSTMENTS) as Array<keyof Adjustments>) {
    if (adjustments[key] !== DEFAULT_ADJUSTMENTS[key]) {
      partial[key] = adjustments[key];
    }
  }
  return Object.keys(partial).length > 0 ? partial : undefined;
};

const pruneCurves = (curves: Curves): Curves | undefined => {
  const next: Curves = {};
  if (curves.master?.length) next.master = curves.master;
  if (curves.r?.length) next.r = curves.r;
  if (curves.g?.length) next.g = curves.g;
  if (curves.b?.length) next.b = curves.b;
  return Object.keys(next).length > 0 ? next : undefined;
};

const toBase64Url = (value: string): string =>
  btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const fromBase64Url = (value: string): string => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return atob(padded + pad);
};

export const serializeGradeState = (state: EditState): GradeSharePayload | null => {
  const payload: GradeSharePayload = {};
  const adjustments = pruneAdjustments(state.adjustments);
  const curves = pruneCurves(state.curves);

  if (adjustments) payload.a = adjustments;
  if (state.filterId !== DEFAULT_EDIT_STATE.filterId) payload.f = state.filterId;
  if (state.filterIntensity !== DEFAULT_EDIT_STATE.filterIntensity) payload.fi = state.filterIntensity;
  if (curves) payload.c = curves;
  if (state.inputProfile !== DEFAULT_EDIT_STATE.inputProfile) payload.ip = state.inputProfile;
  if (state.inputExposure !== DEFAULT_EDIT_STATE.inputExposure) payload.ie = state.inputExposure;
  if (state.inputLinearMode !== DEFAULT_EDIT_STATE.inputLinearMode) payload.il = state.inputLinearMode ? 1 : 0;

  return Object.keys(payload).length > 0 ? payload : null;
};

export const encodeGradePayload = (payload: GradeSharePayload): string =>
  toBase64Url(JSON.stringify(payload));

export const decodeGradePayload = (encoded: string): GradeSharePayload | null => {
  try {
    const parsed = JSON.parse(fromBase64Url(encoded)) as unknown;
    if (!isObject(parsed)) return null;

    const payload: GradeSharePayload = {};

    if (isObject(parsed.a)) {
      const adjustments: Partial<Adjustments> = {};
      for (const key of Object.keys(DEFAULT_ADJUSTMENTS) as Array<keyof Adjustments>) {
        const value = parsed.a[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          adjustments[key] = value;
        }
      }
      if (Object.keys(adjustments).length > 0) payload.a = adjustments;
    }

    if (typeof parsed.f === 'string' && isValidFilterId(parsed.f)) {
      payload.f = parsed.f;
    }

    if (typeof parsed.fi === 'number' && Number.isFinite(parsed.fi)) {
      payload.fi = Math.max(0, Math.min(100, Math.round(parsed.fi)));
    }

    if (isObject(parsed.c)) {
      const curves: Curves = {};
      for (const channel of ['master', 'r', 'g', 'b'] as const) {
        const points = parsed.c[channel];
        if (Array.isArray(points) && points.length >= 2) {
          curves[channel] = points as Curves[typeof channel];
        }
      }
      if (Object.keys(curves).length > 0) payload.c = curves;
    }

    if (typeof parsed.ip === 'string' && INPUT_PROFILES.has(parsed.ip as InputProfileId)) {
      payload.ip = parsed.ip as InputProfileId;
    }

    if (typeof parsed.ie === 'number' && Number.isFinite(parsed.ie)) {
      payload.ie = parsed.ie;
    }

    if (parsed.il === 0 || parsed.il === 1) {
      payload.il = parsed.il;
    }

    return Object.keys(payload).length > 0 ? payload : null;
  } catch {
    return null;
  }
};

export const parseGradeShare = (search: string): GradeSharePayload | null => {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const encoded = params.get('grade')?.trim();
  if (!encoded) return null;
  return decodeGradePayload(encoded);
};

export const hasGradeShare = (payload: GradeSharePayload | null): payload is GradeSharePayload =>
  payload !== null;

export const buildGradeShareUrl = (baseUrl: string, state: EditState): string | null => {
  const payload = serializeGradeState(state);
  if (!payload) return null;

  const url = new URL(baseUrl);
  url.searchParams.set('grade', encodeGradePayload(payload));
  return url.toString();
};

export const describeGradePayload = (payload: GradeSharePayload): string => {
  const parts: string[] = [];
  if (payload.f) {
    const label = FILTER_PRESETS.find((item) => item.id === payload.f)?.label ?? payload.f;
    parts.push(label);
  }
  if (payload.a && Object.keys(payload.a).length > 0) parts.push('adjustments');
  if (payload.c) parts.push('curves');
  if (payload.ip) parts.push(payload.ip);
  return parts.length > 0 ? parts.join(' + ') : 'grade preset';
};