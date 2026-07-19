// The palette codex (G1). Every named color in the client lives here — Pixi
// numbers are the source of truth and CSS strings are derived from them, so
// canvas and DOM can never drift apart. Tone law (from the concept board's
// strip): nothing on the field may be saturated enough to fight a squad
// color — except gold and fire, which are what the game is about.
//
// ONE SUN, from the NORTH-WEST. The whole Vale agrees:
//   · lit edges face up/left, shade edges face down/right
//   · drop shadows fall SOUTH-EAST
//   · volume on squad-colored bodies is alpha-only (white lit / INK shade),
//     so the hue underneath stays the friend-or-foe read
// Numeric strengths (alphas, offsets) are knobs in FX.grounding and
// FX.character (fx/config.ts) — this file owns hues, not amounts.

export const cssOf = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

/** Per-channel linear mix a→b by t (0..1) — squad-tinted materials, etc. */
export const mix = (a: number, b: number, t: number): number => {
  const ar = a >> 16;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  return (
    (Math.round(ar + ((b >> 16) - ar) * t) << 16) |
    (Math.round(ag + (((b >> 8) & 0xff) - ag) * t) << 8) |
    Math.round(ab + ((b & 0xff) - ab) * t)
  );
};

/** The one ink: outlines, cracks, mortar seams, and the app background.
 *  (0x12160e retired into it — two near-identical inks was drift, not design.) */
export const INK = 0x14170f;
/** Bright text on dark (own name label, HUD headlines). */
export const PARCHMENT = 0xf4ead8;
/** Secondary text, dust, worn rope. */
export const KHAKI = 0xb9ad98;
/** Arrow shafts, splinters, dry bone-white detail. */
export const BONE = 0xe8dcc0;
/** Danger red — deliberately the same hue as squad red: red means threat. */
export const ALARM = 0xf05a4d;

export const SQUAD_COLORS = [0xf05a4d, 0x5686bf, 0x8fae6a, 0xe0b95e];
export const SQUAD_CSS = SQUAD_COLORS.map(cssOf);

/** Bounty tier ramp, Nobody → Crownmarked (khaki → blood red). */
export const TIER_COLORS = [0xb9ad98, 0xc9c29b, 0xe0b95e, 0xe8985a, 0xf05a4d, 0xff3333];
export const TIER_CSS = TIER_COLORS.map(cssOf);

/** The terrain bake (scene.ts). road/roadWorn/foam are reserved for G5. */
export const TERRAIN = {
  ground: 0x2f3428,
  groundAlt: 0x333929,
  groundDeep: 0x2c3226,
  grass: 0x475639,
  stone: 0x596052,
  forest: 0x22371f,
  forestLit: 0x2e4a28,
  water: 0x1f3a52,
  waterShallow: 0x25425a,
  waterLine: 0x14202e,
  ripple: 0x3d5f7d,
  bridge: 0x7a6544,
  plank: 0x5f4c33,
  rail: 0x4a3a26,
  rock: 0x55554d,
  rockLit: 0x6d6d62,
  rockShade: 0x3a3a34,
  road: 0x6a593c,
  roadWorn: 0x7d6a48,
  foam: 0x9db4c9,
};

/** Gold is allowed to shout. */
export const GOLD = {
  keep: 0xd5aa54,
  town: 0xf2d68c,
  bright: 0xffe9b0,
  /** Old-gold/leather trim on vaults, sacks, sword guards. */
  trim: 0x7a6544,
};

/** Fire is the other thing allowed to shout (G4 leans on these). */
export const FIRE = {
  flame: 0xffd27a,
  fire: 0xff9a3d,
  ember: 0xd8543e,
  smoke: 0x6b6b64,
};

/** Worn kit (entities.ts): muted steel, oiled leather, bow wood — pulled from
 *  the concept board's tone strip. See docs/character_sheet.html. */
export const ARMORY = {
  STEEL: 0x8b939e,
  STEEL_DARK: 0x565e66,
  STEEL_EDGE: 0x4a5058,
  STEEL_BRIGHT: 0xd8e0e8,
  BLADE: 0xb8c0c8,
  GUARD: 0x7a6544,
  LEATHER: 0x8a6f4d,
  PACK: 0x6b5233,
  PACK_EDGE: 0x4a3a26,
  WOOD: 0x7a5c3a,
  FLETCH: 0xd8d4c8,
  HOOD: 0x46573a,
  COWL_SHADOW: 0x232b1c,
  BOOT: 0x241f19,
  SHIELD_RAISED: 0x9db4c9,
};

/** Neutral props + architecture materials (structures.ts, keeps.ts). */
export const PROPS = {
  trunk: 0x4a3a26,
  oak: 0x2b4426,
  oakLit: 0x35512d,
  hutWall: 0x6b5233,
  hutEdge: 0x3c2f1e,
  thatch: 0x8a7550,
  thatchRidge: 0x5d4d33,
  /** Ownerless architecture (props, unknown squads). */
  neutral: 0x8a8a80,
  /** Dead keeps, rubble. */
  ruin: 0x777770,
};
