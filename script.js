/* ══════════════════════════════════════════════
   AuthenticCam Pro · script.js v4.0
   - Orientation-corrected capture (no more tilted photos)
   - GPS / location watermark
   - Modern slim watermark strip
   - SHA-256 verification hash
   - Full video mode
══════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
const S = {
    mode:       'photo',
    facing:     'environment',
    stream:     null,
    recording:  false,
    recorder:   null,
    chunks:     [],
    recSecs:    0,
    recTick:    null,
    logo:       null,
    animReq:    null,
    sig:        null,
    gps: {
        lat:    null,
        lng:    null,
        acc:    null,
        addr:   null,
        status: 'pending'   // 'pending' | 'ok' | 'denied' | 'error'
    },
    filter: {
        brightness: 0,
        contrast:   0,
        saturation: 0,
        sharpness:  0,
        warmth:     0
    }
};

// ─────────────────────────────────────────────
//  DOM
// ─────────────────────────────────────────────
const vid    = document.getElementById('video');
const cvs    = document.getElementById('canvas');
const liveCvs= document.getElementById('liveCanvas');
const liveCtx= liveCvs.getContext('2d');

// ─────────────────────────────────────────────
//  GPS — ask once at startup
// ─────────────────────────────────────────────
function initGPS() {
    if (!navigator.geolocation) {
        S.gps.status = 'error';
        setGPSPill('GPS tidak tersedia', false);
        return;
    }
    setGPSPill('Mengambil lokasi…', false);

    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            S.gps.lat    = pos.coords.latitude;
            S.gps.lng    = pos.coords.longitude;
            S.gps.acc    = Math.round(pos.coords.accuracy);
            S.gps.status = 'ok';

            const short = `${S.gps.lat.toFixed(5)}, ${S.gps.lng.toFixed(5)}`;
            setGPSPill(`📍 ${short}`, true);

            // Try reverse geocode (OpenStreetMap Nominatim, free, no key)
            try {
                const r    = await fetch(
                    `https://nominatim.openstreetmap.org/reverse?lat=${S.gps.lat}&lon=${S.gps.lng}&format=json`,
                    { headers: { 'Accept-Language': 'id' } }
                );
                const data = await r.json();
                const addr = data?.address;
                if (addr) {
                    S.gps.addr = [
                        addr.village || addr.suburb || addr.neighbourhood,
                        addr.city    || addr.regency || addr.county,
                        addr.state
                    ].filter(Boolean).join(', ');
                    setGPSPill(`📍 ${S.gps.addr}`, true);
                }
            } catch (_) { /* keep coords only */ }
        },
        (err) => {
            S.gps.status = err.code === 1 ? 'denied' : 'error';
            setGPSPill(err.code === 1 ? 'Izin lokasi ditolak' : 'Lokasi tidak tersedia', false);
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function setGPSPill(text, ok) {
    const el = document.getElementById('gpsStatus');
    if (el) el.textContent = text;
    const pill = document.getElementById('gpsPill');
    if (pill) pill.style.color = ok ? 'rgba(0,255,179,.8)' : 'rgba(255,255,255,.4)';
}

// ─────────────────────────────────────────────
//  CAMERA
// ─────────────────────────────────────────────
async function initCamera() {
    if (S.stream) S.stream.getTracks().forEach(t => t.stop());
    const q = parseInt(document.getElementById('quality').value);
    try {
        S.stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width:      { ideal: q },
                height:     { ideal: Math.round(q * 0.75) },
                facingMode: S.facing
            },
            audio: S.mode === 'video'
        });
        vid.srcObject = S.stream;
        vid.onloadedmetadata = () => {
            document.getElementById('camResolution').textContent =
                `${vid.videoWidth} × ${vid.videoHeight}`;
        };
    } catch (e) {
        toast('❌ Gagal akses kamera. Cek izin.', 'err');
    }
}

document.getElementById('quality').addEventListener('change', initCamera);

// Orientation change: re-init so video fills correctly
window.addEventListener('orientationchange', () => setTimeout(initCamera, 450));

function flipCamera() {
    S.facing = S.facing === 'environment' ? 'user' : 'environment';
    initCamera();
    const btn = document.getElementById('flipBtn');
    btn.style.transition = 'transform .3s';
    btn.style.transform  = 'rotateY(180deg)';
    setTimeout(() => { btn.style.transform = ''; }, 320);
}

// ─────────────────────────────────────────────
//  MODE SWITCH
// ─────────────────────────────────────────────
function switchMode(mode) {
    S.mode = mode;
    const isV = mode === 'video';
    document.getElementById('tabPhoto').classList.toggle('active', !isV);
    document.getElementById('tabVideo').classList.toggle('active', isV);
    document.getElementById('snapBtn').style.display  = isV ? 'none' : 'flex';
    document.getElementById('videoBtn').style.display = isV ? 'flex' : 'none';
    liveCvs.style.display = isV ? 'block' : 'none';
    if (isV) startLiveLoop(); else { cancelAnimationFrame(S.animReq); }
    initCamera();
}

// ─────────────────────────────────────────────
//  SIGNATURE
// ─────────────────────────────────────────────
function makeSig() {
    const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = 'AC-';
    for (let i = 0; i < 4; i++) s += ch[Math.floor(Math.random() * ch.length)];
    s += '-';
    for (let i = 0; i < 4; i++) s += ch[Math.floor(Math.random() * ch.length)];
    return s;
}

// ─────────────────────────────────────────────
//  ORIENTATION CORRECTION
//
//  Mobile browsers sometimes deliver video frames
//  in the sensor's native orientation (often landscape)
//  while the CSS `object-fit:cover` hides this visually.
//  We detect the mismatch and rotate the canvas so the
//  captured image always matches what the user sees.
// ─────────────────────────────────────────────
function getCorrectDimensions() {
    const vw  = vid.videoWidth;
    const vh  = vid.videoHeight;
    const sw  = window.innerWidth;
    const sh  = window.innerHeight;
    const vidLandscape  = vw > vh;
    const scrLandscape  = sw > sh;
    const mismatch      = vidLandscape !== scrLandscape;
    // If mismatch: rotate 90°, so final image matches screen orientation
    return { vw, vh, mismatch };
}

function drawCorrectFrame(ctx, targetW, targetH, mismatch) {
    if (!mismatch) {
        ctx.drawImage(vid, 0, 0, targetW, targetH);
    } else {
        // Rotate canvas 90° to correct sensor orientation
        ctx.save();
        ctx.translate(targetW / 2, targetH / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(vid, -targetH / 2, -targetW / 2, targetH, targetW);
        ctx.restore();
    }
}

// ─────────────────────────────────────────────
//  ★ MODERN SLIM WATERMARK ENGINE ★
//
//  Two modes:
//  (A) STRIP — slim bar at top/bottom, non-intrusive
//  (B) CORNER — compact badge in a corner
//  (C) DIAGONAL — ghost tiled text (center option)
//
//  All sizes keyed to Math.min(cw,ch) for orientation safety.
// ─────────────────────────────────────────────
function drawWatermark(ctx, cw, ch, opts = {}) {
    const {
        owner     = 'Original Creator',
        info      = '',
        timestamp = '',
        gpsText   = '',
        signature = '',
        style     = 'dark',
        position  = 'bottom',
        opacity   = 0.75,
        logo      = null,
        showGPS   = true
    } = opts;

    const base  = Math.min(cw, ch);
    const px    = (v) => Math.round(base * v);  // shorthand

    // Style palette
    const palettes = {
        dark:   { bg: `rgba(0,0,0,${opacity * 0.78})`,       txt: 'rgba(255,255,255,.92)', sub: 'rgba(255,255,255,.55)', acc: '#00d4ff',  bar: '#00d4ff' },
        light:  { bg: `rgba(255,255,255,${opacity * 0.88})`, txt: 'rgba(0,0,0,.88)',       sub: 'rgba(0,0,0,.5)',        acc: '#0077bb',  bar: '#0077bb' },
        glass:  { bg: `rgba(255,255,255,${opacity * 0.14})`, txt: 'rgba(255,255,255,.95)', sub: 'rgba(255,255,255,.6)', acc: '#00ffb3',  bar: '#00ffb3' },
        brand:  { bg: `rgba(0,20,50,${opacity * 0.88})`,     txt: 'rgba(0,212,255,1)',     sub: 'rgba(0,212,255,.55)',  acc: '#00ffb3',  bar: '#00ffb3' }
    };
    const pal = palettes[style] || palettes.dark;

    ctx.save();

    // ──── DIAGONAL / CENTER ────
    if (position === 'diagonal') {
        ctx.globalAlpha = opacity * 0.12;
        ctx.fillStyle   = '#fff';
        ctx.font        = `bold ${px(0.04)}px Outfit,sans-serif`;
        ctx.textAlign   = 'center';
        ctx.translate(cw / 2, ch / 2);
        ctx.rotate(-Math.PI / 7);
        const label = `${owner}  ·  AuthenticCam`;
        const stepX = cw * 0.55;
        const stepY = px(0.13);
        const rx    = Math.ceil(cw / stepX) + 3;
        const ry    = Math.ceil(ch / stepY) + 3;
        for (let iy = -ry; iy <= ry; iy++)
            for (let ix = -rx; ix <= rx; ix++)
                ctx.fillText(label, ix * stepX, iy * stepY);
        ctx.restore();
        // Still draw sig corner
        ctx.save();
        drawSignatureCorner(ctx, cw, ch, signature, pal.acc, px);
        ctx.restore();
        return;
    }

    // ──── STRIP mode (bottom / top) ────
    if (position === 'bottom' || position === 'top') {
        const lh      = px(0.042);          // line height
        const fMain   = px(0.028);          // owner name
        const fSub    = px(0.020);          // sub info
        const padV    = px(0.018);
        const padH    = px(0.022);
        const logoSz  = lh * 1.8;

        // Build lines
        const line1  = owner;
        const parts2 = [info, timestamp].filter(Boolean);
        const line2  = parts2.join('  ·  ');
        const line3  = (showGPS && gpsText) ? `📍 ${gpsText}` : null;

        const lineCount = 2 + (line3 ? 1 : 0);
        const stripH    = padV * 2 + lh * lineCount + lh * (lineCount - 1) * 0.35;

        const sy = position === 'bottom' ? ch - stripH : 0;

        // Background strip
        ctx.globalAlpha = 1;
        ctx.fillStyle   = pal.bg;
        ctx.fillRect(0, sy, cw, stripH);

        // Thin accent line
        ctx.fillStyle   = pal.bar;
        const barH = Math.max(2, px(0.003));
        ctx.fillRect(0, position === 'bottom' ? sy : sy + stripH - barH, cw, barH);

        // Logo
        let textX = padH;
        if (logo) {
            try {
                ctx.save();
                ctx.globalAlpha = Math.min(1, opacity + 0.15);
                const lx = padH;
                const ly = sy + (stripH - logoSz) / 2;
                ctx.beginPath();
                ctx.arc(lx + logoSz / 2, ly + logoSz / 2, logoSz / 2, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(logo, lx, ly, logoSz, logoSz);
                ctx.restore();
                textX = lx + logoSz + padH * 0.8;
            } catch (_) {}
        }

        // Text shadow
        ctx.shadowColor = 'rgba(0,0,0,.5)';
        ctx.shadowBlur  = 3;
        ctx.textAlign   = 'left';

        // Line 1: Owner name
        ctx.globalAlpha = 1;
        ctx.fillStyle   = pal.txt;
        ctx.font        = `600 ${fMain}px Outfit,sans-serif`;
        const maxW      = cw - textX - padH * 2;
        ctx.fillText(clip(ctx, line1, maxW), textX, sy + padV + fMain);

        // Line 2: info · timestamp
        ctx.fillStyle   = pal.sub;
        ctx.font        = `${fSub}px 'Fira Code',monospace`;
        ctx.globalAlpha = 0.88;
        ctx.fillText(clip(ctx, line2, maxW), textX, sy + padV + fMain + lh * 1.1);

        // Line 3: GPS
        if (line3) {
            ctx.fillStyle   = pal.acc;
            ctx.font        = `${fSub * 0.92}px 'Fira Code',monospace`;
            ctx.globalAlpha = 0.78;
            ctx.fillText(clip(ctx, line3, maxW), textX, sy + padV + fMain + lh * 2.25);
        }

        ctx.shadowBlur = 0;

        // Sig ID — right-aligned in strip
        ctx.fillStyle   = pal.acc;
        ctx.font        = `500 ${px(0.018)}px 'Fira Code',monospace`;
        ctx.textAlign   = 'right';
        ctx.globalAlpha = 0.65;
        ctx.fillText(signature, cw - padH, sy + stripH - padV * 0.6);

        ctx.restore();
        return;
    }

    // ──── CORNER mode (corner-bl / corner-br) ────
    {
        const fMain = px(0.030);
        const fSub  = px(0.020);
        const pad   = px(0.024);
        const mg    = px(0.020);

        // Badge dimensions
        const bw = cw * 0.50;
        const bh = fMain * 4.5;
        const r  = px(0.010);

        let bx, by;
        if (position === 'corner-br') { bx = cw - bw - mg; by = ch - bh - mg; }
        else                          { bx = mg;            by = ch - bh - mg; }

        // Left accent bar
        ctx.globalAlpha = 1;
        ctx.fillStyle   = pal.bg;
        roundRect(ctx, bx, by, bw, bh, r);
        ctx.fill();
        ctx.fillStyle = pal.bar;
        roundRect(ctx, bx, by, Math.max(3, px(0.004)), bh, [r, 0, 0, r]);
        ctx.fill();

        // Logo
        let tx = bx + pad;
        if (logo) {
            try {
                const lsz = bh * 0.52;
                const lx  = bx + pad * 0.55;
                const ly  = by + (bh - lsz) / 2;
                ctx.save();
                ctx.globalAlpha = opacity;
                ctx.beginPath();
                ctx.arc(lx + lsz / 2, ly + lsz / 2, lsz / 2, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(logo, lx, ly, lsz, lsz);
                ctx.restore();
                tx = lx + lsz + pad * 0.7;
            } catch (_) {}
        }

        ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 4;
        ctx.textAlign   = 'left';
        const mxW = bw - (tx - bx) - pad;

        ctx.fillStyle   = pal.txt;
        ctx.font        = `600 ${fMain}px Outfit,sans-serif`;
        ctx.globalAlpha = 1;
        ctx.fillText(clip(ctx, owner, mxW), tx, by + bh * 0.44);

        const sub2 = [info, timestamp, showGPS && gpsText ? `📍 ${gpsText}` : ''].filter(Boolean).join(' · ');
        ctx.fillStyle   = pal.sub;
        ctx.font        = `${fSub}px 'Fira Code',monospace`;
        ctx.globalAlpha = 0.85;
        ctx.fillText(clip(ctx, sub2, mxW), tx, by + bh * 0.74);

        ctx.shadowBlur = 0;
        drawSignatureCorner(ctx, cw, ch, signature, pal.acc, px);
        ctx.restore();
    }
}

// Tiny signature in bottom-right corner
function drawSignatureCorner(ctx, cw, ch, sig, color, px) {
    ctx.save();
    ctx.globalAlpha = 0.52;
    ctx.fillStyle   = color;
    ctx.font        = `500 ${px(0.018)}px 'Fira Code',monospace`;
    ctx.textAlign   = 'right';
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 3;
    ctx.fillText(sig, cw - px(0.018), ch - px(0.014));
    ctx.shadowBlur = 0;
    ctx.restore();
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

function clip(ctx, text, maxW) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 0 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
}

// ─────────────────────────────────────────────
//  SHA-256 HASH (verification fingerprint)
// ─────────────────────────────────────────────
async function hashBlob(blob) {
    try {
        const buf  = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        const hex  = Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        return hex;
    } catch (_) { return null; }
}

// ─────────────────────────────────────────────
//  AI ENHANCEMENT
// ─────────────────────────────────────────────
function applyEnhancement(ctx, w, h) {
    const f = S.filter;
    if (!f.brightness && !f.contrast && !f.saturation && !f.warmth && !f.sharpness) return;

    const id = ctx.getImageData(0, 0, w, h);
    const d  = id.data;
    const bri = f.brightness * 2.55;
    const con = (f.contrast + 100) / 100;
    const sat = (f.saturation + 100) / 100;
    const wrm = f.warmth * 1.4;

    for (let i = 0; i < d.length; i += 4) {
        let r = d[i], g = d[i+1], b = d[i+2];
        r += bri; g += bri; b += bri;
        r = (r - 128) * con + 128;
        g = (g - 128) * con + 128;
        b = (b - 128) * con + 128;
        r += wrm * .5; b -= wrm * .3; g += wrm * .08;
        const lum = .2126 * r + .7152 * g + .0722 * b;
        r = lum + sat * (r - lum);
        g = lum + sat * (g - lum);
        b = lum + sat * (b - lum);
        d[i]   = clp(r); d[i+1] = clp(g); d[i+2] = clp(b);
    }
    ctx.putImageData(id, 0, 0);
    if (f.sharpness > 0) sharpen(ctx, w, h, f.sharpness / 100);
}

function sharpen(ctx, w, h, amt) {
    const src = ctx.getImageData(0, 0, w, h);
    const dst = ctx.createImageData(w, h);
    const s   = src.data; const d = dst.data;
    const str = amt * 1.5;
    const k   = [0, -str, 0, -str, 1 + 4 * str, -str, 0, -str, 0];
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) {
                let v = 0;
                for (let ky = -1; ky <= 1; ky++)
                    for (let kx = -1; kx <= 1; kx++)
                        v += s[((y + ky) * w + (x + kx)) * 4 + c] * k[(ky + 1) * 3 + (kx + 1)];
                d[i + c] = clp(v);
            }
            d[i + 3] = s[i + 3];
        }
    }
    ctx.putImageData(dst, 0, 0);
}

function clp(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

// ─────────────────────────────────────────────
//  PHOTO CAPTURE
// ─────────────────────────────────────────────
async function capturePhoto() {
    if (!vid.videoWidth) { toast('Kamera belum siap', 'err'); return; }

    flash();

    const ctx       = cvs.getContext('2d');
    const owner     = document.getElementById('ownerName').value || 'Original Creator';
    const info      = document.getElementById('assetInfo').value || '';
    const ts        = new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
    const sig       = makeSig();
    const pos       = document.getElementById('wmPos').value;
    const style     = document.getElementById('wmStyle').value;
    const op        = parseInt(document.getElementById('wmOp').value) / 100;
    const showGPS   = document.getElementById('wmGps').checked;
    const gpsText   = buildGPSText();

    // ── Orientation-aware canvas sizing ──
    const { vw, vh, mismatch } = getCorrectDimensions();
    // After rotation (if needed), final dims are swapped
    cvs.width  = mismatch ? vh : vw;
    cvs.height = mismatch ? vw : vh;

    // Draw frame (with rotation correction if needed)
    drawCorrectFrame(ctx, cvs.width, cvs.height, mismatch);

    // Enhancement
    applyEnhancement(ctx, cvs.width, cvs.height);

    // Watermark
    drawWatermark(ctx, cvs.width, cvs.height, {
        owner, info, timestamp: ts,
        gpsText, signature: sig,
        style, position: pos, opacity: op,
        logo: S.logo, showGPS
    });

    // Export
    cvs.toBlob(async (blob) => {
        const url    = URL.createObjectURL(blob);
        const hash   = await hashBlob(blob);
        const imgEl  = document.getElementById('photoPreview');
        const vidEl  = document.getElementById('videoPreview');
        const dl     = document.getElementById('dlLink');

        imgEl.src            = url;
        imgEl.style.display  = 'block';
        vidEl.style.display  = 'none';
        dl.href              = url;
        dl.download          = `AuthenticCam_${sig}.png`;

        document.getElementById('resBadgeTxt').textContent = 'Foto Terverifikasi';
        fillMeta({ owner, info, ts, sig, gpsText, w: cvs.width, h: cvs.height, hash });
        openResult();
        toast('✅ Foto berhasil diverifikasi!', 'ok');
    }, 'image/png');
}

function buildGPSText() {
    if (S.gps.status !== 'ok') return '';
    if (S.gps.addr) return S.gps.addr;
    return `${S.gps.lat?.toFixed(5)}, ${S.gps.lng?.toFixed(5)}`;
}

// ─────────────────────────────────────────────
//  VIDEO RECORDING
// ─────────────────────────────────────────────
function startLiveLoop() {
    const draw = () => {
        if (vid.readyState < 2) { S.animReq = requestAnimationFrame(draw); return; }
        const { vw, vh, mismatch } = getCorrectDimensions();
        liveCvs.width  = mismatch ? vh : vw;
        liveCvs.height = mismatch ? vw : vh;
        liveCtx.clearRect(0, 0, liveCvs.width, liveCvs.height);

        if (S.recording) {
            drawCorrectFrame(liveCtx, liveCvs.width, liveCvs.height, mismatch);
            applyEnhancement(liveCtx, liveCvs.width, liveCvs.height);

            const ts  = new Date().toLocaleString('id-ID', { timeStyle: 'short' });
            drawWatermark(liveCtx, liveCvs.width, liveCvs.height, {
                owner:     document.getElementById('ownerName').value || 'Original Creator',
                info:      document.getElementById('assetInfo').value || '',
                timestamp: ts,
                gpsText:   buildGPSText(),
                signature: S.sig,
                style:     document.getElementById('wmStyle').value,
                position:  document.getElementById('wmPos').value,
                opacity:   parseInt(document.getElementById('wmOp').value) / 100,
                logo:      S.logo,
                showGPS:   document.getElementById('wmGps').checked
            });
        }
        S.animReq = requestAnimationFrame(draw);
    };
    cancelAnimationFrame(S.animReq);
    draw();
}

function toggleRecording() { S.recording ? stopRec() : startRec(); }

function startRec() {
    S.chunks = []; S.sig = makeSig(); S.recSecs = 0;
    const cs    = liveCvs.captureStream(30);
    if (S.stream) S.stream.getAudioTracks().forEach(t => cs.addTrack(t));
    const mime  = bestMime();
    S.recorder  = new MediaRecorder(cs, mime ? { mimeType: mime } : {});
    S.recorder.ondataavailable = e => { if (e.data.size > 0) S.chunks.push(e.data); };
    S.recorder.onstop = async () => {
        const blob = new Blob(S.chunks, { type: mime || 'video/webm' });
        const url  = URL.createObjectURL(blob);
        const ext  = mime?.includes('mp4') ? 'mp4' : 'webm';
        const vEl  = document.getElementById('videoPreview');
        const iEl  = document.getElementById('photoPreview');
        const dl   = document.getElementById('dlLink');
        vEl.src            = url;
        vEl.style.display  = 'block';
        iEl.style.display  = 'none';
        dl.href            = url;
        dl.download        = `AuthenticCam_${S.sig}.${ext}`;
        document.getElementById('resBadgeTxt').textContent = 'Video Terverifikasi';
        const owner = document.getElementById('ownerName').value || 'Original Creator';
        const info  = document.getElementById('assetInfo').value || '';
        const ts    = new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
        fillMeta({ owner, info, ts, sig: S.sig, gpsText: buildGPSText(), w: liveCvs.width, h: liveCvs.height, hash: null });
        openResult();
        toast('✅ Video tersimpan!', 'ok');
    };
    S.recorder.start(100);
    S.recording = true;
    document.getElementById('recIndicator').style.display = 'flex';
    const dot = document.getElementById('vidDot');
    dot.style.borderRadius = '4px'; dot.style.width = '26px'; dot.style.height = '26px';
    document.getElementById('videoBtn').classList.add('rec');
    S.recTick = setInterval(() => {
        S.recSecs++;
        const m = String(Math.floor(S.recSecs / 60)).padStart(2,'0');
        const s = String(S.recSecs % 60).padStart(2,'0');
        document.getElementById('recTimer').textContent = `${m}:${s}`;
    }, 1000);
}

function stopRec() {
    if (S.recorder?.state !== 'inactive') S.recorder.stop();
    S.recording = false;
    clearInterval(S.recTick);
    document.getElementById('recIndicator').style.display = 'none';
    document.getElementById('videoBtn').classList.remove('rec');
    const dot = document.getElementById('vidDot');
    dot.style.borderRadius = '50%'; dot.style.width = ''; dot.style.height = '';
}

function bestMime() {
    const t = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm','video/mp4'];
    return t.find(x => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(x)) || null;
}

// ─────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────
function toggleSettings() {
    const d = document.getElementById('drawer');
    const b = document.getElementById('backdrop');
    const open = d.classList.contains('open');
    d.classList.toggle('open', !open);
    b.classList.toggle('open', !open);
}

function toggleCard(id) { document.getElementById(id).classList.toggle('collapsed'); }

document.getElementById('wmOp').addEventListener('input', function () {
    document.getElementById('opVal').textContent = this.value;
});

// ─────────────────────────────────────────────
//  RESULT MODAL
// ─────────────────────────────────────────────
function openResult() {
    document.getElementById('resultOverlay').style.display = 'flex';
    document.getElementById('drawer').classList.remove('open');
    document.getElementById('backdrop').classList.remove('open');
}

function closeResult() {
    document.getElementById('resultOverlay').style.display = 'none';
}

function fillMeta({ owner, info, ts, sig, gpsText, w, h, hash }) {
    const rows = [
        ['OWNER',   owner],
        ['ASSET',   info || '—'],
        ['DATE',    ts],
        ['SIG ID',  sig],
        ['RES',     `${w} × ${h}px`],
    ];
    if (S.gps.status === 'ok' && S.gps.lat) {
        rows.push(['GPS', `${S.gps.lat.toFixed(6)}, ${S.gps.lng.toFixed(6)}`]);
        if (S.gps.acc) rows.push(['AKURASI', `±${S.gps.acc}m`]);
    }
    if (gpsText) rows.push(['LOKASI', gpsText]);

    document.getElementById('metaCard').innerHTML = rows.map(([l, v]) =>
        `<div class="mrow"><span class="mlbl">${l}</span><span class="mval">${esc(String(v))}</span></div>`
    ).join('');

    // Verification strip
    const verEl = document.getElementById('verifyStrip');
    if (hash) {
        verEl.innerHTML = `<b style="color:rgba(0,212,255,.7)">SHA-256 HASH</b><br>${hash}`;
        verEl.style.display = 'block';
    } else {
        verEl.style.display = 'none';
    }
}

// ─────────────────────────────────────────────
//  SHARE
// ─────────────────────────────────────────────
async function shareAsset() {
    const dl = document.getElementById('dlLink');
    if (!dl.href || dl.href === location.href) { toast('Ambil foto dulu ya!', 'err'); return; }
    if (navigator.share) {
        try {
            const res  = await fetch(dl.href);
            const blob = await res.blob();
            const file = new File([blob], dl.download, { type: blob.type });
            await navigator.share({ files: [file], title: 'AuthenticCam Verified' });
        } catch (_) { copyToClipboard(dl.href); }
    } else { copyToClipboard(dl.href); }
}

function copyToClipboard(text) {
    navigator.clipboard?.writeText(text)
        .then(() => toast('URL disalin!', 'ok'))
        .catch(() => toast('Tidak dapat membagikan.', 'err'));
}

// ─────────────────────────────────────────────
//  ENHANCEMENT PRESETS
// ─────────────────────────────────────────────
const PRESETS = {
    none:    { brightness:0,  contrast:0,  saturation:0,  sharpness:0,  warmth:0  },
    auto:    { brightness:15, contrast:20, saturation:15, sharpness:35, warmth:5  },
    vivid:   { brightness:10, contrast:30, saturation:50, sharpness:20, warmth:10 },
    night:   { brightness:40, contrast:25, saturation:-10,sharpness:40, warmth:0  },
    portrait:{ brightness:8,  contrast:15, saturation:10, sharpness:15, warmth:15 }
};

const FILTER_KEYS = [
    ['brightness','eBri'],['contrast','eCon'],
    ['saturation','eSat'],['sharpness','eShr'],['warmth','eWrm']
];

function setPreset(name) {
    const p = PRESETS[name]; if (!p) return;
    FILTER_KEYS.forEach(([key, id]) => {
        const el  = document.getElementById(id);
        const vel = document.getElementById(id + 'V');
        if (el)  el.value = p[key];
        if (vel) vel.textContent = p[key];
        S.filter[key] = p[key];
    });
    document.querySelectorAll('.pp').forEach(b => b.classList.remove('active'));
    document.getElementById('p' + name[0].toUpperCase() + name.slice(1))?.classList.add('active');
    applyLiveCSS();
}

function updFilter() {
    FILTER_KEYS.forEach(([key, id]) => {
        const el = document.getElementById(id);
        const ve = document.getElementById(id + 'V');
        if (el) { S.filter[key] = parseInt(el.value); if (ve) ve.textContent = el.value; }
    });
    document.querySelectorAll('.pp').forEach(b => b.classList.remove('active'));
    applyLiveCSS();
}

function applyLiveCSS() {
    const f = S.filter;
    vid.style.filter = `brightness(${1 + f.brightness / 100}) contrast(${1 + f.contrast / 100}) saturate(${1 + f.saturation / 100})`;
}

function resetFilters() { setPreset('none'); vid.style.filter = ''; }

// ─────────────────────────────────────────────
//  LOGO
// ─────────────────────────────────────────────
function loadLogo(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
            S.logo = img;
            document.getElementById('logoName').textContent = `✅ ${file.name}`;
            toast('Logo siap!', 'ok');
        };
        img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
}

// ─────────────────────────────────────────────
//  FLASH
// ─────────────────────────────────────────────
function flash() {
    const el = document.getElementById('flashEl');
    el.classList.add('on');
    setTimeout(() => el.classList.remove('on'), 120);
}

// ─────────────────────────────────────────────
//  TOAST
// ─────────────────────────────────────────────
function toast(msg, type = '') {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className   = `toast ${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
        t.style.opacity    = '0';
        t.style.transition = 'opacity .28s';
        setTimeout(() => t.remove(), 300);
    }, 2700);
}

// ─────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────
function esc(s) {
    return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────
initGPS();
initCamera();
