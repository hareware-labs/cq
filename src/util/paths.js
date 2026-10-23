import { join } from 'node:path';

/** Resolve the standard `.cq/` layout for a target repo root. */
export function cqPaths(root) {
  const cq = join(root, '.cq');
  return {
    root,
    cq,
    tasks: join(cq, 'tasks.json'),
    inbox: join(cq, 'inbox.md'),
    status: join(cq, 'status.json'),
    lock: join(cq, 'lock'),
    logs: join(cq, 'logs'),
    taskLog: (id) => join(cq, 'logs', `${id}.jsonl`),
    taskErr: (id) => join(cq, 'logs', `${id}.err`),
  };
}
