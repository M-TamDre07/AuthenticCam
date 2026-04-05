/* ============================================
   AuthenticCam Pro - script.js
   Full Feature Engine v2.0
   ============================================ */

// ────────────────────────────────────────────
// STATE
// ────────────────────────────────────────────
const state = {
    mode: 'photo',          // 'photo' | 'video'
    facingMode: 'environment',
    stream: null,
    recording: false,
    mediaRecorder: null,
    recordedChunks: [],
    recSeconds: 0,
    recInterval: null,
    logoImage: null,
    currentFilter: {
        brightness: 0,
        contrast: 0,
        saturation: 0,
        sharpness: 0,
        warmth: 0
    },
    animFrame: null
};

// ────────────────────────────────────────────
// DOM REFS
// ────────────────────────────────────────────
const video       = document.getElementById('video');
const canvas      = document.getElementById('canvas');
const liveCanvas  = document.getElementById('liveCanvas');
const liveCtx     = liveCanvas.getContext('2d');

// ────────────────────────────────────────────
// INIT
// ────────────────────────────────────────────
async function initCamera() {
    if (state.stream) {
        state.stream.getTracks().forEach(t => t.stop());
    }

    const q = parseInt(document.getElementById('quality').value);

    try {
        const constraints = {
            video: {
                width:      { ideal: q },
                height:     { ideal: Math.round(q * 0.75) },
                facingMode: state.facingMode
            },
            audio: state.mode === 'video'
        };

        state.stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = state.stream;

        video.onloadedmetadata = () => {
            document.getElementById('camResolution').textContent =
                `${video.videoWidth} × ${video.videoHeight}`;
        };

    } catch (err) {
        showToast('❌ Gagal akses kamera. Cek izin.', 'error');
        console.error(err);
    }
}

// ────────────────────────────────────────────
// CAMERA CONTROLS
// ────────────────────────────────────────────
function flipCamera() {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    initCamera();
}

document.getElementById('quality').addEventListener('change', initCamera);

// ────────────────────────────────────────────
// MODE SWITCH
// ────────────────────────────────────────────
function switchMode(mode) {
    state.mode = mode;
    document.getElementById('tabPhoto').classList.toggle('active', mode === 'photo');
    document.getElementById('tabVideo').classList.toggle('active', mode === 'video');

    const snapBtn  = document.getElementById('snapBtn');
    const videoBtn = document.getElementById('videoBtn');
    const lc       = document.getElementById('liveCanvas');

    if (mode === 'photo') {
        snapBtn.style.display  = 'flex';
        videoBtn.style.display = 'none';
        lc.style.display       = 'none';
        cancelAnimationFrame(state.animFrame);
    } else {
        snapBtn.style.display  = 'none';
        videoBtn.style.display = 'flex';
        lc.style.display       = 'block';
        startLiveOverlay();
    }

    initCamera();
}

// ────────────────────────────────────────────
// GENERATE SIGNATURE
// ────────────────────────────────────────────
function generateSignature() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let sig = 'AC-';
    for (let i = 0; i < 4; i++) sig += chars[Math.floor(Math.random() * chars.length)];
    sig += '-';
    for (let i = 0; i < 4; i++) sig += chars[Math.floor(Math.random() * chars.length)];
    return sig;
}

// ────────────────────────────────────────────
// WATERMARK DRAWING ENGINE
// ────────────────────────────────────────────
function drawWatermark(ctx, cw, ch, opts = {}) {
    const {
        owner     = 'Original Creator',
        info      = 'General Asset',
        timestamp = new Date().toLocaleString('id-ID'),
        signature = generateSignature(),
        style     = 'dark',
        position  = 'bottom-left',
        opacity   = 0.8,
        logoImg   = null
    } = opts;

    const base    = Math.min(cw, ch);
    const fSize   = base * 0.030;
    const fSmall  = base * 0.022;
    const pad     = base * 0.025;

    // Panel dimensions
    const panelW  = cw * 0.62;
    const panelH  = fSize * 3.8;
    const margin  = base * 0.02;

    // Position mapping
    let px, py;
    switch (position) {
        case 'top-left':     px = margin;           py = margin; break;
        case 'top-right':    px = cw - panelW - margin; py = margin; break;
        case 'bottom-right': px = cw - panelW - margin; py = ch - panelH - margin; break;
        case 'center':       px = null; py = null; break;
        default:             px = margin;           py = ch - panelH - margin;
    }

    // Panel background color based on style
    const styleMap = {
        dark:        { bg: `rgba(0,0,0,${opacity * 0.75})`,    text: 'rgba(255,255,255,0.95)',  sub: 'rgba(255,255,255,0.6)',  accent: '#00d4ff' },
        light:       { bg: `rgba(255,255,255,${opacity * 0.85})`, text: 'rgba(0,0,0,0.9)',     sub: 'rgba(0,0,0,0.5)',        accent: '#0077aa' },
        transparent: { bg: `rgba(0,0,0,${opacity * 0.35})`,    text: 'rgba(255,255,255,0.85)', sub: 'rgba(255,255,255,0.5)',  accent: '#00ff9d' },
        colored:     { bg: `rgba(0,30,60,${opacity * 0.88})`,  text: 'rgba(0,212,255,1)',      sub: 'rgba(0,212,255,0.6)',    accent: '#00ff9d' }
    };
    const s = styleMap[style] || styleMap.dark;

    ctx.save();

    if (position === 'center') {
        // Diagonal repeating watermark
        ctx.globalAlpha = opacity * 0.18;
        ctx.fillStyle   = '#ffffff';
        ctx.font        = `bold ${base * 0.04}px Outfit, sans-serif`;
        ctx.textAlign   = 'center';
        ctx.translate(cw / 2, ch / 2);
        ctx.rotate(-Math.PI / 6);
        const diagText  = `${owner} · AuthenticCam`;
        const repeatX   = Math.ceil(cw / (base * 0.4)) + 2;
        const repeatY   = Math.ceil(ch / (base * 0.12)) + 2;
        for (let iy = -repeatY; iy < repeatY; iy++) {
            for (let ix = -repeatX; ix < repeatX; ix++) {
                ctx.fillText(diagText, ix * cw * 0.6, iy * base * 0.14);
            }
        }
        ctx.restore();
        ctx.save();
    }

    // Panel
    if (position !== 'center') {
        // Draw panel
        ctx.globalAlpha = 1;
        ctx.fillStyle   = s.bg;
        const r = base * 0.012;
        roundRect(ctx, px, py, panelW, panelH, r);
        ctx.fill();

        // Accent bar (left side)
        ctx.fillStyle   = s.accent;
        roundRect(ctx, px, py, 3, panelH, [r, 0, 0, r]);
        ctx.fill();

        // Logo
        const logoSize = panelH * 0.55;
        let textOffsetX = px + pad * 1.5;
        if (logoImg) {
            try {
                const logoX = px + pad;
                const logoY = py + (panelH - logoSize) / 2;
                ctx.save();
                ctx.globalAlpha = opacity;
                ctx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);
                ctx.restore();
                textOffsetX = logoX + logoSize + pad;
            } catch (e) {}
        }

        // Shadow for text
        ctx.shadowColor  = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur   = 4;

        // Owner name
        ctx.fillStyle    = s.text;
        ctx.textAlign    = 'left';
        ctx.font         = `bold ${fSize}px Outfit, sans-serif`;
        ctx.globalAlpha  = 1;
        const ownerTxt   = truncateText(ctx, owner, panelW - (textOffsetX - px) - pad);
        ctx.fillText(ownerTxt, textOffsetX, py + panelH * 0.44);

        // Info + Date
        ctx.fillStyle    = s.sub;
        ctx.font         = `${fSmall}px 'Fira Code', monospace`;
        ctx.globalAlpha  = 0.85;
        const metaLine   = `${info}  ·  ${timestamp}`;
        const metaTxt    = truncateText(ctx, metaLine, panelW - (textOffsetX - px) - pad);
        ctx.fillText(metaTxt, textOffsetX, py + panelH * 0.72);

        // Signature (bottom right corner)
        ctx.globalAlpha  = 0.6;
        ctx.fillStyle    = s.accent;
        ctx.textAlign    = 'right';
        ctx.font         = `bold ${fSmall * 0.85}px 'Fira Code', monospace`;
        ctx.fillText(signature, cw - margin, ch - margin * 0.6);

        ctx.shadowBlur   = 0;
    }

    ctx.restore();
    return signature;
}

function roundRect(ctx, x, y, w, h, r) {
    if (typeof r === 'number') r = [r, r, r, r];
    ctx.beginPath();
    ctx.moveTo(x + r[0], y);
    ctx.lineTo(x + w - r[1], y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r[1]);
    ctx.lineTo(x + w, y + h - r[2]);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r[2], y + h);
    ctx.lineTo(x + r[3], y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r[3]);
    ctx.lineTo(x, y + r[0]);
    ctx.quadraticCurveTo(x, y, x + r[0], y);
    ctx.closePath();
}

function truncateText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (ctx.measureText(t + '…').width > maxWidth && t.length > 0) t = t.slice(0, -1);
    return t + '…';
}

// ────────────────────────────────────────────
// IMAGE ENHANCEMENT ENGINE
// ────────────────────────────────────────────
function applyEnhancements(ctx, cw, ch) {
    const f  = state.currentFilter;
    if (f.brightness === 0 && f.contrast === 0 && f.saturation === 0 && f.warmth === 0 && f.sharpness === 0) return;

    const imageData = ctx.getImageData(0, 0, cw, ch);
    const d = imageData.data;
    const len = d.length;

    const brightness = f.brightness * 2.55;       // -255 to 255
    const contrast   = (f.contrast + 100) / 100;  // 0 to 2
    const satFactor  = (f.saturation + 100) / 100;
    const warmth     = f.warmth * 1.5;             // color shift

    for (let i = 0; i < len; i += 4) {
        let r = d[i], g = d[i+1], b = d[i+2];

        // Brightness
        r += brightness; g += brightness; b += brightness;

        // Contrast (around midpoint 128)
        r = (r - 128) * contrast + 128;
        g = (g - 128) * contrast + 128;
        b = (b - 128) * contrast + 128;

        // Warmth (shift red/blue channels)
        r += warmth * 0.5;
        b -= warmth * 0.3;
        g += warmth * 0.1;

        // Saturation via luminance
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = lum + satFactor * (r - lum);
        g = lum + satFactor * (g - lum);
        b = lum + satFactor * (b - lum);

        d[i]   = clamp(r);
        d[i+1] = clamp(g);
        d[i+2] = clamp(b);
    }

    ctx.putImageData(imageData, 0, 0);

    // Sharpening via unsharp mask (convolution)
    if (f.sharpness > 0) {
        applySharpening(ctx, cw, ch, f.sharpness / 100);
    }
}

function applySharpening(ctx, w, h, amount) {
    const src = ctx.getImageData(0, 0, w, h);
    const dst = ctx.getImageData(0, 0, w, h);
    const s   = src.data;
    const d   = dst.data;
    const str = amount * 1.5;

    // Laplacian sharpening kernel
    const kernel = [
        0, -str, 0,
        -str, 1 + 4 * str, -str,
        0, -str, 0
    ];

    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const idx = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) {
                let val = 0;
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const si = ((y + ky) * w + (x + kx)) * 4 + c;
                        val += s[si] * kernel[(ky + 1) * 3 + (kx + 1)];
                    }
                }
                d[idx + c] = clamp(val);
            }
            d[idx + 3] = s[idx + 3];
        }
    }
    ctx.putImageData(dst, 0, 0);
}

function clamp(v) { return Math.min(255, Math.max(0, Math.round(v))); }

// ────────────────────────────────────────────
// PHOTO CAPTURE
// ────────────────────────────────────────────
function capturePhoto() {
    const ctx       = canvas.getContext('2d');
    const owner     = document.getElementById('ownerName').value || 'Original Creator';
    const info      = document.getElementById('assetInfo').value || 'General Asset';
    const timestamp = new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    const signature = generateSignature();
    const position  = document.getElementById('wmPosition').value;
    const wmStyle   = document.getElementById('wmStyle').value;
    const opacity   = parseInt(document.getElementById('wmOpacity').value) / 100;

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;

    // Draw video frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Apply enhancement
    applyEnhancements(ctx, canvas.width, canvas.height);

    // Draw watermark
    drawWatermark(ctx, canvas.width, canvas.height, {
        owner, info, timestamp, signature,
        style: wmStyle, position, opacity,
        logoImg: state.logoImage
    });

    // Export
    canvas.toBlob((blob) => {
        const url      = URL.createObjectURL(blob);
        const preview  = document.getElementById('photoPreview');
        const dlLink   = document.getElementById('downloadLink');

        preview.src            = url;
        dlLink.href            = url;
        dlLink.download        = `AuthenticCam_${signature}.png`;

        // Fill metadata display
        document.getElementById('assetMeta').innerHTML = `
            <div class="meta-row"><span class="meta-label">OWNER</span><span>${escHtml(owner)}</span></div>
            <div class="meta-row"><span class="meta-label">ASSET</span><span>${escHtml(info)}</span></div>
            <div class="meta-row"><span class="meta-label">DATE</span><span>${timestamp}</span></div>
            <div class="meta-row"><span class="meta-label">SIG ID</span><span>${signature}</span></div>
            <div class="meta-row"><span class="meta-label">RES</span><span>${canvas.width} × ${canvas.height}px</span></div>
        `;

        const resultArea = document.getElementById('resultArea');
        resultArea.style.display = 'block';
        resultArea.scrollIntoView({ behavior: 'smooth' });

        showToast('✅ Foto berhasil diverifikasi!', 'success');
    }, 'image/png');
}

// ────────────────────────────────────────────
// VIDEO RECORDING
// ────────────────────────────────────────────
function startLiveOverlay() {
    const draw = () => {
        if (!video.videoWidth) { state.animFrame = requestAnimationFrame(draw); return; }

        liveCanvas.width  = video.videoWidth;
        liveCanvas.height = video.videoHeight;

        liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);

        if (state.recording) {
            // When recording, draw video + enhancement + watermark onto liveCanvas
            liveCtx.drawImage(video, 0, 0, liveCanvas.width, liveCanvas.height);
            applyEnhancements(liveCtx, liveCanvas.width, liveCanvas.height);

            const owner    = document.getElementById('ownerName').value || 'Original Creator';
            const info     = document.getElementById('assetInfo').value || 'General Asset';
            const timestamp = new Date().toLocaleString('id-ID', { timeStyle: 'short' });
            const position = document.getElementById('wmPosition').value;
            const wmStyle  = document.getElementById('wmStyle').value;
            const opacity  = parseInt(document.getElementById('wmOpacity').value) / 100;

            drawWatermark(liveCtx, liveCanvas.width, liveCanvas.height, {
                owner, info, timestamp,
                signature: state.currentSig,
                style: wmStyle, position, opacity,
                logoImg: state.logoImage
            });
        }

        state.animFrame = requestAnimationFrame(draw);
    };
    draw();
}

function toggleRecording() {
    if (!state.recording) {
        startRecording();
    } else {
        stopRecording();
    }
}

function startRecording() {
    state.recordedChunks = [];
    state.currentSig     = generateSignature();
    state.recSeconds     = 0;

    // Capture from the liveCanvas stream (has watermark)
    const canvasStream = liveCanvas.captureStream(30);

    // Merge audio from camera if available
    const audioTracks = state.stream ? state.stream.getAudioTracks() : [];
    audioTracks.forEach(t => canvasStream.addTrack(t));

    const mimeType = getSupportedMimeType();
    state.mediaRecorder = new MediaRecorder(canvasStream, mimeType ? { mimeType } : {});

    state.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) state.recordedChunks.push(e.data);
    };

    state.mediaRecorder.onstop = () => {
        const blob = new Blob(state.recordedChunks, { type: mimeType || 'video/webm' });
        const url  = URL.createObjectURL(blob);
        const ext  = mimeType && mimeType.includes('mp4') ? 'mp4' : 'webm';

        document.getElementById('videoPreview').src        = url;
        document.getElementById('videoDownloadLink').href  = url;
        document.getElementById('videoDownloadLink').download = `AuthenticCam_${state.currentSig}.${ext}`;

        const vResult = document.getElementById('videoResultArea');
        vResult.style.display = 'block';
        vResult.scrollIntoView({ behavior: 'smooth' });
        showToast('✅ Video tersimpan!', 'success');
    };

    state.mediaRecorder.start(100);
    state.recording = true;

    // Update UI
    document.getElementById('recIndicator').style.display = 'inline';
    document.getElementById('recTimer').style.display     = 'inline';
    document.getElementById('videoIcon').className        = 'fas fa-stop';
    document.getElementById('videoLabel').textContent     = 'Stop Rekaman';

    state.recInterval = setInterval(() => {
        state.recSeconds++;
        const m = String(Math.floor(state.recSeconds / 60)).padStart(2, '0');
        const s = String(state.recSeconds % 60).padStart(2, '0');
        document.getElementById('recTimer').textContent = `${m}:${s}`;
    }, 1000);
}

function stopRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
    }
    state.recording = false;
    clearInterval(state.recInterval);

    document.getElementById('recIndicator').style.display = 'none';
    document.getElementById('recTimer').style.display     = 'none';
    document.getElementById('videoIcon').className        = 'fas fa-circle';
    document.getElementById('videoLabel').textContent     = 'Mulai Rekam Video';
}

function getSupportedMimeType() {
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    for (const t of types) {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
    }
    return null;
}

// ────────────────────────────────────────────
// ENHANCEMENT CONTROLS
// ────────────────────────────────────────────
const presets = {
    none:     { brightness: 0,  contrast: 0,   saturation: 0,  sharpness: 0,  warmth: 0  },
    auto:     { brightness: 15, contrast: 20,  saturation: 15, sharpness: 35, warmth: 5  },
    vivid:    { brightness: 10, contrast: 30,  saturation: 50, sharpness: 20, warmth: 10 },
    night:    { brightness: 40, contrast: 25,  saturation: -10, sharpness: 40, warmth: 0 },
    portrait: { brightness: 8,  contrast: 15,  saturation: 10, sharpness: 15, warmth: 15 }
};

function setPreset(name) {
    const p = presets[name];
    if (!p) return;

    Object.keys(p).forEach(key => {
        const el = document.getElementById('e' + key.charAt(0).toUpperCase() + key.slice(1));
        if (el) {
            el.value = p[key];
            state.currentFilter[key] = p[key];
            const valEl = document.getElementById('e' + key.charAt(0).toUpperCase() + key.slice(1) + 'Val');
            if (valEl) valEl.textContent = p[key];
        }
    });

    // Update preset button active state
    document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('preset' + name.charAt(0).toUpperCase() + name.slice(1))?.classList.add('active');

    updateFilter();
}

function updateFilter() {
    const keys = ['brightness', 'contrast', 'saturation', 'sharpness', 'warmth'];
    keys.forEach(key => {
        const el = document.getElementById('e' + key.charAt(0).toUpperCase() + key.slice(1));
        const valEl = document.getElementById('e' + key.charAt(0).toUpperCase() + key.slice(1) + 'Val');
        if (el) {
            state.currentFilter[key] = parseInt(el.value);
            if (valEl) valEl.textContent = el.value;
        }
    });

    // Update CSS filter on video element for real-time preview
    const f = state.currentFilter;
    const bri = 1 + f.brightness / 100;
    const con = 1 + f.contrast  / 100;
    const sat = 1 + f.saturation / 100;
    video.style.filter = `brightness(${bri}) contrast(${con}) saturate(${sat})`;

    // Mark preset as custom
    document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
}

function resetFilters() {
    setPreset('none');
    video.style.filter = '';
}

// Opacity slider display update
document.getElementById('wmOpacity').addEventListener('input', function () {
    document.getElementById('opacityValue').textContent = this.value;
});

// ────────────────────────────────────────────
// LOGO UPLOAD
// ────────────────────────────────────────────
function handleLogoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            state.logoImage = img;
            document.getElementById('logoFileName').textContent = `✅ ${file.name}`;
            showToast('Logo berhasil diupload!', 'success');
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// ────────────────────────────────────────────
// PANEL TOGGLE (COLLAPSIBLE)
// ────────────────────────────────────────────
function toggleCard(id) {
    const card = document.getElementById(id);
    card.classList.toggle('collapsed');
}

// ────────────────────────────────────────────
// SHARE
// ────────────────────────────────────────────
async function sharePhoto() {
    const dlLink = document.getElementById('downloadLink');
    if (!dlLink.href || dlLink.href === window.location.href) {
        showToast('Ambil foto dulu ya!', 'error'); return;
    }

    if (navigator.share) {
        try {
            const res      = await fetch(dlLink.href);
            const blob     = await res.blob();
            const file     = new File([blob], dlLink.download, { type: 'image/png' });
            await navigator.share({ files: [file], title: 'AuthenticCam Verified Photo' });
        } catch (e) {
            // Fallback: copy URL
            copyFallback(dlLink.href);
        }
    } else {
        copyFallback(dlLink.href);
    }
}

function copyFallback(text) {
    navigator.clipboard.writeText(text)
        .then(() => showToast('URL disalin ke clipboard!', 'success'))
        .catch(() => showToast('Tidak dapat membagikan.', 'error'));
}

// ────────────────────────────────────────────
// TOAST NOTIFICATION
// ────────────────────────────────────────────
function showToast(msg, type = '') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toastIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

// ────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────
function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ────────────────────────────────────────────
// START
// ────────────────────────────────────────────
initCamera();
