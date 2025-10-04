// ===== elementos =====
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const btnStart = document.getElementById('btnStart');
const startScr = document.getElementById('start');

const btnFlip  = document.getElementById('btnFlip');
const btnShot  = document.getElementById('btnShot');
const btnAgain = document.getElementById('btnAgain');
const btnSave  = document.getElementById('btnSave');

const btnRec      = document.getElementById('btnRec');
const btnSaveVid  = document.getElementById('btnSaveVid');
const btnAgainVid = document.getElementById('btnAgainVid');

const shootArea       = document.getElementById('shootArea');
const resultArea      = document.getElementById('resultArea');
const resultVideoArea = document.getElementById('resultVideoArea');

const overlayImg = document.getElementById('overlay');

const recBadge = document.getElementById('recBadge');
const recClock = document.getElementById('recClock');

// ===== estado =====
let stream, facing = 'environment';
let lastBlob = null;       // foto
let lastVideoBlob = null;  // vídeo

// gravação
let workCanvas, wctx, drawRAF = 0;
let mediaRecorder = null, chunks = [], recStartTs = 0;
let afterStopAction = null; // 'save' | 'discard' | null

// user agent helpers
const ua = navigator.userAgent || '';
const isAndroid = /Android/i.test(ua);
const isIOS = /iPad|iPhone|iPod/i.test(ua);
const isInApp = /(FBAN|FBAV|Instagram|Line|Twitter|Snapchat|TikTok)/i.test(ua);

// ===== CONFIG DINÂMICA BÁSICA =====
// permite sobrepor pela URL: ?capa=img.png&moldura=frame.png
(function aplicarConfig(){
  const q = new URLSearchParams(location.search);
  const capa  = q.get('capa')    || 'tela-inicial.png';
  const mold  = q.get('moldura') || 'moldura.png';

  startScr.style.backgroundImage = `url("${capa}")`;

  overlayImg.src = mold;
  overlayImg.onload = ()=> overlayImg.classList.remove('hidden');
  overlayImg.onerror = ()=> overlayImg.classList.add('hidden');
})();

// ===== fluxo inicial =====
async function openCameraFromStart() {
  if (startScr.classList.contains('busy')) return;
  startScr.classList.add('busy');
  try {
    await startCamera();
    startScr.classList.add('hidden');
  } catch (e) {
    alert('Não foi possível acessar a câmera. Verifique permissões.');
  } finally {
    startScr.classList.remove('busy');
  }
}
btnStart.addEventListener('click', (ev) => { ev.stopPropagation(); openCameraFromStart(); });
startScr.addEventListener('click', openCameraFromStart);

// ===== câmera =====
async function startCamera(){
  if (stream) stream.getTracks().forEach(t=>t.stop());
  const constraints = {
    audio:true, // áudio para vídeo
    video:{
      facingMode: { ideal: facing },
      width: { ideal: 1920 },
      height:{ ideal: 1080 },
      aspectRatio: { ideal: 9/16 }
    }
  };
  const newStream = await navigator.mediaDevices.getUserMedia(constraints);
  stream = newStream;
  video.srcObject = stream;
  video.classList.toggle('mirror', facing === 'user');
  await video.play();
}
btnFlip.onclick = async () => {
  facing = (facing === 'user') ? 'environment' : 'user';
  await startCamera();
};

// ===== FOTO =====
btnShot.onclick = async () => {
  if (!video.videoWidth) return;
  const W = canvas.width, H = canvas.height;
  const vw = video.videoWidth, vh = video.videoHeight;
  const { sx, sy, sw, sh } = coverCrop(vw, vh, W, H);

  ctx.clearRect(0,0,W,H);
  if (facing === 'user') {
    ctx.save(); ctx.translate(W,0); ctx.scale(-1,1);
    ctx.drawImage(video, sx,sy,sw,sh, 0,0,W,H); ctx.restore();
  } else {
    ctx.drawImage(video, sx,sy,sw,sh, 0,0,W,H);
  }
  await drawOverlayOnce(overlayImg, ctx, W, H);
  lastBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.95));

  // UI
  shootArea.classList.add('hidden');
  resultArea.classList.remove('hidden');
};

btnAgain.onclick = ()=>{
  lastBlob = null;
  resultArea.classList.add('hidden');
  shootArea.classList.remove('hidden');
};

btnSave.onclick = async ()=>{
  if (!lastBlob) return;
  await saveBlobSmart(lastBlob, `foto-${Date.now()}.jpg`, 'image/jpeg');
};

// ===== VÍDEO (com moldura) =====
btnRec.onclick = async ()=>{
  if (!video.videoWidth) return;

  // canvas de composição (mesma resolução do canvas final)
  workCanvas = document.createElement('canvas');
  workCanvas.width = canvas.width;
  workCanvas.height = canvas.height;
  wctx = workCanvas.getContext('2d');

  // stream de vídeo do canvas
  const fps = 30;
  const canvasStream = workCanvas.captureStream ? workCanvas.captureStream(fps) : null;
  if (!canvasStream){ alert('Seu navegador não suporta gravação com moldura.'); return; }

  // anexa áudio da câmera
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) canvasStream.addTrack(audioTrack);

  // melhor MIME suportado
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4' // Safari moderno
  ];
  let mime = '';
  for (const cand of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(cand)) { mime = cand; break; }
  }

  chunks = [];
  mediaRecorder = new MediaRecorder(canvasStream, mime ? { mimeType: mime } : undefined);
  mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = async ()=> {
    lastVideoBlob = new Blob(chunks, { type: mediaRecorder.mimeType || 'video/webm' });
    stopDrawLoop();
    recBadge.classList.add('hidden');

    // se veio de "Salvar" ou "Refazer" durante a gravação
    if (afterStopAction === 'save') {
      afterStopAction = null;
      const ext = pickVideoExtension(mediaRecorder?.mimeType);
      await saveBlobSmart(lastVideoBlob, `video-${Date.now()}.${ext}`, mediaRecorder?.mimeType || 'video/webm');
      // fica na tela de resultado caso queira salvar de novo ou refazer
      resultVideoArea.classList.remove('hidden');
    } else if (afterStopAction === 'discard') {
      afterStopAction = null;
      lastVideoBlob = null;
      resultVideoArea.classList.add('hidden');
      shootArea.classList.remove('hidden');
    } else {
      // fluxo normal (parou por outro motivo): mostra Salvar/Refazer
      resultVideoArea.classList.remove('hidden');
    }
  };

  // UI: ao iniciar gravação já mostra SALVAR/REFAZER (como a foto)
  shootArea.classList.add('hidden');
  resultArea.classList.add('hidden');
  resultVideoArea.classList.remove('hidden');
  recBadge.classList.remove('hidden');

  recStartTs = Date.now();
  updateRecClock();
  mediaRecorder.start(1000);
  startDrawLoop();
};

// salvar vídeo (se ainda estiver gravando, finaliza e salva)
btnSaveVid.onclick = async ()=>{
  if (mediaRecorder?.state === 'recording') {
    afterStopAction = 'save';
    btnSaveVid.disabled = true; // evita duplo clique
    mediaRecorder.stop();
    setTimeout(()=> btnSaveVid.disabled = false, 1200);
    return;
  }
  if (!lastVideoBlob) return;
  const ext = pickVideoExtension(mediaRecorder?.mimeType);
  await saveBlobSmart(lastVideoBlob, `video-${Date.now()}.${ext}`, mediaRecorder?.mimeType || 'video/webm');
};

// refazer vídeo (se estiver gravando, apenas descarta)
btnAgainVid.onclick = ()=>{
  if (mediaRecorder?.state === 'recording') {
    afterStopAction = 'discard';
    mediaRecorder.stop();
    return;
  }
  lastVideoBlob = null;
  resultVideoArea.classList.add('hidden');
  shootArea.classList.remove('hidden');
};

// ===== desenho contínuo do vídeo (composição com moldura) =====
function startDrawLoop(){
  const W = workCanvas.width, H = workCanvas.height;
  const vw = video.videoWidth, vh = video.videoHeight;
  const crop = coverCrop(vw, vh, W, H);

  const draw = ()=>{
    wctx.clearRect(0,0,W,H);
    if (facing === 'user') {
      wctx.save(); wctx.translate(W,0); wctx.scale(-1,1);
      wctx.drawImage(video, crop.sx,crop.sy,crop.sw,crop.sh, 0,0,W,H);
      wctx.restore();
    } else {
      wctx.drawImage(video, crop.sx,crop.sy,crop.sw,crop.sh, 0,0,W,H);
    }
    if (overlayImg && !overlayImg.classList.contains('hidden') && overlayImg.complete) {
      wctx.drawImage(overlayImg, 0,0, W,H);
    }
    drawRAF = requestAnimationFrame(draw);
  };
  drawRAF = requestAnimationFrame(draw);
}
function stopDrawLoop(){ if (drawRAF) cancelAnimationFrame(drawRAF); drawRAF = 0; }

// ===== util =====
function coverCrop(vw, vh, W, H){
  const videoRatio = vw / vh, canvasRatio = W / H;
  let sx, sy, sw, sh;
  if (canvasRatio > videoRatio){
    sw = vw; sh = vw / canvasRatio; sx = 0; sy = (vh - sh) / 2;
  } else {
    sh = vh; sw = vh * canvasRatio; sy = 0; sx = (vw - sw) / 2;
  }
  return { sx, sy, sw, sh };
}

function drawOverlayOnce(img, ctx, W, H){
  return new Promise((resolve)=>{
    if (!img || img.classList.contains('hidden')) return resolve();
    if (img.complete && img.naturalWidth) { ctx.drawImage(img,0,0,W,H); return resolve(); }
    const tmp = new Image();
    tmp.onload = ()=>{ ctx.drawImage(tmp,0,0,W,H); resolve(); };
    tmp.onerror = ()=>resolve();
    tmp.src = img.src;
  });
}

function pickVideoExtension(mime){
  if (!mime) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  return 'webm';
}

async function saveBlobSmart(blob, filename, mime){
  const doDownload = () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  // share (in-app)
  if (isInApp && navigator.canShare && window.File) {
    try {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Arquivo' });
        return;
      }
    } catch {}
  }

  // Android file picker
  if (isAndroid && 'showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Arquivo', accept: { [mime]: [`.${filename.split('.').pop()}`] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch {}
  }

  // share (geral)
  if (navigator.canShare && window.File) {
    try {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Arquivo' });
        return;
      }
    } catch {}
  }

  // iOS fallback (abre em aba)
  if (isIOS) {
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) window.location.href = url;
    setTimeout(()=> URL.revokeObjectURL(url), 15000);
    return;
  }

  doDownload();
}

/* relógio REC */
let clockInt = 0;
function updateRecClock(){
  clearInterval(clockInt);
  const fmt = (n)=> String(n).padStart(2,'0');
  const tick = ()=>{
    const s = Math.floor((Date.now() - recStartTs)/1000);
    const mm = Math.floor(s/60), ss = s%60;
    recClock.textContent = `${fmt(mm)}:${fmt(ss)}`;
  };
  tick();
  clockInt = setInterval(tick, 1000);
}
