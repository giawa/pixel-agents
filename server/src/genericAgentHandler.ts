/**
 * Generic Agent Handler
 *
 * Handles the Generic Agent API: allows any tool to drive the Pixel Agents
 * visualization by sending canonical events directly, bypassing provider-specific
 * normalization. Each client provides its own string agent ID.
 *
 * This handler manages:
 * - Agent creation/removal (sessionStart/sessionEnd)
 * - Tool activity tracking (toolStart/toolEnd)
 * - Turn completion (turnEnd)
 * - Permission requests (permissionRequest)
 */

import type { GenericAgentEvent } from '../../core/src/genericAgent.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from './constants.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState } from './types.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

/**
 * Handles generic agent events from external tools.
 * Maps client-provided string agent IDs to internal numeric IDs.
 */
export class GenericAgentHandler {
  /** Maps client string ID → internal numeric agent ID */
  private readonly agentIdMap = new Map<string, number>();

  constructor(
    private readonly store: AgentStateStore,
    private readonly runtime: AgentRuntime,
  ) {}

  /**
   * Handle an incoming generic agent event.
   * @param clientAgentId - Client-provided string identifier for the agent
   * @param event - The generic agent event
   */
  handleEvent(clientAgentId: string, event: GenericAgentEvent): void {
    if (debug) {
      console.log(`[Pixel Agents] Generic API: ${clientAgentId} -> ${event.kind}`);
    }

    switch (event.kind) {
      case 'sessionStart':
        return this.handleSessionStart(clientAgentId, event);
      case 'sessionEnd':
        return this.handleSessionEnd(clientAgentId);
      case 'toolStart':
        return this.handleToolStart(clientAgentId, event);
      case 'toolEnd':
        return this.handleToolEnd(clientAgentId, event);
      case 'turnEnd':
        return this.handleTurnEnd(clientAgentId, event);
      case 'permissionRequest':
        return this.handlePermissionRequest(clientAgentId);
    }
  }

  /**
   * Handle sessionStart: create a new agent if it doesn't exist.
   */
  private handleSessionStart(
    clientAgentId: string,
    event: Extract<GenericAgentEvent, { kind: 'sessionStart' }>,
  ): void {
    // Check if already exists
    if (this.agentIdMap.has(clientAgentId)) {
      if (debug) {
        console.log(
          `[Pixel Agents] Generic API: Agent "${clientAgentId}" already exists, ignoring sessionStart`,
        );
      }
      return;
    }

    const internalId = this.store.nextAgentId.current++;
    this.agentIdMap.set(clientAgentId, internalId);

    const agent: AgentState = {
      id: internalId,
      sessionId: `generic-${clientAgentId}`,
      terminalRef: undefined,
      isExternal: true,
      hooksOnly: true,
      hookDelivered: true,
      projectDir: event.cwd ?? '',
      jsonlFile: '',
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
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      folderName: event.agentName,
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      palette: event.palette,
      hueShift: event.hueShift,
    };

    assignPaletteIfNeeded(agent, this.store);

    this.store.set(internalId, agent);
    this.store.persist();

    // Register with runtime for hook event routing (uses generic session ID)
    this.runtime.registerAgent(agent.sessionId, internalId);

    if (debug) {
      console.log(
        `[Pixel Agents] Generic API: Created agent "${clientAgentId}" (internal ID ${internalId})`,
      );
    }
  }

  /**
   * Handle sessionEnd: remove the agent.
   */
  private handleSessionEnd(clientAgentId: string): void {
    const internalId = this.agentIdMap.get(clientAgentId);
    if (internalId === undefined) {
      if (debug) {
        console.log(
          `[Pixel Agents] Generic API: Agent "${clientAgentId}" not found, ignoring sessionEnd`,
        );
      }
      return;
    }

    const agent = this.store.get(internalId);
    if (agent) {
      // Dismiss the JSONL file (empty for hooks-only) so it doesn't get re-adopted
      this.runtime.dismissalTracker.dismiss(agent.jsonlFile);
      this.runtime.unregisterAgent(agent.sessionId);
      this.runtime.removeAgent(internalId);
    }

    this.agentIdMap.delete(clientAgentId);

    if (debug) {
      console.log(
        `[Pixel Agents] Generic API: Removed agent "${clientAgentId}" (internal ID ${internalId})`,
      );
    }
  }

  /**
   * Handle toolStart: mark agent as active and broadcast tool start.
   */
  private handleToolStart(
    clientAgentId: string,
    event: Extract<GenericAgentEvent, { kind: 'toolStart' }>,
  ): void {
    const internalId = this.agentIdMap.get(clientAgentId);
    if (internalId === undefined) {
      if (debug) {
        console.log(
          `[Pixel Agents] Generic API: Agent "${clientAgentId}" not found, ignoring toolStart`,
        );
      }
      return;
    }

    const agent = this.store.get(internalId);
    if (!agent) return;

    // Cancel waiting state
    cancelWaitingTimer(internalId, this.runtime.waitingTimers);
    cancelPermissionTimer(internalId, this.runtime.permissionTimers);
    agent.isWaiting = false;
    agent.permissionSent = false;
    agent.hadToolsInTurn = true;

    // Track the tool
    agent.activeToolIds.add(event.toolId);
    agent.activeToolNames.set(event.toolId, event.toolName);
    const status = event.status ?? event.toolName;
    agent.activeToolStatuses.set(event.toolId, status);

    // Broadcast to webview
    this.store.broadcast({
      type: 'agentToolStart',
      id: internalId,
      toolId: event.toolId,
      status,
      toolName: event.toolName,
    });

    this.store.broadcast({
      type: 'agentStatus',
      id: internalId,
      status: 'active',
    });
  }

  /**
   * Handle toolEnd: broadcast tool done and clear tool tracking.
   */
  private handleToolEnd(
    clientAgentId: string,
    event: Extract<GenericAgentEvent, { kind: 'toolEnd' }>,
  ): void {
    const internalId = this.agentIdMap.get(clientAgentId);
    if (internalId === undefined) return;

    const agent = this.store.get(internalId);
    if (!agent) return;

    // Clear tool tracking
    agent.activeToolIds.delete(event.toolId);
    agent.activeToolNames.delete(event.toolId);
    agent.activeToolStatuses.delete(event.toolId);

    this.store.broadcast({
      type: 'agentToolDone',
      id: internalId,
      toolId: event.toolId,
    });
  }

  /**
   * Handle turnEnd: mark agent as waiting.
   */
  private handleTurnEnd(
    clientAgentId: string,
    event: Extract<GenericAgentEvent, { kind: 'turnEnd' }>,
  ): void {
    const internalId = this.agentIdMap.get(clientAgentId);
    if (internalId === undefined) return;

    const agent = this.store.get(internalId);
    if (!agent) return;

    // Cancel timers
    cancelWaitingTimer(internalId, this.runtime.waitingTimers);
    cancelPermissionTimer(internalId, this.runtime.permissionTimers);

    // Clear foreground tools (preserve background agents)
    for (const toolId of [...agent.activeToolIds]) {
      if (agent.backgroundAgentToolIds.has(toolId)) continue;
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
    }
    this.store.broadcast({ type: 'agentToolsClear', id: internalId });

    // Re-send background agent tools
    for (const toolId of agent.backgroundAgentToolIds) {
      const status = agent.activeToolStatuses.get(toolId);
      if (status) {
        this.store.broadcast({
          type: 'agentToolStart',
          id: internalId,
          toolId,
          status,
        });
      }
    }

    agent.isWaiting = true;
    agent.permissionSent = false;
    agent.hadToolsInTurn = false;

    this.store.broadcast({
      type: 'agentStatus',
      id: internalId,
      status: 'waiting',
      awaitingInput: event.awaitingInput === true,
    });
  }

  /**
   * Handle permissionRequest: show permission bubble.
   */
  private handlePermissionRequest(clientAgentId: string): void {
    const internalId = this.agentIdMap.get(clientAgentId);
    if (internalId === undefined) return;

    const agent = this.store.get(internalId);
    if (!agent) return;

    cancelPermissionTimer(internalId, this.runtime.permissionTimers);
    agent.permissionSent = true;

    this.store.broadcast({
      type: 'agentToolPermission',
      id: internalId,
    });
  }

  /**
   * Clean up all agents. Called on shutdown.
   */
  dispose(): void {
    for (const clientAgentId of [...this.agentIdMap.keys()]) {
      this.handleSessionEnd(clientAgentId);
    }
    this.agentIdMap.clear();
  }
}
