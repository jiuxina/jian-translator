import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const glass = require('../web/liquid-glass.js');

assert.equal(glass.version, 1);
assert.deepEqual(glass.normalize(), glass.defaults);
assert.deepEqual(glass.normalize({
  surfaceProfile: 'unknown',
  bezelWidth: -20,
  glassThickness: 100,
  refractiveIndex: 1.57,
  refractionLevel: 250,
  specularOpacity: -1,
  specularSaturation: 20,
  blurLevel: 12.4,
  progressiveBlurStrength: 999,
  backgroundOpacity: 35,
  material: 'frosted',
  glassStrength: 10,
  cardReveal: 100
}), {
  surfaceProfile: 'convex-squircle',
  bezelWidth: 4,
  glassThickness: 40,
  refractiveIndex: 1.6,
  refractionLevel: 200,
  specularOpacity: 0,
  specularSaturation: 10,
  blurLevel: 12,
  progressiveBlurStrength: 100,
  backgroundOpacity: 35
});

const specularSaturation = [1, 4, 5, 6, 10].map(glass.specularSaturationValue);
assert.equal(specularSaturation[2], 1, 'the midpoint keeps the source specular color neutral');
assert.ok(specularSaturation.every((value, index) => index === 0 || value > specularSaturation[index - 1]),
  'higher specular saturation must produce a strictly more vivid SVG saturation value');
assert.equal(glass.opticalGeometryKey(glass.defaults), glass.opticalGeometryKey({
  ...glass.defaults,
  blurLevel: 0,
  progressiveBlurStrength: 100,
  specularOpacity: 90,
  specularSaturation: 10,
  backgroundOpacity: 0
}), 'filter-only controls must not invalidate the ray geometry map');
assert.notEqual(glass.opticalGeometryKey(glass.defaults), glass.opticalGeometryKey({
  ...glass.defaults,
  glassThickness: glass.defaults.glassThickness + 1
}), 'optical geometry changes must invalidate the ray map');

const neutral = glass.generateMaps(360, 240, 26, {
  ...glass.defaults,
  refractiveIndex: 1,
});
assert.equal(neutral.maxDisplacement, 0, 'air-to-air must not bend the background');
for (let index = 0; index < neutral.displacement.length; index += 4) {
  assert.equal(neutral.displacement[index], 128);
  assert.equal(neutral.displacement[index + 1], 128);
}

const refractive = glass.generateMaps(360, 240, 26, glass.defaults);
assert.ok(refractive.maxDisplacement > 0, 'glass must produce a nonzero Snell displacement');
assert.ok(refractive.mapWidth <= 640 && refractive.mapHeight <= 640);
assert.equal(refractive.displacement.length, refractive.mapWidth * refractive.mapHeight * 4);
assert.equal(refractive.specular.length, refractive.displacement.length);
assert.equal(refractive.blurMask.length, refractive.displacement.length);
assert.ok(refractive.displacement.some((value, index) =>
  index % 4 === 0 && value !== 128), 'the red displacement channel must carry an optical offset');
assert.ok(refractive.specular.some((value, index) =>
  index % 4 === 3 && value > 0), 'the specular map must contain a directional highlight');
assert.ok(refractive.blurMask.some((value, index) =>
  index % 4 === 3 && value === 255), 'progressive blur must reach the flat interior');
const saturated = glass.generateMaps(360, 240, 26, { ...glass.defaults, specularSaturation: 10 });
assert.deepEqual(saturated.specular, refractive.specular,
  'specular saturation is a filter-only color adjustment and must reuse the highlight map');

const thicker = glass.generateMaps(360, 240, 26, { ...glass.defaults, glassThickness: 28 });
assert.ok(thicker.maxDisplacement > refractive.maxDisplacement,
  'increasing glass thickness must increase the calculated ray offset');

const profiles = ['convex-circle', 'convex-squircle', 'concave', 'lip'].map((surfaceProfile) =>
  glass.generateMaps(220, 140, 30, { ...glass.defaults, surfaceProfile }));
assert.equal(new Set(profiles.map((maps) => Buffer.from(maps.displacement).toString('base64'))).size, 4,
  'all four surface profiles must create distinct normal maps');

console.log('Liquid Glass engine math and normalization passed.');
