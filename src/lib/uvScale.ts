import { UV_SCALE_MAX, UV_SCALE_MIN, UV_SCALE_STEP } from './defaults';

export const UV_SCALE_SLIDER_MIN = 0;
export const UV_SCALE_SLIDER_MIDPOINT = 50;
export const UV_SCALE_SLIDER_MAX = 100;
export const UV_SCALE_SLIDER_STEP = 0.1;
export const UV_SCALE_MIDPOINT_VALUE = 1;

function snapUvScale(value: number): number {
  const clamped = Math.min(UV_SCALE_MAX, Math.max(UV_SCALE_MIN, value));
  return Number((Math.round(clamped / UV_SCALE_STEP) * UV_SCALE_STEP).toFixed(6));
}

/** Maps the nonlinear slider position to cells per pixel. Half the track is
 * reserved for 0.05–1, and the other half for 1–8. */
export function uvScaleFromSliderPosition(position: number): number {
  const clamped = Math.min(UV_SCALE_SLIDER_MAX, Math.max(UV_SCALE_SLIDER_MIN, position));
  if (clamped <= UV_SCALE_SLIDER_MIDPOINT) {
    const ratio = clamped / UV_SCALE_SLIDER_MIDPOINT;
    return snapUvScale(UV_SCALE_MIN + ratio * (UV_SCALE_MIDPOINT_VALUE - UV_SCALE_MIN));
  }
  const ratio = (clamped - UV_SCALE_SLIDER_MIDPOINT) / (UV_SCALE_SLIDER_MAX - UV_SCALE_SLIDER_MIDPOINT);
  return snapUvScale(UV_SCALE_MIDPOINT_VALUE + ratio * (UV_SCALE_MAX - UV_SCALE_MIDPOINT_VALUE));
}

/** Inverse of uvScaleFromSliderPosition for state sync and direct entry. */
export function uvScaleToSliderPosition(value: number): number {
  const clamped = Math.min(UV_SCALE_MAX, Math.max(UV_SCALE_MIN, value));
  if (clamped <= UV_SCALE_MIDPOINT_VALUE) {
    return ((clamped - UV_SCALE_MIN) / (UV_SCALE_MIDPOINT_VALUE - UV_SCALE_MIN)) * UV_SCALE_SLIDER_MIDPOINT;
  }
  return UV_SCALE_SLIDER_MIDPOINT
    + ((clamped - UV_SCALE_MIDPOINT_VALUE) / (UV_SCALE_MAX - UV_SCALE_MIDPOINT_VALUE))
    * (UV_SCALE_SLIDER_MAX - UV_SCALE_SLIDER_MIDPOINT);
}
