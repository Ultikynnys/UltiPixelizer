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
            (f64x2_extract_lane(dist, 0), f64x2_extract_lane(dist, 1))
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
