import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeAtomic } from '../util/atomic.js';
import { cqPaths } from '../util/paths.js';

export const HEADER = `# cq inbox

Decisions that workers could not make for themselves. Answer one by writing your answer
on the \`> \` line under it, or run \`cq inbox answer <n> "<answer>"\`. Answering a
question unblocks its task and prepends the answer to that task's next prompt.

## Needs human
`;

/**
 * The inbox is markdown, not JSON, on purpose: a worker appends to it with a plain file
 * write and a human answers it in an editor. Both of those are easier in markdown than
 * in a structure either party has to keep valid.
 *
 * Entry format:
 *   - [ ] t-003: Which auth provider should the adapter target?
 *     > answer goes here
 */
const ENTRY_RE = /^-\s*\[( |x|X)\]\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

export function parseInbox(text) {
  const lines = (text ?? '').split('\n');
  const entries = [];
  let current = null;
  lines.forEach((line, i) => {
    const m = ENTRY_RE.exec(line.trim());
    if (m) {
      current = {
        index: entries.length + 1,
        line: i,
        answered: m[1].toLowerCase() === 'x',
        task_id: m[2],
        question: m[3].trim(),
        answer: null,
        answer_lines: [],
      };
      entries.push(current);
      return;
    }
    if (current && /^\s*>\s?/.test(line)) {
      current.answer_lines.push(line.replace(/^\s*>\s?/, ''));
      current.answer = current.answer_lines.join('\n').trim() || null;
      return;
    }
    if (line.trim() && !line.startsWith('  ')) current = null;
  });
  // An entry with prose under `> ` counts as answered even if the box is unticked --
  // a human who typed an answer should not also have to remember the checkbox.
  for (const e of entries) if (e.answer) e.answered = true;
  return entries;
}

export class Inbox {
  constructor(root) { this.paths = cqPaths(root); }

  init() {
    if (!existsSync(this.paths.inbox)) {
      mkdirSync(dirname(this.paths.inbox), { recursive: true });
      writeAtomic(this.paths.inbox, HEADER);
    }
  }

  read() {
    if (!existsSync(this.paths.inbox)) return '';
    return readFileSync(this.paths.inbox, 'utf8');
  }

  list() { return parseInbox(this.read()); }

  /** Questions still awaiting an answer, optionally for one task. */
  open(taskId = null) {
    return this.list().filter((e) => !e.answered && (!taskId || e.task_id === taskId));
  }

  /** Answered questions for a task; these get prepended to its next prompt. */
  answersFor(taskId) {
    return this.list().filter((e) => e.answered && e.answer && e.task_id === taskId);
  }

  /** Append a question. Idempotent per (task, question) so a retry cannot duplicate it. */
  add(taskId, question) {
    this.init();
    const q = question.replace(/\s+/g, ' ').trim();
    if (this.list().some((e) => e.task_id === taskId && e.question === q)) return false;
    appendFileSync(this.paths.inbox, `- [ ] ${taskId}: ${q}\n  > \n`);
    return true;
  }

  /** Answer entry `index` (1-based, as `cq inbox` prints it). */
  answer(index, answer) {
    const text = this.read();
    const entries = parseInbox(text);
    const entry = entries.find((e) => e.index === index);
    if (!entry) throw new Error(`no inbox entry #${index}`);

    const lines = text.split('\n');
    lines[entry.line] = lines[entry.line].replace(/^(\s*-\s*)\[[ xX]\]/, '$1[x]');
    // Replace the whole existing answer block so re-answering does not stack.
    const answerBlock = answer.split('\n').map((l) => `  > ${l}`);
    const start = entry.line + 1;
    const count = entry.answer_lines.length;
    lines.splice(start, count, ...answerBlock);
    writeAtomic(this.paths.inbox, lines.join('\n'));
    return { ...entry, answer, answered: true };
  }
}

/**
 * Pull escalations out of a worker's final message.
 *
 * The worker is told to write to `.cq/inbox.md` directly, but a worker that ran out of
 * turns, crashed, or simply mentioned the decision in its summary instead would
 * otherwise lose it. Scanning the summary too costs nothing and `Inbox.add` dedupes,
 * so both paths converge on one entry.
 */
export function extractNeedsHuman(finalText) {
  const found = [];
  for (const m of (finalText ?? '').matchAll(/NEEDS[_ ]HUMAN\s*:\s*(.+)/gi)) {
    found.push(m[1].trim().replace(/\s+/g, ' '));
  }
  const section = /##+\s*(?:Needs human|Blocked)\s*\n([\s\S]*?)(?=\n##+\s|\n*$)/i.exec(finalText ?? '');
  if (section) {
    for (const line of section[1].split('\n')) {
      const t = line.replace(/^[-*]\s*(\[[ xX]\]\s*)?/, '').trim();
      if (t && !/^NEEDS[_ ]HUMAN/i.test(t) && t.length > 8) found.push(t.replace(/\s+/g, ' '));
    }
  }
  return [...new Set(found)];
}
