/*
 * Téléprompteur
 * --------------
 * Principe : le texte est un élément HTML posé par-dessus l'aperçu caméra.
 * L'enregistrement, lui, se fait à partir d'un <canvas> sur lequel on ne
 * dessine QUE l'image de la caméra (recadrée au format choisi) + la piste
 * audio du micro. Le texte n'est donc jamais dans la vidéo exportée.
 */
(() => {
  'use strict';

  const APP_VERSION = '13';
  const $ = (id) => document.getElementById(id);
  const els = {
    body: document.body,
    frame: $('frame'),
    preview: $('preview'),
    prompter: $('prompter'),
    prompterText: $('prompterText'),
    countdown: $('countdown'),
    recBadge: $('recBadge'),
    recTime: $('recTime'),
    camMessage: $('camMessage'),
    flipBtn: $('flipBtn'),
    scriptBtn: $('scriptBtn'),
    recBtn: $('recBtn'),
    slowerBtn: $('slowerBtn'),
    fasterBtn: $('fasterBtn'),
    speedLabel: $('speedLabel'),
    sheet: $('sheet'),
    closeSheet: $('closeSheet'),
    scriptInput: $('scriptInput'),
    speedInput: $('speedInput'), speedVal: $('speedVal'),
    sizeInput: $('sizeInput'), sizeVal: $('sizeVal'),
    heightInput: $('heightInput'), heightVal: $('heightVal'),
    textPosInput: $('textPosInput'), textPosVal: $('textPosVal'),
    lookbackInput: $('lookbackInput'), lookbackVal: $('lookbackVal'),
    readLine: $('readLine'),
    opacityInput: $('opacityInput'), opacityVal: $('opacityVal'),
    countdownInput: $('countdownInput'),
    recordMirrorInput: $('recordMirrorInput'),
    micSelect: $('micSelect'),
    micRefresh: $('micRefresh'),
    gainInput: $('gainInput'), gainVal: $('gainVal'),
    voiceProcInput: $('voiceProcInput'),
    micMeter: $('micMeter'),
    micName: $('micName'),
    micLevel: $('micLevel'),
    previewMirrorInput: $('previewMirrorInput'),
    formatInfo: $('formatInfo'),
    result: $('result'),
    resultVideo: $('resultVideo'),
    resultInfo: $('resultInfo'),
    saveBtn: $('saveBtn'),
    discardBtn: $('discardBtn'),
    view: $('view'),
    filterBtn: $('filterBtn'),
    filterInput: $('filterInput'),
    smoothInput: $('smoothInput'), smoothVal: $('smoothVal'),
    glowInput: $('glowInput'), glowVal: $('glowVal'),
    filterInfo: $('filterInfo'),
  };

  // ---------- Réglages persistants ----------
  const STORE_KEY = 'teleprompteur.v1';
  const defaults = {
    script: '',
    speed: 5,
    size: 32,
    height: 40,
    lookback: 3,           // nombre de lignes déjà lues qui restent visibles au-dessus
    textTop: 55,           // haut de la zone de texte, en % de la hauteur de l'image
    opacity: 55,
    countdown: true,
    micId: '',             // '' = micro par défaut du téléphone
    voiceProc: false,
    micGain: 4,            // amplification logicielle du micro (×1 à ×16)      // traitement voix iOS (écho/bruit) : désactivé, gêne les micros externes
    recordMirror: false,   // vidéo enregistrée à l'endroit par défaut
    previewMirror: false,  // aperçu identique à la vidéo par défaut
    ratio: 'portrait',
    facing: 'user',
    filter: false,
    smooth: 50,
    glow: 40,
  };
  let settings = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    settings = { ...defaults, ...saved };
  } catch (_) { /* stockage indisponible : on garde les valeurs par défaut */ }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) {}
  }

  // ---------- Format d'enregistrement ----------
  // MP4 en priorité (iPhone / Safari le produit nativement ; Instagram et TikTok l'acceptent).
  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  function pickMime() {
    if (!('MediaRecorder' in window)) return null;
    for (const m of MIME_CANDIDATES) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
    }
    return '';
  }
  const MIME = pickMime();

  // ---------- Rendu (caméra recadrée + filtre bonne mine) ----------
  // Un seul <canvas> sert d'aperçu ET de source d'enregistrement : ce que l'on voit
  // est exactement ce qui est enregistré. Le texte, lui, est un élément HTML à part.
  const VERT = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  // Lissage : flou « bilatéral » (moyenne des pixels voisins de couleur proche, ce qui
  // garde les contours nets : yeux, sourcils, cheveux), appliqué seulement sur les
  // tons de peau (détection dans l'espace YCbCr).
  // Éclat : léger éclaircissement des tons moyens, teinte un peu plus chaude,
  // saturation légèrement augmentée.
  const FRAG = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform vec4 uCrop;      // x, y, largeur, hauteur (coordonnées de texture 0..1)
    uniform vec2 uStep;      // taille d'un pas d'échantillonnage (en coordonnées de texture)
    uniform float uSmooth;   // 0..1
    uniform float uGlow;     // 0..1
    uniform float uFlipX;    // 1.0 = image retournée horizontalement (miroir)

    float skinMask(vec3 c) {
      float cb = -0.1687 * c.r - 0.3313 * c.g + 0.5 * c.b + 0.5;
      float cr =  0.5 * c.r - 0.4187 * c.g - 0.0813 * c.b + 0.5;
      float m = smoothstep(0.26, 0.31, cb) * (1.0 - smoothstep(0.49, 0.54, cb))
              * smoothstep(0.50, 0.54, cr) * (1.0 - smoothstep(0.68, 0.72, cr));
      return m;
    }

    void main() {
      float x = uFlipX > 0.5 ? 1.0 - vUv.x : vUv.x;
      vec2 uv = uCrop.xy + vec2(x, 1.0 - vUv.y) * uCrop.zw;
      vec3 c = texture2D(uTex, uv).rgb;
      vec3 col = c;

      if (uSmooth > 0.001) {
        vec3 sum = c;
        float wsum = 1.0;
        // Plus le lissage est fort, plus il tolère les écarts de couleur (petites taches)
        // et plus il va chercher loin.
        float k = 120.0 - 90.0 * uSmooth;
        vec2 stepR = uStep * (0.6 + 0.9 * uSmooth);
        for (int ring = 1; ring <= 3; ring++) {
          float r = float(ring);
          for (int i = 0; i < 12; i++) {
            float a = (float(i) + 0.5 * r) * 0.5235988; // 2π / 12, anneaux décalés
            vec3 s = texture2D(uTex, uv + vec2(cos(a), sin(a)) * stepR * r).rgb;
            vec3 d = s - c;
            float w = exp(-dot(d, d) * k);
            sum += s * w;
            wsum += w;
          }
        }
        vec3 smoothed = sum / wsum;
        col = mix(c, smoothed, uSmooth * skinMask(c));
      }

      if (uGlow > 0.001) {
        col = pow(max(col, 0.0), vec3(1.0 - 0.18 * uGlow));          // éclaircit les tons moyens
        col += vec3(0.035, 0.012, -0.02) * uGlow;                     // teint plus chaleureux
        float l = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(vec3(l), col, 1.0 + 0.12 * uGlow);                  // un peu plus de couleur
      }

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`;

  const renderer = (() => {
    const canvas = els.view;
    let gl = null, prog = null, tex = null, loc = {}, ctx2d = null;
    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true })
        || canvas.getContext('experimental-webgl', { alpha: false, preserveDrawingBuffer: true });
    } catch (_) { gl = null; }

    if (gl) {
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      try {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        for (const n of ['uTex', 'uCrop', 'uStep', 'uSmooth', 'uGlow', 'uFlipX']) loc[n] = gl.getUniformLocation(prog, n);
        gl.uniform1i(loc.uTex, 0);
      } catch (e) {
        console.warn('WebGL indisponible, rendu sans filtre', e);
        gl = null;
      }
    }
    if (!gl) ctx2d = canvas.getContext('2d', { alpha: false });

    function draw(video, crop) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const flip = settings.recordMirror && settings.facing === 'user';
      if (gl) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
        gl.uniform4f(loc.uCrop, crop.sx / vw, crop.sy / vh, crop.sw / vw, crop.sh / vh);
        // Rayon du lissage proportionnel à la taille de l'image (≈ 2,2 px par anneau pour 1080 px de large).
        const stepPx = Math.max(1, Math.min(crop.sw, crop.sh) / 1080 * 2.2);
        gl.uniform2f(loc.uStep, stepPx / vw, stepPx / vh);
        const on = settings.filter;
        gl.uniform1f(loc.uSmooth, on ? settings.smooth / 100 : 0);
        gl.uniform1f(loc.uGlow, on ? settings.glow / 100 : 0);
        gl.uniform1f(loc.uFlipX, flip ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } else {
        ctx2d.save();
        if (flip) { ctx2d.translate(canvas.width, 0); ctx2d.scale(-1, 1); }
        ctx2d.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
        ctx2d.restore();
      }
    }

    return { canvas, gl, draw };
  })();

  // ---------- Application des réglages à l'interface ----------
  function applySettings() {
    const r = document.documentElement.style;
    r.setProperty('--prompter-size', settings.size + 'px');
    r.setProperty('--prompter-height', settings.height + '%');
    els.textPosVal.textContent = settings.textTop;
    els.lookbackVal.textContent = settings.lookback;
    layoutPrompter();
    r.setProperty('--prompter-bg', `rgba(0,0,0,${settings.opacity / 100})`);

    els.prompterText.textContent = settings.script.trim();
    els.speedLabel.textContent = settings.speed;
    els.speedVal.textContent = settings.speed;
    els.sizeVal.textContent = settings.size;
    els.heightVal.textContent = settings.height;
    els.opacityVal.textContent = settings.opacity;

    els.body.classList.toggle('landscape', settings.ratio === 'landscape');
    document.querySelectorAll('[data-ratio]').forEach((b) =>
      b.classList.toggle('active', b.dataset.ratio === settings.ratio));

    // Le canvas contient déjà l'image telle qu'elle sera enregistrée (miroir ou non) : l'aperçu
    // montre donc la vidéo finale. « Aperçu en miroir » retourne en plus l'écran seulement.
    els.view.classList.toggle('mirror', settings.facing === 'user' && settings.previewMirror && !settings.recordMirror);
    els.smoothVal.textContent = settings.smooth;
    els.glowVal.textContent = settings.glow;
    els.filterBtn.setAttribute('aria-pressed', String(settings.filter));
    els.filterBtn.hidden = !renderer.gl;
  }

  /**
   * Place la zone de texte dans l'image :
   * - le texte démarre (ligne de lecture rouge) à « Position du texte » % de la hauteur ;
   * - la zone remonte de « lignes déjà lues » au-dessus, pour garder les phrases lues visibles ;
   * - elle descend de « Hauteur de la zone » % sous le point de départ, sans dépasser l'image.
   */
  function layoutPrompter() {
    const H = els.frame.clientHeight;
    if (!H) return;
    const lineH = settings.size * 1.35;
    const startY = H * settings.textTop / 100;
    const barSpace = 56; // place pour la barre de boutons du haut
    let top, pad;
    if (startY < barSpace + 8) {
      // Texte tout en haut : comportement d'origine, sous la barre de boutons.
      top = 0;
      pad = Math.max(startY, barSpace);
    } else {
      const look = settings.lookback * lineH + 10;
      top = Math.max(barSpace, startY - look);
      if (top > startY - 10) top = Math.max(0, startY - 10);
      pad = startY - top;
    }
    const bottom = Math.min(H, startY + H * settings.height / 100);
    const p = els.prompter.style;
    p.top = top + 'px';
    p.height = Math.max(lineH + pad, bottom - top) + 'px';
    p.paddingTop = pad + 'px';
    p.setProperty('--fade', pad + 'px');
    els.readLine.style.top = pad + 'px';
  }
  window.addEventListener('resize', () => requestAnimationFrame(layoutPrompter));
  window.addEventListener('orientationchange', () => setTimeout(layoutPrompter, 300));

  function fillForm() {
    els.scriptInput.value = settings.script;
    els.speedInput.value = settings.speed;
    els.sizeInput.value = settings.size;
    els.heightInput.value = settings.height;
    els.textPosInput.value = settings.textTop;
    els.lookbackInput.value = settings.lookback;
    els.opacityInput.value = settings.opacity;
    els.countdownInput.checked = settings.countdown;
    els.recordMirrorInput.checked = settings.recordMirror;
    els.voiceProcInput.checked = settings.voiceProc;
    els.gainInput.value = settings.micGain;
    els.gainVal.textContent = '×' + settings.micGain;
    els.previewMirrorInput.checked = settings.previewMirror;
    els.filterInput.checked = settings.filter;
    els.smoothInput.value = settings.smooth;
    els.glowInput.value = settings.glow;
    els.filterInfo.textContent = renderer.gl
      ? 'Le filtre est appliqué à l\'aperçu et à la vidéo enregistrée (jamais au texte, qui n\'est pas enregistré).'
      : 'Le filtre n\'est pas disponible sur cet appareil (WebGL indisponible).';
    const fmt = MIME === null
      ? "Ce navigateur ne permet pas l'enregistrement vidéo."
      : `Format d'export : ${MIME ? MIME.split(';')[0].replace('video/', '').toUpperCase() : 'par défaut du navigateur'}.`;
    els.formatInfo.textContent = fmt;
  }

  // ---------- Caméra ----------
  let stream = null;

  // Un seul démarrage de caméra à la fois : les demandes arrivées pendant ce temps
  // sont regroupées en un seul nouvel essai.
  let cameraBusy = false, cameraAgain = false, streamStartedAt = 0;
  async function startCamera() {
    if (cameraBusy) { cameraAgain = true; return; }
    cameraBusy = true;
    try { await openCamera(); } finally { cameraBusy = false; }
    if (cameraAgain) { cameraAgain = false; startCamera(); }
  }

  async function openCamera() {
    stopCamera();
    els.camMessage.hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamMessage("L'accès à la caméra n'est pas disponible. Ouvrez cette page en HTTPS dans Safari.", false);
      return;
    }
    const video = {
      facingMode: settings.facing,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    };
    const audioFor = (micId) => {
      // Traitement voix désactivé par défaut : sur iPhone il active un mode « appel »
      // qui pose problème avec certains micros externes.
      const vp = settings.voiceProc;
      const a = { echoCancellation: vp, noiseSuppression: vp, autoGainControl: vp };
      if (micId) a.deviceId = { exact: micId };
      return a;
    };
    // Essais successifs, du plus précis au plus simple. Si le micro pose problème,
    // la caméra doit quand même fonctionner (dernier essai : image seule).
    const attempts = [];
    if (settings.micId) attempts.push({ video, audio: audioFor(settings.micId) });
    attempts.push({ video, audio: audioFor('') });
    attempts.push({ video: { facingMode: settings.facing }, audio: true });
    attempts.push({ video: true, audio: true });
    attempts.push({ video: { facingMode: settings.facing }, audio: false });
    attempts.push({ video: true, audio: false });

    let lastErr = null, s = null, used = -1;
    for (let i = 0; i < attempts.length; i++) {
      try {
        s = await navigator.mediaDevices.getUserMedia(attempts[i]);
        used = i;
        break;
      } catch (err) {
        lastErr = err;
        console.warn('getUserMedia refusé', i, err && err.name, err && err.message);
        // Autorisation refusée : on tente encore l'image seule (le refus peut ne concerner que le micro).
        if (err && err.name === 'NotAllowedError') {
          const next = attempts.findIndex((a, j) => j > i && a.audio === false);
          if (next < 0) break;
          i = next - 1;
        }
      }
    }
    if (!s) {
      showCameraError(lastErr);
      return;
    }
    if (settings.micId && used !== 0) { settings.micId = ''; save(); } // micro choisi introuvable
    stream = s;
    streamStartedAt = performance.now();
    els.preview.srcObject = stream;
    await els.preview.play().catch(() => {});
    watchAudioTrack();
    listMics();
    deviceSignature().then((sig) => { if (sig !== null) lastDeviceSig = sig; });
  }

  function showCameraError(err) {
    const name = (err && err.name) || 'Erreur';
    let help;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      help = "L'accès à la caméra ou au micro a été refusé.<br>" +
        "Sur iPhone : Réglages › Safari › Caméra et Microphone → « Autoriser » (ou « Demander »), " +
        "puis fermez complètement l'application et rouvrez-la.";
    } else if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
      help = "La caméra est peut-être utilisée par une autre application (Appareil photo, FaceTime, DJI Mimo, appel en cours…).<br>" +
        "Fermez ces applications puis touchez « Réessayer ».";
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      help = "Aucune caméra n'a été trouvée.";
    } else {
      help = "Impossible de démarrer la caméra.";
    }
    showCamMessage(`${help}<br><br><small>(${name}${err && err.message ? ' : ' + err.message : ''})</small>`, true);
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  // ---------- Micro : liste, jauge de niveau, surveillance ----------
  async function listMics() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (_) { return; }
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const current = currentAudioTrack();
    const currentId = current && current.getSettings ? current.getSettings().deviceId : '';
    els.micSelect.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Automatique (micro par défaut du téléphone)';
    els.micSelect.appendChild(def);
    mics.forEach((m, i) => {
      const o = document.createElement('option');
      o.value = m.deviceId;
      o.textContent = m.label || `Micro ${i + 1}`;
      els.micSelect.appendChild(o);
    });
    els.micSelect.value = settings.micId && mics.some((m) => m.deviceId === settings.micId) ? settings.micId : '';
    if (!settings.micId && currentId) {
      // Indique quel micro est réellement utilisé en mode automatique.
      const used = mics.find((m) => m.deviceId === currentId);
      if (used && used.label) def.textContent = `Automatique (actuellement : ${used.label})`;
    }
  }

  function currentAudioTrack() {
    return stream ? stream.getAudioTracks()[0] || null : null;
  }

  // Chaîne audio : micro → amplification → limiteur → (jauge + piste enregistrée).
  // Le son n'est envoyé vers aucun haut-parleur.
  let audioCtx = null, analyser = null, meterSource = null, meterBuf = null;
  let gainNode = null, limiter = null, audioDest = null;

  function setupMeter() {
    const track = currentAudioTrack();
    if (meterSource) { try { meterSource.disconnect(); } catch (_) {} meterSource = null; }
    if (!track) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (!analyser) {
        gainNode = audioCtx.createGain();
        limiter = audioCtx.createDynamicsCompressor();
        // Réglages de limiteur : écrase seulement les pics pour éviter la saturation.
        limiter.threshold.value = -3;
        limiter.knee.value = 3;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.15;
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        meterBuf = new Uint8Array(analyser.fftSize);
        gainNode.connect(limiter);
        limiter.connect(analyser);
        if (audioCtx.createMediaStreamDestination) {
          audioDest = audioCtx.createMediaStreamDestination();
          limiter.connect(audioDest);
        }
      }
      applyGain();
      meterSource = audioCtx.createMediaStreamSource(new MediaStream([track]));
      meterSource.connect(gainNode);
      if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    } catch (e) {
      console.warn('Chaîne audio indisponible', e);
    }
  }

  /**
   * À appeler pendant un geste de l'utilisateur (toucher) : iPhone n'autorise à démarrer
   * le moteur audio qu'à ce moment-là. S'il est bloqué (« interrupted », « closed »…),
   * on le recrée.
   */
  function ensureAudioRunning() {
    if (!currentAudioTrack()) return;
    if (audioCtx && audioCtx.state === 'running' && meterSource) return;
    if (audioCtx && audioCtx.state !== 'suspended') {
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null; analyser = null; gainNode = null; limiter = null; audioDest = null; meterSource = null;
    }
    setupMeter();
    if (audioCtx) audioCtx.resume().catch(() => {});
  }

  function applyGain() {
    if (gainNode) gainNode.gain.value = settings.micGain;
  }

  /** Piste audio à enregistrer : le son amplifié si possible, sinon le son brut du micro. */
  let audioInfo = '';
  function recordingAudioTracks() {
    const raw = stream ? stream.getAudioTracks() : [];
    const label = raw[0] ? (raw[0].label || 'micro') : 'aucun micro';
    if (audioDest && meterSource && audioCtx && audioCtx.state === 'running') {
      const t = audioDest.stream.getAudioTracks();
      if (t.length) {
        audioInfo = `Son amplifié ×${settings.micGain} · ${label}`;
        return t;
      }
    }
    audioInfo = `⚠️ Son NON amplifié (moteur audio : ${audioCtx ? audioCtx.state : 'absent'}) · ${label}`;
    console.warn(audioInfo);
    return raw;
  }

  // Safari n'autorise le son qu'après un geste de l'utilisateur.
  document.addEventListener('pointerdown', () => {
    if (!audioCtx || audioCtx.state !== 'running') ensureAudioRunning();
  }, { passive: true });

  function updateMeter() {
    const track = currentAudioTrack();
    let warn = '';
    if (!stream) warn = '';
    else if (!track) warn = 'Aucun micro';
    else if (track.readyState === 'ended') warn = 'Micro déconnecté';
    else if (track.muted) warn = 'Micro coupé par le système';
    els.micMeter.classList.toggle('warn', !!warn);
    els.micName.textContent = warn || (track ? `🎙 ${track.label || 'Micro'}` : 'Micro');
    let level = 0;
    if (analyser && meterSource && !warn && audioCtx.state === 'running') {
      analyser.getByteTimeDomainData(meterBuf);
      let sum = 0;
      for (let i = 0; i < meterBuf.length; i++) { const v = (meterBuf[i] - 128) / 128; sum += v * v; }
      // Échelle en dB : -50 dB = vide, 0 dB = plein.
      const rms = Math.sqrt(sum / meterBuf.length);
      const db = 20 * Math.log10(rms + 1e-9);
      level = Math.max(0, Math.min(1, (db + 50) / 50));
    }
    els.micLevel.style.width = `${Math.round(level * 100)}%`;
    els.micLevel.classList.toggle('hot', level > 0.9);
    if (audioCtx && audioCtx.state !== 'running') els.micName.textContent += ' (touchez l\'écran)';
  }

  function watchAudioTrack() {
    setupMeter();
    const track = currentAudioTrack();
    if (track) track.addEventListener('ended', () => listMics());
  }

  // Branchement / débranchement d'un micro : on relance la capture (hors enregistrement).
  let deviceChangeTimer = 0, lastDeviceSig = null;
  async function deviceSignature() {
    try {
      const d = await navigator.mediaDevices.enumerateDevices();
      return d.filter((x) => x.kind === 'audioinput' || x.kind === 'videoinput')
        .map((x) => x.kind + ':' + x.deviceId).sort().join('|');
    } catch (_) { return null; }
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      clearTimeout(deviceChangeTimer);
      deviceChangeTimer = setTimeout(async () => {
        const sig = await deviceSignature();
        // iPhone signale aussi des « changements » quand la caméra démarre : on ne relance
        // que si un micro ou une caméra a réellement été ajouté ou retiré.
        const changed = sig !== null && lastDeviceSig !== null && sig !== lastDeviceSig;
        lastDeviceSig = sig;
        listMics();
        if (!changed || recording || countdownTimer || cameraBusy) return;
        startCamera();
      }, 800);
    });
  }

  function showCamMessage(html, retry) {
    els.camMessage.innerHTML = `<div>${html}${retry ? '<br><br><button id="camRetry" class="pill primary" type="button">Réessayer</button>' : ''}</div>`;
    els.camMessage.hidden = false;
    const b = document.getElementById('camRetry');
    if (b) b.addEventListener('click', () => { ensureAudioRunning(); startCamera(); });
  }

  // ---------- Défilement du texte ----------
  let scrollY = 0;           // décalage en px
  let scrolling = false;     // en train de défiler
  let lastTs = 0;
  let scrollRaf = 0;

  function pxPerSecond() {
    // Vitesse proportionnelle à la taille du texte pour garder un rythme de lecture cohérent.
    return settings.speed * settings.size * 0.12;
  }

  function maxScroll() {
    return Math.max(0, els.prompterText.scrollHeight - settings.size * 1.35);
  }

  function renderScroll() {
    els.prompterText.style.transform = `translate3d(0, ${-scrollY}px, 0)`;
  }

  function scrollTick(ts) {
    if (!scrolling) return;
    if (lastTs) {
      const dt = Math.min(0.1, (ts - lastTs) / 1000);
      scrollY = Math.min(maxScroll(), scrollY + pxPerSecond() * dt);
      renderScroll();
    }
    lastTs = ts;
    scrollRaf = requestAnimationFrame(scrollTick);
  }

  function playScroll() {
    if (scrolling) return;
    scrolling = true;
    lastTs = 0;
    els.prompter.classList.remove('paused');
    scrollRaf = requestAnimationFrame(scrollTick);
  }

  function pauseScroll() {
    scrolling = false;
    cancelAnimationFrame(scrollRaf);
    els.prompter.classList.add('paused');
  }

  function resetScroll() {
    pauseScroll();
    els.prompter.classList.remove('paused');
    scrollY = 0;
    renderScroll();
  }

  // Toucher = pause / reprise ; glisser = avancer / reculer
  (() => {
    let startY = 0, startScroll = 0, moved = false, active = false;
    els.prompter.addEventListener('pointerdown', (e) => {
      active = true; moved = false;
      startY = e.clientY; startScroll = scrollY;
      els.prompter.setPointerCapture(e.pointerId);
    });
    els.prompter.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 6) moved = true;
      if (moved) {
        scrollY = Math.max(0, Math.min(maxScroll(), startScroll - dy));
        renderScroll();
      }
    });
    const end = () => {
      if (!active) return;
      active = false;
      if (!moved && recording) {
        scrolling ? pauseScroll() : playScroll();
      }
    };
    els.prompter.addEventListener('pointerup', end);
    els.prompter.addEventListener('pointercancel', end);
  })();

  // ---------- Enregistrement ----------
  let recording = false;
  let recorder = null;
  let chunks = [];
  let timerInt = 0;
  let startedAt = 0;
  let resultBlob = null;
  let resultUrl = null;
  let resultSaved = false;
  let wakeLock = null;
  let countdownTimer = 0;

  /** Calcule le recadrage centré de la source vers le format voulu. */
  function cropRect(srcW, srcH, ratio) {
    let w = srcW, h = srcH;
    if (srcW / srcH > ratio) w = srcH * ratio; else h = srcW / ratio;
    return { sx: (srcW - w) / 2, sy: (srcH - h) / 2, sw: w, sh: h };
  }

  /** Taille du canvas : recadrage de la source, plafonné à 1080×1920 (ou 1920×1080), dimensions paires. */
  function canvasSize(srcW, srcH, portrait) {
    const ratio = portrait ? 9 / 16 : 16 / 9;
    const c = cropRect(srcW, srcH, ratio);
    const maxW = portrait ? 1080 : 1920;
    const scale = Math.min(1, maxW / c.sw);
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    return { w: even(c.sw * scale), h: even(c.sh * scale) };
  }

  /**
   * Boucle d'affichage permanente : dessine la caméra (recadrée + filtre) dans le canvas visible.
   * Hors enregistrement, la taille du canvas suit le format choisi et la résolution de la caméra.
   * Pendant l'enregistrement, elle est figée (le recadrage, lui, suit une éventuelle rotation).
   */
  function renderLoop() {
    const v = els.preview;
    if (v.videoWidth && v.videoHeight) {
      const portrait = settings.ratio === 'portrait';
      if (!recording) {
        const size = canvasSize(v.videoWidth, v.videoHeight, portrait);
        if (renderer.canvas.width !== size.w || renderer.canvas.height !== size.h) {
          renderer.canvas.width = size.w;
          renderer.canvas.height = size.h;
        }
      }
      renderer.draw(v, cropRect(v.videoWidth, v.videoHeight, portrait ? 9 / 16 : 16 / 9));
    }
    checkFrozen(v);
    updateMeter();
    requestAnimationFrame(renderLoop);
  }

  /**
   * Surveillance anti-image figée : si l'aperçu caméra est en pause ou n'avance plus
   * (par ex. après la lecture d'une vidéo sur iPhone), on le relance, puis on redémarre
   * la caméra si nécessaire.
   */
  let lastVideoTime = -1, lastProgressAt = 0, lastRestartAt = 0, lastFrameAt = 0;
  // Compte les vraies images reçues de la caméra (plus fiable que currentTime, qui peut
  // continuer d'avancer alors que l'image est figée).
  const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  if (hasRVFC) {
    const onFrame = () => { lastFrameAt = performance.now(); els.preview.requestVideoFrameCallback(onFrame); };
    els.preview.requestVideoFrameCallback(onFrame);
  }
  let autoRestarts = [];
  function checkFrozen(v) {
    if (!stream || cameraBusy || document.hidden || !els.result.hidden) { lastProgressAt = performance.now(); return; }
    const now = performance.now();
    const progressed = hasRVFC ? lastFrameAt > lastProgressAt : v.currentTime !== lastVideoTime;
    if (progressed && !v.paused) {
      lastVideoTime = v.currentTime;
      lastProgressAt = now;
      return;
    }
    if (v.paused) v.play().catch(() => {});
    if (recording || countdownTimer) return;
    const videoEnded = stream.getVideoTracks().some((t) => t.readyState === 'ended');
    // Figé = des images arrivaient pour ce flux, puis plus rien depuis 2 s.
    const hadFrames = hasRVFC ? lastFrameAt > streamStartedAt : v.currentTime > 0;
    const frozen = hadFrames && now - lastProgressAt > 2000;
    if (!videoEnded && !frozen) return;
    // Au plus 3 redémarrages automatiques par minute (jamais de boucle).
    autoRestarts = autoRestarts.filter((t) => now - t < 60000);
    if (autoRestarts.length >= 3 || now - lastRestartAt < 4000) return;
    console.warn('Aperçu figé ou caméra arrêtée : redémarrage');
    autoRestarts.push(now);
    lastRestartAt = now;
    lastProgressAt = now;
    startCamera();
  }

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (_) {}
    wakeLock = null;
  }

  function startRecording() {
    if (!stream) { startCamera(); return; }
    if (MIME === null) {
      alert("Ce navigateur ne permet pas l'enregistrement vidéo. Utilisez Safari sur iPhone (iOS 14.3 ou plus récent).");
      return;
    }
    const v = els.preview;
    if (!v.videoWidth || !v.videoHeight) return;
    const at = currentAudioTrack();
    if ((!at || at.readyState === 'ended') &&
        !confirm('Aucun micro actif : la vidéo n\'aura pas de son. Enregistrer quand même ?')) return;

    // Le canvas ne contient que l'image caméra (filtrée si activé), jamais le texte.
    const canvas = renderer.canvas;
    const size = { w: canvas.width, h: canvas.height };

    const canvasStream = canvas.captureStream(30);
    const outStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...recordingAudioTracks(),
    ]);

    const opts = { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 128_000 };
    if (MIME) opts.mimeType = MIME;
    try {
      recorder = new MediaRecorder(outStream, opts);
    } catch (e) {
      console.warn('MediaRecorder avec options refusé, essai sans options', e);
      recorder = new MediaRecorder(outStream);
    }

    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      canvasStream.getTracks().forEach((t) => t.stop());
      const type = recorder.mimeType || MIME || 'video/mp4';
      resultBlob = new Blob(chunks, { type });
      chunks = [];
      showResult(size);
    };
    recorder.start(1000);

    recording = true;
    els.body.classList.add('recording');
    startedAt = Date.now();
    els.recTime.textContent = '00:00';
    els.recBadge.hidden = false;
    timerInt = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      els.recTime.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 250);

    requestWakeLock();
    playScroll();
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    clearInterval(timerInt);
    els.recBadge.hidden = true;
    els.body.classList.remove('recording');
    pauseScroll();
    releaseWakeLock();
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function runCountdown(done) {
    if (!settings.countdown) { done(); return; }
    let n = 3;
    els.countdown.textContent = n;
    els.countdown.hidden = false;
    els.body.classList.add('recording');
    countdownTimer = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = 0;
        els.countdown.hidden = true;
        done();
      } else {
        els.countdown.textContent = n;
      }
    }, 1000);
  }

  function cancelCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = 0;
    els.countdown.hidden = true;
    els.body.classList.remove('recording');
  }

  els.recBtn.addEventListener('click', () => {
    ensureAudioRunning();
    if (recording) { stopRecording(); return; }
    if (countdownTimer) { cancelCountdown(); return; }
    resetScroll();
    runCountdown(startRecording);
  });

  // ---------- Résultat ----------
  function extFor(type) {
    return /mp4/.test(type) ? 'mp4' : /webm/.test(type) ? 'webm' : 'mp4';
  }
  function fileName(type) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `teleprompteur-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${extFor(type)}`;
  }

  function showResult(size) {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(resultBlob);
    els.resultVideo.src = resultUrl;
    resultSaved = false;
    const mb = (resultBlob.size / 1024 / 1024).toFixed(1);
    els.resultInfo.textContent = `${size.w}×${size.h} · ${extFor(resultBlob.type).toUpperCase()} · ${mb} Mo · ${audioInfo} · v${APP_VERSION}`;
    els.result.hidden = false;
  }

  els.saveBtn.addEventListener('click', async () => {
    if (!resultBlob) return;
    const name = fileName(resultBlob.type);
    const file = new File([resultBlob], name, { type: resultBlob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        resultSaved = true;
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // l'utilisateur a fermé la feuille de partage
        console.warn('Partage impossible, téléchargement à la place', e);
      }
    }
    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    resultSaved = true;
  });

  els.discardBtn.addEventListener('click', () => {
    if (!resultSaved &&
        !confirm('Cette vidéo n\'a pas été enregistrée. La supprimer et refaire une prise ?')) return;
    els.resultVideo.pause();
    els.resultVideo.removeAttribute('src');
    els.resultVideo.load();
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    resultBlob = null;
    els.result.hidden = true;
    resetScroll();
    // Nouvelle prise : on repart d'une caméra et d'un micro tout neufs (sur iPhone, la lecture
    // de la vidéo précédente peut figer l'aperçu caméra).
    lastRestartAt = performance.now();
    startCamera();
    if (audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  });

  // ---------- Commandes ----------
  document.querySelectorAll('[data-ratio]').forEach((b) =>
    b.addEventListener('click', () => {
      if (recording) return;
      settings.ratio = b.dataset.ratio;
      save(); applySettings();
    }));

  els.flipBtn.addEventListener('click', () => {
    if (recording) return;
    settings.facing = settings.facing === 'user' ? 'environment' : 'user';
    save(); applySettings(); startCamera();
  });

  function setSpeed(v) {
    settings.speed = Math.max(1, Math.min(20, v));
    els.speedInput.value = settings.speed;
    save(); applySettings();
  }
  els.slowerBtn.addEventListener('click', () => setSpeed(settings.speed - 1));
  els.fasterBtn.addEventListener('click', () => setSpeed(settings.speed + 1));

  els.scriptBtn.addEventListener('click', () => { fillForm(); listMics(); els.sheet.hidden = false; });
  els.closeSheet.addEventListener('click', () => {
    els.sheet.hidden = true;
    resetScroll();
  });

  const bind = (input, key, parse = Number) =>
    input.addEventListener('input', () => {
      settings[key] = input.type === 'checkbox' ? input.checked : parse(input.value);
      save(); applySettings();
    });
  bind(els.scriptInput, 'script', String);
  bind(els.speedInput, 'speed');
  bind(els.sizeInput, 'size');
  bind(els.heightInput, 'height');
  bind(els.textPosInput, 'textTop');
  bind(els.lookbackInput, 'lookback');
  bind(els.opacityInput, 'opacity');
  bind(els.countdownInput, 'countdown');
  bind(els.recordMirrorInput, 'recordMirror');
  els.micSelect.addEventListener('change', () => {
    settings.micId = els.micSelect.value;
    save();
    if (!recording) startCamera();
  });
  els.voiceProcInput.addEventListener('input', () => {
    settings.voiceProc = els.voiceProcInput.checked;
    save();
    if (!recording) startCamera();
  });
  els.gainInput.addEventListener('input', () => {
    settings.micGain = Number(els.gainInput.value);
    els.gainVal.textContent = '×' + settings.micGain;
    save();
    applyGain();
  });
  els.micRefresh.addEventListener('click', () => { if (!recording) startCamera(); });
  bind(els.previewMirrorInput, 'previewMirror');
  bind(els.filterInput, 'filter');
  bind(els.smoothInput, 'smooth');
  bind(els.glowInput, 'glow');
  els.filterBtn.addEventListener('click', () => {
    settings.filter = !settings.filter;
    save(); applySettings();
  });

  // Si l'app passe en arrière-plan pendant l'enregistrement, on arrête proprement.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (recording) stopRecording();
    } else if (!stream || stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
      startCamera();
    }
  });

  // ---------- Démarrage ----------
  els.appVersion = $('appVersion');
  if (els.appVersion) els.appVersion.textContent = APP_VERSION;
  applySettings();
  fillForm();
  startCamera();
  requestAnimationFrame(renderLoop);

  // Exposé pour les tests automatisés uniquement.
  window.__tp = { cropRect, canvasSize, get mime() { return MIME; }, get gl() { return !!renderer.gl; } };
})();
