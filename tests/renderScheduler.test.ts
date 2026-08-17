import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderScheduler } from '../src/lib/renderScheduler';

afterEach(() => {
  vi.useRealTimers();
});

describe('render scheduler', () => {
  it('coalesces rapid requests into the latest render', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const scheduler = createRenderScheduler(render, 80);
    scheduler.request();
    vi.advanceTimersByTime(40);
    scheduler.request();
    vi.advanceTimersByTime(79);
    expect(render).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(render).toHaveBeenCalledOnce();
  });

  it('flushes immediately and clears pending work', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const scheduler = createRenderScheduler(render);
    scheduler.request();
    scheduler.flush();
    expect(render).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(render).toHaveBeenCalledOnce();
  });

  it('cancels pending renders', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const scheduler = createRenderScheduler(render);
    scheduler.request();
    scheduler.cancel();
    vi.runAllTimers();
    expect(render).not.toHaveBeenCalled();
  });
});
