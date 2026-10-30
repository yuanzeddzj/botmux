import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as registry from '../src/bot-registry.js';
import * as discovery from '../src/utils/daemon-discovery.js';
import * as ipc from '../src/core/daemon-ipc-auth.js';
import { createExclusiveTopicRuntime } from '../src/core/exclusive-topic-runtime.js';
import { ExclusiveTopicCoordinator } from '../src/services/exclusive-topic-owner.js';

const topic = { chatId: 'oc_registry_view', rootId: 'om_registry_view' };
const input = (app: string, time: number, selected = true) => ({ ...topic, larkAppId: app,
  ...(selected ? { selectedAppId: app } : {}), createdAt: time, messageId: `om_${time}` });
let dataDir: string;
let previous: string;
let running: Set<string>;
let revoke: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  previous = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-registry-view-'));
  config.session.dataDir = dataDir;
  const configs = ['a', 'b'].map(larkAppId => ({ larkAppId, cliId: 'traex', apiOnly: true, exclusiveTopicOwner: true }));
  // Production registers one SDK client per daemon, while configuration has
  // every managed bot. Peers must not disappear from this local registry view.
  vi.spyOn(registry, 'getAllBots').mockReturnValue([{ config: configs[1] }] as any);
  vi.spyOn(registry, 'loadBotConfigs').mockReturnValue(configs as any);
  vi.spyOn(discovery, 'findOnlineDaemon').mockImplementation(app => ({ larkAppId: app, ipcPort: app === 'a' ? 9001 : 9002 } as any));
  running = new Set(['a']);
  revoke = vi.spyOn(ipc, 'fetchDaemonIpc').mockImplementation(async port => {
    if (port === 9001) running.delete('a');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
});
afterEach(() => { config.session.dataDir = previous; vi.restoreAllMocks(); rmSync(dataDir, { recursive: true, force: true }); });

it('stops a peer absent from the receiving daemon registry before starting the selected owner', async () => {
  await new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} }).admit(input('a', 1), async () => {});
  expect(registry.getAllBots()).toHaveLength(1);
  const runtime = createExclusiveTopicRuntime();
  expect(await runtime.admit(input('b', 2), async () => { running.add('b'); expect([...running]).toEqual(['b']); })).toBe(true);
  expect(revoke).toHaveBeenCalledWith(9001, '/api/topic-ownership/revoke', expect.anything());
});

it('rechecks an old active ownership record once after the peer-discovery protocol changes', async () => {
  await new ExclusiveTopicCoordinator({ dataDir, revokeOtherBots: async () => {} }).admit(input('b', 1), async () => {});
  const path = join(dataDir, 'topic-owners', readdirSync(join(dataDir, 'topic-owners')).find(name => name.endsWith('.execution.json'))!);
  const legacy = JSON.parse(readFileSync(path, 'utf8'));
  delete legacy.protocol;
  writeFileSync(path, JSON.stringify(legacy));
  running.add('b');
  const runtime = createExclusiveTopicRuntime();
  expect(await runtime.admit(input('b', 2, false), async () => { expect([...running]).toEqual(['b']); })).toBe(true);
  const calls = revoke.mock.calls.length;
  expect(await runtime.admit(input('b', 3, false), async () => {})).toBe(true);
  expect(revoke.mock.calls).toHaveLength(calls);
});
