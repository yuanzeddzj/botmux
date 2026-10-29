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

async function startFixture(order: 'composer-first' | 'terminal-first' | 'no-terminal' | 'failed-terminal' | 'redraw-only' | 'fast-terminal' | 'fast-failed', backendType: 'pty' | 'tmux' = 'pty') {
  root = mkdtempSync(join(tmpdir(), 'botmux-first-terminal-test-'));
  const data = join(root, 'data');
  const grokHome = join(root, '.grok');
  const sid = randomUUID();
  const sessionDir = join(grokHome, 'sessions', encodeURIComponent(data), sid);
  const transcript = join(sessionDir, 'updates.jsonl');
  const writesPath = join(root, 'writes.json');
  const redrawsPath = join(root, 'redraws.json');
  const finish = join(root, 'finish');
  const release = join(root, 'release');
  const begin = join(root, 'begin');
  const foreign = join(root, 'foreign-terminal');
  const replay = join(root, 'replay-terminal');
  const fake = join(root, 'fake-grok');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(transcript, '');
  writeFileSync(writesPath, '[]');
  writeFileSync(redrawsPath, '[]');
  writeFileSync(join(root, '.zshrc'), '# isolated fixture\n');
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const transcript = ${JSON.stringify(transcript)};
const writesPath = ${JSON.stringify(writesPath)};
const redrawsPath = ${JSON.stringify(redrawsPath)};
const history = ${JSON.stringify(join(grokHome, 'sessions', encodeURIComponent(data), 'prompt_history.jsonl'))};
const finish = ${JSON.stringify(finish)}, release = ${JSON.stringify(release)}, begin = ${JSON.stringify(begin)};
const foreign = ${JSON.stringify(foreign)}, replay = ${JSON.stringify(replay)};
const sid = ${JSON.stringify(sid)}, order = ${JSON.stringify(order)};
let begun = false, finished = 0, requested = 0, turn = 0, input = '', tick = 0, terminalRecord;
function update(value) {
  const record = { timestamp: Date.now(), method: 'session/update', params: {sessionId: sid, update: value} };
  if (value.sessionUpdate === 'turn_completed') {
    value.prompt_id = 'native-turn-' + turn;
    record.params._meta = {eventId: 'terminal-' + turn};
    terminalRecord = record;
  }
  fs.appendFileSync(transcript, JSON.stringify(record) + '\\n');
}
function composer() { process.stdout.write('\\x1b[2J\\x1b[H❯\\nShift+Tab:mode | Ctrl+x:shortcuts\\n'); }
function busy() { process.stdout.write('\\x1b[2J\\x1b[HWaiting for response ' + (++tick) + '\\nCtrl+c:cancel\\n'); }
process.on('SIGWINCH', () => {
  const redraws = JSON.parse(fs.readFileSync(redrawsPath, 'utf8'));
  redraws.push({turn, completed:finished >= turn}); fs.writeFileSync(redrawsPath, JSON.stringify(redraws));
  if (order === 'redraw-only' && finished >= turn) composer();
});
function start(body) {
  turn++;
  update({ sessionUpdate: 'user_message_chunk', content: {type:'text',text:body} });
  update({ sessionUpdate: 'agent_message_chunk', content: {type:'text',text:'working'} });
  update({ sessionUpdate: 'tool_call', toolCallId: 'tool-' + turn, title: 'Read', rawInput: {target_file:'fixture.txt'} });
  busy();
}
process.stdin.setRawMode(true);
process.stdin.on('data', bytes => {
  input += bytes.toString();
  let end;
  while ((end = input.indexOf('\\r')) >= 0) {
    const body = input.slice(0,end).replace(/\\x1b\\[20[01]~/g,''); input = input.slice(end+1);
    if (!body) continue;
    const writes = JSON.parse(fs.readFileSync(writesPath,'utf8'));
    writes.push(body); fs.writeFileSync(writesPath,JSON.stringify(writes));
    const receipt = () => fs.appendFileSync(history,JSON.stringify({session_id:sid,prompt:body,is_bash:false})+'\\n');
    if (order === 'fast-terminal' || order === 'fast-failed') setTimeout(receipt, 5_000);
    else receipt();
    start(body);
    if (order === 'fast-terminal' || order === 'fast-failed') {
      const completedTurn = turn;
      setTimeout(() => {
        if (turn !== completedTurn) return;
        finished = turn; composer();
        update({sessionUpdate:'turn_completed',stop_reason:order === 'fast-failed' ? 'error' : 'end_turn'});
      }, 50);
    }
  }
});
busy();
setInterval(() => {
  if (!begun && fs.existsSync(begin)) { begun = true; start('initial turn'); }
  const next = fs.existsSync(finish) ? Number(fs.readFileSync(finish,'utf8')) : 0;
  if (begun && next > requested) {
    requested = next;
    if (order === 'redraw-only' || (order === 'terminal-first' && next === 1)) {
      update({sessionUpdate:'turn_completed',stop_reason:'end_turn'});
    } else {
      composer();
      if (order !== 'no-terminal' || next > 1) {
        setTimeout(() => update({sessionUpdate:'turn_completed',stop_reason:order === 'failed-terminal' ? 'error' : 'end_turn'}),350);
      }
    }
    finished = next;
  }
  if (order === 'terminal-first' && requested === 1 && fs.existsSync(release)) {
    composer(); fs.unlinkSync(release);
  }
  if (fs.existsSync(foreign)) {
    fs.appendFileSync(transcript, JSON.stringify({timestamp:Date.now(),method:'session/update',params:{sessionId:'foreign-session',update:{sessionUpdate:'turn_completed',stop_reason:'end_turn'}}})+'\\n');
    fs.unlinkSync(foreign);
  }
  if (terminalRecord && fs.existsSync(replay)) {
    // A late retry may carry a new transport event id for the SAME native turn.
    const duplicate = {...terminalRecord, timestamp:Date.now(), params:{...terminalRecord.params, _meta:{eventId:'retry-terminal-' + turn}}};
    fs.appendFileSync(transcript,JSON.stringify(duplicate)+'\\n'); fs.unlinkSync(replay);
  }
  if (begun && finished < turn) busy();
},100);
`);
  chmodSync(fake, 0o755);
  const messages: WorkerToDaemon[] = [];
  let logs = '';
  child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: { ...process.env, HOME: root, GROK_HOME: grokHome, SESSION_DATA_DIR: data,
      BOTMUX_SESSION_ID: sid, BOTMUX_COORDINATION_MODE: 'disabled', BOTMUX_TMUX_SOCKET: `grok-readiness-${sid}`,
      LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', b => { logs += b.toString(); });
  child.stderr?.on('data', b => { logs += b.toString(); });
  child.on('message', m => messages.push(m as WorkerToDaemon));
  const wait = async (test: () => boolean, label: string, budget = 12_000) => {
    const deadline = Date.now() + budget;
    while (!test()) {
      if (Date.now() > deadline || child?.exitCode !== null || child?.signalCode !== null)
        throw new Error(label + '\n' + logs.slice(-3500));
      await new Promise(done => setTimeout(done, 25));
    }
  };
  const send = (content: string, turnId: string) => child!.send({type:'message',content,turnId} satisfies DaemonToWorker);
  const writes = (): string[] => JSON.parse(readFileSync(writesPath, 'utf8'));
  const terminalCount = (turnId: string) => messages.filter(m => m.type === 'turn_terminal' && m.turnId === turnId).length;
  child.send({ type: 'init', sessionId: sid, chatId: 'oc_test', rootMessageId: 'om_test',
    workingDir: data, cliId: 'grok', cliPathOverride: fake, cliSessionId: sid,
    backendType, prompt: 'initial turn', turnId: 'turn_initial',
    larkAppId: 'app_test', larkAppSecret: 'test-only' } satisfies DaemonToWorker);
  await wait(() => logs.includes('publishing projected working before first prompt'), 'worker started');
  writeFileSync(begin, '1');
  await wait(() => messages.some(m => m.type === 'thinking_update'), 'initial turn started');
  return { wait, send, writes, terminalCount, messages,
    redraws: (): Array<{turn: number; completed: boolean}> => JSON.parse(readFileSync(redrawsPath, 'utf8')),
    finish: (n: number) => writeFileSync(finish, String(n)),
    release: () => writeFileSync(release, '1'),
    foreign: () => writeFileSync(foreign, '1'),
    replay: () => writeFileSync(replay, '1'),
    delay: (ms: number) => new Promise(done => setTimeout(done, ms)),
  };
}

describe('Grok first terminal readiness without a terminal client', () => {
  it.each(['fast-terminal', 'fast-failed'] as const)('releases the next queued input when a native turn completes before submit verification returns (%s)', async order => {
    const f = await startFixture(order);
    f.finish(1);
    await f.wait(() => f.terminalCount('turn_initial') === 1, 'initial terminal');
    await f.delay(3_000);
    f.send('fast first input', 'turn_fast');
    f.send('next queued input', 'turn_next');
    await f.wait(() => f.terminalCount('turn_fast') === 1, 'fast native terminal');
    await f.wait(() => f.writes().length === 2, 'next input after the submission mutex is released', 8_000);
    expect(f.writes()).toEqual(['fast first input', 'next queued input']);
    expect(f.terminalCount('turn_fast')).toBe(1);
  }, 25_000);

  it('requests a terminal-owned tmux redraw and releases two queued inputs in separate completed turns without attach', async () => {
    const f = await startFixture('redraw-only', 'tmux');
    f.send('follow-up one', 'turn_one');
    f.send('follow-up two', 'turn_two');
    await f.delay(4_000);
    expect(f.writes()).toEqual([]);
    expect(f.redraws()).toEqual([]);
    f.finish(1);
    await f.wait(() => f.writes().length === 1, 'first queued input after terminal redraw', 12_000);
    expect(f.writes()).toEqual(['follow-up one']);
    f.replay();
    await f.delay(4_000);
    expect(f.writes()).toEqual(['follow-up one']);
    f.finish(2);
    await f.wait(() => f.writes().length === 2, 'second queued input after its terminal redraw', 12_000);
    expect(f.writes()).toEqual(['follow-up one', 'follow-up two']);
    expect(f.redraws().length).toBeGreaterThan(0);
    expect(f.redraws().every(row => row.completed)).toBe(true);
    expect(f.terminalCount('turn_initial')).toBe(1);
    expect(f.terminalCount('turn_one')).toBe(1);
  }, 45_000);

  it('keeps the initial terminal settled when the composer is rendered first, then releases successors one at a time', async () => {
    const f = await startFixture('composer-first');
    f.finish(1);
    await f.wait(() => f.terminalCount('turn_initial') === 1, 'initial terminal');
    await f.delay(3_000);
    f.send('follow-up one', 'turn_one');
    f.send('follow-up two', 'turn_two');
    await f.wait(() => f.writes().length === 1, 'first follow-up admitted', 6_000);
    await f.delay(1_000);
    expect(f.writes()).toEqual(['follow-up one']);
    f.replay();
    await f.delay(1_000);
    expect(f.writes()).toEqual(['follow-up one']);
    expect(f.terminalCount('turn_initial')).toBe(1);
    expect(f.terminalCount('turn_one')).toBe(0);
    f.finish(2);
    await f.wait(() => f.writes().length === 2, 'second follow-up admitted');
    expect(f.writes()).toEqual(['follow-up one', 'follow-up two']);
    expect(f.terminalCount('turn_initial')).toBe(1);
    expect(f.messages.filter(m => m.type === 'user_notify')).toEqual([]);
  }, 30_000);

  it('waits for the writable composer after terminal, even when a later input is already queued', async () => {
    const f = await startFixture('terminal-first');
    f.finish(1);
    await f.wait(() => f.terminalCount('turn_initial') === 1, 'initial terminal');
    f.send('follow-up', 'turn_followup');
    await f.delay(4_000);
    expect(f.writes()).toEqual([]);
    f.release();
    await f.wait(() => f.writes().length === 1, 'composer release');
    expect(f.writes()).toEqual(['follow-up']);
  }, 25_000);

  it('does not treat a quiet composer as a terminal for the still executing initial turn', async () => {
    const f = await startFixture('no-terminal');
    f.finish(1);
    await f.delay(3_000);
    f.send('follow-up', 'turn_followup');
    f.foreign();
    await f.delay(5_000);
    expect(f.writes()).toEqual([]);
    expect(f.terminalCount('turn_initial')).toBe(0);
  }, 25_000);

  it('preserves a failed native terminal while admitting later input only at the writable composer', async () => {
    const f = await startFixture('failed-terminal');
    f.finish(1);
    await f.wait(() => f.terminalCount('turn_initial') === 1, 'failed initial terminal');
    expect(f.messages.find(m => m.type === 'turn_terminal' && m.turnId === 'turn_initial'))
      .toMatchObject({status:'failed',errorCode:'grok_turn_error'});
    f.send('follow-up', 'turn_followup');
    await f.wait(() => f.writes().length === 1, 'follow-up after failure');
    expect(f.writes()).toEqual(['follow-up']);
  }, 20_000);
});
