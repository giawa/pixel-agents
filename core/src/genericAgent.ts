/**
 * Generic Agent API types.
 *
 * The Generic Agent API allows any tool to drive the Pixel Agents visualization
 * by sending canonical events directly, without going through provider-specific
 * normalization. Each client provides its own string agent ID and sends events
 * that map to the internal AgentEvent union.
 */

export type GenericAgentEvent =
  | GenericSessionStart
  | GenericSessionEnd
  | GenericToolStart
  | GenericToolEnd
  | GenericTurnEnd
  | GenericPermissionRequest;

export interface GenericSessionStart {
  kind: 'sessionStart';
  /** Display name for the agent (shown in UI). */
  agentName?: string;
  /** Working directory context (used for folder name). */
  cwd?: string;
  /** Preferred character palette (0-5). If undefined, auto-assigned for diversity. */
  palette?: number;
  /** Hue shift in degrees (0-360). Rotates the base palette colors. */
  hueShift?: number;
}

export interface GenericSessionEnd {
  kind: 'sessionEnd';
  /** Reason for ending (e.g., 'done', 'error'). */
  reason?: string;
}

export interface GenericToolStart {
  kind: 'toolStart';
  /** Unique identifier for this tool invocation. */
  toolId: string;
  /** Tool name (e.g., 'Build', 'Test', 'Deploy'). */
  toolName: string;
  /** Human-readable status to display (e.g., "Compiling..."). */
  status?: string;
}

export interface GenericToolEnd {
  kind: 'toolEnd';
  /** Same toolId from the corresponding toolStart. */
  toolId: string;
}

export interface GenericTurnEnd {
  kind: 'turnEnd';
  /** True if agent is waiting for user input, false if just finished. */
  awaitingInput?: boolean;
}

export interface GenericPermissionRequest {
  kind: 'permissionRequest';
}
