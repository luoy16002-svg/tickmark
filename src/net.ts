// Counts every request this page makes to another site after a statement is opened, so the claim
// "nothing is uploaded" is something the reader can watch, not something they have to take on trust.
import { onWorkerRequest } from './ai/gemma.ts';

export interface NetCount {
  external: number;
  hosts: string[];
  /** Requests to the model's host (only after the reader asks for Gemma). */
  model: number;
}

const MODEL_HOSTS = /(^|\.)(huggingface\.co|hf\.co|xethub\.hf\.co)$/;

export function watchNetwork(onChange: (n: NetCount) => void) {
  let since = performance.now();
  let count: NetCount = { external: 0, hosts: [], model: 0 };
  const seen = (e: PerformanceEntry) => {
    if (e.startTime < since) return;
    let host = '';
    try {
      const u = new URL(e.name);
      if (u.origin === location.origin || u.protocol === 'blob:' || u.protocol === 'data:') return;
      host = u.hostname;
    } catch {
      return;
    }
    const model = MODEL_HOSTS.test(host);
    count = {
      external: count.external + (model ? 0 : 1),
      model: count.model + (model ? 1 : 0),
      hosts: count.hosts.includes(host) ? count.hosts : [...count.hosts, host],
    };
    onChange(count);
  };
  const po = new PerformanceObserver((list) => list.getEntries().forEach(seen));
  onWorkerRequest((url) => seen({ name: url, startTime: performance.now() } as PerformanceEntry));
  po.observe({ type: 'resource', buffered: false });
  return {
    reset() {
      since = performance.now();
      count = { external: 0, hosts: [], model: 0 };
      onChange(count);
    },
    stop: () => po.disconnect(),
  };
}
