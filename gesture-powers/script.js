/* ==========================================================================
   GESTURE POWERS — script.js
   Reconhecimento de mãos 100% no navegador (MediaPipe Tasks Vision,
   HandLandmarker) + efeitos em Canvas2D + Web Audio API.
   Nenhum dado de câmera sai do dispositivo — tudo roda localmente.
   ========================================================================== */

import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

/* --------------------------------------------------------------------- */
/* 1. REFERÊNCIAS DE DOM                                                  */
/* --------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const gate = $("gate");
const gateStatus = $("gateStatus");
const startBtn = $("startBtn");
const unsupported = $("unsupported");
const unsupportedMsg = $("unsupportedMsg");
const retryBtn = $("retryBtn");

const stage = $("stage");
const video = $("video");
const canvas = $("fx");
const ctx = canvas.getContext("2d");
const flashEl = $("flash");

const powerReadout = $("powerReadout");
const handStatus = $("handStatus");
const handStatusText = $("handStatusText");
const toastEl = $("toast");

const flipBtn = $("flipBtn");
const modeBtn = $("modeBtn");
const photoBtn = $("photoBtn");
const powerSelector = $("powerSelector");

/* --------------------------------------------------------------------- */
/* 2. DEFINIÇÃO DOS PODERES                                               */
/* Cada poder define paleta de cor e "personalidade" das partículas.      */
/* O GESTO define a FORMA do efeito (raio, explosão, esfera, brilho);     */
/* o PODER selecionado define a COR e o comportamento das partículas.     */
/* --------------------------------------------------------------------- */
const POWERS = {
  fire: {
    name: "🔥 FIRE",
    a: "#ff7a3d", b: "#ffb648",
    spread: 0.9, gravity: -0.02, drag: 0.965, flicker: true,
  },
  lightning: {
    name: "⚡ LIGHTNING",
    a: "#7ad7ff", b: "#b58bff",
    spread: 0.3, gravity: 0, drag: 0.9, flicker: true,
  },
  explosion: {
    name: "💥 EXPLOSION",
    a: "#ffb347", b: "#ff5252",
    spread: 1.6, gravity: 0.01, drag: 0.94, flicker: false,
  },
  energy: {
    name: "🌀 ENERGY",
    a: "#7cffd6", b: "#8b6bff",
    spread: 0.5, gravity: 0, drag: 0.985, flicker: false,
  },
  ice: {
    name: "❄️ ICE",
    a: "#bdf1ff", b: "#6fb8ff",
    spread: 0.7, gravity: 0.015, drag: 0.97, flicker: false,
  },
};
const POWER_ORDER = ["fire", "lightning", "explosion", "energy", "ice"];

/* --------------------------------------------------------------------- */
/* 3. ESTADO GLOBAL DA APLICAÇÃO                                          */
/* --------------------------------------------------------------------- */
const state = {
  currentPower: "lightning",
  facingMode: "user",      // "user" = frontal, "environment" = traseira
  powerModeOn: false,
  handDetected: false,
  running: false,

  // landmarks normalizados (0..1) da mão mais confiável do frame atual
  landmarks: null,

  // gesto confirmado (após filtro de estabilidade) neste frame
  activeGesture: "none",

  // contadores para debounce/estabilidade de gesto
  gestureCounts: { open: 0, fist: 0, point: 0, pinch: 0, peace: 0 },
  lastEdgeGesture: "none",     // último gesto "discreto" já dis­parado
  lastTriggerTime: { fist: 0, wave: 0, peace: 0 },

  // histórico de posição do pulso, usado para detectar aceno
  wristHistory: [],

  // posição suavizada usada para desenhar (evita tremedeira)
  smoothPoint: null,
};

let handLandmarker = null;
let particles = [];
let energyBall = null; // {x,y} quando pinça está ativa, com suavização própria
let rafId = null;
let lastVideoTime = -1;

/* --------------------------------------------------------------------- */
/* 4. ÁUDIO — sintetizado via Web Audio API (nenhum arquivo externo)      */
/* --------------------------------------------------------------------- */
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playTone({ freqStart, freqEnd = freqStart, duration = 0.18, type = "sine", gain = 0.18, delay = 0 }) {
  const ac = getAudioCtx();
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  const t0 = ac.currentTime + delay;
  osc.frequency.setValueAtTime(freqStart, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function playNoiseBurst({ duration = 0.25, gain = 0.25, delay = 0, filterFreq = 1200 }) {
  const ac = getAudioCtx();
  const bufferSize = Math.floor(ac.sampleRate * duration);
  const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = filterFreq;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(ac.destination);
  src.start(ac.currentTime + delay);
}

const SFX = {
  lightning: () => { playNoiseBurst({ duration: 0.08, gain: 0.18, filterFreq: 4000 }); playTone({ freqStart: 1600, freqEnd: 300, duration: 0.12, type: "sawtooth", gain: 0.1 }); },
  explosion: () => { playNoiseBurst({ duration: 0.4, gain: 0.32, filterFreq: 900 }); playTone({ freqStart: 180, freqEnd: 40, duration: 0.35, type: "sine", gain: 0.22 }); },
  energy: () => { playTone({ freqStart: 220, freqEnd: 440, duration: 0.3, type: "triangle", gain: 0.09 }); },
  fire: () => { playNoiseBurst({ duration: 0.15, gain: 0.12, filterFreq: 2200 }); },
  ice: () => { playTone({ freqStart: 1200, freqEnd: 1800, duration: 0.14, type: "sine", gain: 0.08 }); },
  switch: () => { playTone({ freqStart: 700, freqEnd: 900, duration: 0.08, type: "square", gain: 0.08 }); playTone({ freqStart: 900, freqEnd: 1200, duration: 0.09, type: "square", gain: 0.08, delay: 0.07 }); },
  photo: () => { playNoiseBurst({ duration: 0.05, gain: 0.2, filterFreq: 6000 }); playTone({ freqStart: 2200, freqEnd: 1400, duration: 0.05, type: "square", gain: 0.06, delay: 0.05 }); },
};

/* --------------------------------------------------------------------- */
/* 5. SISTEMA DE PARTÍCULAS                                               */
/* --------------------------------------------------------------------- */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function spawnParticles(x, y, count, cfg) {
  const power = POWERS[state.currentPower];
  const [ra, ga, ba] = hexToRgb(power.a);
  const [rb, gb, bb] = hexToRgb(power.b);
  for (let i = 0; i < count; i++) {
    const angle = cfg.angle != null
      ? cfg.angle + (Math.random() - 0.5) * cfg.coneWidth
      : Math.random() * Math.PI * 2;
    const speed = (cfg.minSpeed + Math.random() * (cfg.maxSpeed - cfg.minSpeed)) * power.spread;
    const mix = Math.random();
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: cfg.minSize + Math.random() * (cfg.maxSize - cfg.minSize),
      life: 0,
      maxLife: cfg.minLife + Math.random() * (cfg.maxLife - cfg.minLife),
      color: `rgb(${Math.round(ra + (rb - ra) * mix)},${Math.round(ga + (gb - ga) * mix)},${Math.round(ba + (bb - ba) * mix)})`,
      gravity: power.gravity,
      drag: power.drag,
      flicker: power.flicker,
    });
  }
}

function updateAndDrawParticles(dt) {
  ctx.globalCompositeOperation = "lighter";
  particles = particles.filter((p) => p.life < p.maxLife);
  for (const p of particles) {
    p.life += dt;
    p.vy += p.gravity;
    p.vx *= p.drag;
    p.vy *= p.drag;
    p.x += p.vx * dt * 60;
    p.y += p.vy * dt * 60;

    const t = p.life / p.maxLife;
    const alpha = Math.max(0, 1 - t) * (p.flicker ? 0.6 + Math.random() * 0.4 : 1);
    const size = p.size * (1 - t * 0.5);

    ctx.beginPath();
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size);
    grad.addColorStop(0, p.color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.globalAlpha = alpha;
    ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

/* --------------------------------------------------------------------- */
/* 6. EFEITOS ESPECÍFICOS POR GESTO                                       */
/* --------------------------------------------------------------------- */

// ✋ Palma aberta → brilho/energia ao redor da mão (efeito contínuo)
function effectOpenPalm(px, py, handSizePx) {
  const power = POWERS[state.currentPower];
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const r = handSizePx * 1.6;
  const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
  grad.addColorStop(0, power.a + "cc");
  grad.addColorStop(0.5, power.b + "55");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (Math.random() < 0.6) {
    spawnParticles(px, py, 1, { minSpeed: 0.4, maxSpeed: 1.4, minSize: 2, maxSize: 5, minLife: 0.4, maxLife: 0.9 });
  }
}

// ☝️ Indicador → raio saindo da ponta do dedo (efeito contínuo)
function effectLightningBolt(px, py, dirX, dirY) {
  const power = POWERS[state.currentPower];
  const len = 140 + Math.random() * 60;
  const segments = 7;
  let x = px, y = py;
  const nx = -dirY, ny = dirX; // normal para o zig-zag
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = power.a;
  ctx.lineWidth = 3;
  ctx.shadowColor = power.a;
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(x, y);
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const jitter = (Math.random() - 0.5) * 22 * (1 - t);
    x = px + dirX * len * t + nx * jitter;
    y = py + dirY * len * t + ny * jitter;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = power.b;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
  spawnParticles(px, py, 2, { minSpeed: 1, maxSpeed: 3, minSize: 1.5, maxSize: 3.5, minLife: 0.15, maxLife: 0.35, angle: Math.atan2(dirY, dirX), coneWidth: 0.8 });
}

// ✊ Punho fechado → explosão de partículas (efeito discreto/único)
function effectExplosion(px, py) {
  spawnParticles(px, py, 55, { minSpeed: 2, maxSpeed: 8, minSize: 3, maxSize: 7, minLife: 0.4, maxLife: 0.9 });
  shockwaves.push({ x: px, y: py, r: 4, maxR: 160, life: 0, maxLife: 0.5 });
}

// 🤏 Pinça → esfera de energia que acompanha a mão (efeito contínuo)
function effectEnergyBall(px, py) {
  const power = POWERS[state.currentPower];
  const r = 30 + Math.sin(performance.now() / 130) * 4;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.25, power.a);
  grad.addColorStop(1, power.b + "00");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = power.b;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.arc(px, py, r + 6 + Math.sin(performance.now() / 200) * 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  if (Math.random() < 0.5) {
    spawnParticles(px, py, 1, { minSpeed: 0.3, maxSpeed: 1, minSize: 1.5, maxSize: 3, minLife: 0.3, maxLife: 0.6 });
  }
}

// ondas de choque (usadas pela explosão)
let shockwaves = [];
function updateAndDrawShockwaves(dt) {
  const power = POWERS[state.currentPower];
  shockwaves = shockwaves.filter((s) => s.life < s.maxLife);
  for (const s of shockwaves) {
    s.life += dt;
    const t = s.life / s.maxLife;
    s.r = 4 + t * s.maxR;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = power.a;
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.lineWidth = 4 * (1 - t) + 1;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/* --------------------------------------------------------------------- */
/* 7. GEOMETRIA DE MÃO / CLASSIFICAÇÃO DE GESTOS                          */
/* --------------------------------------------------------------------- */
const IDX = {
  WRIST: 0,
  THUMB_MCP: 2, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_TIP: 20,
};

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Um dedo é considerado "esticado" quando a ponta está bem mais longe do
// pulso do que a junta intermediária (pip) — funciona com a mão em
// qualquer rotação, sem precisar saber a orientação exata da câmera.
function isExtended(lm, tipIdx, pipIdx, wrist) {
  return dist(wrist, lm[tipIdx]) > dist(wrist, lm[pipIdx]) * 1.12;
}

function classifyStaticGesture(lm) {
  const wrist = lm[IDX.WRIST];
  const handSize = dist(wrist, lm[IDX.MIDDLE_MCP]) || 0.001;

  const iExt = isExtended(lm, IDX.INDEX_TIP, IDX.INDEX_PIP, wrist);
  const mExt = isExtended(lm, IDX.MIDDLE_TIP, IDX.MIDDLE_PIP, wrist);
  const rExt = isExtended(lm, IDX.RING_TIP, IDX.RING_PIP, wrist);
  const pExt = isExtended(lm, IDX.PINKY_TIP, IDX.PINKY_PIP, wrist);
  const thumbExt = dist(wrist, lm[IDX.THUMB_TIP]) > dist(wrist, lm[IDX.THUMB_MCP]) * 1.15;

  const pinchDist = dist(lm[IDX.THUMB_TIP], lm[IDX.INDEX_TIP]) / handSize;

  // pinça tem prioridade: polegar e indicador bem próximos
  if (pinchDist < 0.45 && !mExt) return "pinch";

  const extendedCount = [iExt, mExt, rExt, pExt].filter(Boolean).length;

  if (extendedCount === 0 && !thumbExt) return "fist";
  if (extendedCount === 4) return "open";
  if (iExt && !mExt && !rExt && !pExt) return "point";
  if (iExt && mExt && !rExt && !pExt) return "peace"; // ✌️ para foto
  return "none";
}

// Detecta aceno: várias mudanças de direção do pulso no eixo X num
// intervalo curto, com amplitude mínima.
function detectWave(wristX, now) {
  state.wristHistory.push({ x: wristX, t: now });
  const windowMs = 900;
  state.wristHistory = state.wristHistory.filter((p) => now - p.t < windowMs);
  if (state.wristHistory.length < 6) return false;

  let dirChanges = 0;
  let lastDir = 0;
  let minX = Infinity, maxX = -Infinity;
  for (let i = 1; i < state.wristHistory.length; i++) {
    const d = state.wristHistory[i].x - state.wristHistory[i - 1].x;
    minX = Math.min(minX, state.wristHistory[i].x);
    maxX = Math.max(maxX, state.wristHistory[i].x);
    if (Math.abs(d) < 0.004) continue;
    const dir = d > 0 ? 1 : -1;
    if (lastDir !== 0 && dir !== lastDir) dirChanges++;
    lastDir = dir;
  }
  const amplitude = maxX - minX;
  return dirChanges >= 3 && amplitude > 0.12;
}

/* --------------------------------------------------------------------- */
/* 8. LOOP DE DETECÇÃO (MediaPipe roda a cada frame de vídeo)             */
/* --------------------------------------------------------------------- */
function predictLoop() {
  if (!state.running) return;

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = handLandmarker.detectForVideo(video, performance.now());

    if (result.landmarks && result.landmarks.length > 0) {
      state.landmarks = result.landmarks[0];
      state.handDetected = true;
    } else {
      state.landmarks = null;
      state.handDetected = false;
    }
    updateHandStatusUI();
    processGestures();
  }

  rafId = requestAnimationFrame(predictLoop);
}

function updateHandStatusUI() {
  handStatus.classList.toggle("hand-status--on", state.handDetected);
  handStatusText.textContent = state.handDetected ? "HAND: DETECTED" : "HAND: NOT DETECTED";
}

/* --------------------------------------------------------------------- */
/* 9. MAPEAMENTO GESTO → AÇÃO                                             */
/* --------------------------------------------------------------------- */
const HOLD_FRAMES_NEEDED = 3;     // frames seguidos para confirmar gesto estático
const EDGE_COOLDOWN_MS = 700;     // intervalo mínimo entre disparos de gestos discretos

function processGestures() {
  if (!state.landmarks) {
    state.activeGesture = "none";
    Object.keys(state.gestureCounts).forEach((k) => (state.gestureCounts[k] = 0));
    return;
  }

  const lm = state.landmarks;
  const now = performance.now();
  const wrist = lm[IDX.WRIST];

  // aceno é avaliado independentemente do gesto estático
  if (detectWave(wrist.x, now)) {
    if (now - state.lastTriggerTime.wave > 1200) {
      state.lastTriggerTime.wave = now;
      state.wristHistory = [];
      cyclePower();
      showToast("👋 PODER TROCADO");
    }
  }

  const gesture = classifyStaticGesture(lm);

  // debounce: exige N frames consecutivos do mesmo gesto antes de confirmar
  Object.keys(state.gestureCounts).forEach((k) => {
    state.gestureCounts[k] = k === gesture ? state.gestureCounts[k] + 1 : 0;
  });
  const confirmed = state.gestureCounts[gesture] >= HOLD_FRAMES_NEEDED ? gesture : "none";
  state.activeGesture = confirmed;

  // --- gestos contínuos (renderizados a cada frame enquanto ativos) ---
  if (confirmed === "open") {
    const [cx, cy] = handCenterPx(lm);
    const handSizePx = dist(lm[IDX.WRIST], lm[IDX.MIDDLE_MCP]) * canvas.width * 0.5;
    effectOpenPalm(cx, cy, handSizePx);
    if (state.lastEdgeGesture !== "open") showToast("✋ ENERGIA ATIVADA");
  } else if (confirmed === "point") {
    const tip = toPx(lm[IDX.INDEX_TIP]);
    const pip = toPx(lm[IDX.INDEX_PIP]);
    let dx = tip.x - pip.x, dy = tip.y - pip.y;
    const mag = Math.hypot(dx, dy) || 1;
    dx /= mag; dy /= mag;
    effectLightningBolt(tip.x, tip.y, dx, dy);
    if (Math.random() < 0.05) SFX.lightning();
    if (state.lastEdgeGesture !== "point") { showToast("☝️ LIGHTNING ACTIVATED"); SFX.lightning(); }
  } else if (confirmed === "pinch") {
    const t1 = toPx(lm[IDX.THUMB_TIP]);
    const t2 = toPx(lm[IDX.INDEX_TIP]);
    const mx = (t1.x + t2.x) / 2, my = (t1.y + t2.y) / 2;
    energyBall = energyBall
      ? { x: energyBall.x + (mx - energyBall.x) * 0.35, y: energyBall.y + (my - energyBall.y) * 0.35 }
      : { x: mx, y: my };
    effectEnergyBall(energyBall.x, energyBall.y);
    if (state.lastEdgeGesture !== "pinch") { showToast("🤏 ENERGY CONTROL"); SFX.energy(); }
  } else {
    energyBall = null;
  }

  // --- gestos discretos (disparo único na borda de transição) ---
  if (confirmed === "fist" && now - state.lastTriggerTime.fist > EDGE_COOLDOWN_MS) {
    state.lastTriggerTime.fist = now;
    const [cx, cy] = handCenterPx(lm);
    effectExplosion(cx, cy);
    showToast("✊ EXPLOSION ACTIVATED");
    SFX.explosion();
    if (navigator.vibrate) navigator.vibrate(40);
  }

  if (confirmed === "peace" && now - state.lastTriggerTime.peace > 1500) {
    state.lastTriggerTime.peace = now;
    takePhoto();
  }

  if (confirmed !== "none") state.lastEdgeGesture = confirmed;
}

// O <video> é espelhado via CSS apenas na câmera frontal (transform: scaleX(-1)),
// então as coordenadas dos efeitos precisam espelhar o eixo X só nesse caso,
// para o poder nascer exatamente onde a ponta do dedo aparece na tela.
function toPx(pt) {
  const x = state.facingMode === "user" ? 1 - pt.x : pt.x;
  return { x: x * canvas.width, y: pt.y * canvas.height };
}
function handCenterPx(lm) {
  const midX = (lm[IDX.WRIST].x + lm[IDX.MIDDLE_MCP].x) / 2;
  const midY = (lm[IDX.WRIST].y + lm[IDX.MIDDLE_MCP].y) / 2;
  const cx = state.facingMode === "user" ? (1 - midX) * canvas.width : midX * canvas.width;
  const cy = midY * canvas.height;
  return [cx, cy];
}

/* --------------------------------------------------------------------- */
/* 10. TROCA DE PODER                                                     */
/* --------------------------------------------------------------------- */
function setPower(key) {
  state.currentPower = key;
  const power = POWERS[key];
  powerReadout.textContent = power.name;
  document.body.style.setProperty("--power-a", power.a);
  document.body.style.setProperty("--power-b", power.b);
  [...powerSelector.children].forEach((btn) => {
    const active = btn.dataset.power === key;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
}
function cyclePower() {
  const i = POWER_ORDER.indexOf(state.currentPower);
  setPower(POWER_ORDER[(i + 1) % POWER_ORDER.length]);
  SFX.switch();
}
powerSelector.addEventListener("click", (e) => {
  const btn = e.target.closest(".power-btn");
  if (!btn) return;
  setPower(btn.dataset.power);
  SFX.switch();
});

/* --------------------------------------------------------------------- */
/* 11. TOAST DE FEEDBACK                                                  */
/* --------------------------------------------------------------------- */
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 1100);
}

/* --------------------------------------------------------------------- */
/* 12. RENDER LOOP (desenha o canvas todo frame, independente da detecção)*/
/* --------------------------------------------------------------------- */
let lastFrameTime = performance.now();
function renderLoop() {
  if (!state.running) return;
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  updateAndDrawShockwaves(dt);
  updateAndDrawParticles(dt);

  requestAnimationFrame(renderLoop);
}

/* --------------------------------------------------------------------- */
/* 13. CÂMERA                                                             */
/* --------------------------------------------------------------------- */
let currentStream = null;

async function startCamera(facingMode) {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
  }
  const constraints = {
    audio: false,
    video: {
      facingMode,
      width: { ideal: 720 },   // resolução reduzida para manter performance em celular
      height: { ideal: 960 },
    },
  };
  currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = currentStream;
  video.classList.toggle("is-back", facingMode === "environment");
  await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve();
  });
  await video.play();
  resizeCanvas();
}

function resizeCanvas() {
  canvas.width = video.videoWidth || window.innerWidth;
  canvas.height = video.videoHeight || window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);

flipBtn.addEventListener("click", async () => {
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  try {
    await startCamera(state.facingMode);
  } catch (err) {
    showToast("Câmera indisponível");
  }
});

/* --------------------------------------------------------------------- */
/* 14. MODOS: POWER MODE / captura de FOTO                                */
/* --------------------------------------------------------------------- */
modeBtn.addEventListener("click", () => {
  state.powerModeOn = !state.powerModeOn;
  document.body.classList.toggle("power-mode", state.powerModeOn);
  modeBtn.classList.toggle("is-on", state.powerModeOn);
});

photoBtn.addEventListener("click", takePhoto);

function takePhoto() {
  SFX.photo();
  flashEl.classList.remove("is-active");
  void flashEl.offsetWidth; // reinicia animação
  flashEl.classList.add("is-active");

  // Composição: espelha o vídeo (se frontal) + desenha o canvas de efeitos por cima
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext("2d");

  octx.save();
  if (state.facingMode === "user") {
    octx.translate(out.width, 0);
    octx.scale(-1, 1);
  }
  octx.drawImage(video, 0, 0, out.width, out.height);
  octx.restore();

  octx.drawImage(canvas, 0, 0);

  out.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gesture-powers-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");

  showToast("📸 FOTO CAPTURADA");
}

/* --------------------------------------------------------------------- */
/* 15. INICIALIZAÇÃO — HandLandmarker + câmera                            */
/* --------------------------------------------------------------------- */
async function initHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 1,               // uma mão só = melhor performance em celular
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

function checkSupport() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return "Este navegador não suporta acesso à câmera (getUserMedia). Tente Chrome ou Safari atualizados.";
  }
  if (!("WebAssembly" in window)) {
    return "Este navegador não suporta WebAssembly, necessário para o reconhecimento de mãos.";
  }
  return null;
}

async function boot() {
  const unsupportedReason = checkSupport();
  if (unsupportedReason) {
    showUnsupported(unsupportedReason);
    return;
  }

  gateStatus.textContent = "Carregando modelo de reconhecimento de mãos…";
  try {
    await initHandLandmarker();
  } catch (err) {
    console.error(err);
    showUnsupported("Não foi possível carregar o modelo de rastreamento de mãos. Verifique sua conexão com a internet e tente novamente.");
    return;
  }

  gateStatus.textContent = "Solicitando acesso à câmera…";
  try {
    await startCamera(state.facingMode);
  } catch (err) {
    console.error(err);
    showUnsupported("Acesso à câmera negado ou indisponível. Permita o uso da câmera nas configurações do navegador e tente novamente.");
    return;
  }

  gate.classList.add("gate--hidden");
  stage.classList.remove("stage--hidden");
  setPower(state.currentPower);

  state.running = true;
  lastFrameTime = performance.now();
  requestAnimationFrame(predictLoop);
  requestAnimationFrame(renderLoop);
}

function showUnsupported(msg) {
  gate.classList.add("gate--hidden");
  unsupported.classList.remove("gate--hidden");
  unsupportedMsg.textContent = msg;
}

startBtn.addEventListener("click", boot);
retryBtn.addEventListener("click", () => {
  unsupported.classList.add("gate--hidden");
  gate.classList.remove("gate--hidden");
  gateStatus.textContent = "";
});

// Pausa o loop de detecção quando a aba fica em segundo plano, para
// economizar bateria/CPU no celular.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    state.running = false;
    if (rafId) cancelAnimationFrame(rafId);
  } else if (stage && !stage.classList.contains("stage--hidden") && handLandmarker) {
    state.running = true;
    lastFrameTime = performance.now();
    requestAnimationFrame(predictLoop);
    requestAnimationFrame(renderLoop);
  }
});
  createImpact(x, y, colorSet) {
    this.shake = 15;
    for (let i = 0; i < 30; i++) {
      const ang = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 8;
      this.addParticle(new Particle(x, y, colorSet[0], Math.cos(ang)*speed, Math.sin(ang)*speed, 0.8, 4 + Math.random()*4, 'spark'));
    }
  }

  update(dt) {
    if (this.shake > 0) this.shake *= 0.9;
    
    // Processar Partículas
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.update(dt);
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    // Processar Projéteis
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.x += pr.vx * dt * 500;
      pr.y += pr.vy * dt * 500;
      pr.life -= dt;
      
      // Trail do projétil
      this.addParticle(new Particle(pr.x, pr.y, POWER_DATA[pr.type].colors[0], (Math.random()-0.5)*2, (Math.random()-0.5)*2, 0.5, 10, 'trail'));

      if (pr.life <= 0) {
        this.createImpact(pr.x, pr.y, POWER_DATA[pr.type].colors);
        this.projectiles.splice(i, 1);
      }
    }

    // Gerar efeitos na mão
    if (state.handPresent) {
      this.emitHandEffects();
    }
  }

  emitHandEffects() {
    const colors = POWER_DATA[state.power].colors;
    const x = state.handPos.x * this.canvas.width;
    const y = state.handPos.y * this.canvas.height;
    const intensity = state.charge * 1.5 + 1;

    switch(state.power) {
      case 'fire':
        for(let i=0; i<3 * intensity; i++) {
          this.addParticle(new Particle(x + (Math.random()-0.5)*40, y, colors[Math.floor(Math.random()*2)], (Math.random()-0.5)*2, -2 - Math.random()*3, 0.6, 15 + Math.random()*20, 'glow'));
        }
        break;
      case 'lightning':
        if(Math.random() > 0.7) {
          this.addParticle(new Particle(x, y, colors[2], (Math.random()-0.5)*15, (Math.random()-0.5)*15, 0.2, 2, 'spark'));
        }
        break;
      case 'energy':
        const ang = performance.now() * 0.01;
        const rx = Math.cos(ang) * 40;
        const ry = Math.sin(ang) * 40;
        this.addParticle(new Particle(x + rx, y + ry, colors[0], 0, 0, 0.4, 8, 'trail'));
        this.addParticle(new Particle(x - rx, y - ry, colors[1], 0, 0, 0.4, 8, 'trail'));
        break;
      case 'ice':
        if(Math.random() > 0.8) {
           this.addParticle(new Particle(x + (Math.random()-0.5)*60, y + (Math.random()-0.5)*60, colors[0], 0, 1, 1.2, 5, 'spark'));
        }
        break;
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    if (this.shake > 0) {
      ctx.save();
      ctx.translate((Math.random()-0.5)*this.shake, (Math.random()-0.5)*this.shake);
    }

    ctx.globalCompositeOperation = 'lighter';

    this.particles.forEach(p => {
      const ratio = p.life / p.maxLife;
      ctx.beginPath();
      
      if (p.type === 'glow') {
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
        grad.addColorStop(0, p.color);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.globalAlpha = ratio * 0.6;
        ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
      } else {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = ratio;
        ctx.arc(p.x, p.y, p.size * ratio, 0, Math.PI*2);
      }
      ctx.fill();
    });

    // HUD de Carga na mão
    if (state.handPresent && state.charge > 0.1) {
      const x = state.handPos.x * this.canvas.width;
      const y = state.handPos.y * this.canvas.height;
      ctx.strokeStyle = POWER_DATA[state.power].colors[0];
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 50, -Math.PI/2, (-Math.PI/2) + (Math.PI*2*state.charge));
      ctx.stroke();
    }

    if (this.shake > 0) ctx.restore();
    ctx.globalAlpha = 1;
  }

  loop() {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    this.update(dt);
    this.draw();
    requestAnimationFrame(() => this.loop());
  }
}

// --- ÁUDIO SINTETIZADO ---
const SoundEngine = {
  init() {
    if (state.audioCtx) return;
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  },
  play(type) {
    this.init();
    const ctx = state.audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'launch') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
    } else if (type === 'impact') {
      const noise = ctx.createBufferSource();
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noise.buffer = buffer;
      const nGain = ctx.createGain();
      noise.connect(nGain);
      nGain.connect(ctx.destination);
      nGain.gain.setValueAtTime(0.5, ctx.currentTime);
      nGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      noise.start();
      return;
    }
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  }
};

// --- RECONHECIMENTO E GESTOS ---

let handLandmarker;
const video = document.getElementById('video');
const engine = new PowerEngine();

async function initMediaPipe() {
  const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm");
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: 1
  });
  document.getElementById('startBtn').disabled = false;
  document.getElementById('gateStatus').innerText = "Laboratório pronto. Ative a câmera.";
}

function detectGesture(landmarks) {
  // Landmarks chave: 4 (polegar), 8 (indicador), 12 (médio), 16 (anelar), 20 (mínimo), 0 (pulso), 9 (palma)
  const getDist = (a, b) => Math.hypot(landmarks[a].x - landmarks[b].x, landmarks[a].y - landmarks[b].y);
  
  const isIndexUp = landmarks[8].y < landmarks[6].y && landmarks[12].y > landmarks[10].y;
  const isFist = getDist(8, 0) < 0.2 && getDist(12, 0) < 0.2;
  const isPalm = landmarks[8].y < landmarks[6].y && landmarks[12].y < landmarks[10].y && landmarks[20].y < landmarks[18].y;
  const isPinch = getDist(4, 8) < 0.04;

  if (isFist) return 'fist';
  if (isPinch) return 'pinch';
  if (isIndexUp) return 'index';
  if (isPalm) return 'palm';
  return 'none';
}

async function processVideo() {
  if (video.paused || video.ended) return;

  if (handLandmarker) {
    const startTimeMs = performance.now();
    const results = handLandmarker.detectForVideo(video, startTimeMs);
    
    if (results.landmarks && results.landmarks.length > 0) {
      const h = results.landmarks[0];
      state.handPresent = true;
      
      // Suavização da posição (Lerp)
      const targetX = state.cameraFacing === 'user' ? 1 - h[9].x : h[9].x;
      state.handPos.x += (targetX - state.handPos.x) * CONFIG.smoothing;
      state.handPos.y += (h[9].y - state.handPos.y) * CONFIG.smoothing;
      
      // Velocidade
      state.handPos.vx = state.handPos.x - state.lastHandPos.x;
      state.handPos.vy = state.handPos.y - state.lastHandPos.y;
      state.lastHandPos = { x: state.handPos.x, y: state.handPos.y };

      const gesture = detectGesture(h);
      handleGestureLogic(gesture);
      
      document.getElementById('handStatus').className = "hand-status hand-status--on";
      document.getElementById('handStatusText').innerText = "HAND: TRACKING";
    } else {
      state.handPresent = false;
      state.charge = 0;
      document.getElementById('handStatus').className = "hand-status hand-status--off";
      document.getElementById('handStatusText').innerText = "HAND: NOT DETECTED";
    }
  }
  requestAnimationFrame(processVideo);
}

function handleGestureLogic(gesture) {
  const isMatching = (state.power === 'fire' && gesture === 'palm') ||
                    (state.power === 'lightning' && gesture === 'index') ||
                    (state.power === 'explosion' && gesture === 'fist') ||
                    (state.power === 'energy' && gesture === 'pinch') ||
                    (state.power === 'ice' && gesture === 'palm');

  if (isMatching) {
    state.charge = Math.min(1, state.charge + 0.02);
    // Disparo por velocidade
    const speed = Math.hypot(state.handPos.vx, state.handPos.vy) * 100;
    if (speed > CONFIG.launchThreshold && state.charge > 0.3) {
      launchPower();
    }
  } else {
    state.charge = Math.max(0, state.charge - 0.05);
  }
}

function launchPower() {
  const vx = state.handPos.vx * 15;
  const vy = state.handPos.vy * 15;
  const x = state.handPos.x * engine.canvas.width;
  const y = state.handPos.y * engine.canvas.height;
  
  engine.projectiles.push(new Projectile(x, y, vx, vy, state.power));
  SoundEngine.play('launch');
  state.charge = 0;
  
  showToast(`${POWER_DATA[state.power].label} RELEASED!`);
}

// --- INTERFACE E CONTROLES ---

function showToast(txt) {
  const t = document.getElementById('toast');
  t.innerText = txt;
  t.classList.add('is-visible');
  setTimeout(() => t.classList.remove('is-visible'), 2000);
}

document.querySelectorAll('.power-btn').forEach(btn => {
  btn.onclick = () => {
    state.power = btn.dataset.power;
    document.querySelector('.power-btn.is-active').classList.remove('is-active');
    btn.classList.add('is-active');
    document.getElementById('powerReadout').innerText = `${POWER_DATA[state.power].emoji} ${POWER_DATA[state.power].label}`;
    document.body.style.setProperty('--power-a', POWER_DATA[state.power].colors[0]);
    state.charge = 0;
  };
});

document.getElementById('startBtn').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.cameraFacing, width: 1280, height: 720 } });
    video.srcObject = stream;
    video.onloadedmetadata = () => {
      video.play();
      document.getElementById('gate').classList.add('gate--hidden');
      document.getElementById('stage').classList.remove('stage--hidden');
      SoundEngine.init();
      processVideo();
    };
  } catch (e) {
    alert("Erro ao acessar câmera: " + e.message);
  }
};

document.getElementById('modeBtn').onclick = () => {
  state.powerMode = !state.powerMode;
  document.body.classList.toggle('power-mode', state.powerMode);
  showToast(state.powerMode ? "POWER MODE: MAX" : "POWER MODE: NORMAL");
};

document.getElementById('photoBtn').onclick = () => {
  const flash = document.getElementById('flash');
  flash.classList.add('is-active');
  setTimeout(() => flash.classList.remove('is-active'), 400);
  SoundEngine.play('impact');
  // Aqui você pode adicionar a lógica de capturar o canvas + vídeo se desejar
};

document.getElementById('flipBtn').onclick = async () => {
  state.cameraFacing = state.cameraFacing === 'user' ? 'environment' : 'user';
  video.classList.toggle('is-back', state.cameraFacing === 'environment');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.cameraFacing } });
  video.srcObject = stream;
};

// Iniciar app
initMediaPipe();let handLandmarker = null;
let particles = [];
let energyBall = null; // {x,y} quando pinça está ativa, com suavização própria
let rafId = null;
let lastVideoTime = -1;

/* --------------------------------------------------------------------- */
/* 4. ÁUDIO — sintetizado via Web Audio API (nenhum arquivo externo)      */
/* --------------------------------------------------------------------- */
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playTone({ freqStart, freqEnd = freqStart, duration = 0.18, type = "sine", gain = 0.18, delay = 0 }) {
  const ac = getAudioCtx();
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  const t0 = ac.currentTime + delay;
  osc.frequency.setValueAtTime(freqStart, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function playNoiseBurst({ duration = 0.25, gain = 0.25, delay = 0, filterFreq = 1200 }) {
  const ac = getAudioCtx();
  const bufferSize = Math.floor(ac.sampleRate * duration);
  const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = filterFreq;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(ac.destination);
  src.start(ac.currentTime + delay);
}

const SFX = {
  lightning: () => { playNoiseBurst({ duration: 0.08, gain: 0.18, filterFreq: 4000 }); playTone({ freqStart: 1600, freqEnd: 300, duration: 0.12, type: "sawtooth", gain: 0.1 }); },
  explosion: () => { playNoiseBurst({ duration: 0.4, gain: 0.32, filterFreq: 900 }); playTone({ freqStart: 180, freqEnd: 40, duration: 0.35, type: "sine", gain: 0.22 }); },
  energy: () => { playTone({ freqStart: 220, freqEnd: 440, duration: 0.3, type: "triangle", gain: 0.09 }); },
  fire: () => { playNoiseBurst({ duration: 0.15, gain: 0.12, filterFreq: 2200 }); },
  ice: () => { playTone({ freqStart: 1200, freqEnd: 1800, duration: 0.14, type: "sine", gain: 0.08 }); },
  switch: () => { playTone({ freqStart: 700, freqEnd: 900, duration: 0.08, type: "square", gain: 0.08 }); playTone({ freqStart: 900, freqEnd: 1200, duration: 0.09, type: "square", gain: 0.08, delay: 0.07 }); },
  photo: () => { playNoiseBurst({ duration: 0.05, gain: 0.2, filterFreq: 6000 }); playTone({ freqStart: 2200, freqEnd: 1400, duration: 0.05, type: "square", gain: 0.06, delay: 0.05 }); },
};

/* --------------------------------------------------------------------- */
/* 5. SISTEMA DE PARTÍCULAS                                               */
/* --------------------------------------------------------------------- */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function spawnParticles(x, y, count, cfg) {
  const power = POWERS[state.currentPower];
  const [ra, ga, ba] = hexToRgb(power.a);
  const [rb, gb, bb] = hexToRgb(power.b);
  for (let i = 0; i < count; i++) {
    const angle = cfg.angle != null
      ? cfg.angle + (Math.random() - 0.5) * cfg.coneWidth
      : Math.random() * Math.PI * 2;
    const speed = (cfg.minSpeed + Math.random() * (cfg.maxSpeed - cfg.minSpeed)) * power.spread;
    const mix = Math.random();
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: cfg.minSize + Math.random() * (cfg.maxSize - cfg.minSize),
      life: 0,
      maxLife: cfg.minLife + Math.random() * (cfg.maxLife - cfg.minLife),
      color: `rgb(${Math.round(ra + (rb - ra) * mix)},${Math.round(ga + (gb - ga) * mix)},${Math.round(ba + (bb - ba) * mix)})`,
      gravity: power.gravity,
      drag: power.drag,
      flicker: power.flicker,
    });
  }
}

function updateAndDrawParticles(dt) {
  ctx.globalCompositeOperation = "lighter";
  particles = particles.filter((p) => p.life < p.maxLife);
  for (const p of particles) {
    p.life += dt;
    p.vy += p.gravity;
    p.vx *= p.drag;
    p.vy *= p.drag;
    p.x += p.vx * dt * 60;
    p.y += p.vy * dt * 60;

    const t = p.life / p.maxLife;
    const alpha = Math.max(0, 1 - t) * (p.flicker ? 0.6 + Math.random() * 0.4 : 1);
    const size = p.size * (1 - t * 0.5);

    ctx.beginPath();
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size);
    grad.addColorStop(0, p.color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.globalAlpha = alpha;
    ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

/* --------------------------------------------------------------------- */
/* 6. EFEITOS ESPECÍFICOS POR GESTO                                       */
/* --------------------------------------------------------------------- */

// ✋ Palma aberta → brilho/energia ao redor da mão (efeito contínuo)
function effectOpenPalm(px, py, handSizePx) {
  const power = POWERS[state.currentPower];
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const r = handSizePx * 1.6;
  const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
  grad.addColorStop(0, power.a + "cc");
  grad.addColorStop(0.5, power.b + "55");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (Math.random() < 0.6) {
    spawnParticles(px, py, 1, { minSpeed: 0.4, maxSpeed: 1.4, minSize: 2, maxSize: 5, minLife: 0.4, maxLife: 0.9 });
  }
}

// ☝️ Indicador → raio saindo da ponta do dedo (efeito contínuo)
function effectLightningBolt(px, py, dirX, dirY) {
  const power = POWERS[state.currentPower];
  const len = 140 + Math.random() * 60;
  const segments = 7;
  let x = px, y = py;
  const nx = -dirY, ny = dirX; // normal para o zig-zag
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = power.a;
  ctx.lineWidth = 3;
  ctx.shadowColor = power.a;
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(x, y);
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const jitter = (Math.random() - 0.5) * 22 * (1 - t);
    x = px + dirX * len * t + nx * jitter;
    y = py + dirY * len * t + ny * jitter;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = power.b;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
  spawnParticles(px, py, 2, { minSpeed: 1, maxSpeed: 3, minSize: 1.5, maxSize: 3.5, minLife: 0.15, maxLife: 0.35, angle: Math.atan2(dirY, dirX), coneWidth: 0.8 });
}

// ✊ Punho fechado → explosão de partículas (efeito discreto/único)
function effectExplosion(px, py) {
  spawnParticles(px, py, 55, { minSpeed: 2, maxSpeed: 8, minSize: 3, maxSize: 7, minLife: 0.4, maxLife: 0.9 });
  shockwaves.push({ x: px, y: py, r: 4, maxR: 160, life: 0, maxLife: 0.5 });
}

// 🤏 Pinça → esfera de energia que acompanha a mão (efeito contínuo)
function effectEnergyBall(px, py) {
  const power = POWERS[state.currentPower];
  const r = 30 + Math.sin(performance.now() / 130) * 4;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.25, power.a);
  grad.addColorStop(1, power.b + "00");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = power.b;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.arc(px, py, r + 6 + Math.sin(performance.now() / 200) * 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  if (Math.random() < 0.5) {
    spawnParticles(px, py, 1, { minSpeed: 0.3, maxSpeed: 1, minSize: 1.5, maxSize: 3, minLife: 0.3, maxLife: 0.6 });
  }
}

// ondas de choque (usadas pela explosão)
let shockwaves = [];
function updateAndDrawShockwaves(dt) {
  const power = POWERS[state.currentPower];
  shockwaves = shockwaves.filter((s) => s.life < s.maxLife);
  for (const s of shockwaves) {
    s.life += dt;
    const t = s.life / s.maxLife;
    s.r = 4 + t * s.maxR;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = power.a;
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.lineWidth = 4 * (1 - t) + 1;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/* --------------------------------------------------------------------- */
/* 7. GEOMETRIA DE MÃO / CLASSIFICAÇÃO DE GESTOS                          */
/* --------------------------------------------------------------------- */
const IDX = {
  WRIST: 0,
  THUMB_MCP: 2, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_TIP: 20,
};

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Um dedo é considerado "esticado" quando a ponta está bem mais longe do
// pulso do que a junta intermediária (pip) — funciona com a mão em
// qualquer rotação, sem precisar saber a orientação exata da câmera.
function isExtended(lm, tipIdx, pipIdx, wrist) {
  return dist(wrist, lm[tipIdx]) > dist(wrist, lm[pipIdx]) * 1.12;
}

function classifyStaticGesture(lm) {
  const wrist = lm[IDX.WRIST];
  const handSize = dist(wrist, lm[IDX.MIDDLE_MCP]) || 0.001;

  const iExt = isExtended(lm, IDX.INDEX_TIP, IDX.INDEX_PIP, wrist);
  const mExt = isExtended(lm, IDX.MIDDLE_TIP, IDX.MIDDLE_PIP, wrist);
  const rExt = isExtended(lm, IDX.RING_TIP, IDX.RING_PIP, wrist);
  const pExt = isExtended(lm, IDX.PINKY_TIP, IDX.PINKY_PIP, wrist);
  const thumbExt = dist(wrist, lm[IDX.THUMB_TIP]) > dist(wrist, lm[IDX.THUMB_MCP]) * 1.15;

  const pinchDist = dist(lm[IDX.THUMB_TIP], lm[IDX.INDEX_TIP]) / handSize;

  // pinça tem prioridade: polegar e indicador bem próximos
  if (pinchDist < 0.45 && !mExt) return "pinch";

  const extendedCount = [iExt, mExt, rExt, pExt].filter(Boolean).length;

  if (extendedCount === 0 && !thumbExt) return "fist";
  if (extendedCount === 4) return "open";
  if (iExt && !mExt && !rExt && !pExt) return "point";
  if (iExt && mExt && !rExt && !pExt) return "peace"; // ✌️ para foto
  return "none";
}

// Detecta aceno: várias mudanças de direção do pulso no eixo X num
// intervalo curto, com amplitude mínima.
function detectWave(wristX, now) {
  state.wristHistory.push({ x: wristX, t: now });
  const windowMs = 900;
  state.wristHistory = state.wristHistory.filter((p) => now - p.t < windowMs);
  if (state.wristHistory.length < 6) return false;

  let dirChanges = 0;
  let lastDir = 0;
  let minX = Infinity, maxX = -Infinity;
  for (let i = 1; i < state.wristHistory.length; i++) {
    const d = state.wristHistory[i].x - state.wristHistory[i - 1].x;
    minX = Math.min(minX, state.wristHistory[i].x);
    maxX = Math.max(maxX, state.wristHistory[i].x);
    if (Math.abs(d) < 0.004) continue;
    const dir = d > 0 ? 1 : -1;
    if (lastDir !== 0 && dir !== lastDir) dirChanges++;
    lastDir = dir;
  }
  const amplitude = maxX - minX;
  return dirChanges >= 3 && amplitude > 0.12;
}

/* --------------------------------------------------------------------- */
/* 8. LOOP DE DETECÇÃO (MediaPipe roda a cada frame de vídeo)             */
/* --------------------------------------------------------------------- */
function predictLoop() {
  if (!state.running) return;

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = handLandmarker.detectForVideo(video, performance.now());

    if (result.landmarks && result.landmarks.length > 0) {
      state.landmarks = result.landmarks[0];
      state.handDetected = true;
    } else {
      state.landmarks = null;
      state.handDetected = false;
    }
    updateHandStatusUI();
    processGestures();
  }

  rafId = requestAnimationFrame(predictLoop);
}

function updateHandStatusUI() {
  handStatus.classList.toggle("hand-status--on", state.handDetected);
  handStatusText.textContent = state.handDetected ? "HAND: DETECTED" : "HAND: NOT DETECTED";
}

/* --------------------------------------------------------------------- */
/* 9. MAPEAMENTO GESTO → AÇÃO                                             */
/* --------------------------------------------------------------------- */
const HOLD_FRAMES_NEEDED = 3;     // frames seguidos para confirmar gesto estático
const EDGE_COOLDOWN_MS = 700;     // intervalo mínimo entre disparos de gestos discretos

function processGestures() {
  if (!state.landmarks) {
    state.activeGesture = "none";
    Object.keys(state.gestureCounts).forEach((k) => (state.gestureCounts[k] = 0));
    return;
  }

  const lm = state.landmarks;
  const now = performance.now();
  const wrist = lm[IDX.WRIST];

  // aceno é avaliado independentemente do gesto estático
  if (detectWave(wrist.x, now)) {
    if (now - state.lastTriggerTime.wave > 1200) {
      state.lastTriggerTime.wave = now;
      state.wristHistory = [];
      cyclePower();
      showToast("👋 PODER TROCADO");
    }
  }

  const gesture = classifyStaticGesture(lm);

  // debounce: exige N frames consecutivos do mesmo gesto antes de confirmar
  Object.keys(state.gestureCounts).forEach((k) => {
    state.gestureCounts[k] = k === gesture ? state.gestureCounts[k] + 1 : 0;
  });
  const confirmed = state.gestureCounts[gesture] >= HOLD_FRAMES_NEEDED ? gesture : "none";
  state.activeGesture = confirmed;

  // --- gestos contínuos (renderizados a cada frame enquanto ativos) ---
  if (confirmed === "open") {
    const [cx, cy] = handCenterPx(lm);
    const handSizePx = dist(lm[IDX.WRIST], lm[IDX.MIDDLE_MCP]) * canvas.width * 0.5;
    effectOpenPalm(cx, cy, handSizePx);
    if (state.lastEdgeGesture !== "open") showToast("✋ ENERGIA ATIVADA");
  } else if (confirmed === "point") {
    const tip = toPx(lm[IDX.INDEX_TIP]);
    const pip = toPx(lm[IDX.INDEX_PIP]);
    let dx = tip.x - pip.x, dy = tip.y - pip.y;
    const mag = Math.hypot(dx, dy) || 1;
    dx /= mag; dy /= mag;
    effectLightningBolt(tip.x, tip.y, dx, dy);
    if (Math.random() < 0.05) SFX.lightning();
    if (state.lastEdgeGesture !== "point") { showToast("☝️ LIGHTNING ACTIVATED"); SFX.lightning(); }
  } else if (confirmed === "pinch") {
    const t1 = toPx(lm[IDX.THUMB_TIP]);
    const t2 = toPx(lm[IDX.INDEX_TIP]);
    const mx = (t1.x + t2.x) / 2, my = (t1.y + t2.y) / 2;
    energyBall = energyBall
      ? { x: energyBall.x + (mx - energyBall.x) * 0.35, y: energyBall.y + (my - energyBall.y) * 0.35 }
      : { x: mx, y: my };
    effectEnergyBall(energyBall.x, energyBall.y);
    if (state.lastEdgeGesture !== "pinch") { showToast("🤏 ENERGY CONTROL"); SFX.energy(); }
  } else {
    energyBall = null;
  }

  // --- gestos discretos (disparo único na borda de transição) ---
  if (confirmed === "fist" && now - state.lastTriggerTime.fist > EDGE_COOLDOWN_MS) {
    state.lastTriggerTime.fist = now;
    const [cx, cy] = handCenterPx(lm);
    effectExplosion(cx, cy);
    showToast("✊ EXPLOSION ACTIVATED");
    SFX.explosion();
    if (navigator.vibrate) navigator.vibrate(40);
  }

  if (confirmed === "peace" && now - state.lastTriggerTime.peace > 1500) {
    state.lastTriggerTime.peace = now;
    takePhoto();
  }

  if (confirmed !== "none") state.lastEdgeGesture = confirmed;
}

// O <video> é espelhado via CSS apenas na câmera frontal (transform: scaleX(-1)),
// então as coordenadas dos efeitos precisam espelhar o eixo X só nesse caso,
// para o poder nascer exatamente onde a ponta do dedo aparece na tela.
function toPx(pt) {
  const x = state.facingMode === "user" ? 1 - pt.x : pt.x;
  return { x: x * canvas.width, y: pt.y * canvas.height };
}
function handCenterPx(lm) {
  const midX = (lm[IDX.WRIST].x + lm[IDX.MIDDLE_MCP].x) / 2;
  const midY = (lm[IDX.WRIST].y + lm[IDX.MIDDLE_MCP].y) / 2;
  const cx = state.facingMode === "user" ? (1 - midX) * canvas.width : midX * canvas.width;
  const cy = midY * canvas.height;
  return [cx, cy];
}

/* --------------------------------------------------------------------- */
/* 10. TROCA DE PODER                                                     */
/* --------------------------------------------------------------------- */
function setPower(key) {
  state.currentPower = key;
  const power = POWERS[key];
  powerReadout.textContent = power.name;
  document.body.style.setProperty("--power-a", power.a);
  document.body.style.setProperty("--power-b", power.b);
  [...powerSelector.children].forEach((btn) => {
    const active = btn.dataset.power === key;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
}
function cyclePower() {
  const i = POWER_ORDER.indexOf(state.currentPower);
  setPower(POWER_ORDER[(i + 1) % POWER_ORDER.length]);
  SFX.switch();
}
powerSelector.addEventListener("click", (e) => {
  const btn = e.target.closest(".power-btn");
  if (!btn) return;
  setPower(btn.dataset.power);
  SFX.switch();
});

/* --------------------------------------------------------------------- */
/* 11. TOAST DE FEEDBACK                                                  */
/* --------------------------------------------------------------------- */
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 1100);
}

/* --------------------------------------------------------------------- */
/* 12. RENDER LOOP (desenha o canvas todo frame, independente da detecção)*/
/* --------------------------------------------------------------------- */
let lastFrameTime = performance.now();
function renderLoop() {
  if (!state.running) return;
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  updateAndDrawShockwaves(dt);
  updateAndDrawParticles(dt);

  requestAnimationFrame(renderLoop);
}

/* --------------------------------------------------------------------- */
/* 13. CÂMERA                                                             */
/* --------------------------------------------------------------------- */
let currentStream = null;

async function startCamera(facingMode) {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
  }
  const constraints = {
    audio: false,
    video: {
      facingMode,
      width: { ideal: 720 },   // resolução reduzida para manter performance em celular
      height: { ideal: 960 },
    },
  };
  currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = currentStream;
  video.classList.toggle("is-back", facingMode === "environment");
  await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve();
  });
  await video.play();
  resizeCanvas();
}

function resizeCanvas() {
  canvas.width = video.videoWidth || window.innerWidth;
  canvas.height = video.videoHeight || window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);

flipBtn.addEventListener("click", async () => {
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  try {
    await startCamera(state.facingMode);
  } catch (err) {
    showToast("Câmera indisponível");
  }
});

/* --------------------------------------------------------------------- */
/* 14. MODOS: POWER MODE / captura de FOTO                                */
/* --------------------------------------------------------------------- */
modeBtn.addEventListener("click", () => {
  state.powerModeOn = !state.powerModeOn;
  document.body.classList.toggle("power-mode", state.powerModeOn);
  modeBtn.classList.toggle("is-on", state.powerModeOn);
});

photoBtn.addEventListener("click", takePhoto);

function takePhoto() {
  SFX.photo();
  flashEl.classList.remove("is-active");
  void flashEl.offsetWidth; // reinicia animação
  flashEl.classList.add("is-active");

  // Composição: espelha o vídeo (se frontal) + desenha o canvas de efeitos por cima
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext("2d");

  octx.save();
  if (state.facingMode === "user") {
    octx.translate(out.width, 0);
    octx.scale(-1, 1);
  }
  octx.drawImage(video, 0, 0, out.width, out.height);
  octx.restore();

  octx.drawImage(canvas, 0, 0);

  out.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gesture-powers-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");

  showToast("📸 FOTO CAPTURADA");
}

/* --------------------------------------------------------------------- */
/* 15. INICIALIZAÇÃO — HandLandmarker + câmera                            */
/* --------------------------------------------------------------------- */
async function initHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 1,               // uma mão só = melhor performance em celular
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

function checkSupport() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return "Este navegador não suporta acesso à câmera (getUserMedia). Tente Chrome ou Safari atualizados.";
  }
  if (!("WebAssembly" in window)) {
    return "Este navegador não suporta WebAssembly, necessário para o reconhecimento de mãos.";
  }
  return null;
}

async function boot() {
  const unsupportedReason = checkSupport();
  if (unsupportedReason) {
    showUnsupported(unsupportedReason);
    return;
  }

  gateStatus.textContent = "Carregando modelo de reconhecimento de mãos…";
  try {
    await initHandLandmarker();
  } catch (err) {
    console.error(err);
    showUnsupported("Não foi possível carregar o modelo de rastreamento de mãos. Verifique sua conexão com a internet e tente novamente.");
    return;
  }

  gateStatus.textContent = "Solicitando acesso à câmera…";
  try {
    await startCamera(state.facingMode);
  } catch (err) {
    console.error(err);
    showUnsupported("Acesso à câmera negado ou indisponível. Permita o uso da câmera nas configurações do navegador e tente novamente.");
    return;
  }

  gate.classList.add("gate--hidden");
  stage.classList.remove("stage--hidden");
  setPower(state.currentPower);

  state.running = true;
  lastFrameTime = performance.now();
  requestAnimationFrame(predictLoop);
  requestAnimationFrame(renderLoop);
}

function showUnsupported(msg) {
  gate.classList.add("gate--hidden");
  unsupported.classList.remove("gate--hidden");
  unsupportedMsg.textContent = msg;
}

startBtn.addEventListener("click", boot);
retryBtn.addEventListener("click", () => {
  unsupported.classList.add("gate--hidden");
  gate.classList.remove("gate--hidden");
  gateStatus.textContent = "";
});

// Pausa o loop de detecção quando a aba fica em segundo plano, para
// economizar bateria/CPU no celular.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    state.running = false;
    if (rafId) cancelAnimationFrame(rafId);
  } else if (stage && !stage.classList.contains("stage--hidden") && handLandmarker) {
    state.running = true;
    lastFrameTime = performance.now();
    requestAnimationFrame(predictLoop);
    requestAnimationFrame(renderLoop);
  }
});
