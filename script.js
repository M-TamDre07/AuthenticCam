/* ═══════════════════════════════════════════════════════════════
   AuthenticCam Pro · script.js v9.1 (Refactored)
   Features: Camera · Watermark · QR · SHA-256 · GPS
             Web Worker · Screen Wake Lock · Pinch-to-Zoom
             Self-Timer · Burst Mode · Settings Persistence
             PWA Install · Keyboard Shortcuts · WB Control
             Fullscreen API · Hardware Volume Shutter
             [NEW] Adaptive Orientation · Capability Checks
═══════════════════════════════════════════════════════════════ */
'use strict';

// ─── STATE ──────────────────────────────────────────────────────
const S = {
    mode:        'photo',      // photo | video | pro
    facing:      'environment',
    stream:      null,
    recording:   false,
    recorder:    null,
    chunks:      [],
    recSecs:     0,
    recTick:     null,
    logo:        null,
    animReq:     null,
    sig:         null,
    locked:      false,
    torchOn:     false,
    lastBlob:    null,
    wasLevel:    false,
    gridOn:      false,
    // Timer & Burst
    timerSecs:   0,       // 0 | 3 | 10
    timerActive: false,
    timerTick:   null,
    burstCount:  1,       // 1 | 3 | 5
    burstIdx:    0,
    // Aspect ratio
    ratioIdx:    0,       // index into RATIOS
    // Pinch zoom
    pinchStartDist: 0,
    pinchStartZoom: 1,
    pinchActive: false,
    zoomHideTimeout: null,
    // System
    wakeLock:    null,
    deferredPrompt: null,
    isFullscreen: false,
    // GPS
    gps: { lat: null, lng: null, acc: null, addr: null, status: 'pending' },
    // Filters
    filter: { brightness: 0, contrast: 0, saturation: 0, sharpness: 0, warmth: 0, wbShift: { r: 0, g: 0, b: 0 } },
    // Pro
    pro: { ev: 0, zoom: 1, wb: 'auto' }
};

const RATIOS = ['4:3', '16:9', '1:1', 'Full'];

// ─── DOM ────────────────────────────────────────────────────────
const vid     = document.getElementById('video');
const cvs     = document.getElementById('canvas');
const liveCvs = document.getElementById('liveCanvas');
const liveCtx = liveCvs.getContext('2d');

// ─── SETTINGS PERSISTENCE (localStorage) ───────────────────────
const PERSIST = [
    'ownerName','assetInfo','quality','wmPos','wmStyle','wmOp',
    'wmGps','wmSig','qrOn','qrPos','qrSize','exportFmt','qualSlider',
    'eBri','eCon','eSat','eShr','eWrm','hapticTog','soundTog', 'wmAdaptive'
];

function saveSettings() {
    const out = {};
    PERSIST.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        out[id] = el.type === 'checkbox' ? el.checked : el.value;
    });
    try { localStorage.setItem('ac_settings', JSON.stringify(out)); } catch(_) {}
}

function loadSettings() {
    let data = {};
    try { data = JSON.parse(localStorage.getItem('ac_settings') || '{}'); } catch(_) {}
    PERSIST.forEach(id => {
        if (!(id in data)) return;
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') { el.checked = data[id]; }
        else { el.value = data[id]; }
    });
    // Sync visual labels
    const opEl = document.getElementById('wmOp');
    if (opEl) document.getElementById('opVal').textContent = opEl.value;
    const qEl = document.getElementById('qualSlider');
    if (qEl) document.getElementById('qualVal').textContent = qEl.value;
    // Sync filter state
    const FK = [['brightness','eBri'],['contrast','eCon'],['saturation','eSat'],['sharpness','eShr'],['warmth','eWrm']];
    FK.forEach(([k, id]) => {
        const el = document.getElementById(id);
        const ve = document.getElementById(id + 'V');
        if (el) { S.filter[k] = parseInt(el.value); if (ve) ve.textContent = el.value; }
    });
    updFmtHint();
}

// ─── PRO UI INJECTION ────────────────────────────────────────────
function injectProUI() {
    const wrap = document.getElementById('camWrap');
    if (!wrap) return;
    if (!document.querySelector('.cam-grid')) {
        const grid = document.createElement('div');
        grid.className = 'cam-grid';
        grid.style.display = 'none';
        for (let i = 0; i < 9; i++) grid.appendChild(document.createElement('div'));
        wrap.appendChild(grid);
    }
    if (!document.getElementById('leveler')) {
        const lvl = document.createElement('div');
        lvl.className = 'virtual-leveler';
        lvl.id = 'leveler';
        lvl.style.display = 'none';
        wrap.appendChild(lvl);
    }
}

// ─── UI HELPER UNTUK LEVELER ─────────────────────────────────────
// Hanya untuk keperluan sensor UI UI Gyroscope (jangan gunakan untuk capture)
function getUIAngle() {
    if (typeof screen?.orientation?.angle === 'number') return screen.orientation.angle;
    if (typeof window.orientation === 'number') return window.orientation;
    return window.innerWidth > window.innerHeight ? 90 : 0;
}

// ─── GYROSCOPE LEVELER ──────────────────────────────────────────
window.addEventListener('deviceorientation', e => {
    const lvl = document.getElementById('leveler');
    if (!lvl || lvl.style.display === 'none') return;
    const orientation = getUIAngle();
    let angle = (orientation === 0 || orientation === 180) ? e.gamma
              : (orientation === 90 ? e.beta : -e.beta);
    const visual = Math.max(-45, Math.min(45, angle || 0));
    lvl.style.transform = `translateY(-50%) rotate(${visual}deg)`;
    if (Math.abs(angle) < 2) {
        lvl.classList.add('level');
        if (!S.wasLevel) { haptic([15]); S.wasLevel = true; }
    } else {
        lvl.classList.remove('level');
        S.wasLevel = false;
    }
});
// ─── SCREEN MANAGEMENT (Wake Lock & Orientation) ─────────────────────────

// Fungsi untuk menahan layar agar tidak mati
async function initWakeLock() {
    if (!('wakeLock' in navigator)) {
        console.warn('[WakeLock] API tidak didukung di browser ini.');
        return;
    }
    
    try {
        S.wakeLock = await navigator.wakeLock.request('screen');
        const wakeChip = document.getElementById('wakeChip');
        if (wakeChip) wakeChip.style.display = 'flex';
        
        S.wakeLock.addEventListener('release', () => {
            if (wakeChip) wakeChip.style.display = 'none';
            S.wakeLock = null;
            console.log('[WakeLock] Terlepas.');
        });
    } catch(e) { 
        console.warn('[WakeLock] Gagal diaktifkan:', e); 
    }
}

// Fungsi untuk mengunci orientasi layar berdasarkan S.mode
async function lockOrientation() {
    // Cek apakah browser mendukung Screen Orientation API
    if (!('orientation' in screen && 'lock' in screen.orientation)) {
        console.warn('[OrientationLock] API tidak didukung di browser ini.');
        return;
    }

    try {
        if (S.mode === 'photo') {
            await screen.orientation.lock('portrait');
            console.log('[OrientationLock] Terkunci di Portrait');
        } else {
            await screen.orientation.lock('landscape');
            console.log('[OrientationLock] Terkunci di Landscape');
        }
    } catch(e) {
        // Error biasanya terjadi jika web tidak dalam mode Fullscreen atau bukan PWA
        console.warn('[OrientationLock] Gagal mengunci orientasi:', e.message);
    }
}

// Fungsi inisialisasi / re-acquire saat tab kembali dibuka
async function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
        // Ambil kembali Wake Lock jika terlepas saat app di-minimize
        if (!S.wakeLock) {
            await initWakeLock();
        }
        // Pastikan orientasi juga tetap terkunci sesuai mode terakhir
        await lockOrientation();
    }
}

// Pasang event listener
document.addEventListener('visibilitychange', handleVisibilityChange);

// ─── CONTOH PENGGUNAAN ───────────────────────────────────────────────────
// Panggil ini saat inisialisasi awal aplikasi:
// await initWakeLock();
// await lockOrientation();

// Panggil ini jika user mengubah mode di dalam aplikasi:
async function changeMode(newMode) {
    S.mode = newMode;
    await lockOrientation(); // Update orientasi saat mode berubah
}

// ─── PWA INSTALL PROMPT ──────────────────────────────────────────
window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    S.deferredPrompt = e;
    const banner = document.getElementById('pwaBanner');
    if (banner) banner.style.display = 'flex';
    const btn = document.getElementById('installBtn');
    if (btn) btn.style.display = 'flex';
});
window.addEventListener('appinstalled', () => {
    const banner = document.getElementById('pwaBanner');
    if (banner) banner.style.display = 'none';
    S.deferredPrompt = null;
    toast('✅ AuthenticCam terpasang!', 'ok');
});
const installBtn = document.getElementById('pwaInstallBtn');
if (installBtn) installBtn.addEventListener('click', requestPwaInstall);
const dismissBtn = document.getElementById('pwaDismissBtn');
if (dismissBtn) dismissBtn.addEventListener('click', () => {
    document.getElementById('pwaBanner').style.display = 'none';
});

async function requestPwaInstall() {
    document.getElementById('pwaBanner').style.display = 'none';
    if (!S.deferredPrompt) { toast('Gunakan menu browser untuk install PWA', ''); return; }
    S.deferredPrompt.prompt();
    const { outcome } = await S.deferredPrompt.userChoice;
    if (outcome === 'accepted') S.deferredPrompt = null;
}

// ─── FULLSCREEN API ──────────────────────────────────────────────
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
        document.exitFullscreen?.();
    }
}
document.addEventListener('fullscreenchange', () => {
    S.isFullscreen = !!document.fullscreenElement;
    const icon = document.getElementById('fullscreenIcon');
    if (icon) icon.className = S.isFullscreen ? 'fas fa-compress' : 'fas fa-expand';
});

// ─── PINCH-TO-ZOOM ───────────────────────────────────────────────
function initPinchZoom() {
    const el = document.getElementById('camWrap');

    el.addEventListener('touchstart', e => {
        if (e.touches.length === 2) {
            S.pinchActive = true;
            S.pinchStartDist = Math.hypot(
                e.touches[1].clientX - e.touches[0].clientX,
                e.touches[1].clientY - e.touches[0].clientY
            );
            S.pinchStartZoom = S.pro.zoom;
            e.preventDefault();
        }
    }, { passive: false });

    el.addEventListener('touchmove', e => {
        if (e.touches.length !== 2 || !S.pinchActive) return;
        const dist = Math.hypot(
            e.touches[1].clientX - e.touches[0].clientX,
            e.touches[1].clientY - e.touches[0].clientY
        );
        const newZoom = Math.max(1, Math.min(8, S.pinchStartZoom * (dist / S.pinchStartDist)));
        applyZoom(newZoom);
        showZoomIndicator(newZoom);
        e.preventDefault();
    }, { passive: false });

    el.addEventListener('touchend', e => {
        if (e.touches.length < 2) S.pinchActive = false;
    });
}

function applyZoom(z) {
    S.pro.zoom = parseFloat(z.toFixed(2));
    const zs = document.getElementById('zoomSlider');
    const zv = document.getElementById('zoomVal');
    if (zs) zs.value = S.pro.zoom;
    if (zv) zv.textContent = S.pro.zoom.toFixed(1) + '×';
    
    const track = S.stream?.getVideoTracks()[0];
    if (track) {
        const caps = track.getCapabilities?.() || {};
        if (caps.zoom) {
            track.applyConstraints({ advanced: [{ zoom: S.pro.zoom }] }).catch(() => {
                applyDigitalZoom();
            });
        } else {
            applyDigitalZoom();
        }
    } else {
        applyDigitalZoom();
    }
}

function applyDigitalZoom() {
    vid.style.transform = `scale(${S.pro.zoom})`;
    vid.style.transformOrigin = 'center center';
}

function showZoomIndicator(z) {
    const el = document.getElementById('zoomIndicator');
    const vl = document.getElementById('zoomIndicatorVal');
    if (!el) return;
    if (vl) vl.textContent = z.toFixed(1) + '×';
    el.classList.add('visible');
    clearTimeout(S.zoomHideTimeout);
    S.zoomHideTimeout = setTimeout(() => el.classList.remove('visible'), 1400);
}

// ─── WEB WORKER (inline blob) ────────────────────────────────────
let worker = null;
function initWorker() {
    const src = `
self.onmessage=function(e){
    const{buffer,width,height,filter}=e.data;
    const d=new Uint8ClampedArray(buffer);
    const bri=filter.brightness*2.55,con=(filter.contrast+100)/100,
          sat=(filter.saturation+100)/100,wrm=filter.warmth*1.4,
          wb=filter.wbShift||{r:0,g:0,b:0};
    for(let i=0;i<d.length;i+=4){
        let r=d[i],g=d[i+1],b=d[i+2];
        r+=bri;g+=bri;b+=bri;
        r=(r-128)*con+128;g=(g-128)*con+128;b=(b-128)*con+128;
        r+=wrm*.5;b-=wrm*.3;g+=wrm*.08;
        r+=wb.r;g+=wb.g;b+=wb.b;
        const l=.2126*r+.7152*g+.0722*b;
        r=l+sat*(r-l);g=l+sat*(g-l);b=l+sat*(b-l);
        d[i]=c(r);d[i+1]=c(g);d[i+2]=c(b);
    }
    if(filter.sharpness>0){
        const src2=new Uint8ClampedArray(d),str=filter.sharpness/100*1.5,
              k=[0,-str,0,-str,1+4*str,-str,0,-str,0];
        for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
            const i=(y*width+x)*4;
            for(let ch=0;ch<3;ch++){
                let v=0;
                for(let ky=-1;ky<=1;ky++)for(let kx=-1;kx<=1;kx++)
                    v+=src2[((y+ky)*width+(x+kx))*4+ch]*k[(ky+1)*3+(kx+1)];
                d[i+ch]=c(v);
            }
        }
    }
    self.postMessage({buffer:d.buffer},[d.buffer]);
};
function c(v){return v<0?0:v>255?255:v+.5|0;}
    `;
    try {
        const blob = new Blob([src], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));
    } catch(_) { worker = null; }
}

function enhanceAsync(imageData) {
    return new Promise(resolve => {
        const f = S.filter;
        const noOp = !f.brightness && !f.contrast && !f.saturation && !f.sharpness && !f.warmth
                     && !f.wbShift.r && !f.wbShift.g && !f.wbShift.b;
        if (noOp || !worker) { resolve(imageData); return; }
        const onMsg = e => {
            worker.removeEventListener('message', onMsg);
            resolve(new ImageData(new Uint8ClampedArray(e.data.buffer), imageData.width, imageData.height));
        };
        worker.addEventListener('message', onMsg);
        const buf = imageData.data.buffer.slice(0);
        worker.postMessage({ buffer: buf, width: imageData.width, height: imageData.height, filter: f }, [buf]);
    });
}

// ─── GPS ─────────────────────────────────────────────────────────
function initGPS() {
    if (!navigator.geolocation) { S.gps.status = 'error'; setChip('GPS N/A', false); return; }
    setChip('Lokasi…', false);
    navigator.geolocation.getCurrentPosition(async pos => {
        S.gps.lat = pos.coords.latitude;
        S.gps.lng = pos.coords.longitude;
        S.gps.acc = Math.round(pos.coords.accuracy);
        S.gps.status = 'ok';
        setChip(`${S.gps.lat.toFixed(4)}, ${S.gps.lng.toFixed(4)}`, true);
        try {
            const r = await fetch(
                `https://nominatim.openstreetmap.org/reverse?lat=${S.gps.lat}&lon=${S.gps.lng}&format=json`,
                { headers: { 'Accept-Language': 'id' } }
            );
            const d = await r.json();
            const a = d?.address;
            if (a) {
                S.gps.addr = [a.village || a.suburb || a.neighbourhood, a.city || a.regency, a.state]
                    .filter(Boolean).join(', ');
                setChip(`📍 ${S.gps.addr}`, true);
            }
        } catch(_) {}
    }, err => {
        S.gps.status = err.code === 1 ? 'denied' : 'error';
        setChip('Lokasi ditolak', false);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

function setChip(t, ok) {
    const el   = document.getElementById('gpsTxt');
    const chip = document.getElementById('gpsChip');
    if (el)   el.textContent = t;
    if (chip) chip.style.color = ok ? 'rgba(0,255,179,.8)' : 'rgba(255,255,255,.35)';
}

function gpsStr() {
    if (S.gps.status !== 'ok') return '';
    return S.gps.addr || `${S.gps.lat?.toFixed(5)}, ${S.gps.lng?.toFixed(5)}`;
}

// ─── CAMERA ──────────────────────────────────────────────────────
async function initCamera() {
    if (S.stream) S.stream.getTracks().forEach(t => t.stop());
    const q = parseInt(document.getElementById('quality').value);
    const constraints = {
        video: {
            width: { ideal: q },
            height: { ideal: Math.round(q * .75) },
            facingMode: S.facing
        },
        audio: S.mode === 'video'
    };
    // Aspect ratio adjustment
    const ratio = RATIOS[S.ratioIdx];
    if (ratio === '16:9') constraints.video.aspectRatio = { ideal: 16/9 };
    else if (ratio === '1:1') constraints.video.aspectRatio = { ideal: 1 };

    try {
        S.stream = await navigator.mediaDevices.getUserMedia(constraints);
        vid.srcObject = S.stream;
        vid.onloadedmetadata = () => {
            document.getElementById('camRes').textContent = `${vid.videoWidth}×${vid.videoHeight}`;
            checkCaps();
        };
        applyLiveCSS();
        initWakeLock();
    } catch(e) {
        console.error('[Camera]', e);
        const msg = e.name === 'NotAllowedError' ? '❌ Izin kamera ditolak.' :
                    e.name === 'NotFoundError'   ? '❌ Kamera tidak ditemukan.' :
                    '❌ Kamera gagal. Cek izin browser.';
        toast(msg, 'err');
    }
}

function checkCaps() {
    const track = S.stream?.getVideoTracks()[0]; if (!track) return;
    const caps  = track.getCapabilities?.() || {};
    const zs = document.getElementById('zoomSlider');
    if (caps.zoom && zs) {
        zs.min  = caps.zoom.min || 1;
        zs.max  = Math.min(caps.zoom.max || 8, 10);
        zs.step = caps.zoom.step || 0.1;
    }
}

// Minimalisir pemanggilan initCamera di event ubah orientasi, digantikan dengan penyesuaian canvas UI
window.addEventListener('orientationchange', () => {
    setTimeout(() => {
        if (vid.videoWidth && S.mode === 'video') {
            liveCvs.width = vid.videoWidth;
            liveCvs.height = vid.videoHeight;
        }
    }, 250);
});

window.addEventListener('resize', () => {
    if (S.recording && vid.videoWidth) {
        liveCvs.width = vid.videoWidth;
        liveCvs.height = vid.videoHeight;
    }
    // Perbarui layout class jika user resize browser (desktop to tablet viewport, dsb)
    applyResponsiveLayout();
});

function flipCamera() {
    S.facing = S.facing === 'environment' ? 'user' : 'environment';
    S.pro.zoom = 1;
    vid.style.transform = '';
    initCamera();
    const btn = document.getElementById('flipBtn');
    if(btn) {
        btn.style.transition = 'transform .3s';
        btn.style.transform = 'rotateY(180deg)';
        setTimeout(() => { btn.style.transform = ''; }, 340);
    }
}

// Flash/Torch dengan pengecekan capability
function toggleFlash() {
    const track = S.stream?.getVideoTracks()[0]; 
    if (!track) return;
    
    const caps = track.getCapabilities?.() || {};
    if (!('torch' in caps)) {
        toast('❌ Fitur flash tidak didukung di perangkat ini', 'err');
        return;
    }

    S.torchOn = !S.torchOn;
    const btn  = document.getElementById('flashBtn');
    const icon = document.getElementById('flashIcon');
    if(btn) btn.classList.toggle('flash-on', S.torchOn);
    if(icon) icon.className = S.torchOn ? 'fas fa-bolt' : 'fas fa-bolt-slash';
    
    track.applyConstraints({ advanced: [{ torch: S.torchOn }] }).catch(() => {
        S.torchOn = false;
        if(btn) btn.classList.remove('flash-on');
        if(icon) icon.className = 'fas fa-bolt';
        toast('Gagal menyalakan flash', 'err');
    });
}

// Tap-to-Focus
document.getElementById('camWrap').addEventListener('click', async e => {
    if (e.target.closest('button,.top-bar,.cam-grid,.quick-bar,.pro-hud,.chips-row,.timer-overlay')) return;
    if (e.touches?.length === 2) return; // ignore pinch-end
    
    const ring = document.getElementById('focusRing');
    if(ring) {
        ring.style.left = e.clientX + 'px';
        ring.style.top  = e.clientY + 'px';
        ring.classList.add('on');
        setTimeout(() => ring.classList.remove('on'), 700);
    }
    
    const track = S.stream?.getVideoTracks()[0]; 
    if (!track) return;
    
    try {
        const caps = track.getCapabilities?.() || {};
        if (caps.focusMode?.includes('manual')) {
            const rect = vid.getBoundingClientRect();
            await track.applyConstraints({ advanced: [{ focusMode: 'manual',
                pointsOfInterest: [{
                    x: (e.clientX - rect.left) / rect.width,
                    y: (e.clientY - rect.top)  / rect.height
                }]
            }] });
        }
    } catch(_) {}
    haptic([10]);
});

// ─── MODE SWITCH ─────────────────────────────────────────────────
function switchMode(m) {
    if (S.mode === m) return;
    S.mode = m;
    ['photo','video','pro'].forEach(x => {
        const el = document.getElementById('m' + x.charAt(0).toUpperCase() + x.slice(1));
        if(el) {
            el.classList.toggle('active', x === m);
            el.setAttribute('aria-pressed', x === m ? 'true' : 'false');
        }
    });
    const isVideo = m === 'video';
    document.getElementById('shutterPhoto').style.display = isVideo ? 'none'  : 'flex';
    document.getElementById('shutterVideo').style.display = isVideo ? 'flex'  : 'none';
    liveCvs.style.display = isVideo ? 'block' : 'none';

    const grid = document.querySelector('.cam-grid');
    const lvl  = document.getElementById('leveler');
    const proHud = document.getElementById('proHud');

    if(proHud) proHud.style.display = m === 'pro' ? 'flex' : 'none';
    if (grid) grid.style.display = (m === 'pro' && S.gridOn) ? 'grid' : 'none';
    if (lvl)  lvl.style.display  = m === 'pro' ? 'block' : 'none';

    if (isVideo) startLiveLoop(); else cancelAnimationFrame(S.animReq);
    
    // Perbarui constraints kamera bila mode pro perlu spesifikasi lain (opsional)
    // S.pro resets atau penyesuaian bisa dilakukan disini tanpa panggil ulang full initCamera kecuali rasio berubah.
    initCamera(); 
}

// ─── QUICK BAR: TIMER ────────────────────────────────────────────
function cycleTimer() {
    const opts = [0, 3, 10];
    const idx  = opts.indexOf(S.timerSecs);
    S.timerSecs = opts[(idx + 1) % opts.length];
    const lbl = document.getElementById('timerLabel');
    const btn = document.getElementById('timerBtn');
    if (lbl) lbl.textContent = S.timerSecs === 0 ? 'Off' : S.timerSecs + 's';
    if (btn) btn.classList.toggle('active', S.timerSecs > 0);
    toast(S.timerSecs === 0 ? 'Timer dimatikan' : `Timer ${S.timerSecs} detik`, '');
}

// ─── QUICK BAR: GRID ─────────────────────────────────────────────
function toggleGrid() {
    S.gridOn = !S.gridOn;
    const grid = document.querySelector('.cam-grid');
    const btn  = document.getElementById('gridBtn');
    if (grid) grid.style.display = S.gridOn ? 'grid' : 'none';
    if (btn)  btn.classList.toggle('active', S.gridOn);
}

// ─── QUICK BAR: BURST ────────────────────────────────────────────
function cycleBurst() {
    const opts = [1, 3, 5];
    const idx  = opts.indexOf(S.burstCount);
    S.burstCount = opts[(idx + 1) % opts.length];
    const lbl = document.getElementById('burstLabel');
    const btn = document.getElementById('burstBtn');
    if (lbl) lbl.textContent = '×' + S.burstCount;
    if (btn) btn.classList.toggle('active', S.burstCount > 1);
    toast(S.burstCount === 1 ? 'Burst dimatikan' : `Burst ${S.burstCount} foto`, '');
}

// ─── QUICK BAR: RATIO ────────────────────────────────────────────
function cycleRatio() {
    S.ratioIdx = (S.ratioIdx + 1) % RATIOS.length;
    const lbl = document.getElementById('ratioLabel');
    if (lbl) lbl.textContent = RATIOS[S.ratioIdx];
    initCamera();
}

// ─── PRO CONTROLS ────────────────────────────────────────────────
function onEV(el) {
    S.pro.ev = parseFloat(el.value);
    document.getElementById('evVal').textContent = (S.pro.ev > 0 ? '+' : '') + S.pro.ev.toFixed(1);
    applyLiveCSS();
    const track = S.stream?.getVideoTracks()[0]; if (!track) return;
    const caps = track.getCapabilities?.() || {};
    if (caps.exposureCompensation)
        track.applyConstraints({ advanced: [{ exposureCompensation: S.pro.ev }] }).catch(() => {});
}

function onZoom(el) {
    applyZoom(parseFloat(el.value));
    showZoomIndicator(S.pro.zoom);
}

const WB = {
    auto:   { r: 0,   g: 0,  b: 0  },
    sunny:  { r: 12,  g: 4,  b: -14},
    cloudy: { r: 7,   g: 2,  b: -9 },
    indoor: { r: 22,  g: 8,  b: -22},
    night:  { r: -6,  g: -2, b: 14 }
};

function onWB(val) {
    S.pro.wb = val;
    S.filter.wbShift = WB[val] || WB.auto;
    applyLiveCSS();
    saveSettings();
}

// ─── ORIENTATION ENGINE (UPGRADED) ──────────────────────────────
function normalizeAngle(angle) {
    return ((angle % 360) + 360) % 360;
}

function isTouchLikeDevice() {
    return (navigator.maxTouchPoints || 0) > 0 || window.matchMedia?.('(pointer: coarse)').matches;
}

function isTabletLikeDevice() {
    const minSide = Math.min(screen?.width || 0, screen?.height || 0);
    return isTouchLikeDevice() && minSide >= 600;
}

function getDeviceOrientation() {
    const screenAngle = screen?.orientation?.angle;
    if (Number.isFinite(screenAngle)) return normalizeAngle(screenAngle);

    if (Number.isFinite(window.orientation)) return normalizeAngle(window.orientation);

    return window.innerWidth >= window.innerHeight ? 90 : 0;
}

function shouldRotateCapture() {
    // Desktop / laptop biasanya jangan dipaksa rotate.
    // Tablet tetap ikut sensor karena perilakunya lebih dekat ke HP.
    return isTouchLikeDevice();
}

// ─── RESPONSIVE LAYOUT (Tablet & Desktop) ───────────────────────
/**
 * Tambahkan class ke <body> berdasarkan tipe perangkat:
 *   layout-mobile  → HP / perangkat sentuh kecil
 *   layout-tablet  → Tablet (sentuh, lebar ≥ 600 px)
 *   layout-desktop → Laptop / PC (non-sentuh)
 *
 * Untuk desktop: paksa tampilan landscape dengan CSS injected di bawah.
 */
function applyResponsiveLayout() {
    const isDesktop = !isTouchLikeDevice();
    const isTablet  = isTabletLikeDevice();

    document.body.classList.remove('layout-mobile', 'layout-tablet', 'layout-desktop');
    if (isDesktop) {
        document.body.classList.add('layout-desktop');
    } else if (isTablet) {
        document.body.classList.add('layout-tablet');
    } else {
        document.body.classList.add('layout-mobile');
    }
}

function injectResponsiveCSS() {
    if (document.getElementById('ac-responsive-style')) return;
    const style = document.createElement('style');
    style.id = 'ac-responsive-style';
    style.textContent = `
/* ── AuthenticCam: Responsive Layout ─────────────────────── */

/* ── TABLET (≥ 600 px, touch) ─────────────────────────────── */
body.layout-tablet #camWrap,
body.layout-tablet .cam-viewport {
    max-width: 768px;
    margin: 0 auto;
}
body.layout-tablet .settings-sheet {
    max-width: 480px;
}
body.layout-tablet .quick-bar {
    gap: 14px;
    padding: 10px 20px;
}
body.layout-tablet .top-bar {
    padding: 12px 20px;
}
body.layout-tablet .shutter-wrap {
    gap: 32px;
}

/* ── DESKTOP / LAPTOP (non-touch) ─────────────────────────── */
/* Paksa layout landscape: app container horizontal,
   viewfinder di kiri, panel kontrol di kanan            */
body.layout-desktop {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    background: #0a0a0f;
}
body.layout-desktop #app,
body.layout-desktop .app-root {
    display: grid;
    grid-template-columns: 1fr 340px;
    grid-template-rows: 100vh;
    max-width: 1200px;
    width: 100%;
    overflow: hidden;
    border-radius: 0;
    box-shadow: 0 0 60px rgba(0,0,0,.6);
}
body.layout-desktop #camWrap,
body.layout-desktop .cam-viewport {
    grid-column: 1;
    width: 100%;
    height: 100vh;
    border-radius: 0;
}
body.layout-desktop .settings-sheet,
body.layout-desktop #settingsSheet {
    position: static !important;
    grid-column: 2;
    height: 100vh;
    transform: none !important;
    border-radius: 0;
    overflow-y: auto;
    box-shadow: -2px 0 20px rgba(0,0,0,.4);
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
}
body.layout-desktop .sheet-backdrop,
body.layout-desktop #sheetBackdrop {
    display: none !important;
}
body.layout-desktop .top-bar {
    padding: 14px 24px;
}
body.layout-desktop .quick-bar {
    gap: 18px;
    padding: 12px 24px;
}
body.layout-desktop .shutter-wrap {
    gap: 40px;
}
/* Tombol shutter lebih besar di desktop */
body.layout-desktop .shutter-photo,
body.layout-desktop #shutterPhoto {
    width: 72px;
    height: 72px;
}
/* Sembunyikan tombol settings di desktop karena panel selalu terbuka */
body.layout-desktop #settingsBtn {
    display: none !important;
}

/* ── Responsif umum: tidak ada horizontal scroll ──────────── */
body {
    overflow-x: hidden;
}
@media (max-width: 599px) {
    body.layout-tablet { /* fallback jika class salah detect */ }
}
@media (min-width: 600px) and (max-width: 1023px) {
    /* Tablet tambahan via media query sebagai safety net */
    body:not(.layout-desktop) #camWrap { max-width: 700px; margin: 0 auto; }
}
    `;
    document.head.appendChild(style);
}


function buildCaptureCanvas() {
    const vw = vid.videoWidth || 0;
    const vh = vid.videoHeight || 0;
    const rawAngle = shouldRotateCapture() ? getDeviceOrientation() : 0;
    const angle = normalizeAngle(rawAngle);

    const rotate = angle === 90 || angle === 270;
    const cw = rotate ? vh : vw;
    const ch = rotate ? vw : vh;

    cvs.width = cw;
    cvs.height = ch;

    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, cw, ch);

    console.log({
        videoWidth: vw,
        videoHeight: vh,
        canvasWidth: cw,
        canvasHeight: ch,
        orientation: angle,
        touchLike: isTouchLikeDevice(),
        tabletLike: isTabletLikeDevice(),
        facing: S.facing
    });

    ctx.save();

    if (angle === 90) {
        ctx.translate(cw, 0);
        ctx.rotate(Math.PI / 2);
    } else if (angle === 270) {
        ctx.translate(0, ch);
        ctx.rotate(-Math.PI / 2);
    } else if (angle === 180) {
        ctx.translate(cw, ch);
        ctx.rotate(Math.PI);
    }

    // Kamera depan tetap mirror
    if (S.facing === 'user') {
        ctx.translate(vw, 0);
        ctx.scale(-1, 1);
    }

    ctx.drawImage(vid, 0, 0, vw, vh);
    ctx.restore();

    return { ctx, canvasW: cw, canvasH: ch, angle };
}

function drawLiveFrame(ctx, w, h) {
    ctx.save();
    if (S.facing === 'user') {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
    }
    ctx.drawImage(vid, 0, 0, w, h);
    ctx.restore();
}

// ─── WATERMARK ENGINE ────────────────────────────────────────────
async function applyWatermark(ctx, cw, ch, opts = {}) {
    const {
        owner = 'Original Creator', info = '', timestamp = '',
        gps = '', signature = '', style = 'dark', position = 'strip-bot',
        opacity = .75, logo = null, showGPS = true, showSig = true,
        qrImage = null, qrPosition = 'in-strip',
        wmAdaptive = true
    } = opts;

    const base = Math.min(cw, ch);
    const px   = v => Math.round(base * v);

    const isAdaptive = wmAdaptive !== false;

    // ── Orientasi ditentukan dari dimensi canvas FINAL, bukan dari screen angle.
    // Fallback ke metadata video jika canvas belum di-render / dimensi sama.
    // Ini memastikan konsistensi di portrait maupun landscape di semua device.
    const isPortrait = ch > cw || (vid?.videoHeight > vid?.videoWidth);

    // ── Ukuran tipografi & padding disesuaikan orientasi + mode adaptive.
    // Landscape lebih compact karena tinggi strip terbatas.
    let fMain = isPortrait ? px(.035) : px(.025);
    let fSub  = isPortrait ? px(.024) : px(.018);
    let padV  = isPortrait ? px(.028) : px(.018);
    let padH  = isPortrait ? px(.030) : px(.022);

    // Jika adaptive dimatikan, kembalikan ke ukuran standar netral
    if (!isAdaptive) {
        fMain = px(.030); fSub = px(.021);
        padV  = px(.020); padH = px(.024);
    }

    const PALS = {
        dark:    { bg:`rgba(0,0,0,${opacity*.82})`,       txt:'rgba(255,255,255,.92)', sub:'rgba(255,255,255,.55)', acc:'#00d4ff', bar:'#00d4ff' },
        light:   { bg:`rgba(255,255,255,${opacity*.88})`, txt:'rgba(0,0,0,.88)',       sub:'rgba(0,0,0,.5)',        acc:'#0055aa', bar:'#0055aa' },
        glass:   { bg:`rgba(255,255,255,${opacity*.16})`, txt:'rgba(255,255,255,.95)', sub:'rgba(255,255,255,.6)',  acc:'#00ffb3', bar:'#00ffb3' },
        brand:   { bg:`rgba(0,18,50,${opacity*.92})`,     txt:'rgba(255,204,0,1)',     sub:'rgba(255,204,0,.55)',   acc:'#ffcc00', bar:'#ffcc00' }
    };
    const P = PALS[style] || PALS.dark;
    ctx.save();

    if (position === 'diagonal') {
        ctx.globalAlpha = opacity * .10;
        ctx.fillStyle   = '#fff';
        ctx.font        = `bold ${px(.042)}px Outfit,sans-serif`;
        ctx.textAlign   = 'center';
        ctx.translate(cw/2, ch/2); ctx.rotate(-Math.PI/7);
        const lbl = `${owner}  ·  AuthenticCam Pro`;
        const sx  = cw * .52, sy = px(.13);
        for (let iy = -(Math.ceil(ch/sy)+3); iy <= Math.ceil(ch/sy)+3; iy++)
            for (let ix = -(Math.ceil(cw/sx)+3); ix <= Math.ceil(cw/sx)+3; ix++)
                ctx.fillText(lbl, ix*sx, iy*sy);
        ctx.restore(); ctx.save();
        drawSigCorner(ctx, cw, ch, signature, P.acc, px);
        ctx.restore(); return;
    }

    if (position === 'strip-bot' || position === 'strip-top') {
        const lh     = fMain * 1.22;
        const logoSz = lh * 1.7;
        const line1  = owner;

        let line2 = '';
        let line3 = null;

        // Landscape: semua info dijejal dalam 1–2 baris (tinggi strip terbatas)
        // Portrait: GPS dipisah ke baris ke-3 agar lebih terbaca
        if (isAdaptive && !isPortrait) {
            line2 = [info, timestamp, (showGPS && gps) ? `📍 ${gps}` : null].filter(Boolean).join('  ·  ');
        } else {
            line2 = [info, timestamp].filter(Boolean).join('  ·  ');
            line3 = (showGPS && gps) ? `📍 ${gps}` : null;
        }

        const nLines = 1 + (line2 ? 1 : 0) + (line3 ? 1 : 0);
        const hasQrInStrip = qrImage && qrPosition === 'in-strip';

        // QR size & strip height menyesuaikan orientasi
        const qrSz    = hasQrInStrip
            ? (isPortrait ? Math.min(ch * .10, cw * .085) : Math.min(ch * .08, cw * .065))
            : 0;
        const stripH  = padV * 2 + fMain + (nLines - 1) * (fSub * 1.38) + (nLines > 1 ? lh * .28 : 0);
        const sy      = position === 'strip-top' ? 0 : ch - stripH;

        ctx.globalAlpha = 1;
        ctx.fillStyle   = P.bg;
        ctx.fillRect(0, sy, cw, stripH);

        const barH = Math.max(2, px(.003));
        ctx.fillStyle = P.bar;
        ctx.fillRect(0, position === 'strip-top' ? sy+stripH-barH : sy, cw, barH);

        let textX = padH;
        if (logo) {
            try {
                const lx = padH * .7, ly = sy + (stripH - logoSz) / 2;
                ctx.save(); ctx.globalAlpha = Math.min(1, opacity + .15);
                ctx.beginPath(); ctx.arc(lx + logoSz/2, ly + logoSz/2, logoSz/2, 0, Math.PI*2); ctx.clip();
                ctx.drawImage(logo, lx, ly, logoSz, logoSz);
                ctx.restore(); textX = lx + logoSz + padH * .75;
            } catch(_) {}
        }

        const rightReserve = hasQrInStrip ? qrSz + padH*1.5 : padH;
        const maxW = cw - textX - rightReserve;

        ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 4;
        ctx.textAlign   = 'left';
        ctx.globalAlpha = 1; ctx.fillStyle = P.txt;
        ctx.font = `700 ${fMain}px Outfit,sans-serif`;
        let ty = sy + padV + fMain;
        ctx.fillText(clip(ctx, line1, maxW), textX, ty);

        if (line2) {
            ty += lh * .2 + fSub;
            ctx.fillStyle = P.sub; ctx.font = `400 ${fSub}px 'Fira Code',monospace`;
            ctx.globalAlpha = .86;
            ctx.fillText(clip(ctx, line2, maxW), textX, ty);
        }
        if (line3) {
            ty += fSub * 1.32;
            ctx.fillStyle = P.acc; ctx.font = `400 ${fSub*.9}px 'Fira Code',monospace`;
            ctx.globalAlpha = .74;
            ctx.fillText(clip(ctx, line3, maxW), textX, ty);
        }
        ctx.shadowBlur = 0;

        if (showSig) {
            const sigX = hasQrInStrip ? cw - qrSz - padH*1.7 : cw - padH;
            ctx.fillStyle = P.acc; ctx.font = `500 ${px(.016)}px 'Fira Code',monospace`;
            ctx.textAlign = 'right'; ctx.globalAlpha = .55;
            ctx.fillText(signature, sigX, sy + stripH - padV * .5);
        }
        if (hasQrInStrip && qrImage) {
            const qx = cw - qrSz - padH * .5, qy = sy + (stripH - qrSz) / 2;
            ctx.globalAlpha = .95; ctx.fillStyle = '#fff';
            roundRect(ctx, qx-2, qy-2, qrSz+4, qrSz+4, 4); ctx.fill();
            ctx.drawImage(qrImage, qx, qy, qrSz, qrSz);
        }
        ctx.restore();
        if (qrImage && qrPosition !== 'in-strip') drawQRCorner(ctx, cw, ch, qrImage, qrPosition, padH, base);
        return;
    }

    // Corner badge — ukuran, posisi, dan proporsi semua berbasis cw/ch aktual
    {
        const mg  = px(.020);
        const bw  = cw * .52;
        const bh  = fMain * 4.5;
        const r   = px(.010);
        const bx  = position === 'corner-br' ? cw - bw - mg : mg;
        const by  = ch - bh - mg;         // selalu di bagian bawah canvas aktual
        ctx.globalAlpha = 1; ctx.fillStyle = P.bg; roundRect(ctx, bx, by, bw, bh, r); ctx.fill();
        ctx.fillStyle = P.bar; roundRect(ctx, bx, by, Math.max(3, px(.004)), bh, [r, 0, 0, r]); ctx.fill();
        let tx = bx + padH;
        if (logo) {
            try {
                // Logo size proporsional terhadap orientasi
                const lsz = isPortrait ? bh * .55 : bh * .48;
                const lx  = bx + padH * .55;
                const ly  = by + (bh - lsz) / 2;
                ctx.save(); ctx.globalAlpha = opacity;
                ctx.beginPath(); ctx.arc(lx + lsz/2, ly + lsz/2, lsz/2, 0, Math.PI * 2); ctx.clip();
                ctx.drawImage(logo, lx, ly, lsz, lsz); ctx.restore();
                tx = lx + lsz + padH * .7;
            } catch(_) {}
        }
        const mxW = bw - (tx - bx) - padH;
        ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 4; ctx.textAlign = 'left';
        ctx.fillStyle = P.txt; ctx.font = `700 ${fMain}px Outfit,sans-serif`; ctx.globalAlpha = 1;
        ctx.fillText(clip(ctx, owner, mxW), tx, by + bh * .44);
        const sub = [info, timestamp, showGPS && gps ? `📍 ${gps}` : ''].filter(Boolean).join(' · ');
        ctx.fillStyle = P.sub; ctx.font = `400 ${fSub}px 'Fira Code',monospace`; ctx.globalAlpha = .85;
        ctx.fillText(clip(ctx, sub, mxW), tx, by + bh * .74);
        ctx.shadowBlur = 0;
        drawSigCorner(ctx, cw, ch, signature, P.acc, px);
        ctx.restore();
        if (qrImage) drawQRCorner(ctx, cw, ch, qrImage, qrPosition, mg, base);
    }
}

function drawSigCorner(ctx, cw, ch, sig, color, px) {
    if (!sig) return;
    // Posisi signature selalu relatif terhadap ch/cw aktual (sudah termasuk rotasi)
    ctx.save();
    ctx.globalAlpha = .48; ctx.fillStyle = color;
    ctx.font = `500 ${px(.016)}px 'Fira Code',monospace`;
    ctx.textAlign = 'right';
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 3;
    ctx.fillText(sig, cw - px(.016), ch - px(.012));
    ctx.restore();
}

function drawQRCorner(ctx, cw, ch, qrImg, pos, pad, base) {
    // QR size proporsional terhadap sisi terpendek canvas (berlaku di portrait & landscape)
    const sz = Math.round(base * .10);
    const qx = (pos === 'corner-bl' || pos === 'corner-tl') ? pad : cw - sz - pad;
    const qy = (pos === 'corner-tr' || pos === 'corner-tl') ? pad : ch - sz - pad;
    ctx.save(); ctx.globalAlpha = .93; ctx.fillStyle = '#fff';
    roundRect(ctx, qx - 3, qy - 3, sz + 6, sz + 6, 5); ctx.fill();
    ctx.drawImage(qrImg, qx, qy, sz, sz); ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
    if (typeof r === 'number') r = [r,r,r,r];
    ctx.beginPath();
    ctx.moveTo(x+r[0],y); ctx.lineTo(x+w-r[1],y);
    ctx.quadraticCurveTo(x+w,y,x+w,y+r[1]); ctx.lineTo(x+w,y+h-r[2]);
    ctx.quadraticCurveTo(x+w,y+h,x+w-r[2],y+h); ctx.lineTo(x+r[3],y+h);
    ctx.quadraticCurveTo(x,y+h,x,y+h-r[3]); ctx.lineTo(x,y+r[0]);
    ctx.quadraticCurveTo(x,y,x+r[0],y); ctx.closePath();
}

function clip(ctx, text, maxW) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 0 && ctx.measureText(t+'…').width > maxW) t = t.slice(0,-1);
    return t + '…';
}

// ─── QR CODE ─────────────────────────────────────────────────────
const QR_PX = { small: 80, medium: 120, large: 180 };

async function genQR(data, size) {
    return new Promise(resolve => {
        if (typeof QRCode === 'undefined') { resolve(null); return; }
        QRCode.toDataURL(data, { width: size, margin: 1, errorCorrectionLevel: 'M' })
            .then(url => { const img=new Image(); img.onload=()=>resolve(img); img.onerror=()=>resolve(null); img.src=url; })
            .catch(() => resolve(null));
    });
}

// ─── SHA-256 ─────────────────────────────────────────────────────
async function sha256(blob) {
    try {
        const buf  = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
    } catch(_) { return null; }
}

// ─── SIGNATURE ───────────────────────────────────────────────────
function makeSig() {
    const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = 'AC-';
    for (let i = 0; i < 4; i++) s += ch[Math.floor(Math.random() * ch.length)];
    s += '-';
    for (let i = 0; i < 4; i++) s += ch[Math.floor(Math.random() * ch.length)];
    return s;
}

// ─── SELF-TIMER ──────────────────────────────────────────────────
function captureWithTimer() {
    if (S.timerSecs === 0) {
        if (S.burstCount > 1) captureMultiple();
        else capturePhoto();
        return;
    }
    if (S.timerActive) { cancelTimer(); return; }
    S.timerActive = true;
    let count = S.timerSecs;
    const overlay = document.getElementById('timerOverlay');
    const countEl = document.getElementById('timerCount');
    overlay.style.display = 'flex';
    countEl.textContent = count;
    haptic([50]);

    function tick() {
        count--;
        if (count > 0) {
            countEl.textContent = count;
            countEl.style.animation = 'none';
            countEl.offsetHeight; // reflow
            countEl.style.animation = '';
            haptic([30]);
            S.timerTick = setTimeout(tick, 1000);
        } else {
            overlay.style.display = 'none';
            S.timerActive = false;
            haptic([80, 40, 80]);
            if (S.burstCount > 1) captureMultiple();
            else capturePhoto();
        }
    }
    S.timerTick = setTimeout(tick, 1000);
}

function cancelTimer() {
    clearTimeout(S.timerTick);
    S.timerActive = false;
    document.getElementById('timerOverlay').style.display = 'none';
    toast('Timer dibatalkan', '');
}

// ─── BURST MODE ──────────────────────────────────────────────────
async function captureMultiple() {
    toast(`📸 Burst ${S.burstCount}×…`, '');
    for (let i = 0; i < S.burstCount; i++) {
        await capturePhoto(true);
        if (i < S.burstCount - 1) await new Promise(r => setTimeout(r, 350));
    }
}

// ─── PHOTO CAPTURE ───────────────────────────────────────────────
async function capturePhoto(silent = false) {
    if (S.locked || !vid.videoWidth) {
        if (!silent) toast('Kamera belum siap', 'err');
        return;
    }
    lockCapture(true);

    try {
        const ctx    = cvs.getContext('2d');
        const owner  = document.getElementById('ownerName').value || 'Original Creator';
        const info   = document.getElementById('assetInfo').value || '';
        const ts     = new Date().toLocaleString('id-ID', { dateStyle:'short', timeStyle:'short' });
        const sig    = makeSig();
        const pos    = document.getElementById('wmPos').value;
        const style  = document.getElementById('wmStyle').value;
        const op     = parseInt(document.getElementById('wmOp').value) / 100;
        const showGPS = document.getElementById('wmGps').checked;
        const showSig = document.getElementById('wmSig').checked;
        const qrOn   = document.getElementById('qrOn').checked;
        const qrPos  = document.getElementById('qrPos').value;
        const qrSzPx = QR_PX[document.getElementById('qrSize').value] || 120;
        const fmt    = document.getElementById('exportFmt').value;
        const qual   = parseInt(document.getElementById('qualSlider').value) / 100;
        
        // Cek DOM untuk adaptive watermark (default true)
        const adaptiveEl = document.getElementById('wmAdaptive');
        const wmAdaptive = adaptiveEl ? adaptiveEl.checked : true;

        if (!silent) showProc('Menangkap gambar…');
        const { canvasW, canvasH } = buildCaptureCanvas();

        if (!silent) showProc('Meningkatkan kualitas…');
        const imgData  = ctx.getImageData(0, 0, canvasW, canvasH);
        const enhanced = await enhanceAsync(imgData);
        ctx.putImageData(enhanced, 0, 0);

        let qrImg = null;
        if (qrOn) {
            if (!silent) showProc('Membuat QR Code…');
            const qrData = `AUTHENTICAM|SIG:${sig}|OWN:${owner}${info ? '|AST:'+info : ''}|DAT:${ts}${showGPS && gpsStr() ? '|GPS:'+gpsStr() : ''}|VER:2`;
            qrImg = await genQR(qrData, qrSzPx);
        }

        if (!silent) showProc('Menambahkan watermark…');
        await applyWatermark(ctx, canvasW, canvasH, {
            owner, info, timestamp: ts,
            gps:  showGPS ? gpsStr() : '',
            signature: sig, style, position: pos, opacity: op,
            logo: S.logo, showGPS, showSig,
            qrImage: qrImg, qrPosition: qrPos,
            wmAdaptive
        });

        if (!silent) showProc('Menyimpan…');
        const mime = fmt==='png' ? 'image/png' : fmt==='webp' ? 'image/webp' : 'image/jpeg';
        const ext  = fmt==='png' ? 'png' : fmt==='webp' ? 'webp' : 'jpg';
        const q2   = fmt==='png' ? undefined : qual;

        cvs.toBlob(async blob => {
            const url  = URL.createObjectURL(blob);
            const hash = await sha256(blob);
            S.lastBlob = blob;

            // Play shutter sound
            if (document.getElementById('soundTog')?.checked) playShutterSound();

            // Update gallery thumb
            const gt = document.getElementById('galleryThumb');
            if(gt) {
                const tmpImg = new Image(); tmpImg.src = url;
                gt.innerHTML = ''; gt.appendChild(tmpImg);
            }

            // Set up result
            const dl = document.getElementById('dlLink');
            if(dl) { dl.href = url; dl.download = `AuthenticCam_${sig}.${ext}`; }
            
            const pPreview = document.getElementById('photoPreview');
            const vPreview = document.getElementById('videoPreview');
            const bTxt = document.getElementById('resultBadgeTxt');
            
            if(pPreview) { pPreview.src = url; pPreview.style.display = 'block'; }
            if(vPreview) vPreview.style.display = 'none';
            if(bTxt) bTxt.textContent = 'Foto Terverifikasi';

            fillMeta({ owner, info, ts, sig, gps: gpsStr(), w: canvasW, h: canvasH, hash,
                       fmt: fmt.toUpperCase(), size: (blob.size/1024).toFixed(0)+' KB' });

            doFlash();
            haptic([80]);
            hideProc(); lockCapture(false);
            if (!silent) { openResult(); }
            toast('✅ Foto terverifikasi!', 'ok');
        }, mime, q2);

    } catch(e) {
        console.error('[Capture]', e);
        hideProc(); lockCapture(false);
        toast('❌ Gagal memproses', 'err');
    }
}

// ─── CAPTURE LOCK ────────────────────────────────────────────────
function lockCapture(lock) {
    S.locked = lock;
    const btn = document.getElementById('shutterPhoto');
    if (!btn) return;
    btn.disabled = lock;
    btn.classList.toggle('processing', lock);
}

// ─── PROCESSING OVERLAY ──────────────────────────────────────────
function showProc(msg) {
    const el = document.getElementById('procOverlay');
    const tx = document.getElementById('procTxt');
    if(el) el.style.display = 'flex'; 
    if (tx) tx.textContent = msg;
}
function hideProc() { 
    const el = document.getElementById('procOverlay');
    if(el) el.style.display = 'none'; 
}

// ─── VIDEO RECORDING ─────────────────────────────────────────────
function startLiveLoop() {
    const draw = () => {
        if (vid.readyState < 2 || !vid.videoWidth) { S.animReq = requestAnimationFrame(draw); return; }
        
        const vw = vid.videoWidth, vh = vid.videoHeight;

        // Sesuaikan canvas tanpa memaksakan rotasi tambahan
        if (liveCvs.width !== vw || liveCvs.height !== vh) {
            liveCvs.width  = vw;
            liveCvs.height = vh;
        }

        liveCtx.clearRect(0, 0, liveCvs.width, liveCvs.height);
        drawLiveFrame(liveCtx, liveCvs.width, liveCvs.height);

        if (S.recording) {
            const adaptiveEl = document.getElementById('wmAdaptive');
            applyWatermark(liveCtx, liveCvs.width, liveCvs.height, {
                owner:     document.getElementById('ownerName').value || 'Original Creator',
                info:      document.getElementById('assetInfo').value || '',
                timestamp: new Date().toLocaleString('id-ID', { timeStyle:'short' }),
                gps:       document.getElementById('wmGps').checked ? gpsStr() : '',
                signature: S.sig, style: document.getElementById('wmStyle').value,
                position:  document.getElementById('wmPos').value,
                opacity:   parseInt(document.getElementById('wmOp').value) / 100,
                logo: S.logo,
                showGPS:  document.getElementById('wmGps').checked,
                showSig:  document.getElementById('wmSig').checked,
                wmAdaptive: adaptiveEl ? adaptiveEl.checked : true
            });
        }
        S.animReq = requestAnimationFrame(draw);
    };
    cancelAnimationFrame(S.animReq);
    draw();
}

function toggleRecording() { S.recording ? stopRec() : startRec(); }

function startRec() {
    S.chunks=[]; S.sig=makeSig(); S.recSecs=0;
    const cs   = liveCvs.captureStream(30);
    if (S.stream) S.stream.getAudioTracks().forEach(t => cs.addTrack(t));
    const mime = bestMime();
    S.recorder = new MediaRecorder(cs, mime ? { mimeType: mime } : {});
    S.recorder.ondataavailable = e => { if (e.data.size > 0) S.chunks.push(e.data); };
    S.recorder.onstop = () => {
        const blob = new Blob(S.chunks, { type: mime || 'video/webm' });
        const url  = URL.createObjectURL(blob);
        const ext  = mime?.includes('mp4') ? 'mp4' : 'webm';
        
        const vp   = document.getElementById('videoPreview');
        const pp   = document.getElementById('photoPreview');
        if(vp) { vp.src = url; vp.style.display = 'block'; }
        if(pp) pp.style.display = 'none';
        
        const dl = document.getElementById('dlLink');
        if(dl) { dl.href = url; dl.download = `AuthenticCam_${S.sig}.${ext}`; }
        
        const bTxt = document.getElementById('resultBadgeTxt');
        if(bTxt) bTxt.textContent = 'Video Terverifikasi';
        
        const owner = document.getElementById('ownerName').value || 'Original Creator';
        const ts    = new Date().toLocaleString('id-ID', { dateStyle:'short', timeStyle:'short' });
        fillMeta({ owner, info: document.getElementById('assetInfo').value,
                   ts, sig: S.sig, gps: gpsStr(), w: liveCvs.width, h: liveCvs.height });
        haptic([60,40,60]);
        openResult(); toast('✅ Video tersimpan!', 'ok');
    };
    S.recorder.start(100); S.recording = true;
    
    const recChip = document.getElementById('recChip');
    const shVid = document.getElementById('shutterVideo');
    const dot = document.getElementById('shInnerVid');
    if(recChip) recChip.style.display = 'flex';
    if(shVid) shVid.classList.add('rec');
    if(dot) { dot.style.borderRadius = '8px'; dot.style.width = '28px'; dot.style.height = '28px'; }
    
    S.recTick = setInterval(() => {
        S.recSecs++;
        const m = String(Math.floor(S.recSecs/60)).padStart(2,'0');
        const s = String(S.recSecs % 60).padStart(2,'0');
        const rt = document.getElementById('recTime');
        if(rt) rt.textContent = `${m}:${s}`;
    }, 1000);
}

function stopRec() {
    if (S.recorder?.state !== 'inactive') S.recorder.stop();
    S.recording = false; clearInterval(S.recTick);
    
    const recChip = document.getElementById('recChip');
    const shVid = document.getElementById('shutterVideo');
    const dot = document.getElementById('shInnerVid');
    if(recChip) recChip.style.display = 'none';
    if(shVid) shVid.classList.remove('rec');
    if(dot) { dot.style.borderRadius = '50%'; dot.style.width = ''; dot.style.height = ''; }
}

function bestMime() {
    const t = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm','video/mp4'];
    return t.find(x => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(x)) || null;
}

// ─── SETTINGS SHEET ──────────────────────────────────────────────
function openSettings()  {
    document.getElementById('settingsSheet')?.classList.add('open');
    document.getElementById('sheetBackdrop')?.classList.add('open');
}
function closeSettings() {
    document.getElementById('settingsSheet')?.classList.remove('open');
    document.getElementById('sheetBackdrop')?.classList.remove('open');
}
function toggleScard(id) {
    document.getElementById(id)?.classList.toggle('collapsed');
}

// ─── RESULT MODAL ────────────────────────────────────────────────
function openResult() {
    const overlay = document.getElementById('resultOverlay');
    if(overlay) overlay.style.display = 'flex';
    closeSettings();
}
function closeResult() {
    const overlay = document.getElementById('resultOverlay');
    if(overlay) overlay.style.display = 'none';
}

function fillMeta({ owner, info, ts, sig, gps, w, h, hash, fmt, size }) {
    const rows = [
        ['OWNER', owner], ['ASSET', info || '—'], ['DATE', ts],
        ['SIG ID', sig], ['RES', `${w}×${h}px`]
    ];
    if (fmt)  rows.push(['FORMAT', fmt]);
    if (size) rows.push(['SIZE', size]);
    if (S.gps.status === 'ok') {
        rows.push(['GPS', `${S.gps.lat?.toFixed(6)}, ${S.gps.lng?.toFixed(6)}`]);
        if (S.gps.acc) rows.push(['AKURASI', `±${S.gps.acc}m`]);
    }
    if (gps && S.gps.addr) rows.push(['LOKASI', gps]);
    
    const mc = document.getElementById('metaCard');
    if(mc) mc.innerHTML = rows.map(([l, v]) => `<div class="mrow"><span class="mlbl">${l}</span><span class="mval">${esc(String(v))}</span></div>`).join('');
    
    const hs = document.getElementById('hashStrip');
    if(hs) {
        if (hash) {
            hs.innerHTML = `<b style="color:rgba(0,212,255,.65)">SHA-256</b><br>${hash}`;
            hs.style.display = 'block';
        } else {
            hs.style.display = 'none';
        }
    }
}

// ─── SHARE ───────────────────────────────────────────────────────
async function shareAsset() {
    const dl = document.getElementById('dlLink');
    if (!dl || !dl.href || dl.href === location.href) { toast('Ambil foto dulu!', 'err'); return; }
    if (navigator.share) {
        try {
            const res  = await fetch(dl.href);
            const blob = await res.blob();
            await navigator.share({
                files: [new File([blob], dl.download, { type: blob.type })],
                title: 'AuthenticCam Verified Asset'
            });
            return;
        } catch(_) {}
    }
    navigator.clipboard?.writeText(dl.href).then(() => toast('URL disalin!', 'ok'));
}

// ─── AI ENHANCEMENT ──────────────────────────────────────────────
const PRESETS = {
    none:     { brightness:0,  contrast:0,  saturation:0,  sharpness:0,  warmth:0  },
    auto:     { brightness:15, contrast:22, saturation:15, sharpness:35, warmth:5  },
    vivid:    { brightness:10, contrast:30, saturation:50, sharpness:20, warmth:10 },
    night:    { brightness:40, contrast:25, saturation:-10,sharpness:40, warmth:0  },
    portrait: { brightness:8,  contrast:15, saturation:10, sharpness:15, warmth:15 }
};
const FK = [['brightness','eBri'],['contrast','eCon'],['saturation','eSat'],['sharpness','eShr'],['warmth','eWrm']];

function setPreset(n) {
    const p = PRESETS[n]; if (!p) return;
    FK.forEach(([k, id]) => {
        const el = document.getElementById(id);
        const ve = document.getElementById(id + 'V');
        if (el) { el.value = p[k]; } if (ve) ve.textContent = p[k];
        S.filter[k] = p[k];
    });
    document.querySelectorAll('.pp').forEach(b => b.classList.remove('active'));
    document.getElementById('p' + n[0].toUpperCase() + n.slice(1))?.classList.add('active');
    applyLiveCSS(); saveSettings();
}

function updFilter() {
    FK.forEach(([k, id]) => {
        const el = document.getElementById(id);
        const ve = document.getElementById(id + 'V');
        if (el) { S.filter[k] = parseInt(el.value); if (ve) ve.textContent = el.value; }
    });
    document.querySelectorAll('.pp').forEach(b => b.classList.remove('active'));
    applyLiveCSS(); saveSettings();
}

function applyLiveCSS() {
    const f = S.filter, ev = S.pro.ev * 20;
    vid.style.filter = `brightness(${1+(f.brightness+ev)/100}) contrast(${1+f.contrast/100}) saturate(${1+f.saturation/100})`;
}

function resetFilters() { setPreset('none'); vid.style.filter = ''; }

function updFmtHint() {
    const hints = {
        jpeg: 'JPEG — ukuran kecil, kualitas baik. Cocok untuk share.',
        png:  'PNG — lossless tanpa kompresi. Ukuran besar.',
        webp: 'WebP — modern & efisien. Ukuran kecil, kualitas sangat baik.'
    };
    const el = document.getElementById('fmtHint');
    if (el) el.textContent = hints[document.getElementById('exportFmt').value] || '';
}

// ─── LOGO UPLOAD ─────────────────────────────────────────────────
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

// ─── SHUTTER SOUND ───────────────────────────────────────────────
let audioCtx = null;
function playShutterSound() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.type = 'sine'; osc.frequency.value = 800;
        gain.gain.setValueAtTime(.4, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(.0001, audioCtx.currentTime + .12);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + .12);
    } catch(_) {}
}

// ─── FLASH EFFECT ────────────────────────────────────────────────
function doFlash() {
    const el = document.getElementById('flashEl');
    if(!el) return;
    el.classList.add('on');
    setTimeout(() => el.classList.remove('on'), 150);
}

// ─── HAPTIC FEEDBACK ─────────────────────────────────────────────
function haptic(pattern = [30]) {
    if (document.getElementById('hapticTog')?.checked !== false)
        navigator.vibrate?.(pattern);
}

// ─── TOAST ───────────────────────────────────────────────────────
function toast(msg, type = '') {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className = `toast ${type}`; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
        t.style.opacity = '0';
        t.style.transition = 'opacity .28s';
        setTimeout(() => t.remove(), 300);
    }, 2700);
}

// ─── UTILS ───────────────────────────────────────────────────────
function esc(s) {
    return String(s)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;');
}

function getDeviceOrientation() {
    if (screen.orientation && screen.orientation.angle !== undefined) {
        return screen.orientation.angle;
    }
    return window.orientation || 0;
}

// ─── KEYBOARD & HARDWARE SHORTCUTS ──────────────────────────────
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.code) {
        case 'Space':
            e.preventDefault();
            if (S.mode === 'video') toggleRecording();
            else captureWithTimer();
            break;
        case 'KeyV': e.preventDefault(); switchMode(S.mode === 'video' ? 'photo' : 'video'); break;
        case 'KeyF': e.preventDefault(); toggleFlash(); break;
        case 'KeyG': e.preventDefault(); toggleGrid(); break;
        case 'KeyT': e.preventDefault(); cycleTimer(); break;
        case 'ArrowLeft': case 'ArrowRight':
            e.preventDefault(); flipCamera(); break;
        case 'Escape':
            if (S.timerActive) cancelTimer();
            else { closeResult(); closeSettings(); }
            break;
    }
});

// Volume buttons (hardware shutter) via MediaSession / keydown on Android WebView
window.addEventListener('keydown', e => {
    if (e.key === 'AudioVolumeUp' || e.key === 'AudioVolumeDown') {
        e.preventDefault();
        if (S.mode === 'video') toggleRecording();
        else captureWithTimer();
    }
});

// ─── BOOT ────────────────────────────────────────────────────────
function boot() {
    injectProUI();
    injectResponsiveCSS();   // Inject CSS responsif tablet & desktop landscape
    applyResponsiveLayout(); // Pasang class layout berdasarkan tipe perangkat
    initWorker();
    loadSettings();
    initGPS();
    initCamera();
    initPinchZoom();
}

boot();
