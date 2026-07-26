import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { AgentRuntime } = await import('../src/agentRuntime.js');
const { GenericAgentHandler } = await import('../src/genericAgentHandler.js');
const { claudeProvider } = await import('../src/providers/index.js');

async function postGenericEvent(
  port: number,
  token: string,
  agentId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/agents/${agentId}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe('Generic Agent API', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  let store: InstanceType<typeof AgentStateStore>;
  let runtime: InstanceType<typeof AgentRuntime>;
  let handler: InstanceType<typeof GenericAgentHandler>;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-generic-test-'));
    const serverJsonDir = path.join(tmpBase, '.pixel-agents');
    fs.mkdirSync(serverJsonDir, { recursive: true });

    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    handler = new GenericAgentHandler(store, runtime);
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    handler?.dispose();
    runtime?.dispose();
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('generic endpoint requires auth', async () => {
    const config = await server.start({ store, runtime });
    const res = await fetch(`http://127.0.0.1:${config.port}/api/agents/test-agent/events`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'sessionStart' }),
    });
    expect(res.status).toBe(401);
  });

  it('generic endpoint accepts valid auth', async () => {
    const config = await server.start({ store, runtime });
    server.onGenericAgentEvent((agentId, event) => {
      handler.handleEvent(agentId, event);
    });

    const res = await postGenericEvent(config.port, config.token, 'test-agent', {
      kind: 'sessionStart',
      agentName: 'Test Agent',
    });
    expect(res.status).toBe(200);
  });

  it('generic callback fires on valid event', async () => {
    const config = await server.start({ store, runtime });
    const received: Array<{ agentId: string; event: Record<string, unknown> }> = [];
    server.onGenericAgentEvent((agentId: string, event) => {
      received.push({ agentId, event: event as unknown as Record<string, unknown> });
    });

    await postGenericEvent(config.port, config.token, 'my-agent', {
      kind: 'sessionStart',
      agentName: 'My Agent',
    });

    expect(received).toHaveLength(1);
    expect(received[0].agentId).toBe('my-agent');
    expect(received[0].event.kind).toBe('sessionStart');
  });

  it('creates agent on sessionStart', async () => {
    const config = await server.start({ store, runtime });
    server.onGenericAgentEvent((agentId, event) => {
      handler.handleEvent(agentId, event);
    });

    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'sessionStart',
      agentName: 'Agent One',
      cwd: '/workspace',
    });

    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
    expect(agent.folderName).toBe('Agent One');
    expect(agent.isExternal).toBe(true);
    expect(agent.hooksOnly).toBe(true);
  });

  it('removes agent on sessionEnd', async () => {
    const config = await server.start({ store, runtime });
    server.onGenericAgentEvent((agentId, event) => {
      handler.handleEvent(agentId, event);
    });

    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'sessionStart',
      agentName: 'Agent One',
    });
    expect(store.size).toBe(1);

    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'sessionEnd',
      reason: 'done',
    });
    expect(store.size).toBe(0);
  });

  it('handles toolStart and toolEnd', async () => {
    const config = await server.start({ store, runtime });
    server.onGenericAgentEvent((agentId, event) => {
      handler.handleEvent(agentId, event);
    });

    const broadcasts: Record<string, unknown>[] = [];
    store.on('broadcast', (msg) => broadcasts.push(msg));

    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'sessionStart',
      agentName: 'Agent One',
    });

    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'toolStart',
      toolId: 'tool-1',
      toolName: 'Build',
      status: 'Compiling...',
    });

    const toolStartMsg = broadcasts.find((m) => m.type === 'agentToolStart');
    expect(toolStartMsg).toBeDefined();
    expect(toolStartMsg?.toolId).toBe('tool-1');
    expect(toolStartMsg?.toolName).toBe('Build');
    expect(toolStartMsg?.status).toBe('Compiling...');

    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'toolEnd',
      toolId: 'tool-1',
    });

    const toolDoneMsg = broadcasts.find((m) => m.type === 'agentToolDone');
    expect(toolDoneMsg).toBeDefined();
    expect(toolDoneMsg?.toolId).toBe('tool-1');
  });

  it('handles turnEnd', async () => {
    const config = await server.start({ store, runtime });
    server.onGenericAgentEvent((agentId, event) => {
      handler.handleEvent(agentId, event);
    });

    const broadcasts: Record<string, unknown>[] = [];
    store.on('broadcast', (msg) => broadcasts.push(msg));

    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'sessionStart',
      agentName: 'Agent One',
    });

    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'turnEnd',
      awaitingInput: true,
    });

    const statusMsg = broadcasts.find((m) => m.type === 'agentStatus');
    expect(statusMsg).toBeDefined();
    expect(statusMsg?.status).toBe('waiting');
    expect(statusMsg?.awaitingInput).toBe(true);
  });

  it('handles permissionRequest', async () => {
    const config = await server.start({ store, runtime });
    server.onGenericAgentEvent((agentId, event) => {
      handler.handleEvent(agentId, event);
    });

    const broadcasts: Record<string, unknown>[] = [];
    store.on('broadcast', (msg) => broadcasts.push(msg));

    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'sessionStart',
      agentName: 'Agent One',
    });

    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'permissionRequest',
    });

    const permMsg = broadcasts.find((m) => m.type === 'agentToolPermission');
    expect(permMsg).toBeDefined();
  });

  it('ignores events for unknown agent', async () => {
    const config = await server.start({ store, runtime });
    server.onGenericAgentEvent((agentId, event) => {
      handler.handleEvent(agentId, event);
    });

    const res = await postGenericEvent(config.port, config.token, 'unknown-agent', {
      kind: 'toolStart',
      toolId: 'tool-1',
      toolName: 'Build',
    });

    expect(res.status).toBe(200);
    expect(store.size).toBe(0);
  });

  it('ignores duplicate sessionStart', async () => {
    const config = await server.start({ store, runtime });
    server.onGenericAgentEvent((agentId, event) => {
      handler.handleEvent(agentId, event);
    });

    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'sessionStart',
      agentName: 'Agent One',
    });
    await postGenericEvent(config.port, config.token, 'agent-1', {
      kind: 'sessionStart',
      agentName: 'Agent One Again',
    });

    expect(store.size).toBe(1);
  });

  it('rejects invalid agent ID format', async () => {
    const config = await server.start({ store, runtime });
    const res = await postGenericEvent(config.port, config.token, 'invalid agent!', {
      kind: 'sessionStart',
    });
    expect(res.status).toBe(400);
  });
});
