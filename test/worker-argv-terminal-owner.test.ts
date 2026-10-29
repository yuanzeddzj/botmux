import { describe, expect, it } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { CodexPendingTurn } from '../src/services/codex-bridge-queue.js';

function fixture() {
  const owner = {generation:3,cliSessionId:'native-current',turnId:'initial',dispatchAttempt:2};
  const state = {spawnArgvInitialTurn:owner,cliSpawnGeneration:3,
    lastSpawnEffectiveCliSessionId:'native-current',lastInitConfig:{},
    spawnArgvInitialPromptBusy:true,spawnArgvNeedsWorkingSeed:true};
  const observe = loadWorkerFunction<(turns: readonly CodexPendingTurn[]) => void>('observeSpawnArgvInitialTerminal', state);
  const terminal: CodexPendingTurn = {turnId:'initial',dispatchAttempt:2,started:true,finalText:'',sourceSessionId:'native-current'};
  return {state,owner,observe,terminal};
}

describe('argv initial terminal belongs to one native execution', () => {
  it('retires the startup working seed for the bridge-matched initial completion', () => {
    const f = fixture();
    f.observe([f.terminal]);
    expect(f.state).toMatchObject({spawnArgvInitialTurn:null,spawnArgvInitialPromptBusy:false,spawnArgvNeedsWorkingSeed:false});
    // Replayed completion remains idempotent after its owner was consumed.
    f.observe([f.terminal]);
    expect(f.state.spawnArgvInitialTurn).toBeNull();
  });

  it('does not retire the active startup for another turn, retry attempt, local input or foreign session', () => {
    const f = fixture();
    f.observe([
      {...f.terminal,turnId:'unrelated'}, {...f.terminal,dispatchAttempt:1},
      {...f.terminal,isLocal:true}, {...f.terminal,sourceSessionId:'foreign'},
      {...f.terminal,started:false}, {...f.terminal,finalText:undefined},
    ]);
    expect(f.state.spawnArgvInitialTurn).toBe(f.owner);
    expect(f.state.spawnArgvInitialPromptBusy).toBe(true);
  });

  it('does not let a terminal carried from the prior process settle a new generation', () => {
    const f = fixture(); f.state.cliSpawnGeneration=4;
    f.observe([f.terminal]);
    expect(f.state.spawnArgvInitialPromptBusy).toBe(true);
  });

  it('does not let the retired native session change the successor session state', () => {
    const f = fixture(); f.state.lastSpawnEffectiveCliSessionId='native-successor';
    f.observe([f.terminal]);
    expect(f.state.spawnArgvInitialPromptBusy).toBe(true);
  });
});
