/* ==========================================================================
   GESTURE POWERS — PRO VFX ENGINE
   ========================================================================== */
import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const $ = (id) => document.getElementById(id);
const canvas = $("fx"), ctx = canvas.getContext("2d");
const video = $("video"), stage = $("stage");

// --- CONFIGURAÇÃO DE ELITE ---
const VFX_CONFIG = {
  particlesPerFrame: 8,
  maxParticles: 400,
  glowSize: 25,
  lerpFactor: 0.28, // Suavidade do movimento
};

const state = {
  particles: [],
  shocks: [],
  lerpPoints: { index: {x:0, y:0}, wrist: {x:0, y:0} },
  currentPower: 'lightning',
  facingMode: 'user',
  running: true
};

// --- CLASSE DE PARTÍCULA PROFISSIONAL ---
class Particle {
  constructor(x, y, color, type = 'glow') {
    this.x = x;
    this.y = y;
    this.color = color;
    this.type = type; // 'glow', 'spark', 'smoke'
    this.life = 1.0;
    this.decay = Math.random() * 0.02 + 0.01;
    this.size = Math.random() * 6 + 2;
    this.vx = (Math.random() - 0.5) * 12;
    this.vy = (Math.random() - 0.5) * 12;
    this.history = []; // Para rastros (trails)
  }

  update() {
    this.history.push({x: this.x, y: this.y});
    if(this.history.length > 5) this.history.shift();
    
    this.x += this.vx;
    this.y += this.vy;
    this.vy += 0.1; // Gravidade leve
    this.life -= this.decay;
    this.size *= 0.96;
  }

  draw(ctx) {
    if (this.life <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    
    // Desenha rastro
    if(this.history.length > 1) {
      ctx.beginPath();
      ctx.moveTo(this.history[0].x, this.history[0].y);
      this.history.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.size * 0.5;
      ctx.globalAlpha = this.life * 0.5;
      ctx.stroke();
    }

    // Desenha Core
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fillStyle = "#fff"; // Core quente
    ctx.shadowBlur = 15;
    ctx.shadowColor = this.color;
    ctx.globalAlpha = this.life;
    ctx.fill();
    ctx.restore();
  }
}

// --- FUNÇÃO DE RAIO PROCEDURAL (VFX REALISTA) ---
function drawLightning(x1, y1, x2, y2, color, thickness) {
  const dist = Math.hypot(x2-x1, y2-y1);
  const segments = 8;
  let currX = x1;
  let currY = y1;

  ctx.save();
  ctx.shadowBlur = 20;
  ctx.shadowColor = color;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = thickness;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);

  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const tx = x1 + (x2 - x1) * t;
    const ty = y1 + (y2 - y1) * t;
    const jitter = (Math.random() - 0.5) * (dist * 0.2);
    
    currX = tx + jitter;
    currY = ty + jitter;
    ctx.lineTo(currX, currY);
    
    // Pequena chance de ramificação
    if (Math.random() > 0.8) {
       drawLightning(currX, currY, currX + jitter*2, currY + jitter*2, color, thickness * 0.5);
    }
  }
  ctx.stroke();
  
  // Aura do raio
  ctx.strokeStyle = color;
  ctx.lineWidth = thickness * 3;
  ctx.globalAlpha = 0.3;
  ctx.stroke();
  ctx.restore();
}

// --- EXPLOSÃO COM CAMERA SHAKE ---
function triggerExplosion(x, y) {
  stage.classList.add('camera-shake');
  setTimeout(() => stage.classList.remove('camera-shake'), 400);

  for(let i=0; i<40; i++) {
    state.particles.push(new Particle(x, y, "#ffeb3b", 'spark'));
  }
}

// --- LOOP DE RENDERIZAÇÃO ---
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  if (state.landmarks) {
    const hand = state.landmarks;
    const wrist = getCoords(hand[0]);
    const indexTip = getCoords(hand[8]);

    // Interpolação para suavidade cinematográfica
    state.lerpPoints.index.x += (indexTip.x - state.lerpPoints.index.x) * VFX_CONFIG.lerpFactor;
    state.lerpPoints.index.y += (indexTip.y - state.lerpPoints.index.y) * VFX_CONFIG.lerpFactor;

    const gesture = classifyGesture(hand);

    // Efeitos por Gesto
    if (gesture === "point") {
      drawLightning(state.lerpPoints.index.x, state.lerpPoints.index.y, 
                    state.lerpPoints.index.x + (Math.random()-0.5)*200, 
                    state.lerpPoints.index.y - 300, "#4de8ff", 3);
    } 
    else if (gesture === "open") {
      // Aura Swirl
      const time = performance.now() * 0.005;
      for(let i=0; i<2; i++) {
        const angle = time + (i * Math.PI);
        const sx = state.lerpPoints.index.x + Math.cos(angle) * 80;
        const sy = state.lerpPoints.index.y + Math.sin(angle) * 80;
        state.particles.push(new Particle(sx, sy, "#9b6bff"));
      }
    }
    else if (gesture === "fist") {
      if (Math.random() > 0.95) triggerExplosion(state.lerpPoints.index.x, state.lerpPoints.index.y);
    }
  }

  // Update & Draw Particles
  state.particles = state.particles.filter(p => p.life > 0);
  state.particles.forEach(p => {
    p.update();
    p.draw(ctx);
  });

  requestAnimationFrame(render);
}

// --- HELPERS REVISADOS ---
function getCoords(pt) {
  const x = state.facingMode === "user" ? (1 - pt.x) : pt.x;
  return { x: x * canvas.width, y: pt.y * canvas.height };
}

function classifyGesture(lm) {
  const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  const isOpen = lm[8].y < lm[6].y && lm[12].y < lm[10].y;
  const isPoint = lm[8].y < lm[6].y && lm[12].y > lm[10].y;
  const isPinch = d(4, 8) < 0.04;
  
  if (isPinch) return "pinch";
  if (isPoint) return "point";
  if (isOpen) return "open";
  return "fist";
}

// Inicialização (Boot) simplificada para o exemplo
async function init() {
  const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  const handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate: "GPU" },
    runningMode: "VIDEO", numHands: 1
  });

  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
  video.srcObject = stream;
  video.onloadedmetadata = () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    render();
    
    // Loop de Detecção
    const detect = () => {
      const result = handLandmarker.detectForVideo(video, performance.now());
      state.landmarks = result.landmarks?.[0] || null;
      requestAnimationFrame(detect);
    };
    detect();
  };
}

$("startBtn").onclick = () => {
  $("gate").style.display = "none";
  $("stage").style.display = "block";
  init();
};
