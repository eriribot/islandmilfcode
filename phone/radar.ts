// -*- coding: utf-8 -*-
// 仅作类型使用：`import type` 在编译期被擦除，不会产生运行时 import。
// p5 的实际加载改为 mountRadarChart 内的动态 import()，详见下方说明。
import type p5 from 'p5';

/** 五维雷达图的维度标签（女神异闻录风格） */
const LABELS = ['知识', '魅力', '灵巧', '体贴', '勇气'];

/** 同心网格层数 */
const GRID_RINGS = 4;

/** 当前挂载的 p5 实例，用于防止重复挂载 */
let activeSketch: p5 | null = null;

/**
 * 挂载请求序号。每次 mount/unmount 自增，用于丢弃 p5 异步加载期间已过期的挂载请求，
 * 避免页面切走后又把 canvas 挂回去。
 */
let mountToken = 0;

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
 * p5 通过动态 import() 异步加载（webpack 会把它打成 `https://.../p5/+esm` 的
 * 外部模块）。一旦该 CDN 不可达，仅雷达图静默跳过，绝不阻塞整个前端界面的启动
 * ——这正是把它从顶层静态 import 改成动态 import 的原因：顶层 import 失败会让
 * 整个内联 module 中止执行，导致界面空白。
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
  // 标记本次挂载请求；若在异步加载期间又发起新的挂载/卸载，旧请求作废。
  const requestToken = ++mountToken;

  if (activeSketch) {
    activeSketch.remove();
    activeSketch = null;
  }

  void (async () => {
    let p5ctor: typeof p5;
    try {
      const mod = await import('p5');
      p5ctor = (mod.default ?? mod) as typeof p5;
    } catch (error) {
      // CDN 不可达等情况：放弃雷达图，但不影响其余界面。
      console.warn('[radar] p5 加载失败，跳过雷达图渲染', error);
      return;
    }

    // 异步期间状态已变化（页面切走或重新挂载），放弃这次过期的渲染。
    if (requestToken !== mountToken) return;

    activeSketch = createSketch(p5ctor, container, values, animate);
  })();
}

/** 真正构造 p5 实例的逻辑（与 p5 加载解耦）。 */
function createSketch(
  p5ctor: typeof p5,
  container: HTMLElement,
  values: number[],
  animate: boolean,
): p5 {
  const dims = 5;
  const angleStep = (Math.PI * 2) / dims;
  const startAngle = -Math.PI / 2;

  return new p5ctor((p: p5) => {
    let size = 0;
    let cx = 0;
    let cy = 0;
    let radius = 0;

    // 动画用的呼吸相位
    let breathPhase = 0;
    // 漂浮粒子池
    const particles: Particle[] = [];
    const PARTICLE_COUNT = 35;
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
          vx: p.random(-0.3, 0.3),
          vy: p.random(-0.3, 0.3),
          size: p.random(2, 6),
          alpha: p.random(40, 120),
          hue: p.random(200, 300),
        });
      }
    }

    function updateParticles() {
      const bound = radius * 1.2;
      for (const pt of particles) {
        pt.x += pt.vx + Math.sin(breathPhase + pt.hue * 0.05) * 0.2;
        pt.y += pt.vy + Math.cos(breathPhase * 0.7 + pt.hue * 0.03) * 0.2;
        if (Math.abs(pt.x) > bound) pt.vx *= -1;
        if (Math.abs(pt.y) > bound) pt.vy *= -1;
        pt.alpha = 50 + 50 * Math.sin(breathPhase * 0.8 + pt.hue * 0.01);
      }
    }

    function drawParticles() {
      p.noStroke();
      for (const pt of particles) {
        p.fill(pt.hue, 60, 90, pt.alpha / 255);
        p.ellipse(cx + pt.x, cy + pt.y, pt.size, pt.size);
        // 拖尾残影
        p.fill(pt.hue, 40, 95, pt.alpha * 0.3 / 255);
        p.ellipse(cx + pt.x - pt.vx * 3, cy + pt.y - pt.vy * 3, pt.size * 0.6, pt.size * 0.6);
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
  // 自增令牌，作废任何仍在等待 p5 加载的挂载请求。
  mountToken++;
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
  const layers = 7;
  for (let i = layers; i >= 1; i--) {
    const ratio = i / layers;
    p.fill(168, 147, 210, 8 * ratio);
    p.ellipse(cx, cy, r * 2.4 * ratio, r * 2.4 * ratio);
  }
  // 中心柔光
  p.fill(200, 180, 240, 5);
  p.ellipse(cx, cy, r * 0.8, r * 0.8);
}

function wobble(_p: p5, seed: number, i: number, phase: number): number {
  return Math.sin(seed + i * 73.7 + phase * 0.3) * 2.8
    + Math.sin(seed * 1.7 + i * 31.3 + phase * 0.5) * 1.5;
}

/** 绘制手绘风格网格（带轴线脉冲） */
function drawGrid(
  p: p5, cx: number, cy: number, r: number,
  step: number, start: number, seed: number, phase: number,
  axisPulse: number[],
) {
  p.noFill();

  // 多层手绘网格线（每层微偏移模拟铅笔重复描线）
  for (let ring = 1; ring <= GRID_RINGS; ring++) {
    const ringR = (r / GRID_RINGS) * ring;
    const passes = ring === GRID_RINGS ? 3 : 2;
    for (let pass = 0; pass < passes; pass++) {
      const alpha = ring === GRID_RINGS ? 40 - pass * 8 : 20 - pass * 5;
      p.stroke(160, 140, 110, alpha);
      p.strokeWeight(ring === GRID_RINGS ? 1.4 - pass * 0.3 : 0.9 - pass * 0.2);
      p.beginShape();
      for (let i = 0; i < 5; i++) {
        const a = start + step * i;
        const wx = wobble(p, seed + pass * 200, ring * 10 + i, phase);
        const wy = wobble(p, seed + 500 + pass * 200, ring * 10 + i, phase);
        p.vertex(cx + Math.cos(a) * ringR + wx, cy + Math.sin(a) * ringR + wy);
      }
      p.endShape(p.CLOSE);
    }
  }

  // 轴线（虚线 + 脉冲闪光 + 手绘抖动）
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const ex = cx + Math.cos(a) * r;
    const ey = cy + Math.sin(a) * r;
    const pulse = axisPulse[i];
    const segments = 10;
    for (let s = 0; s < segments; s++) {
      if (s % 2 === 1) continue;
      const t0 = s / segments;
      const t1 = (s + 1) / segments;
      const segAlpha = 25 + 20 * (1 - t0) + pulse * 100;
      p.stroke(160 - pulse * 30, 140 - pulse * 20, 110 + pulse * 80, segAlpha);
      p.strokeWeight(0.8 + pulse * 2);
      const jx = wobble(p, seed + i * 50, s, phase) * 0.4;
      const jy = wobble(p, seed + i * 50 + 300, s, phase) * 0.4;
      p.line(
        cx + (ex - cx) * t0 + jx, cy + (ey - cy) * t0 + jy,
        cx + (ex - cx) * t1 + jx, cy + (ey - cy) * t1 + jy,
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
  const breathScale = 1 + Math.sin(phase) * 0.06;
  const scale = breathScale * entryScale;

  // 外层光晕描边（模糊感）
  p.noFill();
  p.stroke(168, 147, 210, 25);
  p.strokeWeight(6);
  p.beginShape();
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const v = ((values[i] ?? 0) / 100) * scale;
    p.vertex(cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v);
  }
  p.endShape(p.CLOSE);

  // 主填充区域
  p.fill(168, 147, 210, 35);
  p.stroke(138, 117, 190, 150);
  p.strokeWeight(1.8);
  p.beginShape();
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const v = ((values[i] ?? 0) / 100) * scale;
    p.vertex(cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v);
  }
  p.endShape(p.CLOSE);

  // 内层高光核心
  p.fill(200, 180, 255, 18);
  p.noStroke();
  p.beginShape();
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const v = ((values[i] ?? 0) / 100) * scale * 0.55;
    p.vertex(cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v);
  }
  p.endShape(p.CLOSE);

  // 第二层手绘描边（偏移重叠）
  p.noFill();
  p.stroke(148, 127, 200, 60);
  p.strokeWeight(1);
  p.beginShape();
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const v = ((values[i] ?? 0) / 100) * scale;
    const jitter = Math.sin(phase * 0.5 + i * 2.1) * 1.5;
    p.vertex(cx + Math.cos(a) * r * v + jitter, cy + Math.sin(a) * r * v + jitter);
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

    // 外层扩散光环
    const outerRing = 16 + pulse * 10;
    p.noFill();
    p.stroke(168, 147, 210, 15 + pulse * 20);
    p.strokeWeight(0.8);
    p.ellipse(px, py, outerRing, outerRing);

    // 内层脉冲环
    const innerRing = 10 + pulse * 5;
    p.stroke(148, 127, 210, 40 + pulse * 50);
    p.strokeWeight(1.2);
    p.ellipse(px, py, innerRing, innerRing);

    // 核心实心点
    p.noStroke();
    p.fill(138, 117, 190, 230);
    p.ellipse(px, py, 7, 7);

    // 高光点
    p.fill(220, 200, 255, 150 + pulse * 80);
    p.ellipse(px - 1.5, py - 1.5, 2.5, 2.5);
  }
}
