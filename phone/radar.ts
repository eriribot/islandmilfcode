// -*- coding: utf-8 -*-
import p5 from 'p5';

/** 五维雷达图的维度标签 */
const LABELS = ['体力', '智力', '魅力', '幸运', '社交'];

/** 同心网格层数 */
const GRID_RINGS = 4;

/** 当前挂载的 p5 实例，用于防止重复挂载 */
let activeSketch: p5 | null = null;

/**
 * 将雷达图挂载到指定容器。
 * 如果已有实例会先销毁再重建，避免 canvas 堆叠。
 *
 * @param container  挂载目标 DOM 节点
 * @param values     五个维度的数值（0-100），顺序对应 LABELS
 */
export function mountRadarChart(container: HTMLElement, values: number[] = [50, 50, 50, 50, 50]) {
  // 销毁旧实例
  if (activeSketch) {
    activeSketch.remove();
    activeSketch = null;
  }

  const dims = 5;
  const angleStep = (Math.PI * 2) / dims;
  // 起始角度：从正上方（-90°）开始
  const startAngle = -Math.PI / 2;

  activeSketch = new p5((p: p5) => {
    let size = 0;
    let cx = 0;
    let cy = 0;
    let radius = 0;

    p.setup = () => {
      // canvas 宽度跟随容器，保持正方形
      size = container.clientWidth;
      const canvas = p.createCanvas(size, size);
      canvas.parent(container);
      p.noLoop(); // 静态图，只画一次
    };

    p.draw = () => {
      size = p.width;
      cx = size / 2;
      // 留出底部空间给标签文字
      cy = size / 2 - 4;
      radius = size * 0.32;

      p.clear();
      p.textAlign(p.CENTER, p.CENTER);
      p.textFont('Zen Maru Gothic, sans-serif');

      drawGrid(p, cx, cy, radius, angleStep, startAngle);
      drawDataArea(p, cx, cy, radius, angleStep, startAngle, values);
      drawLabels(p, cx, cy, radius, angleStep, startAngle);
      drawDataPoints(p, cx, cy, radius, angleStep, startAngle, values);
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

// ── 绘制辅助函数 ──

/** 绘制同心网格和轴线 */
function drawGrid(p: p5, cx: number, cy: number, r: number, step: number, start: number) {
  p.noFill();

  // 同心多边形网格
  for (let ring = 1; ring <= GRID_RINGS; ring++) {
    const ringR = (r / GRID_RINGS) * ring;
    const alpha = ring === GRID_RINGS ? 40 : 22;
    p.stroke(160, 140, 110, alpha);
    p.strokeWeight(1);
    p.beginShape();
    for (let i = 0; i < 5; i++) {
      const a = start + step * i;
      p.vertex(cx + Math.cos(a) * ringR, cy + Math.sin(a) * ringR);
    }
    p.endShape(p.CLOSE);
  }

  // 从中心到各顶点的轴线
  p.stroke(160, 140, 110, 30);
  p.strokeWeight(0.8);
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    p.line(cx, cy, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
}

/** 绘制数据区域（半透明填充多边形） */
function drawDataArea(
  p: p5, cx: number, cy: number, r: number,
  step: number, start: number, values: number[],
) {
  // 填充区域
  p.fill(168, 147, 210, 35);
  p.stroke(138, 117, 190, 120);
  p.strokeWeight(1.5);
  p.beginShape();
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const v = (values[i] ?? 0) / 100;
    p.vertex(cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v);
  }
  p.endShape(p.CLOSE);
}

/** 绘制维度标签文字 */
function drawLabels(p: p5, cx: number, cy: number, r: number, step: number, start: number) {
  p.noStroke();
  p.fill(100, 80, 60);
  p.textSize(11);

  const labelOffset = r + 18;
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const lx = cx + Math.cos(a) * labelOffset;
    const ly = cy + Math.sin(a) * labelOffset;
    p.text(LABELS[i], lx, ly);
  }
}

/** 绘制数据点（各顶点上的小圆点） */
function drawDataPoints(
  p: p5, cx: number, cy: number, r: number,
  step: number, start: number, values: number[],
) {
  p.noStroke();
  p.fill(138, 117, 190, 200);
  for (let i = 0; i < 5; i++) {
    const a = start + step * i;
    const v = (values[i] ?? 0) / 100;
    p.ellipse(cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v, 6, 6);
  }
}
