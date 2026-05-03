// -*- coding: utf-8 -*-
import p5 from 'p5';

/** 五维雷达图的维度标签（女神异闻录风格） */
const LABELS = ['知识', '魅力', '灵巧', '体贴', '勇气'];

/** 同心网格层数 */
const GRID_RINGS = 4;

/** 当前挂载的 p5 实例，用于防止重复挂载 */
let activeSketch: p5 | null = null;

/** 漂浮粒子的数据结构 */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  hue: number;
}

/**
 * 将雷达图挂载到指定容器。
 * 如果已有实例会先销毁再重建，避免 canvas 堆叠。
 *
 * @param container  挂载目标 DOM 节点
 * @param values     五个维度的数值（0-100），顺序对应 LABELS
 * @param animate    是否播放入场动画（Persona 风格从中心涨出）
 */
export function mountRadarChart(
  container: HTMLElement,
  values: number[] = [50, 50, 50, 50, 50],
  animate: boolean = false,
) {
  if (activeSketch) {
    activeSketch.remove();
    activeSketch = null;
  }

  const dims = 5;
  const angleStep = (Math.PI * 2) / dims;
  const startAngle = -Math.PI / 2;

  activeSketch = new p5((p: p5) => {
    let size = 0;
    let cx = 0;
    let cy = 0;
    let radius = 0;

    // 动画用的呼吸相位
    let breathPhase = 0;
    // 漂浮粒子池
    const particles: Particle[] = [];
    const PARTICLE_COUNT = 18;
    // 手绘抖动的种子偏移
    let wobbleSeed = 0;

    // 入场动画进度（0→1），1 表示动画完成
    let entryProgress = animate ? 0 : 1;
    // 入场动画速度（约 0.8 秒 @30fps = 24 帧）
    const ENTRY_SPEED = 1 / 24;
    // 每根轴线的脉冲闪光计时
    const axisPulse: number[] = [0, 0, 0, 0, 0];

    function initParticles() {
      particles.length = 0;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        particles.push({
          x: p.random(-radius, radius),
          y: p.random(-radius, radius),
          vx: p.random(-0.15, 0.15),
          vy: p.random(-0.15, 0.15),
          size: p.random(1.5, 4),
          alpha: p.random(20, 60),
          hue: p.random(200, 300),
        });
      }
    }

    function updateParticles() {
      const bound = radius * 1.2;
      for (const pt of particles) {
        pt.x += pt.vx;
        pt.y += pt.vy;
        if (Math.abs(pt.x) > bound) pt.vx *= -1;
        if (Math.abs(pt.y) > bound) pt.vy *= -1;
        pt.alpha = 30 + 25 * Math.sin(breathPhase * 0.8 + pt.hue * 0.01);
      }
    }

    function drawParticles() {
      p.noStroke();
      for (const pt of particles) {
        p.fill(pt.hue, 60, 90, pt.alpha / 255);
        p.ellipse(cx + pt.x, cy + pt.y, pt.size, pt.size);
      }
    }

    p.setup = () => {
      size = container.clientWidth;
      const canvas = p.createCanvas(size, size);
      canvas.parent(container);
      p.frameRate(30);
      wobbleSeed = p.random(1000);
    };

    p.draw = () => {
      size = p.width;
      cx = size / 2;
      cy = size / 2 - 4;
      radius = size * 0.32;

      if (p.frameCount === 1) initParticles();

      breathPhase += 0.025;

      // 入场动画推进
      if (entryProgress < 1) {
        entryProgress = Math.min(1, entryProgress + ENTRY_SPEED);
        // 每根轴线依次触发脉冲（错开 0.15 的间隔）
        for (let i = 0; i < 5; i++) {
          const trigger = i * 0.15;
          if (entryProgress >= trigger && axisPulse[i] < 1) {
            axisPulse[i] = Math.min(1, axisPulse[i] + 0.08);
          }
        }
      } else {
        // 动画结束后脉冲衰减
        for (let i = 0; i < 5; i++) {
          axisPulse[i] = Math.max(0, axisPulse[i] - 0.03);
        }
      }

      // 入场缓动（easeOutBack 弹性效果）
      const eased = easeOutBack(entryProgress);

      p.clear();
      p.textAlign(p.CENTER, p.CENTER);
      p.textFont('Zen Maru Gothic, sans-serif');

      drawGlow(p, cx, cy, radius);
      updateParticles();
      drawParticles();
      drawGrid(p, cx, cy, radius, angleStep, startAngle, wobbleSeed, breathPhase, axisPulse);
      drawDataArea(p, cx, cy, radius, angleStep, startAngle, values, breathPhase, eased);
      drawLabels(p, cx, cy, radius, angleStep, startAngle, values);
      drawDataPoints(p, cx, cy, radius, angleStep, startAngle, values, breathPhase, eased);
    };
  });
}

/** 销毁当前雷达图实例（页面切走时调用） */
export function unmountRadarChart() {
  if (activeSketch) {
    activeSketch.remove();
    activeSketch = null;
  }
}

// ── 缓动函数 ──

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// ── 绘制辅助函数 ──

function drawGlow(p: p5, cx: number, cy: number, r: number) {
  p.noStroke();
  const layers = 5;
  for (let i = layers; i >= 1; i--) {
    const ratio = i / layers;
    p.fill(168, 147, 210, 6 * ratio);
    p.ellipse(cx, cy, r * 2.2 * ratio, r * 2.2 * ratio);
  }
}

function wobble(_p: p5, seed: number, i: number, phase: number): number {
  return Math.sin(seed + i * 73.7 + phase * 0.3) * 1.2;
}

/** 绘制手绘风格网格（带轴线脉冲） */
function drawGrid(
  p: p5, cx: number, cy: number, r: number,
  step: number, start: number, seed: number, phase: number,
  axisPulse: number[],
) {
  p.noFill();

  for (let ring = 1; ring <= GRID_RINGS; ring++) {
    const ringR = (r / GRID_RINGS) * ring;
    const alpha = ring === GRID_RINGS ? 50 : 25;
    p.stroke(160, 140, 110, alpha);
    p.strokeWeight(ring === GRID_RINGS ? 1.2 : 0.8);
    p.beginShape();
    for (let i = 0; i < 5; i++) {
      const a = start + step * i;
      const wx = wobble(p, seed, ring * 10 + i, phase);
      const wy = wobble(p, seed + 500, ring * 10 + i, phase);
      p.vertex(cx + Math.cos(a) * ringR + wx, cy + Math.sin(a) * ringR + wy);
    }
    p.endShape(p.CLOSE);
  }

  // 轴线（带脉冲闪光）
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const ex = cx + Math.cos(a) * r;
    const ey = cy + Math.sin(a) * r;
    const pulse = axisPulse[i];
    const segments = 8;
    for (let s = 0; s < segments; s++) {
      if (s % 2 === 1) continue;
      const t0 = s / segments;
      const t1 = (s + 1) / segments;
      // 脉冲时轴线变亮变粗
      const segAlpha = 20 + 15 * (1 - t0) + pulse * 80;
      p.stroke(160 - pulse * 30, 140 - pulse * 20, 110 + pulse * 80, segAlpha);
      p.strokeWeight(0.7 + pulse * 1.5);
      p.line(
        cx + (ex - cx) * t0, cy + (ey - cy) * t0,
        cx + (ex - cx) * t1, cy + (ey - cy) * t1,
      );
    }
  }
}

/** 绘制数据区域（带呼吸和入场缩放） */
function drawDataArea(
  p: p5, cx: number, cy: number, r: number,
  step: number, start: number, values: number[],
  phase: number, entryScale: number,
) {
  const breathScale = 1 + Math.sin(phase) * 0.03;
  const scale = breathScale * entryScale;

  p.noFill();
  p.stroke(168, 147, 210, 40);
  p.strokeWeight(4);
  p.beginShape();
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const v = ((values[i] ?? 0) / 100) * scale;
    p.vertex(cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v);
  }
  p.endShape(p.CLOSE);

  p.fill(168, 147, 210, 30);
  p.stroke(138, 117, 190, 130);
  p.strokeWeight(1.5);
  p.beginShape();
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const v = ((values[i] ?? 0) / 100) * scale;
    p.vertex(cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v);
  }
  p.endShape(p.CLOSE);

  p.fill(200, 180, 240, 12);
  p.noStroke();
  p.beginShape();
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const v = ((values[i] ?? 0) / 100) * scale * 0.6;
    p.vertex(cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v);
  }
  p.endShape(p.CLOSE);
}

/** 绘制维度标签和数值 */
function drawLabels(
  p: p5, cx: number, cy: number, r: number,
  step: number, start: number, values: number[],
) {
  p.noStroke();
  p.textAlign(p.CENTER, p.CENTER);

  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);

    // 侧面方向需要更大偏移（文字有宽度）
    const extra = Math.abs(cosA) * 14;
    const dist = r + 22 + extra;
    const ax = cx + cosA * dist;
    const ay = cy + sinA * dist;

    // 标签名（第一行）
    p.fill(100, 80, 60);
    p.textSize(11);
    p.text(LABELS[i], ax, ay);

    // 数值（第二行，标签正下方）
    p.fill(138, 117, 190, 220);
    p.textSize(13);
    p.textStyle(p.BOLD);
    p.text(String(Math.round(values[i] ?? 0)), ax, ay + 14);
    p.textStyle(p.NORMAL);
  }
}

/** 绘制数据点（带脉冲光环，受入场缩放影响） */
function drawDataPoints(
  p: p5, cx: number, cy: number, r: number,
  step: number, start: number, values: number[],
  phase: number, entryScale: number,
) {
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const v = ((values[i] ?? 0) / 100) * entryScale;
    const px = cx + Math.cos(a) * r * v;
    const py = cy + Math.sin(a) * r * v;

    const pulse = Math.sin(phase * 1.2 + i * 1.3) * 0.5 + 0.5;
    const ringSize = 10 + pulse * 6;
    p.noFill();
    p.stroke(168, 147, 210, 30 + pulse * 30);
    p.strokeWeight(1);
    p.ellipse(px, py, ringSize, ringSize);

    p.noStroke();
    p.fill(138, 117, 190, 210);
    p.ellipse(px, py, 6, 6);
  }
}
