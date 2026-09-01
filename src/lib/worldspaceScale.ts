import { WORLDSPACE_SCALE_MAX, WORLDSPACE_SCALE_MIN } from './defaults';

export const WORLDSPACE_SCALE_SLIDER_MIN = 0;
export const WORLDSPACE_SCALE_SLIDER_MIDPOINT = 50;
export const WORLDSPACE_SCALE_SLIDER_MAX = 100;
export const WORLDSPACE_SCALE_SLIDER_STEP = 0.1;
export const WORLDSPACE_SCALE_MIDPOINT_VALUE = 1;

/** Snaps a cells-per-unit value to two significant figures so the logarithmic
 * slider stops on clean, human-readable values (0.1, 0.32, 1.5, 64, 480). */
function snapWorldspaceScale(value: number): number {
  const clamped = Math.min(WORLDSPACE_SCALE_MAX, Math.max(WORLDSPACE_SCALE_MIN, value));
  const magnitude = 10 ** Math.floor(Math.log10(clamped));
  const snapped = Math.round((clamped / magnitude) * 10) / 10 * magnitude;
  return Number(Math.min(WORLDSPACE_SCALE_MAX, Math.max(WORLDSPACE_SCALE_MIN, snapped)).toFixed(6));
}

/** Maps the logarithmic slider position to cells per world unit. The lower
 * half of the track covers 0.1–1 and the upper half 1–2000, both
 * logarithmically, so the 1 cell/unit midpoint sits at the track center. */
export function worldspaceScaleFromSliderPosition(position: number): number {
  const clamped = Math.min(WORLDSPACE_SCALE_SLIDER_MAX, Math.max(WORLDSPACE_SCALE_SLIDER_MIN, position));
  if (clamped <= WORLDSPACE_SCALE_SLIDER_MIDPOINT) {
    const ratio = clamped / WORLDSPACE_SCALE_SLIDER_MIDPOINT;
    const value = WORLDSPACE_SCALE_MIN * (WORLDSPACE_SCALE_MIDPOINT_VALUE / WORLDSPACE_SCALE_MIN) ** ratio;
    return snapWorldspaceScale(value);
  }
  const ratio = (clamped - WORLDSPACE_SCALE_SLIDER_MIDPOINT) / (WORLDSPACE_SCALE_SLIDER_MAX - WORLDSPACE_SCALE_SLIDER_MIDPOINT);
  const value = WORLDSPACE_SCALE_MIDPOINT_VALUE * (WORLDSPACE_SCALE_MAX / WORLDSPACE_SCALE_MIDPOINT_VALUE) ** ratio;
  return snapWorldspaceScale(value);
}

/** Inverse of worldspaceScaleFromSliderPosition for state sync and direct entry. */
export function worldspaceScaleToSliderPosition(value: number): number {
  const clamped = Math.min(WORLDSPACE_SCALE_MAX, Math.max(WORLDSPACE_SCALE_MIN, value));
  if (clamped <= WORLDSPACE_SCALE_MIDPOINT_VALUE) {
    return (Math.log(clamped / WORLDSPACE_SCALE_MIN) / Math.log(WORLDSPACE_SCALE_MIDPOINT_VALUE / WORLDSPACE_SCALE_MIN))
      * WORLDSPACE_SCALE_SLIDER_MIDPOINT;
  }
  return WORLDSPACE_SCALE_SLIDER_MIDPOINT
    + (Math.log(clamped / WORLDSPACE_SCALE_MIDPOINT_VALUE) / Math.log(WORLDSPACE_SCALE_MAX / WORLDSPACE_SCALE_MIDPOINT_VALUE))
    * (WORLDSPACE_SCALE_SLIDER_MAX - WORLDSPACE_SCALE_SLIDER_MIDPOINT);
}
