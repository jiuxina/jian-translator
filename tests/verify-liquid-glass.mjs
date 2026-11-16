import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const glass = require('../web/liquid-glass.js');

assert.equal(glass.version, 3);
assert.deepEqual(glass.normalize(), glass.defaults);
assert.deepEqual(glass.normalize({
  card: {
    refractionLevel: 250,
    specularOpacity: -1,
    specularSaturation: 60,
    blurLevel: 12.4,
    progressiveBlurStrength: 999,
    backgroundOpacity: 35,
    material: 'frosted',
    glassStrength: 10,
    cardReveal: 100
  },
  pill: { backgroundOpacity: 99 },
  button: { blurLevel: 20 },
  surfaceProfile: 'concave'
}), {
  card: {
    refractionLevel: 100,
    specularOpacity: 0,
    specularSaturation: 50,
    blurLevel: 12.4,
    progressiveBlurStrength: 10,
    backgroundOpacity: 35
  },
  pill: glass.defaults.pill,
  button: glass.defaults.button
});
assert.deepEqual(glass.defaults, {
  card: {
    specularOpacity: 40, specularSaturation: 6, refractionLevel: 100,
    blurLevel: 1, progressiveBlurStrength: 1, backgroundOpacity: 60
  },
  pill: { specularOpacity: 50, specularSaturation: 6, refractionLevel: 100, blurLevel: .2 },
  button: { specularOpacity: 50, specularSaturation: 9, refractionLevel: 100 }
}, 'each surface uses the corresponding reference demo control defaults');
assert.equal(glass.opticalPreset('pill', 28).surfaceProfile, 'lip',
  'navigation and model selectors use the reference Dynamic Toggle lip profile');
assert.equal(glass.opticalPreset('card', 28).surfaceProfile, 'convex-circle');
assert.equal(glass.opticalPreset('button', 28).surfaceProfile, 'convex-circle');
for (const name of ['card', 'pill', 'button']) {
  for (const radius of [0, 7, 12, 28, 60, 100]) {
    const component = glass.opticalPreset(name, radius);
    assert.ok(Math.abs(component.glassThickness / component.bezelWidth - 50 / 60) < 1e-12,
      `${name} keeps the reference 60:50 bezel/thickness proportion at radius ${radius}`);
    const normalized = glass.normalizeOptics(component);
    assert.ok(Math.abs(normalized.glassThickness / normalized.bezelWidth - 50 / 60) < .0001,
      'normalization must preserve small-component optical proportions');
  }
}
assert.equal(glass.opticalPreset('button', 12).glassThickness, 10,
  'a 12px button bezel uses 10px thickness rather than the unscaled 50px reference thickness');
assert.deepEqual(glass.interactionParameters('pill', glass.defaults.pill, false), {
  refractionRatio: .4,
  backgroundOpacity: 1,
}, 'an idle toggle uses the reference resting refraction and fill');
assert.deepEqual(glass.interactionParameters('pill', glass.defaults.pill, true), {
  refractionRatio: .9,
  backgroundOpacity: .1,
}, 'a held toggle uses the reference active refraction and fill without changing geometry');
assert.deepEqual(glass.interactionParameters('card', glass.defaults.card, true), {
  refractionRatio: 1,
  backgroundOpacity: .6,
}, 'toggle interaction does not alter card optics');
assert.deepEqual(glass.normalizeOptics({
  surfaceProfile: 'unknown', bezelWidth: -20, glassThickness: 999, refractiveIndex: 1.57
}), {
  surfaceProfile: 'convex-circle', bezelWidth: 1, glassThickness: 200, refractiveIndex: 1.6
});

assert.deepEqual([0, 1, 6, 20, 50].map(glass.specularSaturationValue), [0, 1, 6, 20, 50],
  'saturation is the raw SVG multiplier used by the reference, with 1 neutral');

const optics = glass.normalizeOptics();
assert.equal(glass.opticalGeometryKey(optics), glass.opticalGeometryKey({
  ...optics,
  blurLevel: 40,
  progressiveBlurStrength: 10,
  specularOpacity: 0,
  specularSaturation: 50,
  backgroundOpacity: 0,
}), 'filter-only controls must not invalidate the ray geometry map');
assert.notEqual(glass.opticalGeometryKey(optics), glass.opticalGeometryKey({
  ...optics,
  glassThickness: optics.glassThickness + 1,
}), 'optical geometry changes must invalidate the ray map');

for (const t of [0, .25, .5, .75, 1]) {
  const circle = Math.sqrt(1 - (1 - t) ** 2);
  const squircle = (1 - (1 - t) ** 4) ** .25;
  const blend = 6 * t ** 5 - 15 * t ** 4 + 10 * t ** 3;
  const lip = (1 - (1 - 2 * t) ** 4) ** .25 * (1 - blend) + (1 - circle + .1) * blend;
  assert.ok(Math.abs(glass.profileHeight('convex-circle', t) - circle) < 1e-12);
  assert.ok(Math.abs(glass.profileHeight('convex-squircle', t) - squircle) < 1e-12);
  assert.ok(Math.abs(glass.profileHeight('concave', t) - (1 - circle)) < 1e-12);
  assert.ok(Math.abs(glass.profileHeight('lip', t) - lip) < 1e-12);
}

const neutral = glass.generateMaps(360, 240, 26, {
  ...optics,
  refractiveIndex: 1,
});
assert.equal(neutral.maxDisplacement, 0, 'air-to-air must not bend the background');
for (let index = 0; index < neutral.displacement.length; index += 4) {
  assert.equal(neutral.displacement[index], 128);
  assert.equal(neutral.displacement[index + 1], 128);
}

const refractive = glass.generateMaps(360, 240, 26, optics);
assert.ok(refractive.maxDisplacement > 0, 'glass must produce a nonzero Snell displacement');
assert.ok(refractive.mapWidth <= 640 && refractive.mapHeight <= 640);
assert.equal(refractive.displacement.length, refractive.mapWidth * refractive.mapHeight * 4);
assert.equal(refractive.specular.length, refractive.displacement.length);
assert.equal(refractive.blurMask.length, refractive.displacement.length);
assert.ok(refractive.displacement.some((value, index) =>
  index % 4 === 0 && value !== 128), 'the red displacement channel must carry an optical offset');
assert.ok(refractive.specular.some((value, index) =>
  index % 4 === 3 && value > 0), 'the specular map must contain a directional highlight');
for (let index = 0; index < refractive.specular.length; index += 4) {
  assert.equal(refractive.specular[index], refractive.specular[index + 1]);
  assert.equal(refractive.specular[index + 1], refractive.specular[index + 2]);
}
assert.equal(refractive.blurMasks.length, 3, 'progressive blur keeps the three reference fades');
assert.equal(new Set(refractive.blurMasks.map((mask) => Buffer.from(mask).toString('base64'))).size, 3,
  'the three progressive blur masks use distinct vertical fade ranges');
const filterOnly = glass.generateMaps(360, 240, 26, {
  ...optics, specularSaturation: 50, specularOpacity: 0, blurLevel: 40
});
assert.deepEqual(filterOnly.specular, refractive.specular,
  'filter-only adjustments do not rebuild a different highlight map');

const thicker = glass.generateMaps(360, 240, 26, { ...optics, glassThickness: 100 });
assert.ok(thicker.maxDisplacement > refractive.maxDisplacement,
  'increasing glass thickness must increase the calculated ray offset');

const profiles = ['convex-circle', 'convex-squircle', 'concave', 'lip'].map((surfaceProfile) =>
  glass.generateMaps(220, 140, 30, { ...optics, surfaceProfile }));
assert.equal(new Set(profiles.map((maps) => Buffer.from(maps.displacement).toString('base64'))).size, 4,
  'all four surface profiles must create distinct normal maps');

const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const android = 'Mozilla/5.0 (Linux; Android 15; wv) AppleWebKit/537.36 Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36';
const safari = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
const firefox = 'Mozilla/5.0 (Windows NT 10.0; rv:141.0) Gecko/20100101 Firefox/141.0';
const iosChrome = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/140.0.0.0 Mobile Safari/604.1';
assert.equal(glass.rendererSupport(chrome, true).supported, true);
assert.equal(glass.rendererSupport(android, true).supported, true);
assert.equal(glass.rendererSupport(chrome, false).supported, false);
assert.equal(glass.rendererSupport(safari, true).supported, false);
assert.equal(glass.rendererSupport(firefox, true).supported, false);
assert.equal(glass.rendererSupport(iosChrome, true).supported, false);

console.log('Liquid Glass engine math and normalization passed.');
