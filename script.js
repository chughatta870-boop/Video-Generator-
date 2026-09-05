(function () {
  'use strict';

  /* ================= Constants ================= */
  const RATIOS = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [960, 960] };
  const WATERMARK_TEXT = 'M Ijaz · GHS 124/NB';
  const DEFAULT_STYLE = 'cinematic photo, realistic, soft light';
  const DB_NAME = 'videoMakerDB';
  const DB_VERSION = 1;
  const STORE = 'projects';

  /* ================= State ================= */
  let project = null;           // active project being built/edited
  let editingExistingId = null; // gallery record id if editing a saved project
  let picFiles = [];            // staged files on the "picture" tab before opening editor
  let sceneIdCounter = 0;

  /* ================= Small utilities ================= */
  function genId() { return Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function sanitizeFilename(name) {
    return (name || 'video').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
  }

  function formatDuration(sec) {
    sec = Math.round(sec || 0);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2600);
  }

  function createScene(source, caption) {
    return {
      id: 'scn' + (sceneIdCounter++),
      source,               // 'ai' | 'upload'
      caption: caption || '',
      duration: 4,
      imgSrc: null,
      imgBlob: null,
      imgEl: null,
      loading: false,
      failed: false
    };
  }

  /* ================= IndexedDB ================= */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbPut(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.createdAt - a.createdAt));
      req.onerror = () => reject(req.error);
    });
  }
  async function dbGet(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /* ================= Navigation ================= */
  function switchScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== `screen-${name}`; });
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === name));
    if (name === 'gallery') refreshGallery();
  }

  function handleShortcutParam() {
    const params = new URLSearchParams(location.search);
    const action = params.get('action');
    if (action === 'text' || action === 'picture' || action === 'gallery') switchScreen(action);
  }

  /* ================= AI image generation (Pollinations) ================= */
  async function generateSceneImage(scene) {
    scene.loading = true;
    renderSceneList();
    try {
      const [w, h] = RATIOS[project.ratio];
      const prompt = encodeURIComponent((scene.caption && scene.caption.trim() ? scene.caption.trim() : 'a beautiful scene') + ', ' + (project.style || DEFAULT_STYLE));
      const seed = Math.floor(Math.random() * 1000000);
      const url = `https://image.pollinations.ai/prompt/${prompt}?width=${w}&height=${h}&nologo=true&seed=${seed}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('generation failed');
      const blob = await res.blob();
      if (scene.imgSrc) URL.revokeObjectURL(scene.imgSrc);
      scene.imgBlob = blob;
      scene.imgSrc = URL.createObjectURL(blob);
      scene.imgEl = null;
      scene.failed = false;
    } catch (e) {
      scene.failed = true;
    } finally {
      scene.loading = false;
      renderSceneList();
    }
  }

  async function generateAllScenes() {
    const CONCURRENCY = 2;
    const scenes = project.scenes;
    let cursor = 0;
    async function worker() {
      while (cursor < scenes.length) {
        const my = cursor++;
        await generateSceneImage(scenes[my]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scenes.length) }, worker));
  }

  /* ================= Text tab ================= */
  function buildFromText() {
    const title = document.getElementById('text-title').value.trim();
    const scriptText = document.getElementById('text-script').value.trim();
    const style = document.getElementById('text-style').value;
    const ratio = document.getElementById('text-ratio').value;
    const lines = scriptText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { toast('کم از کم ایک لائن لکھیں'); return; }

    editingExistingId = null;
    project = {
      title: title || 'بلا عنوان ویڈیو',
      type: 'text',
      ratio, style,
      scenes: lines.map((line) => createScene('ai', line)),
      musicBlob: null, musicName: null,
      useMic: false, showCaptions: true, showWatermark: true,
      videoBlob: null, mimeType: null, duration: 0, thumbnail: null
    };
    openEditorUI();
    generateAllScenes();
  }

  /* ================= Picture tab ================= */
  function handlePicFilesChosen(fileList) {
    picFiles = picFiles.concat(Array.from(fileList || []));
    const btn = document.getElementById('btn-build-pic');
    btn.disabled = picFiles.length === 0;
    btn.querySelector('span').textContent = picFiles.length ? `ایڈیٹر میں کھولیں (${picFiles.length})` : 'ایڈیٹر میں کھولیں';
  }

  function buildFromPictures() {
    if (!picFiles.length) return;
    const title = document.getElementById('pic-title').value.trim();
    const ratio = document.getElementById('pic-ratio').value;
    editingExistingId = null;
    project = {
      title: title || 'بلا عنوان ویڈیو',
      type: 'picture',
      ratio, style: null,
      scenes: picFiles.map((f) => {
        const s = createScene('upload', '');
        s.imgBlob = f;
        s.imgSrc = URL.createObjectURL(f);
        return s;
      }),
      musicBlob: null, musicName: null,
      useMic: false, showCaptions: true, showWatermark: true,
      videoBlob: null, mimeType: null, duration: 0, thumbnail: null
    };
    picFiles = [];
    document.getElementById('btn-build-pic').querySelector('span').textContent = 'ایڈیٹر میں کھولیں';
    document.getElementById('btn-build-pic').disabled = true;
    openEditorUI();
  }

  /* ================= Scene editor ================= */
  function openEditorUI() {
    document.getElementById('editor-title').textContent = project.title;
    document.getElementById('music-chip').hidden = !project.musicBlob;
    document.getElementById('music-name').textContent = project.musicName || '';
    document.getElementById('mic-toggle').checked = !!project.useMic;
    document.getElementById('caption-toggle').checked = project.showCaptions !== false;
    document.getElementById('watermark-toggle').checked = project.showWatermark !== false;
    document.getElementById('btn-add-scene').textContent =
      project.type === 'text' ? '+ نیا منظر شامل کریں' : '+ مزید تصاویر شامل کریں';
    renderSceneList();
    document.getElementById('editor').hidden = false;
  }

  function renderSceneList() {
    if (!project) return;
    const wrap = document.getElementById('scene-list');
    wrap.innerHTML = project.scenes.map((s, i) => {
      let thumbInner;
      if (s.loading) thumbInner = `<div class="scene-thumb is-loading"><div class="spinner"></div></div>`;
      else if (s.imgSrc) thumbInner = `<img class="scene-thumb" src="${s.imgSrc}" alt="" />`;
      else thumbInner = `<div class="scene-thumb is-loading">${s.failed ? '⚠️' : '🖼️'}</div>`;
      const regenBtn = s.source === 'ai'
        ? `<button class="scene-regen" data-action="regen" title="تصویر بنائیں">⟳</button>`
        : '';
      return `
      <div class="scene-card" data-index="${i}">
        <div class="scene-thumb-wrap">${thumbInner}${regenBtn}</div>
        <div class="scene-body">
          <textarea class="scene-caption-input" rows="2" placeholder="اس منظر کا کیپشن / تفصیل لکھیں">${escapeHtml(s.caption)}</textarea>
          <div class="scene-controls">
            <div class="scene-duration">
              <span>⏱</span>
              <input type="range" class="scene-duration-input" min="2" max="8" step="0.5" value="${s.duration}" />
              <span class="duration-value">${s.duration}s</span>
            </div>
            <div class="scene-move-group">
              <button data-action="up" ${i === 0 ? 'disabled' : ''} title="اوپر">↑</button>
              <button data-action="down" ${i === project.scenes.length - 1 ? 'disabled' : ''} title="نیچے">↓</button>
              <button class="scene-delete" data-action="delete" title="حذف کریں">✕</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function regenerateScene(idx) {
    const s = project.scenes[idx];
    if (!s.caption || !s.caption.trim()) { toast('پہلے اس منظر کا کیپشن لکھیں'); return; }
    generateSceneImage(s);
  }

  function moveScene(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= project.scenes.length) return;
    const tmp = project.scenes[idx];
    project.scenes[idx] = project.scenes[j];
    project.scenes[j] = tmp;
    renderSceneList();
  }

  function deleteScene(idx) {
    project.scenes.splice(idx, 1);
    renderSceneList();
  }

  function addScene() {
    if (project.type === 'text') {
      project.scenes.push(createScene('ai', ''));
      renderSceneList();
    } else {
      document.getElementById('editor-pic-input').click();
    }
  }

  /* ================= Render engine ================= */
  function pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4;codecs=h264,aac',
      'video/mp4'
    ];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function hashSeed(str) {
    let h = 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (Math.abs(h) % 1000) / 1000;
  }

  function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  function drawKenBurns(ctx, img, cw, ch, t, seed) {
    const baseScale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const zoom = 1 + 0.15 * easeInOutQuad(t);
    const scale = baseScale * zoom;
    const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
    const driftX = (Math.sin(seed * 13.1) > 0 ? 1 : -1) * 26 * easeInOutQuad(t);
    const driftY = (Math.cos(seed * 7.3) > 0 ? 1 : -1) * 18 * easeInOutQuad(t);
    const dx = (cw - dw) / 2 + driftX;
    const dy = (ch - dh) / 2 + driftY;
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, dx, dy, dw, dh);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCaption(ctx, text, cw, ch) {
    if (!text || !text.trim()) return;
    ctx.direction = 'rtl';
    const fontSize = Math.round(cw * 0.044);
    ctx.font = `600 ${fontSize}px "Noto Nastaliq Urdu", sans-serif`;
    ctx.textAlign = 'center';
    const maxWidth = cw * 0.86;
    const words = text.trim().split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) lines.push(cur);

    const lineH = fontSize * 1.5;
    const boxH = lines.length * lineH + 26;
    const boxY = ch - boxH - ch * 0.06;
    ctx.fillStyle = 'rgba(10,11,16,0.55)';
    roundRect(ctx, cw * 0.05, boxY, cw * 0.9, boxH, 14);
    ctx.fill();

    ctx.fillStyle = '#F5F0E6';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, cw / 2, boxY + 13 + i * lineH));
  }

  function drawWatermark(ctx, cw, ch) {
    ctx.direction = 'ltr';
    const fontSize = Math.max(12, Math.round(cw * 0.024));
    ctx.font = `500 ${fontSize}px Inter, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(245,240,230,0.55)';
    ctx.fillText(WATERMARK_TEXT, cw * 0.035, ch - ch * 0.025);
  }

  function showRenderOverlay() {
    document.getElementById('render-overlay').hidden = false;
    document.getElementById('render-status').hidden = false;
    document.getElementById('render-result').hidden = true;
    document.getElementById('render-progress').style.width = '0%';
  }
  function setRenderStatus(text) { document.getElementById('render-status-text').textContent = text; }
  function setProgress(frac) {
    document.getElementById('render-progress').style.width = Math.min(100, Math.max(0, frac * 100)) + '%';
  }

  function showResult(blob, title, mimeType, allowSave) {
    document.getElementById('render-overlay').hidden = false;
    document.getElementById('render-status').hidden = true;
    document.getElementById('render-result').hidden = false;
    document.getElementById('result-video').src = URL.createObjectURL(blob);
    document.getElementById('btn-save').style.display = allowSave ? '' : 'none';
    document.getElementById('btn-download').onclick = () => downloadBlob(blob, title, mimeType);
    document.getElementById('btn-share').onclick = () => shareBlob(blob, title, mimeType);
  }

  async function renderProject() {
    if (!project || !project.scenes.length) { toast('کم از کم ایک منظر شامل کریں'); return; }
    const missing = project.scenes.filter((s) => !s.imgSrc);
    if (missing.length) { toast('کچھ مناظر کی تصاویر ابھی تیار نہیں — انتظار کریں یا دوبارہ بنائیں'); return; }

    showRenderOverlay();
    setRenderStatus('تیاری ہو رہی ہے…');

    try { await document.fonts.ready; } catch (e) { /* ignore */ }

    try {
      for (const s of project.scenes) {
        if (!s.imgEl) s.imgEl = await loadImage(s.imgSrc);
      }
    } catch (e) {
      toast('تصویر لوڈ نہیں ہو سکی — دوبارہ کوشش کریں');
      document.getElementById('render-overlay').hidden = true;
      return;
    }

    const [cw, ch] = RATIOS[project.ratio] || RATIOS['9:16'];
    const canvas = document.getElementById('render-canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');

    let audioCtx = null, dest = null, musicEl = null, micStream = null;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      dest = audioCtx.createMediaStreamDestination();

      if (project.musicBlob) {
        musicEl = new Audio();
        musicEl.src = URL.createObjectURL(project.musicBlob);
        musicEl.loop = true;
        const src = audioCtx.createMediaElementSource(musicEl);
        const gain = audioCtx.createGain();
        gain.gain.value = 0.5;
        src.connect(gain).connect(dest);
        try { await musicEl.play(); } catch (e) { /* ignore autoplay block */ }
      }

      if (project.useMic) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const src = audioCtx.createMediaStreamSource(micStream);
          const gain = audioCtx.createGain();
          gain.gain.value = 1.0;
          src.connect(gain).connect(dest);
        } catch (e) {
          toast('مائیک کی اجازت نہیں ملی — بغیر آواز کے جاری ہے');
        }
      }
      if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (e) {} }
    } catch (e) {
      // audio setup failed entirely; continue with a silent video
    }

    const canvasStream = canvas.captureStream(25);
    const tracks = canvasStream.getVideoTracks().slice();
    if (dest) tracks.push(...dest.stream.getAudioTracks());
    const combined = new MediaStream(tracks);

    const mimeType = pickMimeType();
    const chunks = [];
    const options = mimeType ? { mimeType, videoBitsPerSecond: 2600000 } : {};
    let recorder;
    try {
      recorder = new MediaRecorder(combined, options);
    } catch (e) {
      toast('اس براؤزر میں ویڈیو ریکارڈنگ سپورٹ نہیں ہے');
      document.getElementById('render-overlay').hidden = true;
      return;
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const stopEverything = () => {
      if (musicEl) musicEl.pause();
      if (micStream) micStream.getTracks().forEach((t) => t.stop());
      canvasStream.getTracks().forEach((t) => t.stop());
      if (audioCtx) audioCtx.close().catch(() => {});
    };

    const recordedPromise = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
    });

    recorder.start(250);
    setRenderStatus('ویڈیو بن رہی ہے…');

    const totalDurationMs = project.scenes.reduce((a, s) => a + s.duration, 0) * 1000;
    let elapsedTotal = 0;
    let thumbCaptured = null;

    for (let i = 0; i < project.scenes.length; i++) {
      const scene = project.scenes[i];
      const next = project.scenes[i + 1];
      const seed = hashSeed(scene.id);
      const durMs = scene.duration * 1000;
      const transitionMs = next ? 450 : 0;

      await new Promise((resolve) => {
        const start = performance.now();
        function frame(now) {
          const elapsed = now - start;
          const t = Math.min(1, elapsed / durMs);
          ctx.clearRect(0, 0, cw, ch);
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, cw, ch);
          drawKenBurns(ctx, scene.imgEl, cw, ch, t, seed);

          if (next && elapsed > durMs - transitionMs) {
            const a = Math.min(1, (elapsed - (durMs - transitionMs)) / transitionMs);
            ctx.globalAlpha = a;
            drawKenBurns(ctx, next.imgEl, cw, ch, 0, hashSeed(next.id));
            ctx.globalAlpha = 1;
          }

          if (project.showCaptions) drawCaption(ctx, scene.caption, cw, ch);
          if (project.showWatermark) drawWatermark(ctx, cw, ch);

          if (!thumbCaptured && i === 0 && elapsed > 60) {
            thumbCaptured = canvas.toDataURL('image/jpeg', 0.6);
          }

          setProgress((elapsedTotal + Math.min(elapsed, durMs)) / totalDurationMs);

          if (elapsed < durMs) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      });
      elapsedTotal += durMs;
    }

    await new Promise((r) => setTimeout(r, 300));
    recorder.stop();
    const blob = await recordedPromise;
    stopEverything();

    project.videoBlob = blob;
    project.mimeType = mimeType || 'video/webm';
    project.duration = totalDurationMs / 1000;
    project.thumbnail = thumbCaptured || canvas.toDataURL('image/jpeg', 0.6);

    showResult(project.videoBlob, project.title, project.mimeType, true);
  }

  /* ================= Save / Download / Share ================= */
  async function saveCurrentProject() {
    if (!project || !project.videoBlob) { toast('پہلے ویڈیو بنائیں'); return; }
    const id = editingExistingId || genId();
    const record = {
      id,
      title: project.title || 'بلا عنوان ویڈیو',
      type: project.type,
      ratio: project.ratio,
      style: project.style || null,
      videoBlob: project.videoBlob,
      mimeType: project.mimeType,
      duration: project.duration,
      thumbnail: project.thumbnail,
      createdAt: Date.now(),
      scenes: project.scenes.map((s) => ({
        id: s.id, source: s.source, caption: s.caption, duration: s.duration, imgBlob: s.imgBlob || null
      })),
      musicBlob: project.musicBlob || null,
      musicName: project.musicName || null,
      useMic: !!project.useMic,
      showCaptions: project.showCaptions !== false,
      showWatermark: project.showWatermark !== false
    };
    await dbPut(record);
    editingExistingId = id;
    toast('ویڈیو محفوظ ہو گئی ✅');
    refreshGallery();
  }

  function downloadBlob(blob, title, mimeType) {
    if (!blob) { toast('ویڈیو دستیاب نہیں'); return; }
    const ext = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = sanitizeFilename(title) + '.' + ext;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 4000);
  }

  async function shareBlob(blob, title, mimeType) {
    if (!blob) { toast('ویڈیو دستیاب نہیں'); return; }
    const ext = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    try {
      const file = new File([blob], sanitizeFilename(title) + '.' + ext, { type: mimeType || 'video/webm' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: title || 'ویڈیو' });
        return;
      }
    } catch (e) { /* fall through to message */ }
    toast('اس براؤزر میں فائل شیئرنگ سپورٹ نہیں — پہلے ڈاؤن لوڈ کریں');
  }

  /* ================= Gallery ================= */
  async function refreshGallery() {
    let list = [];
    try { list = await dbGetAll(); } catch (e) { list = []; }
    const wrap = document.getElementById('gallery-list');
    const empty = document.getElementById('gallery-empty');
    if (!list.length) { wrap.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    wrap.innerHTML = list.map((rec) => `
      <div class="gallery-card" data-id="${rec.id}">
        <img class="gallery-thumb" src="${rec.thumbnail || ''}" alt="" />
        <div class="gallery-info">
          <h3>${escapeHtml(rec.title || 'بلا عنوان')}</h3>
          <p>${formatDuration(rec.duration)} · ${new Date(rec.createdAt).toLocaleDateString('ur-PK')}</p>
        </div>
        <div class="gallery-actions">
          <button data-action="play" title="چلائیں">▶</button>
          <button data-action="download" title="ڈاؤن لوڈ">⬇</button>
          <button data-action="share" title="شیئر">↗</button>
          <button data-action="edit" title="ترمیم">✎</button>
          <button class="danger" data-action="delete" title="حذف کریں">🗑</button>
        </div>
      </div>`).join('');
  }

  async function editProject(id) {
    const rec = await dbGet(id);
    if (!rec) return;
    editingExistingId = id;
    project = {
      title: rec.title,
      type: rec.type,
      ratio: rec.ratio,
      style: rec.style || DEFAULT_STYLE,
      scenes: (rec.scenes || []).map((s) => ({
        id: s.id, source: s.source, caption: s.caption, duration: s.duration || 4,
        imgBlob: s.imgBlob || null,
        imgSrc: s.imgBlob ? URL.createObjectURL(s.imgBlob) : null,
        imgEl: null, loading: false, failed: !s.imgBlob
      })),
      musicBlob: rec.musicBlob || null,
      musicName: rec.musicName || null,
      useMic: !!rec.useMic,
      showCaptions: rec.showCaptions !== false,
      showWatermark: rec.showWatermark !== false,
      videoBlob: null, mimeType: null, duration: 0, thumbnail: null
    };
    document.getElementById('render-overlay').hidden = true;
    openEditorUI();
  }

  /* ================= Service worker & init ================= */
  function registerSW() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
    }
  }

  function bindEvents() {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchScreen(btn.dataset.nav));
    });

    document.getElementById('btn-help').onclick = () => { document.getElementById('help-sheet').hidden = false; };
    document.getElementById('help-close').onclick = () => { document.getElementById('help-sheet').hidden = true; };

    document.getElementById('btn-build-text').onclick = buildFromText;

    document.getElementById('pic-input').addEventListener('change', (e) => {
      handlePicFilesChosen(e.target.files);
      e.target.value = '';
    });
    document.getElementById('btn-build-pic').onclick = buildFromPictures;

    document.getElementById('editor-close').onclick = () => { document.getElementById('editor').hidden = true; };
    document.getElementById('btn-add-scene').onclick = addScene;
    document.getElementById('editor-render').onclick = renderProject;

    document.getElementById('editor-pic-input')?.addEventListener('change', (e) => {
      Array.from(e.target.files || []).forEach((f) => {
        const s = createScene('upload', '');
        s.imgBlob = f;
        s.imgSrc = URL.createObjectURL(f);
        project.scenes.push(s);
      });
      renderSceneList();
      e.target.value = '';
    });

    document.getElementById('scene-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const idx = Number(btn.closest('.scene-card').dataset.index);
      const action = btn.dataset.action;
      if (action === 'regen') regenerateScene(idx);
      else if (action === 'up') moveScene(idx, -1);
      else if (action === 'down') moveScene(idx, 1);
      else if (action === 'delete') deleteScene(idx);
    });
    document.getElementById('scene-list').addEventListener('input', (e) => {
      const card = e.target.closest('.scene-card');
      if (!card) return;
      const idx = Number(card.dataset.index);
      if (e.target.classList.contains('scene-caption-input')) {
        project.scenes[idx].caption = e.target.value;
      } else if (e.target.classList.contains('scene-duration-input')) {
        project.scenes[idx].duration = Number(e.target.value);
        card.querySelector('.duration-value').textContent = e.target.value + 's';
      }
    });

    document.getElementById('music-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      project.musicBlob = f;
      project.musicName = f.name;
      document.getElementById('music-chip').hidden = false;
      document.getElementById('music-name').textContent = f.name;
      e.target.value = '';
    });
    document.getElementById('music-remove').onclick = () => {
      project.musicBlob = null;
      project.musicName = null;
      document.getElementById('music-chip').hidden = true;
    };
    document.getElementById('mic-toggle').onchange = (e) => { project.useMic = e.target.checked; };
    document.getElementById('caption-toggle').onchange = (e) => { project.showCaptions = e.target.checked; };
    document.getElementById('watermark-toggle').onchange = (e) => { project.showWatermark = e.target.checked; };

    document.getElementById('btn-save').onclick = saveCurrentProject;
    document.getElementById('btn-render-close').onclick = () => {
      document.getElementById('render-overlay').hidden = true;
      refreshGallery();
    };

    document.getElementById('gallery-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const card = e.target.closest('.gallery-card');
      const id = card.dataset.id;
      const rec = await dbGet(id);
      if (!rec) return;
      const action = btn.dataset.action;
      if (action === 'play') showResult(rec.videoBlob, rec.title, rec.mimeType, false);
      else if (action === 'download') downloadBlob(rec.videoBlob, rec.title, rec.mimeType);
      else if (action === 'share') shareBlob(rec.videoBlob, rec.title, rec.mimeType);
      else if (action === 'edit') editProject(id);
      else if (action === 'delete') {
        if (confirm('کیا یہ ویڈیو حذف کرنی ہے؟')) {
          await dbDelete(id);
          toast('ویڈیو حذف کر دی گئی');
          refreshGallery();
        }
      }
    });
  }

  function init() {
    bindEvents();
    registerSW();
    handleShortcutParam();
    refreshGallery();
  }

  init();
})();
