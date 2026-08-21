import { describe, expect, it, vi } from 'vitest';
import { computeLuminosityHistogram, drawLuminosityHistogram } from '../src/lib/luminosityHistogram';
import { FakeCanvas, installDomStubs } from './helpers/domStubs';

describe('luminosity histogram', () => {
  it('bins visible RGB pixels using the shared Rec. 601 luminosity weights', () => {
    const histogram = computeLuminosityHistogram({
      data: new Uint8ClampedArray([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255,
      ]),
      width: 4,
      height: 1,
    });
    expect(histogram[76]).toBe(1);
    expect(histogram[149]).toBe(1);
    expect(histogram[29]).toBe(1);
    expect(histogram[255]).toBe(1);
  });

  it('ignores fully transparent pixels', () => {
    const histogram = computeLuminosityHistogram({
      data: new Uint8ClampedArray([255, 255, 255, 0, 0, 0, 0, 255]),
      width: 2,
      height: 1,
    });
    expect(histogram[255]).toBe(0);
    expect(histogram[0]).toBe(1);
  });

  it('draws normalized bars and safely clears empty input', () => {
    installDomStubs();
    const source = new FakeCanvas();
    source.width = 2;
    source.height = 1;
    source.context.pixels.set([0, 0, 0, 255, 255, 255, 255, 255]);
    const target = new FakeCanvas();

    drawLuminosityHistogram(source as unknown as HTMLCanvasElement, target as unknown as HTMLCanvasElement);
    expect(target.width).toBe(256);
    expect(target.height).toBe(48);
    expect(target.context.fillRect).toHaveBeenCalledWith(0, 0, 1, 48);
    expect(target.context.fillRect).toHaveBeenCalledWith(255, 0, 1, 48);

    const empty = new FakeCanvas();
    drawLuminosityHistogram(empty as unknown as HTMLCanvasElement, target as unknown as HTMLCanvasElement);
    expect(target.width).toBe(256);
    expect(target.height).toBe(48);
    vi.unstubAllGlobals();
  });
});
