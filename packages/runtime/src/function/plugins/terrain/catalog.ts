/**
 * Ground materials on the ParallaxPro asset store: photographed, tileable CC0 surfaces
 * (albedo + tangent-space normal map), the same images ParallaxPro's hosted terrain uses.
 * A terrain layer named after one of `NAMED_GROUND` (and given no `"texture"`) draws its
 * material; `"texture": null` keeps a layer plain (its color and procedural pattern).
 *
 * The files are content-addressed and immutable; a run without a network draws the layer's
 * color instead (render3d treats an unreachable hosted image as plain white, and a named
 * layer's color sets its texture's average tone).
 */

import { remoteAssetUrl } from '../../../core/index.js';

const STORE = 'https://r2.parallaxpro.ai/assets/image_texture/';

export interface GroundMaterial {
  /** sRGB base color image URL. */
  readonly albedo: string;
  /** Tangent-space normal map URL (OpenGL convention: +y up the image). */
  readonly normal: string;
  /** Meters per repeat that reads right from a playing camera. */
  readonly tile: number;
}

const at = (albedo: string, normal: string, tile: number): GroundMaterial => ({
  albedo: `${STORE}${albedo.slice(0, 2)}/${albedo.slice(2, 4)}/${albedo}.jpg`,
  normal: `${STORE}${normal.slice(0, 2)}/${normal.slice(2, 4)}/${normal}.jpg`,
  tile,
});

/** The catalog, by material name. */
export const GROUND_MATERIALS: Readonly<Record<string, GroundMaterial>> = {
  /** Pale olive turf (ParallaxPro's default grass). */
  leafy_grass: at('cfa40bc9d9417d1852db8753a8d5917f110c40101179f63543c382e39bc05e4a', '03dc0449bb5dcac7819b62ca7a272f6160118c13537a1b31b01fedf3e4ee597b', 7),
  /** Dense green lawn. */
  grass_lush: at('9e1c60da44b34a9738b1256ba827541f097dc583521b1d281e61b5f4b4217bc5', '8014a81d896a5c589b60612a769bc39eb1213e48d96f6146f485ea36e9e9610f', 6),
  /** Straw-colored dead grass. */
  grass_dry: at('8bebfb639ef74f651bc445526c46c845beee52a86d831848b82eb2bbbf2d98ee', '6178f31d0c0cafbbe44e1642eeeed3a23a1530643279cef71b1d8f885d9a0d41', 6),
  /** Trodden earth with roots and needle litter. */
  forest_floor: at('50a4dda30875020c64385261aa7e00e2155b592302fa6794165f58fae73cbd2c', 'c22cc904a7f057598ac9c6c5f8c0937aba9fc1b8b8806d2fb9b2d3effe5e3669', 6),
  /** Solid moss. */
  moss_bed: at('312506c2ea4cc474273dbabbf6287f1b60ec104ce0f8fbbbfa5a6e76d48d7edc', '10f00f2bfc8a96e1b3995a727fee60d485e69354c75fcea48b50537e611b87a2', 5),
  /** Ochre compacted earth. */
  packed_dirt: at('5c4b518f993c845b25a8d1a54b35b8657b85f93c21c54df7802f33b02771dcc1', '087cead3280499d10f927ccf5b81d136841daed2adac32abef96c3c059c6cb1f', 6),
  /** Dark earth with grit: a worn route. */
  dirt_path: at('a662000ff3f7f64e23c25d2b8cd5947b9c8fd893510c5ed49c0daa2847004758', '735c55139f8d068051e07e3faab88b238d4218fc833f20d138983d6da9e9832c', 6),
  /** Wet churned mud. */
  mud_track: at('7867c9bfc6f6e85d51debddda3974ed68225e96b2cdb385a5518616102710730', 'dfe11a06236af1d277b1fc688d54272aa7a2dfc96d454b48c559afa259630d69', 6),
  /** Cracked pale earth. */
  dry_earth: at('75222fc97a82b635a09cf8f2891dd58bc42e49599b9fda920b2c50193fe85e9f', '2eba532f0f5150a655c966b4c42d3460fcc632942c509b4b2fcfd5ac55a55c65', 8),
  /** Red-brown clay. */
  clay_earth: at('ac952e39e4ae9143aac4e7081c0e7e10afc7e59682d66e899626f7136dd7c9de', '753ea2aafea3bb3552c23b91edf54fe8f90451d384ddcae2fc6108eb5699051e', 6),
  /** Fine grey gravel. */
  gravel_bed: at('010374d62b44f77d3b84de4e53329b32edb86294fa228cfcf6c693dad79f0811', '61e85ebcba0af79b9339ea1c4185e1814bbd780f9da59c0003672e1d6f546a37', 3),
  /** Beach sand. */
  coast_sand: at('58af2e40100f7f405703a86d593af64379f822c4786850def23ecfc921450d54', '19ca020fbffa44cb041d5f2e9cfeec25ab9d18a3a381c9f8d509339fb406bde9', 8),
  /** Settled snow. */
  snow_pack: at('c038848e3574552c0ae93dadc3582dd8d43cb104f72289e2c9d6876ae4b977fe', 'c2653e873b486f9a121f9221e4149d9a5f595fee17ac599d3941b0919f21b762', 9),
  /** Warm mossy cobbled rock. */
  rocky_terrain: at('429315865fd89c150272592f6d93def174c6f69804a565ff08e53627a885579b', '84df2a6c3329566302d248509694bfec3f3ea1000b27ff11b173408c0fdf867d', 12),
  /** Pale cracked bedrock with bedding. */
  rock_strata: at('4406a3a28fa0edd2734cf08c0720ef84d5edd1a4cf035f4c9e56de6c905151ff', '6fc74f6c642a7b67a90c00f80fbd3f92040018155101c192c5050d606bb4d65e', 14),
  /** Banded orange-brown cliff strata. */
  cliff_strata: at('5c6858541108fc34e5726ecf4d8d942d6301155c489e7341619260f2909570c5', 'c44cf5fb11402da822e5f9c89e77c2514ea59d825abb81622835aea842b11f99', 24),
  /** Plain cast concrete. */
  brushed_concrete: at('4054ed6eb65cd063356ffb4a88706b7d7b78c5435051c48bf0ee64290f04bc8c', '89a07e01f7ca138b06711c729755b26ed0e588769c3568a7008ef420c9cba305', 5),
  /** Road asphalt. */
  city_asphalt: at('99b6f6bdfbd09279f3f550ac9593336df541aa2319537566eeb3e737d8512010', '11d7a91149357a7fba7adde16d14cc016bdabf86a8f14879cc7e21207ed75db8', 6),
  /** Coursed rectangular setts. */
  cobble_setts: at('16d707beaa30a62c2d7338d00bdb393213a25ec55d96322c228195a69d2fb0ea', '77d1c3ae6cbbd6912a819c94301776757a99f606ad1b7d2bc3f38a035c9fc33d', 4),
  /** Irregular warm blockwork. */
  stone_blocks: at('91bc9f13dba69588efeaed86bd4490c4aae5d3381351a934e4d3fc5222c01a6c', 'f78d4c4f27a2e462a8919e29ddf70229db7f567a729e010ea3404fbc6b91e3eb', 5),
};

/** The material a layer with a common name draws when it names no texture. */
export const NAMED_GROUND: Readonly<Record<string, string>> = {
  grass: 'leafy_grass', meadow: 'leafy_grass', lawn: 'grass_lush', field: 'leafy_grass', jungle: 'grass_lush',
  dry_grass: 'grass_dry', forest: 'forest_floor', forest_floor: 'forest_floor', moss: 'moss_bed',
  dirt: 'packed_dirt', soil: 'packed_dirt', earth: 'packed_dirt', path: 'dirt_path', trail: 'dirt_path', mud: 'mud_track',
  clay: 'clay_earth', desert: 'dry_earth', gravel: 'gravel_bed',
  sand: 'coast_sand', beach: 'coast_sand', dune: 'coast_sand',
  snow: 'snow_pack', ice: 'snow_pack',
  rock: 'rocky_terrain', stone: 'rocky_terrain', cliff: 'cliff_strata', bedrock: 'rock_strata',
  road: 'brushed_concrete', concrete: 'brushed_concrete', pavement: 'brushed_concrete', plaza: 'stone_blocks',
  asphalt: 'city_asphalt', tarmac: 'city_asphalt', cobble: 'cobble_setts', cobblestone: 'cobble_setts',
};

/** The hosted material for a layer name, or undefined. */
export function groundFor(name: string): GroundMaterial | undefined {
  const key = Object.prototype.hasOwnProperty.call(NAMED_GROUND, name) ? NAMED_GROUND[name] : undefined;
  return key === undefined ? undefined : GROUND_MATERIALS[key];
}

/**
 * The material whose base color is this hosted image (any accepted form of its URL), or
 * undefined: a layer that names a catalog image by URL gets its normal map too (the store's
 * files are content-addressed, so the URL identifies the material).
 */
export function groundByAlbedo(url: string): GroundMaterial | undefined {
  const canonical = remoteAssetUrl(url);
  if (canonical === undefined) return undefined;
  return Object.values(GROUND_MATERIALS).find((m) => m.albedo === canonical);
}
