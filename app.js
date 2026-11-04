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
    opacityInput: $('opacityInput'), opacityVal: $('opacityVal'),
    countdownInput: $('countdownInput'),
    mirrorInput: $('mirrorInput'),
    formatInfo: $('formatInfo'),
    result: $('result'),
    resultVideo: $('resultVideo'),
    resultInfo: $('resultInfo'),
    saveBtn: $('saveBtn'),
    discardBtn: $('discardBtn'),
    canvas: $('recCanvas'),
  };

  // ---------- Réglages persistants ----------
  const STORE_KEY = 'teleprompteur.v1';
  const defaults = {
    script: '',
    speed: 5,
    size: 32,
    height: 40,
    opacity: 55,
    countdown: true,
    mirror: true,
    ratio: 'portrait',
    facing: 'user',
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

  // ---------- Application des réglages à l'interface ----------
  function applySettings() {
    const r = document.documentElement.style;
    r.setProperty('--prompter-size', settings.size + 'px');
    r.setProperty('--prompter-height', settings.height + '%');
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

    els.preview.classList.toggle('mirror', settings.mirror && settings.facing === 'user');
  }

  function fillForm() {
    els.scriptInput.value = settings.script;
    els.speedInput.value = settings.speed;
    els.sizeInput.value = settings.size;
    els.heightInput.value = settings.height;
    els.opacityInput.value = settings.opacity;
    els.countdownInput.checked = settings.countdown;
    els.mirrorInput.checked = settings.mirror;
    const fmt = MIME === null
      ? "Ce navigateur ne permet pas l'enregistrement vidéo."
      : `Format d'export : ${MIME ? MIME.split(';')[0].replace('video/', '').toUpperCase() : 'par défaut du navigateur'}.`;
    els.formatInfo.textContent = fmt;
  }

  // ---------- Caméra ----------
  let stream = null;

  async function startCamera() {
    stopCamera();
    els.camMessage.hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamMessage("L'accès à la caméra n'est pas disponible. Ouvrez cette page en HTTPS dans Safari.");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: settings.facing,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      els.preview.srcObject = stream;
      await els.preview.play().catch(() => {});
    } catch (err) {
      console.error(err);
      showCamMessage(
        "Impossible d'accéder à la caméra ou au micro.<br>" +
        "Vérifiez les autorisations : Réglages › Safari › Caméra / Microphone → « Autoriser ».<br><br>" +
        `<small>(${err.name || 'Erreur'})</small>`);
    }
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function showCamMessage(html) {
    els.camMessage.innerHTML = html;
    els.camMessage.hidden = false;
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
  let drawRaf = 0;
  let timerInt = 0;
  let startedAt = 0;
  let resultBlob = null;
  let resultUrl = null;
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

    const portrait = settings.ratio === 'portrait';
    const ratio = portrait ? 9 / 16 : 16 / 9;
    const size = canvasSize(v.videoWidth, v.videoHeight, portrait);
    const canvas = els.canvas;
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext('2d', { alpha: false });

    // Dessin : uniquement l'image caméra (jamais le texte).
    const draw = () => {
      const c = cropRect(v.videoWidth, v.videoHeight, ratio);
      ctx.drawImage(v, c.sx, c.sy, c.sw, c.sh, 0, 0, canvas.width, canvas.height);
      drawRaf = requestAnimationFrame(draw);
    };
    draw();

    const canvasStream = canvas.captureStream(30);
    const outStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...stream.getAudioTracks(),
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
      cancelAnimationFrame(drawRaf);
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
    const mb = (resultBlob.size / 1024 / 1024).toFixed(1);
    els.resultInfo.textContent = `${size.w}×${size.h} · ${extFor(resultBlob.type).toUpperCase()} · ${mb} Mo`;
    els.result.hidden = false;
  }

  els.saveBtn.addEventListener('click', async () => {
    if (!resultBlob) return;
    const name = fileName(resultBlob.type);
    const file = new File([resultBlob], name, { type: resultBlob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
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
  });

  els.discardBtn.addEventListener('click', () => {
    if (!confirm('Supprimer cette vidéo ? Pensez à l\'enregistrer avant si vous voulez la garder.')) return;
    els.resultVideo.pause();
    els.resultVideo.removeAttribute('src');
    els.resultVideo.load();
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    resultBlob = null;
    els.result.hidden = true;
    resetScroll();
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

  els.scriptBtn.addEventListener('click', () => { fillForm(); els.sheet.hidden = false; });
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
  bind(els.opacityInput, 'opacity');
  bind(els.countdownInput, 'countdown');
  bind(els.mirrorInput, 'mirror');

  // Si l'app passe en arrière-plan pendant l'enregistrement, on arrête proprement.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (recording) stopRecording();
    } else if (!stream || stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
      startCamera();
    }
  });

  // ---------- Démarrage ----------
  applySettings();
  fillForm();
  startCamera();

  // Exposé pour les tests automatisés uniquement.
  window.__tp = { cropRect, canvasSize, get mime() { return MIME; } };
})();
