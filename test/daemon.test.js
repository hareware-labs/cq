import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlist, labelFor, plistPath, systemdUnit, LOG_DIR } from '../src/daemon/index.js';

test('each repo gets its own agent label, so queues do not collide', () => {
  assert.equal(labelFor('/Users/x/code/my-app'), 'com.cq.queue.users-x-code-my-app');
  assert.notEqual(labelFor('/a/b'), labelFor('/a/c'));
  assert.match(labelFor('/tmp/Weird Name (1)!'), /^com\.cq\.queue\.[a-z0-9-]+$/,
    'the label is always a legal reverse-DNS-ish string');
});

test('the plist restarts a parked queue but is throttled against a spin', () => {
  const p = buildPlist('/tmp/repo', { cliPath: '/opt/cq/bin/cq.js' });
  assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/, 'survives a reboot');
  assert.match(p, /<key>SuccessfulExit<\/key><false\/>/,
    'a queue that exits cleanly stays stopped; one that dies is restarted');
  assert.match(p, /<key>ThrottleInterval<\/key><integer>60<\/integer>/,
    'a hard-failing config cannot spin');
  assert.match(p, /<string>run<\/string>/);
  assert.match(p, /<key>PATH<\/key>/, 'launchd has a minimal PATH; claude must be findable');
  assert.ok(p.includes(LOG_DIR), 'logs go somewhere a human can find them');
});

test('paths and values are XML-escaped', () => {
  const p = buildPlist('/tmp/a&b<c>', { cliPath: '/opt/cq.js', env: { X: 'a<b>&c' } });
  assert.ok(!/[^&]&[^a-z]/.test(p.replace(/&(amp|lt|gt);/g, '')), 'no raw ampersands survive');
  assert.match(p, /a&amp;b&lt;c&gt;/);
  assert.match(p, /a&lt;b&gt;&amp;c/);
});

test('plistPath lands in LaunchAgents', () => {
  assert.match(plistPath('/tmp/x'), /Library\/LaunchAgents\/com\.cq\.queue\..*\.plist$/);
});

test('a systemd unit is offered off darwin rather than nothing', () => {
  const u = systemdUnit('/tmp/repo', { cliPath: '/opt/cq/bin/cq.js', nodeBin: '/usr/bin/node' });
  assert.match(u, /ExecStart=\/usr\/bin\/node \/opt\/cq\/bin\/cq\.js run/);
  assert.match(u, /Restart=always/);
  assert.match(u, /WorkingDirectory=\/tmp\/repo/);
});
