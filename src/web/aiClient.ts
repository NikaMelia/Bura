import type { AdvisorOptions, Analysis } from '../ai/advisor';
import type { Obs } from '../core/view';

export interface WorkerRequest {
  id: number;
  kind: 'search' | 'heuristic';
  me: number;
  history: Obs[];
  opts?: AdvisorOptions;
}

export interface WorkerResponse {
  id: number;
  action?: number;
  analysis?: Analysis;
  error?: string;
}

/** Runs the AI in a web worker so the page stays responsive while it thinks. */
export class AiClient {
  private worker: Worker;
  private pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data);
    };
  }

  private request(req: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id });
    });
  }

  async analyze(me: number, history: Obs[], opts: AdvisorOptions): Promise<Analysis> {
    return (await this.request({ kind: 'search', me, history, opts })).analysis!;
  }

  async heuristicMove(me: number, history: Obs[]): Promise<number> {
    return (await this.request({ kind: 'heuristic', me, history })).action!;
  }
}
