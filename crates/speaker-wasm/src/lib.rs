//! Zero-dependency `wasm32-unknown-unknown` C-ABI JSON bridge for live in-browser
//! Parametric Speaker Design, 3D Solid CAD generation, and Coupled MNA/TMM/BEM simulation.

use acoustics_types::SystemDesignSpec;
use serde::Deserialize;
use speaker_engine::{
    builtin_designs, extract_parametric_baseline, simulate_parametric_edit, ParametricPatch,
};
use std::cell::RefCell;

thread_local! {
    static RESULT_BUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn store_result(s: String) -> i32 {
    RESULT_BUF.with(|buf| {
        *buf.borrow_mut() = s.into_bytes();
    });
    1
}

fn store_err(msg: String) -> i32 {
    RESULT_BUF.with(|buf| {
        *buf.borrow_mut() = msg.into_bytes();
    });
    0
}

fn resolve_design(design_id: &str, custom_toml: Option<&str>) -> Result<SystemDesignSpec, String> {
    if let Some(t_str) = custom_toml {
        if !t_str.trim().is_empty() {
            return toml::from_str::<SystemDesignSpec>(t_str)
                .map_err(|e| format!("Invalid custom TOML: {e}"));
        }
    }
    builtin_designs()
        .into_iter()
        .find(|d| d.id == design_id)
        .ok_or_else(|| format!("Unknown design_id `{design_id}`"))
}

/// Allocate `len` bytes in WASM linear memory for incoming UTF-8 JSON requests.
#[no_mangle]
pub extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Free an incoming request buffer previously allocated with `wasm_alloc`.
///
/// # Safety
/// `ptr` and `cap` must match a prior `wasm_alloc(cap)` call.
#[no_mangle]
pub unsafe extern "C" fn wasm_dealloc(ptr: *mut u8, cap: usize) {
    if !ptr.is_null() && cap > 0 {
        drop(Vec::from_raw_parts(ptr, 0, cap));
    }
}

/// Pointer to the latest UTF-8 JSON response or error message.
#[no_mangle]
pub extern "C" fn wasm_result_ptr() -> *const u8 {
    RESULT_BUF.with(|buf| buf.borrow().as_ptr())
}

/// Byte length of the latest UTF-8 JSON response or error message.
#[no_mangle]
pub extern "C" fn wasm_result_len() -> usize {
    RESULT_BUF.with(|buf| buf.borrow().len())
}

#[derive(Deserialize)]
struct BaselineRequest {
    design_id: String,
    #[serde(default)]
    cabinet_idx: usize,
    #[serde(default)]
    variant_idx: usize,
    #[serde(default)]
    custom_toml: Option<String>,
}

/// Extract baseline parametric slider values for `{ design_id, cabinet_idx, variant_idx }`.
///
/// # Safety
/// `ptr` must point to `len` valid UTF-8 bytes in WASM linear memory.
#[no_mangle]
pub unsafe extern "C" fn wasm_extract_baseline(ptr: *const u8, len: usize) -> i32 {
    let slice = std::slice::from_raw_parts(ptr, len);
    let Ok(req_str) = std::str::from_utf8(slice) else {
        return store_err("Invalid UTF-8 request".into());
    };
    let req: BaselineRequest = match serde_json::from_str(req_str) {
        Ok(r) => r,
        Err(e) => return store_err(format!("JSON parse error: {e}")),
    };
    let spec = match resolve_design(&req.design_id, req.custom_toml.as_deref()) {
        Ok(s) => s,
        Err(e) => return store_err(e),
    };
    let info = extract_parametric_baseline(&spec, req.cabinet_idx, req.variant_idx);
    match serde_json::to_string(&info) {
        Ok(json) => store_result(json),
        Err(e) => store_err(format!("JSON serialize error: {e}")),
    }
}

#[derive(Deserialize)]
struct SimulateRequest {
    design_id: String,
    patch: ParametricPatch,
    #[serde(default)]
    custom_toml: Option<String>,
}

/// Execute a live parametric 3D CAD + Acoustic simulation run in WASM!
///
/// # Safety
/// `ptr` must point to `len` valid UTF-8 bytes in WASM linear memory.
#[no_mangle]
pub unsafe extern "C" fn wasm_simulate_parametric(ptr: *const u8, len: usize) -> i32 {
    let slice = std::slice::from_raw_parts(ptr, len);
    let Ok(req_str) = std::str::from_utf8(slice) else {
        return store_err("Invalid UTF-8 request".into());
    };
    let req: SimulateRequest = match serde_json::from_str(req_str) {
        Ok(r) => r,
        Err(e) => return store_err(format!("JSON parse error: {e}")),
    };
    let spec = match resolve_design(&req.design_id, req.custom_toml.as_deref()) {
        Ok(s) => s,
        Err(e) => return store_err(e),
    };
    match simulate_parametric_edit(&spec, &req.patch) {
        Ok(out) => match serde_json::to_string(&out) {
            Ok(json) => store_result(json),
            Err(e) => store_err(format!("JSON serialize error: {e}")),
        },
        Err(e) => store_err(format!("Simulation error: {e}")),
    }
}
