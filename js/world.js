/* ============================================================
   World — 池塘的全部：实体、水感物理、池核渲染。
   俯视视角。水面层（荷叶/鸭子/涟漪）半透明覆盖在水下（鱼/水草/物品）之上。
   ============================================================ */
(function () {
  const G = (window.G = window.G || {});
  G.W = 2000; G.H = 1300;

  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
  G.lerp = lerp; G.clamp = clamp; G.rand = rand; G.dist = dist; G.TAU = TAU;

  /* ---------- 调色板 ---------- */
  const PALETTES = {
    title:  { top: '#1d5c94', mid: '#2f9e8e', bottom: '#b9ece0', caustic: 0.5,  duck: 1 },
    ch1:    { top: '#1d6ea8', mid: '#2fa392', bottom: '#bfeee0', caustic: 0.55, duck: 1 },
    ch2:    { top: '#2277a0', mid: '#35a898', bottom: '#c6f0e2', caustic: 0.52, duck: 1 },
    ch3:    { top: '#1a5c8a', mid: '#2a8a86', bottom: '#9fdcd0', caustic: 0.42, duck: 1 },
    ch4:    { top: '#3a5a8c', mid: '#6a8ea0', bottom: '#d8ccc8', caustic: 0.3,  duck: 0.35 },
    ch5:    { top: '#0a2436', mid: '#0e3a3e', bottom: '#1a4a50', caustic: 0.12, duck: 0 },
    ch6:    { top: '#2a7ab0', mid: '#48b8a8', bottom: '#d2f4ea', caustic: 0.72, duck: 0.8 },
    ending: { top: '#206090', mid: '#2f9e8e', bottom: '#bfeee0', caustic: 0.52, duck: 1 },
  };
  G.setPalette = (name) => { G.palette = PALETTES[name] || PALETTES.ch1; };

  /* ---------- 状态容器 ---------- */
  const W = (G.world = {
    lilies: [], ducks: [], weeds: [], foods: [], petals: [],
    bubbles: [], ripples: [], particles: [], items: [], sparkles: [],
    obstacles: [], currents: [], tangles: [], door: null,
    t: 0, duckFreeze: 0, causticTile: null, grain: null,
  });

  /* ---------- 光斑贴图 / 胶片颗粒（离屏缓存） ---------- */
  function makeCaustics() {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    // 大而柔的光斑；每个斑在九宫格方向各画一次，保证平铺无缝
    for (let i = 0; i < 26; i++) {
      const px = rand(0, size), py = rand(0, size);
      const r = rand(50, 130);
      const a = rand(0.025, 0.055);
      const sy = rand(0.5, 0.85);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const g = x.createRadialGradient(0, 0, 0, 0, 0, r);
          g.addColorStop(0, `rgba(224,255,246,${a})`);
          g.addColorStop(0.6, `rgba(224,255,246,${a * 0.45})`);
          g.addColorStop(1, 'rgba(224,255,246,0)');
          x.save();
          x.translate(px + ox * size, py + oy * size);
          x.scale(1, sy);
          x.fillStyle = g;
          x.beginPath();
          x.arc(0, 0, r, 0, TAU);
          x.fill();
          x.restore();
        }
      }
    }
    W.causticTile = c;
  }
  function makeGrain() {
    W.grain = [];
    for (let n = 0; n < 3; n++) {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const x = c.getContext('2d');
      const img = x.createImageData(256, 256);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 14;
      }
      x.putImageData(img, 0, 0);
      W.grain.push(c);
    }
  }

  /* ---------- 关卡布置 ---------- */
  G.initPond = function (chapter) {
    W.lilies = []; W.ducks = []; W.weeds = []; W.foods = []; W.petals = [];
    W.bubbles = []; W.ripples = []; W.items = []; W.sparkles = [];
    W.obstacles = []; W.currents = []; W.tangles = []; W.door = null;
    W.duckFreeze = 0;
    if (!W.causticTile) { makeCaustics(); makeGrain(); }
    G.setPalette(chapter === 'title' ? 'title' : 'ch' + chapter);

    const lilyCount = { 1: 9, 2: 8, 3: 7, 4: 6, 5: 0, 6: 5 }[chapter] ?? 8;
    for (let i = 0; i < lilyCount; i++) {
      W.lilies.push({
        x: rand(150, G.W - 150), y: rand(130, G.H - 130), r: rand(46, 84),
        a: rand(0, TAU), sway: 0, swayV: 0, px: 0, py: 0, closed: chapter >= 4 && chapter < 5 && i % 2 === 0,
      });
    }
    // 荷叶避开中心出生点
    W.lilies.forEach((l) => { if (dist(l.x, l.y, G.W / 2, G.H / 2) < 220) { l.x += 420; l.y += 260; } });

    const duckCount = Math.round(({ 1: 5, 2: 4, 3: 5, 4: 3, 6: 4 }[chapter] ?? 0) * (G.palette.duck ?? 1));
    for (let i = 0; i < duckCount; i++) {
      W.ducks.push({
        x: rand(220, G.W - 220), y: rand(180, G.H - 260),
        vx: 0, vy: 0, phase: rand(0, TAU), look: 0, faded: chapter === 4,
      });
    }

    const weedClusters = { 1: 6, 2: 7, 3: 6, 4: 5, 5: 10, 6: 4 }[chapter] ?? 5;
    for (let i = 0; i < weedClusters; i++) {
      const wx = rand(120, G.W - 120), wy = rand(110, G.H - 110);
      addWeedCluster(wx, wy, chapter === 5 ? 16 : 9, chapter === 5);
    }

    const petalCount = { 1: 14, 2: 12, 3: 8, 4: 5, 6: 8 }[chapter] ?? 6;
    for (let i = 0; i < petalCount; i++) {
      W.petals.push({ x: rand(0, G.W), y: rand(0, G.H), a: rand(0, TAU), s: rand(0.6, 1), drift: rand(0.4, 1) });
    }

    for (let i = 0; i < 34; i++) {
      W.particles.push({ x: rand(0, G.W), y: rand(0, G.H), vx: rand(-4, 4), vy: rand(-6, -1), s: rand(1, 2.6), a: rand(0.08, 0.3) });
    }
  };

  function addWeedCluster(x, y, n, tall) {
    const blades = [];
    for (let i = 0; i < n; i++) {
      blades.push({
        ang: rand(-0.7, 0.7), len: rand(tall ? 90 : 46, tall ? 190 : 88),
        phase: rand(0, TAU), push: 0, pushV: 0, w: rand(4, 8),
      });
    }
    W.weeds.push({ x, y, blades });
  }

  G.spawnFood = function (n) {
    for (let i = 0; i < n; i++) {
      W.foods.push({
        x: rand(160, G.W - 160), y: rand(140, G.H - 140),
        phase: rand(0, TAU), type: Math.random() < 0.3 ? 'mote' : Math.random() < 0.5 ? 'bug' : 'daphnia',
        alive: true,
      });
    }
  };

  /* ---------- 遗失物 ---------- */
  const ITEM_SPOTS = [
    { id: 'bead', name: '玻璃珠' }, { id: 'boat', name: '纸船' },
    { id: 'clip', name: '红色发卡' }, { id: 'duck', name: '旧黄色鸭子' },
    { id: 'key', name: '旧钥匙' },
  ];
  G.itemName = (id) => (ITEM_SPOTS.find((s) => s.id === id) || {}).name || id;

  G.spawnItems = function (takenIds) {
    const zones = [[260, 280], [1650, 300], [350, 1050], [1700, 1000], [980, 640]];
    let zi = Math.floor(rand(0, zones.length));
    ITEM_SPOTS.forEach((spot, i) => {
      if (takenIds && takenIds.includes(spot.id)) return;
      const z = zones[(zi + i * 2) % zones.length];
      W.items.push({
        id: spot.id, x: clamp(z[0] + rand(-120, 120), 120, G.W - 120),
        y: clamp(z[1] + rand(-90, 90), 100, G.H - 100),
        taken: false, pulse: rand(0, TAU), drift: null,
      });
    });
  };

  /* ---------- 第五关迷宫布置 ---------- */
  G.buildMaze = function () {
    const O = W.obstacles;
    // 外圈石壁
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * TAU;
      if (a > 1.25 && a < 1.9) continue; // 留一个入口缺口
      O.push({ x: G.W / 2 + Math.cos(a) * 880, y: G.H / 2 + Math.sin(a) * 560, r: rand(46, 76) });
    }
    // 内部墙群：留出 S 形通道
    const walls = [
      [500, 950, 70, 420], [900, 500, 70, 560], [1300, 850, 70, 500],
      [600, 320, 380, 66], [1100, 240, 66, 300], [1500, 620, 320, 66],
    ];
    walls.forEach(([x, y, w, h]) => O.push({ rect: true, x, y, w, h }));
    // 水流
    W.currents.push({ x: 620, y: 640, w: 360, h: 420, fx: 150, fy: -40 });
    W.currents.push({ x: 1380, y: 380, w: 420, h: 360, fx: -110, fy: 150 });
    // 缠草
    addWeedCluster(950, 1080, 12, true); W.tangles.push({ x: 950, y: 1080, r: 120 });
    addWeedCluster(420, 620, 12, true); W.tangles.push({ x: 420, y: 620, r: 110 });
    // 门
    W.door = { x: 1760, y: 210, open: 0 };
    // 记忆提示物（第四关收集的物品成为路标）
    W.items.push({ id: 'bead', x: 1130, y: 640, taken: false, pulse: 0, hint: true });
    W.items.push({ id: 'boat', x: 700, y: 760, taken: false, pulse: 1, hint: true, driftPath: true });
    W.items.push({ id: 'clip', x: 1560, y: 980, taken: false, pulse: 2, hint: true });
  };

  /* ---------- 涟漪 / 气泡 ---------- */
  G.ripple = function (x, y, scale = 1) {
    W.ripples.push({ x, y, r: 6 * scale, max: 130 * scale, a: 0.5, w: 1.6 * scale });
  };
  G.bubbleAt = function (x, y) {
    W.bubbles.push({ x, y, r: rand(2, 5), vy: rand(-46, -26), wob: rand(0, TAU), life: 1 });
  };

  // 发光珠散逸：玻璃珠被触碰到的那一瞬间
  G.sparkleBurst = function (x, y) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU + rand(-0.2, 0.2);
      const sp = rand(18, 64);
      W.sparkles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 10,
        r: rand(2.2, 4.6), life: 1, decay: rand(0.22, 0.4), wob: rand(0, TAU),
      });
    }
  };

  /* ---------- 每帧更新 ---------- */
  G.updateWorld = function (dt, fish) {
    W.t += dt;

    // 荷叶：弹簧回正 + 鱼碰撞推挤
    W.lilies.forEach((l) => {
      if (fish && dist(fish.x, fish.y, l.x, l.y) < l.r + fish.size * 14) {
        const d = Math.max(1, dist(fish.x, fish.y, l.x, l.y));
        l.swayV += clamp(fish.vx * 0.004 + fish.vy * 0.004, -0.7, 0.7);
        if (Math.random() < dt * 3) G.ripple(l.x + rand(-l.r, l.r) * 0.5, l.y + rand(-l.r, l.r) * 0.5, 0.7);
      }
      l.swayV += (-l.sway * 5 - l.swayV * 2.2) * dt;
      l.sway += l.swayV * dt;
      l.x += l.px * dt; l.y += l.py * dt;
      l.px *= 0.92; l.py *= 0.92;
    });

    // 鸭子：漂浮 + 微弱群聚 + 被鱼/大鱼推开；freeze 时全体静止注视
    if (W.duckFreeze > 0) { W.duckFreeze -= dt; }
    W.ducks.forEach((d) => {
      if (W.duckFreeze > 0) {
        if (fish) d.look = Math.atan2(fish.y - d.y, fish.x - d.x);
        return;
      }
      d.phase += dt * 0.7;
      let ax = Math.cos(d.phase) * 5, ay = Math.sin(d.phase * 0.8) * 4;
      // 群聚：靠太近的鸭子互相轻推 + 向群体质心缓慢靠拢
      W.ducks.forEach((o) => {
        if (o === d) return;
        const dd = dist(d.x, d.y, o.x, o.y);
        if (dd < 90 && dd > 0.01) { ax -= ((o.x - d.x) / dd) * 14; ay -= ((o.y - d.y) / dd) * 14; }
      });
      const pushers = fish ? [fish, G.bigfish].filter(Boolean) : [G.bigfish].filter(Boolean);
      pushers.forEach((p) => {
        if (!p) return;
        const dd = dist(d.x, d.y, p.x, p.y);
        const rr = (p.size || 10) * 16 + 26;
        if (dd < rr && dd > 0.01) {
          const f = ((rr - dd) / rr) * (p === fish ? 120 : 340);
          ax += ((d.x - p.x) / dd) * f; ay += ((d.y - p.y) / dd) * f;
          if (p === G.bigfish && Math.random() < dt * 6) { G.ripple(d.x, d.y, 1); AudioSys.pop(); }
          else if (p === fish && dd < rr * 0.7 && Math.random() < dt * 2) { AudioSys.pop(); G.ripple(d.x, d.y, 0.7); }
        }
      });
      d.vx += ax * dt; d.vy += ay * dt;
      d.vx *= 0.97; d.vy *= 0.97;
      d.x = clamp(d.x + d.vx * dt, 60, G.W - 60);
      d.y = clamp(d.y + d.vy * dt, 60, G.H - 60);
    });

    // 水草：正弦摆 + 鱼经过延迟推开、弹簧恢复
    W.weeds.forEach((cl) => {
      if (fish) {
        const dd = dist(fish.x, fish.y, cl.x, cl.y);
        if (dd < 90) {
          cl.blades.forEach((b) => { b.pushV += ((fish.vx * 0.02) * dt * 60) * 0.02; });
        }
      }
      cl.blades.forEach((b) => {
        b.pushV += (-b.push * 4.5 - b.pushV * 2.6) * dt;
        b.push += b.pushV * dt;
      });
    });

    // 食物漂浮
    W.foods.forEach((f) => { if (f.alive) { f.phase += dt; f.x += Math.sin(f.phase * 0.7) * 3 * dt; f.y += Math.cos(f.phase * 0.5) * 2 * dt; } });

    // 花瓣漂移
    W.petals.forEach((p) => { p.x += Math.sin(W.t * 0.2 + p.a) * 4 * p.drift * dt; p.y += 2.4 * p.drift * dt; if (p.y > G.H + 20) p.y = -20; if (p.x > G.W + 20) p.x = -20; if (p.x < -20) p.x = G.W + 20; });

    // 气泡上浮
    for (let i = W.bubbles.length - 1; i >= 0; i--) {
      const b = W.bubbles[i];
      b.y += b.vy * dt; b.x += Math.sin(W.t * 3 + b.wob) * 8 * dt;
      if (Math.random() < dt * 0.25) AudioSys.bubble();
      if (b.y < -10) W.bubbles.splice(i, 1);
    }

    // 粒子
    W.particles.forEach((p) => {
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.y < -10) { p.y = G.H + 8; p.x = rand(0, G.W); }
      if (p.x < -10) p.x = G.W + 8; if (p.x > G.W + 10) p.x = -8;
    });

    // 涟漪扩散
    for (let i = W.ripples.length - 1; i >= 0; i--) {
      const r = W.ripples[i];
      r.r += (r.max - r.r) * dt * 1.6;
      r.a -= dt * 0.55;
      if (r.a <= 0) W.ripples.splice(i, 1);
    }

    // 发光珠散逸
    for (let i = W.sparkles.length - 1; i >= 0; i--) {
      const s = W.sparkles[i];
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.vx *= 0.985; s.vy = s.vy * 0.985 - 6 * dt;
      s.life -= s.decay * dt;
      if (s.life <= 0) W.sparkles.splice(i, 1);
    }

    // 随机环境气泡（少而精）
    if (Math.random() < dt * 0.28) G.bubbleAt(rand(0, G.W), rand(0, G.H));
  };

  /* ---------- 第五关：障碍 / 水流 / 缠草 对鱼的作用 ---------- */
  G.mazeForces = function (fish, dt) {
    // 推离障碍
    W.obstacles.forEach((o) => {
      if (o.rect) {
        const cx = clamp(fish.x, o.x, o.x + o.w), cy = clamp(fish.y, o.y, o.y + o.h);
        const dd = dist(fish.x, fish.y, cx, cy);
        if (dd < fish.size * 12) {
          const nx = dd > 0.01 ? (fish.x - cx) / dd : 1, ny = dd > 0.01 ? (fish.y - cy) / dd : 0;
          const push = fish.size * 12 - dd;
          fish.x += nx * push; fish.y += ny * push;
        }
      } else {
        const dd = dist(fish.x, fish.y, o.x, o.y);
        const rr = o.r + fish.size * 10;
        if (dd < rr && dd > 0.01) {
          fish.x += ((fish.x - o.x) / dd) * (rr - dd);
          fish.y += ((fish.y - o.y) / dd) * (rr - dd);
        }
      }
    });
    // 水流
    let inCurrent = null;
    W.currents.forEach((c) => {
      if (fish.x > c.x && fish.x < c.x + c.w && fish.y > c.y && fish.y < c.y + c.h) {
        inCurrent = c;
      }
    });
    return inCurrent;
  };

  /* ============================================================
     渲染
     ============================================================ */
  G.drawWorld = function (ctx, vw, vh, cam, scale) {
    const pal = G.palette;
    // 背景：上深蓝 → 青绿 → 浅青白（清澈见底的通透感）
    const bg = ctx.createLinearGradient(0, 0, 0, vh);
    bg.addColorStop(0, pal.top);
    bg.addColorStop(0.58, pal.mid);
    bg.addColorStop(1, pal.bottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, vw, vh);

    // 水下光斑（两层错位平铺的柔和光斑贴图）
    const cw = vw / scale, ch = vh / scale;
    const ox = -(cam.x - cw / 2), oy = -(cam.y - ch / 2);
    ctx.globalAlpha = pal.caustic;
    ctx.globalCompositeOperation = 'lighter';
    const t = W.t * 8;
    for (let L = 0; L < 2; L++) {
      const size = 512 * (L ? 1.35 : 1);
      const offx = ((t * (L ? 5 : 9)) % size), offy = ((t * (L ? 3 : 6)) % size);
      for (let gx = -1; gx <= Math.ceil(cw / size) + 1; gx++) {
        for (let gy = -1; gy <= Math.ceil(ch / size) + 1; gy++) {
          ctx.drawImage(W.causticTile, ox + gx * size - offx, oy + gy * size - offy, size, size);
        }
      }
    }
    ctx.globalAlpha = 1;
    // 从上方洒落的光柱：径向渐变椭圆压出柔边，青白色，缓慢游移
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const bx = ((i * 0.24 + 0.08) + Math.sin(W.t * 0.05 + i * 1.7) * 0.05) * vw;
      const rw = vw * (0.07 + (i % 2) * 0.035);
      const len = vh * (1.15 + (i % 2) * 0.25);
      const tilt = 0.16 + Math.sin(W.t * 0.04 + i) * 0.05;
      const a = (0.10 + 0.05 * (Math.sin(W.t * 0.3 + i * 2.1) * 0.5 + 0.5)) * clamp(pal.caustic * 2, 0.3, 1);
      ctx.save();
      ctx.translate(bx + rw / 2, -vh * 0.05);
      ctx.rotate(tilt);
      ctx.scale(rw / len, 1);
      const g = ctx.createRadialGradient(0, len * 0.42, 0, 0, len * 0.42, len * 0.55);
      g.addColorStop(0, `rgba(212,250,240,${a})`);
      g.addColorStop(0.55, `rgba(206,246,238,${a * 0.38})`);
      g.addColorStop(1, 'rgba(206,246,238,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, len * 0.42, len * 0.55, 0, TAU); ctx.fill();
      ctx.restore();
    }
    // 水面天光：顶部一层淡淡的青白亮意
    const surf = ctx.createLinearGradient(0, 0, 0, vh * 0.4);
    surf.addColorStop(0, `rgba(196,240,228,${0.16 * pal.caustic * 2})`);
    surf.addColorStop(1, 'rgba(196,240,228,0)');
    ctx.fillStyle = surf;
    ctx.fillRect(0, 0, vw, vh * 0.4);
    ctx.globalCompositeOperation = 'source-over';

    // 世界层
    ctx.save();
    ctx.translate(vw / 2, vh / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cam.x, -cam.y);

    drawWeedsBack(ctx);
    drawPetals(ctx);
    drawItems(ctx);
    drawFoods(ctx);

    // 气泡：像一串串发光的小珠，柔光、无硬边
    W.bubbles.forEach((b) => {
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r * 3.2);
      g.addColorStop(0, 'rgba(248,255,252,0.5)');
      g.addColorStop(0.35, 'rgba(206,246,236,0.2)');
      g.addColorStop(1, 'rgba(206,246,236,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 3.2, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath(); ctx.arc(b.x - b.r * 0.25, b.y - b.r * 0.25, b.r * 0.55, 0, TAU); ctx.fill();
    });
    // 发光珠散逸（玻璃珠的回忆）
    W.sparkles.forEach((s) => {
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 3.4);
      g.addColorStop(0, `rgba(255,244,200,${0.5 * s.life})`);
      g.addColorStop(0.4, `rgba(255,238,186,${0.2 * s.life})`);
      g.addColorStop(1, 'rgba(255,238,186,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 3.4, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.85 * s.life})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 0.6, 0, TAU); ctx.fill();
    });
    ctx.globalAlpha = 1;

    drawParticles(ctx);

    // 荷叶（水面层，半透明盖在水上）
    W.lilies.forEach((l) => drawLily(ctx, l));

    // 鸭子（最上层水面物）
    W.ducks.forEach((d) => drawDuck(ctx, d));

    // 涟漪
    W.ripples.forEach((r) => {
      ctx.strokeStyle = `rgba(240,250,252,${r.a})`;
      ctx.lineWidth = r.w;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, TAU); ctx.stroke();
      ctx.strokeStyle = `rgba(240,250,252,${r.a * 0.4})`;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r * 0.62, 0, TAU); ctx.stroke();
    });

    // 第五关迷宫元素
    if (W.obstacles.length) drawMaze(ctx);
    if (W.door) drawDoor(ctx);

    ctx.globalAlpha = 1;

    ctx.restore();

    // 暗角（很轻，只做边缘聚拢，保持画面通透）
    const vg = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.5, vw / 2, vh / 2, Math.max(vw, vh) * 0.78);
    vg.addColorStop(0, 'rgba(6,40,50,0)');
    vg.addColorStop(1, 'rgba(8,52,60,0.2)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, vw, vh);
  };

  function drawLily(ctx, l) {
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(l.a + l.sway * 0.35);
    const r = l.r;
    const g = ctx.createRadialGradient(0, 0, r * 0.15, 0, 0, r);
    if (l.closed) { g.addColorStop(0, 'rgba(150,164,190,0.8)'); g.addColorStop(1, 'rgba(96,108,142,0.72)'); }
    else { g.addColorStop(0, 'rgba(128,208,164,0.92)'); g.addColorStop(1, 'rgba(74,160,124,0.85)'); }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, l.a + 0.28, l.a + TAU - 0.28);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(220,240,220,0.16)';
    ctx.lineWidth = 1.4;
    for (let i = 1; i < 6; i++) {
      const a = l.a + 0.28 + ((TAU - 0.56) * i) / 6;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(235,250,245,0.35)';
    ctx.beginPath(); ctx.arc(r * 0.34, -r * 0.3, 3.2, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawDuck(ctx, d) {
    ctx.save();
    ctx.translate(d.x, d.y);
    // 柔光：鸭子在深色水面上微微发亮
    const gl = ctx.createRadialGradient(0, 0, 4, 0, 0, 34);
    gl.addColorStop(0, d.faded ? 'rgba(226,208,160,0.14)' : 'rgba(255,238,196,0.18)');
    gl.addColorStop(1, 'rgba(255,238,196,0)');
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(0, 0, 34, 0, TAU); ctx.fill();
    const dir = d.look !== undefined && W.duckFreeze > 0 ? d.look : d.phase;
    ctx.rotate(dir * 0.06);
    const body = d.faded ? 'rgba(196,178,132,0.9)' : 'rgba(247,232,176,0.94)';
    const bob = Math.sin(W.t * 1.6 + d.phase) * 1.6;
    ctx.translate(0, bob);
    ctx.globalAlpha = d.faded ? 0.75 : 0.96;
    // 影
    ctx.fillStyle = 'rgba(10,30,40,0.18)';
    ctx.beginPath(); ctx.ellipse(2, 5, 19, 12, 0, 0, TAU); ctx.fill();
    // 身体
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(0, 0, 17, 11.5, 0, 0, TAU); ctx.fill();
    // 尾部翘起
    ctx.beginPath(); ctx.moveTo(-15, -2); ctx.quadraticCurveTo(-22, -8, -17, -11); ctx.quadraticCurveTo(-12, -8, -12, -4); ctx.fill();
    // 头
    const hx = 14, hy = -6;
    ctx.beginPath(); ctx.arc(hx, hy, 7.4, 0, TAU); ctx.fill();
    // 嘴
    ctx.fillStyle = d.faded ? 'rgba(200,140,90,0.9)' : '#f0a45e';
    ctx.beginPath(); ctx.moveTo(hx + 6, hy - 1.5); ctx.lineTo(hx + 13, hy + 0.5); ctx.lineTo(hx + 6, hy + 3); ctx.closePath(); ctx.fill();
    // 眼（freeze 时注视鱼的方向由整体 rotate 呈现）
    ctx.fillStyle = 'rgba(40,30,20,0.85)';
    ctx.beginPath(); ctx.arc(hx + 2.4, hy - 2.4, 1.25, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawWeedsBack(ctx) {
    W.weeds.forEach((cl) => {
      cl.blades.forEach((b) => {
        const sway = Math.sin(W.t * 0.9 + b.phase) * 0.16 + b.push;
        const dark = G.palette === PALETTES.ch5;
        ctx.strokeStyle = dark ? 'rgba(24,58,62,0.85)' : 'rgba(70,182,148,0.55)';
        ctx.lineWidth = b.w;
        ctx.beginPath();
        ctx.moveTo(cl.x, cl.y);
        const midx = cl.x + Math.sin(b.ang + sway) * b.len * 0.5;
        const midy = cl.y - b.len * 0.55;
        const endx = cl.x + Math.sin(b.ang + sway * 1.6) * b.len * 0.85;
        const endy = cl.y - b.len;
        ctx.quadraticCurveTo(midx, midy, endx, endy);
        ctx.stroke();
      });
    });
  }

  function drawPetals(ctx) {
    W.petals.forEach((p) => {
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.fillStyle = 'rgba(248,222,226,0.55)';
      ctx.beginPath(); ctx.ellipse(0, 0, 7 * p.s, 3.6 * p.s, 0, 0, TAU); ctx.fill();
      ctx.restore();
    });
  }

  function drawFoods(ctx) {
    W.foods.forEach((f) => {
      if (!f.alive) return;
      const p = Math.sin(f.phase * 2) * 0.5 + 0.5;
      // 呼吸的暖色光晕——远处也能看见的"可以吃"的信号
      const gl = ctx.createRadialGradient(f.x, f.y, 1, f.x, f.y, 17 + p * 6);
      gl.addColorStop(0, `rgba(255,238,180,${0.34 + p * 0.22})`);
      gl.addColorStop(1, 'rgba(255,238,180,0)');
      ctx.fillStyle = gl;
      ctx.beginPath(); ctx.arc(f.x, f.y, 17 + p * 6, 0, TAU); ctx.fill();
      // 偶尔的十字星芒
      if (p > 0.86) {
        ctx.strokeStyle = `rgba(255,248,214,${(p - 0.86) * 4})`;
        ctx.lineWidth = 1.2;
        const rr = 6 + p * 4;
        ctx.beginPath();
        ctx.moveTo(f.x - rr, f.y); ctx.lineTo(f.x + rr, f.y);
        ctx.moveTo(f.x, f.y - rr); ctx.lineTo(f.x, f.y + rr);
        ctx.stroke();
      }
      if (f.type === 'mote') {
        ctx.fillStyle = `rgba(255,242,196,${0.62 + p * 0.38})`;
        ctx.beginPath(); ctx.arc(f.x, f.y, 3.6 + p * 1.4, 0, TAU); ctx.fill();
      } else if (f.type === 'bug') {
        ctx.strokeStyle = 'rgba(232,222,178,0.95)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(f.x, f.y, 4.4, 0.4, 2.6); ctx.stroke();
        ctx.beginPath(); ctx.arc(f.x + 2.6, f.y - 2.4, 2, 0, TAU); ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(214,238,228,${0.7 + p * 0.3})`;
        ctx.beginPath(); ctx.arc(f.x, f.y, 4.4, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.beginPath(); ctx.arc(f.x - 1.3, f.y - 1.3, 1.5, 0, TAU); ctx.fill();
      }
    });
  }

  G.drawItem = function (ctx, it) {
    const pulse = Math.sin(W.t * 2 + (it.pulse || 0)) * 0.5 + 0.5;
    ctx.save();
    ctx.translate(it.x, it.y);
    // 微光晕
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 40);
    g.addColorStop(0, `rgba(255,238,190,${0.16 + pulse * 0.12})`);
    g.addColorStop(1, 'rgba(255,238,190,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 40, 0, TAU); ctx.fill();
    if (it.id === 'bead') {
      const bg = ctx.createRadialGradient(-4, -4, 1, 0, 0, 13);
      bg.addColorStop(0, 'rgba(255,255,255,0.95)');
      bg.addColorStop(0.5, 'rgba(160,220,235,0.75)');
      bg.addColorStop(1, 'rgba(90,150,190,0.6)');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(0, 0, 12, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(-4, -5, 2.6, 0, TAU); ctx.fill();
    } else if (it.id === 'boat') {
      ctx.rotate(0.3 + Math.sin(W.t) * 0.05);
      ctx.fillStyle = 'rgba(250,246,232,0.95)';
      ctx.beginPath(); ctx.moveTo(-20, 6); ctx.lineTo(0, -14); ctx.lineTo(20, 6); ctx.lineTo(0, 10); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(180,170,140,0.7)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-20, 6); ctx.lineTo(20, 6); ctx.stroke();
    } else if (it.id === 'clip') {
      ctx.strokeStyle = 'rgba(226,110,96,0.95)'; ctx.lineWidth = 3.4;
      ctx.beginPath(); ctx.arc(-4, 0, 9, 0.6, 3.6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(2, 7); ctx.lineTo(14, -4); ctx.stroke();
      ctx.fillStyle = 'rgba(255,180,160,0.9)';
      ctx.beginPath(); ctx.arc(-11, 6, 2.2, 0, TAU); ctx.fill();
    } else if (it.id === 'key') {
      ctx.rotate(-0.5);
      ctx.strokeStyle = 'rgba(212,190,130,0.95)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(-8, 0, 5.4, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-2.6, 0); ctx.lineTo(14, 0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(9, 5); ctx.moveTo(14, 0); ctx.lineTo(14, 6); ctx.stroke();
    } else if (it.id === 'duck') {
      ctx.fillStyle = 'rgba(214,190,120,0.92)';
      ctx.beginPath(); ctx.ellipse(0, 2, 15, 10.5, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(12, -5, 6.6, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(190,130,80,0.9)';
      ctx.beginPath(); ctx.moveTo(17, -6); ctx.lineTo(23, -4.6); ctx.lineTo(17, -3); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(40,30,20,0.8)';
      ctx.beginPath(); ctx.arc(13.6, -7, 1.1, 0, TAU); ctx.fill();
    }
    ctx.restore();
  };

  function drawItems(ctx) {
    W.items.forEach((it) => { if (!it.taken) G.drawItem(ctx, it); });
  }

  function drawParticles(ctx) {
    W.particles.forEach((p) => {
      // 星尘般的闪烁：每颗粒子有自己的节奏
      const tw = 0.55 + 0.45 * Math.sin(W.t * 2.4 + p.x * 0.05 + p.y * 0.03);
      ctx.fillStyle = `rgba(226,244,242,${p.a * tw})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, TAU); ctx.fill();
    });
  }

  function drawMaze(ctx) {
    ctx.fillStyle = 'rgba(8,20,28,0.9)';
    ctx.strokeStyle = 'rgba(60,100,105,0.4)';
    ctx.lineWidth = 2;
    W.obstacles.forEach((o) => {
      if (o.rect) {
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(o.x, o.y, o.w, o.h, 16) : ctx.rect(o.x, o.y, o.w, o.h);
        ctx.fill(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill(); ctx.stroke();
      }
    });
    // 水流提示：缓动的流动短划
    W.currents.forEach((c) => {
      ctx.strokeStyle = 'rgba(120,190,200,0.14)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 8; i++) {
        const px = c.x + ((W.t * c.fx * 0.6 + i * 97) % c.w + c.w) % c.w;
        const py = c.y + ((W.t * c.fy * 0.6 + i * 61) % c.h + c.h) % c.h;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + c.fx * 0.22, py + c.fy * 0.22); ctx.stroke();
      }
    });
    // 缠草区（更暗更密的草已在 weeds，额外画警告色叶尖）
    W.tangles.forEach((tg) => {
      ctx.strokeStyle = 'rgba(80,120,90,0.25)';
      ctx.beginPath(); ctx.arc(tg.x, tg.y, tg.r, 0, TAU); ctx.stroke();
    });
  }

  function drawDoor(ctx) {
    const d = W.door;
    ctx.save();
    ctx.translate(d.x, d.y);
    // 石门框
    ctx.fillStyle = 'rgba(10,24,30,0.95)';
    ctx.beginPath(); ctx.ellipse(0, 0, 74, 96, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(90,130,130,0.5)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(0, 0, 74, 96, 0, 0, TAU); ctx.stroke();
    // 门内光
    const og = d.open || 0;
    if (og > 0) {
      const g = ctx.createRadialGradient(0, 0, 4, 0, 0, 70 * og);
      g.addColorStop(0, `rgba(255,252,235,${0.95 * Math.min(1, og * 1.4)})`);
      g.addColorStop(1, 'rgba(255,252,235,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, 66 * og, 88 * og, 0, 0, TAU); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(6,14,20,0.98)';
      ctx.beginPath(); ctx.ellipse(0, 0, 58, 82, 0, 0, TAU); ctx.fill();
      // 锁孔
      ctx.fillStyle = `rgba(212,190,130,${0.4 + Math.sin(W.t * 2) * 0.2})`;
      ctx.beginPath(); ctx.arc(0, -10, 6, 0, TAU); ctx.fill();
      ctx.fillRect(-2.4, -8, 4.8, 16);
    }
    ctx.restore();
  }

  /* ---------- 鱼（通用绘制：玩家 / 伙伴 / 大鱼 / 群游小鱼） ---------- */
  G.drawFish = function (ctx, f) {
    const s = (f.size || 0.6) * 52;   // size 是缩放因子：0.55 ≈ 幼苗，1.2 ≈ 成年
    const tail = Math.sin(f.tailPhase || 0) * (0.42 + Math.min(0.3, (f.speed || 0) * 0.001));
    const c1 = f.color1 || 'rgba(255,214,150,0.95)';
    const c2 = f.color2 || 'rgba(255,190,120,0.12)';
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.dir || 0);
    // 光晕
    if (f.glow) {
      const g = ctx.createRadialGradient(0, 0, s * 0.4, 0, 0, s * 6);
      g.addColorStop(0, 'rgba(255,226,160,0.22)');
      g.addColorStop(1, 'rgba(255,226,160,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, s * 6, 0, TAU); ctx.fill();
    }
    // 尾鳍
    ctx.save();
    ctx.translate(-s * 0.9, 0);
    ctx.rotate(tail);
    ctx.fillStyle = c2.replace('0.12', '0.5');
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-s * 0.7, -s * 0.55, -s * 1.15, -s * 0.4);
    ctx.quadraticCurveTo(-s * 0.6, 0, -s * 1.15, s * 0.4);
    ctx.quadraticCurveTo(-s * 0.7, s * 0.55, 0, 0);
    ctx.fill();
    ctx.restore();
    // 身体
    const g = ctx.createLinearGradient(s * 1.15, 0, -s, 0);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(s * 1.15, 0);
    ctx.quadraticCurveTo(s * 0.7, -s * 0.62, -s * 0.55, -s * 0.34);
    ctx.quadraticCurveTo(-s * 0.95, -s * 0.1, -s * 0.95, 0);
    ctx.quadraticCurveTo(-s * 0.95, s * 0.1, -s * 0.55, s * 0.34);
    ctx.quadraticCurveTo(s * 0.7, s * 0.62, s * 1.15, 0);
    ctx.fill();
    // 背鳍
    ctx.fillStyle = c2.replace('0.12', '0.42');
    ctx.beginPath();
    ctx.moveTo(s * 0.25, -s * 0.42);
    ctx.quadraticCurveTo(-s * 0.1, -s * 0.85, -s * 0.5, -s * 0.3);
    ctx.fill();
    // 眼
    ctx.fillStyle = 'rgba(20,24,30,0.9)';
    ctx.beginPath(); ctx.arc(s * 0.72, -s * 0.16, s * 0.09 + 0.6, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(s * 0.72, s * 0.16, s * 0.09 + 0.6, 0, TAU); ctx.fill();
    ctx.restore();
  };

  G.drawBigFish = function (ctx, b) {
    const s = b.size * 30;
    const tail = Math.sin(b.tailPhase) * 0.3;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.dir);
    // 深影
    ctx.fillStyle = 'rgba(2,8,14,0.35)';
    ctx.beginPath(); ctx.ellipse(6, 10, s * 1.35, s * 0.75, 0, 0, TAU); ctx.fill();
    // 尾
    ctx.save();
    ctx.translate(-s * 0.95, 0); ctx.rotate(tail);
    ctx.fillStyle = 'rgba(30,52,66,0.85)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-s * 0.6, -s * 0.5, -s * 1.05, -s * 0.38);
    ctx.quadraticCurveTo(-s * 0.55, 0, -s * 1.05, s * 0.38);
    ctx.quadraticCurveTo(-s * 0.6, s * 0.5, 0, 0);
    ctx.fill();
    ctx.restore();
    // 身体：优雅的深蓝灰
    const g = ctx.createLinearGradient(s * 1.2, 0, -s, 0);
    g.addColorStop(0, 'rgba(58,86,102,0.96)');
    g.addColorStop(0.6, 'rgba(34,56,70,0.94)');
    g.addColorStop(1, 'rgba(18,32,44,0.9)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(s * 1.2, 0);
    ctx.quadraticCurveTo(s * 0.72, -s * 0.66, -s * 0.5, -s * 0.4);
    ctx.quadraticCurveTo(-s * 0.92, -s * 0.12, -s * 0.92, 0);
    ctx.quadraticCurveTo(-s * 0.92, s * 0.12, -s * 0.5, s * 0.4);
    ctx.quadraticCurveTo(s * 0.72, s * 0.66, s * 1.2, 0);
    ctx.fill();
    // 胸鳍
    ctx.fillStyle = 'rgba(40,64,80,0.8)';
    ctx.beginPath();
    ctx.moveTo(s * 0.3, s * 0.3);
    ctx.quadraticCurveTo(s * 0.05, s * 0.85, -s * 0.35, s * 0.5);
    ctx.quadraticCurveTo(-s * 0.05, s * 0.35, s * 0.3, s * 0.3);
    ctx.fill();
    // 眼：安静、不凶
    ctx.fillStyle = 'rgba(220,236,238,0.6)';
    ctx.beginPath(); ctx.arc(s * 0.76, -s * 0.2, s * 0.1, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(8,12,16,0.95)';
    ctx.beginPath(); ctx.arc(s * 0.78, -s * 0.2, s * 0.05, 0, TAU); ctx.fill();
    ctx.restore();
  };

  /* ---------- 鱼卵 ---------- */
  G.drawEgg = function (ctx, x, y, t, crack) {
    ctx.save();
    ctx.translate(x, y);
    const wob = Math.sin(t * 2.2) * 0.06;
    ctx.rotate(wob);
    const g = ctx.createRadialGradient(-4, -6, 2, 0, 0, 22);
    g.addColorStop(0, 'rgba(255,244,214,0.95)');
    g.addColorStop(0.7, 'rgba(240,214,160,0.75)');
    g.addColorStop(1, 'rgba(220,190,130,0.25)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, 15, 19, 0, 0, TAU); ctx.fill();
    const glow = ctx.createRadialGradient(0, 0, 4, 0, 0, 46);
    glow.addColorStop(0, 'rgba(255,236,180,0.28)');
    glow.addColorStop(1, 'rgba(255,236,180,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, 46, 0, TAU); ctx.fill();
    if (crack > 0) {
      ctx.strokeStyle = 'rgba(60,40,20,0.55)';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + 0.4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 4, Math.sin(a) * 5);
        ctx.lineTo(Math.cos(a) * (8 + crack * 8), Math.sin(a) * (10 + crack * 8));
        ctx.stroke();
      }
    }
    ctx.restore();
  };

  /* ---------- 黑暗遮罩（第五关） ---------- */
  G.drawDarkness = function (ctx, vw, vh, lights) {
    const lc = G._lightCanvas || (G._lightCanvas = document.createElement('canvas'));
    if (lc.width !== vw || lc.height !== vh) { lc.width = vw; lc.height = vh; }
    const x = lc.getContext('2d');
    x.globalCompositeOperation = 'source-over';
    x.clearRect(0, 0, vw, vh);
    x.fillStyle = 'rgba(2,8,14,0.93)';
    x.fillRect(0, 0, vw, vh);
    x.globalCompositeOperation = 'destination-out';
    lights.forEach((L) => {
      const g = x.createRadialGradient(L.x, L.y, 4, L.x, L.y, L.r);
      g.addColorStop(0, `rgba(0,0,0,${L.a ?? 0.95})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g;
      x.beginPath(); x.arc(L.x, L.y, L.r, 0, TAU); x.fill();
    });
    ctx.drawImage(lc, 0, 0);
  };
})();
