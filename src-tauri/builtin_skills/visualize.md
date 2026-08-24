---
name: Visualize
description: 当用户想“看”结果、要求画图/图表/可视化/模拟/演示/对比/可调参数/UI mockup，或任何内容用视觉呈现会更直观时主动调用。数据、趋势、流程、算法、关系图、方案比较、布局设计和交互概念都应优先考虑；首次使用 render_html 前必须调用。仅纯文字已足够或用户明确要求真实项目交付物时跳过。
---

用 `render_html` 在对话中构建用户可直接操作的小型可视化界面。

## 什么时候使用

- 采用高召回策略：只要可视化能让用户更快理解、比较、探索或做决定，就主动使用，不必等到文字完全无法表达。
- 用户说“给我看看”“画出来”“做个图”“模拟一下”“对比一下”“让我调参数”“做个界面看看”“mockup”“dashboard”“chart”“visualize”等意图时，默认应调用。
- 遇到数据、趋势、比例、时间变化、空间关系、算法过程、多个方案、参数影响、状态流转、UI/产品设计时，应主动判断是否用交互可视化补充答案。
- 用户没有明确要求也可以主动使用，只要可视化确实能提高理解；不要先询问“要不要做图”。
- 用户要真实网站、项目页面、组件或独立文件时，修改项目文件，不要用对话可视化代替交付物。
- 非常简单、两三句话就能说清的内容不必调用。关系图、流程图、架构图同样使用 render_html；项目没有 Mermaid 展示能力，不要输出 Mermaid 代码块代替可视化。

## 调用工具

将真实 HTML markup 直接放进 `fragment`，可选 `title` 和 `mode`。模型输出 fragment 时页面会在该工具调用所在的对话位置实时长出，完成后原位保留。

- 页面始终占满对话消息区可用宽度；`mode` 只表达内容意图和高度上限，不应通过固定宽度收窄页面。
- 默认 `mode: "inline"`；多个紧凑面板并排比较时可使用 `mode: "wide"`。
- 只写 fragment，绝不输出 `<!doctype>`、`<html>`、`<head>`、`<body>`。
- 用真实换行和真实 markup，不要输出带 `\"`、`\n` 的二次转义字符串。
- 根元素必须有唯一 ID；脚本用 `document.getElementById` 获取根，不依赖 `document.currentScript`。
- 用户可见的标签、控件、提示、图注使用当前对话主要语言。

## 安全与资源

- Inline `<style>` 和 `<script>` 可用。
- `fetch`、XHR、WebSocket、表单提交和嵌套页面被 CSP 禁止。
- 外部静态资源只允许固定并带版本的 CDN：`cdnjs.cloudflare.com`、`cdn.jsdelivr.net`、`esm.sh`、`unpkg.com`、`fonts.googleapis.com`、`fonts.gstatic.com`、`fonts.bunny.net`。
- Fragment 上限 1 MB。大数据先降采样：减少行数、分桶、降低小数精度、删除无用字段。

## 设计规范

好界面靠克制，不靠堆组件。

- 采用 8px 间距节奏，留白是设计的一部分；宁可少一个面板，不要挤四个。
- 每个可视化只有一个焦点。数值大、标签弱；颜色只用于含义和当前状态。
- 初始状态必须已经展示答案：合理默认值、已绘制图表、已填充网格，不给空画布等待用户输入。
- 动效只解释变化，150–400ms ease-out；不做装饰性循环动画。
- 动态数字使用 `font-variant-numeric: tabular-nums`，带单位、千位分隔和稳定小数位。
- 删除没有信息的边框、网格线、单系列图例、重复 KPI 卡。
- 不发明用户没要求的搜索框、筛选器、重置按钮、状态卡；一个状态只给一个控制机制。
- 内容占满可用宽度并在窄屏重排；避免固定外宽、`position: fixed`、视口高度和内部滚动条。
- 使用语义元素和原生可访问控件，不破坏键盘焦点。

## 动效是硬性验收项

每个可视化都必须有**完整、连续、可中断、符合因果关系**的动效系统。动效不是最后贴上的装饰，而要与交互和视觉同时设计。提交静态跳变、只给一个淡入、参数变化时整块重绘闪烁，均视为未完成。

### 每个可视化必须覆盖的动效

1. **首次出现**：主内容按视觉层级进入。先让结构稳定，再让数据/主要标记出现；总响应通常 300–500ms。不要所有元素同时从四面八方飞入。
2. **按下反馈**：按钮和可点击对象在 `pointerdown`/`:active` 时立即响应，不等 click。建议缩放到 `0.97–0.985`，约 80–120ms ease-out。
3. **参数变化**：滑块拖动、选择切换时，输出必须在操作过程中连续更新。图表修改 `chart.data` 后调用 `chart.update()` 原地过渡；数字、颜色、位置也要平滑变化，禁止销毁重建整个区域。
4. **状态切换**：选中、展开、添加、删除、排序都有可理解的过渡；进入与退出走对称路径，并从当前屏幕呈现值继续，不能跳回逻辑起点。
5. **完成/错误反馈**：只在真实完成或错误发生时给短促、克制的视觉反馈，和状态改变同一帧发生。

### Apple 风格运动原则

- **响应优先**：输入发生时立即反馈；绝不因动画锁住输入。
- **直接操控**：拖动对象与指针 1:1 跟随，使用 Pointer Events 和 `setPointerCapture`；保留用户抓取位置偏移，不能吸附到中心。
- **可中断性最重要**：动画中途再次操作时，从当前呈现值继续。手势驱动动画优先用 `requestAnimationFrame`/Web Animations 或可重定向弹簧，不要用无法接手当前速度的长 `@keyframes`。
- **默认临界阻尼**：普通 UI 使用无过冲的平滑弹簧（约 damping 1.0、response 0.3–0.4s）。只有拖拽释放、轻扫等真实携带动量的交互才允许轻微弹跳（约 damping 0.8）。
- **速度交接**：拖动释放后的动画继承释放速度；吸附目标应参考预测落点，而不是只看释放位置。
- **空间一致性**：元素从哪里出现，就沿同一路径回去；浮层和展开内容从触发源附近生长。
- **柔性边界**：拖过边界时逐渐增加阻力，不要突然冻结。
- **帧级流畅**：动画尽量只修改 `transform` 和 `opacity`；频繁绘制使用 `requestAnimationFrame`，避免布局抖动和大面积重排。

### 基础动效模板

普通状态反馈至少使用这种即时、克制的反馈：

```css
.interactive {
  transition: transform 120ms ease-out, opacity 180ms ease-out,
              background-color 180ms ease-out, color 180ms ease-out;
  transform-origin: center;
}
.interactive:active { transform: scale(0.975); }
.viz-enter {
  animation: viz-enter 380ms cubic-bezier(.2,.7,.3,1) both;
}
@keyframes viz-enter {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
```

手势/连续物理交互使用可中断的 `requestAnimationFrame`，而不是固定脚本：

```js
function springTo(state, target, render) {
  state.target = target;
  if (state.running) return;
  state.running = true;
  var last = performance.now();
  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.032);
    last = now;
    var stiffness = 240, damping = 30;
    var acceleration = stiffness * (state.target - state.value) - damping * state.velocity;
    state.velocity += acceleration * dt;
    state.value += state.velocity * dt;
    render(state.value);
    if (Math.abs(state.target - state.value) < 0.1 && Math.abs(state.velocity) < 0.1) {
      state.value = state.target;
      state.velocity = 0;
      state.running = false;
      render(state.value);
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
```

新输入只更新 `state.target`，现有动画继续并自然转向；不要创建第二条互相争抢的动画。

### 主题变量

每个颜色都来自以下变量或 `light-dark(light, dark)`；不要自行声明 `color-scheme`：

- 表面/文字：`--background`、`--foreground`、`--card`、`--card-foreground`、`--muted-foreground`、`--border`
- 强调：`--primary`、`--primary-foreground`
- 图表序列：`--viz-series-1` 到 `--viz-series-6`；单指标与当前状态使用 `--viz-series-1`

### 宿主基础类

- `.card`：有必要时使用的单个局部容器；fragment 根和图表本身保持透明无框，卡片不能嵌套卡片。
- `.viz-stat` / `.viz-stat-value`：统计数字。
- `.viz-grid`：响应式等宽网格。
- `.viz-row`：自动换行的相关值或操作。
- `.viz-controls`：控制条。
- `.viz-badge`：只读强调标签，不是按钮。
- `.btn` / `.btn-primary` / `.btn-ghost`：原生按钮；每组最多一个主按钮。
- `.form-label`、`.form-control`、`.form-select`、`.form-check`：原生表单控件。
- `.text-small`：次级文字；`.table-responsive` 只用于确实无法自适应的表格。

## 图表规范

标准折线、面积、柱状、散点、环形图优先使用固定版本 Chart.js：

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>
```

Canvas 不能直接读取 CSS 变量，先解析颜色：

```js
function themeColor(token) {
  var probe = document.createElement('span');
  probe.style.color = 'var(' + token + ')';
  document.body.appendChild(probe);
  var resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}
Chart.defaults.color = themeColor('--muted-foreground');
Chart.defaults.borderColor = themeColor('--border');
Chart.defaults.font.family = 'inherit';
```

- Canvas 外层容器给明确高度；使用 `responsive: true, maintainAspectRatio: false`，不要固定 canvas 宽度。
- 首次绘制保留默认入场动画。控件变化时修改 `chart.data` 后调用 `chart.update()`，原地过渡，不重建图表。
- 单指标面积图默认使用系列色约 0.25 alpha 到透明的垂直渐变；多系列或精确比较不填充。
- 单系列隐藏 legend。

自定义视觉才手写 SVG：数据域由数据计算；从容器宽度绘制并用 `ResizeObserver` 重绘；检查标签不重叠；入场动画只播放一次，重绘不重复；直接标注优先于图例和浮层 tooltip。

## 标准图表模板：必须从这里改

折线、面积、柱状、散点、环形图以此模板为起点，替换领域数据、标签与交互。保留它的主题色解析、容器驱动尺寸、初始答案、渐变与 `chart.update()` 原地更新方式。不要从零发明仪表盘布局。

```html
<div id="sim-cooling">
  <style>
    #sim-cooling .row { display: grid; grid-template-columns: 92px 1fr 72px; align-items: center; gap: 12px; margin-bottom: 10px; }
    #sim-cooling .row output { text-align: right; font-weight: 500; font-variant-numeric: tabular-nums; }
    #sim-cooling .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
    #sim-cooling .stats { display: flex; flex-wrap: wrap; gap: 8px 40px; margin: 14px 0 10px; }
    #sim-cooling .stats .viz-stat-value { font-size: 1.5em; }
  </style>
  <div class="head">
    <h3 style="margin: 0;">Coffee cooling</h3>
    <span class="text-small">T(t) = Tₐ + (T₀ − Tₐ)·e⁻ᵏᵗ</span>
  </div>
  <div class="row">
    <label class="form-label" for="sim-cooling-rate" style="margin: 0;">Cooling rate</label>
    <input id="sim-cooling-rate" type="range" min="2" max="30" step="1" value="10">
    <output id="sim-cooling-rate-out">0.10/min</output>
  </div>
  <div class="row">
    <label class="form-label" for="sim-cooling-years" style="margin: 0;">Window</label>
    <input id="sim-cooling-years" type="range" min="15" max="120" step="5" value="60">
    <output id="sim-cooling-years-out">60 min</output>
  </div>
  <div class="stats">
    <div>
      <div class="text-small">Temp at window end</div>
      <div class="viz-stat-value" id="sim-cooling-end" style="font-variant-numeric: tabular-nums;">—</div>
    </div>
    <div>
      <div class="text-small">Drinkable (≤60°C) after</div>
      <div class="viz-stat-value" id="sim-cooling-drink" style="font-variant-numeric: tabular-nums;">—</div>
    </div>
  </div>
  <div style="height: 220px; animation: sim-cooling-fade 300ms ease-out;"><canvas id="sim-cooling-plot"></canvas></div>
  <style>@keyframes sim-cooling-fade { from { opacity: 0; } }</style>
</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>
<script>
(function () {
  var rateEl = document.getElementById('sim-cooling-rate');
  var yearsEl = document.getElementById('sim-cooling-years');
  var T0 = 90, TA = 22, DRINKABLE = 60;

  function themeColor(token) {
    var probe = document.createElement('span');
    probe.style.color = 'var(' + token + ')';
    document.body.appendChild(probe);
    var resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }
  var series = themeColor('--viz-series-1');
  var faint = series.replace('rgb', 'rgba').replace(')', ', 0.25)');
  Chart.defaults.color = themeColor('--muted-foreground');
  Chart.defaults.borderColor = themeColor('--border');
  Chart.defaults.font.family = 'inherit';

  function values() {
    var k = Number(rateEl.value) / 100, n = Number(yearsEl.value);
    var out = [];
    for (var t = 0; t <= n; t++) out.push(TA + (T0 - TA) * Math.exp(-k * t));
    return out;
  }
  function fmt(v) { return v.toFixed(0) + '°C'; }

  var ctx = document.getElementById('sim-cooling-plot');
  var gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, faint);
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

  var data = values();
  var chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(function (_, y) { return y; }),
      datasets: [{
        data: data,
        borderColor: series,
        backgroundColor: gradient,
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.25,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 9 } },
        y: { ticks: { callback: fmt, maxTicksLimit: 6 } },
      },
      interaction: { mode: 'index', intersect: false },
    },
  });

  function update() {
    var data = values();
    var k = Number(rateEl.value) / 100;
    var toDrinkable = Math.log((T0 - TA) / (DRINKABLE - TA)) / k;
    document.getElementById('sim-cooling-rate-out').textContent = k.toFixed(2) + '/min';
    document.getElementById('sim-cooling-years-out').textContent = yearsEl.value + ' min';
    document.getElementById('sim-cooling-end').textContent = fmt(data[data.length - 1]);
    document.getElementById('sim-cooling-drink').textContent = toDrinkable.toFixed(1) + ' min';
    chart.data.labels = data.map(function (_, t) { return t; });
    chart.data.datasets[0].data = data;
    chart.update();
  }

  rateEl.addEventListener('input', update);
  yearsEl.addEventListener('input', update);
  update();
})();
</script>
```

## 自定义比较模板：只有 Chart.js 不合适时使用

需要直接标值、特殊空间布局或定制 hover 细节时以此模板为起点。保留透明根、直接标签、只突出领先项、ResizeObserver 和单行 hover 细节；不要添加多余网格、图例或 tooltip 面板。

```html
<div id="cmp-langs">
  <h3>Build time by toolchain</h3>
  <svg id="cmp-langs-plot" width="100%" height="150" role="img" aria-label="Build time comparison"></svg>
  <div class="text-small" id="cmp-langs-detail" style="min-height: 1.5em;">Hover a bar for the breakdown.</div>
</div>
<script>
(function () {
  var DATA = [
    { name: 'esbuild', seconds: 0.4, note: 'Go, parallel from the start' },
    { name: 'rolldown', seconds: 0.9, note: 'Rust, Rollup-compatible API' },
    { name: 'rollup', seconds: 6.8, note: 'JS, plugin ecosystem pioneer' },
    { name: 'webpack', seconds: 11.2, note: 'JS, richest loader ecosystem' },
  ];
  var root = document.getElementById('cmp-langs');
  var svg = document.getElementById('cmp-langs-plot');
  var detail = document.getElementById('cmp-langs-detail');
  var best = Math.min.apply(null, DATA.map(function (d) { return d.seconds; }));
  var max = Math.max.apply(null, DATA.map(function (d) { return d.seconds; }));

  function draw() {
    var w = svg.clientWidth || 600, rowH = 34, labelW = 84, valueW = 56;
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + DATA.length * rowH);
    svg.innerHTML = DATA.map(function (d, i) {
      var y = i * rowH, barMax = w - labelW - valueW;
      var barW = Math.max(2, d.seconds / max * barMax);
      var lead = d.seconds === best;
      return '<g data-index="' + i + '">' +
        '<text x="0" y="' + (y + 21) + '">' + d.name + '</text>' +
        '<rect x="' + labelW + '" y="' + (y + 8) + '" width="' + barW.toFixed(1) + '" height="18" rx="3" ' +
          'fill="' + (lead ? 'var(--viz-series-1)' : 'var(--border)') + '"/>' +
        '<text x="' + (labelW + barW + 8).toFixed(1) + '" y="' + (y + 21) + '" ' +
          'style="font-variant-numeric: tabular-nums;"' + (lead ? ' font-weight="500"' : '') + '>' +
          d.seconds.toFixed(1) + 's</text>' +
        '</g>';
    }).join('');
  }

  svg.addEventListener('pointermove', function (event) {
    var group = event.target.closest('g[data-index]');
    if (!group) return;
    var d = DATA[Number(group.getAttribute('data-index'))];
    detail.textContent = d.name + ' · ' + d.seconds.toFixed(1) + 's — ' + d.note;
  });
  svg.addEventListener('pointerleave', function () {
    detail.textContent = 'Hover a bar for the breakdown.';
  });

  new ResizeObserver(draw).observe(root);
  draw();
})();
</script>
```

## 完成前检查

- 脚本查询的每个元素真实存在，变量都已定义。
- 主交互会明显改变输出。
- 初始状态已可读、窄屏可用、颜色随主题变化。
- 首次进入、按下、参数连续变化、状态切换和完成/错误都有因果明确的流畅动效；动画可被再次操作中断，不锁输入、不闪烁、不整块重建。
- 普通 UI 不滥用弹跳，只有真实动量交互继承速度。
- 可视化前后最多写一两句帮助用户阅读或操作的说明；不提工具、fragment、文件或实现机制，也不要再次粘贴 markup。
