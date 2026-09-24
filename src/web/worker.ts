/// <reference lib="webworker" />
import { analyze } from '../ai/advisor';
import { HeuristicBot } from '../ai/bots';
import { PlayerView } from '../core/view';
import type { WorkerRequest, WorkerResponse } from './aiClient';

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  let res: WorkerResponse;
  try {
    const view = PlayerView.from(req.me, req.history);
    if (req.kind === 'heuristic') {
      res = { id: req.id, action: new HeuristicBot().choose(view) };
    } else {
      const analysis = analyze(view, req.opts ?? {});
      res = { id: req.id, action: analysis.action, analysis };
    }
  } catch (err) {
    res = { id: req.id, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(res);
};
