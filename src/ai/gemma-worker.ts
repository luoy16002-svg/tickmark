// Gemma 4 E2B, running on this computer's graphics card through WebGPU, in its own worker so the page stays
// responsive. It reads table rows off a page image and suggests categories; it never sees the network except
// to download its own weights the first time (they are kept in the browser's cache afterwards).
import { AutoProcessor, env, Gemma4ForConditionalGeneration, RawImage } from '@huggingface/transformers';
// the ONNX runtime ships with this site (one hashed copy), so no CDN is ever contacted
import ortMjs from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';

const MODEL = 'onnx-community/gemma-4-E2B-it-ONNX';
env.allowLocalModels = false;
(env.backends.onnx as { wasm: { wasmPaths: unknown } }).wasm.wasmPaths = {
  mjs: new URL(ortMjs, self.location.href).href,
  wasm: new URL(ortWasm, self.location.href).href,
};

type Msg =
  | { type: 'load' }
  | { type: 'read'; id: number; width: number; height: number; pixels: Uint8ClampedArray; prompt: string; maxTokens: number; imageTokens?: number }
  | { type: 'ask'; id: number; prompt: string; maxTokens: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let processor: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let model: any = null;

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

// every request this worker makes is reported to the page's network counter
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) post({ type: 'net', url: e.name });
}).observe({ type: 'resource', buffered: true });

async function load() {
  if (model) return post({ type: 'ready', seconds: 0 });
  const t0 = performance.now();
  processor = await AutoProcessor.from_pretrained(MODEL);
  model = await Gemma4ForConditionalGeneration.from_pretrained(MODEL, {
    dtype: 'q4f16',
    device: 'webgpu',
    progress_callback: (info: { status: string; progress?: number; loaded?: number; total?: number }) => {
      if (info.status === 'progress_total') post({ type: 'progress', progress: info.progress ?? 0, loaded: info.loaded ?? 0, total: info.total ?? 0 });
    },
  });
  post({ type: 'ready', seconds: (performance.now() - t0) / 1000 });
}

async function generate(id: number, prompt: string, image: RawImage | null, maxTokens: number) {
  const content = image ? [{ type: 'image' }, { type: 'text', text: prompt }] : [{ type: 'text', text: prompt }];
  const chat = processor.apply_chat_template([{ role: 'user', content }], { enable_thinking: false, add_generation_prompt: true });
  const inputs = await processor(chat, image, null, { add_special_tokens: false });
  const t0 = performance.now();
  let streamed = '';
  const { TextStreamer } = await import('@huggingface/transformers');
  const streamer = new TextStreamer(processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => {
      streamed += text;
      post({ type: 'partial', id, text: streamed });
    },
  });
  const out = await model.generate({ ...inputs, max_new_tokens: maxTokens, do_sample: false, streamer });
  const n = inputs.input_ids.dims.at(-1);
  const text = processor.batch_decode(out.slice(null, [n, null]), { skip_special_tokens: true })[0] as string;
  post({ type: 'done', id, text, seconds: (performance.now() - t0) / 1000 });
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === 'load') await load();
    else if (m.type === 'read') {
      // more image tokens = more detail; statement print is small, so reading asks for the most the model takes
      processor.image_processor.max_soft_tokens = m.imageTokens ?? 280;
      await generate(m.id, m.prompt, new RawImage(m.pixels, m.width, m.height, 4), m.maxTokens);
    }
    else if (m.type === 'ask') await generate(m.id, m.prompt, null, m.maxTokens);
  } catch (err) {
    post({ type: 'error', id: 'id' in m ? m.id : -1, message: err instanceof Error ? err.message : String(err) });
  }
};
