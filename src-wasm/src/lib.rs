//! Byte-identical f64 palette scan for the seamless error-diffusion dither.
//!
//! The JS `linearMatch` (src/lib/dither.ts) computes, for each palette entry i,
//!
//! ```text
//! d_i = ((r - cr_i)*(r - cr_i)*wr + (g - cg_i)*(g - cg_i)*wg) + (b - cb_i)*(b - cb_i)*wb
//! ```
//!
//! in IEEE-754 double precision. Every operand is an f32 value promoted to f64
//! (the palette and weights live in Float32Arrays on the JS side; `r/g/b` come
//! from a Float32Array work buffer). The argmin uses strict less-than with
//! first-wins, so ties resolve to the lowest palette index (`if (distance <
//! bestDistance)`).
//!
//! This module reproduces that arithmetic EXACTLY. The caller promotes the f32
//! palette and weights to f64 (f32 -> f64 is exact) and passes structure-of-
//! arrays f64 channels; `linear_match` evaluates the same expression in the
//! same order with the same rounding, so the returned index is byte-identical.
//!
//! SIMD pitfall (learned the hard way): a mask from `f64x2_lt` (or any f64x2
//! compare) packs the even comparison in bits 0-63 and the odd comparison in
//! bits 64-127. As i32 lanes that is lanes 0,1 = even and lanes 2,3 = odd, so
//! `v128_bitselect` against an i32x4 index vector updates the odd index
//! whenever the even entry wins. Use an i64x2 index vector (lane layout
//! matches the mask) or re-shuffle the mask before the bitselect.

use core::arch::wasm32::*;

/// Allocates `size` bytes with 16-byte alignment. The JS caller writes the SoA
/// f64 palette + weights here and frees with `dither_dealloc`. Exported so the
/// JS side can hand the module memory it manages.
#[no_mangle]
pub extern "C" fn dither_alloc(size: usize) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(size, 16).expect("dither_alloc size overflow");
    unsafe { std::alloc::alloc(layout) }
}

/// Frees memory from `dither_alloc`.
#[no_mangle]
pub extern "C" fn dither_dealloc(ptr: *mut u8, size: usize) {
    if ptr.is_null() {
        return;
    }
    let layout = std::alloc::Layout::from_size_align(size, 16).expect("dither_dealloc size overflow");
    unsafe { std::alloc::dealloc(ptr, layout) };
}

/// Scalar f64 distance, matching `lumaDistanceSquared` in src/lib/dither.ts
/// exactly (same left-to-right operation order and rounding).
#[inline]
fn distance(r: f64, g: f64, b: f64, cr: f64, cg: f64, cb: f64, wr: f64, wg: f64, wb: f64) -> f64 {
    let dr = r - cr;
    let dg = g - cg;
    let db = b - cb;
    (dr * dr * wr + dg * dg * wg) + db * db * wb
}

/// Scalar reference scan — byte-identical to JS `linearMatch`. Exported
/// alongside the SIMD path so a mismatched result isolates the SIMD loop from
/// a marshaling/contract bug.
#[no_mangle]
pub extern "C" fn linear_match_scalar(
    r_ptr: *const f64,
    g_ptr: *const f64,
    b_ptr: *const f64,
    w_ptr: *const f64,
    count: u32,
    r: f64,
    g: f64,
    b: f64,
) -> u32 {
    let wr = unsafe { *w_ptr };
    let wg = unsafe { *w_ptr.add(1) };
    let wb = unsafe { *w_ptr.add(2) };
    let mut best = 0u32;
    let mut best_dist = f64::INFINITY;
    for i in 0..count {
        let cr = unsafe { *r_ptr.add(i as usize) };
        let cg = unsafe { *g_ptr.add(i as usize) };
        let cb = unsafe { *b_ptr.add(i as usize) };
        let d = distance(r, g, b, cr, cg, cb, wr, wg, wb);
        if d < best_dist {
            best_dist = d;
            best = i;
        }
    }
    best
}

/// SIMD f64x2 scan — two palette entries per lane. The pair reduction uses
/// first-wins so it matches the left-to-right strict-less-than order of the
/// scalar/JS scan.
///
/// Alignment contract: each channel pointer must be 16-byte aligned (the JS
/// loader pads the SoA stride to an even element count, and `dither_alloc`
/// returns a 16-byte-aligned base, so every channel and every pair-load is
/// aligned).
#[no_mangle]
// The v128 SIMD intrinsics are gated behind the per-function simd128 target
// feature — the default wasm32-unknown-unknown toolchain has it disabled, so
// calling f64x2_*/v128_* here fails to compile without this attribute.
#[target_feature(enable = "simd128")]
pub extern "C" fn linear_match(
    r_ptr: *const f64,
    g_ptr: *const f64,
    b_ptr: *const f64,
    w_ptr: *const f64,
    count: u32,
    r: f64,
    g: f64,
    b: f64,
) -> u32 {
    let wr = unsafe { *w_ptr };
    let wg = unsafe { *w_ptr.add(1) };
    let wb = unsafe { *w_ptr.add(2) };

    let mut best = 0u32;
    let mut best_dist = f64::INFINITY;

    let mut i = 0u32;
    while i + 1 < count {
        let (d0, d1) = unsafe {
            let rq = f64x2_splat(r);
            let gq = f64x2_splat(g);
            let bq = f64x2_splat(b);
            let cr = v128_load(r_ptr.add(i as usize) as *const v128);
            let cg = v128_load(g_ptr.add(i as usize) as *const v128);
            let cb = v128_load(b_ptr.add(i as usize) as *const v128);
            let dr = f64x2_sub(rq, cr);
            let dg = f64x2_sub(gq, cg);
            let db = f64x2_sub(bq, cb);
            let dist = f64x2_add(
                f64x2_add(
                    f64x2_mul(f64x2_mul(dr, dr), f64x2_splat(wr)),
                    f64x2_mul(f64x2_mul(dg, dg), f64x2_splat(wg)),
                ),
                f64x2_mul(f64x2_mul(db, db), f64x2_splat(wb)),
            );
            (f64x2_extract_lane::<0>(dist), f64x2_extract_lane::<1>(dist))
        };

        // Pair winner with first-wins (equivalent to processing i then i+1).
        let (win_idx, win_dist) = if d0 < d1 {
            (i, d0)
        } else if d1 < d0 {
            (i + 1, d1)
        } else {
            (i, d0)
        };
        if win_dist < best_dist {
            best_dist = win_dist;
            best = win_idx;
        }
        i += 2;
    }

    // Scalar tail for an odd count.
    if i < count {
        let cr = unsafe { *r_ptr.add(i as usize) };
        let cg = unsafe { *g_ptr.add(i as usize) };
        let cb = unsafe { *b_ptr.add(i as usize) };
        let d = distance(r, g, b, cr, cg, cb, wr, wg, wb);
        if d < best_dist {
            best = i;
        }
    }

    best
}


// ── Full seamless error-diffusion loop ────────────────────────────────────────
//
// Runs the ENTIRE streaming seamless pass (src/lib/dither.ts
// `streamDitherSeamless`) inside the module: tone adjustment + row init, the
// per-pixel linear match, the center-tile output write, and the error spreads,
// with the same f64 arithmetic, the same left-to-right operation order, and
// the same f32 work-buffer stores as the JS. This is what makes the JS and
// wasm loops byte-identical:
//
//   * wasm32 has no FMA instructions, so no mul+add can fuse and change
//     rounding; every f64 op rounds identically to the JS engine.
//   * f64 -> f32 stores (Rust `as f32`, JS typed-array stores) both round to
//     nearest, ties to even.
//   * the work-buffer accumulation is load-f64, add-f64, store-f32, exactly
//     like `work[t] += x` on a Float32Array.
//   * matched colors come from the same SoA f64 palette the JS promotes its
//     f32 flat array into, so `mr/mg/mb` are bit-identical; they are always
//     exact integers (hexToRgb), so the u8 output store is exact either way.
//
// The JS side allocates src/out/work buffers in module memory, copies the
// source in, calls this, and copies the output back. Caller must pass a work
// scratch of rows_needed * grid_width * 3 f32s.

/// Rec. 601 luma weights, matching `LUMA` in src/lib/math.ts.
const LUMA_R: f64 = 0.299;
const LUMA_G: f64 = 0.587;
const LUMA_B: f64 = 0.114;

/// ES262 ToUint8Clamp: NaN -> 0, <=0 -> 0, >=255 -> 255, else round half to
/// even. Matches Uint8ClampedArray stores. (Matched colors are exact
/// integers, so this is defensive.)
#[inline]
fn to_uint8_clamp(x: f64) -> u8 {
    if x <= 0.0 {
        return 0;
    }
    if x >= 255.0 {
        return 255;
    }
    let f = x.floor();
    let diff = x - f;
    if diff < 0.5 {
        f as u8
    } else if diff > 0.5 {
        (f + 1.0) as u8
    } else {
        let n = f as i64;
        if n % 2 == 0 {
            f as u8
        } else {
            (f + 1.0) as u8
        }
    }
}

/// Tone adjustment, matching `toneAdjustPixel` in src/lib/dither.ts exactly:
/// contrast factor on (c - 128) + 128 + offset, then the LUMA-weighted
/// saturation blend, clamped to 0..255. `bo` = brightnessOffset, `cf` =
/// contrastFactor, `sf` = saturationFactor.
#[inline]
fn tone_adjust(r: u8, g: u8, b: u8, bo: f64, cf: f64, sf: f64) -> (f64, f64, f64) {
    let r = r as f64;
    let g = g as f64;
    let b = b as f64;
    let red = cf * (r - 128.0) + 128.0 + bo;
    let green = cf * (g - 128.0) + 128.0 + bo;
    let blue = cf * (b - 128.0) + 128.0 + bo;
    let gray = red * LUMA_R + green * LUMA_G + blue * LUMA_B;
    let tr = if gray + (red - gray) * sf < 0.0 { 0.0 } else if gray + (red - gray) * sf > 255.0 { 255.0 } else { gray + (red - gray) * sf };
    let tg = if gray + (green - gray) * sf < 0.0 { 0.0 } else if gray + (green - gray) * sf > 255.0 { 255.0 } else { gray + (green - gray) * sf };
    let tb = if gray + (blue - gray) * sf < 0.0 { 0.0 } else if gray + (blue - gray) * sf > 255.0 { 255.0 } else { gray + (blue - gray) * sf };
    (tr, tg, tb)
}

/// Writes the tone-adjusted colors of virtual grid row `py` into work slot
/// `slot`, matching `initRow` in the JS (the source row wraps at `py % h`).
#[inline]
fn init_row(
    work: &mut [f32],
    src: &[u8],
    w: usize,
    h: usize,
    gw: usize,
    slot: usize,
    py: usize,
    bo: f64,
    cf: f64,
    sf: f64,
) {
    let sy = py % h;
    let src_row = sy * w * 4;
    let base = slot * gw * 3;
    for px in 0..gw {
        let s = src_row + (px % w) * 4;
        let (tr, tg, tb) = tone_adjust(src[s], src[s + 1], src[s + 2], bo, cf, sf);
        let t = base + px * 3;
        work[t] = tr as f32;
        work[t + 1] = tg as f32;
        work[t + 2] = tb as f32;
    }
}

/// Adds `er * factor * strength` into work slot base `target` at column `x`,
/// matching `spreadRow` in the JS (columns outside the grid are dropped, and
/// the accumulate is load-f64, add-f64, store-f32).
#[inline]
fn spread_row(
    work: &mut [f32],
    gw: usize,
    target: usize,
    x: i64,
    er: f64,
    eg: f64,
    eb: f64,
    factor: f64,
    strength: f64,
) {
    if x < 0 || x as usize >= gw {
        return;
    }
    let t = target + (x as usize) * 3;
    let cur = work[t] as f64;
    work[t] = (cur + (er * factor) * strength) as f32;
    let cur = work[t + 1] as f64;
    work[t + 1] = (cur + (eg * factor) * strength) as f32;
    let cur = work[t + 2] as f64;
    work[t + 2] = (cur + (eb * factor) * strength) as f32;
}

/// The full streaming seamless error-diffusion pass. Arguments: source RGBA
/// (w*h*4), output RGBA (w*h*4), the SoA f64 palette (createWasmMatcher
/// layout: r/g/b channels of `stride` f64s each, then 3 weights), count,
/// width, height, atkinson flag, strength, the three tone params, and the
/// work scratch (rows_needed*gw*3 f32s). Output bytes are written into
/// `out_ptr`; the JS copies them back into the ImageData.
#[no_mangle]
pub extern "C" fn dither_seamless(
    src_ptr: *const u8,
    out_ptr: *mut u8,
    r_ptr: *const f64,
    g_ptr: *const f64,
    b_ptr: *const f64,
    w_ptr: *const f64,
    count: u32,
    width: u32,
    height: u32,
    atkinson: u32,
    strength: f64,
    brightness_offset: f64,
    contrast_factor: f64,
    saturation_factor: f64,
    work_ptr: *mut f32,
) {
    let rows_needed: usize = if atkinson == 1 { 3 } else { 2 };
    let w = width as usize;
    let h = height as usize;
    let gw = w * 3;
    let gh = h * 2;
    let total = w * h;
    let src = unsafe { core::slice::from_raw_parts(src_ptr, total * 4) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, total * 4) };
    let work = unsafe { core::slice::from_raw_parts_mut(work_ptr, rows_needed * gw * 3) };
    let (bo, cf, sf) = (brightness_offset, contrast_factor, saturation_factor);

    init_row(work, src, w, h, gw, 0, 0, bo, cf, sf);
    if rows_needed > 2 {
        init_row(work, src, w, h, gw, 1, 1, bo, cf, sf);
    }

    for py in 0..gh {
        let row_slot = py % rows_needed;
        let next_row = py + rows_needed - 1;
        if next_row < gh {
            init_row(work, src, w, h, gw, next_row % rows_needed, next_row, bo, cf, sf);
        }
        let base = row_slot * gw * 3;
        let below = ((py + 1) % rows_needed) * gw * 3;
        let below2 = ((py + 2) % rows_needed) * gw * 3;
        let in_center = py >= h;
        for px in 0..gw {
            let wi = base + px * 3;
            let r = work[wi] as f64;
            let g = work[wi + 1] as f64;
            let b = work[wi + 2] as f64;
            let best = linear_match(r_ptr, g_ptr, b_ptr, w_ptr, count, r, g, b) as usize;
            let mr = unsafe { *r_ptr.add(best) };
            let mg = unsafe { *g_ptr.add(best) };
            let mb = unsafe { *b_ptr.add(best) };
            if in_center && px >= w && px < w * 2 {
                let o = ((py - h) * w + (px - w)) * 4;
                out[o] = to_uint8_clamp(mr);
                out[o + 1] = to_uint8_clamp(mg);
                out[o + 2] = to_uint8_clamp(mb);
                out[o + 3] = src[(py % h) * w * 4 + (px % w) * 4 + 3];
            }
            let er = r - mr;
            let eg = g - mg;
            let eb = b - mb;
            if atkinson == 1 {
                spread_row(work, gw, base, px as i64 + 1, er, eg, eb, 1.0 / 8.0, strength);
                spread_row(work, gw, base, px as i64 + 2, er, eg, eb, 1.0 / 8.0, strength);
                spread_row(work, gw, below, px as i64 - 1, er, eg, eb, 1.0 / 8.0, strength);
                spread_row(work, gw, below, px as i64, er, eg, eb, 1.0 / 8.0, strength);
                spread_row(work, gw, below, px as i64 + 1, er, eg, eb, 1.0 / 8.0, strength);
                spread_row(work, gw, below2, px as i64, er, eg, eb, 1.0 / 8.0, strength);
            } else {
                spread_row(work, gw, base, px as i64 + 1, er, eg, eb, 7.0 / 16.0, strength);
                spread_row(work, gw, below, px as i64 - 1, er, eg, eb, 3.0 / 16.0, strength);
                spread_row(work, gw, below, px as i64, er, eg, eb, 5.0 / 16.0, strength);
                spread_row(work, gw, below, px as i64 + 1, er, eg, eb, 1.0 / 16.0, strength);
            }
        }
    }
}
