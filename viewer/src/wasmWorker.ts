import type {
  ParametricBaselineInfo,
  ParametricPatch,
  ParametricSimulationOutput,
} from './types';

interface SpeakerWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  wasm_alloc(len: number): number;
  wasm_dealloc(ptr: number, cap: number): void;
  wasm_result_ptr(): number;
  wasm_result_len(): number;
  wasm_extract_baseline(ptr: number, len: number): number;
  wasm_simulate_parametric(ptr: number, len: number): number;
}

export type WasmWorkerRequest =
  | {
      id: number;
      kind: 'extract_baseline';
      wasmUrl: string;
      designId: string;
      cabinetIdx: number;
      variantIdx: number;
      customToml?: string;
    }
  | {
      id: number;
      kind: 'simulate_parametric';
      wasmUrl: string;
      designId: string;
      patch: ParametricPatch;
      customToml?: string;
    };

export type WasmWorkerResponse =
  | {
      id: number;
      ok: true;
      kind: 'extract_baseline';
      data: ParametricBaselineInfo;
      elapsedMs: number;
    }
  | {
      id: number;
      ok: true;
      kind: 'simulate_parametric';
      data: ParametricSimulationOutput;
      elapsedMs: number;
    }
  | {
      id: number;
      ok: false;
      error: string;
      elapsedMs: number;
    };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let wasmPromise: Promise<SpeakerWasmExports> | null = null;
let loadedWasmUrl = '';

async function getWasmExports(wasmUrl: string): Promise<SpeakerWasmExports> {
  if (wasmPromise && loadedWasmUrl === wasmUrl) {
    return wasmPromise;
  }
  loadedWasmUrl = wasmUrl;
  wasmPromise = (async () => {
    try {
      if (typeof WebAssembly.instantiateStreaming === 'function') {
        const resp = await fetch(wasmUrl);
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} fetching ${wasmUrl}`);
        }
        try {
          const { instance } = await WebAssembly.instantiateStreaming(resp, {});
          return instance.exports as SpeakerWasmExports;
        } catch {
          // Fallback if server Content-Type is not application/wasm
          const resp2 = await fetch(wasmUrl);
          const bytes = await resp2.arrayBuffer();
          const { instance } = await WebAssembly.instantiate(bytes, {});
          return instance.exports as SpeakerWasmExports;
        }
      } else {
        const resp = await fetch(wasmUrl);
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} fetching ${wasmUrl}`);
        }
        const bytes = await resp.arrayBuffer();
        const { instance } = await WebAssembly.instantiate(bytes, {});
        return instance.exports as SpeakerWasmExports;
      }
    } catch (err) {
      wasmPromise = null;
      throw err;
    }
  })();
  return wasmPromise;
}

function invokeWasmJson<T>(
  exports: SpeakerWasmExports,
  fn: (ptr: number, len: number) => number,
  payload: unknown
): T {
  const reqBytes = encoder.encode(JSON.stringify(payload));
  const len = Math.max(1, reqBytes.byteLength);
  const inPtr = exports.wasm_alloc(len);
  // Refresh view after allocation in case WASM linear memory grew
  new Uint8Array(exports.memory.buffer, inPtr, reqBytes.byteLength).set(reqBytes);

  let status = 0;
  try {
    status = fn(inPtr, reqBytes.byteLength);
  } finally {
    exports.wasm_dealloc(inPtr, len);
  }

  const outPtr = exports.wasm_result_ptr();
  const outLen = exports.wasm_result_len();
  // Refresh view after WASM execution in case linear memory grew during simulation
  const outStr = decoder.decode(new Uint8Array(exports.memory.buffer, outPtr, outLen));
  if (status !== 1) {
    throw new Error(outStr || 'Rust WASM acoustic solver returned an error');
  }
  return JSON.parse(outStr) as T;
}

self.onmessage = async (ev: MessageEvent<WasmWorkerRequest>) => {
  const msg = ev.data;
  const t0 = performance.now();
  try {
    const exports = await getWasmExports(msg.wasmUrl);
    if (msg.kind === 'extract_baseline') {
      const data = invokeWasmJson<ParametricBaselineInfo>(
        exports,
        exports.wasm_extract_baseline,
        {
          design_id: msg.designId,
          cabinet_idx: msg.cabinetIdx,
          variant_idx: msg.variantIdx,
          custom_toml: msg.customToml ?? null,
        }
      );
      const resp: WasmWorkerResponse = {
        id: msg.id,
        ok: true,
        kind: 'extract_baseline',
        data,
        elapsedMs: performance.now() - t0,
      };
      self.postMessage(resp);
    } else if (msg.kind === 'simulate_parametric') {
      const data = invokeWasmJson<ParametricSimulationOutput>(
        exports,
        exports.wasm_simulate_parametric,
        {
          design_id: msg.designId,
          patch: msg.patch,
          custom_toml: msg.customToml ?? null,
        }
      );
      const resp: WasmWorkerResponse = {
        id: msg.id,
        ok: true,
        kind: 'simulate_parametric',
        data,
        elapsedMs: performance.now() - t0,
      };
      self.postMessage(resp);
    }
  } catch (err) {
    const resp: WasmWorkerResponse = {
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: performance.now() - t0,
    };
    self.postMessage(resp);
  }
};
