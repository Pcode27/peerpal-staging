// Procedural ambient audio engine — no audio files required.
// Uses the Web Audio API to synthesise all sounds from noise and oscillators.

function noiseBuffer(ctx, type) {
  const len = Math.ceil(ctx.sampleRate * 5);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d   = buf.getChannelData(0);
  if (type === 'white') {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } else if (type === 'pink') {
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
      b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
      b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
      d[i]=(b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11;
      b6=w*0.115926;
    }
  } else if (type === 'brown') {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      d[i] = (last + 0.02 * w) / 1.02;
      last = d[i];
      d[i] *= 3.5;
    }
  }
  return buf;
}

function mkNoise(ctx, type) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx, type);
  s.loop = true; s.start();
  return s;
}

function mkOsc(ctx, freq, type = 'sine') {
  const o = ctx.createOscillator();
  o.type = type; o.frequency.value = freq; o.start();
  return o;
}

function mkFilter(ctx, type, freq, Q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = Q;
  return f;
}

function mkGain(ctx, v) {
  const g = ctx.createGain(); g.gain.value = v; return g;
}

class AmbientSound {
  constructor() {
    this._ctx     = null;
    this._master  = null;
    this._nodes   = [];
    this._timers  = [];
    this._type    = null;
  }

  get currentType()  { return this._type; }
  get isActive()     { return this._ctx !== null; }
  get isRunning()    { return this._ctx?.state === 'running'; }

  play(type, vol = 0.7) {
    this._teardown();
    this._type   = type;
    this._ctx    = new (window.AudioContext || window.webkitAudioContext)();
    this._master = mkGain(this._ctx, 0);
    this._master.connect(this._ctx.destination);
    this._master.gain.setTargetAtTime(vol, this._ctx.currentTime, 0.4);
    this._build(type);
  }

  pause() {
    if (this._ctx?.state === 'running') this._ctx.suspend();
  }

  resume() {
    if (this._ctx?.state === 'suspended') this._ctx.resume();
  }

  setVolume(v) {
    if (this._master && this._ctx) {
      this._master.gain.setTargetAtTime(v, this._ctx.currentTime, 0.05);
    }
  }

  stop() {
    if (!this._ctx) return;
    if (this._master) {
      this._master.gain.setTargetAtTime(0, this._ctx.currentTime, 0.2);
    }
    const ctx = this._ctx;
    const nodes = this._nodes;
    this._ctx = null; this._master = null; this._nodes = []; this._type = null;
    this._timers.forEach(t => clearTimeout(t));
    this._timers = [];
    setTimeout(() => {
      nodes.forEach(n => { try { n.stop?.(); n.disconnect?.(); } catch { /* ignore */ } });
      try { ctx.close(); } catch { /* ignore */ }
    }, 700);
  }

  _teardown() {
    this._timers.forEach(t => clearTimeout(t)); this._timers = [];
    this._nodes.forEach(n => { try { n.stop?.(); n.disconnect?.(); } catch { /* ignore */ } });
    this._nodes = [];
    if (this._ctx) { try { this._ctx.close(); } catch { /* ignore */ } }
    this._ctx = null; this._master = null; this._type = null;
  }

  _t(...ns) { ns.forEach(n => this._nodes.push(n)); return ns[ns.length - 1]; }

  _build(type) {
    const ctx = this._ctx;
    const out = this._master;

    switch (type) {
      case 'rain': {
        const src = this._t(mkNoise(ctx, 'pink'));
        const bp  = this._t(mkFilter(ctx, 'bandpass', 1100, 0.35));
        const lp  = this._t(mkFilter(ctx, 'lowpass', 8000));
        src.connect(bp); bp.connect(lp); lp.connect(out);
        break;
      }
      case 'forest': {
        const src = this._t(mkNoise(ctx, 'pink'));
        const bp  = this._t(mkFilter(ctx, 'bandpass', 1800, 0.7));
        const lfo = this._t(mkOsc(ctx, 0.07));
        const lg  = this._t(mkGain(ctx, 360));
        lfo.connect(lg); lg.connect(bp.frequency);
        src.connect(bp); bp.connect(out);
        break;
      }
      case 'ocean': {
        const src = this._t(mkNoise(ctx, 'brown'));
        const lp  = this._t(mkFilter(ctx, 'lowpass', 420));
        const lfo = this._t(mkOsc(ctx, 0.09));
        const lg  = this._t(mkGain(ctx, 270));
        lfo.connect(lg); lg.connect(lp.frequency);
        src.connect(lp); lp.connect(out);
        break;
      }
      case 'white-noise': {
        const src = this._t(mkNoise(ctx, 'white'));
        const lp  = this._t(mkFilter(ctx, 'lowpass', 7000));
        src.connect(lp); lp.connect(out);
        break;
      }
      case 'tibetan-bowls': {
        [432, 528, 648, 864].forEach((freq, i) => {
          const o   = this._t(mkOsc(ctx, freq));
          const g   = this._t(mkGain(ctx, 0.12));
          const lfo = this._t(mkOsc(ctx, 0.20 + i * 0.06));
          const lg  = this._t(mkGain(ctx, 0.08));
          lfo.connect(lg); lg.connect(g.gain);
          o.connect(g); g.connect(out);
        });
        break;
      }
      case 'fireplace': {
        const base = this._t(mkNoise(ctx, 'brown'));
        const blp  = this._t(mkFilter(ctx, 'lowpass', 380));
        const bg   = this._t(mkGain(ctx, 0.55));
        base.connect(blp); blp.connect(bg); bg.connect(out);

        const crk  = this._t(mkNoise(ctx, 'pink'));
        const cbp  = this._t(mkFilter(ctx, 'bandpass', 3600, 2.2));
        const cg   = this._t(mkGain(ctx, 0));
        crk.connect(cbp); cbp.connect(cg); cg.connect(out);

        const burst = () => {
          if (!this._ctx) return;
          const now = this._ctx.currentTime;
          cg.gain.setValueAtTime(0.03 + Math.random() * 0.12, now);
          cg.gain.setTargetAtTime(0, now + 0.01, 0.022);
          const t = setTimeout(burst, (0.07 + Math.random() * 1.1) * 1000);
          this._timers.push(t);
        };
        burst();
        break;
      }
      case 'stream': {
        const src = this._t(mkNoise(ctx, 'pink'));
        const hp  = this._t(mkFilter(ctx, 'highpass', 900));
        const lp  = this._t(mkFilter(ctx, 'lowpass', 14000));
        const gg  = this._t(mkGain(ctx, 1));
        const lfo = this._t(mkOsc(ctx, 0.22));
        const lg  = this._t(mkGain(ctx, 0.14));
        lfo.connect(lg); lg.connect(gg.gain);
        src.connect(hp); hp.connect(lp); lp.connect(gg); gg.connect(out);
        break;
      }
      case 'wind': {
        const src = this._t(mkNoise(ctx, 'pink'));
        const lp  = this._t(mkFilter(ctx, 'lowpass', 620));
        const lfo = this._t(mkOsc(ctx, 0.045));
        const lg  = this._t(mkGain(ctx, 230));
        lfo.connect(lg); lg.connect(lp.frequency);
        src.connect(lp); lp.connect(out);
        break;
      }
      default: break;
    }
  }
}

// Module-level singleton — persists across component unmounts so audio keeps playing during navigation.
let _instance = null;
export function getAmbient() {
  if (!_instance) _instance = new AmbientSound();
  return _instance;
}
