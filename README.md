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
| Door / Window / Opening | D / N / O | Click on a wall. While placing, the gaps to the corners of each wall face are shown. Doors come in five styles (pick one in the inspector; new doors use the last style picked): **single swing**, **double swing** (a pair of half-width leaves), **sliding** (two bypass panels), **pocket** (slides into the wall) and **barn** (a slab hung on one face that slides along a track). |
| Measure | M | Hover the side of any wall to see the length of that face (inside a room or outside the building) and click to pin it. Drag, or click twice, for a point-to-point measure: points snap to inside and outside corners, door and window jambs, wall faces and guides, and straight or 45° measures stop on the wall face they reach, so a measure across a room is its clear size. Diagonals show their across/down legs. Shift frees the angle, Del removes the last measure, Esc clears. Measurements are not saved and clear when you switch tools. |
| Select | V | Click to select; Shift+click adds or removes. Drag a ruler guide to move it; Shift+drag one to pull a copy off it. With several items selected, dragging any selected wall or corner moves the whole selection together (walls attached to it stretch to follow; the corner nearest where you grabbed snaps). **Hold Shift while moving to lock the move** horizontal or vertical (whichever way you have moved further; a dashed line shows the lock), still snapping along it to corners, guides and the grid. Alt (Option) moves without snapping. Shift can be held from the start: Shift+drag on a selected wall or corner is a locked move, while a Shift+click without moving still removes it from the selection. Drag a box over empty floor to select several: left→right picks walls/openings fully inside, right→left picks anything the box touches. Ctrl+A selects everything. Drag corners, walls (perpendicular) or openings (along their wall); Alt frees walls and openings from the grid. Del deletes the whole selection in one undoable step. Double-click focuses the main field in the inspector. |
| Pan | P | Drag anywhere to move around the plan. |
| Layout | U | Place furniture, cabinets, fixtures and appliances from the catalog and check the clearances (see Layout planning below). |
| Trim | T | Hover the side of a wall and click to open that face in the trim editor (see below). |
| Level | L | Survey a room's subfloor and plan the leveling (see below). |

Other controls: **Flooring (Shift+F)** shows the flooring layout (see below); **Furniture** shows or hides the layout pieces with the other tools; pan with the Pan tool (P), by right-dragging, with the middle mouse button or by holding Space; zoom with the
scroll wheel; F fits the plan; Ctrl+Z / Ctrl+Shift+Z undo and redo; Ctrl+S saves.

The plan and the wall face editor share one drawing canvas: rulers along the
top and left (with the cursor marked), an adaptive grid down to 1/16" or
1 mm, snap guides, and a bar with **Snap (S)**, **Grid (G)**, zoom − / + and
**Fit**. With snapping off, points round to 1/16" or 1 mm only.

**Ruler guides** work the same on the plan and on a wall face in the trim
editor (they are part of the shared canvas). Drag from the top ruler for a
horizontal guide or from the left ruler for a vertical one. While you drag, a guide snaps to
parallel wall faces (interior or exterior) and wall centrelines, and shows
how far it is from the nearest face. Walls, rooms, corners and measurements
snap onto guides, and to the points where guides cross each other or a wall.
Drag a guide with the Select tool to move it, or back onto its ruler to
delete it. **Type a distance + Enter to place a guide exactly**: while
dragging it, or straight after letting go (the guide stays ready, with a
dimension showing, until you click elsewhere or press Esc; type again to
adjust it). The distance is measured from the guide it was pulled off, else
from the nearest parallel wall face or guide, on the side the guide is on.
As with typed lengths elsewhere on the plan, bare numbers are feet (metres on
metric plans), so type `18"` for inches; on a wall face bare numbers are
inches (mm), as everywhere in the trim editor.

On a wall face, guides snap to and measure from everything the trim tools
use (corners, the floor, opening edges and heads, casing, other trim), and
the trim tools snap to the guides, e.g. a horizontal guide at 32" for a
chair rail. A face's guides are saved with that face and follow it when walls
move (a split face gives height guides to both halves). Click a guide to see
its position and delete it. Click a guide to select it, or drag a selection box across
several (in either direction a box picks every guide it crosses), then press
Del to delete them. **Shift+drag (or Alt+drag) a guide to pull a new one off it**,
leaving the original in place, for reference measurements (while doing so,
Alt turns snapping off): the distance back to the source is shown live, and typing a
distance (`3'6"`, `1200mm`) + Enter places the new guide exactly that far
away. Moving a guide shows (and types) its distance from the nearest parallel
guide, guides snap to each other, and hovering a guide shows its distance to
the guides on either side. Guides are saved with the plan and are undoable. "Clear all" is
in the plan settings.

**Dimensions are face to face.** Plan labels show the length of each wall
face to its corners (interior faces, optionally exterior faces as well),
never centre to centre. Once a door, window or opening is in a wall, that
face is labelled piece by piece instead: the wall on either side of each
opening (corner to edge, edge to edge), with the opening's own width in
smaller grey type. A selected wall shows its face lengths, a selected or
new opening shows its gaps to the corners of each face, and the inspector
edits these same face lengths and gaps.

Assigned trim shows on the plan: baseboard as a solid band along the floor (shoe moulding as a thin darker band in front of it)
line and crown (including tray crown) as a dashed band at its projection,
each mitred where runs meet at a corner and stopped square at door gaps.
Cased doors and windows show their casing legs beside the jambs (on the side
of the wall the casing is on), and windows their stool or sill. "Show trim on
the plan" turns this off.

Rooms are **detected automatically** from enclosed areas, so you never have
to define them by hand. An enclosed void with no way in (a chase, a boxed-in
corner) can be marked as **dead space** in the room inspector, which suggests
it for rooms with no doors or openings. Dead space is hatched on the plan and
left out of the takeoff (floor, walls, ceiling, insulation, trim), of
flooring runs and of leveling. Drawing a wall across a room splits it, and deleting
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
- **Room:** also a **Dead space** toggle (see above).
- **Wall:** the face length on each side (room faces and the exterior face);
  the centreline length is tucked under "Centreline" (it is the only field for a
  wall with no faces). Changing a length *stretches* the plan beyond end B, so
  rectangles stay rectangular. Also thickness, the exterior/interior override,
  and an "Edit trim" button for each side of the wall.
- **Opening:** type, door style, width, height, sill, and the gap to the left
  and right corner of each wall face it is in (as seen facing the wall from
  that side). Flip buttons match the style: hinge and swing (single), swing
  (double), the side a pocket or barn door slides to, and the face a barn door
  hangs on. Pocket and barn doors warn when there isn't enough clear wall
  beside the opening for them to slide open.
- **Nothing selected:** default wall thickness, default ceiling height, the
  dimension display (interior faces, interior and exterior faces, or hidden),
  ruler guides, and whether trimmed wall faces are marked on the plan ("Show
  trim on the plan").

Units can be switched between imperial and metric at any time. All geometry is
stored in millimetres; only the display changes.

## Layout planning

The **Layout tool (U)** turns the plan into a space-planning drawing: pick a
piece in the panel's catalog (search it, or open a room type), choose its
size and click **Place**, then click on the plan. Shift+click places another
of the same; Q / E rotate the preview 90° (Shift: 15°); Esc stops.

- **Catalog** (typical sizes, all editable afterwards):
  - *Bedroom:* beds (crib/toddler 28×52, twin 38×75, twin XL, full 54×75,
    queen 60×80, king 76×80, California king 72×84), bunk and loft beds,
    nightstands, dressers and tall chests, wardrobes, end-of-bed bench,
    makeup vanity.
  - *Living:* armchair, recliner, loveseat, sofa, L- and U-shaped
    sectionals (flip the return), ottoman / pouf, coffee, end and console
    tables, TV stand (with the TV on it), wall-mounted TV (55"–85"),
    bookcases 10"–14" deep, credenza.
  - *Dining:* rectangular tables for 4 / 6 / 8 / 10, round for 2 / 4 / 6,
    square for 2 / 4, oval, extendable (folded or extended: longer, more
    seats), chairs with and without arms, bench, counter stools (24" seat),
    bar stools (30"), sideboard, bar cart / dry bar. Tables are drawn with
    their chairs.
  - *Kitchen:* base cabinets 24" deep, 9"–36" wide; corner units (L / lazy
    Susan, diagonal, blind); uppers 12" (and 15") deep, drawn dashed
    overhead; tall pantry; islands and breakfast bars; single, double and
    corner sinks; standard, counter-depth, French-door and side-by-side
    fridges; 30" / 36" ranges; cooktops; single and double wall ovens;
    24" and 18" dishwashers; over-the-range, drawer and built-in
    microwaves; range hoods.
  - *Bathroom:* elongated, round and wall-hung toilets, bidet, single
    vanities 24"–48" and doubles 60" / 72", pedestal and wall-hung sinks,
    alcove tubs 60×30 / 60×32, freestanding tubs, corner and neo-angle
    showers, a 60×36 walk-in with a glass panel.
  - *Office:* writing / computer desk, L-shaped and corner desks, desk
    chair with its 30" swivel circle, lateral and vertical filing cabinets,
    shelving.
  - *Laundry, mudroom & utility:* washer and dryer side by side
    (56"–60"), separate washer and dryer, stacked 27"×30", utility sink,
    mudroom bench with hooks / cubbies, shoe rack / entry storage, water
    heaters (tank and tankless), furnace / air handler.
  - *Rugs & custom:* area rugs and runners (under everything), and a custom
    rectangle or circle for anything else.
- **Placing and moving:** wall pieces (beds, dressers, sofas, cabinets,
  appliances, fixtures…) turn to face into the room and sit flush on the
  nearest wall face, sliding along it with their edges snapping to the
  corners, door and window jambs and the pieces already on that wall (uppers
  line up with the base cabinets below), or their centre to the middle of
  the wall. Other pieces keep their angle and line up with walls, guides
  and other pieces. Drag to move (Shift locks the axis, Alt places freely),
  arrows nudge (Shift: a foot / 10 cm), Ctrl+D duplicates beside (handy for
  cabinet runs and chairs). Pieces select, box-select, group-move with walls
  and delete like anything else on the plan.
- **Clearances:** each piece carries the clear floor it needs on each side
  (30" beside and at the foot of a bed, 36" in front of a dresser, 36"
  around a dining table to pull out a chair, 42" in front of base cabinets
  and islands, 15" from a toilet's centreline and 21" in front of it, 42" in
  front of a washer and dryer, 30" in front of a furnace…). With the Layout
  tool every zone is drawn (green, red where short); otherwise the selected
  piece's. The selected piece also shows the clear distance from each side
  to the nearest wall or piece. Override any side in the piece's panel.
- **Checks** (listed in the panel; click one to select the piece):
  overlaps between pieces at the same height (a wall TV may hang over a
  media console, an upper cabinet may not hang over a fridge or pantry;
  chairs and stools tuck under tables), pieces running into walls or outside
  every room, clearances, pieces in a door's swing, a barn door's path or a
  doorway, tall pieces or wall units in front of a window, pieces in dead
  space, sinks and cooktops that are not on a base cabinet or island, the
  **kitchen work triangle** (sink, cooktop, fridge: each leg 4'–9', 13'–26'
  in total, drawn on the plan) and **TV viewing distance** (about 1.2–2 ×
  the screen diagonal, to the seat facing the screen). Twin beds, cribs and
  bunks only need one side clear. While placing, the preview is checked as
  if it were already placed.
- **Takeoff:** pieces are counted by type and size under Fixtures,
  Appliances, Cabinets, Mechanical and Furniture (priced like any other
  line), plus the countertop area over base cabinets, islands and
  dishwashers. Pieces in dead space are left out.

The kitchen and bath figures follow the NKBA planning guidelines and the
fixture figures the usual code minimums; local codes and the maker's
instructions take precedence.

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
| Shoe moulding | H | Click for shoe moulding (or quarter round) along the floor at the foot of the baseboard, or drag a partial run. It gaps at doors and stops at casing exactly like the baseboard, is drawn over it, and on the plan shows as a thin band just in front of it. |
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
in code. Each has an `id`, `name`, `category` (baseboard, shoe, crown, chair-rail,
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

## Flooring layout

Turn on **Flooring (Shift+F)** in the bar above the plan to see how each
flooring run actually lands in the rooms, and where to start the first course
so there are no slivers at walls, in doorways or in traffic paths.

- **Runs:** click a room and pick its finish floor (a new **plank** or **tile**
  run, or an existing one) and, on the **Subfloor** layer, its subfloor. A room
  has at most one run per layer, so DRIcore-type panels under vinyl plank work.
  Tick several rooms into one run and the pattern carries on through the doors
  and cased openings between them without restarting. Separate runs each start
  their own pattern.
- **Product:** presets with typical sizes and carton counts (vinyl plank,
  laminate, solid and engineered hardwood; 12×12 to 24×24 and plank tile;
  4×8 plywood/OSB, 2×2 basement panels, dimple membrane rolls) or any custom
  size, plus grout (tile) or panel gap (subfloor), pieces per box, waste
  allowance, the gap at the walls and the smallest acceptable end cut.
- **Pattern:** planks use a **random** stagger that keeps neighbouring rows'
  joints a minimum distance apart, avoids H-joints, and, as an installer
  would, picks each row's start cut so both end pieces are long enough. A
  **fixed** offset (½, ⅓, ¼ or any) is also available. Tile is a straight
  grid or an offset bond. Subfloor sheets are staggered half a sheet by default.
- **Placing it:** drag the layout on the plan (Select tool) to move the
  pattern; rows and joints snap to wall corners and room centres (Shift: lock the move horizontal or vertical; Alt: free).
  The arrow keys nudge it (Shift = 1" / 10 mm). **Best fit** searches for the
  position with no slivers (weighted three times in doorways and the 2' in
  front of them), cuts of at least half a piece where possible and balanced
  first and last rows. For tile, **Center tile** and **Center joint** put a
  tile or a grout crossing on the centre of the largest room. Rotating
  re-fits automatically.
- **On the plan:** full pieces, cuts, cuts under half a piece (amber) and
  slivers (red), the first and last row widths at the walls, the origin
  handle with the run direction, and a summary box that updates live while
  dragging.
- **Takeoff:** pieces come from the layout itself: full pieces plus stock
  for the cuts, reusing offcuts where they fit (plank offcuts only along
  their length and only if long enough for an end piece). The waste allowance
  is added on top for breakage and defects, then rounded up to whole boxes,
  sheets, panels or rolls. The panel shows floor covered, area bought and the
  layout's own cut waste. Each run is a line in the Takeoff; rooms without a
  layout keep the area-based flooring line.
- **Install guidance** for the run's type, each checked against the layout
  where it can be: plank direction relative to the main windows and (for
  nail-down hardwood) the joists, end-joint stagger, shortest end piece,
  balanced first and last rows, expansion gap and long continuous runs; tile
  centring and balanced perimeter cuts, half-tile minimum, the ANSI A108.02
  33% offset limit for tile over 18", grout joint width, perimeter and field
  movement joints (TCNA EJ171) and flatness; subfloor sheet strength axis
  across the joists, staggered end joints, 1/8" panel gaps (APA), and
  spacers for basement panels. Set the joist direction in the panel to check
  the joist rules. The figures are the usual published ones; the maker's
  instructions take precedence.

## Views

- **Plan:** top-down drawing with interior dimensions for every wall face,
  room areas, ceiling markers (ridge line, slope arrow, tray outline), door
  symbols for each style and hatched dead space.
- **Elevations:** each wall face of the selected room as seen from inside,
  at a shared scale. Shows the ceiling profile (peaks and slopes), openings
  with sizes, sill heights, chain and overall dimensions, any trim, and a key
  plan. Printable.
- **Trim:** the wall face editor (see above).
- **Takeoff:** per-room quantities (floor, perimeter, gross/net wall area,
  exterior wall area, ceiling surface, potential baseboard and casing,
  opening counts), a first-pass material list with waste factors and the
  doors by style and size (with the hardware each style needs), assigned
  trim by profile and size and by wall face, and CSV export. Trim lines come
  only from assigned trim.
  **Pricing:** type a unit price on any material line (per sheet, sq ft,
  lf, bag, door… as listed) to get its total; the quantity priced is the
  one shown, waste included. One tax rate (Estimate settings) applies to
  every line, and the table ends with the subtotal, tax and total, which
  also appear in the CSV. Enter or Tab moves to the next price. Prices, the
  tax rate and the currency symbol are saved with the plan.

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
  flooring.js      flooring runs: region, pattern, clipped pieces, best fit, offcut takeoff, install guidance
  faces.js         every wall face (room and exterior) with its profile and openings
  trimCatalog.js   loads and validates the trim profile catalog
  trim.js          trim items, resolved pieces and quantities, re-attachment, bulk apply
  furniture.js     layout planning: furniture/fixture catalog, footprints, placement snapping, clearance and layout checks
  takeoff.js       quantities and material list
public/data/       trim-profiles.json (the profile catalog)
public/js/ui/      shared drawing canvas (canvas.js) with its ruler guides (guides.js), SVG plan editor, elevations, wall face (trim) editor, inspector,
                   flooring layer and panel (floorLayer.js, floorPanel.js), layout symbols and panels (layoutLayer.js, layoutPanel.js), takeoff view
test/              node:test suites for core logic and the API
```

### Data model

A design is a planar graph: `nodes` (points, in mm) joined by `walls`
(centrelines with thickness). `openings` sit on a wall at an `offset` from
its start node; doors also have a `style` (`single`, `double`, `sliding`,
`pocket`, `barn`; missing means single), and `flipX`/`flipY` pick the hinge
(or slide) side and the swing (or barn) side. `guides` are ruler guides
`{ id, axis: 'x' | 'y', v }` (a vertical line at x = v, or a horizontal one at
y = v). `rooms` hold only user metadata (name, ceiling, finishes, leveling
survey, `dead` for dead space) and
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
`{ id, wallIds, outward, p0, p1, items, guides? }` (guides: that face's ruler
guides in face coordinates, x along the face and y the height), where the first four record the
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

Flooring runs are stored in `floorRuns`:
`{ id, name, kind, preset, length, width, joint, stagger: { mode, offset, min, seed }, perBox, unit, waste, gap, minCut, angle, origin, roomIds }`.
`kind` is `plank` or `tile` (finish layer) or `subfloor`. `length` runs along
`angle` (degrees; 0 = east–west). `origin` is a plan point where a corner of
course 0 sits, so a run shared by several rooms is one continuous pattern.
`normalize()` drops deleted rooms from runs, keeps each room in one run per
layer and removes runs left empty. `layoutRun()` builds the region (each
room inset by the gap, plus a threshold strip through each door or opening
between two of the run's rooms), lays the pattern in run coordinates,
clips every piece (Sutherland–Hodgman) and grades its cut, then packs the
cuts into stock for the takeoff.

Layout pieces are stored in `furniture`:
`{ id, type, size, x, y, angle, w, d, label?, opts: { side, extended, screen, clear } }`.
`x`, `y` is the centre (mm) and `angle` the rotation in degrees; in the
piece's own frame x runs across its width and y from its back to its front,
so at angle 0 it backs onto a north wall and faces south. `type` and `size`
index the catalog in `core/furniture.js` (`FURNITURE`, sizes in inches),
which supplies the shape, mounting (floor, overhead, counter, rug), height
and standard clearances; `w`/`d` are copied from the size so they can be
edited (`size: 'custom'` once they differ). `opts.clear` overrides the
standard clearance per side (mm). `analyzeLayout(design)` returns each
piece's footprint, clearance zones, side distances and problems, plus the
work triangles and TV viewing distances.

### Extending the estimate

`computeTakeoff()` returns raw quantities per room in mm/mm². To add a
material (studs, flooring underlayment, tile, and so on), derive it from
these quantities in `materialList()`, or use `analyze()` /
`roomElevations()` directly when you need per-wall geometry. Estimate
settings live in `design.estimate` and are merged with defaults by
`resolveEstimate()`; that includes `prices` (unit price by material line
key), `taxRate` (%) and `currency`, which `priceMaterials()` turns into line
totals, a subtotal, tax and a total (`computeTakeoff().pricing`).
