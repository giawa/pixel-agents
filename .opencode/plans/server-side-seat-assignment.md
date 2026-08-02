# Fix: Server-side seat assignment for consistent remote client experience

## Problem

Remote WebSocket clients (connecting to `--host 0.0.0.0`) and any webview connecting
before a server has assigned seating experience agents with inconsistent seats:

1. Agent created on server with `seatId: undefined`.
2. Webview assigns seat locally via `findFreeSeat()` (3-stage area-aware picker with
   electronics bias).
3. Webview calls `saveAgentSeats()` to persist.
4. **For remote clients**: `saveAgentSeats` is rejected (only `webviewReady` and
   `requestDiagnostics` are in `REMOTE_ALLOWED_TYPES`, `clientMessageHandler.ts:64`).
5. Server's `AgentState` has no `seatId`, seats file never updated.
6. On reconnection, `existingAgents` reads `seatId` from the persisted seats file and
   the webview falls back to `findFreeSeat()` → agents jump around.

**Pre-existing obstacles** the original plan understated (verified against current code):

- `AgentState` (`server/src/types.ts:3-67`) has **no `seatId` field** today. Seats
  live separately in the seats file as `AgentMeta = {palette, hueShift, seatId}`
  (`core/src/schemas.ts:34-38`), only writable by webviews via `adapter.saveSeats()`.
- `AgentRuntime` (`server/src/agentRuntime.ts:76-79`) constructor only accepts
  `(store, provider)` — no `assetCache`, no layout handle, no `SeatManager`.
- VS Code's `PixelAgentsViewProvider.ts:103-171` registers its `store.on('agentAdded')`
  broadcast listener at **line 109** but constructs `new AgentRuntime(...)` at **line
  168**. EventEmitter fires in subscription order — so any SeatManager subscribed
  inside the runtime ctor would fire _after_ the broadcast, leaving `agent.seatId`
  undefined at broadcast time. **Requires reordering in VS Code.**
- AsyncAPI `AgentCreated` (`core/asyncapi.yaml:179-192`) is `additionalProperties: false`
  with only `type, id, folderName?, isExternal?`. The implementation already sends 6
  extra fields (`palette, hueShift, teamName, teammateName, parentAgentId, isTeammate,
hooksOnly`) from both surfaces without the contract — pre-existing drift not addressed
  by this PR.
- `layoutToSeats()` lives in `webview-ui/src/office/layout/layoutSerializer.ts:165` and
  calls the **module-global** `getCatalogEntry()` (`furnitureCatalog.js:11`) — a
  webview-ui module. Per layering, neither `core/` nor `server/` can reach it.

## Solution

**Authority model**: The server (shared `AgentRuntime` consumed by both VS Code's
embedded `PixelAgentsServer` and the standalone CLI) is the only assigning authority
for new agents at creation time. Localhost webviews keep the manual drag-reassign UI
(only they can call `saveAgentSeats`, already enforced today). Remote viewers are
read-only by the existing gate.

**Persistence is free**: the seats file already durably persists `seatId` alongside
palette/hueShift. We move the _initial write_ of seatId from the webview to the server.
`PersistedAgent` (identity only) is untouched.

- Agent created → SeatManager assigns → writes `agent.seatId` on AgentState → `adapter.saveSeats()` persists.
- Localhost drag-reassign → webview `saveAgentSeats` → handler syncs AgentState + SeatManager occupancy → `adapter.saveSeats()`.
- Remote viewer → cannot write.
- Server restart → `existingAgents` rehydrates AgentState from seats file (as today); SeatManager rebuilds occupancy by walking restored agents.

## Scope decisions (locked)

- **Both VS Code and standalone** get server-authority (not standalone-only).
- **SeatManager lives in `AgentRuntime`** — shared by both surfaces.
- **AsyncAPI**: add only `seatId` to `AgentCreated`. The 6 pre-existing drifted fields
  are out of scope (separate cleanup).
- **Webview keeps its runtime-built `furnitureCatalog`** and passes it as a `catalogMap`.
  No catalog build in `core/`.

## Implementation Plan

### Phase 1 — Extract `layoutToSeats()` to core/

**File**: `core/src/layout/seats.ts` (new)

Pure module — no webview-ui imports. The webview keeps `getSeatTiles()` local but stops
re-exporting it.

```typescript
// core/src/layout/seats.ts

export const Direction = { DOWN: 0, LEFT: 1, RIGHT: 2, UP: 3 } as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export interface Seat {
  uid: string;
  seatCol: number;
  seatRow: number;
  facingDir: Direction;
}

/** Minimal catalog entry fields needed for seat computation */
export interface SeatCatalogEntry {
  category: string;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  orientation?: string;
  backgroundTiles?: number;
}

function orientationToFacing(orientation: string): Direction {
  switch (orientation) {
    case 'front':
      return Direction.DOWN;
    case 'back':
      return Direction.UP;
    case 'left':
      return Direction.LEFT;
    case 'right':
    case 'side':
      return Direction.RIGHT;
    default:
      return Direction.DOWN;
  }
}

/**
 * Generate seats from chair furniture in the layout.
 * Facing priority: 1) chair orientation, 2) adjacent desk, 3) forward (DOWN).
 */
export function layoutToSeats(
  furniture: Array<{ type: string; uid: string; col: number; row: number }>,
  catalogMap: Map<string, SeatCatalogEntry>,
): Map<string, Seat> {
  const seats = new Map<string, Seat>();
  const deskTiles = new Set<string>();
  for (const item of furniture) {
    const entry = catalogMap.get(item.type);
    if (!entry || !entry.isDesk) continue;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        deskTiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }
  const dirs = [
    { dc: 0, dr: -1, facing: Direction.UP },
    { dc: 0, dr: 1, facing: Direction.DOWN },
    { dc: -1, dr: 0, facing: Direction.LEFT },
    { dc: 1, dr: 0, facing: Direction.RIGHT },
  ];
  for (const item of furniture) {
    const entry = catalogMap.get(item.type);
    if (!entry || entry.category !== 'chairs') continue;
    let seatCount = 0;
    const bgRows = entry.backgroundTiles ?? 0;
    for (let dr = bgRows; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const tileCol = item.col + dc;
        const tileRow = item.row + dr;
        let facingDir: Direction = Direction.DOWN;
        if (entry.orientation) {
          facingDir = orientationToFacing(entry.orientation);
        } else {
          for (const d of dirs) {
            if (deskTiles.has(`${tileCol + d.dc},${tileRow + d.dr}`)) {
              facingDir = d.facing;
              break;
            }
          }
        }
        const seatUid = seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`;
        seats.set(seatUid, { uid: seatUid, seatCol: tileCol, seatRow: tileRow, facingDir });
        seatCount++;
      }
    }
  }
  return seats;
}
```

**Webview update** — `webview-ui/src/office/layout/layoutSerializer.ts`:

- Import `layoutToSeats`, `Direction`, `Seat` from `core/src/layout/seats.ts`.
- Remove local `orientationToFacing()`.
- Build `catalogMap` at the call site from the runtime-built `furnitureCatalog`
  (`buildDynamicCatalog()` populates it; webview keeps its catalog build unchanged).
- Drop the re-export of `getSeatTiles` from `layout/index.ts:7` (mark unexported cleanup).

### Phase 2 — Server SeatManager

**File**: `server/src/seatManager.ts` (new)

```typescript
// server/src/seatManager.ts

import { layoutToSeats, type Seat, type SeatCatalogEntry } from '../../core/src/layout/seats.js';
import type { AssetCache } from './clientMessageHandler.js';
import type { PlacedFurniture } from '../../core/src/schemas.js';
import { readLayoutFromFile, watchLayoutFile, type LayoutWatcher } from './layoutPersistence.js';
import { readConfig } from './configPersistence.js';

export class SeatManager {
  private seats = new Map<string, Seat>();
  private occupancy = new Map<string, number>(); // seatId → agentId
  private catalogMap = new Map<string, SeatCatalogEntry>();
  private areaMappings: Record<string, string[]> = {};
  private layoutWatcher: LayoutWatcher | null = null;

  constructor(private readonly assetCache: AssetCache | null) {
    this.buildCatalogMap();
    this.loadLayout();
    this.loadAreaMappings();
    this.startWatching();
  }

  private buildCatalogMap(): void {
    this.catalogMap.clear();
    if (!this.assetCache?.furniture) return;
    for (const a of this.assetCache.furniture.catalog) {
      this.catalogMap.set(a.id, {
        category: a.category,
        footprintW: a.footprintW,
        footprintH: a.footprintH,
        isDesk: a.isDesk,
        orientation: a.orientation,
        backgroundTiles: a.backgroundTiles,
      });
    }
  }

  private loadLayout(): void {
    const layout = readLayoutFromFile();
    if (!layout) return;
    this.seats = layoutToSeats((layout.furniture as PlacedFurniture[]) ?? [], this.catalogMap);
    // Re-validate occupancy: drop seats that no longer exist
    for (const seatId of this.occupancy.keys()) {
      if (!this.seats.has(seatId)) this.occupancy.delete(seatId);
    }
  }

  private loadAreaMappings(): void {
    this.areaMappings = readConfig().standalone.areaMappings ?? {};
  }

  private startWatching(): void {
    this.layoutWatcher = watchLayoutFile(() => this.loadLayout());
  }

  /** Reapply persisted seatIds after a cold restart.
   *  Walks restored agents and re-marks their seats as occupied. */
  rehydrateOccupancy(entries: Array<{ agentId: number; seatId: string | null }>): void {
    for (const { agentId, seatId } of entries) {
      if (seatId && this.seats.has(seatId)) this.occupancy.set(seatId, agentId);
    }
  }

  /** Assign a seat to an agent. Returns seatId or null. */
  assignSeat(agentId: number, folderName?: string): string | null {
    const seatId = this.findFreeSeat(folderName);
    if (seatId) this.occupancy.set(seatId, agentId);
    return seatId;
  }

  releaseSeat(agentId: number): void {
    for (const [seatId, id] of this.occupancy) {
      if (id === agentId) {
        this.occupancy.delete(seatId);
        return;
      }
    }
  }

  /** Reassign — release current, claim new. Caller must persist afterward. */
  reassignSeat(agentId: number, newSeatId: string, _folderName?: string): void {
    this.releaseSeat(agentId);
    this.occupancy.set(newSeatId, agentId);
  }

  /** 2-stage seat picker: Areas mapping first, any free seat second.
   *  Keeps folderName-aware selection (does NOT regress the webview's fallback). */
  private findFreeSeat(folderName?: string): string | null {
    const free = [...this.seats.keys()].filter((uid) => !this.occupancy.has(uid));
    if (free.length === 0) return null;
    const labels = folderName ? this.areaMappings[folderName] : undefined;
    if (labels?.length) {
      const wanted = new Set(labels);
      // TODO: cross-reference areaTiles[] from layout to filter seats spatially
      // (deferred — kept simple for v1; behaves like stage 2 below)
      void wanted;
    }
    return free[Math.floor(Math.random() * free.length)];
  }

  dispose(): void {
    this.layoutWatcher?.dispose();
  }
}
```

**Simplifications (vs. webview `findFreeSeat`)**:

- **No electronics bias**: visual nicety, skipped.
- **AreaTiles cross-reference**: stubbed for v1; revisit if needed. The plan does not
  regress webview local fallback — the webview's `findFreeSeat(folderName)` keeps its
  existing behavior.

### Phase 3 — Wire SeatManager into AgentRuntime

**`server/src/types.ts`** — add to `AgentState`:

```typescript
seatId?: string;
```

**`server/src/agentRuntime.ts`**:

- Constructor accepts `assetCache?: AssetCache | null`.
- Constructs + owns a `SeatManager` from `assetCache`.
- **Subscribes SeatManager to `store.on('agentAdded')` during construction**
  (before broadcast listeners — see Phase 4 reordering).
- On `agentAdded`: `const seatId = seatManager.assignSeat(id, agent.folderName); agent.seatId = seatId; adapter.saveSeats(...)`.
- On `agentRemoved`: `seatManager.releaseSeat(id)`.
- On `restoreExternalAgents` (`:339-419`): after `store.set`, call
  `seatManager.rehydrateOccupancy(restoredAgents.map(a => ({agentId: a.id, seatId: a.seatId ?? null})))`
  so subsequent new agents don't collide with restored seats.

**Standalone**: `cli.ts:136` already constructs runtime before `httpServer.start()`
subscribes its broadcast listeners at `httpServer.ts:221-223` — no ordering fix needed.

**VS Code**: see Phase 4 — `PixelAgentsViewProvider.ts` ctor order must be adjusted.

### Phase 4 — Surface parity (VS Code + standalone)

**`adapters/vscode/PixelAgentsViewProvider.ts:103-171`** — reorder constructor:
move the three `store.on('agentAdded'/'agentRemoved'/'broadcast')` subscriptions
(lines 109-129) to **after** `this.runtime = new AgentRuntime(...)` (line 168), so
the runtime's SeatManager listener fires first.

**`adapters/vscode/PixelAgentsViewProvider.ts:291-294`** (`saveAgentSeats`) — mirror
standalone (`clientMessageHandler.ts:126-143`):

```typescript
case 'saveAgentSeats': {
  const seats = message.seats as Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
  for (const [idStr, meta] of Object.entries(seats)) {
    const id = Number(idStr);
    const agent = this.store.get(id);
    if (agent) {
      if (meta.palette !== undefined) agent.palette = meta.palette;
      if (meta.hueShift !== undefined) agent.hueShift = meta.hueShift;
      if (meta.seatId !== undefined && meta.seatId !== agent.seatId) {
        this.runtime.seatManager.reassignSeat(id, meta.seatId, agent.folderName);
        agent.seatId = meta.seatId;
      }
    }
  }
  // Reap orphan seat entries (ids no longer in AgentState)
  const live = new Set(this.store.getAllIds().map(String));
  for (const idStr of Object.keys(seats)) if (!live.has(idStr)) delete seats[idStr];
  this.adapter.saveSeats(seats);
  break;
}
```

(Exposes `seatManager` on `AgentRuntime` for the surface to reach.)

**`adapters/vscode/agentManager.ts:517-518`** — VS Code `existingAgents`: stop pulling
`seatId` from `adapter.loadSeats()`; read it from `AgentState` (palette/hueShift stay
in the seats file as the durable store for cold start; during a live session AgentState
is authoritative).

**`server/src/clientMessageHandler.ts:308-334`** — standalone `existingAgents`: read
`seatId` from `agent.seatId` (AgentState) instead of `persisted?.seatId`.
Palette/hueShift stay as-is.

**`server/src/httpServer.ts:197-211`** and **`adapters/vscode/PixelAgentsViewProvider.ts:109-122`**:
add `seatId: agent.seatId` to the `agentCreated` broadcast.

### Phase 5 — Webview consume

**`webview-ui/src/hooks/useExtensionMessages.ts:244`** (and teammate branch at line 232):

```typescript
const seatId = msg.seatId as string | undefined;
os.addAgent(id, palette, hueShift, seatId, undefined, folderName);
```

Webview keeps its existing `findFreeSeat(folderName)` fallback at
`officeState.ts:416-418` as a safety net for invalid/occupied server seats.

Drag-to-reassign UI unchanged — only localhost can call `saveAgentSeats`
(already enforced).

### Phase 6 — Contract & cleanup

- **AsyncAPI** (`core/asyncapi.yaml`): add only `seatId?: string` to `AgentCreated`,
  regenerate via `npm run asyncapi:generate`. Confirm `git diff --exit-code core/src/messages.ts`
  is clean. The pre-existing 6 drifted fields stay out of scope — they're a separate
  contract-reconciliation issue.
- **Orphan reapening**: `saveAgentSeats` handlers drop seat entries for agent ids no
  longer in AgentState (see Phase 4 code). Prevents id-recycled ghost assignments.
- **Tests**:
  - `core/src/layout/__tests__/seats.test.ts` (new) — `layoutToSeats` with mock
    furniture/catalog, facing priority, backgroundTiles skipping.
  - `server/__tests__/seatManager.test.ts` (new) — assign/release/reassign/occupancy
    rehydrate, layout-change re-validate.
  - Extend `server/__tests__/clientMessageHandler.test.ts` — seatId in `agentCreated`
    broadcast and `existingAgents` (read from AgentState).
  - Extend `server/__tests__/agentStateStore.test.ts` — listener ordering (SeatManager
    subscriber runs before broadcast subscriber).

## Out of scope

- VS Code + standalone running side-by-side against the same layout: each has its own
  embedded `AgentRuntime` + own `SeatManager` + own namespace seats file, so collisions
  remain per-namespace-isolated (same as today, not made worse).
- "Reassign seat via external API" — future enhancement.
- Reconciling the 6 pre-existing drifted `agentCreated` fields — separate PR.
- Moving catalog building into `core/` — webview keeps its runtime catalog.

## Verification

1. `npm run compile` — asyncapi drift clean, types clean, esbuild clean.
2. `npm test` — new unit tests green.
3. Manual: start `npx pixel-agents --host 0.0.0.0`, connect a remote browser, create
   agents via the Generic API → agents get assigned seats from server; reload page →
   agents keep their seats; from localhost, drag-reassign still works; remote drag is
   silently ignored (already enforced).
4. Manual: in VS Code, run an extension dev host — agents get seats assigned by the
   runtime; manual drag-reassign persists; reload window → seats stable from seats file.

## Rollback

Revert the commit. The change is backward-compatible — old webviews ignore `msg.seatId`
and fall back to `findFreeSeat()`; old servers sending `agentCreated` without `seatId`
make the new webview fall back the same way.

## Files to modify

### Core

- `core/src/layout/seats.ts` (new) — `Direction`, `Seat`, `SeatCatalogEntry`,
  `orientationToFacing`, `layoutToSeats`.

### Server

- `server/src/seatManager.ts` (new).
- `server/src/types.ts` — add `seatId?: string` to `AgentState`.
- `server/src/agentRuntime.ts` — accept `assetCache?`, construct + own SeatManager,
  subscribe before broadcasts, hydrate occupancy on restore.
- `server/src/cli.ts` — pass `assetCache` to `AgentRuntime`.
- `server/src/httpServer.ts` — include `seatId` in `agentCreated` broadcast.
- `server/src/clientMessageHandler.ts` — read `seatId` from AgentState in
  `existingAgents`; orphan reapening in `saveAgentSeats`.

### VS Code adapter

- `adapters/vscode/PixelAgentsViewProvider.ts` — reorder ctor subscriptions after
  runtime construction; `agentCreated` broadcast adds `seatId`; `saveAgentSeats` syncs
  AgentState + SeatManager + reaps orphans.
- `adapters/vscode/agentManager.ts` — `existingAgents` reads `seatId` from AgentState.

### Webview

- `webview-ui/src/office/layout/layoutSerializer.ts` — import shared `layoutToSeats`,
  build `catalogMap` from runtime catalog, remove local `orientationToFacing`,
  un-export `getSeatTiles`.
- `webview-ui/src/office/layout/index.ts` — drop `getSeatTiles` re-export.
- `webview-ui/src/hooks/useExtensionMessages.ts` — pass `msg.seatId` to `os.addAgent`.

### Contract

- `core/asyncapi.yaml` — add `seatId?: string` to `AgentCreated`.
- `core/src/messages.ts` — regenerated (CI drift check).

### Tests

- `core/src/layout/__tests__/seats.test.ts` (new).
- `server/__tests__/seatManager.test.ts` (new).
- `server/__tests__/clientMessageHandler.test.ts` (extend).
- `server/__tests__/agentStateStore.test.ts` (extend — listener ordering).
