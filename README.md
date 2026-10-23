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
| Pan | P | Drag anywhere to move around the plan. |
| Trim | T | Hover the side of a wall and click to open that face in the trim editor (see below). |
| Level | L | Survey a room's subfloor and plan the leveling (see below). |

Other controls: pan with the Pan tool (P), by right-dragging, with the middle mouse button or by holding Space; zoom with the
scroll wheel; F fits the plan; Ctrl+Z / Ctrl+Shift+Z undo and redo; Ctrl+S saves.

The plan and the wall face editor share one drawing canvas: rulers along the
top and left (with the cursor marked), an adaptive grid down to 1/16" or
1 mm, snap guides, and a bar with **Snap (S)**, **Grid (G)**, zoom − / + and
**Fit**. With snapping off, points round to 1/16" or 1 mm only.

Assigned trim shows on the plan: baseboard as a solid band along the floor
line and crown (including tray crown) as a dashed band at its projection,
each mitred where runs meet at a corner and stopped square at door gaps.
Cased doors and windows show their casing legs beside the jambs (on the side
of the wall the casing is on), and windows their stool or sill. "Show trim on
the plan" turns this off.

Rooms are **detected automatically** from enclosed areas, so you never have
to define them by hand. Drawing a wall across a room splits it, and deleting
a dividing wall merges the rooms. Room names and ceiling settings carry over
through these edits.

The inspector edits the selection:
- **Room:** name; ceiling profile (flat, shed, cathedral/gable, tray) with
  heights, slope or ridge direction, and tray depth/inset; flooring toggle;
  bulkheads; trim for the room's faces; the list of interior wall faces.
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
  rectangular. Also thickness, the exterior/interior override, and an
  "Edit trim" button for each side of the wall.
- **Opening:** type, width, height, sill, gaps to the wall ends, and door
  hinge/swing flip.
- **Nothing selected:** default wall thickness, default ceiling height, the
  dimension display (interior faces, centrelines or hidden), and whether
  trimmed wall faces are marked on the plan ("Show trim on the plan").

Units can be switched between imperial and metric at any time. All geometry is
stored in millimetres; only the display changes.

## Trim and panelling

Trim belongs to a **wall face**: one side of a wall run. A wall between a
kitchen and a hallway has two faces with independent trim, and exterior
walls have an interior face and an exterior face. Only quantities are
estimated (linear feet/metres, area, sheet count); there is no pricing.

Open a face with the Trim tool (T) on the plan, the "Edit trim" buttons on
the wall inspector and Elevations cards, or the face picker on the **Trim**
tab. The face is drawn on its own as a true-scale elevation: one uniform
scale for length and height, so it stays exact at any zoom (scroll) or pan
(right/middle-drag, Space+drag or P). Rulers show distance from the left
corner and height above the finished floor (AFF), and the grid adapts to the
zoom down to 1/16" or 1 mm. Openings are placed from the plan geometry, so
casing is measured from their real size and position.

| Tool | Key | How |
|------|-----|-----|
| Select | V | Click trim to select; drag a chair rail or box to move it; drag handles to resize boxes and wainscot or to shorten a run. Del deletes, X removes the clicked piece of a run, arrows nudge (Shift = 1" / 10 mm), Ctrl+D duplicates a box. |
| Baseboard / Crown | B / C | Click for a run along the whole face, or drag a partial run. Baseboard gaps at doors and cased openings (stopping at the casing); crown follows sloped ceilings and gaps at bulkheads. Gaps follow the openings when they move. With a tray ceiling, click inside the dashed tray outline for **tray crown**: it runs along the tray side above that wall, at the tray height. |
| Chair rail | R | Click at a height (the top edge), or type a height such as `36` + Enter. Breaks where it meets openings and their casing. |
| Casing | O | Click a door, window or opening to case it on this side. Doors get two legs and a head; windows are picture-framed, or have a stool, apron and sill (toggles in the panel). Corners are drawn as 45° mitres (legs stand square on the floor or stool), and lengths are measured at the long point. |
| Panel box | M | Drag a picture-frame box, or type a size such as `24x18` + Enter. "Lay out boxes" repeats a box evenly between openings. |
| Wainscot | W | Click for wainscot along the face at the default height, type a height, or drag part of the wall. Measured as area (openings deducted) or sheets. |

Everything snaps (to corners, floor, ceiling, opening edges, heads and sills,
casing, bulkheads, other trim and the grid; Shift turns snapping off, S and G
toggle snapping and the grid), the selection shows its dimensions, and every
value can be typed in the panel. In the trim editor bare numbers are inches
on imperial plans and millimetres on metric ones. All edits are undoable.

**Bulk assignment.** Trim can be assigned to one face, a whole room (all its
interior faces) or the whole house (every room face), from the trim panel,
the room inspector or the plan settings. A **package** is a named set of
trim (e.g. "Standard Main Floor" = 5¼" baseboard + 3½" casing + chair rail at
36") saved with the plan; packages can be built in the panel or saved from a
face. Tray crown is its own kind (in packages and the "+ Tray crown"
buttons) and only lands on walls under a tray ceiling. Applying trim or a
package replaces those kinds of trim on each face,
and each bulk action is a single Undo.

**Bulk removal.** One kind of trim (baseboard, crown, tray crown, chair rail,
door or window casing, wainscot) can be deleted from a whole room or the whole
house at once: the "−" buttons in the room inspector, plan settings and trim
panel list the kinds present, and a selected piece has **Delete from whole
room** / **Delete from whole house** (Shift+Del in the editor = whole room).
Other kinds are left alone: removing crown keeps tray crown, and removing
wainscot keeps hand-placed panel boxes. Each removal is a single Undo.

**Profile catalog.** Profiles live in `public/data/trim-profiles.json`, not
in code. Each has an `id`, `name`, `category` (baseboard, crown, chair-rail,
panel-moulding, door-casing, window-casing, window-stool, window-apron,
window-sill), `widths` written with units (`"5 1/4\""`, `"90mm"`) and an
estimate `unit` (`lf`, `sf` or `sheet`; sheet goods also give `sheetLength`).
Optional: `defaultWidth`, `default: true`, `description`, and for wall
panelling `pattern` (`beadboard`, `shiplap`, `board-batten` or `panel`)
with `spacing` (groove or batten spacing, with units), which decides how
wainscot is drawn: grooves, boards at the board width, battens at the
batten width, or plain sheets, plus seams every sheet width for sheet goods.
Without a pattern, sheet goods draw as plain sheets and area goods as boards.
Invalid entries
are skipped with a console warning. Sizes always display in the plan's units.

## Floor leveling

The Level tool (L) overlays a survey grid on the selected room (1'–3' or
0.5–1 m spacing, centred and kept off the walls). Columns are lettered
west → east and rows numbered north → south, so every node has a name like
`C4`.

- **Survey:** readings are relative to your benchmark (+ high, − low). The
  entry bar under the plan has one-tap presets (`+1` `+3/4` `+1/2` `+1/4` `+1/8`
  `0` … `-1` inches, or `±20` `15` `10` `6` `3` `0` mm). Tap one and it is saved
  to the current node. For anything else, type the value in the bar's box or
  straight onto the plan (`3/8`, `-5/16"`, `4mm` etc.), then Enter. Quick entry
  jumps to the next node in walking order (row 1 west → east, row 2 back), so a
  whole grid goes in one go. With no node active, entry starts at the first
  empty one. Tab/Shift+Tab skip, arrows move, Del clears a reading, Esc stops.
  Bare numbers are inches on imperial plans and mm on metric ones; the panel can
  switch them.
- **Heatmap:** the readings are interpolated (inverse-distance weighting) and
  drawn on the plan relative to the target: yellow → red where you grind, light
  blue → navy where you pour, green within tolerance. Numbers on the plan show
  each node's deviation from the target (+ grind, − pour) and can be turned off.
- **Target & tolerance:** pick a flatness spec (3/16" in 10', 1/8" in 6', 1/4"
  in 10'). Keeping every point within ±half of it guarantees no straightedge gap
  exceeds the spec. The target slider previews live. By default the target follows
  the recommendation.
- **Optimize for:** choose **Minimize grinding** (pour up to the highest spot)
  or **Minimize pour** (grind down to the lowest spot so no compound is needed).
  Both plans are shown side by side with their target, grind area, deepest cut
  and bags, and both are held under the clearance locks. Grinding only shrinks
  as the target rises and pouring only grows, so each optimum is the highest
  (or lowest) target the readings and locks allow.
- **Clearance locks:** cap how far the floor may rise at a door or opening (above
  the existing floor there) or anywhere in the room (above the benchmark). When
  a lock is below the fill-only target, the recommendation drops to the lock and
  switches to grinding the high spots. A target above a lock is flagged as a breach.
- **Connected rooms:** rooms joined by a door or cased opening are leveled
  as one floor once they have readings. They share one continuous heatmap,
  one target and tolerance (taken from the first of them), and each other's
  clearance locks, and the action plan and bag count cover them together.
  Each room keeps its own grid, so linking never moves readings. Readings in
  linked rooms must come from the same benchmark. Quick entry carries on into
  the next connected room when a room is done. Untick "Level with rooms
  connected by doors or openings" in a room's panel to level it on its own. The
  Takeoff splits linked quantities per room by area.
- **Action plan:** total grind area with the maximum cut, total fill area with the
  average fill, and a numbered list of grind spots (`G1`, `G2`…, also marked on the
  plan) with the nodes they cover and their distance from the west and north walls.
- **Compound:** choose Custom Building Products LevelQuik RS, MAPEI Ultraplan 1 Plus,
  ARDEX K 15 or a custom product. Each has a yield curve: bag volume over the
  neat range, plus extra yield when extended with aggregate for deep pours. The
  panel reports "You need **X bags** of compound (includes 10% contingency)" (the
  contingency is adjustable), and the bags and grinding also appear in the Takeoff.
  The product figures are nominal data-sheet values, so check them against the bag.

## Views

- **Plan:** top-down drawing with interior dimensions for every wall face,
  room areas, ceiling markers (ridge line, slope arrow, tray outline) and door
  swings.
- **Elevations:** each wall face of the selected room as seen from inside,
  at a shared scale. Shows the ceiling profile (peaks and slopes), openings
  with sizes, sill heights, chain and overall dimensions, any trim, and a key
  plan. Printable.
- **Trim:** the wall face editor (see above).
- **Takeoff:** per-room quantities (floor, perimeter, gross/net wall area,
  exterior wall area, ceiling surface, potential baseboard and casing,
  opening counts), a first-pass material list with waste factors, assigned
  trim by profile and size and by wall face, and CSV export. Trim lines come
  only from assigned trim.

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
  leveling.js      survey grid, interpolated floor surface, cut/fill plan, compound yield
  faces.js         every wall face (room and exterior) with its profile and openings
  trimCatalog.js   loads and validates the trim profile catalog
  trim.js          trim items, resolved pieces and quantities, re-attachment, bulk apply
  takeoff.js       quantities and material list
public/data/       trim-profiles.json (the profile catalog)
public/js/ui/      shared drawing canvas (canvas.js), SVG plan editor, elevations, wall face (trim) editor, inspector, takeoff view
test/              node:test suites for core logic and the API
```

### Data model

A design is a planar graph: `nodes` (points, in mm) joined by `walls`
(centrelines with thickness). `openings` sit on a wall at an `offset` from
its start node. `rooms` hold only user metadata (name, ceiling, finishes, leveling survey) and
are matched to the graph's faces on every edit, first by wall set and then by
an anchor point. After each edit, `normalize()` keeps the graph planar: it
splits walls at T-junctions and crossings, merges duplicate and collinear
segments, and re-homes openings.

`analyze(design)` is the single source of derived data. For each room it
returns the interior polygon (centrelines offset by half the wall thickness)
and the merged wall faces with their openings and exterior spans, plus the
exterior faces around the outside of the building. The elevation, trim and
takeoff views build on top of it.

Trim (design version 2) is stored per face in `faceTrim`:
`{ id, wallIds, outward, p0, p1, items }`, where the first four record the
face at the last edit so `normalize()` can re-attach it: moved walls keep
their trim, a face split by a new wall gives each piece a copy, merged faces
combine, and casing goes with its opening. Items use face coordinates (mm
from the face's left end as seen facing it, mm above the floor): runs
(`start`/`end` null = to the corner, plus user `cuts`; gaps at openings are
derived; crown with `placement: 'tray'` runs along the tray side above the
wall instead of the wall top), casing (by `openingId`, with `reveal` and optional
`stool`/`apron`/`sill`), boxes and wainscot. `trimPackages` holds named
sets of `{ category, profileId, size, height?, … }`. Version 1 designs
are migrated on load: a room's crown flag becomes crown runs on its faces.

### Extending the estimate

`computeTakeoff()` returns raw quantities per room in mm/mm². To add a
material (studs, flooring underlayment, tile, and so on), derive it from
these quantities in `materialList()`, or use `analyze()` /
`roomElevations()` directly when you need per-wall geometry. Estimate
settings live in `design.estimate` and are merged with defaults by
`resolveEstimate()`.
