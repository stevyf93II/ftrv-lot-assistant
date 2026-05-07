// ftrv_shared.js — single source of truth for the FTRV Lot Helper
// Both ftrv_lot_assistant.html (Grid View) and ftrv_ai_assistant.html (AI Chat) <script src> this file.
// Spec layer per spec-first-thinking: this file is the contract; HTMLs are UI shells.
//
// What lives here (one copy, ever):
//   • SYSTEM_TEMPLATE (the AI translator's system prompt — schema for the filter spec)
//   • BOOL_FILTER_FIELDS, FEATURE_ALIAS (the filter vocabulary)
//   • applyFilterSpec, applySort, describeFilterSpec (deterministic execution)
//   • inventoryReady + alias block (upstream→Lot-Helper field name normalization)
//   • callChat (single /api/chat caller with prompt caching)
//   • getLayout (model-suffix → human-readable layout name)
//
// What stays in each HTML: UI markup, render functions, DOM event wiring, page-specific UX.

// ─── ENDPOINTS ──────────────────────────────────────────────────────────────
const INVENTORY_URL = 'https://arklatexrv.com/inventory.json';
const CHAT_ENDPOINT = 'https://ftrv-lot-assistant.onrender.com/api/chat';

// ─── SYSTEM PROMPT (v8 translator pattern) ──────────────────────────────────
// AI returns JSON filter spec; JS executes deterministically.
const SYSTEM_TEMPLATE = "You are the FTRV Lot Assistant query translator for Fun Town RV Texarkana.\n\nYour ONLY job: convert customer queries into a JSON filter spec that JavaScript will execute deterministically over the current inventory. You do NOT see individual units. You do NOT count. You do NOT list stocks. You translate intent into structured filter parameters.\n\nOUTPUT FORMAT \u2014 respond with EXACTLY this JSON shape and nothing else (no markdown fences, no surrounding text):\n{\n  \"narrative\": \"<1-2 sentence sales-friendly response in your voice>\",\n  \"filter\": { ... filter spec, see below ... },\n  \"sortBy\": \"priceNum\"|\"wt\"|\"len\"|\"year\"|\"sl\"|\"gvwr\"|\"garage_ft\"|null,\n  \"sortDir\": \"asc\"|\"desc\",\n  \"limit\": <integer or null \u2014 for 'smallest 5w' use 1; 'top 3 X' use 3; otherwise null>\n}\n\nFILTER SPEC SCHEMA (omit any field you don't need):\n- features: [\"Bunkhouse\",\"King Bed\",...]   ALL of these must be in the unit's feat[]. Closed list of 30 (see below).\n- hitch: \"bumper\"|\"5w\"\n- type: \"Travel Trailer\"|\"Fifth Wheel\"|\"Toy Hauler\"|\"Destination Trailer\"\n- condition: \"New\"|\"Pre-Owned\"\n- Boolean must-haves (set to true to require): dishwasher, central_vacuum, off_grid_solar, solar_pkg, wd_installed, wd_prep_only, convection_oven, convection_cooking, on_demand_water, murphy_bed, bunkroom, bunk_private_door, loft, kit_island, kit_pantry, pullout_pantry, kit_residential_fridge, outdoor_kitchen, outdoor_tv, ceiling_fan, theater_seat, hideabed, walkin_shower, walkin_closet, desk, l_shaped_sofa, u_shaped_dinette, jackknife_sofa, power_awning, auto_level, electric_tilt_bed, happi_jac, disc_brakes, third_ac\n- kit_loc, bed_loc, bath_loc: \"front\"|\"rear\"|\"mid\"\n- minPrice, maxPrice (priceNum, $)\n- minWt, maxWt (dry weight, lbs)\n- minLen, maxLen (feet)\n- minSlp (sleeps)\n- slidesEq (exact slide count) | minSlides | maxSlides\n- minBdrms (2 means must be true 2-bedroom; bdrms===2 strictly)\n- minBths (1, 1.5, or 2)\n- minBunks (bunk count)\n- minFridgeCuft (cu ft)\n- minGarage (toy hauler garage feet)\n- elecAmp (30 or 50)\n- minFreshWater, minGreyWater, minBlackWater (gallons)\n- minHitchWt, maxHitchWt (lbs \u2014 pin/hitch weight at the hitch ball)\n- minGvwr, maxGvwr (lbs)\n- minCargo (cargo capacity lbs)\n- minLpLbs (LP tank capacity lbs), minLpTanks (count)\n- minFuelGal (toy hauler fuel gallons)\n- minFurnaceBtu, minBurners (cooktop burner count), minAxles, minAwnings\n- stockEq: \"215463\"  (exact stock match)\n- modelContains: \"Brinkley Model G\"  (substring match on brandModel, case-insensitive)\n\nHITCH MAPPING:\n- \"bumper pull\"/\"TT\"/\"travel trailer\"/\"pull behind\" \u2192 hitch:\"bumper\" (also includes Destination Trailers, which are bumper-hitch)\n- \"5th wheel\"/\"fifth wheel\"/\"gooseneck\" \u2192 hitch:\"5w\"\n\nINSTALLED vs AVAILABLE (critical distinctions):\n- \"W/D installed\"/\"real washer dryer\" \u2192 wd_installed:true (NOT W&D Prep, NOT wd_prep_only)\n- \"W/D prep\"/\"plumbing for W/D\"/\"prepped for washer\" \u2192 wd_prep_only:true OR features:[\"Washer & Dryer Prep\"]\n- \"off-grid solar\" \u2192 off_grid_solar:true\n- \"solar package\"/\"solar panels installed\" \u2192 solar_pkg:true\n- \"theater seating\"/\"theater seats\"/\"recliners\"/\"reclining seats\" \u2192 theater_seat:true\n- \"walk-in shower\" \u2192 walkin_shower:true (separate stall, NOT tub/shower combo)\n- \"residential fridge\"/\"big fridge\" \u2192 kit_residential_fridge:true\n- \"pantry\" \u2192 kit_pantry:true; \"pullout pantry\" \u2192 pullout_pantry:true\n- \"tankless\"/\"on-demand water\" \u2192 on_demand_water:true\n- \"convection cooking\"/\"convection capability\" \u2192 convection_cooking:true (spec-table; distinct from convection_oven which fires on the oven appliance)\n- \"loft\"/\"loft bed\"/\"upper sleeping\" \u2192 loft:true\n- \"happi-jac\"/\"happijac\"/\"power bunks\"/\"electric bed lift\" (toy haulers) \u2192 happi_jac:true\n- \"disc brakes\"/\"4-wheel disc brakes\" \u2192 disc_brakes:true\n- \"3rd A/C\"/\"third A/C\"/\"three roof A/Cs\"/\"triple A/C\" \u2192 third_ac:true (set in addition to features:[\"Dual A/C\"] for queries that want exactly 3 A/Cs)\n\nTOW VEHICLE WEIGHT HINTS (when customer mentions a vehicle, set maxWt for dry weight AND maxHitchWt for fifth-wheel pin weight):\n- \"F-150\"/\"Ram 1500\"/\"Silverado 1500\"/\"half-ton\"/\"1500\" \u2192 maxWt around 7500-8500 (leaves headroom under rated cap)\n- \"F-250\"/\"Ram 2500\"/\"Silverado 2500\"/\"3/4 ton\"/\"2500\" \u2192 maxWt around 12000\n- \"F-350\"/\"Ram 3500\"/\"Silverado 3500\"/\"1 ton\"/\"dually\" \u2192 maxWt around 18000\n- SUV/midsize without specifics \u2192 maxWt 5000\n- If unsure, leave maxWt unset (don't gate the customer artificially)\n\nCONDITION VOCABULARY:\n- \"used\"/\"pre-owned\"/\"second-hand\"/\"trade-in\" \u2192 condition:\"Pre-Owned\"\n- \"new\"/\"never used\"/\"current year\" \u2192 condition:\"New\"\n\nCLOSED FEATURE LIST (use exact strings ONLY in features array):\nFront Living, Rear Living Area, Front Kitchen, Rear Kitchen, Front Bedroom, Rear Bedroom, Front Bath, Rear Bath, Bunkhouse, Bunk Over Cab, Two Entry/Exit Doors, Rear Twin, V-Nose, Rear Entertainment, Outdoor Kitchen, U Shaped Dinette, Kitchen Island, Bath and a Half, Front Entertainment, Two Full Baths, Walk-Thru Bath, Murphy Bed, Wheelchair Accessible, Couples Coach - No Bunks, King Bed, Two Bedrooms, Dual or Triple AC, Texas Chill Package, Washer & Dryer Prep\n\nEXAMPLES:\nQ: \"5w under 12k dry\"\nA: {\"narrative\":\"Fifth wheels under 12,000 lbs dry weight, sorted lightest first.\",\"filter\":{\"hitch\":\"5w\",\"maxWt\":12000},\"sortBy\":\"wt\",\"sortDir\":\"asc\"}\n\nQ: \"biggest GVWR on the lot\"\nA: {\"narrative\":\"The biggest unit by GVWR.\",\"filter\":{},\"sortBy\":\"gvwr\",\"sortDir\":\"desc\",\"limit\":1}\n\nQ: \"cheapest bunkhouse\"\nA: {\"narrative\":\"Cheapest bunkhouse on the lot.\",\"filter\":{\"features\":[\"Bunkhouse\"]},\"sortBy\":\"priceNum\",\"sortDir\":\"asc\",\"limit\":1}\n\nQ: \"couples coach with king bed and outdoor kitchen under $80k\"\nA: {\"narrative\":\"Couples coach (no bunks) with king bed and outdoor kitchen under $80,000.\",\"filter\":{\"features\":[\"Couples Coach - No Bunks\",\"King Bed\",\"Outdoor Kitchen\"],\"maxPrice\":80000}}\n\nQ: \"stock 215463\"\nA: {\"narrative\":\"Here is stock #215463.\",\"filter\":{\"stockEq\":\"215463\"}}\n\nQ: \"show me the Brinkley Model G 4100\"\nA: {\"narrative\":\"The Brinkley Model G 4100.\",\"filter\":{\"modelContains\":\"Brinkley Model G 4100\"}}\n\nQ: \"toy hauler with at least 14 ft garage and 50 amp service\"\nA: {\"narrative\":\"Toy haulers with 14+ ft garage and 50-amp service.\",\"filter\":{\"type\":\"Toy Hauler\",\"minGarage\":14,\"elecAmp\":50}}\n\nQ: \"toy hauler with happi-jac and disc brakes\"\nA: {\"narrative\":\"Toy haulers with Happi-Jac power bunks and disc brakes.\",\"filter\":{\"type\":\"Toy Hauler\",\"happi_jac\":true,\"disc_brakes\":true}}\n\nQ: \"bumper pull under 7500 lbs sleeping 6\"\nA: {\"narrative\":\"Bumper-pull units under 7,500 lbs dry that sleep 6+.\",\"filter\":{\"hitch\":\"bumper\",\"maxWt\":7500,\"minSlp\":6}}\n\nQ: \"purple unicorn rv\"\nA: {\"narrative\":\"That's not a model we carry \u2014 happy to find you something real instead.\",\"filter\":{},\"noMatch\":true}\n\nQ: \"do you sell hot dogs\"\nA: {\"narrative\":\"We're an RV dealer \u2014 no hot dogs! Want me to find an RV instead?\",\"filter\":{},\"noMatch\":true}\n\nQ: \"front bedroom rear bath theater seat under 100k\"\nA: {\"narrative\":\"Front bedroom + rear bath with theater seating, under $100,000.\",\"filter\":{\"features\":[\"Front Bedroom\",\"Rear Bath\"],\"theater_seat\":true,\"maxPrice\":100000}}\n\nQ: \"bunkhouse with walk-in shower and pantry\"\nA: {\"narrative\":\"Bunkhouses with a walk-in shower and pantry.\",\"filter\":{\"features\":[\"Bunkhouse\"],\"walkin_shower\":true,\"kit_pantry\":true}}\n\nQ: \"5w with washer/dryer just prepped not installed\"\nA: {\"narrative\":\"Fifth wheels with W/D plumbing prep (not actual W/D installed).\",\"filter\":{\"hitch\":\"5w\",\"wd_prep_only\":true}}\n\nRULES:\n- For absurd/impossible queries (purple unicorn, hot dogs, RV that flies), include \"noMatch\":true in the response. Empty filter {} alone returns ALL units \u2014 use noMatch:true to return zero.\n- RESPOND WITH JSON ONLY \u2014 no prose, no markdown.\n- NEVER include unit-specific stock numbers in the narrative \u2014 JS will compute the actual list.\n- The narrative is short (1-2 sentences), describes the search, never claims a count.\n- For ambiguous queries, pick the most common interpretation.\n- If a query is impossible (purple unicorn, hot dogs), return empty filter and acknowledge politely in narrative.\n";

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
// Upstream (arklatexrv.com) ships long names; the filter uses short names.
// This block is the canonical translation layer — adding a new spec field means adding ONE line here.
let FTRV_DATA = {};
let INVENTORY = [];

const inventoryReady = (async () => {
  const r = await fetch(INVENTORY_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error('inventory HTTP ' + r.status);
  const data = await r.json();
  const units = data.units || data;
  for (const u of units) {
    u.stock = u.stock || u.stock_number;
    // Price: treat 0 OR null as "Call" — upstream sometimes ships 0 for not-priced units (H1 fix)
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
    u.detailUrl = u.detailUrl || u.source_url;
    u.photoUrl = u.photoUrl || u.photo_url;
    u.floorplanUrl = u.floorplanUrl || u.floorplan_url;
    u.brandModel = u.brandModel || [u.manufacturer, u.brand, u.model, u.floorplan].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
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
    // Hitch heuristic: 5w iff Fifth Wheel; everything else is bumper-pulled
    u.hitch = u.hitch || (u.type === 'Fifth Wheel' ? '5w' : 'bumper');
    FTRV_DATA[u.stock] = u;
  }
  INVENTORY = Object.values(FTRV_DATA);
  // Update header badges if present (each HTML may have its own)
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

// ─── FILTER VOCABULARY ──────────────────────────────────────────────────────
// Boolean filter fields — every entry here MUST exist as a true/false in upstream.
// Drift between this list and the upstream schema causes silent zero-matches.
const BOOL_FILTER_FIELDS = ['dishwasher','central_vacuum','off_grid_solar','wd_installed','murphy_bed','kit_island','outdoor_kitchen','auto_level','solar_pkg','walkin_shower','bunkroom','hideabed','on_demand_water','convection_oven','convection_cooking','kit_pantry','kit_residential_fridge','power_awning','outdoor_tv','ceiling_fan','pullout_pantry','wd_prep_only','walkin_closet','theater_seat','desk','bunk_private_door','l_shaped_sofa','u_shaped_dinette','jackknife_sofa','electric_tilt_bed','loft','happi_jac','disc_brakes','third_ac'];

// Feature aliases — the closed feature list maps to either u.features[] inclusion OR a dedicated bool/loc field.
const FEATURE_ALIAS = {
  "Bunkhouse":         u => u.bunkroom === true,
  "Murphy Bed":        u => u.murphy_bed === true,
  "Kitchen Island":    u => u.kit_island === true,
  "Outdoor Kitchen":   u => u.outdoor_kitchen === true,
  "U Shaped Dinette":  u => u.u_shaped_dinette === true,
  "Front Bedroom":     u => u.bed_loc === "front",
  "Rear Bedroom":      u => u.bed_loc === "rear",
  "Front Kitchen":     u => u.kit_loc === "front",
  "Rear Kitchen":      u => u.kit_loc === "rear",
  "Front Bath":        u => u.bath_loc === "front",
  "Rear Bath":         u => u.bath_loc === "rear",
  "Loft":              u => u.loft === true,
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

  // Defensive aliases for queries the AI used to phrase as removed/legacy fields
  if (spec.recliners === true) list = list.filter(u => u.theater_seat === true);
  if (spec.theater_inst === true) list = list.filter(u => u.theater_seat === true);

  for (const f of BOOL_FILTER_FIELDS) {
    if (spec[f] === true) list = list.filter(u => u[f] === true);
  }

  if (spec.kit_loc)  list = list.filter(u => u.kit_loc === spec.kit_loc);
  if (spec.bed_loc)  list = list.filter(u => u.bed_loc === spec.bed_loc);
  if (spec.bath_loc) list = list.filter(u => u.bath_loc === spec.bath_loc);

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
  if (spec.minBdrms != null) list = list.filter(u => (u.bdrms || 1) >= spec.minBdrms);
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

function applySort(list, sortBy, sortDir) {
  if (!sortBy) return list;
  const dir = sortDir === 'desc' ? -1 : 1;
  // For price-ascending sorts, drop $0/Call units to the bottom — they aren't really "cheapest" (H1 fix)
  const arr = list.slice();
  arr.sort((a, b) => {
    const av = a[sortBy], bv = b[sortBy];
    // If sorting by priceNum ascending, push 0/missing to the end regardless of dir
    if (sortBy === 'priceNum') {
      const aPrice = av || 0, bPrice = bv || 0;
      if (aPrice === 0 && bPrice === 0) return 0;
      if (aPrice === 0) return 1;   // a goes after b
      if (bPrice === 0) return -1;  // a goes before b
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
// Single source. Both HTMLs use this. Uses prompt caching on the system block.
async function callChat(messages) {
  const res = await fetch(CHAT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: [{ type: 'text', text: SYSTEM_TEMPLATE, cache_control: { type: 'ephemeral' } }],
      messages: messages
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
    narrative: parsed.narrative || '',
    spec:      parsed.filter || {},
    sortBy:    parsed.sortBy || null,
    sortDir:   parsed.sortDir || 'asc',
    limit:     parsed.limit || null,
    noMatch:   parsed.noMatch === true
  };
}
