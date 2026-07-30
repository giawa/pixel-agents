/**
 * Server-side palette assignment helper.
 *
 * Assigns palette and hueShift to agents when they're created, ensuring
 * consistent character appearance across all connected clients.
 */

import { pickDiversePalette } from '../../core/src/paletteUtils.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { AgentState } from './types.js';

const PALETTE_COUNT = 6;

/**
 * Assign palette and hueShift to an agent if not already set.
 * Uses the diversity algorithm to pick a palette that's least used among
 * existing agents.
 *
 * @param agent - The agent to assign a palette to (mutated in place)
 * @param store - The agent state store (used to count existing palettes)
 */
export function assignPaletteIfNeeded(agent: AgentState, store: AgentStateStore): void {
  if (agent.palette !== undefined) return;

  const paletteCounts = new Array(PALETTE_COUNT).fill(0);
  for (const existing of store.values()) {
    if (existing.palette !== undefined && existing.palette < PALETTE_COUNT) {
      paletteCounts[existing.palette]++;
    }
  }

  const pick = pickDiversePalette(PALETTE_COUNT, paletteCounts);
  agent.palette = pick.palette;
  agent.hueShift = pick.hueShift;
}
