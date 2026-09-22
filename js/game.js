/* ============================================================
   Game — 状态机与六章叙事。
   TITLE → INTRO → L1..L6 → ENDING (→ SECRET) → CREDITS
   ============================================================ */
(function () {
  const G = (window.G = window.G || {});
  const TAU = G.TAU, lerp = G.lerp, clamp = G.clamp, rand = G.rand, dist = G.dist;

  const canvas = document.getElementById('pond');
  const ctx = canvas.getContext('2d');
  let vw = 0, vh = 0, scale = 1;

  /* ---------- 全局可变状态 ---------- */
  G.state = 'TITLE';
  G.mouse = { x: 1000, y: 650, sx: 0, sy: 0, spd: 0, down: false };
  G.cam = { x: 1000, y: 650 };
  G.fish = null;
  G.bigfish = null;
  G.buddy = null;
  G.collected = new Set();
  G.shardsLost = false;
  G.dark = false;

  const SAVE_KEY = 'six-escapes-v1';
  const save = (o) => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(o)); } catch (e) {} };
  const loadSave = () => { try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return null; } };
  const clearSave = () => { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} };

  /* ---------- DOM helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const tagEl = $('chapter-tag'), whisperEl = $('whisper'), trEl = $('transition'),
    dotsEl = $('dots'), scalesEl = $('scales'), titleEl = $('title-screen'),
    cursorEl = $('cursor-dot'), endEl = $('end-choices');

  function chapterTag(num, name, en) {
    tagEl.querySelector('.num').textContent = num;
    tagEl.querySelector('.name').textContent = name;
    tagEl.querySelector('.en').textContent = en;
    tagEl.classList.add('show');
  }
  function hideTag() { tagEl.classList.remove('show'); }
  function whisper(text, dur = 4200) {
    whisperEl.textContent = text;
    whisperEl.classList.add('show');
    clearTimeout(whisper._t);
    whisper._t = setTimeout(() => whisperEl.classList.remove('show'), dur);
  }
  function transition(text, holdMs, cb, bg) {
    trEl.style.background = bg || '#04101a';
    trEl.querySelector('.tr-text').textContent = text || '';
    trEl.classList.add('show');
    setTimeout(() => {
      cb && cb();
      setTimeout(() => trEl.classList.remove('show'), holdMs ? 200 : 900);
    }, Math.max(1500, holdMs ?? 2600));
  }
  function whiteFlash(dur = 500) {
    trEl.style.background = '#fffdf4';
    trEl.classList.add('show');
    setTimeout(() => { trEl.classList.remove('show'); trEl.style.background = ''; }, dur);
  }
  function scalesUI(show, broken) {
    scalesEl.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      scalesEl.insertAdjacentHTML('beforeend',
        `<svg viewBox="0 0 20 20" class="${i < broken ? '' : 'broken'}"><path d="M10 1 C15 4 18 8 18 12 A8 8 0 0 1 2 12 C2 8 5 4 10 1 Z" fill="rgba(232,244,240,.55)"/></svg>`);
    }
    scalesEl.classList.toggle('show', !!show);
  }
  function dotsUI(show, collectedIds = []) {
    dotsEl.innerHTML = '';
    ['bead', 'boat', 'clip', 'duck', 'key'].forEach((id) => {
      dotsEl.insertAdjacentHTML('beforeend', `<i class="${collectedIds.includes(id) ? 'lit' : ''}"></i>`);
    });
    dotsEl.classList.toggle('show', !!show);
  }

  /* ---------- 输入 ---------- */
  function toWorld(sx, sy) {
    return { x: (sx - vw / 2) / scale + G.cam.x, y: (sy - vh / 2) / scale + G.cam.y };
  }
  let lastMX = 0, lastMY = 0;
  function pointerMove(cx, cy) {
    const w = toWorld(cx, cy);
    G.mouse.x = w.x; G.mouse.y = w.y;
    G.mouse.sx = cx; G.mouse.sy = cy;
    G.mouse.spd = Math.hypot(cx - lastMX, cy - lastMY);
    lastMX = cx; lastMY = cy;
    cursorEl.style.left = cx + 'px'; cursorEl.style.top = cy + 'px';
  }
  window.addEventListener('mousemove', (e) => pointerMove(e.clientX, e.clientY));
  window.addEventListener('touchmove', (e) => { const t = e.touches[0]; pointerMove(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener('mousedown', (e) => {
    G.mouse.down = true; AudioSys.init(); AudioSys.resume();
    // 点击水面：一圈轻轻扩散的涟漪（纯粹的触碰感，无任何作用）
    const w = toWorld(e.clientX, e.clientY);
    G.ripple(w.x, w.y, 1);
    setTimeout(() => G.ripple(w.x, w.y, 0.55), 180);
  });
  window.addEventListener('mouseup', () => { G.mouse.down = false; G._mouseupFlag = true; });
  window.addEventListener('touchstart', (e) => {
    AudioSys.init(); AudioSys.resume(); const t = e.touches[0]; pointerMove(t.clientX, t.clientY); G.mouse.down = true; G._mouseupFlag = true;
    const w = toWorld(t.clientX, t.clientY);
    G.ripple(w.x, w.y, 1);
  }, { passive: true });
  window.addEventListener('touchend', () => { G.mouse.down = false; G._mouseupFlag = true; });
  window.addEventListener('keydown', (e) => {
    // 导演模式：数字键直达章节（0 = 结尾），供快速浏览完整流程
    const map = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
    if (map[e.key]) startChapter(map[e.key]);
    if (e.key === '0') gotoState('ENDING');
  });

  /* ---------- 玩家小鱼 ---------- */
  function makeFish(x, y, size) {
    return {
      x, y, vx: 0, vy: 0, dir: -TAU / 4, size: size || 0.55,
      tailPhase: 0, speed: 0, color1: 'rgba(255,220,158,0.96)',
      color2: 'rgba(255,186,120,0.14)', glow: true, trapped: 0,
    };
  }
  function controlFish(dt, controlAmt, maxSp) {
    const f = G.fish;
    if (!f) return;
    const dx = G.mouse.x - f.x, dy = G.mouse.y - f.y;
    const d = Math.hypot(dx, dy) || 0.01;
    const arrive = clamp(d / 150, 0, 1);
    const cap = (maxSp || 250) * (0.72 + f.size * 0.4) * controlAmt;
    let sp = cap * (0.16 + arrive * 0.84);
    // 鼠标越快，追随越急
    sp *= 1 + clamp(G.mouse.spd * 0.004, 0, 0.6);
    const desX = (dx / d) * sp, desY = (dy / d) * sp;
    const k = 1 - Math.exp(-dt * 3.1);
    f.vx += (desX - f.vx) * k;
    f.vy += (desY - f.vy) * k;
    f.speed = Math.hypot(f.vx, f.vy);
    f.x += f.vx * dt; f.y += f.vy * dt;
    f.x = clamp(f.x, 30, G.W - 30); f.y = clamp(f.y, 30, G.H - 30);
    if (f.speed > 18) {
      const ta = Math.atan2(f.vy, f.vx);
      let da = ta - f.dir;
      while (da > Math.PI) da -= TAU;
      while (da < -Math.PI) da += TAU;
      f.dir += da * Math.min(1, dt * 4.4);
    }
    f.tailPhase += dt * (5 + f.speed * 0.028);
  }
  function autoSwim(dt, tx, ty, sp) {
    const f = G.fish;
    const dx = tx - f.x, dy = ty - f.y, d = Math.hypot(dx, dy) || 0.01;
    f.vx = lerp(f.vx, (dx / d) * sp, 1 - Math.exp(-dt * 1.4));
    f.vy = lerp(f.vy, (dy / d) * sp, 1 - Math.exp(-dt * 1.4));
    f.speed = Math.hypot(f.vx, f.vy);
    f.x += f.vx * dt; f.y += f.vy * dt;
    const ta = Math.atan2(f.vy, f.vx);
    let da = ta - f.dir;
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    f.dir += da * Math.min(1, dt * 3);
    f.tailPhase += dt * (4 + f.speed * 0.03);
  }

  /* ---------- 伙伴 / 鱼群 / 大鱼 ---------- */
  function makeBuddy(x, y) {
    return { x, y, vx: 0, vy: 0, dir: 0, size: 0.52, tailPhase: 0, speed: 0,
      color1: 'rgba(196,228,214,0.95)', color2: 'rgba(150,210,190,0.14)', wp: null, wpT: 0 };
  }
  function swimBuddy(b, dt, tx, ty, sp) {
    const dx = tx - b.x, dy = ty - b.y, d = Math.hypot(dx, dy) || 0.01;
    b.vx = lerp(b.vx, (dx / d) * sp, 1 - Math.exp(-dt * 1.8));
    b.vy = lerp(b.vy, (dy / d) * sp, 1 - Math.exp(-dt * 1.8));
    b.speed = Math.hypot(b.vx, b.vy);
    b.x += b.vx * dt; b.y += b.vy * dt;
    const ta = Math.atan2(b.vy, b.vx);
    let da = ta - b.dir;
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    b.dir += da * Math.min(1, dt * 3.6);
    b.tailPhase += dt * (5 + b.speed * 0.03);
  }
  function makeBigFish(x, y) {
    return { x, y, vx: 0, vy: 0, dir: TAU / 4, size: 3.4, tailPhase: 0, speed: 0, mode: 'idle' };
  }
  function swimBig(b, dt, tx, ty, sp, turn) {
    const ta = Math.atan2(ty - b.y, tx - b.x);
    let da = ta - b.dir;
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    b.dir += da * Math.min(1, dt * (turn || 1.5));
    b.vx = Math.cos(b.dir) * sp; b.vy = Math.sin(b.dir) * sp;
    b.x += b.vx * dt; b.y += b.vy * dt;
    b.x = clamp(b.x, -200, G.W + 200); b.y = clamp(b.y, -200, G.H + 200);
    b.speed = sp; b.tailPhase += dt * (3 + sp * 0.008);
  }

  /* ---------- 相机 ---------- */
  function updateCam(dt, focus, zoom) {
    const target = focus || G.fish;
    let tx = target ? target.x : G.W / 2, ty = target ? target.y : G.H / 2;
    const halfW = vw / 2 / scale, halfH = vh / 2 / scale;
    tx = G.W > halfW * 2 ? clamp(tx, halfW, G.W - halfW) : G.W / 2;
    ty = G.H > halfH * 2 ? clamp(ty, halfH, G.H - halfH) : G.H / 2;
    const k = 1 - Math.exp(-dt * 2.4);
    G.cam.x = lerp(G.cam.x, tx, k);
    G.cam.y = lerp(G.cam.y, ty, k);
  }

  /* ============================================================
     状态机
     ============================================================ */
  let S = null; // 当前状态对象
  const STATES = {};

  function gotoState(name, arg) {
    G.state = name;
    S = STATES[name];
    S.enter && S.enter(arg);
  }

  function startChapter(n) {
    clearStateEntities();
    G.dark = false;
    if (n === 1) gotoState('L1');
    if (n === 2) gotoState('L2');
    if (n === 3) gotoState('L3');
    if (n === 4) gotoState('L4');
    if (n === 5) gotoState('L5');
    if (n === 6) gotoState('L6');
  }
  function clearStateEntities() {
    G.bigfish = null; G.buddy = null; G.shoal = []; G.dark = false;
    scalesUI(false); dotsUI(false);
  }

  const saveChapter = (ch) => save({ ch, collected: [...G.collected], shardsLost: G.shardsLost });

  /* ============================================================
     TITLE
     ============================================================ */
  STATES.TITLE = {
    enter() {
      G.initPond('title');
      G.fish = null; G.dark = false;
      G.cam.x = G.W / 2; G.cam.y = G.H / 2 - 100;
      this.t = 0; this.rippled = 0;
      this.titleFish = [];
      for (let i = 0; i < 5; i++) {
        this.titleFish.push({ x: rand(300, 1700), y: rand(500, 1100), dir: rand(0, TAU), size: rand(0.5, 0.9), tailPhase: rand(0, 9), speed: 20, color1: 'rgba(190,214,222,0.4)', color2: 'rgba(190,214,222,0.06)' });
      }
      titleEl.classList.remove('gone');
      titleEl.classList.add('show');
      hideTag(); scalesUI(false); dotsUI(false);
      cursorEl.classList.add('show');
      const sv = loadSave();
      $('title-continue').innerHTML = sv && sv.ch > 1 ? '○ 从上次的池塘继续' : '';
      AudioSys.init();
      AudioSys.setAmbience({ vol: 0.055, bright: 340, rumble: 0.008, music: 'calm' });
    },
    update(dt) {
      this.t += dt;
      G.updateWorld(dt, null);
      this.titleFish.forEach((f) => {
        f.x += Math.cos(f.dir) * f.speed * dt; f.y += Math.sin(f.dir) * f.speed * dt;
        f.tailPhase += dt * 4;
        if (f.x < 200 || f.x > 1800 || f.y < 380 || f.y > 1220) f.dir += Math.PI * 0.6 * dt + 0.01;
      });
      // 鼠标轻抚产生涟漪
      if (G.mouse.spd > 6 && this.t - this.rippled > 0.5) {
        G.ripple(G.mouse.x, G.mouse.y, 0.6); this.rippled = this.t;
      }
    },
    draw(ctx) {
      G.drawWorld(ctx, vw, vh, G.cam, scale);
      withWorld(ctx, () => {
        this.titleFish.forEach((f) => G.drawFish(ctx, f));
      });
    },
    click(x, y, onContinue) {
      G.ripple(...Object.values(toWorld(x, y)), 1.4);
      AudioSys.pop();
      titleEl.classList.add('gone');
      setTimeout(() => titleEl.classList.remove('show'), 900);
      setTimeout(() => { onContinue ? onContinue() : gotoState('INTRO'); }, 1500);
    },
  };

  titleEl.addEventListener('click', (e) => {
    if (G.state !== 'TITLE') return;
    if (e.target.id === 'title-continue') {
      const sv = loadSave();
      STATES.TITLE.click(e.clientX, e.clientY, () => {
        if (sv) {
          G.collected = new Set(sv.collected || []);
          G.shardsLost = !!sv.shardsLost;
          startChapter(clamp(sv.ch, 1, 6));
        } else gotoState('INTRO');
      });
    } else {
      STATES.TITLE.click(e.clientX, e.clientY);
    }
  });

  /* ============================================================
     INTRO — 沉入水下，鱼卵出生
     ============================================================ */
  STATES.INTRO = {
    enter() {
      G.initPond(1);
      G.fish = null; G.dark = false;
      this.t = 0; this.egg = { x: G.W / 2, y: G.H / 2 + 60 };
      G.cam.x = this.egg.x; G.cam.y = this.egg.y;
      this.msg = false;
      AudioSys.setAmbience({ vol: 0.04, bright: 240, rumble: 0.01, music: 'calm' });
    },
    update(dt) {
      this.t += dt;
      const t = this.t;
      G.updateWorld(dt, null);
      if (t > 2 && t < 6.2) {
        this.egg.wob = 1 + Math.sin(t * 5) * 0.3;
        if (Math.random() < dt * 1.2) G.bubbleAt(this.egg.x + rand(-14, 14), this.egg.y);
      }
      if (t > 6.2 && !this.cracked) this.cracked = 0.01;
      if (this.cracked > 0 && this.cracked < 1) this.cracked = Math.min(1, this.cracked + dt * 1.6);
      if (t > 7.4 && !G.fish) {
        G.fish = makeFish(this.egg.x, this.egg.y, 0.5);
        G.ripple(this.egg.x, this.egg.y, 1.6);
        AudioSys.chime();
      }
      if (t > 8.2 && t < 12) autoSwim(dt, this.egg.x + 130, this.egg.y + 40, 42);
      if (t > 9.4 && !this.msg) {
        this.msg = true;
        whisper('你第一次游进这个池塘的时候，\n还不知道这里会发生什么。', 5200);
      }
      if (t > 14.6) { clearStateEntities(); gotoState('L1'); }
    },
    draw(ctx) {
      const t = this.t;
      G.drawWorld(ctx, vw, vh, G.cam, scale);
      withWorld(ctx, () => {
        if (t < 7.4) {
          G.drawEgg(ctx, this.egg.x, this.egg.y, t, this.cracked > 0 ? this.cracked : 0);
        }
        if (G.fish) G.drawFish(ctx, G.fish);
      });
      // 沉入水下的初始暗层
      if (t < 2.4) {
        ctx.fillStyle = `rgba(3,12,20,${clamp(1 - t / 2.4, 0, 1) * 0.85})`;
        ctx.fillRect(0, 0, vw, vh);
      }
    },
  };

  /* ============================================================
     L1 出生 — 探索与进食
     ============================================================ */
  STATES.L1 = {
    enter() {
      G.initPond(1);
      G.fish = G.fish || makeFish(G.W / 2, G.H / 2, 0.55);
      G.fish.x = G.W / 2; G.fish.y = G.H / 2;
      G.spawnFood(7);
      this.eaten = 0; this.buddy = null; this.stage = 'eat';
      this.msg = false; this.followT = 0;
      chapterTag('01', '出生', 'B I R T H');
      AudioSys.setAmbience({ vol: 0.05, bright: 420, rumble: 0, music: 'calm' });
    },
    update(dt) {
      controlFish(dt, 1, 235);
      G.updateWorld(dt, G.fish);
      // 进食
      W: for (let i = G.world.foods.length - 1; i >= 0; i--) {
        const f = G.world.foods[i];
        if (!f.alive) continue;
        if (dist(f.x, f.y, G.fish.x, G.fish.y) < 26 + G.fish.size * 10) {
          f.alive = false; this.eaten++;
          AudioSys.eat(); G.ripple(f.x, f.y, 0.45);
          G.fish.size = Math.min(0.9, 0.55 + this.eaten * 0.03);
          if (this.eaten === 1) whisper('这些发光的东西是什么，尝尝看吧', 4400);
          if (this.eaten === 6) whisper('好像在慢慢长大...', 4200);
          setTimeout(() => { const arr = G.world.foods; const idx = arr.indexOf(f); if (idx >= 0) arr.splice(idx, 1); }, 100);
          G.spawnFood(1);
          break;
        }
      }
      // 吃够了：伙伴出现
      if (this.eaten >= 12 && !this.buddy) {
        this.buddy = makeBuddy(G.fish.x + 700, G.fish.y - 420);
        G.buddy = this.buddy;
        whisper('它是谁？要去打个招呼吗...', 4600);
      }
      if (this.buddy) {
        const b = this.buddy, f = G.fish;
        if (this.stage === 'eat') {
          swimBuddy(b, dt, f.x + 110, f.y + 30, 70);
          if (dist(b.x, b.y, f.x + 110, f.y + 30) < 90 && !this.msg) {
            this.msg = true; this.stage = 'greet';
            whisper('原来池塘里还有别人。', 4200);
          }
        } else if (this.stage === 'greet') {
          this.greetT = (this.greetT || 0) + dt;
          swimBuddy(b, dt, f.x + 90, f.y + 20, 60);
          if (this.greetT > 3.4) {
            this.stage = 'lead'; b.tx = 1700; b.ty = 300;
            whisper('也许我应该跟随他。', 4600);
          }
        } else if (this.stage === 'lead') {
          swimBuddy(b, dt, b.tx, b.ty, 88);
          this.followT += dt;
          if ((dist(f.x, f.y, b.tx, b.ty) < 260 && dist(b.x, b.y, b.tx, b.ty) < 60) || this.followT > 22) {
            saveChapter(1);
            transition('它带你去看池塘的另一边。', 2400, () => gotoState('L2'));
            this.stage = 'out';
          }
        }
      }
      updateCam(dt);
    },
    draw(ctx) {
      G.drawWorld(ctx, vw, vh, G.cam, scale);
      withWorld(ctx, () => {
        if (this.buddy) G.drawFish(ctx, this.buddy);
        G.drawFish(ctx, G.fish);
      });
    },
  };

  /* ============================================================
     L2 玩伴 — 跟随 / 捉迷藏 / 群游跃水
     ============================================================ */
  STATES.L2 = {
    enter() {
      G.initPond(2);
      G.fish = G.fish || makeFish(G.W / 2, G.H / 2, 0.9);
      G.fish.x = G.W / 2; G.fish.y = G.H / 2;
      this.buddy = makeBuddy(G.W / 2 + 160, G.H / 2);
      G.buddy = this.buddy;
      this.shoal = [];
      for (let i = 0; i < 5; i++) {
        this.shoal.push({ ...makeBuddy(G.W / 2 + rand(-200, 200), G.H / 2 + rand(-160, 160)), color1: 'rgba(178,214,222,0.9)', color2: 'rgba(140,196,206,0.12)' });
      }
      this.stage = 'follow'; this.t = 0; this.followAcc = 0;
      this.wp = { x: rand(400, 1600), y: rand(300, 1000) }; this.wpT = 0;
      chapterTag('02', '玩伴', 'P L A Y M A T E S');
      AudioSys.setAmbience({ vol: 0.055, bright: 520, rumble: 0, music: 'calm' });
      setTimeout(() => whisper('跟上它——别跟丢了。', 4200), 1600);
      // 捉迷藏的三丛水草
      const pool = [...G.world.weeds].sort(() => Math.random() - 0.5).slice(0, 3);
      this.hideWeeds = pool;
      this.correct = Math.floor(rand(0, 3));
    },
    update(dt) {
      this.t += dt;
      const b = this.buddy, f = G.fish;
      G.updateWorld(dt, f);
      if (this.stage === 'follow') {
        controlFish(dt, 1, 260);
        this.wpT += dt;
        if (this.wpT > 2.6 || dist(b.x, b.y, this.wp.x, this.wp.y) < 90) {
          this.wp = { x: rand(350, 1650), y: rand(260, 1040) }; this.wpT = 0;
        }
        let sp = 120;
        if (dist(f.x, f.y, b.x, b.y) > 380) sp = 55; // 伙伴等待
        swimBuddy(b, dt, this.wp.x, this.wp.y, sp);
        this.shoal.forEach((s, i) => {
          this.wpT;
          const ang = this.t * (0.5 + i * 0.11);
          swimBuddy(s, dt, b.x + Math.cos(ang) * (120 + i * 22), b.y + Math.sin(ang) * (90 + i * 16), 130);
        });
        if (dist(f.x, f.y, b.x, b.y) < 250) this.followAcc += dt;
        if (this.followAcc > 10) {
          this.stage = 'hide'; this.hideT = 0;
          whisper('找到它', 2400);
          // 伙伴游向藏身水草
          const target = this.hideWeeds[this.correct];
          this.hideSpot = { x: target.x, y: target.y };
        }
      } else if (this.stage === 'hide') {
        controlFish(dt, 1, 240);
        this.hideT += dt;
        if (this.hideT > 1.8 && !this.hintWeed) {
          this.hintWeed = true;
          whisper('会动的水草里，有它。', 4400);
        }
        if (this.hideT < 2.4) {
          swimBuddy(b, dt, this.hideSpot.x, this.hideSpot.y, 190);
        } else {
          b.hidden = true;
          // 正确水草冒泡
          if (Math.random() < dt * 1.4) G.bubbleAt(this.hideSpot.x + rand(-30, 30), this.hideSpot.y + rand(-20, 20));
        }
        this.shoal.forEach((s, i) => {
          const ang = this.t * 0.7 + i;
          swimBuddy(s, dt, G.W / 2 + Math.cos(ang) * 420, G.H / 2 + Math.sin(ang) * 260, 100);
        });
        if (this.hideT > 2.4 && dist(f.x, f.y, this.hideSpot.x, this.hideSpot.y) < 135) {
          this.stage = 'race'; this.raceT = 0;
          b.hidden = false; b.x = this.hideSpot.x; b.y = this.hideSpot.y;
          AudioSys.chime(); G.ripple(f.x, f.y, 1.6);
        }
      } else if (this.stage === 'race') {
        this.raceT += dt;
        const ang = this.t * 0.85;
        swimBuddy(b, dt, G.W / 2 + Math.cos(ang) * 640, G.H / 2 + Math.sin(ang * 1.3) * 380, 235);
        this.shoal.forEach((s, i) => {
          const a2 = ang + 0.2 * i;
          swimBuddy(s, dt, G.W / 2 + Math.cos(a2) * (560 + i * 30), G.H / 2 + Math.sin(a2 * 1.2) * (330 + i * 18), 225);
        });
        controlFish(dt, 1, 300);
        if (this.raceT > 13) { this.stage = 'leap'; this.leapT = 0; AudioSys.whoosh(0.2); whisper('往上！大家一起——', 2600); }
      } else if (this.stage === 'leap') {
        // 全员冲向水面（画面上方），白光，落回
        this.leapT += dt;
        const all = [b, f, ...this.shoal];
        all.forEach((p, i) => {
          p.y -= (260 + i * 12) * dt; p.x += Math.sin(i) * 30 * dt;
          p.dir = -TAU / 4; p.tailPhase += dt * 14;
          if (Math.random() < dt * 4) G.bubbleAt(p.x, p.y + 14);
        });
        controlFish(dt, 0.35, 300);
        if (this.leapT > 1.5 && !this.flash) {
          this.flash = true; whiteFlash(700); AudioSys.splash();
        }
        if (this.leapT > 2.3 && !this.back) {
          this.back = true;
          all.forEach((p) => { p.y = clamp(p.y, 200, G.H - 200); });
          G.ripple(G.W / 2, 300, 3); G.ripple(G.W / 2 - 200, 340, 2.4); G.ripple(G.W / 2 + 220, 280, 2.6);
        }
        if (this.leapT > 4.2) {
          // 大鱼黑影掠过
          G.bigfish = makeBigFish(-150, 200);
          G.bigfish.dir = 0.5;
          this.stage = 'shadow'; this.shadowT = 0;
          AudioSys.rumbleTo(0.09, true);
        }
      } else if (this.stage === 'shadow') {
        this.shadowT += dt;
        const bf = G.bigfish;
        bf.x += 560 * dt * Math.cos(bf.dir); bf.y += 560 * dt * Math.sin(bf.dir);
        bf.tailPhase += dt * 4;
        this.shoal.forEach((s, i) => {
          const a2 = this.t * 2 + i;
          swimBuddy(s, dt, G.W / 2 + Math.cos(a2) * 500, G.H / 2 + Math.sin(a2) * 320, 260);
        });
        swimBuddy(b, dt, f.x - 120, f.y - 60, 240);
        controlFish(dt, 1, 280);
        if (this.shadowT > 2.6) {
          G.bigfish = null;
          saveChapter(2);
          transition('一个巨大的黑影从你们头顶经过。\n池塘忽然变得很安静。', 3000, () => gotoState('L3'), '#03101c');
        }
      }
      updateCam(dt);
    },
    draw(ctx) {
      G.drawWorld(ctx, vw, vh, G.cam, scale);
      withWorld(ctx, () => {
        this.shoal.forEach((s) => { if (!s.hidden) G.drawFish(ctx, s); });
        if (!this.buddy.hidden) G.drawFish(ctx, this.buddy);
        G.drawFish(ctx, G.fish);
        if (this.stage === 'shadow' && G.bigfish) G.drawBigFish(ctx, G.bigfish);
      });
    },
  };

  /* ============================================================
     L3 追逐 — 大鱼三阶段 AI + 鱼鳞
     ============================================================ */
  STATES.L3 = {
    enter() {
      G.initPond(3);
      G.fish = G.fish || makeFish(G.W / 2, G.H / 2 + 200, 0.95);
      G.fish.x = G.W / 2; G.fish.y = G.H - 300;
      this.big = makeBigFish(G.W / 2, -160);
      G.bigfish = this.big;
      this.t = 0; this.scales = 5; this.inv = 0; this.hitFx = 0;
      this.phase = 'chase'; this.gazeT = 0; this.done = false;
      chapterTag('03', '追逐', 'C H A S E');
      scalesUI(true, 5);
      AudioSys.setAmbience({ vol: 0.045, bright: 260, rumble: 0.05, music: 'tense' });
      setTimeout(() => whisper('游。别回头。', 3600), 1800);
    },
    update(dt) {
      this.t += dt;
      const f = G.fish, b = this.big;
      const inWeed = G.world.weeds.some((cl) => dist(f.x, f.y, cl.x, cl.y) < 95);
      controlFish(dt, 1, 275);
      G.updateWorld(dt, f);

      if (this.phase === 'chase') {
        const t = this.t;
        if (t > 5.5 && !this.fearMsg) { this.fearMsg = true; whisper('要一直跑吗...有点害怕....', 4800); }
        let sp = 152, pred = 0, turn = 1.5;
        if (t > 15) { sp = 178; pred = 0.85; turn = 1.8; }
        if (t > 32) { sp = 218; pred = 1.15; turn = 2.3; }
        let tx = f.x + f.vx * pred, ty = f.y + f.vy * pred;
        if (inWeed) { tx += Math.sin(this.t * 2.3) * 180; ty += Math.cos(this.t * 1.7) * 140; } // 水草掩蔽
        swimBig(b, dt, tx, ty, sp, turn);
        AudioSys.rumbleTo(clamp(0.1 - dist(b.x, b.y, f.x, f.y) / 2600, 0.015, 0.1), false);

        // 碰撞
        this.inv = Math.max(0, this.inv - dt);
        if (this.hitFx > 0) this.hitFx -= dt;
        if (dist(b.x, b.y, f.x, f.y) < b.size * 20 && this.inv <= 0 && this.phase === 'chase') {
          this.scales--;
          this.inv = 2.6; this.hitFx = 0.6;
          AudioSys.shatter(); G.ripple(f.x, f.y, 2.4);
          scalesUI(true, this.scales);
          // 击退
          const a = Math.atan2(f.y - b.y, f.x - b.x);
          f.vx = Math.cos(a) * 520; f.vy = Math.sin(a) * 520;
          if (this.scales <= 0) {
            // 被水流卷到安全角落，追逐重新开始
            this.phase = 'swept'; this.sweptT = 0;
            G.shardsLost = true;
          }
        }
        if (t >= 42) {
          this.phase = 'gaze'; this.gazeT = 0;
          AudioSys.rumbleTo(0.008, true);
        }
      } else if (this.phase === 'swept') {
        this.sweptT += dt;
        autoSwim(dt, 260, 1140, 300);
        if (Math.random() < dt * 4) G.bubbleAt(f.x, f.y);
        if (this.sweptT > 2.6) {
          this.phase = 'chase';
          this.scales = 3; scalesUI(true, this.scales);
          this.t = Math.max(this.t, 6); // 重启后仍会经历第二三阶段
          b.x = G.W / 2; b.y = -140;
        }
      } else if (this.phase === 'gaze') {
        this.gazeT += dt;
        // 大鱼停住，安静地看着玩家
        const ta = Math.atan2(f.y - b.y, f.x - b.x);
        let da = ta - b.dir;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        b.dir += da * Math.min(1, dt * 1.2);
        b.tailPhase += dt * 1.4;
        if (this.gazeT > 3.2) { this.phase = 'leave'; }
      } else if (this.phase === 'leave') {
        swimBig(b, dt, b.x + Math.cos(b.dir) * 500, -300, 90, 0.6);
        if (!this.msg) {
          this.msg = true;
          whisper('有些东西不是为了抓住你才一直跟着你。', 5200);
        }
        this.leaveT = (this.leaveT || 0) + dt;
        if (this.leaveT > 5.4) {
          saveChapter(3);
          transition('黄昏来了。\n水面上开始有了一层淡淡的金色。', 3000, () => gotoState('L4'), '#131a2e');
        }
      }
      updateCam(dt, f);
    },
    draw(ctx) {
      G.drawWorld(ctx, vw, vh, G.cam, scale);
      withWorld(ctx, () => {
        G.drawBigFish(ctx, this.big);
        G.drawFish(ctx, G.fish);
      });
      if (this.hitFx > 0) {
        ctx.fillStyle = `rgba(240,248,250,${this.hitFx * 0.5})`;
        ctx.fillRect(0, 0, vw, vh);
      }
    },
  };

  /* ============================================================
     L4 遗失物 — 收集与五段彩蛋
     ============================================================ */
  STATES.L4 = {
    enter() {
      G.initPond(4);
      G.fish = G.fish || makeFish(G.W / 2, G.H / 2, 1.0);
      G.fish.x = G.W / 2; G.fish.y = G.H / 2;
      G.spawnItems([...G.collected]);
      this.collectedHere = [];
      dotsUI(true, [...G.collected]);
      chapterTag('04', '遗失物', 'L O S T   T H I N G S');
      AudioSys.setAmbience({ vol: 0.03, bright: 200, rumble: 0, music: 'calm' });
      setTimeout(() => whisper('水底闪着微光的……是那些丢掉的东西。', 5200), 1800);
      this.egg = null;
      this.doorVision = 0;
      // 兼容存档：若五件记忆已在前次寻回，停留片刻便直接沉入深处
      this.sinkDelay = G.collected.size >= 5 ? 3.2 : undefined;
    },
    update(dt) {
      controlFish(dt, 1, 200);
      G.updateWorld(dt, G.fish);
      this.doorVision = Math.max(0, this.doorVision - dt);

      G.world.items.forEach((it) => {
        if (it.taken) {
          // 纸船彩蛋：漂走，玩家跟随
          if (it.id === 'boat' && it.drift) {
            it.drift.t += dt;
            it.x += 46 * dt; it.y -= 14 * dt;
            if (Math.random() < dt * 2.4) G.ripple(it.x, it.y + 6, 0.5);
          }
          return;
        }
        if (dist(it.x, it.y, G.fish.x, G.fish.y) < 52 && !this.busy) {
          it.taken = true;
          G.collected.add(it.id);
          this.collectedHere.push(it.id);
          dotsUI(true, [...G.collected]);
          this.playEgg(it.id, it);
        }
      });

      // 五件集齐（含存档继承）即触发下沉；给最后一件的彩蛋留出播放时间
      const allFound = G.collected.size >= 5;
      if (allFound && this.sinkDelay === undefined) this.sinkDelay = 3.0;
      if (allFound && this.sinkDelay !== undefined) {
        this.sinkDelay -= dt;
        if (this.sinkDelay <= 0 && !this.sinking) { this.sinking = true; this.sinkT = 0; }
      }
      if (this.sinking) {
        this.sinkT += dt;
        G.world.items.forEach((it) => { it.y += dt * 30 * (it.drift ? 0 : 1); });
        if (this.sinkT > 3.2) {
          saveChapter(4);
          transition('它们沉下去了。\n而你跟着它们，往更深处游。', 3000, () => gotoState('L5'), '#020c14');
          this.sinking = false; // 防止重复触发 transition
        }
      }
      updateCam(dt);
    },
    playEgg(id, it) {
      this.busy = true;
      const done = () => { this.busy = false; };
      if (id === 'bead') {
        // 玻璃珠：那个夏天散成一片发光的小珠子
        G.sparkleBurst(it.x, it.y);
        AudioSys.chime();
        whisper('玻璃珠里，藏着那个夏天。', 3400);
        setTimeout(done, 3000);
      } else if (id === 'boat') {
        it.drift = true; whisper('纸船记得它要去的地方。', 3200);
        setTimeout(done, 2600);
      } else if (id === 'clip') {
        AudioSys.chime();
        whisper('“你在哪里？”', 3800);
        setTimeout(done, 3000);
      } else if (id === 'duck') {
        G.world.duckFreeze = 2.4; AudioSys.quack();
        setTimeout(done, 2500);
      } else if (id === 'key') {
        this.doorVision = 3.6; AudioSys.door();
        whisper('水底很深的地方，有一扇门。', 3600);
        setTimeout(done, 3200);
      } else done();
    },
    draw(ctx) {
      G.drawWorld(ctx, vw, vh, G.cam, scale);
      withWorld(ctx, () => {
        G.drawFish(ctx, G.fish);
        // 钥匙彩蛋：水下门的幻影
        if (this.doorVision > 0) {
          ctx.save();
          ctx.globalAlpha = clamp(this.doorVision / 3.6, 0, 1) * 0.8;
          ctx.translate(1760, 210);
          ctx.fillStyle = 'rgba(8,18,26,0.9)';
          ctx.beginPath(); ctx.ellipse(0, 0, 60, 82, 0, 0, TAU); ctx.fill();
          ctx.strokeStyle = 'rgba(212,190,130,0.7)'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.ellipse(0, 0, 60, 82, 0, 0, TAU); ctx.stroke();
          ctx.restore();
        }
      });
    },
  };

  /* ============================================================
     L5 深处 — 黑暗迷宫 + 水流 + 缠草 + 门
     ============================================================ */
  STATES.L5 = {
    enter() {
      G.initPond(5);
      G.buildMaze();
      G.fish = G.fish || makeFish(250, 1120, 1.05);
      G.fish.x = 250; G.fish.y = 1120; G.fish.glow = true;
      G.dark = true;
      this.t = 0; this.doorT = 0; this.opening = false; this.msgT = 0;
      chapterTag('05', '深处', 'T H E   D E E P');
      AudioSys.setAmbience({ vol: 0.028, bright: 150, rumble: 0.03, music: 'off' });
      hideTagLater();
    },
    update(dt) {
      this.t += dt;
      const f = G.fish;
      const inCurrent = G.mazeForces(f, dt);
      controlFish(dt, 1, 230);
      if (inCurrent) { f.x += inCurrent.fx * dt; f.y += inCurrent.fy * dt; }
      G.updateWorld(dt, f);

      // 缠草：需要快速晃动鼠标挣脱
      let tangledNow = false;
      G.world.tangles.forEach((tg) => {
        if (dist(f.x, f.y, tg.x, tg.y) < tg.r) tangledNow = true;
      });
      if (tangledNow) {
        f.trapped = Math.min(3, (f.trapped || 0) + dt);
        f.x = lerp(f.x, f.x - f.vx * dt * 0.6, 0.5);
        const effort = G.mouse.spd * dt * 0.028;
        f.trapped -= effort;
        if (Math.random() < dt * 3) G.bubbleAt(f.x, f.y);
        // 兜底：被缠住 3 秒后水流自然会把你松开，不会卡死
        if (f.trapped >= 3) {
          this.stuckT = (this.stuckT || 0) + dt;
          if (this.stuckT > 1.4) { f.trapped = 0; this.stuckT = 0; G.ripple(f.x, f.y, 1.1); }
        } else this.stuckT = 0;
        if (f.trapped <= 0.05) { f.trapped = 0; G.ripple(f.x, f.y, 1.1); }
      } else if (f.trapped > 0) {
        f.trapped = Math.max(0, f.trapped - dt * 1.8);
      }

      // 门
      const door = G.world.door;
      const dDoor = dist(f.x, f.y, door.x, door.y);
      if (!this.opening && dDoor < 110) {
        this.opening = true; this.doorT = 0;
        AudioSys.door(); AudioSys.chime();
      }
      if (this.opening) {
        this.doorT += dt;
        door.open = clamp(this.doorT / 2.6, 0, 1);
        if (this.doorT > 3.4) {
          saveChapter(5);
          whiteFlash(900);
          transition('门后面不是宝藏。\n是一片很亮、很亮的水。', 2800, () => gotoState('L6'), '#eaf4f2');
          this.opening = false;
        }
      }
      // 提示语
      if (this.t > 3 && this.msgT === 0) { this.msgT = 1; whisper('深处很冷。\n还记得那些发光的东西吗。', 4800); }

      // 相机与黑暗（lights 是世界坐标，先转屏幕坐标再交给遮罩）
      updateCam(dt);
      const toScr = (x, y) => ({ x: (x - G.cam.x) * scale + vw / 2, y: (y - G.cam.y) * scale + vh / 2 });
      const fs = toScr(f.x, f.y);
      this.lights = [{ x: fs.x, y: fs.y, r: (250 + Math.sin(this.t * 2) * 14) * scale, a: 0.96 }];
      G.world.items.forEach((it) => {
        if (it.taken) return;
        const d = dist(f.x, f.y, it.x, it.y);
        if (d < 520) {
          const s = toScr(it.x, it.y);
          this.lights.push({ x: s.x, y: s.y, r: (80 + Math.sin(this.t * 3 + it.pulse) * 14) * scale, a: 0.7 });
        }
      });
      if (dDoor < 560) {
        const s = toScr(door.x, door.y);
        this.lights.push({ x: s.x, y: s.y, r: 150 * scale, a: 0.8 });
      }
    },
    draw(ctx) {
      G.drawWorld(ctx, vw, vh, G.cam, scale);
      withWorld(ctx, () => {
        // 玩家携带的钥匙微光
        const g = ctx.createRadialGradient(G.fish.x + 16, G.fish.y - 10, 2, G.fish.x + 16, G.fish.y - 10, 30);
        g.addColorStop(0, 'rgba(212,190,130,0.5)');
        g.addColorStop(1, 'rgba(212,190,130,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(G.fish.x + 16, G.fish.y - 10, 30, 0, TAU); ctx.fill();
        G.drawFish(ctx, G.fish);
      });
      // 黑暗遮罩：只在小鱼与光源物周围开天窗
      G.drawDarkness(ctx, vw, vh, this.lights || [{ x: vw / 2, y: vh / 2, r: 240 }]);
      // 光源物画回黑暗之上（微弱）
      withWorld(ctx, () => {
        G.world.items.forEach((it) => {
          if (it.taken) return;
          const d = dist(G.fish.x, G.fish.y, it.x, it.y);
          if (d < 520) {
            ctx.save(); ctx.globalAlpha = 0.85;
            G.drawItem(ctx, it);
            ctx.restore();
          }
        });
      });
    },
  };
  function hideTagLater() { setTimeout(() => hideTag(), 6000); }

  /* ============================================================
     L6 出水 — 放开控制
     ============================================================ */
  STATES.L6 = {
    enter() {
      G.initPond(6);
      G.fish = G.fish || makeFish(G.W / 2, G.H - 200, 1.1);
      G.fish.x = G.W / 2; G.fish.y = G.H - 180; G.fish.glow = false;
      this.t = 0; this.control = 1; this.released = false;
      this.hint = false; this.stillT = 0;
      this.autoIdx = 0;
      this.buddy = null; this.big = null;
      chapterTag('06', '出水', 'S U R F A C E');
      AudioSys.setAmbience({ vol: 0.05, bright: 560, rumble: 0, music: 'calm' });
      G.ripple(G.fish.x, G.fish.y, 1.2);
    },
    update(dt) {
      this.t += dt;
      const f = G.fish;
      // 控制逐渐失效
      if (!this.released) {
        this.control = clamp(1 - Math.max(0, this.t - 7) / 9, 0.12, 1);
        controlFish(dt, this.control, 240);
        if (this.t > 10 && !this.hint) {
          this.hint = true;
          G._mouseupFlag = false; // 只认可提示出现之后的松手
          whisper('松开鼠标。', 12000);
        }
        if (this.hint) {
          if (G._mouseupFlag) { this.released = true; }
          else if (G.mouse.spd < 1.5) { this.stillT += dt; if (this.stillT > 2.2) this.released = true; }
          else this.stillT = 0;
        }
      }
      if (this.released && !this.free) {
        this.free = true;
        this.freeT = 0;
        this.e1 = this.e2 = this.e3 = this.e4 = false;
        whisperEl.classList.remove('show');
        AudioSys.chime();
        // 巡游路线：荷叶 → 鸭群 → 与大鱼相会 → 伙伴 → 回到池塘中心
        this.route = [
          { x: 900, y: 380 }, { x: 430, y: 620 }, { x: 1150, y: 560 },
          { x: 760, y: 830 }, { x: 1520, y: 460 }, { x: 1000, y: 620 },
        ];
        // 大鱼安静地横穿
        this.big = makeBigFish(-200, 520); this.big.dir = 0;
        G.bigfish = this.big;
      }
      if (this.free) {
        this.freeT += dt;
        const wp = this.route[this.autoIdx];
        if (wp) {
          autoSwim(dt, wp.x, wp.y, 62);
          if (dist(f.x, f.y, wp.x, wp.y) < 70) this.autoIdx = (this.autoIdx + 1) % this.route.length;
        } else {
          autoSwim(dt, f.x + 200, f.y, 55);
        }
        // 大鱼缓慢横穿
        if (this.big) {
          this.big.x += 64 * dt; this.big.tailPhase += dt * 2.4;
          if (this.big.x > G.W + 300) this.big = null;
        }
        // 伙伴在中途出现，同行一段后离开
        if (this.autoIdx >= 3 && !this.buddy) {
          this.buddy = makeBuddy(f.x + 320, f.y - 180);
        }
        if (this.buddy) {
          swimBuddy(this.buddy, dt, f.x + 120, f.y - 60, 62);
          if (this.autoIdx >= 4) swimBuddy(this.buddy, dt, this.buddy.x + 200, this.buddy.y - 300, 96);
        }
        // 松手 5.2 秒后：结束文字一句一句浮现，小鱼仍在自由游动
        if (!this.e1 && this.freeT > 5.2) { this.e1 = true; whisper('池塘一直都在。', 4600); }
        if (!this.e2 && this.freeT > 10.4) { this.e2 = true; whisper('而我只是其中一个来去的过客。', 5000); }
        if (!this.e3 && this.freeT > 16) { this.e3 = true; whisper('穿梭于水面与水底，\n穿梭于相遇与离开。', 5400); }
        if (!this.e4 && this.freeT > 21.8) { this.e4 = true; whisper('我不知道要游向哪里。\n但我仍然自由。', 5600); }
        if (this.freeT > 28.6) {
          saveChapter(6);
          gotoState('ENDING');
        }
      }
      G.updateWorld(dt, this.released ? f : null);
      updateCam(dt, f);
    },
    draw(ctx) {
      G.drawWorld(ctx, vw, vh, G.cam, scale);
      withWorld(ctx, () => {
        if (this.big) G.drawBigFish(ctx, this.big);
        if (this.buddy) G.drawFish(ctx, this.buddy);
        G.drawFish(ctx, G.fish);
      });
    },
  };

  /* ============================================================
     ENDING / SECRET / CREDITS
     ============================================================ */

  STATES.ENDING = {
    enter() {
      this.t = 0; this.stage = 0;
      hideTag(); whisperEl.classList.remove('show');
      scalesUI(false); dotsUI(false);
      AudioSys.setAmbience({ vol: 0.05, bright: 560, rumble: 0, music: 'calm' });
      this.secret = G.collected.size >= 5 && !G.shardsLost;
      // 不切画面：小鱼留在池塘里，继续自由地游
      this.route = [
        { x: 1500, y: 520 }, { x: 620, y: 420 }, { x: 1320, y: 720 },
        { x: 820, y: 960 }, { x: 1520, y: 460 }, { x: 1000, y: 620 },
      ];
      this.autoIdx = 0;
      this.secretFish = null;
      G.bigfish = null; G.buddy = null;
      cursorEl.classList.add('show');
    },
    update(dt) {
      this.t += dt;
      const f = G.fish;
      // 自由巡游：总结文字已在第六章播完，这里只有 THE END 与循环的暗示
      const wp = this.route[this.autoIdx];
      autoSwim(dt, wp.x, wp.y, 48);
      if (dist(f.x, f.y, wp.x, wp.y) < 60) this.autoIdx = (this.autoIdx + 1) % this.route.length;
      G.updateWorld(dt, f);

      if (this.stage === 0 && this.t > 0.8) {
        this.stage = 1;
        whisper('THE END', 5000);
        AudioSys.chime();
      }
      if (this.stage === 1 && this.t > 6.4) {
        if (this.secret && !this.secretDone) {
          this.stage = 'secret'; this.secretT = 0; this.secretDone = true;
          this.secretFish = makeFish(f.x + rand(-60, 60), G.H - 50, 0.5);
          whisper('……又一条小鱼，从水草里游了出来。', 4600);
        } else {
          this.stage = 3;
          endEl.classList.add('show');
        }
      }
      if (this.stage === 'secret') {
        this.secretT += dt;
        const sf = this.secretFish;
        sf.y -= 30 * dt;
        sf.x += Math.sin(this.secretT * 1.8) * 36 * dt;
        sf.dir = -TAU / 4 + Math.cos(this.secretT * 1.8) * 0.4;
        sf.tailPhase += dt * 6;
        if (Math.random() < dt * 0.8) G.bubbleAt(sf.x, sf.y);
        if (this.secretT > 5.4) { this.stage = 3; endEl.classList.add('show'); }
      }
    },
    draw(ctx) {
      G.drawWorld(ctx, vw, vh, G.cam, scale);
      withWorld(ctx, () => {
        if (this.stage === 'secret' && this.secretFish) {
          ctx.save();
          ctx.globalAlpha = clamp(this.secretT / 1.4, 0, 1);
          G.drawFish(ctx, this.secretFish);
          ctx.restore();
        }
        G.drawFish(ctx, G.fish);
      });
    },
  };

  STATES.SECRET = STATES.ENDING;

  endEl.querySelector('#btn-replay').addEventListener('click', () => {
    endEl.classList.remove('show');
    clearSave();
    G.collected = new Set(); G.shardsLost = false;
    transition('又是一次放学。\n又是一个夏天。', 2600, () => gotoState('INTRO'));
  });
  endEl.querySelector('#btn-pond').addEventListener('click', () => {
    endEl.classList.remove('show');
    transition('', 600, () => gotoState('CREDITS'));
  });

  STATES.CREDITS = {
    enter() { this.t = 0; },
    update(dt) {
      this.t += dt;
      if (this.t > 4.6) gotoState('TITLE');
    },
    draw(ctx) {
      ctx.fillStyle = '#04101a';
      ctx.fillRect(0, 0, vw, vh);
      ctx.fillStyle = 'rgba(232,242,240,0.8)';
      ctx.textAlign = 'center';
      ctx.font = '17px "Songti SC", "Noto Serif SC", serif';
      const lines = [
        '六次逃离池塘', '',
        '一个关于池塘、童年与松手的小作品',
        '为所有记得那个夏天的人',
      ];
      lines.forEach((l, i) => ctx.fillText(l, vw / 2, vh / 2 - 60 + i * 44));
    },
  };

  /* ============================================================
     启动与主循环
     ============================================================ */
  function resize() {
    // 按设备像素比渲染（上限 2）：渐变更平滑，手机上不出色带
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = window.innerWidth;
    vh = window.innerHeight;
    canvas.width = vw * dpr;
    canvas.height = vh * dpr;
    canvas.style.width = vw + 'px';
    canvas.style.height = vh + 'px';
    G.DPR = dpr;
    // 触摸屏 / 窄屏：光柱与天光减半，避免高亮屏上刺眼
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    G.raySoft = coarse || vw < 720 ? 0.4 : 1;
    scale = Math.max(vw / G.W, vh / G.H);
  }
  window.addEventListener('resize', resize);
  resize();

  // 世界坐标下的绘制：所有实体（鱼/卵/门…）都必须在这个变换里画
  function withWorld(ctx, fn) {
    ctx.save();
    ctx.translate(vw / 2, vh / 2);
    ctx.scale(scale, scale);
    ctx.translate(-G.cam.x, -G.cam.y);
    fn();
    ctx.restore();
  }

  // URL 参数直达章节
  const qp = new URLSearchParams(location.search).get('ch');
  G.collected = new Set();

  try {
    gotoState('TITLE');
  } catch (e) {
    window.__gameErr = 'init: ' + (e.stack || e.message);
  }
  if (qp) {
    const n = clamp(parseInt(qp, 10) || 1, 1, 6);
    setTimeout(() => { titleEl.classList.remove('show'); startChapter(n); }, 400);
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    G.mouse.spd *= 0.86;
    ctx.setTransform(G.DPR || 1, 0, 0, G.DPR || 1, 0, 0);
    try {
      if (S.update) S.update(dt);
    } catch (e) { window.__gameErr = window.__gameErr || ('update: ' + (e.stack || e.message)); }
    try {
      ctx.clearRect(0, 0, vw, vh);
      if (S.draw) S.draw(ctx);
    } catch (e) { window.__gameErr = window.__gameErr || ('draw: ' + (e.stack || e.message)); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 调试模式（?debug=1）：手动步进游戏循环，便于在后台标签中验证逻辑
  if (new URLSearchParams(location.search).has('debug')) {
    window.__debug = {
      step(dt = 0.016, n = 1) {
        let e = null;
        for (let i = 0; i < n; i++) {
          try { S.update(dt); } catch (err) { e = err.message; break; }
        }
        return e || G.state;
      },
      draw() {
        try { S.draw(ctx); } catch (err) { return err.message; }
        return 'ok';
      },
    };
  }
})();
