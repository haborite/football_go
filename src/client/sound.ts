// 囲碁サッカーの音響: Web Audio APIによる完全プロシージャル合成（音源ファイル不要）
//
// コンセプト =「静寂の碁 × 喧騒のサッカー」（『日常』的な不条理の音響化）
// - 着手音: 碁石の「パチッ」。高域のクリック過渡音(2-4kHz)＋碁盤の胴鳴り(約300Hz)の二層
// - 進行音: サッカー審判の笛で統一。実物のホイッスル（主要周波数2.2-4.4kHz、
//   近接2周波数のうなりによるトリル）を2発振器のビートで模す
//   開始=長笛 / パス=短笛 / 待った=ファウル二連笛 / 終局=試合終了三連笛
// - 捕獲: 石を拾い上げる連続クリック＋帯域ノイズの包絡で作る観客の歓声
// - BGM: 琴風プラック（平調子ペンタトニック・カープラス風の減衰）をまばらに。
//   その下にごく薄いスタジアムの群衆ノイズを敷き、「競技場で碁を打つ」空気を作る

type WhistleBlast = { dur: number; gap?: number };

const LS_BGM = 'gofb-bgm';
const LS_SE = 'gofb-se';

// 平調子（A基準）のスケール: A, B, C, E, F + オクターブ上
const SCALE_SEMITONES = [0, 2, 3, 7, 8, 12, 14, 15];
const SCALE_BASE = 220; // A3

class SoundManager {
  private ctx: AudioContext | null = null;
  private seBus: GainNode | null = null;
  private bgmBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  private bgmTimer: number | null = null;
  private bgmNextTime = 0;
  private bgmDegree = 4;
  private bgmNodes: AudioNode[] = [];
  private inGame = false;

  bgmOn = localStorage.getItem(LS_BGM) !== '0';
  seOn = localStorage.getItem(LS_SE) !== '0';

  // ---- 基盤 ----

  private ensure(): AudioContext | null {
    try {
      if (!this.ctx) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.seBus = this.ctx.createGain();
        this.seBus.gain.value = 0.9;
        this.seBus.connect(this.ctx.destination);
        this.bgmBus = this.ctx.createGain();
        this.bgmBus.gain.value = 0.9;
        this.bgmBus.connect(this.ctx.destination);
        // ノイズバッファ（笛の息成分・歓声・群衆に共用）
        const len = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  private noiseSource(ctx: AudioContext, loop = false): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = loop;
    return src;
  }

  // ---- 効果音（碁） ----

  /** 碁石を打つ「パチッ」 */
  stone(soft = false) {
    if (!this.seOn) return;
    const ctx = this.ensure();
    if (!ctx || !this.seBus) return;
    try {
      const t = ctx.currentTime;
      const vol = soft ? 0.5 : 1;
      // 高域クリック過渡音（ノイズバースト）
      const click = this.noiseSource(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2000;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.5 * vol, t);
      cg.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
      click.connect(hp).connect(cg).connect(this.seBus);
      click.start(t);
      click.stop(t + 0.03);
      // 石の鳴り（高域）
      const ping = ctx.createOscillator();
      ping.type = 'sine';
      ping.frequency.value = 2300 * (0.95 + Math.random() * 0.1);
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.22 * vol, t);
      pg.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      ping.connect(pg).connect(this.seBus);
      ping.start(t);
      ping.stop(t + 0.06);
      // 碁盤の胴鳴り（低中域、わずかに下降）
      const body = ctx.createOscillator();
      body.type = 'sine';
      const f0 = 300 * (0.95 + Math.random() * 0.1);
      body.frequency.setValueAtTime(f0, t);
      body.frequency.exponentialRampToValueAtTime(f0 * 0.85, t + 0.12);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.3 * vol, t);
      bg.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      body.connect(bg).connect(this.seBus);
      body.start(t);
      body.stop(t + 0.16);
    } catch {
      /* 音は失敗しても無視 */
    }
  }

  /** 石を取り上げる音 + 歓声（数に応じて大きく） */
  capture(count: number) {
    if (!this.seOn) return;
    const ctx = this.ensure();
    if (!ctx || !this.seBus) return;
    try {
      const t = ctx.currentTime;
      const n = Math.min(count, 5);
      for (let i = 0; i < n; i++) {
        const at = t + 0.06 + i * 0.055;
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = 2600 * (0.9 + Math.random() * 0.2);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.16, at);
        g.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
        o.connect(g).connect(this.seBus);
        o.start(at);
        o.stop(at + 0.05);
      }
      this.cheer(Math.min(0.35 + count * 0.18, 1));
    } catch {
      /* ignore */
    }
  }

  /** 観客の歓声（帯域ノイズの包絡） */
  cheer(intensity: number) {
    if (!this.seOn) return;
    const ctx = this.ensure();
    if (!ctx || !this.seBus) return;
    try {
      const t = ctx.currentTime;
      const dur = 0.8 + intensity * 0.8;
      for (const [freq, q, lv] of [
        [750, 0.9, 0.14],
        [1500, 1.2, 0.05],
      ] as const) {
        const src = this.noiseSource(ctx);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = freq * (0.9 + Math.random() * 0.2);
        bp.Q.value = q;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(lv * intensity, t + 0.1);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(bp).connect(g).connect(this.seBus);
        src.start(t, Math.random());
        src.stop(t + dur + 0.1);
      }
    } catch {
      /* ignore */
    }
  }

  // ---- 効果音（サッカー審判の笛） ----

  /**
   * ホイッスル: 近接した2周波数のうなり（実物のFox40型と同じ原理）＋
   * 倍音＋息のノイズ成分
   */
  private whistle(blasts: WhistleBlast[], volume = 0.16) {
    if (!this.seOn) return;
    const ctx = this.ensure();
    if (!ctx || !this.seBus) return;
    try {
      let t = ctx.currentTime + 0.02;
      for (const b of blasts) {
        t += b.gap ?? 0;
        const end = t + b.dur;
        const master = ctx.createGain();
        master.gain.setValueAtTime(0.0001, t);
        master.gain.exponentialRampToValueAtTime(volume, t + 0.015);
        master.gain.setValueAtTime(volume, end - 0.02);
        master.gain.exponentialRampToValueAtTime(0.0001, end + 0.03);
        master.connect(this.seBus);
        // 基音2発振器（差≈42Hzのうなりがトリルになる）
        for (const [f, lv] of [
          [2350, 0.5],
          [2392, 0.5],
          [4700, 0.08],
        ] as const) {
          const o = ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = f;
          const g = ctx.createGain();
          g.gain.value = lv;
          o.connect(g).connect(master);
          o.start(t);
          o.stop(end + 0.05);
        }
        // 息のノイズ
        const breath = this.noiseSource(ctx);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2400;
        bp.Q.value = 8;
        const bg = ctx.createGain();
        bg.gain.value = 0.25;
        breath.connect(bp).connect(bg).connect(master);
        breath.start(t, Math.random());
        breath.stop(end + 0.05);
        t = end;
      }
    } catch {
      /* ignore */
    }
  }

  /** 対局開始: キックオフの長笛 */
  kickoff() {
    this.whistle([{ dur: 0.65 }]);
    this.cheer(0.5);
  }

  /** パス: 短笛 */
  passWhistle() {
    this.whistle([{ dur: 0.15 }]);
  }

  /** 待った: ファウルの二連笛 */
  foul() {
    this.whistle([{ dur: 0.12 }, { dur: 0.12, gap: 0.1 }]);
  }

  /** 終局: 試合終了の三連笛（ピッ・ピッ・ピーーッ） */
  finalWhistle() {
    this.whistle([{ dur: 0.14 }, { dur: 0.14, gap: 0.1 }, { dur: 0.85, gap: 0.1 }]);
    this.cheer(1);
  }

  /** 置けない: ブザー */
  buzzer() {
    if (!this.seOn) return;
    const ctx = this.ensure();
    if (!ctx || !this.seBus) return;
    try {
      const t = ctx.currentTime;
      for (const f of [120, 90]) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = f;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 500;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.07, t);
        g.gain.setValueAtTime(0.07, t + 0.18);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
        o.connect(lp).connect(g).connect(this.seBus);
        o.start(t);
        o.stop(t + 0.26);
      }
    } catch {
      /* ignore */
    }
  }

  /** 勝敗ジングル */
  result(kind: 'win' | 'lose' | 'draw') {
    if (!this.seOn) return;
    const ctx = this.ensure();
    const bus = this.seBus;
    if (!ctx || !bus) return;
    try {
      const t = ctx.currentTime;
      const notes =
        kind === 'win'
          ? [523.25, 659.25, 783.99, 1046.5]
          : kind === 'lose'
            ? [392, 329.63, 261.63]
            : [523.25, 587.33];
      const step = kind === 'win' ? 0.13 : 0.22;
      notes.forEach((f, i) => {
        const at = t + i * step;
        for (const [type, mult, lv] of [
          ['triangle', 1, 0.14],
          ['sine', 2, 0.04],
        ] as const) {
          const o = ctx.createOscillator();
          o.type = type;
          o.frequency.value = f * mult;
          const g = ctx.createGain();
          g.gain.setValueAtTime(lv, at);
          g.gain.exponentialRampToValueAtTime(0.001, at + (kind === 'win' ? 0.5 : 0.6));
          o.connect(g).connect(bus);
          o.start(at);
          o.stop(at + 0.7);
        }
      });
    } catch {
      /* ignore */
    }
  }

  /** 再生モードの小さな送り音 */
  tick() {
    if (!this.seOn) return;
    const ctx = this.ensure();
    if (!ctx || !this.seBus) return;
    try {
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 1200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.08, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
      o.connect(g).connect(this.seBus);
      o.start(t);
      o.stop(t + 0.04);
    } catch {
      /* ignore */
    }
  }

  // ---- BGM ----

  /** 琴風プラック（鋭いアタック＋長い減衰、わずかなデチューン副弦） */
  private pluck(at: number, freq: number, vol: number) {
    const ctx = this.ctx!;
    const bus = this.bgmBus!;
    // 爪のアタック
    const pick = this.noiseSource(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = freq * 4;
    hp.Q.value = 1.5;
    const pkg = ctx.createGain();
    pkg.gain.setValueAtTime(0.08 * vol, at);
    pkg.gain.exponentialRampToValueAtTime(0.001, at + 0.03);
    pick.connect(hp).connect(pkg).connect(bus);
    pick.start(at, Math.random());
    pick.stop(at + 0.05);
    // 弦本体（基音 + デチューン副弦 + 倍音）
    for (const [mult, lv, dec] of [
      [1, 0.12, 1.6],
      [1.003, 0.06, 1.3],
      [2, 0.025, 0.7],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(lv * vol, at);
      g.gain.exponentialRampToValueAtTime(0.0008, at + dec);
      o.connect(g).connect(bus);
      o.start(at);
      o.stop(at + dec + 0.1);
    }
  }

  private scheduleBgm() {
    const ctx = this.ctx;
    if (!ctx || !this.bgmBus) return;
    const ahead = ctx.currentTime + 0.8;
    while (this.bgmNextTime < ahead) {
      const t = this.bgmNextTime;
      // ランダムウォークでスケール上を歩く（休符多め＝静けさ）
      if (Math.random() < 0.55) {
        const stepChoices = [-2, -1, -1, 0, 1, 1, 2];
        this.bgmDegree += stepChoices[(Math.random() * stepChoices.length) | 0];
        if (this.bgmDegree < 0) this.bgmDegree = 0;
        if (this.bgmDegree >= SCALE_SEMITONES.length) this.bgmDegree = SCALE_SEMITONES.length - 1;
        const f = SCALE_BASE * Math.pow(2, SCALE_SEMITONES[this.bgmDegree] / 12);
        this.pluck(t, f, 0.9);
        // たまに装飾音（隣の音を素早く）
        if (Math.random() < 0.18 && this.bgmDegree > 0) {
          const f2 = SCALE_BASE * Math.pow(2, SCALE_SEMITONES[this.bgmDegree - 1] / 12);
          this.pluck(t + 0.16, f2, 0.5);
        }
      }
      this.bgmNextTime += 0.85 + Math.random() * 0.5;
    }
  }

  private startBgm() {
    const ctx = this.ensure();
    const bus = this.bgmBus;
    if (!ctx || !bus || this.bgmTimer !== null) return;
    try {
      bus.gain.cancelScheduledValues(ctx.currentTime);
      bus.gain.setValueAtTime(0.0001, ctx.currentTime);
      bus.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 1.5);
      // 薄いスタジアムの群衆ざわめき（囲碁サッカーの「競技場感」）
      const crowd = this.noiseSource(ctx, true);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 500;
      bp.Q.value = 0.5;
      const cg = ctx.createGain();
      cg.gain.value = 0.016;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.06;
      const lfoG = ctx.createGain();
      lfoG.gain.value = 0.007;
      lfo.connect(lfoG).connect(cg.gain);
      crowd.connect(bp).connect(cg).connect(bus);
      crowd.start();
      lfo.start();
      // 低い持続音（ドローン）
      const drone = ctx.createOscillator();
      drone.type = 'sine';
      drone.frequency.value = 110;
      const dg = ctx.createGain();
      dg.gain.value = 0.02;
      drone.connect(dg).connect(bus);
      drone.start();
      this.bgmNodes = [crowd, lfo, drone];
      this.bgmNextTime = ctx.currentTime + 0.3;
      this.bgmDegree = 4;
      this.bgmTimer = window.setInterval(() => this.scheduleBgm(), 200);
    } catch {
      /* ignore */
    }
  }

  private stopBgm() {
    if (this.bgmTimer !== null) {
      clearInterval(this.bgmTimer);
      this.bgmTimer = null;
    }
    const ctx = this.ctx;
    if (ctx && this.bgmBus) {
      try {
        this.bgmBus.gain.cancelScheduledValues(ctx.currentTime);
        this.bgmBus.gain.setValueAtTime(this.bgmBus.gain.value, ctx.currentTime);
        this.bgmBus.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      } catch {
        /* ignore */
      }
    }
    const nodes = this.bgmNodes;
    this.bgmNodes = [];
    setTimeout(() => {
      for (const n of nodes) {
        try {
          (n as AudioScheduledSourceNode).stop();
        } catch {
          /* ignore */
        }
      }
    }, 700);
  }

  // ---- 画面・設定 ----

  enterGame() {
    this.inGame = true;
    if (this.bgmOn) this.startBgm();
  }

  leaveGame() {
    this.inGame = false;
    this.stopBgm();
  }

  setBgm(on: boolean) {
    this.bgmOn = on;
    localStorage.setItem(LS_BGM, on ? '1' : '0');
    if (on && this.inGame) this.startBgm();
    else this.stopBgm();
  }

  setSe(on: boolean) {
    this.seOn = on;
    localStorage.setItem(LS_SE, on ? '1' : '0');
  }
}

export const sound = new SoundManager();
