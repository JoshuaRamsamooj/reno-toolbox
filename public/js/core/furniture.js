// Layout planning: furniture, cabinets, fixtures and appliances placed on the
// plan, with the clearances each one needs and checks against the walls,
// doors, windows and each other.
//
// Items are stored in design.furniture as
//   { id, type, size, x, y, angle, w, d, label?, opts: { side, extended, screen, clear, cutsTrim } }
// opts.cutsTrim (true / false, absent = the catalog's choice) says whether
// wall trim is left off where the item stands against a wall.
// x, y: plan centre (mm); angle: degrees. In the item's own frame, local x
// runs across its width (w) and local y from its back (-d/2) to its front
// (+d/2): a bed's head is its back, a sofa faces its front, a cabinet's
// doors are on its front. ux = (cos a, sin a), front = perp(ux), so at
// angle 0 an item backs onto a north wall and faces south. "Left" is the
// -ux side, as seen standing in front of the item looking at it.
//
// The catalog is written in inches (the usual published sizes) and kept in
// millimetres like all other geometry. Clearances are the usual planning
// figures (NKBA kitchen and bath guidelines, IRC minimums for fixtures);
// codes and the maker's instructions take precedence.
import { add, cross, dist, dot, norm, perp, pointInPolygon, polygonArea, scale, segmentIntersection, sub } from './geometry.js';
import { MM_PER_IN, areaUnit, areaValue, formatLength } from './units.js';
import { analyze, doorStyle, openingGeometry, uid, BARN_OVERLAP } from './model.js';

const IN = MM_PER_IN;
const OVERLAP_MM2 = 2000; // ~3 in²: anything less is a touch, not an overlap
const GAP_MAX = 120 * IN; // side distances are measured out to 10'

export const FURNITURE_CATEGORIES = {
  bedroom: 'Bedroom',
  living: 'Living & lounge',
  dining: 'Dining',
  kitchen: 'Kitchen & pantry',
  bath: 'Bathroom',
  office: 'Office & study',
  utility: 'Laundry, mudroom & utility',
  general: 'Rugs & custom',
};

/**
 * The catalog. Per type: name, category, symbol (how it is drawn), sizes
 * [{ id, label, w, d, h, ...overrides }] in inches, and optionally:
 *   shape   rect (default) | round | L | U | corner | diag  (size may override; leg/cut in inches)
 *   mount   floor (default) | overhead (upper cabinets, hoods, wall TVs: dashed, above
 *           the floor) | counter (sits on cabinets: sinks, cooktops) | rug (under everything)
 *   wall    true: backs onto a wall (snaps there and turns to face the room)
 *   clear   { front, back, left, right } inches of clear floor needed on each side
 *   oneSide true: one of left/right is enough (a twin bed in a corner)
 *   centerline  inches from the item's centreline to anything beside it (toilets)
 *   sideFrom    inches from the back where side clearance starts (beside nightstands)
 *   tuck    true: chairs and stools, which tuck under tables and aren't obstacles
 *   under   true: tables, desks and islands that chairs tuck under
 *   counter true: carries countertop (base cabinets, islands, dishwashers)
 *   takeoff Furniture (default) | Cabinets | Fixtures | Appliances | Mechanical
 *   z0      bottom height for overhead items (inches)
 *   cutsTrim true: built in against the wall (cabinets, vanities, showers, alcove
 *           tubs, built-in appliances), so trim on that wall stops either side of it
 *           wherever its height overlaps the trim; furniture that moves (and toilets,
 *           pedestal sinks, laundry) leaves the trim behind it in place
 */
export const FURNITURE = {
  // Bedroom ----------------------------------------------------------------
  bed: {
    name: 'Bed', category: 'bedroom', symbol: 'bed', wall: true, clear: { left: 30, right: 30, front: 30 }, sideFrom: 22,
    sizes: [
      { id: 'crib', label: 'Crib / toddler', w: 28, d: 52, h: 36, oneSide: true },
      { id: 'twin', label: 'Twin / single', w: 38, d: 75, h: 24, oneSide: true },
      { id: 'twin-xl', label: 'Twin XL', w: 38, d: 80, h: 24, oneSide: true },
      { id: 'full', label: 'Full / double', w: 54, d: 75, h: 24 },
      { id: 'queen', label: 'Queen', w: 60, d: 80, h: 24 },
      { id: 'king', label: 'King', w: 76, d: 80, h: 24 },
      { id: 'cal-king', label: 'California king', w: 72, d: 84, h: 24 },
    ],
    defaultSize: 'queen',
  },
  bunk: {
    name: 'Bunk / loft bed', category: 'bedroom', symbol: 'bunk', wall: true, clear: { left: 30, right: 30, front: 30 }, oneSide: true, sideFrom: 0,
    sizes: [
      { id: 'twin-twin', label: 'Twin over twin', w: 42, d: 80, h: 65 },
      { id: 'twin-full', label: 'Twin over full', w: 57, d: 80, h: 65 },
      { id: 'loft', label: 'Loft bed (twin)', w: 42, d: 80, h: 72 },
    ],
  },
  nightstand: {
    name: 'Nightstand', category: 'bedroom', symbol: 'nightstand', wall: true,
    sizes: [
      { id: 'square', label: 'Square', w: 20, d: 16, h: 24 },
      { id: 'round', label: 'Round', w: 20, d: 20, h: 24, shape: 'round' },
      { id: 'floating', label: 'Floating', w: 18, d: 12, h: 24 },
    ],
  },
  dresser: {
    name: 'Dresser', category: 'bedroom', symbol: 'dresser', wall: true, clear: { front: 36 },
    sizes: [
      { id: 'low', label: 'Low 6-drawer', w: 60, d: 18, h: 32 },
      { id: 'tall', label: 'Tall chest', w: 36, d: 18, h: 50 },
    ],
  },
  wardrobe: {
    name: 'Wardrobe / armoire', category: 'bedroom', symbol: 'wardrobe', wall: true, clear: { front: 36 },
    sizes: [
      { id: '2-door', label: '2-door', w: 40, d: 24, h: 78 },
      { id: '3-door', label: '3-door', w: 60, d: 24, h: 78 },
    ],
  },
  'bed-bench': { name: 'End-of-bed bench', category: 'bedroom', symbol: 'bench', sizes: [{ id: 'std', label: 'Standard', w: 48, d: 18, h: 18 }] },
  'makeup-vanity': {
    name: 'Makeup vanity & stool', category: 'bedroom', symbol: 'desk', wall: true, clear: { front: 30 }, under: true,
    sizes: [{ id: 'std', label: 'Standard', w: 42, d: 18, h: 30 }],
  },

  // Living -----------------------------------------------------------------
  armchair: {
    name: 'Armchair / accent chair', category: 'living', symbol: 'chair', clear: { front: 15 },
    sizes: [{ id: 'arm', label: 'Armchair', w: 32, d: 34, h: 34 }, { id: 'accent', label: 'Accent chair', w: 28, d: 30, h: 32 }],
  },
  recliner: { name: 'Recliner', category: 'living', symbol: 'chair', clear: { front: 24, back: 12 }, sizes: [{ id: 'std', label: 'Standard', w: 36, d: 38, h: 40 }] },
  loveseat: { name: 'Loveseat (2-seat sofa)', category: 'living', symbol: 'sofa', seats: 2, wall: true, clear: { front: 15 }, sizes: [{ id: 'std', label: 'Standard', w: 64, d: 36, h: 34 }] },
  sofa: {
    name: 'Sofa (3-seat)', category: 'living', symbol: 'sofa', seats: 3, wall: true, clear: { front: 15 },
    sizes: [{ id: 'std', label: 'Standard', w: 84, d: 38, h: 34 }, { id: 'large', label: 'Large', w: 96, d: 40, h: 34 }],
  },
  'sectional-l': {
    name: 'L-shaped sectional', category: 'living', symbol: 'sectional', shape: 'L', leg: 38, wall: true, clear: { front: 15 }, options: ['side'],
    sizes: [{ id: 'chaise', label: 'With chaise', w: 104, d: 64, h: 34 }, { id: 'corner', label: 'Corner L', w: 112, d: 112, h: 34 }],
  },
  'sectional-u': {
    name: 'U-shaped sectional', category: 'living', symbol: 'sectional', shape: 'U', leg: 38, wall: true, clear: { front: 15 },
    sizes: [{ id: 'std', label: 'Standard', w: 128, d: 96, h: 34 }],
  },
  ottoman: {
    name: 'Ottoman / pouf', category: 'living', symbol: 'ottoman',
    sizes: [{ id: 'ottoman', label: 'Ottoman', w: 36, d: 24, h: 18 }, { id: 'pouf', label: 'Pouf', w: 20, d: 20, h: 16, shape: 'round' }],
  },
  'coffee-table': {
    name: 'Coffee table', category: 'living', symbol: 'table',
    sizes: [
      { id: 'rect', label: 'Rectangular', w: 48, d: 24, h: 18 },
      { id: 'round', label: 'Round', w: 36, d: 36, h: 18, shape: 'round' },
      { id: 'oval', label: 'Oval', w: 48, d: 30, h: 18, shape: 'round' },
      { id: 'square', label: 'Square', w: 36, d: 36, h: 18 },
    ],
  },
  'end-table': {
    name: 'End / side table', category: 'living', symbol: 'table',
    sizes: [{ id: 'square', label: 'Square', w: 24, d: 24, h: 24 }, { id: 'round', label: 'Round', w: 20, d: 20, h: 24, shape: 'round' }],
  },
  console: { name: 'Console / sofa table', category: 'living', symbol: 'table', sizes: [{ id: 'std', label: 'Slim', w: 60, d: 14, h: 30 }] },
  'tv-stand': {
    name: 'TV stand / media console', category: 'living', symbol: 'media', wall: true, options: ['screen'],
    sizes: [{ id: '60', label: '60" wide', w: 60, d: 18, h: 24 }, { id: '72', label: '72" wide', w: 72, d: 18, h: 24 }],
  },
  'tv-wall': {
    name: 'Wall-mounted TV', category: 'living', symbol: 'tv', mount: 'overhead', wall: true, z0: 40,
    sizes: [
      { id: '55', label: '55" screen', w: 48, d: 3, h: 68, screen: 55 },
      { id: '65', label: '65" screen', w: 57, d: 3, h: 72, screen: 65 },
      { id: '75', label: '75" screen', w: 66, d: 3, h: 77, screen: 75 },
      { id: '85', label: '85" screen', w: 75, d: 3, h: 82, screen: 85 },
    ],
    defaultSize: '65',
  },
  bookcase: {
    name: 'Bookcase', category: 'living', symbol: 'shelves', wall: true, clear: { front: 24 },
    sizes: [{ id: 'std', label: 'Standard (12" deep)', w: 36, d: 12, h: 72 }, { id: 'slim', label: 'Slim (10" deep)', w: 30, d: 10, h: 72 }, { id: 'deep', label: 'Deep (14" deep)', w: 36, d: 14, h: 72 }],
  },
  credenza: { name: 'Display credenza', category: 'living', symbol: 'dresser', wall: true, clear: { front: 24 }, sizes: [{ id: 'std', label: 'Standard', w: 72, d: 18, h: 30 }] },

  // Dining -----------------------------------------------------------------
  'dining-rect': {
    name: 'Rectangular dining table', category: 'dining', symbol: 'dining', under: true, clear: { front: 36, back: 36, left: 36, right: 36 },
    sizes: [
      { id: '4', label: '4-seat', w: 48, d: 30, h: 30, seats: 4 },
      { id: '6', label: '6-seat', w: 72, d: 36, h: 30, seats: 6 },
      { id: '8', label: '8-seat', w: 96, d: 40, h: 30, seats: 8 },
      { id: '10', label: '10-seat', w: 120, d: 42, h: 30, seats: 10 },
    ],
    defaultSize: '6',
  },
  'dining-round': {
    name: 'Round dining table', category: 'dining', symbol: 'dining', shape: 'round', under: true, clear: { front: 36, back: 36, left: 36, right: 36 },
    sizes: [
      { id: '2', label: '2-seat bistro', w: 30, d: 30, h: 30, seats: 2 },
      { id: '4', label: '4-seat', w: 42, d: 42, h: 30, seats: 4 },
      { id: '6', label: '6-seat', w: 54, d: 54, h: 30, seats: 6 },
    ],
    defaultSize: '4',
  },
  'dining-square': {
    name: 'Square dining table', category: 'dining', symbol: 'dining', under: true, clear: { front: 36, back: 36, left: 36, right: 36 },
    sizes: [{ id: '2', label: '2-seat', w: 30, d: 30, h: 30, seats: 2 }, { id: '4', label: '4-seat', w: 40, d: 40, h: 30, seats: 4 }],
    defaultSize: '4',
  },
  'dining-oval': {
    name: 'Oval dining table', category: 'dining', symbol: 'dining', shape: 'round', under: true, clear: { front: 36, back: 36, left: 36, right: 36 },
    sizes: [{ id: '6', label: '6-seat', w: 72, d: 42, h: 30, seats: 6 }],
  },
  'dining-ext': {
    name: 'Extendable dining table', category: 'dining', symbol: 'dining', under: true, clear: { front: 36, back: 36, left: 36, right: 36 }, options: ['extended'],
    sizes: [{ id: '6-8', label: '6 to 8 seats', w: 72, d: 40, h: 30, seats: 6, ext: 96, extSeats: 8 }, { id: '4-6', label: '4 to 6 seats', w: 54, d: 36, h: 30, seats: 4, ext: 72, extSeats: 6 }],
  },
  'dining-chair': {
    name: 'Dining chair', category: 'dining', symbol: 'dchair', tuck: true, clear: { back: 18 },
    sizes: [{ id: 'armless', label: 'Without arms', w: 18, d: 22, h: 36 }, { id: 'arms', label: 'With arms', w: 22, d: 24, h: 36 }],
  },
  'dining-bench': {
    name: 'Dining bench', category: 'dining', symbol: 'bench', tuck: true,
    sizes: [{ id: '48', label: '48" long', w: 48, d: 15, h: 18 }, { id: '60', label: '60" long', w: 60, d: 15, h: 18 }],
  },
  'counter-stool': { name: 'Counter stool (24" seat)', category: 'dining', symbol: 'stool', shape: 'round', tuck: true, clear: { back: 24 }, sizes: [{ id: 'std', label: 'Standard', w: 17, d: 17, h: 24 }] },
  'bar-stool': { name: 'Bar stool (30" seat)', category: 'dining', symbol: 'stool', shape: 'round', tuck: true, clear: { back: 24 }, sizes: [{ id: 'std', label: 'Standard', w: 17, d: 17, h: 30 }] },
  sideboard: {
    name: 'Sideboard / buffet', category: 'dining', symbol: 'dresser', wall: true, clear: { front: 30 },
    sizes: [{ id: '60', label: '60" wide', w: 60, d: 18, h: 34 }, { id: '72', label: '72" wide', w: 72, d: 20, h: 34 }],
  },
  bar: {
    name: 'Bar cart / dry bar', category: 'dining', symbol: 'dresser', wall: true,
    sizes: [{ id: 'cart', label: 'Bar cart', w: 32, d: 18, h: 34 }, { id: 'cabinet', label: 'Dry bar cabinet', w: 40, d: 20, h: 40, clear: { front: 24 } }],
  },

  // Kitchen ----------------------------------------------------------------
  'base-cabinet': {
    name: 'Base cabinet', category: 'kitchen', symbol: 'base', wall: true, cutsTrim: true, counter: true, takeoff: 'Cabinets', clear: { front: 42 },
    sizes: [9, 12, 15, 18, 21, 24, 27, 30, 33, 36].map((w) => ({ id: String(w), label: `${w}" wide`, w, d: 24, h: 34.5 })),
    defaultSize: '24',
  },
  'corner-cabinet': {
    name: 'Corner base cabinet', category: 'kitchen', symbol: 'base', wall: true, cutsTrim: true, counter: true, takeoff: 'Cabinets', clear: { front: 42 }, options: ['side'],
    sizes: [
      { id: 'l-corner', label: 'L-corner (lazy Susan)', w: 36, d: 36, h: 34.5, shape: 'corner', leg: 24 },
      { id: 'diagonal', label: 'Diagonal corner', w: 36, d: 36, h: 34.5, shape: 'diag', cut: 12 },
      { id: 'blind', label: 'Blind corner', w: 42, d: 24, h: 34.5 },
    ],
  },
  'upper-cabinet': {
    name: 'Upper / wall cabinet', category: 'kitchen', symbol: 'upper', mount: 'overhead', wall: true, cutsTrim: true, takeoff: 'Cabinets', z0: 54,
    sizes: [...[12, 15, 18, 24, 30, 36].map((w) => ({ id: String(w), label: `${w}" wide`, w, d: 12, h: 84 })), { id: '36x15', label: '36" wide, 15" deep (over fridge)', w: 36, d: 15, h: 84, z0: 70 }],
    defaultSize: '30',
  },
  'tall-cabinet': {
    name: 'Tall pantry cabinet', category: 'kitchen', symbol: 'tall', wall: true, cutsTrim: true, takeoff: 'Cabinets', clear: { front: 36 },
    sizes: [18, 24, 30].map((w) => ({ id: String(w), label: `${w}" wide`, w, d: 24, h: 84 })),
    defaultSize: '24',
  },
  island: {
    name: 'Kitchen island / breakfast bar', category: 'kitchen', symbol: 'island', cutsTrim: true, counter: true, under: true, takeoff: 'Cabinets', clear: { front: 42, back: 42, left: 36, right: 36 },
    sizes: [
      { id: '48x24', label: '48" × 24"', w: 48, d: 24, h: 36 },
      { id: '72x36', label: '72" × 36"', w: 72, d: 36, h: 36 },
      { id: '96x42', label: '96" × 42"', w: 96, d: 42, h: 36 },
      { id: 'bar', label: 'Breakfast bar 72" × 30"', w: 72, d: 30, h: 42 },
    ],
    defaultSize: '72x36',
  },
  sink: {
    name: 'Kitchen sink', category: 'kitchen', symbol: 'sink', mount: 'counter', wall: true, takeoff: 'Fixtures',
    sizes: [{ id: 'single', label: 'Single bowl', w: 25, d: 22, bowls: 1 }, { id: 'double', label: 'Double bowl', w: 33, d: 22, bowls: 2 }],
  },
  'corner-sink': {
    name: 'Corner kitchen sink', category: 'kitchen', symbol: 'sink', mount: 'counter', wall: true, shape: 'diag', cut: 12, takeoff: 'Fixtures', options: ['side'],
    sizes: [{ id: 'std', label: 'Corner, 2 bowls', w: 36, d: 36, bowls: 2 }],
  },
  fridge: {
    name: 'Refrigerator', category: 'kitchen', symbol: 'fridge', wall: true, cutsTrim: true, takeoff: 'Appliances', clear: { front: 36 },
    sizes: [
      { id: 'standard', label: 'Standard (top freezer)', w: 30, d: 30, h: 67 },
      { id: 'counter-depth', label: 'Counter-depth', w: 36, d: 25, h: 70 },
      { id: 'french', label: 'French door', w: 36, d: 34, h: 70 },
      { id: 'side-by-side', label: 'Side-by-side', w: 36, d: 34, h: 70 },
    ],
    defaultSize: 'french',
  },
  range: {
    name: 'Range / stove', category: 'kitchen', symbol: 'range', wall: true, cutsTrim: true, takeoff: 'Appliances', clear: { front: 36 },
    sizes: [{ id: '30', label: '30"', w: 30, d: 26, h: 36, burners: 4 }, { id: '36', label: '36"', w: 36, d: 27, h: 36, burners: 6 }],
  },
  cooktop: {
    name: 'Built-in cooktop', category: 'kitchen', symbol: 'range', mount: 'counter', wall: true, takeoff: 'Appliances',
    sizes: [{ id: '30', label: '30"', w: 30, d: 21, burners: 4 }, { id: '36', label: '36"', w: 36, d: 21, burners: 5 }],
  },
  'wall-oven': {
    name: 'Wall oven tower', category: 'kitchen', symbol: 'oven', wall: true, cutsTrim: true, takeoff: 'Appliances', clear: { front: 36 },
    sizes: [{ id: 'single', label: 'Single oven', w: 30, d: 25, h: 84 }, { id: 'double', label: 'Double oven', w: 30, d: 25, h: 84, ovens: 2 }],
  },
  dishwasher: {
    name: 'Dishwasher', category: 'kitchen', symbol: 'dw', wall: true, cutsTrim: true, counter: true, takeoff: 'Appliances', clear: { front: 24 },
    sizes: [{ id: '24', label: 'Standard 24"', w: 24, d: 24, h: 34.5 }, { id: '18', label: 'Compact 18"', w: 18, d: 24, h: 34.5 }],
  },
  microwave: {
    name: 'Microwave', category: 'kitchen', symbol: 'micro', wall: true, cutsTrim: true, takeoff: 'Appliances',
    sizes: [
      { id: 'over-range', label: 'Over the range', w: 30, d: 16, mount: 'overhead', z0: 54, h: 70 },
      { id: 'drawer', label: 'Under-counter drawer', w: 30, d: 24, h: 34.5, clear: { front: 24 } },
      { id: 'built-in', label: 'Built-in (in a tall cabinet)', w: 30, d: 22, mount: 'overhead', z0: 36, h: 56 },
    ],
  },
  hood: {
    name: 'Range hood', category: 'kitchen', symbol: 'hood', mount: 'overhead', wall: true, cutsTrim: true, takeoff: 'Appliances', z0: 60,
    sizes: [{ id: '30', label: '30"', w: 30, d: 20, h: 84 }, { id: '36', label: '36"', w: 36, d: 22, h: 84 }],
  },

  // Bathroom ---------------------------------------------------------------
  toilet: {
    name: 'Toilet', category: 'bath', symbol: 'toilet', wall: true, takeoff: 'Fixtures', centerline: 15, clear: { front: 21 },
    sizes: [
      { id: 'elongated', label: 'Elongated, floor mount', w: 20, d: 30, h: 30 },
      { id: 'round', label: 'Round-front compact', w: 18, d: 27, h: 30, bowl: 'round' },
      { id: 'wall-hung', label: 'Wall-hung, concealed tank', w: 15, d: 22, h: 16, tank: false },
    ],
  },
  bidet: { name: 'Bidet', category: 'bath', symbol: 'bidet', wall: true, takeoff: 'Fixtures', centerline: 15, clear: { front: 21 }, sizes: [{ id: 'std', label: 'Freestanding', w: 15, d: 24, h: 16 }] },
  'bath-vanity': {
    name: 'Bathroom vanity', category: 'bath', symbol: 'vanity', wall: true, cutsTrim: true, takeoff: 'Fixtures', clear: { front: 21 },
    sizes: [
      ...[24, 30, 36, 48].map((w) => ({ id: String(w), label: `Single ${w}"`, w, d: 21, h: 34, bowls: 1 })),
      ...[60, 72].map((w) => ({ id: String(w), label: `Double ${w}"`, w, d: 22, h: 34, bowls: 2 })),
    ],
    defaultSize: '36',
  },
  'pedestal-sink': {
    name: 'Pedestal / wall-hung sink', category: 'bath', symbol: 'pedestal', wall: true, takeoff: 'Fixtures', clear: { front: 21 },
    sizes: [{ id: 'pedestal', label: 'Pedestal', w: 22, d: 18, h: 34 }, { id: 'wall-hung', label: 'Wall-hung powder room', w: 20, d: 16, h: 34 }],
  },
  tub: {
    name: 'Alcove bathtub', category: 'bath', symbol: 'tub', wall: true, cutsTrim: true, takeoff: 'Fixtures', clear: { front: 21 },
    sizes: [{ id: '60x30', label: '60" × 30"', w: 60, d: 30, h: 20 }, { id: '60x32', label: '60" × 32"', w: 60, d: 32, h: 20 }],
  },
  'freestanding-tub': {
    name: 'Freestanding soaking tub', category: 'bath', symbol: 'tub', shape: 'round', takeoff: 'Fixtures', clear: { front: 21 },
    sizes: [{ id: '66', label: '66" oval', w: 66, d: 32, h: 24 }, { id: '59', label: '59" oval', w: 59, d: 30, h: 24 }],
  },
  shower: {
    name: 'Shower', category: 'bath', symbol: 'shower', wall: true, cutsTrim: true, takeoff: 'Fixtures', clear: { front: 24 }, options: ['side'],
    sizes: [
      { id: 'square-36', label: 'Corner square 36" × 36"', w: 36, d: 36, h: 80 },
      { id: 'neo-36', label: 'Neo-angle 36"', w: 36, d: 36, h: 80, shape: 'diag', cut: 13 },
      { id: 'neo-42', label: 'Neo-angle 42"', w: 42, d: 42, h: 80, shape: 'diag', cut: 15 },
      { id: 'walk-in', label: 'Walk-in 60" × 36" with glass panel', w: 60, d: 36, h: 80, glass: true },
    ],
  },

  // Office -----------------------------------------------------------------
  desk: {
    name: 'Writing / computer desk', category: 'office', symbol: 'desk', wall: true, under: true, clear: { front: 36 },
    sizes: [{ id: '48', label: '48" × 24"', w: 48, d: 24, h: 30 }, { id: '60', label: '60" × 30"', w: 60, d: 30, h: 30 }],
  },
  'desk-l': {
    name: 'L-shaped desk', category: 'office', symbol: 'desk', shape: 'L', leg: 24, wall: true, under: true, clear: { front: 36 }, options: ['side'],
    sizes: [{ id: '60', label: '60" × 60"', w: 60, d: 60, h: 30 }, { id: '72', label: '72" × 72" executive', w: 72, d: 72, h: 30 }],
  },
  'corner-desk': {
    name: 'Corner desk', category: 'office', symbol: 'desk', shape: 'diag', cut: 24, wall: true, under: true, clear: { front: 36 }, options: ['side'],
    sizes: [{ id: '48', label: '48" × 48"', w: 48, d: 48, h: 30 }],
  },
  'desk-chair': { name: 'Desk chair (swivel circle)', category: 'office', symbol: 'swivel', shape: 'round', tuck: true, sizes: [{ id: 'std', label: 'Ergonomic, 30" swivel', w: 30, d: 30, h: 40 }] },
  'file-cabinet': {
    name: 'Filing cabinet', category: 'office', symbol: 'file', wall: true, clear: { front: 30 },
    sizes: [{ id: 'lateral', label: 'Lateral', w: 36, d: 20, h: 28 }, { id: 'vertical', label: 'Vertical', w: 15, d: 28, h: 52 }],
  },
  shelving: {
    name: 'Shelving unit', category: 'office', symbol: 'shelves', wall: true, clear: { front: 24 },
    sizes: [{ id: '36', label: '36" × 14"', w: 36, d: 14, h: 72 }, { id: '48', label: '48" × 18" wire', w: 48, d: 18, h: 72 }],
  },

  // Laundry, mudroom & utility ---------------------------------------------
  'washer-dryer': {
    name: 'Washer & dryer (side by side)', category: 'utility', symbol: 'laundry-pair', wall: true, takeoff: 'Appliances', clear: { front: 42 },
    sizes: [{ id: '56', label: '56" wide (two 27" units)', w: 56, d: 30, h: 39 }, { id: '60', label: '60" wide', w: 60, d: 32, h: 39 }],
  },
  washer: { name: 'Washing machine', category: 'utility', symbol: 'laundry', wall: true, takeoff: 'Appliances', clear: { front: 42 }, sizes: [{ id: 'std', label: '27"', w: 27, d: 30, h: 39 }] },
  dryer: { name: 'Dryer', category: 'utility', symbol: 'laundry', wall: true, takeoff: 'Appliances', clear: { front: 42 }, sizes: [{ id: 'std', label: '27"', w: 27, d: 30, h: 39 }] },
  'stacked-laundry': { name: 'Stacked washer/dryer', category: 'utility', symbol: 'laundry', wall: true, takeoff: 'Appliances', clear: { front: 36 }, sizes: [{ id: 'std', label: '27" × 30"', w: 27, d: 30, h: 76, stacked: true }] },
  'utility-sink': { name: 'Laundry / utility sink', category: 'utility', symbol: 'pedestal', wall: true, takeoff: 'Fixtures', clear: { front: 21 }, sizes: [{ id: 'std', label: 'Standard', w: 24, d: 22, h: 34 }] },
  'mudroom-bench': {
    name: 'Mudroom bench with hooks / cubbies', category: 'utility', symbol: 'bench', wall: true, cutsTrim: true, clear: { front: 24 },
    sizes: [{ id: '48', label: '48" wide', w: 48, d: 16, h: 72 }, { id: '36', label: '36" wide', w: 36, d: 16, h: 72 }],
  },
  'shoe-rack': {
    name: 'Shoe rack / entry storage', category: 'utility', symbol: 'shelves', wall: true, clear: { front: 18 },
    sizes: [{ id: 'low', label: 'Low rack', w: 30, d: 12, h: 18 }, { id: 'cabinet', label: 'Entry cabinet', w: 36, d: 14, h: 36 }],
  },
  'water-heater': {
    name: 'Water heater', category: 'utility', symbol: 'heater', wall: true, takeoff: 'Mechanical', clear: { front: 30 },
    sizes: [
      { id: '40', label: '40 gal tank', w: 20, d: 20, h: 60, shape: 'round' },
      { id: '50', label: '50 gal tank', w: 22, d: 22, h: 62, shape: 'round' },
      { id: 'tankless', label: 'Tankless (on the wall)', w: 18, d: 8, mount: 'overhead', z0: 48, h: 76 },
    ],
  },
  furnace: {
    name: 'Furnace / air handler', category: 'utility', symbol: 'furnace', wall: true, takeoff: 'Mechanical', clear: { front: 30 },
    sizes: [{ id: 'furnace', label: 'Furnace', w: 22, d: 28, h: 48 }, { id: 'air-handler', label: 'Air handler', w: 24, d: 22, h: 54 }],
  },

  // Rugs & custom ------------------------------------------------------------
  rug: {
    name: 'Area rug', category: 'general', symbol: 'rug', mount: 'rug',
    sizes: [
      { id: '5x8', label: "5' × 8'", w: 60, d: 96 },
      { id: '8x10', label: "8' × 10'", w: 96, d: 120 },
      { id: '9x12', label: "9' × 12'", w: 108, d: 144 },
      { id: 'round-6', label: "6' round", w: 72, d: 72, shape: 'round' },
      { id: 'runner', label: "Runner 2'6\" × 8'", w: 30, d: 96 },
    ],
    defaultSize: '8x10',
  },
  custom: { name: 'Custom item', category: 'general', symbol: 'generic', sizes: [{ id: 'rect', label: 'Rectangle', w: 36, d: 24, h: 30 }, { id: 'round', label: 'Round', w: 36, d: 36, h: 30, shape: 'round' }] },
};

export const TAKEOFF_CATEGORIES = ['Fixtures', 'Appliances', 'Cabinets', 'Mechanical', 'Furniture'];

const SIDES = ['front', 'back', 'left', 'right'];

// ---------------------------------------------------------------------------
// Items

export function defaultSizeId(type) {
  const def = FURNITURE[type];
  return def?.defaultSize ?? def?.sizes[0]?.id ?? null;
}

/** A new item of `type` (size id optional) at plan point p. Dimensions are copied in mm so they can be edited. */
export function createFurniture(type, p, { size = defaultSizeId(type), angle = 0, opts = {} } = {}) {
  const def = FURNITURE[type];
  const sz = def.sizes.find((s) => s.id === size) ?? def.sizes[0];
  return { id: uid('u'), type, size: sz.id, x: p.x, y: p.y, angle, w: sz.w * IN, d: sz.d * IN, opts: { ...opts } };
}

/** Sets an item's size from its catalog entry (dimensions too). */
export function applySize(item, sizeId) {
  const sz = FURNITURE[item.type]?.sizes.find((s) => s.id === sizeId);
  if (!sz) return;
  item.size = sz.id;
  item.w = sz.w * IN;
  item.d = sz.d * IN;
}

export function deleteFurniture(d, id) {
  d.furniture = (d.furniture ?? []).filter((f) => f.id !== id);
}

/** A copy of an item placed beside it (to its right, as seen from the front), so runs of cabinets or chairs are quick to build. */
export function duplicateFurniture(d, id) {
  const f = (d.furniture ?? []).find((x) => x.id === id);
  if (!f) return null;
  const r = resolveItem(f);
  const p = toWorld(r, r.w, 0);
  const copy = { ...structuredClone(f), id: uid('u'), x: p.x, y: p.y };
  d.furniture.push(copy);
  return copy;
}

/** Vertical extent [bottom, top] of an item (mm), for deciding which items can share floor space. */
export function heightRange(r) {
  if (r.mount === 'rug') return [0, 0];
  if (r.mount === 'counter') return [34 * IN, 36 * IN];
  return [r.z0, Math.max(r.z0 + 1, r.h)];
}

/**
 * Where items that cut trim (resolveItem().cutsTrim) stand against a wall
 * face: [{ s0, s1, bottom, top, itemId, name }] in face coordinates. An item
 * counts where its footprint is within an inch of the face (or a little into
 * the wall), over the height it takes up; counter-mounted items (sinks,
 * cooktops) and rugs never do, as the cabinet under them already has.
 */
export function trimObstructions(d, face) {
  const out = [];
  const inward = { x: -face.outward.x, y: -face.outward.y };
  for (const item of d.furniture ?? []) {
    const r = resolveItem(item);
    if (!r.cutsTrim || r.mount === 'counter' || r.mount === 'rug') continue;
    // The part of the footprint in a thin strip along the face.
    let poly = footprint(r).outline;
    poly = clipHalfPlane(poly, (p) => dot(sub(p, face.P), inward) + TRIM_REACH_BEHIND);
    poly = clipHalfPlane(poly, (p) => TRIM_REACH - dot(sub(p, face.P), inward));
    if (poly.length < 3) continue;
    const ss = poly.map((p) => dot(sub(p, face.P), face.dir));
    const s0 = Math.max(0, Math.min(...ss));
    const s1 = Math.min(face.length, Math.max(...ss));
    if (s1 - s0 < 1) continue;
    const [bottom, top] = heightRange(r);
    out.push({ s0, s1, bottom, top, itemId: item.id, name: r.name });
  }
  return out.sort((a, b) => a.s0 - b.s0);
}

const TRIM_REACH = 1 * IN; // how far off a wall an item can stand and still cut its trim
const TRIM_REACH_BEHIND = 2 * IN; // or how far it may overlap into the wall

/** The part of a polygon where f(p) ≥ 0, for a linear f (Sutherland–Hodgman against one edge). */
function clipHalfPlane(poly, f) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

export function sanitizeFurniture(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((f) => f && typeof f.id === 'string' && FURNITURE[f.type] && [f.x, f.y, f.w, f.d].every(Number.isFinite) && f.w > 0 && f.d > 0)
    .map((f) => ({ ...f, angle: Number.isFinite(f.angle) ? f.angle : 0, opts: f.opts && typeof f.opts === 'object' ? f.opts : {} }));
}

/**
 * Everything about an item that comes from the catalog, merged with its
 * own size, options and overrides (lengths in mm): shape, mount, heights,
 * clearances, and its frame (ux = across, uy = toward the front).
 */
export function resolveItem(item) {
  const def = FURNITURE[item.type] ?? FURNITURE.custom;
  const sz = def.sizes.find((s) => s.id === item.size) ?? {};
  const pick = (k, fallback) => sz[k] ?? def[k] ?? fallback;
  const opts = item.opts ?? {};
  const extended = !!(opts.extended && sz.ext);
  const w = extended ? Math.max(item.w, sz.ext * IN) : item.w;
  const clear = {};
  const base = { ...(def.clear ?? {}), ...(sz.clear ?? {}) };
  for (const s of SIDES) {
    const v = opts.clear?.[s] ?? (base[s] != null ? base[s] * IN : 0);
    clear[s] = Number.isFinite(v) ? Math.max(0, v) : 0;
  }
  const centerline = pick('centerline', null);
  if (centerline != null) {
    // Toilets and bidets: so far from the centreline to anything beside them.
    for (const s of ['left', 'right']) if (opts.clear?.[s] == null) clear[s] = Math.max(0, centerline * IN - w / 2);
  }
  const a = ((item.angle ?? 0) * Math.PI) / 180;
  const ux = { x: Math.cos(a), y: Math.sin(a) };
  const mount = pick('mount', 'floor');
  return {
    item, def, sizeDef: sz, type: item.type, w, d: item.d, extended,
    name: item.label?.trim() || def.name,
    sizeLabel: item.size === 'custom' || !sz.label ? null : sz.label,
    shape: pick('shape', 'rect'), leg: pick('leg', 24) * IN, cut: pick('cut', 12) * IN, side: opts.side === 'left' ? 'left' : 'right',
    mount, h: pick('h', 30) * IN, z0: mount === 'overhead' ? pick('z0', 54) * IN : 0,
    cutsTrim: typeof opts.cutsTrim === 'boolean' ? opts.cutsTrim : !!pick('cutsTrim', false),
    clear, oneSide: !!pick('oneSide', false), sideFrom: pick('sideFrom', 0) * IN,
    tuck: !!def.tuck, under: !!def.under, counter: !!def.counter, wall: !!def.wall,
    seats: extended ? sz.extSeats ?? sz.seats ?? 0 : sz.seats ?? def.seats ?? 0,
    screen: pick('screen', null) ?? (item.type === 'tv-stand' ? opts.screen ?? 55 : null),
    takeoff: def.takeoff ?? 'Furniture',
    c: { x: item.x, y: item.y }, ux, uy: perp(ux),
  };
}

/** Plan point of local (lx, ly). */
export function toWorld(r, lx, ly) {
  return { x: r.c.x + r.ux.x * lx + r.uy.x * ly, y: r.c.y + r.ux.y * lx + r.uy.y * ly };
}

/** Local coordinates of plan point p. */
export function toLocal(r, p) {
  const v = sub(p, r.c);
  return { x: dot(v, r.ux), y: dot(v, r.uy) };
}

const rectPts = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const mirror = (pts) => pts.map((p) => ({ x: -p.x, y: p.y })).reverse();

/**
 * The footprint in local coordinates: `outline` (one polygon, for drawing
 * and hit tests) and `parts` (convex pieces, for overlap areas).
 */
export function localShape(r) {
  const { w, d, shape } = r;
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  if (shape === 'round') {
    const pts = [];
    for (let i = 0; i < 32; i++) pts.push({ x: (Math.cos((i / 32) * 2 * Math.PI) * w) / 2, y: (Math.sin((i / 32) * 2 * Math.PI) * d) / 2 });
    return { outline: pts, parts: [pts] };
  }
  if (shape === 'L') {
    // Bar along the back, leg down the right side to the front (or the left).
    const a = Math.min(r.leg, d);
    const b = Math.min(r.leg, w);
    let outline = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x1 - b, y: y1 }, { x: x1 - b, y: y0 + a }, { x: x0, y: y0 + a }];
    let parts = [rectPts(x0, y0, x1, y0 + a), rectPts(x1 - b, y0 + a, x1, y1)];
    if (r.side === 'left') {
      outline = mirror(outline);
      parts = parts.map(mirror);
    }
    return { outline, parts };
  }
  if (shape === 'U') {
    const a = Math.min(r.leg, d);
    const b = Math.min(r.leg, w / 2);
    const outline = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x1 - b, y: y1 }, { x: x1 - b, y: y0 + a }, { x: x0 + b, y: y0 + a }, { x: x0 + b, y: y1 }, { x: x0, y: y1 }];
    return { outline, parts: [rectPts(x0, y0, x1, y0 + a), rectPts(x0, y0 + a, x0 + b, y1), rectPts(x1 - b, y0 + a, x1, y1)] };
  }
  if (shape === 'corner') {
    // Legs along the back and the left (a corner at the back left), or the right.
    const a = Math.min(r.leg, d);
    const b = Math.min(r.leg, w);
    let outline = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y0 + a }, { x: x0 + b, y: y0 + a }, { x: x0 + b, y: y1 }, { x: x0, y: y1 }];
    let parts = [rectPts(x0, y0, x1, y0 + a), rectPts(x0, y0 + a, x0 + b, y1)];
    if (r.side === 'right') {
      outline = mirror(outline);
      parts = parts.map(mirror);
    }
    return { outline, parts };
  }
  if (shape === 'diag') {
    // Square with the front corner away from the walls cut off on the diagonal (corner at the back left).
    const k = Math.min(r.cut, w, d);
    let outline = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 - k }, { x: x1 - k, y: y1 }, { x: x0, y: y1 }];
    if (r.side === 'right') outline = mirror(outline);
    return { outline, parts: [outline] };
  }
  const pts = rectPts(x0, y0, x1, y1);
  return { outline: pts, parts: [pts] };
}

/** Footprint in plan coordinates: { outline, parts }. */
export function footprint(r) {
  const s = localShape(r);
  const map = (pts) => pts.map((p) => toWorld(r, p.x, p.y));
  return { outline: map(s.outline), parts: s.parts.map(map) };
}

/**
 * Clearance zones in plan coordinates, one rectangle per side that needs
 * clear floor: [{ side, depth, poly }]. Side zones of a bed start past the
 * nightstands (sideFrom).
 */
export function clearanceZones(r) {
  const { w, d, clear } = r;
  const out = [];
  for (const side of SIDES) {
    const c = clear[side];
    if (!(c > 0)) continue;
    const local = side === 'front' ? rectPts(-w / 2, d / 2, w / 2, d / 2 + c)
      : side === 'back' ? rectPts(-w / 2, -d / 2 - c, w / 2, -d / 2)
        : side === 'left' ? rectPts(-w / 2 - c, -d / 2 + r.sideFrom, -w / 2, d / 2)
          : rectPts(w / 2, -d / 2 + r.sideFrom, w / 2 + c, d / 2);
    out.push({ side, depth: c, poly: local.map((p) => toWorld(r, p.x, p.y)) });
  }
  return out;
}

/** Outward normal, along-edge direction, half-length and offset of a side's edge (plan frame). */
function sideFrame(r, side) {
  if (side === 'front') return { n: r.uy, t: r.ux, half: r.w / 2, off: r.d / 2, from: 0 };
  if (side === 'back') return { n: scale(r.uy, -1), t: r.ux, half: r.w / 2, off: r.d / 2, from: 0 };
  // Sides run back → front; the span may start past the nightstands.
  const n = side === 'left' ? scale(r.ux, -1) : r.ux;
  return { n, t: r.uy, half: r.d / 2, off: r.w / 2, from: r.sideFrom };
}

/**
 * Clear distance from one side of an item to the nearest obstacle segment
 * ({a, b}) within the strip straight out from that side, up to `max`.
 * Returns { dist, at } (at: the nearest obstacle point), dist = max when clear.
 */
export function sideDistance(r, side, segments, max) {
  const f = sideFrame(r, side);
  const u0 = -f.half + f.from + 0.5;
  const u1 = f.half - 0.5;
  let best = max;
  let at = null;
  for (const s of segments) {
    const pa = sub(s.a, r.c);
    const pb = sub(s.b, r.c);
    const A = { u: dot(pa, f.t), v: dot(pa, f.n) - f.off };
    const B = { u: dot(pb, f.t), v: dot(pb, f.n) - f.off };
    // Clip A→B (parameter t) to u0 ≤ u ≤ u1 and -0.5 ≤ v ≤ best.
    let t0 = 0;
    let t1 = 1;
    const clip = (p, q) => { // keep p + (q - p)·t ≥ 0
      if (Math.abs(q - p) < 1e-12) return p >= 0;
      const t = -p / (q - p);
      if (q > p) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      return t0 <= t1;
    };
    if (!clip(A.u - u0, B.u - u0) || !clip(u1 - A.u, u1 - B.u) || !clip(A.v + 0.5, B.v + 0.5) || !clip(best - A.v, best - B.v)) continue;
    for (const t of [t0, t1]) {
      const v = A.v + (B.v - A.v) * t;
      if (v < best) {
        best = Math.max(0, v);
        const u = A.u + (B.u - A.u) * t;
        at = add(r.c, add(scale(f.t, u), scale(f.n, f.off + v)));
      }
    }
  }
  return { dist: best, at };
}

const edges = (poly) => poly.map((p, i) => ({ a: p, b: poly[(i + 1) % poly.length] }));

/** Sutherland–Hodgman: subject polygon clipped by a convex polygon (either winding). */
function clipConvex(subject, clipPoly) {
  const sign = polygonArea(clipPoly) >= 0 ? 1 : -1;
  let out = subject;
  for (let i = 0; i < clipPoly.length && out.length; i++) {
    const a = clipPoly[i];
    const b = clipPoly[(i + 1) % clipPoly.length];
    const inside = (p) => sign * cross(sub(b, a), sub(p, a)) >= 0;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const pin = inside(p);
      const qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const hit = segmentIntersection(p, q, a, b);
        if (hit) out.push(hit.point);
      }
    }
  }
  return out;
}

/** Overlap area of two sets of convex parts. */
export function overlapArea(partsA, partsB) {
  let area = 0;
  for (const a of partsA) for (const b of partsB) {
    const c = clipConvex(a, b);
    if (c.length >= 3) area += Math.abs(polygonArea(c));
  }
  return area;
}

// ---------------------------------------------------------------------------
// Placing

export const wrapAngle = (deg) => {
  let a = deg % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return Math.round(a * 1000) / 1000;
};

/** Plan-axis bounding box of an item. */
export function itemBounds(r) {
  const pts = footprint(r).outline;
  return {
    minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/** Picks the target nearest `v` within tol: { v, target } or null. */
function nearest(v, targets, tol) {
  let best = null;
  for (const t of targets) {
    const dv = Math.abs(t.v - v);
    if (dv <= tol && (!best || dv < best.dv)) best = { dv, v: t.v, target: t };
  }
  return best;
}

/**
 * Wall-backed items (beds, cabinets, appliances, toilets...): when the
 * point p is within `reach` of a room wall face, the item turns to face
 * into the room with its back flush on the face, and slides along it,
 * its edges snapping (within tol) to the face's corners, door and window
 * jambs and the items already on that wall (uppers line up with the base
 * cabinets under them), or its centre to the middle of the wall. Returns
 * { x, y, angle, face, guides } or null when no wall is in reach.
 */
export function wallPlacement(d, analysis, item, p, { reach = 300, tol = 50, snap = true } = {}) {
  const probe = resolveItem({ ...item, angle: 0 });
  const w = probe.w;
  const depth = probe.d;
  let best = null;
  for (const g of analysis.rooms) {
    for (const f of g.walls) {
      if (f.length < 1) continue;
      const v = sub(p, f.P);
      const s = dot(v, f.dir);
      const into = -dot(v, f.outward);
      // Only faces on this side of the wall (the point no further in than the wall's centreline).
      if (s < -reach || s > f.length + reach || into < -Math.min(reach, f.thickness / 2) || into > depth / 2 + reach) continue;
      if (!pointInPolygon(add(f.P, add(scale(f.dir, Math.min(Math.max(s, 1), f.length - 1)), scale(f.outward, -1))), g.polygon)) continue;
      // Half how far the point is from the wall, half how far the item would move to sit on it;
      // the wall it already backs onto wins ties, so it doesn't flip round at corners.
      const facing = Math.abs(wrapAngle((Math.atan2(f.dir.y, f.dir.x) * 180) / Math.PI - (item.angle ?? 0))) < 1;
      const score = (Math.abs(into - depth / 2) + Math.max(0, into)) / 2 + Math.max(0, -s, s - f.length) - (facing ? 4 * IN : 0);
      if (!best || score < best.score) best = { score, f, s };
    }
  }
  if (!best) return null;
  const { f } = best;
  const inward = scale(f.outward, -1);
  let s = best.s;
  if (f.length >= w) s = Math.min(Math.max(s, w / 2), f.length - w / 2);
  const guides = [];
  if (snap) {
    // Edge targets along the face: corners, jambs, items touching this face.
    const edgesAt = [{ v: 0, label: 'corner' }, { v: f.length, label: 'corner' }];
    for (const op of f.openings) edgesAt.push({ v: op.s0, label: 'jamb' }, { v: op.s1, label: 'jamb' });
    for (const other of d.furniture ?? []) {
      if (other.id === item.id) continue;
      const pts = footprint(resolveItem(other)).outline.map((q) => ({ s: dot(sub(q, f.P), f.dir), into: -dot(sub(q, f.P), f.outward) }));
      if (Math.min(...pts.map((q) => q.into)) > 2 * IN || Math.max(...pts.map((q) => q.into)) < 0) continue;
      edgesAt.push({ v: Math.min(...pts.map((q) => q.s)), label: 'item' }, { v: Math.max(...pts.map((q) => q.s)), label: 'item' });
    }
    const options = [
      ...edgesAt.map((t) => ({ v: t.v + w / 2, edge: t.v, label: t.label })),
      ...edgesAt.map((t) => ({ v: t.v - w / 2, edge: t.v, label: t.label })),
      { v: f.length / 2, edge: null, label: 'centre' },
    ];
    const hit = nearest(s, options, tol);
    if (hit) {
      s = hit.v;
      const at = hit.target.edge ?? f.length / 2;
      const a = add(f.P, scale(f.dir, at));
      guides.push({ a: add(a, scale(inward, -IN)), b: add(a, scale(inward, depth + 6 * IN)) });
    }
  }
  const c = add(add(f.P, scale(f.dir, s)), scale(inward, depth / 2));
  return { x: c.x, y: c.y, angle: wrapAngle((Math.atan2(f.dir.y, f.dir.x) * 180) / Math.PI), face: f, guides };
}

/**
 * Free placement: the item keeps its angle and, when square to the plan,
 * its edges (or centre) snap within tol to the room's wall faces, guides
 * and the edges and centres of other items. Returns { x, y, guides }.
 */
export function alignPlacement(d, analysis, item, p, { tol = 50 } = {}) {
  const r = resolveItem({ ...item, x: p.x, y: p.y });
  const square = Math.abs(((((item.angle ?? 0) % 90) + 90) % 90)) < 0.01 || Math.abs(((((item.angle ?? 0) % 90) + 90) % 90) - 90) < 0.01;
  if (!square) return { x: p.x, y: p.y, guides: [] };
  const b = itemBounds(r);
  const out = { x: p.x, y: p.y, guides: [] };
  for (const axis of ['x', 'y']) {
    const lo = axis === 'x' ? b.minX : b.minY;
    const hi = axis === 'x' ? b.maxX : b.maxY;
    const mid = (lo + hi) / 2;
    const targets = [];
    for (const g of analysis.rooms) for (const q of g.polygon) targets.push({ v: q[axis], from: q });
    for (const gd of d.guides ?? []) if (gd.axis === axis) targets.push({ v: gd.v, from: null });
    for (const other of d.furniture ?? []) {
      if (other.id === item.id) continue;
      const ob = itemBounds(resolveItem(other));
      const olo = axis === 'x' ? ob.minX : ob.minY;
      const ohi = axis === 'x' ? ob.maxX : ob.maxY;
      const oc = { x: (ob.minX + ob.maxX) / 2, y: (ob.minY + ob.maxY) / 2 };
      for (const v of [olo, ohi, (olo + ohi) / 2]) targets.push({ v, from: oc });
    }
    let best = null;
    for (const [edge, k] of [[lo, 'lo'], [hi, 'hi'], [mid, 'mid']]) {
      const hit = nearest(edge, targets, tol);
      if (hit && (!best || hit.dv < best.dv)) best = { ...hit, shift: hit.v - edge };
    }
    if (best) {
      out[axis] += best.shift;
      const from = best.target.from;
      if (from) {
        const other = axis === 'x' ? 'y' : 'x';
        const a = { [axis]: best.v, [other]: from[other] };
        const bb = { [axis]: best.v, [other]: (axis === 'x' ? (b.minY + b.maxY) / 2 : (b.minX + b.maxX) / 2) };
        out.guides.push({ a, b: bb });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checking a layout

/** Wall faces as segments, with the doorways (doors and cased openings) cut out: you can walk through those. */
function wallSegments(analysis) {
  const out = [];
  for (const g of analysis.rooms) {
    for (const f of g.walls) {
      const gaps = f.openings.filter((op) => op.opening.type !== 'window').map((op) => [Math.max(0, op.s0), Math.min(f.length, op.s1)]).sort((p, q) => p[0] - q[0]);
      let at = 0;
      const pt = (s) => add(f.P, scale(f.dir, s));
      for (const [s0, s1] of gaps) {
        if (s0 > at + 1) out.push({ a: pt(at), b: pt(s0), face: f });
        at = Math.max(at, s1);
      }
      if (f.length > at + 1) out.push({ a: pt(at), b: pt(f.length), face: f });
    }
  }
  return out;
}

/**
 * Where doors need floor: each swinging leaf's sweep (a quarter circle), a
 * barn door's slab path along the wall, and the doorway itself on both
 * sides (18" out) for doors and cased openings. [{ opening, kind, poly }]
 */
export function doorZones(d, analysis = analyze(d)) {
  const zones = [];
  const approach = 18 * IN;
  for (const o of d.openings) {
    if (o.type === 'window') continue;
    const g = openingGeometry(d, o, analysis.idx);
    if (!g) continue;
    const T = g.wall.thickness / 2;
    for (const k of [1, -1]) {
      const a = add(g.start, scale(g.normal, k * T));
      const b = add(g.end, scale(g.normal, k * T));
      zones.push({ opening: o, kind: 'doorway', poly: [a, b, add(b, scale(g.normal, k * approach)), add(a, scale(g.normal, k * approach))] });
    }
    const style = doorStyle(o);
    const side = o.flipY ? -1 : 1;
    const face = scale(g.normal, side * T);
    const sweep = (H, J, radius) => {
      // From the closed position (H → J, along the wall) to open (straight out from the wall).
      const u = norm(sub(J, H));
      const v = scale(g.normal, side);
      const pts = [H];
      for (let i = 0; i <= 8; i++) {
        const t = (i / 8) * (Math.PI / 2);
        pts.push(add(H, add(scale(u, Math.cos(t) * radius), scale(v, Math.sin(t) * radius))));
      }
      return pts;
    };
    if (style === 'single') {
      const H = add(o.flipX ? g.end : g.start, face);
      zones.push({ opening: o, kind: 'swing', poly: sweep(H, add(o.flipX ? g.start : g.end, face), o.width) });
    } else if (style === 'double') {
      const mid = add(g.center, face);
      zones.push({ opening: o, kind: 'swing', poly: sweep(add(g.start, face), mid, o.width / 2) });
      zones.push({ opening: o, kind: 'swing', poly: sweep(add(g.end, face), mid, o.width / 2) });
    } else if (style === 'barn') {
      const slab = o.width + 2 * BARN_OVERLAP;
      const [t0, t1] = o.flipX ? [-BARN_OVERLAP, o.width + slab] : [-slab, o.width + BARN_OVERLAP];
      const at = (t, k) => add(add(g.start, scale(g.dir, t)), scale(g.normal, side * (T + k)));
      zones.push({ opening: o, kind: 'barn', poly: [at(t0, 0), at(t1, 0), at(t1, 3 * IN), at(t0, 3 * IN)] });
    }
  }
  return zones;
}

const SIDE_NAMES = { front: 'in front', back: 'behind', left: 'on the left', right: 'on the right' };

/**
 * Checks every item: overlaps with walls and other items, clearances on
 * each side, door swings and doorways, windows behind tall items, items
 * in dead space or outside the rooms, and counter items off the counter.
 * Also the kitchen work triangle and TV viewing distances per room.
 * Returns { items: [{ r, fp, zones, room, issues, sides }], issues, triangles, tvs }.
 */
export function analyzeLayout(d, analysis = analyze(d)) {
  const units = d.units;
  const L = (mm) => formatLength(mm, units, { precision: 'label' });
  const walls = wallSegments(analysis);
  const doors = doorZones(d, analysis);
  const items = (d.furniture ?? []).map((item) => {
    const r = resolveItem(item);
    const fp = footprint(r);
    const room = analysis.rooms.find((g) => pointInPolygon(r.c, g.polygon)) ?? null;
    return { r, fp, zones: clearanceZones(r), room, issues: [], sides: {} };
  });
  const floor = (x) => x.r.mount === 'floor';
  const issues = [];
  const report = (x, severity, kind, message, others = []) => {
    const issue = { itemId: x.r.item.id, severity, kind, message, others };
    x.issues.push(issue);
    issues.push(issue);
  };

  for (const x of items) {
    const { r } = x;
    const label = r.name;
    // Inside a room, clear of the walls (flush against a wall is fine).
    if (r.mount !== 'overhead') {
      const shrunk = x.fp.parts.map((part) => {
        const c = scale(part.reduce((s, p) => add(s, p), { x: 0, y: 0 }), 1 / part.length);
        return part.map((p) => {
          const v = sub(c, p);
          const l = Math.hypot(v.x, v.y);
          return l > 3 ? add(p, scale(v, 2 / l)) : p;
        });
      });
      const pts = shrunk.flat();
      const inside = pts.every((p) => analysis.rooms.some((g) => pointInPolygon(p, g.polygon)));
      const crosses = shrunk.some((part) => edges(part).some((e) => analysis.rooms.some((g) => edges(g.polygon).some((w) => {
        const hit = segmentIntersection(e.a, e.b, w.a, w.b);
        return hit && hit.t > 0 && hit.t < 1 && hit.u > 0 && hit.u < 1;
      }))));
      if (!x.room && !pts.some((p) => analysis.rooms.some((g) => pointInPolygon(p, g.polygon)))) report(x, 'error', 'outside', `${label} isn't inside a room`);
      else if (!inside || crosses) report(x, r.mount === 'rug' ? 'warn' : 'error', 'wall', `${label} runs into a wall`);
    }
    if (x.room?.dead) report(x, 'warn', 'dead', `${label} is in dead space`);
  }

  // Overlaps between items at the same height: a wall TV can hang over a
  // media console and an upper cabinet over a base cabinet, but not over a
  // tall pantry or a fridge.
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const ma = a.r.mount;
      const mb = b.r.mount;
      if (ma === 'rug' || mb === 'rug') continue;
      if (ma === 'counter' || mb === 'counter') continue; // checked below: they belong on the counter
      if ((a.r.tuck && b.r.under) || (b.r.tuck && a.r.under) || (a.r.tuck && b.r.tuck)) continue;
      const [a0, a1] = heightRange(a.r);
      const [b0, b1] = heightRange(b.r);
      if (Math.min(a1, b1) - Math.max(a0, b0) <= IN / 2) continue;
      if (overlapArea(a.fp.parts, b.fp.parts) > OVERLAP_MM2) {
        report(a, 'error', 'overlap', `${a.r.name} overlaps the ${b.r.name.toLowerCase()}`, [b.r.item.id]);
        report(b, 'error', 'overlap', `${b.r.name} overlaps the ${a.r.name.toLowerCase()}`, [a.r.item.id]);
      }
    }
  }

  // Counter items (sinks, cooktops) sit on base cabinets or an island.
  for (const x of items.filter((y) => y.r.mount === 'counter')) {
    const under = items.filter((y) => y.r.counter);
    const area = Math.abs(x.fp.parts.reduce((s, p) => s + polygonArea(p), 0));
    if (overlapArea(x.fp.parts, under.flatMap((y) => y.fp.parts)) < area * 0.9) report(x, 'warn', 'counter', `${x.r.name} isn't over a base cabinet or island`);
  }

  // Clearances: clear floor straight out from each side (measured on every
  // side, out to 10', for the dimensions on the plan).
  for (const x of items) {
    const { r } = x;
    if (r.mount !== 'floor') continue;
    const obstacles = [...walls];
    for (const y of items) {
      if (y === x || !floor(y) || y.r.tuck) continue;
      obstacles.push(...edges(y.fp.outline).map((e) => ({ ...e, item: y.r.item.id })));
    }
    const short = [];
    for (const side of SIDES) {
      const need = r.clear[side];
      const s = sideDistance(r, side, obstacles, Math.max(GAP_MAX, need + 1));
      x.sides[side] = { need, have: s.dist, at: s.at };
      if (need > 0 && s.dist < need - 0.5 * IN) short.push(side);
    }
    const sideShort = short.filter((s) => s === 'left' || s === 'right');
    const reportSide = (side) => {
      const s = x.sides[side];
      report(x, 'warn', 'clearance', `${r.name}: ${s.have < 1 ? 'nothing' : L(s.have)} clear ${SIDE_NAMES[side]} (${L(s.need)} recommended)`);
    };
    for (const side of short) {
      if ((side === 'left' || side === 'right') && r.oneSide) continue;
      reportSide(side);
    }
    if (r.oneSide && sideShort.length === 2) {
      const best = x.sides.left.have >= x.sides.right.have ? 'left' : 'right';
      report(x, 'warn', 'clearance', `${r.name}: needs ${L(x.sides[best].need)} clear on one side (best is ${L(x.sides[best].have)} ${SIDE_NAMES[best]})`);
    }
  }

  // Door swings, barn door paths and doorways.
  for (const x of items) {
    if (x.r.mount === 'rug' || x.r.mount === 'counter') continue;
    const hits = doors.filter((z) => (x.r.z0 < (z.opening.height ?? Infinity) - IN) && overlapArea(x.fp.parts, [z.poly]) > OVERLAP_MM2);
    const kinds = new Set(hits.map((z) => z.kind));
    if (kinds.has('swing')) report(x, 'error', 'door', `${x.r.name} is in the swing of a door`);
    else if (kinds.has('barn')) report(x, 'error', 'door', `${x.r.name} is in the path of a barn door`);
    else if (kinds.has('doorway')) report(x, 'warn', 'doorway', `${x.r.name} stands in a doorway`);
  }

  // Tall items (or wall units) in front of windows.
  for (const x of items) {
    const { r } = x;
    if (r.mount === 'rug' || r.mount === 'counter') continue;
    for (const g of analysis.rooms) {
      for (const f of g.walls) {
        for (const op of f.openings) {
          if (op.opening.type !== 'window') continue;
          const loc = x.fp.outline.map((p) => ({ s: dot(sub(p, f.P), f.dir), depth: dot(sub(p, f.P), scale(f.outward, -1)) }));
          const near = Math.min(...loc.map((q) => q.depth)) < 8 * IN && Math.max(...loc.map((q) => q.depth)) > -1;
          const s0 = Math.min(...loc.map((q) => q.s));
          const s1 = Math.max(...loc.map((q) => q.s));
          const along = Math.min(s1, op.s1) - Math.max(s0, op.s0) > 2 * IN;
          if (near && along && r.h > op.bottom + IN && r.z0 < op.top - IN) {
            report(x, 'warn', 'window', `${r.name} (${L(r.h)} high) covers a window (sill at ${L(op.bottom)})`);
          }
        }
      }
    }
  }

  return { items, issues, triangles: workTriangles(items, units), tvs: viewingDistances(items, units) };
}

const front = (r) => toWorld(r, 0, r.d / 2);

/**
 * The kitchen work triangle per room: sink, cooktop (range or cooktop) and
 * fridge, measured between the centres of their fronts. NKBA: each leg
 * 4'–9', the three together 13'–26'.
 */
function workTriangles(items, units) {
  const L = (mm) => formatLength(mm, units, { precision: 'label' });
  const out = [];
  const rooms = new Set(items.map((x) => x.room).filter(Boolean));
  for (const room of rooms) {
    const inRoom = items.filter((x) => x.room === room);
    const find = (types) => inRoom.find((x) => types.includes(x.r.type));
    const sink = find(['sink', 'corner-sink']);
    const cook = find(['range', 'cooktop']);
    const fridge = find(['fridge']);
    if (!sink || !cook || !fridge) continue;
    const pts = [front(sink.r), front(cook.r), front(fridge.r)];
    const legs = [
      { name: 'Sink – cooktop', len: dist(pts[0], pts[1]) },
      { name: 'Cooktop – fridge', len: dist(pts[1], pts[2]) },
      { name: 'Fridge – sink', len: dist(pts[2], pts[0]) },
    ];
    const total = legs.reduce((s, l) => s + l.len, 0);
    const problems = [];
    for (const l of legs) {
      if (l.len < 4 * 12 * IN) problems.push(`${l.name} is only ${L(l.len)} (4' minimum)`);
      if (l.len > 9 * 12 * IN) problems.push(`${l.name} is ${L(l.len)} (9' maximum)`);
    }
    if (total < 13 * 12 * IN) problems.push(`the three legs total ${L(total)} (13' minimum)`);
    if (total > 26 * 12 * IN) problems.push(`the three legs total ${L(total)} (26' maximum)`);
    out.push({ roomId: room.room?.id ?? null, room: room.room?.name ?? 'Room', points: pts, legs, total, ok: !problems.length, problems, ids: [sink, cook, fridge].map((x) => x.r.item.id) });
  }
  return out;
}

/**
 * TV viewing distance per TV: to the seat in the same room that faces it
 * most squarely. Comfortable viewing is about 1.2 to 2 times the screen
 * diagonal.
 */
function viewingDistances(items, units) {
  const L = (mm) => formatLength(mm, units, { precision: 'label' });
  const seats = new Set(['sofa', 'loveseat', 'sectional-l', 'sectional-u', 'armchair', 'recliner']);
  const out = [];
  for (const tv of items.filter((x) => x.r.screen)) {
    const p = front(tv.r);
    // Seats in front of the screen and turned toward it, the most squarely facing first.
    const facing = (x) => dot(x.r.uy, norm(sub(p, x.r.c)));
    const candidates = items.filter((x) => x.room === tv.room && seats.has(x.r.type) && dot(sub(x.r.c, p), tv.r.uy) > 0 && facing(x) > 0.5);
    if (!candidates.length) continue;
    const seat = candidates.sort((a, b) => facing(b) - facing(a) || dist(a.r.c, p) - dist(b.r.c, p))[0];
    const diag = tv.r.screen * IN;
    const lo = diag * 1.2;
    const hi = diag * 2;
    const len = dist(seat.r.c, p);
    out.push({
      tvId: tv.r.item.id, seatId: seat.r.item.id, screen: tv.r.screen, distance: len, min: lo, max: hi, ok: len >= lo && len <= hi,
      message: `${seat.r.name} is ${L(len)} from the ${tv.r.screen}" screen (${L(lo)}–${L(hi)} is comfortable)`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Takeoff

/**
 * Takeoff lines: one per type and size, counted (fixtures, appliances,
 * cabinets, mechanical and furniture), plus countertop area over base
 * cabinets, islands and dishwashers. Lines are { key, category, label,
 * quantity, unit, detail } like the rest of the material list.
 */
export function furnitureMaterials(d, analysis = analyze(d)) {
  const units = d.units;
  const L = (mm) => formatLength(mm, units, { precision: 'label' });
  const groups = new Map();
  let counter = 0;
  for (const item of d.furniture ?? []) {
    const r = resolveItem(item);
    const room = analysis.rooms.find((g) => pointInPolygon(r.c, g.polygon));
    if (room?.dead) continue;
    const key = `furn:${item.type}:${Math.round(r.w)}x${Math.round(r.d)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key, category: r.takeoff, type: item.type, count: 0, rooms: new Set(),
        label: `${FURNITURE[item.type].name}${r.sizeLabel ? ` – ${r.sizeLabel}` : ''} (${L(r.w)} × ${L(r.d)})`,
      });
    }
    const g = groups.get(key);
    g.count++;
    if (room?.room) g.rooms.add(room.room.name);
    if (r.counter) counter += Math.abs(footprint(r).parts.reduce((s, p) => s + polygonArea(p), 0));
  }
  const order = (c) => TAKEOFF_CATEGORIES.indexOf(c);
  const lines = [...groups.values()]
    .sort((a, b) => order(a.category) - order(b.category) || a.label.localeCompare(b.label))
    .map((g) => ({ key: g.key, category: g.category, label: g.label, quantity: g.count, unit: 'ea', detail: g.rooms.size ? [...g.rooms].join(', ') : 'Not in a room' }));
  if (counter > 0) {
    lines.push({
      key: 'countertop', category: 'Cabinets', label: 'Countertop (base cabinets, islands, dishwashers)',
      quantity: areaValue(counter, units), unit: areaUnit(units), detail: 'Top area of the cabinet footprints; add overhangs and cut-outs to suit',
    });
  }
  return lines;
}
