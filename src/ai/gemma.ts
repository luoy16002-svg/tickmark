// The page's side of the Gemma worker: one model per tab, loaded only when the reader asks for it.

export interface Progress {
  progress: number;
  loaded: number;
  total: number;
}

type Pending = { resolve: (t: string) => void; reject: (e: Error) => void; onPartial?: (t: string) => void };

let worker: Worker | null = null;
let workerRequest: (url: string) => void = () => undefined;

/** The network counter listens here for requests made inside the model worker. */
export function onWorkerRequest(fn: (url: string) => void) {
  workerRequest = fn;
}
let ready: Promise<void> | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;

export function gemma(onProgress?: (p: Progress) => void): Promise<void> {
  if (ready) return ready;
  worker = new Worker(new URL('./gemma-worker.ts', import.meta.url), { type: 'module' });
  ready = new Promise((resolve, reject) => {
    worker!.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'net') workerRequest(m.url);
      else if (m.type === 'progress') onProgress?.(m);
      else if (m.type === 'ready') resolve();
      else if (m.type === 'partial') pending.get(m.id)?.onPartial?.(m.text);
      else if (m.type === 'done') {
        pending.get(m.id)?.resolve(m.text);
        pending.delete(m.id);
      } else if (m.type === 'error') {
        const p = pending.get(m.id);
        if (p) {
          p.reject(new Error(m.message));
          pending.delete(m.id);
        } else reject(new Error(m.message));
      }
    };
    worker!.onerror = (e) => reject(new Error(e.message || 'The model worker stopped.'));
    worker!.postMessage({ type: 'load' });
  });
  ready.catch(() => {
    ready = null;
    worker?.terminate();
    worker = null;
  });
  return ready;
}

export function hasWebGPU(): boolean {
  return 'gpu' in navigator;
}

export async function readImage(img: ImageData, prompt: string, maxTokens: number, onPartial?: (t: string) => void, imageTokens = 280): Promise<string> {
  await ready;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onPartial });
    worker!.postMessage({ type: 'read', id, width: img.width, height: img.height, pixels: img.data, prompt, maxTokens, imageTokens }, [img.data.buffer]);
  });
}

export async function ask(prompt: string, maxTokens: number, onPartial?: (t: string) => void): Promise<string> {
  await ready;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onPartial });
    worker!.postMessage({ type: 'ask', id, prompt, maxTokens });
  });
}
