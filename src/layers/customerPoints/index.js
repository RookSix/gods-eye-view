import * as Cesium from 'cesium';
import { governorRequestRender } from '../../renderGovernor.js';
import { normalizeCustomerCsv, visibleCountAt } from './model.js';

const DAY_MS = 86400000;
const DOT_HEIGHT_M = 35;
const DROP_DURATION_MS = 700;
const DROP_START_HEIGHT_M = 900;
const DOT_COLOR = Cesium.Color.fromCssColorString('#6ee7ff').withAlpha(0.92);
const NEW_DOT_COLOR = Cesium.Color.fromCssColorString('#d8ab2f').withAlpha(1);

function easeOutCubic(t) {
  const p = Math.max(0, Math.min(1, t));
  return 1 - ((1 - p) ** 3);
}

function formatDate(time) {
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '—';
}

function makeButton(label, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  return button;
}

export class CustomerPointLayer {
  constructor(viewer, { requestRender = governorRequestRender } = {}) {
    if (!viewer) throw new TypeError('Customer points require a Cesium viewer');
    this.viewer = viewer;
    this.requestRender = requestRender;
    this.dataSource = new Cesium.CustomDataSource('private-customer-points');
    this.viewer.dataSources.add(this.dataSource);
    this.points = [];
    this.entities = [];
    this.finalPositions = [];
    this.dataset = null;
    this.currentTime = null;
    this.visibleCount = 0;
    this.dropAnimations = new Map();
    this.dropFrame = null;
    this.playing = false;
    this.speedDaysPerSecond = 14;
    this.lastFrameTime = 0;
    this.panel = null;
    this.frame = null;
  }

  importText(text, fileName) {
    const dataset = normalizeCustomerCsv(text, { fileName });
    this.clear();
    this.dataset = dataset;
    this.points = dataset.points;
    this.currentTime = dataset.minTime;
    for (const point of this.points) {
      const finalPosition = Cesium.Cartesian3.fromDegrees(point.lon, point.lat, DOT_HEIGHT_M);
      const entity = this.dataSource.entities.add({
        id: `private-customer:${point.id}`,
        position: finalPosition,
        show: false,
        point: {
          pixelSize: 8,
          color: DOT_COLOR,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.75),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          disableDepthTestDistance: 250000,
        },
        properties: { label: point.label, date_of_first_contact: point.date },
      });
      this.entities.push(entity);
      this.finalPositions.push(finalPosition);
    }
    this.seek(dataset.minTime, { animate: false });
    this.updatePanel();
    this.flyToLayer();
    return dataset;
  }

  clear() {
    this.pause();
    this.cancelDropAnimations();
    this.dataSource.entities.removeAll();
    this.points = [];
    this.entities = [];
    this.finalPositions = [];
    this.dataset = null;
    this.currentTime = null;
    this.visibleCount = 0;
    this.updatePanel();
    this.requestRender('private-customer-points:clear');
  }

  seek(time, { animate = true } = {}) {
    if (!this.dataset) return;
    const clamped = Math.max(this.dataset.minTime, Math.min(this.dataset.maxTime, Number(time)));
    const previous = this.visibleCount;
    this.currentTime = clamped;
    const next = visibleCountAt(this.points, clamped);
    this.visibleCount = next;
    if (next < previous || !animate) this.cancelDropAnimations();
    for (let i = 0; i < this.entities.length; i += 1) {
      const entity = this.entities[i];
      const show = i < next;
      entity.show = show;
      if (!show) {
        entity.position = this.finalPositions[i];
        if (entity.point) {
          entity.point.color = DOT_COLOR;
          entity.point.pixelSize = 8;
        }
        continue;
      }
      if (entity.point) entity.point.color = i >= previous && show ? NEW_DOT_COLOR : DOT_COLOR;
      if (i >= previous && animate) this.startDropAnimation(i);
      else if (!this.dropAnimations.has(i)) entity.position = this.finalPositions[i];
    }
    this.updatePanel();
    this.requestRender('private-customer-points:seek');
  }

  cancelDropAnimations() {
    if (this.dropFrame != null) cancelAnimationFrame(this.dropFrame);
    this.dropFrame = null;
    this.dropAnimations.clear();
    for (let i = 0; i < this.entities.length; i += 1) {
      const entity = this.entities[i];
      if (this.finalPositions[i]) entity.position = this.finalPositions[i];
      if (entity.point) entity.point.pixelSize = 8;
    }
  }

  startDropAnimation(index) {
    const point = this.points[index];
    const entity = this.entities[index];
    if (!point || !entity) return;
    const now = performance.now();
    const startHeight = DOT_HEIGHT_M + DROP_START_HEIGHT_M;
    entity.position = Cesium.Cartesian3.fromDegrees(point.lon, point.lat, startHeight);
    if (entity.point) entity.point.pixelSize = 10;
    this.dropAnimations.set(index, { start: now, startHeight });
    if (this.dropFrame == null) this.dropFrame = requestAnimationFrame(this.tickDrops);
  }

  tickDrops = () => {
    this.dropFrame = null;
    if (!this.dropAnimations.size) return;
    const now = performance.now();
    for (const [index, drop] of this.dropAnimations) {
      const point = this.points[index];
      const entity = this.entities[index];
      if (!point || !entity || !entity.show) {
        this.dropAnimations.delete(index);
        continue;
      }
      const progress = Math.min(1, (now - drop.start) / DROP_DURATION_MS);
      const eased = easeOutCubic(progress);
      const height = DOT_HEIGHT_M + ((drop.startHeight - DOT_HEIGHT_M) * (1 - eased));
      entity.position = progress >= 1
        ? this.finalPositions[index]
        : Cesium.Cartesian3.fromDegrees(point.lon, point.lat, height);
      if (entity.point) entity.point.pixelSize = progress >= 1 ? 8 : 8 + (2 * (1 - progress));
      if (progress >= 1) {
        this.dropAnimations.delete(index);
        if (entity.point) entity.point.color = DOT_COLOR;
      }
    }
    this.requestRender('private-customer-points:drop');
    if (this.dropAnimations.size) this.dropFrame = requestAnimationFrame(this.tickDrops);
  };

  play() {
    if (!this.dataset || this.playing) return;
    this.playing = true;
    this.lastFrameTime = performance.now();
    this.tick();
    this.updatePanel();
  }

  pause() {
    this.playing = false;
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.updatePanel();
  }

  reset() {
    if (!this.dataset) return;
    this.pause();
    this.seek(this.dataset.minTime);
  }

  tick = () => {
    if (!this.playing || !this.dataset) return;
    const now = performance.now();
    const elapsed = Math.max(0, now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    const next = this.currentTime + elapsed * this.speedDaysPerSecond * DAY_MS;
    if (next >= this.dataset.maxTime) {
      this.seek(this.dataset.maxTime);
      this.pause();
      return;
    }
    this.seek(next);
    this.frame = requestAnimationFrame(this.tick);
  };

  flyToLayer() {
    if (!this.entities.length) return;
    this.viewer.flyTo(this.dataSource, { duration: 1.2 }).catch(() => {});
  }

  mount(container = document.body) {
    this.destroyPanel();
    const panel = document.createElement('section');
    panel.className = 'customer-timeline-panel';
    panel.setAttribute('aria-label', 'Customer Timeline');

    const title = document.createElement('h2');
    title.textContent = 'Customer Timeline';
    const importLabel = document.createElement('label');
    importLabel.className = 'customer-import-label';
    importLabel.textContent = 'Import CSV';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.dataset.gevCustomerCsvInput = 'true';
    importLabel.appendChild(input);

    const status = document.createElement('div');
    status.className = 'customer-status';
    status.dataset.gevCustomerStatus = 'true';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '0';
    slider.value = '0';
    slider.step = String(DAY_MS);
    slider.disabled = true;
    slider.dataset.gevCustomerTimeline = 'true';
    const controls = document.createElement('div');
    controls.className = 'customer-controls';
    const play = makeButton('Play', 'customer-play');
    play.dataset.gevCustomerPlay = 'true';
    const reset = makeButton('Reset', 'customer-reset');
    reset.dataset.gevCustomerReset = 'true';
    const focus = makeButton('Focus', 'customer-focus');
    focus.dataset.gevCustomerFocus = 'true';
    const clear = makeButton('Clear', 'customer-clear');
    clear.dataset.gevCustomerClear = 'true';
    const speed = document.createElement('select');
    speed.dataset.gevCustomerSpeed = 'true';
    for (const [value, label] of [['3', '3 days/s'], ['14', '14 days/s'], ['45', '45 days/s'], ['120', '120 days/s']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      if (value === '14') option.selected = true;
      speed.appendChild(option);
    }
    controls.append(play, reset, focus, clear, speed);
    const provenance = document.createElement('p');
    provenance.className = 'customer-provenance';
    provenance.dataset.gevCustomerProvenance = 'true';
    provenance.textContent = 'Memory-only browser import. Coordinates and first-contact dates are read from your local CSV; addresses are not rendered.';
    panel.append(title, importLabel, status, slider, controls, provenance);
    container.appendChild(panel);

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        this.importText(text, file.name);
      } catch (error) {
        status.textContent = `Import failed: ${error?.message || 'invalid CSV'}`;
      } finally {
        input.value = '';
      }
    });
    slider.addEventListener('input', () => this.seek(Number(slider.value)));
    play.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    reset.addEventListener('click', () => this.reset());
    focus.addEventListener('click', () => this.flyToLayer());
    clear.addEventListener('click', () => this.clear());
    speed.addEventListener('change', () => { this.speedDaysPerSecond = Number(speed.value) || 14; });
    this.panel = { panel, input, status, slider, play, reset, focus, clear, speed, provenance };
    this.updatePanel();
  }

  updatePanel() {
    if (!this.panel) return;
    const { status, slider, play, reset, focus, clear, provenance } = this.panel;
    const hasData = Boolean(this.dataset);
    slider.disabled = !hasData;
    reset.disabled = !hasData;
    focus.disabled = !hasData;
    clear.disabled = !hasData;
    play.disabled = !hasData;
    play.textContent = this.playing ? 'Pause' : 'Play';
    if (!hasData) {
      slider.min = '0'; slider.max = '0'; slider.value = '0';
      status.textContent = 'No customer CSV imported. Use a local geocoded CSV with latitude, longitude, and date_of_first_contact.';
      provenance.textContent = 'Memory-only browser import. No localStorage, IndexedDB, backend upload, geocoding, or share URL embedding is used.';
      return;
    }
    slider.min = String(this.dataset.minTime);
    slider.max = String(this.dataset.maxTime);
    slider.value = String(this.currentTime);
    const s = this.dataset.stats;
    status.textContent = `${this.visibleCount}/${s.plotted} visible through ${formatDate(this.currentTime)} · ${s.totalRows} rows · ${s.unresolved} unresolved/skipped · ${s.duplicates} duplicates skipped`;
    provenance.textContent = `${this.dataset.source.fileName} · ${this.dataset.source.provenance}`;
  }

  destroyPanel() {
    this.panel?.panel?.remove();
    this.panel = null;
  }

  destroy() {
    this.destroyPanel();
    this.clear();
    if (!this.viewer.isDestroyed()) this.viewer.dataSources.remove(this.dataSource, true);
  }
}

export function installCustomerPointLayer(viewer, options) {
  const layer = new CustomerPointLayer(viewer, options);
  layer.mount();
  return layer;
}
