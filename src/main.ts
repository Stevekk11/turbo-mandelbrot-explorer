import './style.css';
import type {ViewState} from './types';
import {createAudioControls} from './audioControls';
import {createBookmarks} from './bookmarks';
import {createInteractions} from './interactions';
import {createMiniMap} from './miniMap';
import {createOverlays} from './overlays';
import {createRenderer} from './renderer';
import {createUiControls} from './uiControls';

const DEFAULT_VIEW: ViewState = {
  xMin: '-2.5',
  xMax: '1.0',
  yMin: '-1.25',
  yMax: '1.25',
  maxIter: 1000,
  palette: 2,
  colorSpeed: 0.8,
  colorOffset: 0.35,
  isJulia: false,
  juliaRe: '-0.7269',
  juliaIm: '0.1889',
  zoom: '1',
  shadows: false,
  fractalType: 0,
  multibrotPower: 2.0,
};

const canvas = document.getElementById('fractal-canvas') as HTMLCanvasElement;
const precisionTierHintEl = document.getElementById('precision-tier-hint');
const zoomEl = document.getElementById('zoom-counter');

let view: ViewState = {...DEFAULT_VIEW};
let interactions!: ReturnType<typeof createInteractions>;
let overlays!: ReturnType<typeof createOverlays>;
let audioControls!: ReturnType<typeof createAudioControls>;
let ui!: ReturnType<typeof createUiControls>;

const renderer = createRenderer({
  canvas,
  getView: () => view,
  onViewChange: (nextView) => {
    view = nextView;
  },
  onDrawOverlays: () => overlays.drawAll(),
  isInteractionIdle: () => !interactions || (!interactions.isDragging() && interactions.wheelTimerIsIdle()),
  isAnimationPaused: () => !audioControls || audioControls.isColorAnimActive() || audioControls.isAudioPulseActive(),
  onProgress: (progress) => {
    if (ui) ui.updateProgressBar(progress);
  },
  onAutoIterChange: () => {
    if (ui) ui.updateIterDisplay();
  },
  onZoomLabelChange: (label) => {
    if (zoomEl) zoomEl.textContent = label;
  },
  onPrecisionTierChange: (tier) => {
    if (precisionTierHintEl) precisionTierHintEl.textContent = `p: ${tier.toUpperCase()}`;
  },
});

overlays = createOverlays({
  canvas,
  ctx: renderer.ctx,
  getView: () => view,
  screenToFractal: renderer.screenToFractal,
  redrawBase: renderer.setBaseImage,
  scheduleRender: renderer.scheduleRender,
});

audioControls = createAudioControls({
  getView: () => view,
  scheduleRecolor: renderer.scheduleRecolor,
  getPendingRecolorTiles: renderer.pendingRecolorTiles,
  getTileCount: renderer.tileCount,
  getCanPulseRecolor: () => !renderer.isRendering() && !interactions.isDragging() && interactions.wheelTimerIsIdle(),
});

const miniMap = createMiniMap({
  getView: () => view,
  scheduleRender: renderer.scheduleRender,
});

const bookmarks = createBookmarks({
  getView: () => view,
  onApplyBookmark: (bookmark) => {
    view = {
      ...view,
      ...bookmark,
      fractalType: bookmark.fractalType ?? DEFAULT_VIEW.fractalType,
      multibrotPower: bookmark.multibrotPower ?? DEFAULT_VIEW.multibrotPower,
    };
    renderer.updateZoom();
    ui.updateIterDisplay();
    ui.updatePaletteUI();
    ui.updateFractalTypeUI();
    ui.updateMultibrotUI();
    renderer.scheduleRender();
  },
});

ui = createUiControls({
  defaultView: DEFAULT_VIEW,
  getView: () => view,
  setView: (nextView) => {
    view = nextView;
  },
  canvas,
  miniMap,
  overlays,
  audioControls,
  bookmarks,
  scheduleRender: renderer.scheduleRender,
  scheduleRecolor: renderer.scheduleRecolor,
});

interactions = createInteractions({
  canvas,
  ctx: renderer.ctx,
  getView: () => view,
  screenToFractal: renderer.screenToFractal,
  zoomAt: renderer.zoomAt,
  scheduleRender: renderer.scheduleRender,
  getOffscreen: renderer.getOffscreen,
  getRedrawOverlays: () => overlays.redraw,
  getDrawAxisGrid: () => overlays.drawAxisGrid,
  getOverlayState: () => ({
    isMeasureMode: overlays.isMeasureMode,
    hasMeasurements: overlays.hasMeasurements,
    isOrbitModeActive: overlays.isOrbitModeActive,
    showOrbitAtClientPoint: overlays.showOrbitAtClientPoint,
    addMeasurementPoint: overlays.addMeasurementPoint,
    clearMeasurements: overlays.clearMeasurements,
    hasPath: overlays.hasPath,
    clearPath: overlays.clearPath,
    placePathAtClientPoint: overlays.placePathAtClientPoint,
  }),
  onCancelRenderDuringDrag: renderer.cancelCurrentRender,
  updateIterDisplay: ui.updateIterDisplay,
  resetView: () => ui.resetView(renderer.updateZoom),
  toggleJulia: ui.toggleJulia,
  saveScreenshot: () => {
    const link = document.createElement('a');
    link.download = `mandelbrot-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  },
  cyclePalette: () => ui.cyclePalette(() => renderer.tileCount() > 0),
  toggleShadows: () => ui.toggleShadows(() => renderer.tileCount() > 0),
  togglePathModeUI: (active) => {
    document.getElementById('path-mode-btn')?.classList.toggle('btn-active', active);
  },
  toggleColorAnim: audioControls.toggleColorAnim,
  randomPalette: () => ui.randomizePalette(renderer.broadcastPaletteUpdate, () => renderer.tileCount() > 0),
});

const saveScreenshot = () => {
  const link = document.createElement('a');
  link.download = `mandelbrot-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
};

function init() {
  ui.initSettingsPanel({
    hasCachedTiles: () => renderer.tileCount() > 0,
    toggleJulia: ui.toggleJulia,
  });
  ui.initToolbar({
    toggleJulia: ui.toggleJulia,
    saveScreenshot,
    toggleShadows: () => ui.toggleShadows(() => renderer.tileCount() > 0),
    randomizePalette: () => ui.randomizePalette(renderer.broadcastPaletteUpdate, () => renderer.tileCount() > 0),
    resetView: () => ui.resetView(renderer.updateZoom),
  });
  ui.initHelp();
  audioControls.updateAudioSensitivityUI();
  audioControls.updateAudioPulseUI();
  renderer.resizeCanvas();
  renderer.updateZoom();
  ui.updateIterDisplay();
  renderer.createWorkerPool(`${import.meta.env.BASE_URL}mandelbrot.wasm`);
}

init();

document.getElementById('path-mode-btn')?.addEventListener('click', interactions.togglePathMode);
window.addEventListener('resize', renderer.resizeCanvas);
window.addEventListener('beforeunload', () => audioControls.stop());
