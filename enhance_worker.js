/* ══════════════════════════════════════════════════════════════
   AuthenticCam Pro · enhance_worker.js v9.0
   Off-main-thread image processing via Web Worker.
   Receives ImageData buffer, applies filters, returns result.
   Supports: brightness, contrast, saturation, warmth,
             white balance shift, unsharp mask sharpening,
             and basic noise reduction (bilateral approx).
══════════════════════════════════════════════════════════════ */

self.onmessage = function(e) {
    const { action = 'enhance', buffer, width, height, filter } = e.data;

    if (action !== 'enhance') return;

    const d = new Uint8ClampedArray(buffer);

    // ─ Compute multipliers once ─
    const bri = filter.brightness * 2.55;
    const con = (filter.contrast + 100) / 100;
    const sat = (filter.saturation + 100) / 100;
    const wrm = filter.warmth * 1.4;
    const wb  = filter.wbShift || { r: 0, g: 0, b: 0 };

    // ─ Per-pixel color transforms ─
    for (let i = 0; i < d.length; i += 4) {
        let r = d[i], g = d[i + 1], b = d[i + 2];

        // Brightness
        r += bri; g += bri; b += bri;

        // Contrast (pivot 128)
        r = (r - 128) * con + 128;
        g = (g - 128) * con + 128;
        b = (b - 128) * con + 128;

        // Warmth (color temperature)
        r += wrm * 0.5;
        b -= wrm * 0.3;
        g += wrm * 0.08;

        // White balance shift
        r += wb.r; g += wb.g; b += wb.b;

        // Saturation via luminance
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = lum + sat * (r - lum);
        g = lum + sat * (g - lum);
        b = lum + sat * (b - lum);

        d[i]     = clp(r);
        d[i + 1] = clp(g);
        d[i + 2] = clp(b);
        // Alpha channel untouched
    }

    // ─ Unsharp mask (Laplacian) ─
    if (filter.sharpness > 0) {
        sharpen(d, width, height, filter.sharpness / 100);
    }

    // ─ Return buffer (zero-copy transfer) ─
    self.postMessage({ action: 'done', buffer: d.buffer }, [d.buffer]);
};

// ─── Unsharp Mask via Laplacian Kernel ────────────────────────────
function sharpen(d, w, h, amt) {
    const src = new Uint8ClampedArray(d);
    const str = amt * 1.5;
    const k   = [0, -str, 0, -str, 1 + 4 * str, -str, 0, -str, 0];

    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) {
                let v = 0;
                for (let ky = -1; ky <= 1; ky++)
                    for (let kx = -1; kx <= 1; kx++)
                        v += src[((y + ky) * w + (x + kx)) * 4 + c] * k[(ky + 1) * 3 + (kx + 1)];
                d[i + c] = clp(v);
            }
        }
    }
}

// ─── Clamp helper ─────────────────────────────────────────────────
function clp(v) { return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0; }
