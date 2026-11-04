'use strict'
// Cells the game treats as empty when a block is placed there: air, fluids, and the plants and layers a
// placed block simply replaces (grass, ferns, flowers, dead bushes, snow layers, vines…). Used by
// api.place and by build (Session 10a: grass in a hut's footprint is not "something in the way").
const REPLACEABLE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|short_dry_grass|tall_dry_grass|fern|large_fern|bush|firefly_bush|dead_bush|snow|vine|glow_lichen|seagrass|tall_seagrass|leaf_litter|pink_petals|wildflowers|dandelion|poppy|blue_orchid|allium|azure_bluet|red_tulip|orange_tulip|white_tulip|pink_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|closed_eyeblossom|open_eyeblossom|sunflower|lilac|rose_bush|peony|pitcher_plant|nether_sprouts|warped_roots|crimson_roots|hanging_roots|structure_void|light)$/

module.exports = { REPLACEABLE }
