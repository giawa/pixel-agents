# Fix: Server-side palette/hueShift assignment for remote WebSocket clients

## Problem

Remote WebSocket clients (connecting to `--host 0.0.0.0`) experience agents with inconsistent palette/hueShift assignments:

1. Agent created on server with `palette: undefined` (for Claude agents)
2. Webview assigns random palette locally via `pickDiversePalette()`
3. Webview calls `saveAgentSeats()` to persist
4. **For remote clients**: `saveAgentSeats` is rejected (not in `REMOTE_ALLOWED_TYPES`)
5. Server's `AgentState` still has `palette: undefined`, seats file never updated
6. On reconnection, `existingAgents` sends empty `agentMeta` → webview assigns new random palette → agents change appearance

## Solution

Make the server the authority for palette/hueShift assignment. The server assigns these values at agent creation time and includes them in all broadcasts. Remote clients receive authoritative values and cannot change them.

**Out of scope**: Seat assignment (deferred to follow-up). Seats continue to be assigned by the webview and persisted via `saveAgentSeats` for local clients.

## Implementation Plan

### 1.1 Move `pickDiversePalette()` to core/

**File**: `core/src/paletteUtils.ts` (new)

Extract the palette diversity logic from `officeState.ts` into a pure function with no DOM/sprite dependencies. The server can call this with `paletteCount=6` and computed `paletteCounts` from its `AgentState` map.

```typescript
export interface PalettePick {
  palette: number;
  hueShift: number;
}

export const HUE_SHIFT_MIN_DEG = 45;
export const HUE_SHIFT_RANGE_DEG = 270;

export function pickDiversePalette(paletteCount: number, paletteCounts: number[]): PalettePick {
  const minCount = Math.min(...paletteCounts);
  const available: number[] = [];
  for (let i = 0; i < paletteCount; i++) {
    if (paletteCounts[i] === minCount) available.push(i);
  }
  const palette = available[Math.floor(Math.random() * available.length)];
  let hueShift = 0;
  if (minCount > 0) {
    hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG);
  }
  return { palette, hueShift };
}
```

**Update webview**: `webview-ui/src/office/engine/officeState.ts`

- Import `pickDiversePalette`, `HUE_SHIFT_MIN_DEG`, `HUE_SHIFT_RANGE_DEG` from `core/src/paletteUtils.ts`
- Remove local implementation and constants
- `pickDiversePalette()` method becomes a thin wrapper calling the shared function

### 1.2 Server assigns palette/hueShift at agent creation

**Helper function** in `server/src/paletteAssigner.ts` (new):

```typescript
import { pickDiversePalette } from '../../core/src/paletteUtils.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { AgentState } from './types.js';

const PALETTE_COUNT = 6;

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
```

**Files to update** (call `assignPaletteIfNeeded(agent, store)` after creating `AgentState`):

- `server/src/genericAgentHandler.ts` — after line 112 (Generic API, only when `event.palette` is undefined)
- `server/src/fileWatcher.ts` — after lines 881 and 962 (Claude agents: hooks-only and file-based adoption)
- `server/src/agentRuntime.ts` — after line 352 (restore on startup)

### 1.3 Update `existingAgents` to send palette/hueShift from `AgentState`

**File**: `server/src/clientMessageHandler.ts` (line 296-316)

**Current**:

```typescript
const seats = adapter?.loadSeats() ?? {};
send({
  type: 'existingAgents',
  agents: agentIds,
  agentMeta: seats, // from persisted file — empty for remote clients
  folderNames,
  externalAgents,
});
```

**New**:

```typescript
const persistedSeats = adapter?.loadSeats() ?? {};
const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
for (const [id, agent] of store) {
  const persisted = persistedSeats[String(id)];
  agentMeta[id] = {
    palette: agent.palette, // from AgentState (authoritative)
    hueShift: agent.hueShift, // from AgentState (authoritative)
    seatId: persisted?.seatId, // from persisted file (local clients only)
  };
}
send({
  type: 'existingAgents',
  agents: agentIds,
  agentMeta,
  folderNames,
  externalAgents,
});
```

### 1.4 Update `saveAgentSeats` to sync palette/hueShift to `AgentState`

**File**: `server/src/clientMessageHandler.ts` (line 126-132)

When a local client sends `saveAgentSeats` (e.g., after manual seat reassignment), the message includes the current palette/hueShift for all agents. We should sync these back to `AgentState` so that:

1. If a future UI allows palette/hueShift modification, the changes persist across reconnections
2. The server's `AgentState` stays consistent with the persisted file

**Current**:

```typescript
case 'saveAgentSeats':
  if (msg.seats) {
    adapter?.saveSeats(
      msg.seats as Record<string, { palette?: number; hueShift?: number; seatId?: string }>,
    );
  }
  break;
```

**New**:

```typescript
case 'saveAgentSeats':
  if (msg.seats) {
    const seats = msg.seats as Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
    // Sync palette/hueShift back to AgentState so existingAgents stays consistent
    for (const [idStr, meta] of Object.entries(seats)) {
      const id = Number(idStr);
      const agent = store.get(id);
      if (agent) {
        if (meta.palette !== undefined) agent.palette = meta.palette;
        if (meta.hueShift !== undefined) agent.hueShift = meta.hueShift;
      }
    }
    adapter?.saveSeats(seats);
  }
  break;
```

### 1.5 No webview changes needed

The webview already uses `msg.palette` and `msg.hueShift` from `agentCreated` (line 242-246). Once the server always provides these values, the webview's `addAgent()` receives `preferredPalette` and never calls `pickDiversePalette()` locally.

For `existingAgents`, the webview already reads `palette`/`hueShift` from `agentMeta` (line 284-288). The source change (from persisted file to `AgentState`) is transparent to the webview.

## Testing

### Unit tests

1. **`server/__tests__/paletteAssigner.test.ts`** (new): Test `assignPaletteIfNeeded()` — assigns when undefined, preserves when defined, distributes evenly
2. **`server/__tests__/genericAgentHandler.test.ts`**: Verify palette/hueShift are assigned for Generic API agents when not provided
3. **`server/__tests__/clientMessageHandler.test.ts`**: Verify `existingAgents` sends palette/hueShift from `AgentState`

### Verification

1. Start standalone server with `--host 0.0.0.0`
2. Connect remote browser client
3. Create agents via Generic API
4. Verify agents have consistent palette across page reloads
5. Verify local client can still manually reassign seats via `saveAgentSeats`

## Migration

No migration needed. Existing agents without `palette`/`hueShift` in `AgentState` will be assigned values on next reconnection (when `existingAgents` is rebuilt).

## Rollback

If issues arise, revert the commit. The change is backward-compatible — old webviews will still work with new servers (they'll just ignore the server-provided values and assign locally if undefined).

## Files to modify

### Core

- `core/src/paletteUtils.ts` (new)

### Server

- `server/src/paletteAssigner.ts` (new)
- `server/src/genericAgentHandler.ts` (call `assignPaletteIfNeeded`)
- `server/src/fileWatcher.ts` (call `assignPaletteIfNeeded`)
- `server/src/agentRuntime.ts` (call `assignPaletteIfNeeded`)
- `server/src/clientMessageHandler.ts` (update `existingAgents` to use `AgentState` for palette/hueShift; update `saveAgentSeats` to sync palette/hueShift back to `AgentState`)

### Webview

- `webview-ui/src/office/engine/officeState.ts` (import `pickDiversePalette` from core, remove local implementation)

### Tests

- `server/__tests__/paletteAssigner.test.ts` (new)
- `server/__tests__/genericAgentHandler.test.ts` (update)
- `server/__tests__/clientMessageHandler.test.ts` (update)
