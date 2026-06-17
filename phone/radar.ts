// Native canvas radar chart. Kept dependency-free because TavernHelper inlines
// the bundle and large third-party modules have proven fragile in that path.

const LABELS = ['知识', '魅力', '灵巧', '体贴', '勇气'];
const GRID_RINGS = 4;
const PARTICLE_COUNT = 35;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  hue: number;
};

type RadarSketch = {
  canvas: HTMLCanvasElement;
  frameId: number | null;
  resizeObserver: ResizeObserver | null;
  remove: () => void;
};

let activeSketch: RadarSketch | null = null;
let mountToken = 0;

export function mountRadarChart(
  container: HTMLElement,
  values: number[] = [50, 50, 50, 50, 50],
  animate: boolean = false,
) {
  const requestToken = ++mountToken;

  if (activeSketch) {
    activeSketch.remove();
    activeSketch = null;
  }

  if (requestToken !== mountToken) return;
  activeSketch = createSketch(container, values, animate);
}

export function unmountRadarChart() {
  mountToken++;
  if (activeSketch) {
    activeSketch.remove();
    activeSketch = null;
  }
}

function createSketch(container: HTMLElement, rawValues: number[], animate: boolean): RadarSketch {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const values = normalizeValues(rawValues);
  const particles = createParticles();

  let size = 0;
  let cssSize = 0;
  let frameId: number | null = null;
  let startTime = performance.now();
  let wobbleSeed = Math.random() * 1000;

  container.replaceChildren(canvas);

  const resize = () => {
    cssSize = Math.max(180, Math.floor(container.clientWidth || 220));
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    size = cssSize;
    canvas.width = Math.floor(cssSize * dpr);
    canvas.height = Math.floor(cssSize * dpr);
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    wobbleSeed = Math.random() * 1000;
  };

  resize();

  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(resize)
    : null;
  resizeObserver?.observe(container);

  const drawFrame = (now: number) => {
    if (!ctx) return;

    const elapsed = (now - startTime) / 1000;
    const entryProgress = animate ? Math.min(1, elapsed / 0.8) : 1;
    const eased = easeOutBack(entryProgress);
    drawRadar(ctx, size, values, particles, elapsed, wobbleSeed, eased);
    frameId = requestAnimationFrame(drawFrame);
  };

  frameId = requestAnimationFrame(drawFrame);

  return {
    canvas,
    frameId,
    resizeObserver,
    remove() {
      if (frameId !== null) cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      canvas.remove();
    },
  };
}

function normalizeValues(values: number[]) {
  return LABELS.map((_, index) => {
    const value = Number(values[index] ?? 0);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
  });
}

function createParticles(): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({
      x: Math.random() * 2 - 1,
      y: Math.random() * 2 - 1,
      vx: Math.random() * 0.006 - 0.003,
      vy: Math.random() * 0.006 - 0.003,
      size: 2 + Math.random() * 4,
      alpha: 0.2 + Math.random() * 0.28,
      hue: 200 + Math.random() * 100,
    });
  }
  return particles;
}

function drawRadar(
  ctx: CanvasRenderingContext2D,
  size: number,
  values: number[],
  particles: Particle[],
  elapsed: number,
  seed: number,
  entryScale: number,
) {
  const dims = LABELS.length;
  const cx = size / 2;
  const cy = size / 2 - 4;
  const radius = size * 0.32;
  const angleStep = (Math.PI * 2) / dims;
  const startAngle = -Math.PI / 2;

  ctx.clearRect(0, 0, size, size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '11px "Zen Maru Gothic", sans-serif';

  drawGlow(ctx, cx, cy, radius);
  drawParticles(ctx, cx, cy, radius, particles, elapsed);
  drawGrid(ctx, cx, cy, radius, angleStep, startAngle, seed, elapsed);
  drawDataArea(ctx, cx, cy, radius, angleStep, startAngle, values, elapsed, entryScale);
  drawLabels(ctx, cx, cy, radius, angleStep, startAngle, values);
  drawDataPoints(ctx, cx, cy, radius, angleStep, startAngle, values, elapsed, entryScale);
}

function drawGlow(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number) {
  for (let i = 7; i >= 1; i--) {
    const ratio = i / 7;
    ctx.fillStyle = `rgba(168, 147, 210, ${0.03 * ratio})`;
    ellipse(ctx, cx, cy, radius * 2.4 * ratio, radius * 2.4 * ratio, true);
  }
  ctx.fillStyle = 'rgba(200, 180, 240, 0.02)';
  ellipse(ctx, cx, cy, radius * 0.8, radius * 0.8, true);
}

function drawParticles(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  particles: Particle[],
  elapsed: number,
) {
  for (const particle of particles) {
    particle.x += particle.vx + Math.sin(elapsed + particle.hue * 0.05) * 0.0015;
    particle.y += particle.vy + Math.cos(elapsed * 0.7 + particle.hue * 0.03) * 0.0015;
    if (Math.abs(particle.x) > 1.2) particle.vx *= -1;
    if (Math.abs(particle.y) > 1.2) particle.vy *= -1;

    const x = cx + particle.x * radius;
    const y = cy + particle.y * radius;
    const alpha = particle.alpha * (0.65 + Math.sin(elapsed * 0.8 + particle.hue * 0.01) * 0.25);
    ctx.fillStyle = `hsla(${particle.hue}, 60%, 70%, ${alpha})`;
    ellipse(ctx, x, y, particle.size, particle.size, true);
    ctx.fillStyle = `hsla(${particle.hue}, 40%, 80%, ${alpha * 0.3})`;
    ellipse(ctx, x - particle.vx * radius * 3, y - particle.vy * radius * 3, particle.size * 0.6, particle.size * 0.6, true);
  }
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  step: number,
  start: number,
  seed: number,
  elapsed: number,
) {
  for (let ring = 1; ring <= GRID_RINGS; ring++) {
    const ringRadius = (radius / GRID_RINGS) * ring;
    const passes = ring === GRID_RINGS ? 3 : 2;
    for (let pass = 0; pass < passes; pass++) {
      const alpha = ring === GRID_RINGS ? 0.16 - pass * 0.03 : 0.08 - pass * 0.02;
      ctx.strokeStyle = `rgba(160, 140, 110, ${alpha})`;
      ctx.lineWidth = ring === GRID_RINGS ? 1.4 - pass * 0.3 : 0.9 - pass * 0.2;
      ctx.beginPath();
      for (let i = 0; i < LABELS.length; i++) {
        const angle = start + step * i;
        const wx = wobble(seed + pass * 200, ring * 10 + i, elapsed) * 0.75;
        const wy = wobble(seed + 500 + pass * 200, ring * 10 + i, elapsed) * 0.75;
        const x = cx + Math.cos(angle) * ringRadius + wx;
        const y = cy + Math.sin(angle) * ringRadius + wy;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  for (let i = 0; i < LABELS.length; i++) {
    const angle = start + step * i;
    const ex = cx + Math.cos(angle) * radius;
    const ey = cy + Math.sin(angle) * radius;
    const pulse = Math.max(0, 1 - Math.abs(elapsed - i * 0.12) * 2.5);
    const segments = 10;
    for (let s = 0; s < segments; s += 2) {
      const t0 = s / segments;
      const t1 = (s + 1) / segments;
      const alpha = 0.14 + 0.35 * pulse;
      ctx.strokeStyle = `rgba(${160 - pulse * 30}, ${140 - pulse * 20}, ${110 + pulse * 80}, ${alpha})`;
      ctx.lineWidth = 0.8 + pulse * 2;
      const jx = wobble(seed + i * 50, s, elapsed) * 0.35;
      const jy = wobble(seed + i * 50 + 300, s, elapsed) * 0.35;
      ctx.beginPath();
      ctx.moveTo(cx + (ex - cx) * t0 + jx, cy + (ey - cy) * t0 + jy);
      ctx.lineTo(cx + (ex - cx) * t1 + jx, cy + (ey - cy) * t1 + jy);
      ctx.stroke();
    }
  }
}

function drawDataArea(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  step: number,
  start: number,
  values: number[],
  elapsed: number,
  entryScale: number,
) {
  const breathScale = 1 + Math.sin(elapsed * 1.5) * 0.06;
  const scale = breathScale * entryScale;

  drawValuePath(ctx, cx, cy, radius, step, start, values, scale);
  ctx.strokeStyle = 'rgba(168, 147, 210, 0.1)';
  ctx.lineWidth = 6;
  ctx.stroke();

  drawValuePath(ctx, cx, cy, radius, step, start, values, scale);
  ctx.fillStyle = 'rgba(168, 147, 210, 0.14)';
  ctx.strokeStyle = 'rgba(138, 117, 190, 0.58)';
  ctx.lineWidth = 1.8;
  ctx.fill();
  ctx.stroke();

  drawValuePath(ctx, cx, cy, radius, step, start, values, scale * 0.55);
  ctx.fillStyle = 'rgba(200, 180, 255, 0.07)';
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < LABELS.length; i++) {
    const angle = start + step * i;
    const value = (values[i] / 100) * scale;
    const jitter = Math.sin(elapsed * 0.7 + i * 2.1) * 1.5;
    const x = cx + Math.cos(angle) * radius * value + jitter;
    const y = cy + Math.sin(angle) * radius * value + jitter;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.strokeStyle = 'rgba(148, 127, 200, 0.24)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  step: number,
  start: number,
  values: number[],
) {
  for (let i = 0; i < LABELS.length; i++) {
    const angle = start + step * i;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dist = radius + 22 + Math.abs(cos) * 14;
    const x = cx + cos * dist;
    const y = cy + sin * dist;

    ctx.fillStyle = 'rgb(100, 80, 60)';
    ctx.font = '11px "Zen Maru Gothic", sans-serif';
    ctx.fillText(LABELS[i], x, y);
    ctx.fillStyle = 'rgba(138, 117, 190, 0.86)';
    ctx.font = '700 13px "Zen Maru Gothic", sans-serif';
    ctx.fillText(String(Math.round(values[i])), x, y + 14);
  }
}

function drawDataPoints(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  step: number,
  start: number,
  values: number[],
  elapsed: number,
  entryScale: number,
) {
  for (let i = 0; i < LABELS.length; i++) {
    const angle = start + step * i;
    const value = (values[i] / 100) * entryScale;
    const x = cx + Math.cos(angle) * radius * value;
    const y = cy + Math.sin(angle) * radius * value;
    const pulse = Math.sin(elapsed * 1.8 + i * 1.3) * 0.5 + 0.5;

    ctx.strokeStyle = `rgba(168, 147, 210, ${0.06 + pulse * 0.08})`;
    ctx.lineWidth = 0.8;
    ellipse(ctx, x, y, 16 + pulse * 10, 16 + pulse * 10, false);

    ctx.strokeStyle = `rgba(148, 127, 210, ${0.16 + pulse * 0.2})`;
    ctx.lineWidth = 1.2;
    ellipse(ctx, x, y, 10 + pulse * 5, 10 + pulse * 5, false);

    ctx.fillStyle = 'rgba(138, 117, 190, 0.9)';
    ellipse(ctx, x, y, 7, 7, true);

    ctx.fillStyle = `rgba(220, 200, 255, ${0.58 + pulse * 0.28})`;
    ellipse(ctx, x - 1.5, y - 1.5, 2.5, 2.5, true);
  }
}

function drawValuePath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  step: number,
  start: number,
  values: number[],
  scale: number,
) {
  ctx.beginPath();
  for (let i = 0; i < LABELS.length; i++) {
    const angle = start + step * i;
    const value = (values[i] / 100) * scale;
    const x = cx + Math.cos(angle) * radius * value;
    const y = cy + Math.sin(angle) * radius * value;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function ellipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: boolean,
) {
  ctx.beginPath();
  ctx.ellipse(x, y, width / 2, height / 2, 0, 0, Math.PI * 2);
  if (fill) ctx.fill();
  else ctx.stroke();
}

function wobble(seed: number, i: number, phase: number): number {
  return Math.sin(seed + i * 73.7 + phase * 0.3) * 2.8
    + Math.sin(seed * 1.7 + i * 31.3 + phase * 0.5) * 1.5;
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
