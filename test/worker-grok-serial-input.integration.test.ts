import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

let child: ChildProcess | undefined;
let root: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(done => child!.once('exit', () => done()));
    if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
    await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await stopped;
    }
  }
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('Grok worker serial input delivery', () => {
  it('holds busy follow-ups and submits each once after its predecessor completes', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-grok-serial-'));
    const dataDir = join(root, 'data');
    const grokHome = join(root, '.grok');
    const sessionId = randomUUID();
    const sessionDir = join(grokHome, 'sessions', encodeURIComponent(dataDir), sessionId);
    const transcript = join(sessionDir, 'updates.jsonl');
    const writesPath = join(root, 'writes.json');
    const controlPath = join(root, 'complete-turn');
    const beginPath = join(root, 'begin-initial');
    const fakeGrok = join(root, 'fake-grok');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(transcript, '');
    writeFileSync(writesPath, '[]');
    // The production worker, queue, adapter and transcript bridge all run.
    // Only Grok is replaced: a busy submit is queued without a history receipt,
    // just as the affected TUI does. A control file completes one native turn.
    writeFileSync(fakeGrok, `#!/usr/bin/env node
const fs = require('node:fs');
const transcript = ${JSON.stringify(transcript)};
const writesPath = ${JSON.stringify(writesPath)};
const controlPath = ${JSON.stringify(controlPath)};
const beginPath = ${JSON.stringify(beginPath)};
const history = ${JSON.stringify(join(grokHome, 'sessions', encodeURIComponent(dataDir), 'prompt_history.jsonl'))};
const sid = ${JSON.stringify(sessionId)};
let busy = false, begun = false, turn = 0, completed = 0, input = '', queue = [];
const writes = [];
function update(value) {
  fs.appendFileSync(transcript, JSON.stringify({ timestamp: Date.now(), method: 'session/update', params: { sessionId: sid, update: value } }) + '\\n');
}
function start(body) {
  busy = true; turn++;
  fs.appendFileSync(history, JSON.stringify({ session_id: sid, prompt: body, is_bash: false }) + '\\n');
  update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: body } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working on ' + body } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'tool-' + turn, title: 'Read', rawInput: { target_file: 'fixture.txt' } });
  process.stdout.write('\\x1b[2J\\x1b[HWaiting for response\\n❯\\nCtrl+c: cancel\\n');
}
process.stdin.setRawMode(true);
process.stdin.on('data', bytes => {
  input += bytes.toString();
  let end;
  while ((end = input.indexOf('\\r')) >= 0) {
    const body = input.slice(0, end).replace(/\\x1b\\[20[01]~/g, '');
    input = input.slice(end + 1);
    if (!body) continue;
    writes.push(body); fs.writeFileSync(writesPath, JSON.stringify(writes));
    if (busy) queue.push(body); else start(body);
  }
});
process.stdout.write('❯\\n');
setInterval(() => {
  if (!begun && fs.existsSync(beginPath)) { begun = true; start('initial turn'); }
  const requested = fs.existsSync(controlPath) ? Number(fs.readFileSync(controlPath, 'utf8')) : 0;
  if (!busy || requested <= completed) return;
  completed = requested; busy = false;
  update({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' });
  process.stdout.write('\\x1b[2J\\x1b[H❯\\n');
  if (queue.length) start(queue.shift());
}, 20);
`);
    chmodSync(fakeGrok, 0o755);
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: { ...process.env, HOME: root, GROK_HOME: grokHome, SESSION_DATA_DIR: dataDir,
        BOTMUX_TIME_SCALE: '1', BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', bytes => logs.push(bytes.toString()));
    child.stderr?.on('data', bytes => logs.push(bytes.toString()));
    const waitUntil = async (check: () => boolean) => {
      const deadline = Date.now() + 15_000;
      while (!check()) {
        if (child?.exitCode !== null || child?.signalCode !== null || Date.now() > deadline) {
          throw new Error(`Worker did not reach expected state\n${logs.join('').slice(-4_000)}\nTRANSCRIPT=${readFileSync(transcript, 'utf8')}\nWRITES=${readFileSync(writesPath, 'utf8')}`);
        }
        await new Promise(done => setTimeout(done, 20));
      }
    };
    const writes = (): string[] => JSON.parse(readFileSync(writesPath, 'utf8'));
    child.send({ type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'grok', cliPathOverride: fakeGrok, cliSessionId: sessionId,
      backendType: 'pty', prompt: 'initial turn', larkAppId: 'app_test', larkAppSecret: 'test-only',
      turnId: 'turn_initial' } satisfies DaemonToWorker);
    await waitUntil(() => logs.some(line => line.includes('publishing projected working before first prompt')));
    writeFileSync(beginPath, 'start');
    await waitUntil(() => messages.some(msg => msg.type === 'thinking_update'));
    child.send({ type: 'message', content: 'follow-up one', turnId: 'turn_one' } satisfies DaemonToWorker);
    child.send({ type: 'message', content: 'follow-up two', turnId: 'turn_two' } satisfies DaemonToWorker);
    // The native submit transport would write within 200ms. A busy successor
    // must remain outside it while its predecessor still owns the turn.
    await new Promise(done => setTimeout(done, 1_800));
    expect(writes()).toEqual([]);
    expect(messages.filter(msg => msg.type === 'user_notify')).toEqual([]);

    writeFileSync(controlPath, '1');
    await waitUntil(() => writes().length > 0);
    await new Promise(done => setTimeout(done, 400));
    expect(writes()).toEqual(['follow-up one']);
    expect(messages.filter(msg => msg.type === 'user_notify')).toEqual([]);

    writeFileSync(controlPath, '2');
    await waitUntil(() => writes().length === 2);
    expect(writes()).toEqual(['follow-up one', 'follow-up two']);
    writeFileSync(controlPath, '3');
    await waitUntil(() => messages.some(msg => msg.type === 'turn_terminal' && msg.turnId === 'turn_two'));
    expect(writes()).toEqual(['follow-up one', 'follow-up two']);
    expect(messages.filter(msg => msg.type === 'user_notify')).toEqual([]);
  }, 30_000);
});
