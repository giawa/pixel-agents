import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  type AssetCache,
  type ClientMessageContext,
  handleClientMessage,
} from '../src/clientMessageHandler.js';
import { readConfig, writeConfig } from '../src/configPersistence.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { readLayoutFromFile } from '../src/layoutPersistence.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
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
 * These tests exercise the area-related dispatch branches and the load-order
 * invariant in handleWebviewReady. They isolate the on-disk config + state
 * files by redirecting $HOME to a fresh temp dir for every test, so the
 * standalone adapter writes its config.json there.
 */
describe('clientMessageHandler: areas + carpet wire ordering', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  function freshCtx(cache: AssetCache | null = null): ClientMessageContext {
    return { store, cache };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = freshCtx();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── saveAreaMappings ─────────────────────────────────────────

  describe('saveAreaMappings', () => {
    it('persists a valid mapping payload to cfg.standalone.areaMappings', () => {
      handleClientMessage(
        {
          type: 'saveAreaMappings',
          mappings: { frontend: ['Engineering'], design: ['Engineering', 'Design'] },
        },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({
        frontend: ['Engineering'],
        design: ['Engineering', 'Design'],
      });
    });

    it('is a no-op when mappings is missing or not an object', () => {
      handleClientMessage({ type: 'saveAreaMappings' }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: 'not-an-object' },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({});
    });

    it('does not leak into the vscode namespace', () => {
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({ frontend: ['Engineering'] });
      expect(cfg.vscode.areaMappings).toEqual({});
    });
  });

  // ── setShowAreas ─────────────────────────────────────────────

  describe('setShowAreas', () => {
    it('persists the boolean via the adapter (standalone namespace)', () => {
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);

      const adapter = store.getAdapter()!;
      expect(adapter.getSetting('pixel-agents.showAreas', false)).toBe(true);

      handleClientMessage({ type: 'setShowAreas', enabled: false }, (m) => sent.push(m), ctx);
      expect(adapter.getSetting('pixel-agents.showAreas', true)).toBe(false);
    });
  });

  // ── handleWebviewReady ordering ──────────────────────────────

  describe('handleWebviewReady ordering', () => {
    it('emits settingsLoaded with showAreas before areaMappingsLoaded before existingAgents', () => {
      // Seed config so the assertion proves the values round-trip via the
      // dispatch rather than just relying on hard-coded defaults.
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );
      sent = [];

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);

      const iSettings = types.indexOf('settingsLoaded');
      const iAreaMappings = types.indexOf('areaMappingsLoaded');
      const iExistingAgents = types.indexOf('existingAgents');

      expect(iSettings).toBeGreaterThanOrEqual(0);
      expect(iAreaMappings).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iSettings).toBeLessThan(iAreaMappings);
      expect(iAreaMappings).toBeLessThan(iExistingAgents);

      const settings = sent[iSettings] as { showAreas?: boolean };
      expect(settings.showAreas).toBe(true);

      const mappings = sent[iAreaMappings] as { mappings?: Record<string, string[]> };
      expect(mappings.mappings).toEqual({ frontend: ['Engineering'] });
    });

    it('emits layoutLoaded after existingAgents so buffered agents materialize', () => {
      // The webview buffers agents from existingAgents and only materializes
      // them on the next layoutLoaded. If layout arrives first, a client
      // connecting after agents were created never renders their characters.
      store.set(1, createTestAgent({ id: 1 }));

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iExistingAgents = types.indexOf('existingAgents');
      const iLayout = types.indexOf('layoutLoaded');

      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iLayout).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeLessThan(iLayout);

      const existing = sent[iExistingAgents] as { agents?: number[] };
      expect(existing.agents).toEqual([1]);
    });

    it('emits carpetTilesLoaded after wallTilesLoaded when both are present in the cache', () => {
      // Hex placeholders are test fixtures, not UI tokens — disable the
      // centralized-color rule just for this cache literal.
      /* eslint-disable pixel-agents/no-inline-colors */
      const cache: AssetCache = {
        characters: null,
        pets: null,
        floorTiles: [[['#000000']]],
        wallTiles: [[[['#aabbcc']]]],
        carpetTiles: [[[['#112233']]]],
        furniture: null,
        defaultLayout: null,
      };
      /* eslint-enable pixel-agents/no-inline-colors */
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iWalls = types.indexOf('wallTilesLoaded');
      const iCarpets = types.indexOf('carpetTilesLoaded');

      expect(iWalls).toBeGreaterThanOrEqual(0);
      expect(iCarpets).toBeGreaterThanOrEqual(0);
      expect(iWalls).toBeLessThan(iCarpets);
    });

    it('skips carpetTilesLoaded when the cache has no carpet sprites', () => {
      const cache: AssetCache = {
        characters: null,
        pets: null,
        floorTiles: null,
        wallTiles: null,
        carpetTiles: null,
        furniture: null,
        defaultLayout: null,
      };
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const carpetMsgs = sent.filter((m) => m.type === 'carpetTilesLoaded');
      expect(carpetMsgs).toHaveLength(0);
    });

    it('always emits areaMappingsLoaded, even with no persisted mappings (sends {})', () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const areaMsgs = sent.filter((m) => m.type === 'areaMappingsLoaded');
      expect(areaMsgs).toHaveLength(1);
      expect((areaMsgs[0] as { mappings: Record<string, string[]> }).mappings).toEqual({});
    });
  });
});

describe('clientMessageHandler: remote read-only mode', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;

  function freshCtx(isLocal = true): ClientMessageContext {
    return { store, cache: null, isLocal };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-ro-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('allows webviewReady from remote clients', () => {
    const ctx = freshCtx(false);
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

    const types = sent.map((m) => m.type);
    expect(types).toContain('settingsLoaded');
    expect(types).toContain('layoutLoaded');
  });

  it('allows requestDiagnostics from remote clients', () => {
    const ctx = freshCtx(false);
    handleClientMessage({ type: 'requestDiagnostics' }, (m) => sent.push(m), ctx);

    const diagMsg = sent.find((m) => m.type === 'agentDiagnostics');
    expect(diagMsg).toBeDefined();
  });

  it('includes readOnly: true in settingsLoaded for remote clients', () => {
    const ctx = freshCtx(false);
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

    const settingsMsg = sent.find((m) => m.type === 'settingsLoaded') as {
      readOnly?: boolean;
    };
    expect(settingsMsg.readOnly).toBe(true);
  });

  it('does not include readOnly for local clients', () => {
    const ctx = freshCtx(true);
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

    const settingsMsg = sent.find((m) => m.type === 'settingsLoaded') as {
      readOnly?: boolean;
    };
    expect(settingsMsg.readOnly).toBeUndefined();
  });

  // Stub state adapter so mutation handlers either fall through to the spy
  // (setSetting/saveSeats) or stop at the gate before reaching the module-level
  // writeLayoutToFile / writeConfig calls. Uses spies instead of the real
  // FileStateAdapter so the rejection tests are hermetic — they don't read or
  // write the real ~/.pixel-agents/ (which on Windows isn't redirected by
  // process.env.HOME because os.homedir() consults USERPROFILE instead).
  function stubAdapter() {
    const setSettingCalls: Array<{ key: string; value: unknown }> = [];
    const saveSeatsCalls: Array<Record<string, unknown>> = [];
    return {
      adapter: {
        getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
        setSetting: <T>(key: string, value: T): void => {
          setSettingCalls.push({ key, value });
        },
        loadSeats: () => ({}),
        saveSeats: (seats: Record<string, unknown>): void => {
          saveSeatsCalls.push(seats);
        },
        loadAgents: () => [],
        saveAgents: () => {},
      },
      setSettingCalls,
      saveSeatsCalls,
    };
  }

  // Stub runtime so closeAgent's `if (agent && runtime)` branch is exercised:
  // removeAgent + dismissalTracker.dismiss become observable. Without this
  // stub the closeAgent handler is a no-op regardless of the gate.
  // restoreExternalAgents is a no-op so the exhaustive-allowlist test (which
  // sends a webviewReady to enumerate handlers) doesn't blow up here.
  function stubRuntime(removed: Set<number>, dismissed: Set<string>) {
    return {
      dismissalTracker: { dismiss: (file: string) => dismissed.add(file) },
      hooksEnabled: { current: true },
      watchAllSessions: { current: false },
      removeAgent: (id: number) => {
        removed.add(id);
      },
      restoreExternalAgents: () => {},
    } as unknown as AgentRuntime;
  }

  it('rejects every mutation type from remote clients (state-based assertions)', () => {
    // Install the stub adapter so mutation handlers either fall through to
    // the spy (setSetting/saveSeats) or stop at the gate before reaching the
    // module-level writeLayoutToFile / writeConfig calls.
    const { adapter, setSettingCalls, saveSeatsCalls } = stubAdapter();
    store.setAdapter(adapter);

    // ── closeAgent: seeded agent must survive ─────────────────────────
    store.set(1, createTestAgent({ id: 1, jsonlFile: '/test/survivor.jsonl' }));
    const removed = new Set<number>();
    const dismissed = new Set<string>();
    let ctx = { ...freshCtx(false), runtime: stubRuntime(removed, dismissed) };
    handleClientMessage({ type: 'closeAgent', id: 1 }, () => {}, ctx);
    expect(store.get(1), 'closeAgent must not remove agent').toBeDefined();
    expect(removed, 'closeAgent must not invoke runtime.removeAgent').toHaveLength(0);
    expect(dismissed, 'closeAgent must not invoke dismissalTracker.dismiss').toHaveLength(0);

    // ── saveLayout: sentinel value must not appear in the layout file ──
    // Use a unique sentinel so the assertion is hermetic — the layout file
    // may already exist from a prior run on Windows where HOME isolation is
    // broken; we only assert the remote payload wasn't written.
    handleClientMessage(
      {
        type: 'saveLayout',
        layout: { version: 1, cols: 4242, rows: 4242, tiles: [], furniture: [] },
      },
      () => {},
      freshCtx(false),
    );
    const savedLayout = readLayoutFromFile();
    expect(savedLayout?.cols ?? 0, 'saveLayout must not persist sentinel cols').not.toBe(4242);

    // ── saveAgentSeats: stub.saveSeats spy must never fire ─────────────
    handleClientMessage(
      { type: 'saveAgentSeats', seats: { 1: { palette: 3, hueShift: 120, seatId: 'x' } } },
      () => {},
      freshCtx(false),
    );
    expect(saveSeatsCalls, 'saveAgentSeats must not reach adapter.saveSeats').toHaveLength(0);

    // ── set* settings: stub.setSetting spy must never fire ─────────────
    handleClientMessage({ type: 'setSoundEnabled', enabled: false }, () => {}, freshCtx(false));
    handleClientMessage(
      { type: 'setLastSeenVersion', version: '9.9.9' },
      () => {},
      freshCtx(false),
    );
    handleClientMessage({ type: 'setAlwaysShowLabels', enabled: true }, () => {}, freshCtx(false));
    handleClientMessage({ type: 'setWatchAllSessions', enabled: true }, () => {}, freshCtx(false));
    handleClientMessage({ type: 'setHooksEnabled', enabled: false }, () => {}, freshCtx(false));
    handleClientMessage({ type: 'setHooksInfoShown' }, () => {}, freshCtx(false));
    handleClientMessage({ type: 'setShowAreas', enabled: true }, () => {}, freshCtx(false));
    expect(setSettingCalls, 'set* mutations must not reach adapter.setSetting').toHaveLength(0);

    // ── addExternalAssetDirectory: sentinel path must not be persisted ─
    const remoteAssetPath = '/remote/sentinel/zzz-pixel-agents-ro-test';
    handleClientMessage(
      { type: 'addExternalAssetDirectory', path: remoteAssetPath },
      () => {},
      freshCtx(false),
    );
    expect(
      readConfig().externalAssetDirectories,
      'remote addAssetDir must not persist sentinel path',
    ).not.toContain(remoteAssetPath);

    // ── removeExternalAssetDirectory: pre-seeded sentinel must survive ─
    const keepPath = '/keep/sentinel/zzz-pixel-agents-ro-test';
    let cfg = readConfig();
    if (!cfg.externalAssetDirectories.includes(keepPath)) {
      cfg.externalAssetDirectories.push(keepPath);
      writeConfig(cfg);
    }
    handleClientMessage(
      { type: 'removeExternalAssetDirectory', path: keepPath },
      () => {},
      freshCtx(false),
    );
    expect(
      readConfig().externalAssetDirectories,
      'remote removeAssetDir must not drop seeded sentinel path',
    ).toContain(keepPath);

    // ── saveAreaMappings: sentinel key must not be persisted ───────────
    handleClientMessage(
      { type: 'saveAreaMappings', mappings: { __remote_sentinel__: ['Bar'] } },
      () => {},
      freshCtx(false),
    );
    expect(
      readConfig().standalone.areaMappings ?? {},
      'remote saveAreaMappings must not persist sentinel key',
    ).not.toHaveProperty('__remote_sentinel__');

    // ── launchAgent: defensive rejection; just assert no side effect ────
    const removedAfterLaunch = new Set<number>();
    ctx = { ...freshCtx(false), runtime: stubRuntime(removedAfterLaunch, new Set<string>()) };
    const agentIdsBefore = [...store].map(([id]) => id);
    handleClientMessage({ type: 'launchAgent' }, () => {}, ctx);
    expect(removedAfterLaunch, 'launchAgent must not invoke removeAgent').toHaveLength(0);
    expect(
      [...store].map(([id]) => id),
      'launchAgent must not change store membership',
    ).toEqual(agentIdsBefore);
  });

  // Regression net for new ClientMessage variants: any variant added to the
  // AsyncAPI contract that produces a server response (or a state change)
  // from a remote client must be explicitly added to REMOTE_ALLOWED_TYPES or
  // this test fails. The list below is the exhaustive ClientMessage union;
  // if you add a new variant upstream, regenerate messages.ts and update this
  // list, then decide whether the new variant belongs in the allowlist.
  it('allowlist is exhaustive: only webviewReady + requestDiagnostics reach handlers', () => {
    // Every ClientMessage `type` discriminator from core/src/messages.ts.
    const allClientMessageTypes = [
      'launchAgent',
      'focusAgent',
      'closeAgent',
      'saveAgentSeats',
      'saveLayout',
      'setSoundEnabled',
      'setLastSeenVersion',
      'setAlwaysShowLabels',
      'setHooksEnabled',
      'setHooksInfoShown',
      'setWatchAllSessions',
      'exportLayout',
      'importLayout',
      'openSessionsFolder',
      'addExternalAssetDirectory',
      'removeExternalAssetDirectory',
      'saveAreaMappings',
      'setShowAreas',
      'requestDiagnostics',
      'webviewReady',
    ];

    // Install a stub adapter so handler side effects are observable through
    // `sent` (the server replies) instead of touching real disk state —
    // keeps the test hermetic and makes "produced a response" observable.
    const { adapter, setSettingCalls, saveSeatsCalls } = stubAdapter();
    store.setAdapter(adapter);
    const runtime = stubRuntime(new Set<number>(), new Set<string>());

    const producedResponse = new Set<string>();
    let mutationOccurred = false;
    for (const type of allClientMessageTypes) {
      sent = [];
      setSettingCalls.length = 0;
      saveSeatsCalls.length = 0;
      handleClientMessage({ type }, (m) => sent.push(m), {
        ...freshCtx(false),
        runtime,
      });
      if (sent.length > 0) producedResponse.add(type);
      if (setSettingCalls.length > 0 || saveSeatsCalls.length > 0) mutationOccurred = true;
    }

    expect(
      producedResponse,
      'only webviewReady + requestDiagnostics may produce a response for remote clients',
    ).toEqual(new Set(['webviewReady', 'requestDiagnostics']));
    expect(mutationOccurred, 'no remote variant may mutate adapter state').toBe(false);
  });
});
