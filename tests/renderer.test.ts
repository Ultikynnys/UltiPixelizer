import { beforeAll, describe, expect, it } from 'vitest';
import { createRenderer } from '../src/lib/render';
import { createRendererDeps } from './helpers/rendererDeps';
import { asSourceImage, FakeCanvas, installDomStubs } from './helpers/domStubs';

beforeAll(() => {
  installDomStubs();
});

describe('createRenderer wiring', () => {
  it('exposes the full API surface and routes through the submodules', () => {
    const deps = createRendererDeps({ getAOScene: () => null });
    const base = new FakeCanvas();
    base.width = 2;
    base.height = 2;
    base.context.pixels.set([10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255]);
    deps.textures.base.image = asSourceImage(base);

    const api = createRenderer(deps);

    // The rendered canvas is a fresh document canvas shared with the pipeline.
    expect(api.getRenderedCanvas()).toBeDefined();
    // No lightmap is baked yet, so the implicit slot preview is empty.
    expect(api.getImplicitLightmapCanvas()).toBeNull();

    api.render();
    expect(deps.previewCanvas.context.pixels.length).toBe(16);
    expect(deps.updatePreviewBadge).toHaveBeenCalledWith(2, 2);

    api.generateAo();
    api.bakeLighting();
    api.clearLightmap();
    expect(deps.renderTextureRibbon).toHaveBeenCalled();

    api.scheduleImplicitLightmapBake();
    api.reengageImplicitLightmap();
    api.scheduleNormalAdjustedLighting();
    api.refreshUVWireframe();
    api.refreshUVOverlap();
    // The clear-pass still runs even with the overlap view disabled.
    expect(deps.forEachViewport).toHaveBeenCalledOnce();

    api.resetPreview();
    expect(deps.renderTextureRibbon).toHaveBeenCalled();
  });
});
