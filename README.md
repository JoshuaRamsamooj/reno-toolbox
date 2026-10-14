# Reno Toolbox: floor plans for material estimating

A browser-based floor plan editor that serves as the foundation for estimating
renovation materials (flooring, drywall, insulation, trim, paint). You draw
the plan quickly and the tool works out rooms, wall faces, openings and
ceiling surfaces, then produces quantities from them.

```bash
npm install
npm start            # http://127.0.0.1:3000
npm test             # unit + API tests (node:test)
```

Requires Node 22.13+ (uses the built-in `node:sqlite`, so there are no native
modules to compile). Environment variables: `PORT` (default 3000), `HOST`
(default 127.0.0.1), `RENO_DB` (default `data/reno-toolbox.db`).

## Drawing

| Tool | Key | How |
|------|-----|-----|
| Room | R | Drag a rectangle, or click a corner and type the **interior** size (`12x10`, `12'6" x 10'`, `3.6x4.2`) + Enter. Start a room on an existing corner and the shared wall merges. |
| Wall | W | Click corners. Type a length (`8'6`, `96"`, `2.4`, `2400mm`) + Enter to place an exact wall in the direction of the mouse. Snaps to 45° (hold Shift for any angle), to corners, to walls and to alignment with other corners. Ending on a wall or corner joins it and finishes the chain. Esc/Enter/double-click also finish. |
| Door / Window / Opening | D / N / O | Click on a wall. While placing, the distances to the wall ends are shown. |
| Select | V | Click to select; Shift+click adds or removes. Drag a box over empty floor to select several: left→right picks walls/openings fully inside, right→left picks anything the box touches. Ctrl+A selects everything. Drag corners, walls (perpendicular) or openings (along their wall). Del deletes the whole selection in one undoable step. Double-click focuses the main field in the inspector. |

Other controls: pan by right-dragging, with the middle mouse button or by holding Space; zoom with the
scroll wheel; F fits the plan; Ctrl+Z / Ctrl+Shift+Z undo and redo; Ctrl+S saves.

Rooms are **detected automatically** from enclosed areas, so you never have
to define them by hand. Drawing a wall across a room splits it, and deleting
a dividing wall merges the rooms. Room names and ceiling settings carry over
through these edits.

The inspector edits the selection:
- **Room:** name; ceiling profile (flat, shed, cathedral/gable, tray) with
  heights, slope or ridge direction, and tray depth/inset; flooring and crown
  moulding toggles; bulkheads; the list of interior wall faces.
- **Bulkheads** (in the room inspector): a dropped box along one wall with a
  depth into the room, an underside height (defaults to 12"/300 mm below the
  ceiling and follows it), and an optional start/length along the wall. Use
  several for L-shaped runs. They appear as hatched bands on every elevation
  wall they touch, as dashed boxes on the plan, and in the takeoff: hidden
  wall area is removed from the wall finish (insulation behind is kept), and
  the soffit, front face and open end caps are added to drywall and paint,
  plus corner bead for the outside edges.
- **Multiple selection:** counts by type, bulk thickness and wall-type
  edits, and delete all.
- **Wall:** centreline length or the interior face length on either side.
  Changing a length *stretches* the plan beyond end B, so rectangles stay
  rectangular. Also thickness and the exterior/interior override.
- **Opening:** type, width, height, sill, gaps to the wall ends, and door
  hinge/swing flip.
- **Nothing selected:** default wall thickness, default ceiling height, and
  the dimension display (interior faces, centrelines or hidden).

Units can be switched between imperial and metric at any time. All geometry is
stored in millimetres; only the display changes.

## Views

- **Plan:** top-down drawing with interior dimensions for every wall face,
  room areas, ceiling markers (ridge line, slope arrow, tray outline) and door
  swings.
- **Elevations:** each wall face of the selected room as seen from inside,
  at a shared scale. Shows the ceiling profile (peaks and slopes), openings
  with sizes, sill heights, chain and overall dimensions, and a key plan.
  Printable.
- **Takeoff:** per-room quantities (floor, perimeter, gross/net wall area,
  exterior wall area, ceiling surface, baseboard, casing, opening counts), a
  first-pass material list with waste factors, and CSV export.

## Saving

Designs are saved to a local SQLite database through a small REST API
(`GET/POST /api/designs`, `GET/PUT/DELETE /api/designs/:id`), each with an
SVG thumbnail. The working copy is also autosaved to `localStorage`, so a
reload never loses work. Plans can be exported and imported as JSON.

## Architecture

```
server/            Express app + node:sqlite repository
public/js/core/    Pure, DOM-free logic (shared by the browser and the tests)
  geometry.js      vectors, polygons, offsets
  units.js         imperial/metric parsing & formatting
  model.js         planar wall graph, normalisation, face/room detection, edit ops
  ceiling.js       ceiling profiles → height field, wall-top profiles, surface area
  bulkhead.js      bulkhead footprints, covered wall bands, finished surfaces
  takeoff.js       quantities and material list
public/js/ui/      SVG plan editor, elevations, inspector, takeoff view
test/              node:test suites for core logic and the API
```

### Data model

A design is a planar graph: `nodes` (points, in mm) joined by `walls`
(centrelines with thickness). `openings` sit on a wall at an `offset` from
its start node. `rooms` hold only user metadata (name, ceiling, finishes) and
are matched to the graph's faces on every edit, first by wall set and then by
an anchor point. After each edit, `normalize()` keeps the graph planar: it
splits walls at T-junctions and crossings, merges duplicate and collinear
segments, and re-homes openings.

`analyze(design)` is the single source of derived data. For each room it
returns the interior polygon (centrelines offset by half the wall thickness)
and the merged wall faces with their openings and exterior spans. The
elevation and takeoff views build on top of it.

### Extending the estimate

`computeTakeoff()` returns raw quantities per room in mm/mm². To add a
material (studs, flooring underlayment, tile, and so on), derive it from
these quantities in `materialList()`, or use `analyze()` /
`roomElevations()` directly when you need per-wall geometry. Estimate
settings live in `design.estimate` and are merged with defaults by
`resolveEstimate()`.
