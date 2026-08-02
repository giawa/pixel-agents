import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState, PersistedAgent } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

/**
 * Restored agents must keep their palette/hueShift across server restarts.
 * PersistedAgent carries the values; restoreExternalAgents copies them onto
 * the fresh AgentState and assignPaletteIfNeeded is a no-op (palette is
 * already set), so existingAgents sends the persisted values instead of
 * re-rolling. Persistence + restore round-trip is tested end-to-end through
 * a real FileStateAdapter on disk (temp HOME), not a mock, so the on-disk
 * shape is exercised too.
 */
describe('AgentRuntime -- restore preserves palette/hueShift', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let tempJsonl: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-restore-pal-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    // os.homedir() consults HOME on POSIX and USERPROFILE on Windows — set
    // both so FileStateAdapter's stateFilePath lands inside tempHome on
    // every platform (without this, Windows tests write to the real
    // ~/.pixel-agents/ and leak state across suites).
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    // restoreExternalAgents skips agents whose jsonlFile doesn't exist.
    tempJsonl = path.join(tempHome, 'session.jsonl');
    fs.writeFileSync(tempJsonl, '');

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
  });

  afterEach(() => {
    // NOTE: dispose the runtime FIRST. AgentRuntime.dispose() calls
    // removeAgent() for every tracked agent, which calls store.persist() --
    // so disposing after the store has already been cleared (or after a
    // fresh store was built) can clobber the on-disk state file. Disposing
    // here while the original store still holds its agents is safe.
    runtime?.dispose();
    store?.dispose();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('restoreExternalAgents keeps palette/hueShift from the persisted record', () => {
    const persisted: PersistedAgent[] = [
      {
        id: 7,
        sessionId: 'sess-restore',
        terminalName: '',
        isExternal: true,
        jsonlFile: tempJsonl,
        projectDir: tempHome,
        palette: 3,
        hueShift: 90,
      },
    ];
    store.getAdapter()!.saveAgents(persisted);

    runtime = new AgentRuntime(store, claudeProvider);
    runtime.restoreExternalAgents();

    const agent = store.get(7);
    expect(agent).toBeDefined();
    expect(agent?.palette).toBe(3);
    expect(agent?.hueShift).toBe(90);
  });

  it('persist() then restoreExternalAgents round-trips palette/hueShift unchanged', () => {
    // persist via one runtime, then build a fresh store + runtime from disk
    // (simulating a restart). The old runtime is left for afterEach to
    // dispose — disposing it mid-test would clobber the on-disk file (see
    // the afterEach note above).
    runtime = new AgentRuntime(store, claudeProvider);
    const agent = createTestAgent({
      id: 42,
      sessionId: 'sess-rt',
      jsonlFile: tempJsonl,
      projectDir: tempHome,
      palette: 5,
      hueShift: 270,
    });
    store.set(42, agent);
    store.persist();

    // New store + runtime fresh from disk.
    const freshStore = new AgentStateStore();
    freshStore.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    const freshRuntime = new AgentRuntime(freshStore, claudeProvider);
    freshRuntime.restoreExternalAgents();

    const restored = freshStore.get(42);
    expect(restored).toBeDefined();
    expect(restored?.palette).toBe(5);
    expect(restored?.hueShift).toBe(270);

    // Dispose the fresh runtime so its removeAgent→persist doesn't leak.
    freshRuntime.dispose();
  });

  it('assigns a fresh palette when the persisted record has no palette', () => {
    const persisted: PersistedAgent[] = [
      {
        id: 9,
        sessionId: 'sess-fresh',
        terminalName: '',
        isExternal: true,
        jsonlFile: tempJsonl,
        projectDir: tempHome,
        // palette/hueShift intentionally omitted
      },
    ];
    store.getAdapter()!.saveAgents(persisted);

    runtime = new AgentRuntime(store, claudeProvider);
    runtime.restoreExternalAgents();

    const agent = store.get(9);
    expect(agent).toBeDefined();
    // assignPaletteIfNeeded fills in [0, PALETTE_COUNT) with hueShift 0 on
    // an empty store (first round). We assert it's been set to something
    // valid rather than re-deriving the exact algorithm here.
    expect(agent?.palette).toBeGreaterThanOrEqual(0);
    expect(agent?.palette).toBeLessThan(6);
    expect(agent?.hueShift).toBe(0);
  });
});
