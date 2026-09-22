/* ============================================================
   AudioSys — 全部声音由 WebAudio 程序合成，无任何音频文件。
   水下低频氛围 / 气泡 / 鸭叫 / 进食 / 鳞碎 / 闪回泛音 / 水花。
   ============================================================ */
(function () {
  const A = { ctx: null, master: null, ready: false, ambience: null, rumble: null, current: null };

  A.init = function () {
    if (A.ready) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    A.ctx = new Ctx();
    A.master = A.ctx.createGain();
    A.master.gain.value = 0.85;
    A.master.connect(A.ctx.destination);

    // 循环白噪声源（供氛围与水花复用）
    const len = A.ctx.sampleRate * 2;
    const buf = A.ctx.createBuffer(1, len, A.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    A.noiseBuf = buf;

    // 氛围层：低通噪声 + 缓慢起伏
    const src = A.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = A.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.6;
    const g = A.ctx.createGain(); g.gain.value = 0.0;
    const lfo = A.ctx.createOscillator(); lfo.frequency.value = 0.09;
    const lfoG = A.ctx.createGain(); lfoG.gain.value = 0.012;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    src.connect(lp); lp.connect(g); g.connect(A.master);
    src.start(); lfo.start();
    A.ambience = { gain: g, filter: lp };

    // 低频层（大鱼接近 / 深水）
    const ro = A.ctx.createOscillator();
    ro.type = 'sine'; ro.frequency.value = 52;
    const rg = A.ctx.createGain(); rg.gain.value = 0;
    ro.connect(rg); rg.connect(A.master); ro.start();
    A.rumble = { osc: ro, gain: rg };
    A.ready = true;
  };

  A.resume = function () { if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume(); };

  // 氛围档案：每章不同 { vol, bright, rumble }
  A.setAmbience = function (p) {
    if (!A.ready) { A.current = p; return; }
    A.current = p;
    const t = A.ctx.currentTime;
    A.ambience.gain.gain.setTargetAtTime(p.vol ?? 0.05, t, 1.2);
    A.ambience.filter.frequency.setTargetAtTime(p.bright ?? 320, t, 1.4);
    A.rumble.gain.gain.setTargetAtTime(p.rumble ?? 0.0, t, 1.6);
  };

  A.rumbleTo = function (v, fast) {
    if (!A.ready) return;
    A.rumble.gain.gain.setTargetAtTime(v, A.ctx.currentTime, fast ? 0.25 : 1.2);
  };

  function blip(freq, dur, vol, type, glideTo) {
    if (!A.ready) return;
    const t = A.ctx.currentTime;
    const o = A.ctx.createOscillator();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(A.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function noiseBurst(dur, vol, hpFreq, lpFreq) {
    if (!A.ready) return;
    const t = A.ctx.currentTime;
    const src = A.ctx.createBufferSource();
    src.buffer = A.noiseBuf;
    const hp = A.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = hpFreq;
    const lp = A.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lpFreq;
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(A.master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  A.eat = function () { blip(660 + Math.random() * 160, 0.09, 0.06, 'sine', 990); };
  A.pop = function () { blip(430 + Math.random() * 120, 0.14, 0.10, 'sine', 240); };
  A.bubble = function () { blip(280 + Math.random() * 220, 0.16, 0.045, 'sine', 820 + Math.random() * 300); };
  A.quack = function () { blip(310, 0.09, 0.05, 'triangle', 210); setTimeout(() => blip(290, 0.11, 0.04, 'triangle', 190), 120); };
  A.shatter = function () { noiseBurst(0.45, 0.22, 900, 5200); blip(96, 0.5, 0.16, 'sine', 52); };
  A.whoosh = function (vol) { noiseBurst(0.8, vol || 0.14, 120, 900); };
  A.chime = function () {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => setTimeout(() => blip(f, 1.6, 0.045, 'sine'), i * 170));
  };
  A.door = function () { blip(72, 1.8, 0.14, 'sine', 48); noiseBurst(1.2, 0.05, 60, 500); };
  A.splash = function () { noiseBurst(0.55, 0.26, 300, 3800); blip(190, 0.3, 0.08, 'sine', 70); };

  /* ---------- 程序化环境音乐：和弦垫 + 水滴琴点缀 ---------- */
  A.music = { bus: null, filter: null, mode: 'off', timer: null, noteTimer: null, chordIdx: 0, active: [] };

  const CHORDS_CALM = [
    [130.81, 196.0, 261.63, 329.63],   // C
    [110.0, 220.0, 261.63, 329.63],    // Am
    [87.31, 174.61, 261.63, 440.0],    // F
    [98.0, 196.0, 293.66, 392.0],      // G
  ];
  const CHORDS_TENSE = [
    [110.0, 220.0, 261.63, 329.63],    // Am
    [146.83, 220.0, 293.66, 349.23],   // Dm
    [82.41, 164.81, 246.94, 329.63],   // E
    [174.61, 220.0, 261.63, 349.23],   // F
  ];
  const NOTES_CALM = [523.25, 587.33, 659.25, 783.99, 880.0];
  const NOTES_TENSE = [440.0, 523.25, 587.33, 659.25, 698.46];

  A.startMusic = function (mode) {
    if (!A.ready) { A.music.mode = mode; return; }
    A.resume();
    if (!A.music.bus) {
      A.music.bus = A.ctx.createGain();
      A.music.bus.gain.value = 0;
      const lp = A.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 950; lp.Q.value = 0.4;
      A.music.bus.connect(lp); lp.connect(A.master);
      A.music.filter = lp;
    }
    A.music.mode = mode;
    const t = A.ctx.currentTime;
    A.music.bus.gain.setTargetAtTime(mode === 'off' ? 0 : (mode === 'tense' ? 0.85 : 0.62), t, 2);
    if (mode === 'off') {
      A.music.active.forEach((n) => { n.gain.gain.setTargetAtTime(0, t, 0.8); n.oscs.forEach((o) => o.stop(t + 3)); });
      A.music.active = [];
      return;
    }
    if (!A.music.timer) { A.playChord(); A.music.timer = setInterval(() => A.playChord(), 5200); }
    if (!A.music.noteTimer) A.scheduleNote();
  };

  A.playChord = function () {
    if (A.music.mode === 'off' || !A.ready) return;
    const tense = A.music.mode === 'tense';
    const chords = tense ? CHORDS_TENSE : CHORDS_CALM;
    const chord = chords[A.music.chordIdx % chords.length];
    A.music.chordIdx++;
    const t = A.ctx.currentTime;
    // 上一组和弦缓慢消散
    A.music.active.forEach((n) => {
      n.gain.gain.setTargetAtTime(0, t, 1.0);
      n.oscs.forEach((o) => o.stop(t + 4));
    });
    A.music.active = [];
    // 新和弦：每音两个微失谐正弦，暖而柔
    chord.forEach((f, i) => {
      const g = A.ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime((tense ? 0.03 : 0.033) / (1 + i * 0.28), t, 1.3);
      const oscs = [];
      [f, f * 1.0035].forEach((fr) => {
        const o = A.ctx.createOscillator();
        o.type = 'sine'; o.frequency.value = fr;
        o.connect(g); o.start(t);
        oscs.push(o);
      });
      g.connect(A.music.bus);
      A.music.active.push({ oscs, gain: g });
    });
  };

  A.scheduleNote = function () {
    A.music.noteTimer = setTimeout(() => {
      if (A.music.mode !== 'off' && A.ready) {
        const tense = A.music.mode === 'tense';
        const scale = tense ? NOTES_TENSE : NOTES_CALM;
        blip(scale[Math.floor(Math.random() * scale.length)], 2.6, tense ? 0.03 : 0.024, 'sine');
        A.scheduleNote();
      }
      }, tense() ? 1300 + Math.random() * 1300 : 2800 + Math.random() * 2800);
  };
  function tense() { return A.music.mode === 'tense'; }

  // setAmbience 联动音乐模式
  const _setAmb = A.setAmbience;
  A.setAmbience = function (p) {
    _setAmb(p);
    if (p && p.music) A.startMusic(p.music);
  };

  window.AudioSys = A;
})();
