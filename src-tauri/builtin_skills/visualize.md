---
name: Visualize
description: 当用户想“看”结果、要求画图/图表/可视化/模拟/演示/对比/可调参数/UI mockup，或任何内容用视觉呈现会更直观时主动调用。数据、趋势、流程、算法、关系图、方案比较、布局设计和交互概念都应优先考虑；首次使用 render_html 前必须调用。仅纯文字已足够或用户明确要求真实项目交付物时跳过。
---

用 `render_html` 在对话中构建用户可直接操作的小型可视化界面。

## 一条原则

**一切服务于你想表达的内容。** 先把“要让人看到什么、理解什么、能动手试什么”想清楚，再决定形式——形式可以是数据图、示意图、算法动画、可玩的模拟、界面草图，也可以只是排得好看的一段文字，没有哪种是默认答案。不要因为常见就把内容塞进同一个形状，也不要把任何内容都掰成“滑块 + 一张图”。

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
- 默认 `mode: "inline"`；需要更宽画面时用 `mode: "wide"`。
- 只写 fragment，绝不输出 `<!doctype>`、`<html>`、`<head>`、`<body>`。
- `fragment` 是 JSON 字符串：换行写 `\n`、引号写 `\"`，不要留裸换行或未转义引号；也不要二次转义（`\\n` 会变成字面反斜杠，不是换行）。
- 根元素必须有唯一 ID；脚本用 `document.getElementById` 获取根，不依赖 `document.currentScript`。
- 用户可见的标签、控件、提示、图注使用当前对话主要语言。

## 安全与资源

- Inline `<style>` 和 `<script>` 可用。
- `fetch`、XHR、WebSocket、表单提交和嵌套页面被 CSP 禁止。
- 外部静态资源只允许固定并带版本的 CDN：`cdnjs.cloudflare.com`、`cdn.jsdelivr.net`、`esm.sh`、`unpkg.com`、`fonts.googleapis.com`、`fonts.gstatic.com`、`fonts.bunny.net`。
- Fragment 上限 1 MB。大数据先降采样：减少行数、分桶、降低小数精度、删除无用字段。

## 设计规范

- 采用 8px 间距节奏；留白是设计的一部分。
- 一个可视化只有一个焦点：先让信息量最大的东西最大、最清楚，其余退到背景里。
- 数值大、标签弱：数值是主角，标签用小字号和弱色退到背景；颜色只用于含义和当前状态，不做装饰。
- 排版跟着阅读顺序走：先说清“这是什么、怎么操作”，再呈现画面；读数和标注放在它解释的东西旁边。
- 宁可少一个面板，不要挤四个。
- 初始状态必须已经展示答案：合理默认值、已绘制、已填充，不给空画布等待用户输入。
- 动态数字使用 `font-variant-numeric: tabular-nums`，带单位、千位分隔和稳定小数位。
- 控件只在能改变理解时出现；一个状态只给一个控制机制。
- 内容占满可用宽度并在窄屏重排；避免固定外宽、`position: fixed`、视口高度和内部滚动条。
- 使用语义元素和原生可访问控件，不破坏键盘焦点。
- 不承载信息的装饰——没有含义的边框、网格线、图例、重复卡片——直接删掉。

## 与宿主融合

界面已经提供主题变量和基础样式，直接使用，视觉上就像应用自己长出来的。

颜色只用以下变量或 `light-dark(light, dark)`；不要自行声明 `color-scheme`：

- 表面/文字：`--background`、`--foreground`、`--card`、`--card-foreground`、`--muted-foreground`、`--border`
- 强调：`--primary`、`--primary-foreground`
- 数据序列：`--viz-series-1` 到 `--viz-series-6`；单指标与当前状态使用 `--viz-series-1`

基础类：`.card`（有必要时使用的单个局部容器；fragment 根与画面主体保持透明无框，卡片不能嵌套卡片）、`.viz-row` / `.viz-grid` / `.viz-controls`（排布）、`.viz-stat` / `.viz-stat-value`（数字）、`.viz-badge`（只读标签）、`.btn` / `.btn-primary` / `.btn-ghost`、`.form-label` / `.form-control` / `.form-select` / `.form-check`、`.text-small`、`.table-responsive`（只用于确实无法自适应的表格）。

控件与文字要长得像应用自己的——尺寸、字重、间距、状态都跟着主题走，不要另发明一套视觉语言：

```html
<div class="viz-controls">
  <button class="btn btn-primary" id="recompute">重新计算</button>
  <button class="btn btn-ghost" id="reset">复位</button>
  <label class="form-check"><input type="checkbox" id="show-raw" checked> 显示原始值</label>
  <span class="text-small">与基线相差 <span class="viz-badge">+12%</span></span>
</div>
```

## 动效是硬性验收项

每个可视化都必须有完整、连续、可中断、符合因果关系的动效；静默跳变、只给一次淡入、参数变化时整块重绘闪烁，都算未完成。动效与交互、视觉同时设计，不是最后贴上去的装饰。动效只解释变化（150–400ms ease-out），不做装饰性循环动画。

必须覆盖：首次出现（主内容按视觉层级进入，先结构后数据，总响应 300–500ms，不要所有元素从四面八方飞入）、按下反馈（`pointerdown` / `:active` 立即响应，不等 click，缩放到 0.97–0.985，80–120ms ease-out）、参数变化（操作过程中连续更新，改数据后原地过渡，禁止销毁重建）、状态切换（进入与退出走对称路径，从当前呈现值继续，不跳回逻辑起点）、完成/错误反馈（真实发生时才给，短促克制）。

运动原则：

- 响应优先：输入发生时立即反馈，绝不因动画锁住输入。
- 直接操控：拖动与指针 1:1 跟随，使用 Pointer Events 和 `setPointerCapture`，保留抓取偏移。
- **可中断性最重要**：动画中途再次操作，从当前呈现值继续；手势驱动用 `requestAnimationFrame` 或可重定向弹簧，不用无法接手当前速度的长 `@keyframes`。
- 默认临界阻尼：普通 UI 用无过冲弹簧（damping ≈ 1.0、response 0.3–0.4s）；只有真实携带动量的交互（拖拽释放、轻扫）允许轻微弹跳。
- 速度交接、空间一致性、柔性边界：释放后继承速度并按预测落点吸附；元素从哪来就沿同一路径回去；拖过边界逐渐加阻力。
- 动画尽量只修改 `transform` 和 `opacity`，避免布局抖动和大面积重排。

普通状态反馈：

```css
.interactive {
  transition: transform 120ms ease-out, opacity 180ms ease-out,
              background-color 180ms ease-out, color 180ms ease-out;
  transform-origin: center;
}
.interactive:active { transform: scale(0.975); }
.viz-enter { animation: viz-enter 380ms cubic-bezier(.2,.7,.3,1) both; }
@keyframes viz-enter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
```

连续、可中断的数值或位置变化用弹簧推进器；新输入只更新 `state.target`，现有动画自然转向，不要开第二条互相争抢的动画：

```js
function springTo(state, target, render) {
  state.target = target;
  if (state.running) return;
  state.running = true;
  var last = performance.now();
  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.032);
    last = now;
    var acceleration = 240 * (state.target - state.value) - 30 * state.velocity;
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

## 图表是选项之一，不是默认

先看内容在回答什么问题——随时间变化、比较若干对象、看分布、看关系、看构成——形式跟着问题走。能用直接标注、位置、大小、颜色说清的，就不必上坐标轴；只有确实需要刻度、多系列或交互探查时才用图表库，用完即走。

- 标准折线、柱状、散点、环形可以用固定版本的 Chart.js：`https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js`。
- Canvas 读不到 CSS 变量，先解析再交给库：

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

- 图表容器给明确高度，用 `responsive: true, maintainAspectRatio: false`；数值变化时改 `chart.data` 后 `chart.update()` 原地过渡，不重建图表。
- 单指标面积图使用系列色约 0.25 alpha 到透明的垂直渐变，端点按容器实际高度计算，不写字面量；多系列或精确比较不填充；单系列隐藏 legend。
- 自己画 SVG 时：数据域由数据计算；从容器宽度绘制并随 `ResizeObserver` 重绘；检查标签不重叠；入场动画只播放一次，重绘不重复。
- 直接标注优先于图例和浮层 tooltip；单位落在刻度或轴上，不要只写在读数里；小数位数保持稳定。

## 示例：一条会堵的队列

下面是一个把本文档所有契约合在一起的完整示例：形式由内容决定（讲“堵”就画一条流动的队列，而不是报表），排版只服务阅读，颜色与控件全部来自宿主，五类动效各就各位。从它学判断和手感，不是照抄的骨架——换一个内容，形式就该跟着换。

```html
<div id="marcel-queue-demo">
  <style>
    #marcel-queue-demo .q-head{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px;margin-bottom:10px;animation:q-in 300ms ease-out 40ms backwards}
    #marcel-queue-demo .q-head h3{margin:0}
    #marcel-queue-demo .q-stats{display:flex;gap:26px;animation:q-in 300ms ease-out 120ms backwards}
    #marcel-queue-demo .q-stat{display:flex;flex-direction:column;align-items:flex-end}
    #marcel-queue-demo .q-stat .form-label{margin:0}
    #marcel-queue-demo .q-num{font-variant-numeric:tabular-nums;font-size:1.3em;font-weight:500;line-height:1.2}
    #marcel-queue-demo .q-unit{font-size:.6em;color:var(--muted-foreground);margin-left:2px;font-weight:400}
    #marcel-queue-demo .q-stage{position:relative;animation:q-in 300ms ease-out 140ms backwards}
    #marcel-queue-demo canvas{display:block;border-radius:var(--radius);touch-action:none}
    #marcel-queue-demo .viz-controls{margin-top:10px;animation:q-in 300ms ease-out 240ms backwards}
    #marcel-queue-demo .q-step{display:flex;flex-direction:column}
    #marcel-queue-demo .q-step .viz-row{gap:6px}
    #marcel-queue-demo .q-val{font-variant-numeric:tabular-nums;min-width:74px;text-align:center;font-weight:500}
    #marcel-queue-demo .q-val .q-unit{font-size:11px}
    #marcel-queue-demo .q-step .btn{width:30px;height:28px;padding:0;justify-content:center;font-weight:500}
    #marcel-queue-demo .q-gate-badge{display:none}
    #marcel-queue-demo .q-gate-badge.on{display:inline-block}
    @keyframes q-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    @media (prefers-reduced-motion:reduce){#marcel-queue-demo .q-head,#marcel-queue-demo .q-stage,#marcel-queue-demo .viz-controls{animation:none}}
  </style>

  <div class="q-head">
    <div>
      <h3>一条会堵的队列</h3>
      <div class="text-small">直接拖动橙色闸门改变开口 · 参数随时可调，过程连续呈现</div>
    </div>
    <div class="q-stats">
      <div class="q-stat"><span class="form-label">平均等待</span><span class="q-num" id="q-wait">—</span></div>
      <div class="q-stat"><span class="form-label">排队中</span><span class="q-num" id="q-q">0<span class="q-unit">人</span></span></div>
      <div class="q-stat"><span class="form-label">已服务</span><span class="q-num" id="q-done">0</span></div>
    </div>
  </div>

  <div class="q-stage"><canvas id="q-canvas"></canvas></div>

  <div class="viz-controls">
    <div class="q-step">
      <span class="form-label">到达率 λ</span>
      <div class="viz-row">
        <button class="btn" type="button" data-k="l" data-d="-1">−</button>
        <span class="q-val" id="q-lv">1.0<span class="q-unit">/s</span></span>
        <button class="btn" type="button" data-k="l" data-d="1">＋</button>
      </div>
    </div>
    <div class="q-step">
      <span class="form-label">服务率 μ</span>
      <div class="viz-row">
        <button class="btn" type="button" data-k="m" data-d="-1">−</button>
        <span class="q-val" id="q-mv">1.4<span class="q-unit">/s</span></span>
        <button class="btn" type="button" data-k="m" data-d="1">＋</button>
      </div>
    </div>
    <span class="viz-badge q-gate-badge" id="q-gb">闸门限制了服务</span>
  </div>

  <script>
  (function(){
    var root=document.getElementById('marcel-queue-demo');
    var cv=document.getElementById('q-canvas'),ctx=cv.getContext('2d');
    function probe(){var s=document.createElement('span');s.style.cssText='position:absolute;visibility:hidden;pointer-events:none';document.body.appendChild(s);
      function g(n){s.style.color=n;return getComputedStyle(s).color;}
      var c={p:g('var(--viz-series-1)'),o:g('var(--viz-series-2)'),gr:g('var(--viz-series-3)'),fg:g('var(--foreground)'),mut:g('var(--muted-foreground)'),bd:g('var(--border)'),card:g('var(--card)')};
      s.remove();return c;}
    var C=probe(),probeTick=0;

    var W=680,H=280,laneY,laneH=56,serverX,xSpawn,gMin,gMax;
    function layout(){laneY=H*0.56;serverX=W*0.76;xSpawn=34;gMin=xSpawn+128;gMax=Math.max(gMin+40,serverX-74);}
    function resize(){var st=root.querySelector('.q-stage');W=Math.max(320,st.getBoundingClientRect().width);H=280;
      var dpr=window.devicePixelRatio||1;cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);
      cv.style.width='100%';cv.style.height=H+'px';ctx.setTransform(dpr,0,0,dpr,0,0);layout();}
    if('ResizeObserver' in window){new ResizeObserver(resize).observe(root.querySelector('.q-stage'));}
    resize();

    var lamT=1.0,muT=1.4,lam=1.0,mu=1.4;
    var ents=[],server=null,served=0,waitE=0,spawnAcc=0,pulse=0;
    var gx,gv=0,drag=false,dOff=0;
    gx=gMin+0.35*(gMax-gMin);
    function openness(){var t=(gx-gMin)/(gMax-gMin);return 1-t*0.7;} // 1 → 0.3
    function clampGx(x){return Math.min(gMax,Math.max(gMin,x));}

    var t0=performance.now(),last=t0;
    var rm=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
    function easeT(x){return x<0?0:x>1?1:1-(1-x)*(1-x);}

    function spawn(){if(ents.length>32)return;ents.push({x:xSpawn,st:'go',born:performance.now(),a:0});}

    // ── 参数步进：按下即生效（pointerdown，不等 click）
    root.querySelectorAll('button[data-k]').forEach(function(b){
      b.addEventListener('pointerdown',function(e){e.preventDefault();
        var d=+b.dataset.d;
        if(b.dataset.k==='l')lamT=Math.min(3,Math.max(0.2,Math.round((lamT+0.2*d)*10)/10));
        else muT=Math.min(3,Math.max(0.2,Math.round((muT+0.2*d)*10)/10));
        syncVals();});
    });
    function syncVals(){
      document.getElementById('q-lv').innerHTML=lamT.toFixed(1)+'<span class="q-unit">/s</span>';
      document.getElementById('q-mv').innerHTML=muT.toFixed(1)+'<span class="q-unit">/s</span>';}

    // ── 闸门拖拽：1:1 跟随，保留抓取偏移，越界渐阻
    function px(e){var r=cv.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
    function nearGate(p){return Math.abs(p.x-gx)<20&&Math.abs(p.y-(laneY-laneH/2-18))<22;}
    cv.addEventListener('pointerdown',function(e){var p=px(e);
      if(nearGate(p)||Math.abs(p.x-gx)<14&&Math.abs(p.y-laneY)<laneH/2+6){
        drag=true;dOff=gx-p.x;cv.setPointerCapture(e.pointerId);cv.style.cursor='grabbing';e.preventDefault();}});
    cv.addEventListener('pointermove',function(e){var p=px(e);
      if(drag){var raw=p.x+dOff;
        if(raw>gMax)gx=gMax+(raw-gMax)*0.18;else if(raw<gMin)gx=gMin+(raw-gMin)*0.18;else gx=raw;}
      else cv.style.cursor=nearGate(p)?'grab':'default';});
    function endDrag(){if(!drag)return;drag=false;gv=0;cv.style.cursor='grab';}
    cv.addEventListener('pointerup',endDrag);cv.addEventListener('pointercancel',endDrag);

    var statT=0;
    function frame(now){
      var dt=Math.min(0.05,(now-last)/1000);last=now;
      if(++probeTick>36){probeTick=0;C=probe();}
      var tt=(now-t0)/1000;
      var aS=rm?1:easeT(tt/0.28), aD=rm?1:easeT((tt-0.15)/0.3);

      // 参数平滑趋近目标（连续过渡，可随时再改）
      lam+=(lamT-lam)*Math.min(1,dt*4);
      mu+=(muT-mu)*Math.min(1,dt*4);
      var o=openness(),muEff=mu*(0.15+0.85*o);

      // 闸门释放后的临界阻尼弹簧，从当前位置继续
      if(!drag){var tgt=clampGx(gx);if(Math.abs(tgt-gx)>0.1||Math.abs(gv)>1){
        var k=Math.pow(2*Math.PI/0.35,2);
        gv+=(k*(tgt-gx)-2*Math.sqrt(k)*gv)*dt;gx+=gv*dt;}
        else{gx=tgt;gv=0;}}

      // 到达（泊松）
      spawnAcc+=lam*dt;while(spawnAcc>=1){spawnAcc--;spawn();}

      // 排队：按 x 排序，前位紧贴闸门
      var wait=ents.filter(function(e){return e.st==='go'&&e.x>gx-40||e.st==='q';});
      wait.sort(function(a,b){return b.x-a.x;});
      var fp=gx-16,sp=18;
      for(var i=0;i<wait.length;i++){var e=wait[i];
        var slot=fp-i*sp;
        if(e.st==='go'){if(e.x<slot)e.x=Math.min(e.x+110*dt,slot);if(e.x>=slot-2)e.st='q';}
        if(e.st==='q'){e.x+=(slot-e.x)*Math.min(1,dt*8);}}
      // 其余前进的实体
      ents.forEach(function(e){
        if(e.st==='go'&&!wait.some(function(w){return w===e;}))
          e.x+=110*dt*(e.x>gx-24&&e.x<gx+10?o:1); // 过闸口随开口减速
        if(e.st==='exit'){e.x+=170*dt;e.a=Math.min(1,e.a+dt*4);}
      });
      // 收位：服务台空闲则放行队首
      if(!server&&wait.length&&wait[0].st==='q'&&wait[0].x>fp-5){
        var f=wait[0];f.st='in';server={e:f,t:0,dur:Math.max(0.3,1/muEff)};
        var w=(now-f.born)/1000;waitE=waitE?waitE*0.88+w*0.12:w;
      }
      if(server){server.t+=dt;server.e.x+=(serverX-16-server.e.x)*Math.min(1,dt*3);
        if(server.t>=server.dur){var de=server.e;de.st='exit';de.a=1;server=null;served++;pulse=1;}}
      pulse=Math.max(0,pulse-dt*3);
      ents=ents.filter(function(e){return e.x<W+24;});

      draw(aS,aD,o,muEff);

      statT+=dt;
      if(statT>0.12){statT=0;
        document.getElementById('q-wait').innerHTML=(waitE?waitE.toFixed(1):'0.0')+'<span class="q-unit">s</span>';
        document.getElementById('q-q').innerHTML=wait.filter(function(e){return e.st!=='exit'&&e.st!=='in';}).length+'<span class="q-unit">人</span>';
        document.getElementById('q-done').textContent=served;
        document.getElementById('q-gb').classList.toggle('on',o<0.75);}
      requestAnimationFrame(frame);
    }

    function rr(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
    function draw(aS,aD,o,muEff){
      ctx.clearRect(0,0,W,H);
      // 轨道
      ctx.globalAlpha=aS;ctx.strokeStyle=C.bd;ctx.lineWidth=1.5;
      rr(xSpawn-16,laneY-laneH/2,W-14-(xSpawn-16),laneH,14);ctx.stroke();
      ctx.fillStyle=C.card;rr(xSpawn-16,laneY-laneH/2,serverX-46-(xSpawn-16),laneH,14);ctx.fill();
      // 实体
      ctx.globalAlpha=aD;
      ents.forEach(function(e){
        var al=e.st==='exit'?e.a*Math.max(0,1-Math.max(0,(e.x-(W-46))/60)):1;
        ctx.globalAlpha=aD*al;
        ctx.fillStyle=e.st==='q'?C.o:C.p;
        ctx.beginPath();ctx.arc(e.x,laneY,7,0,7);ctx.fill();});
      ctx.globalAlpha=aD;
      // 闸门
      var open=o*laneH,gTop=laneY-open/2,gBot=laneY+open/2,kY=laneY-laneH/2-18;
      ctx.fillStyle=C.o;
      rr(gx-3,laneY-laneH/2,6,Math.max(0,gTop-(laneY-laneH/2)),3);ctx.fill();
      rr(gx-3,gBot,6,Math.max(0,(laneY+laneH/2)-gBot),3);ctx.fill();
      ctx.beginPath();ctx.arc(gx,kY,10,0,7);ctx.fillStyle=C.o;ctx.fill();
      ctx.strokeStyle='rgba(255,255,255,.75)';ctx.lineWidth=1.5;
      ctx.beginPath();ctx.moveTo(gx-4,kY-3);ctx.lineTo(gx+4,kY-3);ctx.moveTo(gx-4,kY+3);ctx.lineTo(gx+4,kY+3);ctx.stroke();
      // 服务台
      ctx.beginPath();ctx.arc(serverX,laneY,30,0,7);ctx.fillStyle=C.card;ctx.fill();
      ctx.strokeStyle=C.bd;ctx.lineWidth=1.5;ctx.stroke();
      if(server){ctx.beginPath();ctx.arc(serverX,laneY,24,-Math.PI/2,-Math.PI/2+server.t/server.dur*Math.PI*2);
        ctx.strokeStyle=C.p;ctx.lineWidth=4;ctx.lineCap='round';ctx.stroke();
        ctx.fillStyle=C.p;ctx.beginPath();ctx.arc(serverX,laneY,8,0,7);ctx.fill();}
      if(pulse>0){ctx.globalAlpha=aD*pulse*0.7;ctx.beginPath();ctx.arc(serverX,laneY,30+(1-pulse)*10,0,7);
        ctx.strokeStyle=C.gr;ctx.lineWidth=2;ctx.stroke();ctx.globalAlpha=aD;}
      // 直接标注
      ctx.fillStyle=C.mut;ctx.font='11px system-ui,-apple-system,sans-serif';ctx.textBaseline='alphabetic';
      ctx.textAlign='left';ctx.fillText('到达 '+lam.toFixed(1)+'/s',xSpawn-8,laneY-laneH/2-14);
      ctx.textAlign='center';
      ctx.fillText((server?'服务中 ':'有效服务 ')+muEff.toFixed(1)+'/s',serverX,laneY+laneH/2+26);
      var qn=ents.filter(function(e){return e.st==='q';}).length;
      if(qn>0)ctx.fillText('排队 '+qn,gx-16-(qn*18)/2,laneY-laneH/2-14);
      ctx.textAlign='left';ctx.fillText('开口 '+Math.round(o*100)+'%',gx+16,kY+4);
      // 队列过长提示
      if(qn>=14){ctx.fillStyle=C.o;ctx.fillText('队列在变长，试试提高 μ 或拉大闸门',xSpawn+40,laneY-laneH/2-14);}
      ctx.globalAlpha=1;
    }
    requestAnimationFrame(frame);
  })();
  </script>
</div>
```

值得注意的细节：

- 排版只有三层：标题与操作提示（`.text-small`）、右上角三个读数（数值大标签弱、`tabular-nums`）、画面本体；根元素无框，没有包卡片。
- 颜色全部经探针从主题变量解析（`--viz-series-1/2/3`、`--border`、`--card`），画布跟着深浅主题走。
- 五个动效点：分层进场（40–240ms 依次 `q-in`）、按钮 `pointerdown` 即反馈、λ/μ 与开口变化时流量连续过渡、拖闸门 1:1 跟随 + 越界渐阻 + 松手临界阻尼弹簧收敛、服务完成一圈短促脉冲与计数同帧。
- `prefers-reduced-motion` 时直接关掉入场动画，状态变化保留。
- 直接标注（“到达 1.0/s”“开口 35%”“排队 N”）画在它解释的东西旁边，不用图例、不做浮层。

## 完成前检查

- 形式是从内容推出来的，不是从习惯推出来的。
- 脚本查询的每个元素真实存在，变量都已定义。
- 主交互会明显改变输出。
- 初始状态已可读、窄屏可用、颜色随主题变化。
- 首次进入、按下、参数连续变化、状态切换和完成/错误都有因果明确的流畅动效；动画可被再次操作中断，不锁输入、不闪烁、不整块重建。
- 可视化前后最多写一两句帮助用户阅读或操作的说明；不提工具、fragment、文件或实现机制，也不要再次粘贴 markup。
