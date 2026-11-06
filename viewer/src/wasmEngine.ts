import type {
  ParametricBaselineInfo,
  ParametricPatch,
  ParametricSimulationOutput,
} from './types';
import type { WasmWorkerRequest, WasmWorkerResponse } from './wasmWorker';

interface PendingCall {
  resolve: (resp: WasmWorkerResponse) => void;
  reject: (err: Error) => void;
}

class ParametricWasmClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private inflight = new Map<number, PendingCall>();
  private simBusy = false;
  private queuedSim: {
    designId: string;
    patch: ParametricPatch;
    customToml?: string;
    resolve: (res: { output: ParametricSimulationOutput; elapsedMs: number }) => void;
    reject: (err: Error) => void;
  } | null = null;

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./wasmWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (ev: MessageEvent<WasmWorkerResponse>) => {
        const resp = ev.data;
        const pending = this.inflight.get(resp.id);
        if (pending) {
          this.inflight.delete(resp.id);
          if (resp.ok) {
            pending.resolve(resp);
          } else {
            pending.reject(new Error(resp.error));
          }
        }
      };
      this.worker.onerror = (err) => {
        const error = new Error(err.message || 'WASM Web Worker error');
        for (const [, pending] of this.inflight) {
          pending.reject(error);
        }
        this.inflight.clear();
      };
    }
    return this.worker;
  }

  private getWasmUrl(): string {
    return new URL('./wasm/speaker_wasm.wasm', window.location.href).href;
  }

  private postRequest(req: WasmWorkerRequest): Promise<WasmWorkerResponse> {
    const worker = this.ensureWorker();
    return new Promise<WasmWorkerResponse>((resolve, reject) => {
      this.inflight.set(req.id, { resolve, reject });
      worker.postMessage(req);
    });
  }

  async extractBaseline(
    designId: string,
    cabinetIdx: number,
    variantIdx: number,
    customToml?: string
  ): Promise<{ info: ParametricBaselineInfo; elapsedMs: number }> {
    const id = this.nextId++;
    const resp = await this.postRequest({
      id,
      kind: 'extract_baseline',
      wasmUrl: this.getWasmUrl(),
      designId,
      cabinetIdx,
      variantIdx,
      customToml,
    });
    if (resp.ok && resp.kind === 'extract_baseline') {
      return { info: resp.data, elapsedMs: resp.elapsedMs };
    }
    throw new Error('Unexpected response from WASM baseline extractor');
  }

  /**
   * Executes a live Rust WASM 3D CAD + Coupled MNA/TMM/BEM simulation.
   * Coalesces intermediate slider ticks while a run is active so only the latest
   * parameter state executes next — keeping 3D & chart updates lag-free!
   */
  simulateParametric(
    designId: string,
    patch: ParametricPatch,
    customToml?: string
  ): Promise<{ output: ParametricSimulationOutput; elapsedMs: number }> {
    if (this.simBusy) {
      return new Promise((resolve, reject) => {
        // Supersede any older queued request cleanly without throwing an unhandled error
        if (this.queuedSim) {
          const superseded = this.queuedSim;
          this.queuedSim = { designId, patch, customToml, resolve, reject };
          // Resolve superseded promise only when the newer run completes: chain both!
          const prevResolve = superseded.resolve;
          const prevReject = superseded.reject;
          const cur = this.queuedSim;
          cur.resolve = (val) => {
            prevResolve(val);
            resolve(val);
          };
          cur.reject = (err) => {
            prevReject(err);
            reject(err);
          };
          return;
        }
        this.queuedSim = { designId, patch, customToml, resolve, reject };
      });
    }

    return this.runSimImmediate(designId, patch, customToml);
  }

  private async runSimImmediate(
    designId: string,
    patch: ParametricPatch,
    customToml?: string
  ): Promise<{ output: ParametricSimulationOutput; elapsedMs: number }> {
    this.simBusy = true;
    try {
      const id = this.nextId++;
      const resp = await this.postRequest({
        id,
        kind: 'simulate_parametric',
        wasmUrl: this.getWasmUrl(),
        designId,
        patch,
        customToml,
      });
      if (!resp.ok || resp.kind !== 'simulate_parametric') {
        throw new Error('Unexpected WASM simulation response');
      }
      return { output: resp.data, elapsedMs: resp.elapsedMs };
    } finally {
      this.simBusy = false;
      if (this.queuedSim) {
        const next = this.queuedSim;
        this.queuedSim = null;
        this.runSimImmediate(next.designId, next.patch, next.customToml).then(
          next.resolve,
          next.reject
        );
      }
    }
  }
}

export const wasmEngine = new ParametricWasmClient();
