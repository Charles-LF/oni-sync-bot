<template>
  <div class="trend">
    <svg
      v-if="points.length"
      class="trend-svg"
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      role="img"
      :aria-label="`最近 ${points.length} 天提问趋势`"
    >
      <defs>
        <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" class="stop-start" />
          <stop offset="100%" class="stop-end" />
        </linearGradient>
      </defs>

      <!-- 横向网格 + 纵轴刻度 -->
      <g class="grid">
        <template v-for="tick in ticks" :key="tick.value">
          <line
            :x1="PAD.left"
            :x2="WIDTH - PAD.right"
            :y1="tick.y"
            :y2="tick.y"
            :class="{ baseline: tick.value === 0 }"
          />
          <text :x="PAD.left - 10" :y="tick.y + 4" text-anchor="end">
            {{ tick.value }}
          </text>
        </template>
      </g>

      <!-- 面积 + 折线 -->
      <path class="area" :d="areaPath" :fill="`url(#${gradientId})`" />
      <path class="line" :d="linePath" />

      <!-- 数据点 + 横轴日期 -->
      <g v-for="(point, index) in points" :key="index" class="point">
        <title>{{ point.date }} 提问 {{ point.count }} 次</title>
        <line
          class="hover-line"
          :x1="point.x"
          :x2="point.x"
          :y1="PAD.top"
          :y2="PAD.top + innerH"
        />
        <circle :cx="point.x" :cy="point.y" r="3.5" />
        <text
          v-if="point.count > 0"
          class="point-label"
          :x="point.x"
          :y="point.y - 10"
          text-anchor="middle"
        >
          {{ point.count }}
        </text>
        <text
          class="axis-label"
          :x="point.x"
          :y="HEIGHT - 12"
          text-anchor="middle"
        >
          {{ formatDayTick(point.date) }}
        </text>
      </g>
    </svg>

    <p v-else class="empty">
      <span>暂无提问记录</span>
    </p>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { formatDayTick } from "../../shared/time";

/**
 * 零依赖 SVG 折线图（提问趋势）。
 *
 * 控制台已经带了 ECharts 之外的一整套 UI 依赖，为了这一张 7 点的折线图
 * 再引 1MB 的图表库并不划算，所以这里用 `viewBox` + 平滑贝塞尔自己画：
 * 面积渐变、网格、刻度、悬停提示（原生 `<title>`）都已具备。
 */
const props = withDefaults(
  defineProps<{ data: Array<{ date: string; count: number }> }>(),
  { data: () => [] },
);

const WIDTH = 720;
const HEIGHT = 260;
/** 内边距：左侧留给纵轴刻度，底部留给日期 */
const PAD = { top: 24, right: 16, bottom: 34, left: 40 };

const innerW = WIDTH - PAD.left - PAD.right;
const innerH = HEIGHT - PAD.top - PAD.bottom;

/** 同一页面可能有多个图表，渐变 id 必须唯一 */
const gradientId = `ai-trend-${Math.random().toString(36).slice(2, 8)}`;

interface ChartPoint {
  x: number;
  y: number;
  date: string;
  count: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 把最大值抬到「好看」的刻度上（4 / 5 / 10 / 20 …），避免纵轴出现 7 这种数 */
function niceCeil(value: number): number {
  if (value <= 4) return 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

const maxValue = computed(() =>
  niceCeil(Math.max(...props.data.map((item) => item.count), 1)),
);

const points = computed<ChartPoint[]>(() => {
  const list = props.data ?? [];
  if (list.length === 0) return [];

  const step = list.length > 1 ? innerW / (list.length - 1) : 0;
  return list.map((item, index) => {
    const x =
      list.length > 1 ? PAD.left + step * index : PAD.left + innerW / 2;
    const ratio = item.count / maxValue.value;
    return {
      x: round(x),
      y: round(PAD.top + innerH - ratio * innerH),
      date: item.date,
      count: item.count,
    };
  });
});

const ticks = computed(() => {
  const steps = 4;
  return Array.from({ length: steps + 1 }, (_, index) => ({
    value: Math.round((maxValue.value / steps) * (steps - index)),
    y: round(PAD.top + (innerH / steps) * index),
  }));
});

/** Catmull-Rom 转三次贝塞尔：7 个点用平滑曲线比折线更耐看 */
function smoothPath(list: ChartPoint[]): string {
  if (list.length === 0) return "";
  if (list.length === 1) return `M${list[0].x},${list[0].y}`;

  let path = `M${list[0].x},${list[0].y}`;
  for (let index = 0; index < list.length - 1; index++) {
    const prev = list[index === 0 ? 0 : index - 1];
    const current = list[index];
    const next = list[index + 1];
    const after = list[index + 2] ?? next;

    const c1x = round(current.x + (next.x - prev.x) / 6);
    const c1y = round(current.y + (next.y - prev.y) / 6);
    const c2x = round(next.x - (after.x - current.x) / 6);
    const c2y = round(next.y - (after.y - current.y) / 6);
    path += ` C${c1x},${c1y} ${c2x},${c2y} ${next.x},${next.y}`;
  }
  return path;
}

const linePath = computed(() => smoothPath(points.value));

const areaPath = computed(() => {
  const list = points.value;
  if (list.length === 0) return "";
  const bottom = PAD.top + innerH;
  const first = list[0];
  const last = list[list.length - 1];
  return `${linePath.value} L${last.x},${bottom} L${first.x},${bottom} Z`;
});
</script>

<style lang="scss" scoped>
.trend {
  width: 100%;
}

.trend-svg {
  width: 100%;
  height: auto;
  overflow: visible;
}

.stop-start {
  stop-color: var(--el-color-primary);
  stop-opacity: 0.3;
}

.stop-end {
  stop-color: var(--el-color-primary);
  stop-opacity: 0;
}

.grid {
  line {
    stroke: var(--el-border-color-lighter);
    stroke-width: 1;
    stroke-dasharray: 4 4;

    &.baseline {
      stroke: var(--el-border-color);
      stroke-dasharray: none;
    }
  }

  text {
    font-size: 11px;
    fill: var(--el-text-color-placeholder);
  }
}

.area {
  stroke: none;
}

.line {
  fill: none;
  stroke: var(--el-color-primary);
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.point {
  circle {
    fill: var(--el-bg-color);
    stroke: var(--el-color-primary);
    stroke-width: 2.2;
  }

  .point-label,
  .axis-label {
    font-size: 11px;
    fill: var(--el-text-color-secondary);
  }

  .point-label {
    font-weight: 600;
    fill: var(--el-color-primary);
    opacity: 0;
    transition: opacity 0.15s;
  }

  .hover-line {
    stroke: var(--el-color-primary);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    opacity: 0;
    transition: opacity 0.15s;
  }

  &:hover {
    circle {
      r: 5;
      fill: var(--el-color-primary);
    }

    .point-label,
    .hover-line {
      opacity: 1;
    }
  }
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
