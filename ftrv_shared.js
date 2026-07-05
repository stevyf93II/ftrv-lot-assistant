// ftrv_shared.js — single source of truth for the FTRV Lot Helper
// Both ftrv_lot_assistant.html (Grid View) and ftrv_ai_assistant.html (AI Chat) <script src> this file.
// Spec layer per spec-first-thinking: this file is the contract; HTMLs are UI shells.
//
// What lives here (one copy, ever):
//   • SYSTEM_TEMPLATE (the AI translator's system prompt — schema for the filter spec)
//   • BOOL_FILTER_FIELDS, FEATURE_ALIAS (the filter vocabulary)
//   • applyFilterSpec, applyFilterSpecWithFallback, applySort, describeFilterSpec
//   • inventoryReady + alias block (upstream→Lot-Helper field name normalization)
//   • loadCrossStore() (live cross-FTRV-store inventory; Texarkana stays in INVENTORY)
//   • callChat (single /api/chat caller with prompt caching)
//   • getLayout (model-suffix → human-readable layout name)
//
// What stays in each HTML: UI markup, render functions, DOM event wiring, page-specific UX.
//
// FEATURE TRUTH DOCTRINE (2026-07-05): every layout feature FTRV's faceted
// search tracks (bath/kitchen/bedroom/living location, Bunkhouse, King Bed,
// Kitchen Island, U Shaped Dinette, Murphy Bed, Loft, Two Entry/Exit Doors,
// Outdoor Kitchen, Two Bedrooms, Two Full Baths, Bath and a Half, Walk-Thru
// Bath) is sourced EXCLUSIVELY from FTRV's own filter tags via the scraper
// (SITE_FEATURE_TAGS in arklatexrv/scripts/scrape-inventory.mjs). No text
// detectors, no floorplan-code guesses, no aliases for those — guesses were
// catastrophically wrong (front bath: 0/8 overlap; front kitchen: 73 vs 3).

// ─── ENDPOINTS ──────────────────────────────────────────────────────────────
const INVENTORY_URL       = 'https://arklatexrv.com/inventory.json';
const CHAT_ENDPOINT       = 'https://ftrv-lot-assistant.onrender.com/api/chat';
const CROSS_STORE_ENDPOINT = 'https://ftrv-lot-assistant.onrender.com/api/cross-store';

// ─── SYSTEM PROMPT (sales-pro voice; v2 dial-in 2026-05-08) ─────────────────
// AI returns JSON filter spec; JS executes deterministically. The prompt is
// tuned for the Lot Tool's primary use case: sales pro on the lot with a
// customer, NOT buyer self-service. Tone is colleague-briefing, not pitch.
const SYSTEM_TEMPLATE = "You are the FTRV Lot Tool query translator.\n\nPRIMARY USER: an experienced FTRV sales professional standing on the lot with a customer. They are walking 400+ units. The customer is overwhelmed. Units bleed together. Your job: convert what the sales pro learns about the customer's needs into a structured filter spec, then write a CONCISE narrative the pro can use to brief the customer.\n\nThis is NOT a buyer-facing chatbot. Do NOT write salesman copy (\"Here are some great options for you!\"). Do NOT pitch. The pro IS the salesperson — they don't need pitching. Brief them like a colleague who already knows the lot.\n\nOUTPUT FORMAT — respond with EXACTLY this JSON shape and nothing else (no markdown fences, no surrounding text):\n{\n  \"narrative\": \"<concise colleague-briefing of the matches; 1-2 sentences max; surface key differentiators if 2+ candidates; no count claims>\",\n  \"filter\": { ... filter spec, see below ... },\n  \"sortBy\": \"priceNum\"|\"wt\"|\"len\"|\"year\"|\"sl\"|\"gvwr\"|\"garage_ft\"|null,\n  \"sortDir\": \"asc\"|\"desc\",\n  \"limit\": <integer or null — for 'smallest 5w' use 1; 'top 3 X' use 3; otherwise null>,\n  \"likely_zero\": <bool or null — set true if the constraint combo is uncommon enough you suspect it returns 0 (bunkhouse + king bed + under $30k, etc.). When true, narrative should mention which constraint to consider relaxing first.>\n}\n\nNARRATIVE TONE GUIDANCE (this is load-bearing):\n- Concise. 1-2 short sentences. Never a paragraph.\n- Factual, not promotional. \"Bumper-pull bunkhouses under 8500 lbs, lightest first.\" NOT \"Here are some great family-friendly options!\"\n- Surface differentiators when multiple matches likely. \"Top picks differ on length and slide count.\" or \"All 5W; widest range is in length (28-42ft).\"\n- Never use \"perfect for you\" / \"great options\" / \"happy to help\" / \"awesome\" — sales-pro doesn't talk this way.\n- Never claim a count (JS computes that).\n- For likely-zero queries, end with a relaxation hint: \"If 0, try dropping the budget cap.\"\n- For absurd queries (purple unicorn, hot dogs), narrate matter-of-factly: \"Not a model we carry.\" — no smiley wordplay.\n\nFILTER SPEC SCHEMA (omit any field you don't need — NEVER invent fields not listed here; an unknown field silently breaks the search):\n- features: [\"Bunkhouse\",\"King Bed\",...]   ALL of these must be in the unit's feat[]. Closed list (see below). ALL layout facts — bath/kitchen/bedroom/living location, bunkhouse, king bed, island, dinette, murphy, loft, two entry doors, outdoor kitchen, two bedrooms — are features from this list. There are NO location fields (no bath_loc, kit_loc, bed_loc).\n- hitch: \"bumper\"|\"5w\"\n- type: \"Travel Trailer\"|\"Fifth Wheel\"|\"Toy Hauler\"|\"Destination Trailer\"\n- condition: \"New\"|\"Pre-Owned\"\n- Boolean must-haves (set to true to require): fireplace, dishwasher, central_vacuum, off_grid_solar, solar_pkg, wd_installed, wd_prep_only, convection_oven, convection_cooking, on_demand_water, murphy_bed, bunkroom, bunk_private_door, loft, kit_island, kit_pantry, pullout_pantry, kit_residential_fridge, outdoor_kitchen, outdoor_tv, ceiling_fan, theater_seat, hideabed, walkin_shower, walkin_closet, desk, l_shaped_sofa, u_shaped_dinette, jackknife_sofa, power_awning, auto_level, electric_tilt_bed, happi_jac, disc_brakes, third_ac, two_entry_doors\n- minPrice, maxPrice (priceNum, $)\n- minWt, maxWt (dry weight, lbs)\n- minLen, maxLen (feet)\n- minSlp (sleeps)\n- slidesEq (exact slide count) | minSlides | maxSlides\n- minBths (1, 1.5, or 2)\n- minBunks (bunk count)\n- minFridgeCuft (cu ft)\n- minGarage (toy hauler garage feet)\n- elecAmp (30 or 50)\n- minFreshWater, minGreyWater, minBlackWater (gallons)\n- minHitchWt, maxHitchWt (lbs — pin/hitch weight at the hitch ball)\n- minGvwr, maxGvwr (lbs)\n- minCargo (cargo capacity lbs)\n- minLpLbs (LP tank capacity lbs), minLpTanks (count)\n- minFuelGal (toy hauler fuel gallons)\n- minFurnaceBtu, minBurners (cooktop burner count), minAxles, minAwnings\n- stockEq: \"215463\"  (exact stock match)\n- modelContains: \"Brinkley Model G\"  (substring match on brandModel, case-insensitive)\n\nHITCH MAPPING:\n- \"bumper pull\"/\"TT\"/\"travel trailer\"/\"pull behind\" → hitch:\"bumper\" (also includes Destination Trailers, which are bumper-hitch)\n- \"5th wheel\"/\"fifth wheel\"/\"gooseneck\" → hitch:\"5w\"\n\nINSTALLED vs AVAILABLE (critical distinctions):\n- \"W/D installed\"/\"real washer dryer\" → wd_installed:true (NOT W&D Prep, NOT wd_prep_only)\n- \"W/D prep\"/\"plumbing for W/D\"/\"prepped for washer\" → wd_prep_only:true OR features:[\"Washer & Dryer Prep\"]\n- \"off-grid solar\" → off_grid_solar:true\n- \"solar package\"/\"solar panels installed\" → solar_pkg:true\n- \"theater seating\"/\"theater seats\"/\"recliners\"/\"reclining seats\" → theater_seat:true\n- \"walk-in shower\" → walkin_shower:true (separate stall, NOT tub/shower combo)\n- \"residential fridge\"/\"big fridge\" → kit_residential_fridge:true\n- \"pantry\" → kit_pantry:true; \"pullout pantry\" → pullout_pantry:true\n- \"tankless\"/\"on-demand water\" → on_demand_water:true\n- \"convection cooking\"/\"convection capability\" → convection_cooking:true (spec-table; distinct from convection_oven which fires on the oven appliance)\n- \"couples coach\"/\"no bunks\"/\"no kids\"/\"no bunkhouse\"/\"adults only\" → features:[\"Couples Coach\"] (means the unit has no bunkhouse)\n- \"2 bedrooms\"/\"two bedrooms\"/\"two bedroom\"/\"second bedroom\"/\"dual bedroom\"/\"2 bdrm\" → features:[\"Two Bedrooms\"] (bedrooms are queryable ONLY through the Two Bedrooms feature — there is NO bedroom-count field; never emit minBdrms or bdrms)\n- LAYOUT LOCATIONS ARE FEATURES: \"front kitchen\" → features:[\"Front Kitchen\"]; \"rear kitchen\" → features:[\"Rear Kitchen\"]; \"front living\" → features:[\"Front Living\"]; \"rear living\" → features:[\"Rear Living\"]; \"front bedroom\"/\"front master\" → features:[\"Front Bedroom\"]; \"rear bedroom\"/\"rear master\" → features:[\"Rear Bedroom\"]; \"front bath\" → features:[\"Front Bath\"]; \"rear bath\" → features:[\"Rear Bath\"]; \"walk-thru bath\"/\"walk-through bath\" → features:[\"Walk-Thru Bath\"]. NEVER emit bath_loc/kit_loc/bed_loc — those fields do not exist.\n- \"two full baths\"/\"2 full bath\"/\"dual bath\" → features:[\"Two Full Baths\"]; \"bath and a half\"/\"1.5 bath\"/\"half bath\" → minBths:1.5\n- \"loft\"/\"loft bed\"/\"upper sleeping\" → features:[\"Loft\"]\n- \"happi-jac\"/\"happijac\"/\"power bunks\"/\"electric bed lift\" (toy haulers) → happi_jac:true\n- \"disc brakes\"/\"4-wheel disc brakes\" → disc_brakes:true\n- \"3rd A/C\"/\"third A/C\"/\"three roof A/Cs\"/\"triple A/C\" → third_ac:true (set in addition to features:[\"Dual A/C\"] for queries that want exactly 3 A/Cs)\n- \"two entry doors\"/\"two entry/exit doors\"/\"second exterior door\"/\"dual entry doors\"/\"private bunkroom entry\" → features:[\"Two Entry/Exit Doors\"]\n- \"fireplace\"/\"electric fireplace\" → fireplace:true (boolean must-have; not a features[] string — Fireplace is suppressed from feature tags but the boolean is queryable)\n- \"L shaped sofa\"/\"L sofa\"/\"L couch\"/\"corner sofa\"/\"jackknife sofa\"/\"jackknife couch\"/\"jackknife\" → l_shaped_sofa:true (Steve's call: L-shape and jackknife are the same on our lot — either query returns the union of both vision-derived fields. Boolean must-have, NOT a features[] string.)\n- \"L shaped kitchen\"/\"L shaped counter\"/\"L counter\" → no schema field for counter shape — set noMatch:true with note \"We don't track counter shape; try kitchen island or front/rear kitchen instead.\"\n\nTOW VEHICLE WEIGHT HINTS (when customer mentions a vehicle, set maxWt for dry weight AND maxHitchWt for fifth-wheel pin weight):\n- \"F-150\"/\"Ram 1500\"/\"Silverado 1500\"/\"half-ton\"/\"1500\" → maxWt around 7500-8500 (leaves headroom under rated cap)\n- \"F-250\"/\"Ram 2500\"/\"Silverado 2500\"/\"3/4 ton\"/\"2500\" → maxWt around 12000\n- \"F-350\"/\"Ram 3500\"/\"Silverado 3500\"/\"1 ton\"/\"dually\" → maxWt around 18000\n- SUV/midsize without specifics → maxWt 5000\n- If unsure, leave maxWt unset (don't gate the customer artificially)\n\nCONDITION VOCABULARY:\n- \"used\"/\"pre-owned\"/\"second-hand\"/\"trade-in\" → condition:\"Pre-Owned\"\n- \"new\"/\"never used\"/\"current year\" → condition:\"New\"\n\nCLOSED FEATURE LIST (use exact strings ONLY in features array — these match scraper output OR FEATURE_ALIAS):\nBunkhouse, Outdoor Kitchen, Kitchen Island, Front Living, Rear Living, Front Kitchen, Rear Kitchen, Front Bedroom, Rear Bedroom, Two Bedrooms, Front Bath, Rear Bath, Two Full Baths, Bath and a Half, Walk-Thru Bath, Murphy Bed, King Bed, Solar, Solar Prep, Generator, Generator Prep, Auto-Level, Dual A/C, Four Seasons, 12V Fridge, Theater Seating, Power Awning, W/D Prep, Washer/Dryer, U Shaped Dinette, Loft, Happi-Jac, Disc Brakes, Third A/C, Couples Coach, Two Entry/Exit Doors\n\nEXAMPLES (sales-pro voice — note the tone):\nQ: \"5w under 12k dry\"\nA: {\"narrative\":\"5W under 12k dry, lightest first.\",\"filter\":{\"hitch\":\"5w\",\"maxWt\":12000},\"sortBy\":\"wt\",\"sortDir\":\"asc\"}\n\nQ: \"biggest GVWR on the lot\"\nA: {\"narrative\":\"Highest GVWR.\",\"filter\":{},\"sortBy\":\"gvwr\",\"sortDir\":\"desc\",\"limit\":1}\n\nQ: \"cheapest bunkhouse\"\nA: {\"narrative\":\"Cheapest bunkhouse.\",\"filter\":{\"features\":[\"Bunkhouse\"]},\"sortBy\":\"priceNum\",\"sortDir\":\"asc\",\"limit\":1}\n\nQ: \"2 bedrooms under 80k\"\nA: {\"narrative\":\"Two-bedroom units, ≤$80k, cheapest first.\",\"filter\":{\"features\":[\"Two Bedrooms\"],\"maxPrice\":80000},\"sortBy\":\"priceNum\",\"sortDir\":\"asc\"}\n\nQ: \"5th wheel front bath under 80k\"\nA: {\"narrative\":\"5W front-bath units, ≤$80k, cheapest first.\",\"filter\":{\"hitch\":\"5w\",\"features\":[\"Front Bath\"],\"maxPrice\":80000},\"sortBy\":\"priceNum\",\"sortDir\":\"asc\"}\n\nQ: \"front kitchen\"\nA: {\"narrative\":\"Front-kitchen layouts.\",\"filter\":{\"features\":[\"Front Kitchen\"]}}\n\nQ: \"couples coach with king bed and outdoor kitchen under $80k\"\nA: {\"narrative\":\"No-bunk units with king bed + outdoor kitchen, ≤$80k. Differentiators are length and brand.\",\"filter\":{\"features\":[\"Couples Coach\",\"King Bed\",\"Outdoor Kitchen\"],\"maxPrice\":80000}}\n\nQ: \"family of 6, half-ton truck, around $40k, must have a bunkhouse\"\nA: {\"narrative\":\"Bunkhouses sleeping 6+, half-ton-towable, ≤$40k.\",\"filter\":{\"features\":[\"Bunkhouse\"],\"hitch\":\"bumper\",\"maxWt\":8500,\"minSlp\":6,\"maxPrice\":40000}}\n\nQ: \"stock 215463\"\nA: {\"narrative\":\"Stock #215463.\",\"filter\":{\"stockEq\":\"215463\"}}\n\nQ: \"show me the Brinkley Model G 4100\"\nA: {\"narrative\":\"Brinkley Model G 4100.\",\"filter\":{\"modelContains\":\"Brinkley Model G 4100\"}}\n\nQ: \"toy hauler with at least 14 ft garage and 50 amp service\"\nA: {\"narrative\":\"Toy haulers, 14ft+ garage, 50-amp.\",\"filter\":{\"type\":\"Toy Hauler\",\"minGarage\":14,\"elecAmp\":50}}\n\nQ: \"toy hauler with happi-jac and disc brakes\"\nA: {\"narrative\":\"Toy haulers with Happi-Jac power bunks + disc brakes.\",\"filter\":{\"type\":\"Toy Hauler\",\"happi_jac\":true,\"disc_brakes\":true}}\n\nQ: \"bumper pull under 7500 lbs sleeping 6\"\nA: {\"narrative\":\"Bumper-pull, ≤7500 dry, sleeps 6+.\",\"filter\":{\"hitch\":\"bumper\",\"maxWt\":7500,\"minSlp\":6}}\n\nQ: \"bunkhouse with king bed under 30k\"\nA: {\"narrative\":\"Bunkhouse + king bed, ≤$30k. Tight combo — if 0 returned, drop the budget cap first.\",\"filter\":{\"features\":[\"Bunkhouse\",\"King Bed\"],\"maxPrice\":30000},\"likely_zero\":true}\n\nQ: \"purple unicorn rv\"\nA: {\"narrative\":\"Not a model we carry.\",\"filter\":{},\"noMatch\":true}\n\nQ: \"do you sell hot dogs\"\nA: {\"narrative\":\"Not on the lot.\",\"filter\":{},\"noMatch\":true}\n\nQ: \"front bedroom rear bath theater seat under 100k\"\nA: {\"narrative\":\"Front bedroom, rear bath, theater seating, ≤$100k.\",\"filter\":{\"features\":[\"Front Bedroom\",\"Rear Bath\"],\"theater_seat\":true,\"maxPrice\":100000}}\n\nQ: \"bunkhouse with walk-in shower and pantry\"\nA: {\"narrative\":\"Bunkhouse + walk-in shower + pantry.\",\"filter\":{\"features\":[\"Bunkhouse\"],\"walkin_shower\":true,\"kit_pantry\":true}}\n\nQ: \"5w with washer/dryer just prepped not installed\"\nA: {\"narrative\":\"5W with W/D plumbing prep (not installed).\",\"filter\":{\"hitch\":\"5w\",\"wd_prep_only\":true}}\n\nRULES:\n- For absurd/impossible queries (purple unicorn, hot dogs, RV that flies), include \"noMatch\":true. Empty filter {} alone returns ALL units — use noMatch:true to return zero.\n- RESPOND WITH JSON ONLY — no prose, no markdown.\n- NEVER include unit-specific stock numbers in the narrative — JS computes the actual list.\n- ONLY use filter fields from the schema above. Never invent a field (minBdrms, bdrms, bath_loc, kit_loc, bed_loc, etc.) — unknown fields silently break the search.\n- Set likely_zero:true when constraints are tight (3+ filters, narrow price band, multiple boolean must-haves). Hint at which to relax in the narrative.\n- Narrative tone: concise colleague briefing, NOT customer-pitch. Surface differentiators between top candidates when 2+ likely match.\n";

// ─── LAYOUT DETECTION ───────────────────────────────────────────────────────
function getLayout(brandModel) {
  const m = (brandModel || '').toUpperCase();
  if (/\b\d*FL\b/.test(m) || /FRONT.?LIV/i.test(m))         return 'Front Living';
  if (/\b\d*RL[BST]?\b/.test(m) || /REAR.?LIV/i.test(m))    return 'Rear Living';
  if (/\b\d*(RK|RKFB|RKS|RKT)\b/.test(m))                    return 'Rear Kitchen';
  if (/\b\d*(FK[DK]?|FKW)\b/.test(m))                        return 'Front Kitchen';
  if (/\b\d*(MK|MKT|MKS)\b/.test(m))                         return 'Mid Kitchen';
  if (/\b\d*(QUAD)\b/.test(m) || /4.?BEDROOM/i.test(m))      return 'Quad/4-Bedroom';
  if (/\b\d*(TB|TBH|3BH)\b/.test(m))                         return 'Triple Bunk';
  if (/\b\d*(DBH|DB[SL]?|DBLE)\b/.test(m))                   return 'Double Bunk';
  if (/\b\d*(BH[SLF]?|BHS|BHK|BHSL|BHKSE)\b/.test(m))       return 'Bunkhouse';
  if (/\b\d*BH\b/.test(m))                                    return 'Bunkhouse';
  if (/\b\d*(DRL|DLR)\b/.test(m))                             return 'Double Rear Living';
  if (/\b\d*(MBS|MDS|MB)\b/.test(m))                         return 'Master Suite';
  if (/\b\d*(CK|QBC)\b/.test(m))                              return 'Corner Kitchen';
  if (/\b\d*(RBS|RBD)\b/.test(m))                             return 'Rear Bath Suite';
  if (/\b\d*(VFD|VIEW|VIEWX)\b/.test(m))                      return 'View/Panoramic';
  if (/\b\d*FAM\b/.test(m))                                   return 'Family Suite';
  if (/\b\d*SB\b/.test(m))                                    return 'Side Bath';
  if (/\b\d*(ZEN|ICE)\b/.test(m))                             return 'Open Concept';
  return '';
}

// ─── INVENTORY LOAD + ALIAS BLOCK ───────────────────────────────────────────
// Texarkana-only inventory from arklatexrv.com (the canonical regional source).
let FTRV_DATA = {};
let INVENTORY = [];

// Cross-store inventory (live fan-out across the 9 non-Texarkana FTRV stores).
// Loaded on demand the first time the toggle flips ON. Cached in-memory for
// the page lifetime; refreshed when toggle is flipped OFF then ON again.
let CROSS_STORE_INVENTORY = [];
let CROSS_STORE_LOADED_AT = 0;

const inventoryReady = (async () => {
  const r = await fetch(INVENTORY_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error('inventory HTTP ' + r.status);
  const data = await r.json();
  const units = data.units || data;
  for (const u of units) aliasUnit(u);
  for (const u of units) FTRV_DATA[u.stock] = u;
  INVENTORY = Object.values(FTRV_DATA);
  const badge = document.getElementById('unitBadge');
  if (badge) badge.textContent = INVENTORY.length + ' units';
  const totalCount = document.getElementById('totalCount');
  if (totalCount) totalCount.textContent = INVENTORY.length;
  return INVENTORY;
})();

inventoryReady.catch(e => {
  console.error('Inventory load failed:', e);
  const badge = document.getElementById('unitBadge');
  if (badge) badge.textContent = 'load error';
  const grid = document.getElementById('grid');
  if (grid) grid.innerHTML = '<div class="empty"><h2>Couldn\'t load inventory from arklatexrv.com</h2><div>' + (e.message || e) + '</div></div>';
});

// Apply field aliases to a unit. Used for both Texarkana and cross-store data.
function aliasUnit(u) {
  u.stock = u.stock || u.stock_number || (u.unit_id && u.product_id ? (u.unit_id + '-' + u.product_id) : null);
  const sp = u.sale_price;
  u.priceNum = (typeof sp === 'number' && sp > 0) ? sp : 0;
  u.price = u.price || (u.priceNum > 0 ? '$' + u.priceNum.toLocaleString() : 'Call');
  u.len = u.len ?? u.length_ft;
  u.length_ft = u.length_ft ?? u.len;
  u.wt = u.wt ?? u.dry_weight_lbs;
  u.dry_weight_lb = u.dry_weight_lb ?? u.dry_weight_lbs ?? u.wt;
  u.slp = u.slp ?? u.sleeps;
  u.sleeps = u.sleeps ?? u.slp;
  u.sl = u.sl ?? u.slides;
  u.slides = u.slides ?? u.sl;
  u.bths = u.bths ?? u.bath_count;
  u.detailUrl = u.detailUrl || u.source_url || u.url;
  u.photoUrl = u.photoUrl || u.photo_url;
  u.floorplanUrl = u.floorplanUrl || u.floorplan_url;
  u.brandModel = u.brandModel || [u.manufacturer, u.brand, u.model, u.floorplan].filter(Boolean).join(' ').replace(/\s+/g,' ').trim() || u.title || '';
  u.desc = u.desc || u.description_text || '';
  u.fresh_gal = u.fresh_gal ?? u.fresh_water_gal;
  u.grey_gal = u.grey_gal ?? u.grey_water_gal;
  u.black_gal = u.black_gal ?? u.black_water_gal;
  u.garage_ft = u.garage_ft ?? u.garage_size_ft;
  u.amp = u.amp ?? u.electrical_amp;
  u.gvwr = u.gvwr ?? u.gvwr_lb;
  u.hitch_wt = u.hitch_wt ?? u.hitch_weight_lb;
  u.cargo = u.cargo ?? u.cargo_capacity_lb;
  u.furnace = u.furnace ?? u.furnace_btu;
  u.bunks = u.bunks ?? u.bunks_count;
  u.burners = u.burners ?? u.cooktop_burners;
  u.awnings = u.awnings ?? u.awning_count;
  u.axles = u.axles ?? u.axle_count;
  u.lp_tanks = u.lp_tanks ?? u.lp_tank_count;
  u.lp_lbs = u.lp_lbs ?? u.lp_tank_lbs;
  u.fuel_gal = u.fuel_gal ?? u.fuel_capacity_gal;
  u.baths = u.baths != null ? u.baths : (u.bths != null ? u.bths : 1);
  u.layout = u.layout || '';
  u.hitch = u.hitch || (u.type === 'Fifth Wheel' ? '5w' : 'bumper');
  // Steve (2026-05-07): L-shaped sofa and jackknife sofa are the same thing in his shop context.
  // Vision returns them as separate fields; union them so either query returns the same set.
  const lOrJ = u.l_shaped_sofa === true || u.jackknife_sofa === true;
  u.l_shaped_sofa = lOrJ;
  u.jackknife_sofa = lOrJ;
  return u;
}

// Load the cross-store inventory live from /api/cross-store. Caches in
// CROSS_STORE_INVENTORY for the page lifetime. Returns the unit list.
async function loadCrossStore() {
  const r = await fetch(CROSS_STORE_ENDPOINT, { cache: 'no-cache' });
  if (!r.ok) throw new Error('cross-store HTTP ' + r.status);
  const data = await r.json();
  const flat = [];
  const results = data.results || {};
  for (const store of Object.keys(results)) {
    for (const u of results[store].units || []) {
      flat.push(aliasUnit({ ...u, _store: store }));
    }
  }
  CROSS_STORE_INVENTORY = flat;
  CROSS_STORE_LOADED_AT = Date.now();
  return flat;
}

// Pick the right inventory based on toggle state. crossStore=true returns
// cross-store data (must be loaded first via loadCrossStore); else returns
// Texarkana-only INVENTORY.
function currentInventory(crossStore) {
  return crossStore ? CROSS_STORE_INVENTORY : INVENTORY;
}

// ─── FILTER VOCABULARY ──────────────────────────────────────────────────────
const BOOL_FILTER_FIELDS = ['fireplace','dishwasher','central_vacuum','off_grid_solar','wd_installed','murphy_bed','kit_island','outdoor_kitchen','auto_level','solar_pkg','walkin_shower','bunkroom','hideabed','on_demand_water','convection_oven','convection_cooking','kit_pantry','kit_residential_fridge','power_awning','outdoor_tv','ceiling_fan','pullout_pantry','wd_prep_only','walkin_closet','theater_seat','desk','bunk_private_door','l_shaped_sofa','u_shaped_dinette','jackknife_sofa','electric_tilt_bed','loft','happi_jac','disc_brakes','third_ac','two_entry_doors'];

// FEATURE_ALIAS (2026-07-05): layout features that FTRV's faceted filters
// track have NO aliases — they exist only as scraper-emitted site-truth
// features[] strings. Aliases remain only for semantics FTRV doesn't filter
// on directly. "Couples Coach" = no Bunkhouse site tag.
const FEATURE_ALIAS = {
  "Couples Coach":            u => !((u.features || []).includes('Bunkhouse')),
  "Couples Coach - No Bunks": u => !((u.features || []).includes('Bunkhouse')),
  "Happi-Jac":         u => u.happi_jac === true,
  "Disc Brakes":       u => u.disc_brakes === true,
  "Third A/C":         u => u.third_ac === true
};

function hasFeature(u, f) {
  if ((u.features || []).includes(f)) return true;
  const fn = FEATURE_ALIAS[f];
  return fn ? fn(u) : false;
}

// ─── DETERMINISTIC EXECUTION ────────────────────────────────────────────────
function applyFilterSpec(spec, startList) {
  spec = spec || {};
  let list = startList ? startList.slice() : INVENTORY.slice();

  if (spec.features && spec.features.length) {
    list = list.filter(u => spec.features.every(f => hasFeature(u, f)));
  }
  if (spec.hitch) list = list.filter(u => u.hitch === spec.hitch);
  if (spec.type) {
    const PARENT_TYPES = ["Toy Hauler", "Motor Home"];
    if (PARENT_TYPES.includes(spec.type)) {
      list = list.filter(u => (u.type || "").startsWith(spec.type));
    } else {
      list = list.filter(u => u.type === spec.type);
    }
  }
  if (spec.condition) list = list.filter(u => u.condition === spec.condition);

  if (spec.recliners === true) list = list.filter(u => u.theater_seat === true);
  if (spec.theater_inst === true) list = list.filter(u => u.theater_seat === true);

  for (const f of BOOL_FILTER_FIELDS) {
    if (spec[f] === true) list = list.filter(u => u[f] === true);
  }

  // Location guesses retired 2026-07-05 — FTRV site feature tags are truth.
  // Legacy/cached specs that still emit *_loc fields map to the truth features.
  if (spec.kit_loc) {
    if (spec.kit_loc === 'front')      list = list.filter(u => hasFeature(u, 'Front Kitchen'));
    else if (spec.kit_loc === 'rear')  list = list.filter(u => hasFeature(u, 'Rear Kitchen'));
    else                               list = list.filter(u => u.kit_loc === spec.kit_loc);
  }
  if (spec.bed_loc) {
    if (spec.bed_loc === 'front')      list = list.filter(u => hasFeature(u, 'Front Bedroom'));
    else if (spec.bed_loc === 'rear')  list = list.filter(u => hasFeature(u, 'Rear Bedroom'));
    else                               list = list.filter(u => u.bed_loc === spec.bed_loc);
  }
  if (spec.bath_loc) {
    if (spec.bath_loc === 'front')      list = list.filter(u => hasFeature(u, 'Front Bath'));
    else if (spec.bath_loc === 'rear')  list = list.filter(u => hasFeature(u, 'Rear Bath'));
    else                                list = list.filter(u => u.bath_loc === spec.bath_loc);
  }

  if (spec.minPrice != null) list = list.filter(u => (u.priceNum || 0) >= spec.minPrice);
  if (spec.maxPrice != null) list = list.filter(u => (u.priceNum || 0) > 0 && u.priceNum <= spec.maxPrice);
  if (spec.minWt != null) list = list.filter(u => (u.wt || 0) >= spec.minWt);
  if (spec.maxWt != null) list = list.filter(u => (u.wt || 0) > 0 && u.wt <= spec.maxWt);
  if (spec.minLen != null) list = list.filter(u => (u.len || 0) >= spec.minLen);
  if (spec.maxLen != null) list = list.filter(u => (u.len || 0) > 0 && u.len <= spec.maxLen);
  if (spec.minSlp != null) list = list.filter(u => (u.slp || 0) >= spec.minSlp);
  if (spec.slidesEq != null) list = list.filter(u => u.sl === spec.slidesEq);
  if (spec.minSlides != null) list = list.filter(u => (u.sl || 0) >= spec.minSlides);
  if (spec.maxSlides != null) list = list.filter(u => (u.sl || 0) <= spec.maxSlides);
  // No unit carries a bdrms count field — the "Two Bedrooms" feature is the real
  // signal. Backstop for legacy/cached specs that still emit minBdrms (2026-07-05 fix:
  // the old (u.bdrms || 1) comparison filtered out the ENTIRE lot).
  if (spec.minBdrms != null && spec.minBdrms >= 2) list = list.filter(u => hasFeature(u, 'Two Bedrooms'));
  if (spec.minBths != null) list = list.filter(u => (u.bths || 1) >= spec.minBths);
  if (spec.minBunks != null) list = list.filter(u => (u.bunks || 0) >= spec.minBunks);
  if (spec.minFridgeCuft != null) list = list.filter(u => (u.fridge_cuft || 0) >= spec.minFridgeCuft);
  if (spec.minGarage != null) list = list.filter(u => (u.garage_ft || 0) >= spec.minGarage);
  if (spec.elecAmp != null) list = list.filter(u => u.amp === spec.elecAmp);
  if (spec.stockEq) list = list.filter(u => u.stock === spec.stockEq);
  if (spec.modelContains) {
    const needle = String(spec.modelContains).toLowerCase();
    list = list.filter(u => (u.brandModel || '').toLowerCase().includes(needle));
  }
  if (spec.minFreshWater != null) list = list.filter(u => (u.fresh_gal || 0) >= spec.minFreshWater);
  if (spec.minGreyWater != null) list = list.filter(u => (u.grey_gal || 0) >= spec.minGreyWater);
  if (spec.minBlackWater != null) list = list.filter(u => (u.black_gal || 0) >= spec.minBlackWater);
  if (spec.minHitchWt != null) list = list.filter(u => (u.hitch_wt || 0) >= spec.minHitchWt);
  if (spec.maxHitchWt != null) list = list.filter(u => (u.hitch_wt || 0) > 0 && u.hitch_wt <= spec.maxHitchWt);
  if (spec.minGvwr != null) list = list.filter(u => (u.gvwr || 0) >= spec.minGvwr);
  if (spec.maxGvwr != null) list = list.filter(u => (u.gvwr || 0) > 0 && u.gvwr <= spec.maxGvwr);
  if (spec.minCargo != null) list = list.filter(u => (u.cargo || 0) >= spec.minCargo);
  if (spec.minLpLbs != null) list = list.filter(u => (u.lp_lbs || 0) >= spec.minLpLbs);
  if (spec.minLpTanks != null) list = list.filter(u => (u.lp_tanks || 0) >= spec.minLpTanks);
  if (spec.minFuelGal != null) list = list.filter(u => (u.fuel_gal || 0) >= spec.minFuelGal);
  if (spec.minFurnaceBtu != null) list = list.filter(u => (u.furnace || 0) >= spec.minFurnaceBtu);
  if (spec.minBurners != null) list = list.filter(u => (u.burners || 0) >= spec.minBurners);
  if (spec.minAxles != null) list = list.filter(u => (u.axles || 0) >= spec.minAxles);
  if (spec.minAwnings != null) list = list.filter(u => (u.awnings || 0) >= spec.minAwnings);
  return list;
}

// 0-match fallback: when applyFilterSpec returns 0, find the SINGLE constraint
// whose removal yields the most matches. Returns:
//   { units: [...], fallback: null }                                       (strict match worked)
//   { units: [...filtered with constraint X dropped], fallback: { dropped, count, dropped_value } }
//   { units: [], fallback: null }                                          (no single drop helps)
function applyFilterSpecWithFallback(spec, startList) {
  const strict = applyFilterSpec(spec, startList);
  if (strict.length > 0) return { units: strict, fallback: null };

  // Try dropping each constraint one at a time. Score by resulting count.
  // Order matters slightly: dropping budget cap is usually less destructive
  // to user intent than dropping a feature, so we surface budget first when tied.
  const candidates = [];
  const tryDrop = (label, dropFn) => {
    const probe = dropFn(spec);
    const matches = applyFilterSpec(probe, startList);
    if (matches.length > 0) candidates.push({ dropped: label, count: matches.length, units: matches, dropped_value: spec[label.split(' ')[0]] });
  };

  // Numeric cap relaxations (most common cause of 0 matches)
  if (spec.maxPrice != null) tryDrop('maxPrice', s => ({ ...s, maxPrice: undefined }));
  if (spec.maxWt != null) tryDrop('maxWt', s => ({ ...s, maxWt: undefined }));
  if (spec.maxLen != null) tryDrop('maxLen', s => ({ ...s, maxLen: undefined }));
  if (spec.minSlp != null) tryDrop('minSlp', s => ({ ...s, minSlp: undefined }));
  if (spec.minBdrms != null) tryDrop('minBdrms', s => ({ ...s, minBdrms: undefined }));
  if (spec.minBths != null) tryDrop('minBths', s => ({ ...s, minBths: undefined }));
  if (spec.minGarage != null) tryDrop('minGarage', s => ({ ...s, minGarage: undefined }));
  if (spec.elecAmp != null) tryDrop('elecAmp', s => ({ ...s, elecAmp: undefined }));

  // Categorical relaxations
  if (spec.hitch) tryDrop('hitch', s => ({ ...s, hitch: undefined }));
  if (spec.type) tryDrop('type', s => ({ ...s, type: undefined }));
  if (spec.condition) tryDrop('condition', s => ({ ...s, condition: undefined }));
  if (spec.bath_loc) tryDrop('bath_loc', s => ({ ...s, bath_loc: undefined }));
  if (spec.kit_loc) tryDrop('kit_loc', s => ({ ...s, kit_loc: undefined }));
  if (spec.bed_loc) tryDrop('bed_loc', s => ({ ...s, bed_loc: undefined }));

  // Drop each must-have feature individually
  if (spec.features && spec.features.length) {
    for (let i = 0; i < spec.features.length; i++) {
      const dropped = spec.features[i];
      tryDrop('feature ' + dropped, s => ({ ...s, features: s.features.filter((_, j) => j !== i) }));
    }
  }
  // Drop each boolean must-have
  for (const f of BOOL_FILTER_FIELDS) {
    if (spec[f] === true) tryDrop('flag ' + f, s => ({ ...s, [f]: undefined }));
  }

  if (!candidates.length) return { units: [], fallback: null };

  // Pick the SINGLE drop yielding the most matches (ties: budget/numeric > flag/feature).
  candidates.sort((a, b) => b.count - a.count);
  const best = candidates[0];
  return {
    units: best.units,
    fallback: {
      dropped: best.dropped,
      dropped_value: best.dropped_value,
      restored_count: best.count,
    },
  };
}

function applySort(list, sortBy, sortDir) {
  if (!sortBy) return list;
  const dir = sortDir === 'desc' ? -1 : 1;
  const arr = list.slice();
  arr.sort((a, b) => {
    const av = a[sortBy], bv = b[sortBy];
    if (sortBy === 'priceNum') {
      const aPrice = av || 0, bPrice = bv || 0;
      if (aPrice === 0 && bPrice === 0) return 0;
      if (aPrice === 0) return 1;
      if (bPrice === 0) return -1;
      return (aPrice - bPrice) * dir;
    }
    const an = (av == null) ? -Infinity : av;
    const bn = (bv == null) ? -Infinity : bv;
    if (typeof an === 'number' && typeof bn === 'number') return (an - bn) * dir;
    return String(an).localeCompare(String(bn)) * dir;
  });
  return arr;
}

function describeFilterSpec(spec, sortBy, sortDir, limit) {
  if (!spec) spec = {};
  const parts = [];
  if (spec.features && spec.features.length) parts.push(spec.features.join(' + '));
  if (spec.hitch === '5w') parts.push('5th wheel');
  if (spec.hitch === 'bumper') parts.push('bumper-pull');
  if (spec.type) parts.push(spec.type);
  if (spec.condition) parts.push(spec.condition);
  for (const f of BOOL_FILTER_FIELDS) {
    if (spec[f] === true) parts.push(f.replace(/_/g, ' '));
  }
  if (spec.bath_loc) parts.push(spec.bath_loc + ' bath');
  if (spec.kit_loc) parts.push(spec.kit_loc + ' kitchen');
  if (spec.bed_loc) parts.push(spec.bed_loc + ' bedroom');
  if (spec.maxPrice != null) parts.push('≤$' + spec.maxPrice.toLocaleString());
  if (spec.minPrice != null) parts.push('≥$' + spec.minPrice.toLocaleString());
  if (spec.maxWt != null) parts.push('≤' + spec.maxWt.toLocaleString() + ' lb dry');
  if (spec.minSlp != null) parts.push('sleeps ' + spec.minSlp + '+');
  if (spec.minBths != null) parts.push(spec.minBths + '+ baths');
  if (spec.minGarage != null) parts.push(spec.minGarage + 'ft+ garage');
  if (spec.elecAmp != null) parts.push(spec.elecAmp + '-amp');
  if (spec.stockEq) parts.push('stock #' + spec.stockEq);
  if (spec.modelContains) parts.push('model: ' + spec.modelContains);
  if (sortBy) {
    const labels = {priceNum:'price', wt:'dry weight', len:'length', year:'year', sl:'slides', gvwr:'GVWR', garage_ft:'garage'};
    parts.push('sorted by ' + (labels[sortBy] || sortBy) + ' ' + (sortDir === 'desc' ? '↓' : '↑'));
  }
  if (limit) parts.push('top ' + limit);
  return parts.join(' · ');
}

// ─── /api/chat CALLER ───────────────────────────────────────────────────────
// callChat(messages) — Texarkana mode (default). The AI returns a filter spec
// keyed to the canonical INVENTORY.
// callChat(messages, { crossStore: true }) — cross-store mode. The user
// message is augmented with a hint so the AI knows we're searching all stores.
async function callChat(messages, opts) {
  opts = opts || {};
  const crossStore = opts.crossStore === true;
  const augmentedMessages = crossStore
    ? messages.map((m, i) => i === messages.length - 1
        ? { ...m, content: '[cross-store mode: searching all 9 non-Texarkana FTRV stores live] ' + m.content }
        : m)
    : messages;

  const res = await fetch(CHAT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: [{ type: 'text', text: SYSTEM_TEMPLATE, cache_control: { type: 'ephemeral' } }],
      messages: augmentedMessages
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('API ' + res.status + ': ' + txt.slice(0, 200));
  }
  const data = await res.json();
  const reply = data.content?.[0]?.text || '';
  const cleaned = reply.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch(_) {} }
  }
  if (!parsed) throw new Error('Could not parse AI response as JSON');
  return {
    narrative:    parsed.narrative || '',
    spec:         parsed.filter || {},
    sortBy:       parsed.sortBy || null,
    sortDir:      parsed.sortDir || 'asc',
    limit:        parsed.limit || null,
    noMatch:      parsed.noMatch === true,
    likely_zero:  parsed.likely_zero === true,
  };
}
