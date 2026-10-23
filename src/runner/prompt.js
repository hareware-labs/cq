import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = fileURLToPath(new URL('../../templates/', import.meta.url));

/** Cap per context file. A worker that needs more than this needs a smaller task. */
export const CONTEXT_FILE_MAX_BYTES = 64 * 1024;
export const CONTEXT_TOTAL_MAX_BYTES = 256 * 1024;

export function loadWorkerTemplate(dir = TEMPLATE_DIR) {
  return readFileSync(join(dir, 'worker.md'), 'utf8');
}

/**
 * Read a task's context files, refusing to escape the repo root.
 *
 * Truncation is reported in-band rather than silently: a worker that is handed the
 * first 64 KB of a file and does not know it will make confident claims about code it
 * never saw.
 */
export function readContextFiles(root, files, {
  maxBytes = CONTEXT_FILE_MAX_BYTES, totalMaxBytes = CONTEXT_TOTAL_MAX_BYTES,
} = {}) {
  const out = [];
  let total = 0;
  for (const rel of files ?? []) {
    const raw = isAbsolute(rel) ? rel : resolve(root, rel);
    const escapes = (p, base) => p !== base && relative(base, p).startsWith('..');

    // Lexical check first: it fails closed for a path that does not exist, and does not
    // reveal whether an out-of-root file is there.
    if (escapes(raw, resolve(root))) {
      out.push({ path: rel, error: 'outside the repo root; refusing to read' });
      continue;
    }
    if (!existsSync(raw)) { out.push({ path: rel, error: 'not found' }); continue; }

    // Then resolve symlinks and check again. The lexical check alone let a link that
    // lives inside the repo but points at ~/.ssh through, which is not what "refusing
    // to escape the repo root" promises.
    let abs;
    try { abs = realpathSync(raw); }
    catch { out.push({ path: rel, error: 'could not resolve path' }); continue; }
    let realRoot;
    try { realRoot = realpathSync(root); } catch { realRoot = resolve(root); }
    if (escapes(abs, realRoot)) {
      out.push({ path: rel, error: 'outside the repo root; refusing to read (symlink)' });
      continue;
    }
    const st = statSync(abs);
    if (st.isDirectory()) { out.push({ path: rel, error: 'is a directory' }); continue; }
    if (total >= totalMaxBytes) {
      out.push({ path: rel, error: 'skipped: context budget exhausted' });
      continue;
    }
    let text = readFileSync(abs, 'utf8');
    let truncated = false;
    const budget = Math.min(maxBytes, totalMaxBytes - total);
    if (Buffer.byteLength(text) > budget) {
      text = Buffer.from(text).subarray(0, budget).toString('utf8');
      truncated = true;
    }
    total += Buffer.byteLength(text);
    out.push({ path: rel, text, truncated });
  }
  return out;
}

function fence(path, text) {
  // Pick a fence longer than any run of backticks inside, so file content cannot
  // break out of its own block.
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `### ${path}\n${f}\n${text}\n${f}`;
}

/**
 * Assemble the prompt for one task: task prompt, then context files, then the protocol.
 *
 * The protocol block is omitted when the target repo already carries it in CLAUDE.md
 * (`cq init` writes it there), because re-sending ~270 words per task is exactly the
 * compounding-context waste this tool exists to avoid.
 */
export function buildPrompt(task, {
  root = process.cwd(), template = null, includeProtocol = true, contextFiles = null,
  handoff = null, inboxAnswers = [],
} = {}) {
  const parts = [];

  for (const a of inboxAnswers) {
    parts.push(`## Decision from the human (answer to your earlier question)\n\n**Q:** ${a.question}\n\n**A:** ${a.answer}\n`);
  }
  if (handoff) parts.push(`## Hand-off from your previous attempt\n\n${handoff}\n`);

  parts.push(`## Task ${task.id}${task.title ? `: ${task.title}` : ''}\n\n${task.prompt.trim()}`);

  const ctx = contextFiles ?? readContextFiles(root, task.context_files);
  if (ctx.length) {
    const body = ctx.map((c) => (c.error
      ? `### ${c.path}\n_(${c.error})_`
      : fence(c.path, c.text) + (c.truncated ? '\n_(truncated by cq — read the file directly if you need the rest)_' : '')
    )).join('\n\n');
    parts.push(`## Context files\n\n${body}`);
  }

  if (includeProtocol) {
    const tpl = template ?? loadWorkerTemplate();
    parts.push(tpl.replaceAll('{{TASK_ID}}', task.id).replaceAll('{{TASK_TITLE}}', task.title || task.id));
  } else {
    parts.push(`---\nFollow the **cq worker protocol** in this repo's CLAUDE.md. You are executing exactly task ${task.id} and nothing else. End with the structured summary it specifies.`);
  }

  return parts.join('\n\n');
}
