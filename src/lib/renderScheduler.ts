export type RenderScheduler = {
  request: () => void;
  flush: () => Promise<void> | void;
  cancel: () => void;
};

export function createRenderScheduler(render: () => Promise<void> | void, delay = 80): RenderScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const flush = () => {
    cancel();
    return render();
  };

  const request = () => {
    cancel();
    timer = setTimeout(() => {
      timer = undefined;
      render();
    }, delay);
  };

  return { request, flush, cancel };
}
