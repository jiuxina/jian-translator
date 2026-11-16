/*
 * Parametric SVG liquid-glass surfaces inspired by https://kube.io/blog/liquid-glass-css-svg/.
 * This is an original implementation of the Snell displacement-map and specular pipeline.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    if (root.ItLiquidGlass && root.ItLiquidGlass.version === api.version) {
      if (root.ItLiquidGlass.ensure) root.ItLiquidGlass.ensure();
      return;
    }
    root.ItLiquidGlass = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';
  var MAX_MAP_SIDE = 640;
  var MAX_MAP_PIXELS = 360000;
  var DEFAULTS = {
    surfaceProfile: 'convex-squircle',
    bezelWidth: 12,
    glassThickness: 14,
    refractiveIndex: 1.5,
    refractionLevel: 100,
    specularOpacity: 45,
    specularSaturation: 6,
    blurLevel: 60,
    progressiveBlurStrength: 50,
    backgroundOpacity: 60
  };
  var PROFILES = ['convex-circle', 'convex-squircle', 'concave', 'lip'];
  var attached = new Map();
  var geometryCache = new Map();
  var currentConfig = normalizeConfig(DEFAULTS);
  var sequence = 0;
  var resizeObserver = null;
  var resizeFrame = 0;
  var resizeQueue = new Set();
  var mutationObserver = null;
  var unsupportedReported = false;

  function reportError(code, error) {
    if (typeof document === 'undefined' || typeof CustomEvent !== 'function') return;
    document.dispatchEvent(new CustomEvent('it-liquid-glass-error', {
      detail: { code: code, message: error ? String(error.message || error) : '' }
    }));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function numberOr(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeConfig(input) {
    var source = input && typeof input === 'object' ? input : {};
    var result = {};
    result.surfaceProfile = PROFILES.indexOf(source.surfaceProfile) >= 0
      ? source.surfaceProfile : DEFAULTS.surfaceProfile;
    result.bezelWidth = Math.round(clamp(numberOr(source.bezelWidth, DEFAULTS.bezelWidth), 4, 32));
    result.glassThickness = Math.round(clamp(numberOr(source.glassThickness, DEFAULTS.glassThickness), 1, 40));
    result.refractiveIndex = Math.round(clamp(numberOr(source.refractiveIndex, DEFAULTS.refractiveIndex), 1, 2.5) * 10) / 10;
    result.refractionLevel = Math.round(clamp(numberOr(source.refractionLevel, DEFAULTS.refractionLevel), 0, 200));
    result.specularOpacity = Math.round(clamp(numberOr(source.specularOpacity, DEFAULTS.specularOpacity), 0, 100));
    result.specularSaturation = Math.round(clamp(numberOr(source.specularSaturation, DEFAULTS.specularSaturation), 1, 10));
    result.blurLevel = Math.round(clamp(numberOr(source.blurLevel, DEFAULTS.blurLevel), 0, 100));
    result.progressiveBlurStrength = Math.round(clamp(numberOr(source.progressiveBlurStrength,
      DEFAULTS.progressiveBlurStrength), 0, 100));
    result.backgroundOpacity = Math.round(clamp(numberOr(source.backgroundOpacity,
      DEFAULTS.backgroundOpacity), 0, 100));
    return result;
  }

  function profileHeight(profile, t) {
    t = clamp(t, 0, 1);
    if (profile === 'convex-circle') return Math.sqrt(Math.max(0, 1 - Math.pow(1 - t, 2)));
    if (profile === 'concave') return 3 * t * t - 2 * t * t * t;
    if (profile === 'lip') {
      return clamp(t + .12 * Math.sin(Math.PI * 2 * t) * t * (1 - t), 0, 1);
    }
    return 1 - Math.pow(1 - t, 4);
  }

  function roundedRectDistance(x, y, width, height, radius) {
    var qx = Math.abs(x - width / 2) - (width / 2 - radius);
    var qy = Math.abs(y - height / 2) - (height / 2 - radius);
    var outsideX = Math.max(qx, 0);
    var outsideY = Math.max(qy, 0);
    var outsideLength = Math.hypot(outsideX, outsideY);
    var signedDistance = outsideLength + Math.min(Math.max(qx, qy), 0) - radius;
    var normalX = 0;
    var normalY = 0;
    if (outsideLength > .0001) {
      normalX = (x < width / 2 ? -1 : 1) * outsideX / outsideLength;
      normalY = (y < height / 2 ? -1 : 1) * outsideY / outsideLength;
    } else if (qx > qy) {
      normalX = x < width / 2 ? -1 : 1;
    } else {
      normalY = y < height / 2 ? -1 : 1;
    }
    return { distance: -signedDistance, signedDistance: signedDistance, nx: normalX, ny: normalY };
  }

  function hueToRgb(hue) {
    var h = ((hue % 1) + 1) % 1 * 6;
    var c = .94;
    var x = c * (1 - Math.abs(h % 2 - 1));
    var values = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] :
      h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return [Math.round(values[0] * 255), Math.round(values[1] * 255), Math.round(values[2] * 255)];
  }

  function mapDimensions(width, height) {
    var scale = Math.min(1, MAX_MAP_SIDE / Math.max(width, height),
      Math.sqrt(MAX_MAP_PIXELS / (width * height)));
    return {
      width: Math.max(4, Math.round(width * scale)),
      height: Math.max(4, Math.round(height * scale))
    };
  }

  function generateMaps(width, height, radius, input) {
    var config = normalizeConfig(input);
    width = Math.max(4, numberOr(width, 4));
    height = Math.max(4, numberOr(height, 4));
    radius = clamp(numberOr(radius, 0), 0, Math.min(width, height) / 2);
    var dimensions = mapDimensions(width, height);
    var mapWidth = dimensions.width;
    var mapHeight = dimensions.height;
    var displacement = new Uint8ClampedArray(mapWidth * mapHeight * 4);
    var specular = new Uint8ClampedArray(mapWidth * mapHeight * 4);
    var blurMask = new Uint8ClampedArray(mapWidth * mapHeight * 4);
    var vectorsX = new Float32Array(mapWidth * mapHeight);
    var vectorsY = new Float32Array(mapWidth * mapHeight);
    var maxDisplacement = 0;
    var bezel = config.bezelWidth;
    var thickness = config.glassThickness;
    var indexRatio = 1 / config.refractiveIndex;
    var light = { x: -.39, y: -.52, z: .76 };
    var lightLength = Math.hypot(light.x, light.y, light.z);
    light.x /= lightLength;
    light.y /= lightLength;
    light.z /= lightLength;

    for (var y = 0; y < mapHeight; y++) {
      var py = (y + .5) * height / mapHeight;
      for (var x = 0; x < mapWidth; x++) {
        var px = (x + .5) * width / mapWidth;
        var index = y * mapWidth + x;
        var offset = index * 4;
        var shape = roundedRectDistance(px, py, width, height, radius);
        var distance = Math.max(0, shape.distance);
        var inside = shape.signedDistance <= 0;
        var bevelAmount = inside ? clamp(distance / bezel, 0, 1) : 1;
        var blurStart = bezel * .55;
        var blurEnd = Math.max(blurStart + 1, bezel * 1.65);
        var blurT = inside ? clamp((distance - blurStart) / (blurEnd - blurStart), 0, 1) : 0;
        blurT = blurT * blurT * (3 - 2 * blurT);
        var blurAlpha = Math.round(blurT * 255);
        blurMask[offset] = 255;
        blurMask[offset + 1] = 255;
        blurMask[offset + 2] = 255;
        blurMask[offset + 3] = blurAlpha;

        displacement[offset] = 128;
        displacement[offset + 1] = 128;
        displacement[offset + 2] = 128;
        displacement[offset + 3] = 255;
        specular[offset] = 255;
        specular[offset + 1] = 255;
        specular[offset + 2] = 255;
        specular[offset + 3] = 0;
        if (!inside || distance >= bezel || config.refractiveIndex <= 1) continue;

        var delta = .008;
        var t = bevelAmount;
        var before = profileHeight(config.surfaceProfile, Math.max(0, t - delta));
        var after = profileHeight(config.surfaceProfile, Math.min(1, t + delta));
        var span = Math.max(.001, Math.min(1, t + delta) - Math.max(0, t - delta));
        var slope = thickness * (after - before) / (bezel * span);
        var normLength = Math.hypot(shape.nx * slope, shape.ny * slope, 1);
        var nx = shape.nx * slope / normLength;
        var ny = shape.ny * slope / normLength;
        var nz = 1 / normLength;

        var incidentDot = nz;
        var tangentX = -incidentDot * nx;
        var tangentY = -incidentDot * ny;
        var tangentZ = 1 - incidentDot * nz;
        var refractedTangentX = tangentX * indexRatio;
        var refractedTangentY = tangentY * indexRatio;
        var refractedTangentZ = tangentZ * indexRatio;
        var tangentLengthSquared = refractedTangentX * refractedTangentX +
          refractedTangentY * refractedTangentY + refractedTangentZ * refractedTangentZ;
        var transmittedNormal = Math.sqrt(Math.max(0, 1 - tangentLengthSquared));
        var rayX = refractedTangentX + nx * transmittedNormal;
        var rayY = refractedTangentY + ny * transmittedNormal;
        var rayZ = refractedTangentZ + nz * transmittedNormal;
        var shiftX = -thickness * rayX / Math.max(.08, rayZ);
        var shiftY = -thickness * rayY / Math.max(.08, rayZ);
        var shiftLength = Math.hypot(shiftX, shiftY);
        var maxOffset = Math.max(1, bezel * 1.5);
        if (shiftLength > maxOffset) {
          shiftX *= maxOffset / shiftLength;
          shiftY *= maxOffset / shiftLength;
          shiftLength = maxOffset;
        }
        vectorsX[index] = shiftX;
        vectorsY[index] = shiftY;
        maxDisplacement = Math.max(maxDisplacement, shiftLength);

        var dot = clamp(nx * light.x + ny * light.y + nz * light.z, 0, 1);
        var highlight = Math.pow(dot, 14) * (1 - .22 * t);
        var hue = (Math.atan2(shape.ny, shape.nx) / (Math.PI * 2) + .55) % 1;
        var rgb = hueToRgb(hue);
        specular[offset] = rgb[0];
        specular[offset + 1] = rgb[1];
        specular[offset + 2] = rgb[2];
        specular[offset + 3] = Math.round(clamp(highlight, 0, 1) * 255);
      }
    }

    maxDisplacement = config.refractiveIndex <= 1 ? 0 : maxDisplacement;
    if (maxDisplacement > 0) {
      for (var pixel = 0; pixel < mapWidth * mapHeight; pixel++) {
        var position = pixel * 4;
        displacement[position] = Math.round(clamp(128 + vectorsX[pixel] / maxDisplacement * 127, 0, 255));
        displacement[position + 1] = Math.round(clamp(128 + vectorsY[pixel] / maxDisplacement * 127, 0, 255));
      }
    }

    return {
      width: width,
      height: height,
      mapWidth: mapWidth,
      mapHeight: mapHeight,
      radius: radius,
      maxDisplacement: maxDisplacement,
      displacement: displacement,
      specular: specular,
      blurMask: blurMask
    };
  }

  function geometryKey(width, height, radius, config) {
    return [width.toFixed(2), height.toFixed(2), radius.toFixed(2), opticalGeometryKey(config)].join(':');
  }

  function opticalGeometryKey(input) {
    var config = normalizeConfig(input);
    return [config.surfaceProfile, config.bezelWidth, config.glassThickness,
      config.refractiveIndex].join(':');
  }

  function specularSaturationValue(input) {
    var saturation = normalizeConfig({ specularSaturation: input }).specularSaturation;
    if (saturation <= 5) return (saturation - 1) / 4;
    return Math.min(3, 1 + (saturation - 5) * .4);
  }

  function cssSupportsLiquidGlass() {
    if (typeof document === 'undefined' || !document.createElementNS) return false;
    if (typeof CSS === 'undefined' || !CSS.supports) return false;
    var urlSupported = CSS.supports('backdrop-filter', 'url(#it-liquid-glass-check)') ||
      CSS.supports('-webkit-backdrop-filter', 'url(#it-liquid-glass-check)');
    var svgSupported = !!document.createElementNS(SVG_NS, 'filter');
    return urlSupported && svgSupported;
  }

  function setImageSource(image, source) {
    image.setAttribute('href', source);
    image.setAttributeNS(XLINK_NS, 'xlink:href', source);
  }

  function canvasPng(rgba, width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
    if (!context) throw new Error('Canvas image generation is unavailable.');
    var image = context.createImageData(width, height);
    image.data.set(rgba);
    context.putImageData(image, 0, 0);
    var data = canvas.toDataURL('image/png');
    canvas.width = 1;
    canvas.height = 1;
    return data;
  }

  function cachedMaps(width, height, radius, config) {
    var key = geometryKey(width, height, radius, config);
    var cached = geometryCache.get(key);
    if (cached) {
      geometryCache.delete(key);
      geometryCache.set(key, cached);
      return cached;
    }
    var maps = generateMaps(width, height, radius, config);
    var result = {
      maps: maps,
      displacementUrl: canvasPng(maps.displacement, maps.mapWidth, maps.mapHeight),
      specularUrl: canvasPng(maps.specular, maps.mapWidth, maps.mapHeight),
      blurMaskUrl: canvasPng(maps.blurMask, maps.mapWidth, maps.mapHeight)
    };
    geometryCache.set(key, result);
    while (geometryCache.size > 32) geometryCache.delete(geometryCache.keys().next().value);
    return result;
  }

  function ensureDefs() {
    if (typeof document === 'undefined' || !document.body) return null;
    var svg = document.getElementById('it-liquid-glass-defs');
    if (!svg || !svg.isConnected) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.id = 'it-liquid-glass-defs';
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.setAttribute('width', '1');
      svg.setAttribute('height', '1');
      svg.style.cssText = 'position:fixed;left:-2px;top:-2px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
      var defs = document.createElementNS(SVG_NS, 'defs');
      svg.appendChild(defs);
      document.body.appendChild(svg);
      attached.forEach(function (state) {
        if (state.filter) defs.appendChild(state.filter);
      });
    }
    return svg.querySelector('defs');
  }

  function appendPrimitive(parent, name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    parent.appendChild(node);
    return node;
  }

  function createFilter(element) {
    var defs = ensureDefs();
    if (!defs) return null;
    var filter = document.createElementNS(SVG_NS, 'filter');
    filter.id = 'it-liquid-glass-filter-' + (++sequence);
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('width', '1');
    filter.setAttribute('height', '1');
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    var displacementImage = appendPrimitive(filter, 'feImage', {
      x: '0', y: '0', width: '1', height: '1', preserveAspectRatio: 'none', result: 'displacement-map'
    });
    var refract = appendPrimitive(filter, 'feDisplacementMap', {
      in: 'SourceGraphic', in2: 'displacement-map', scale: '0',
      xChannelSelector: 'R', yChannelSelector: 'G', result: 'refracted'
    });
    var baseBlur = appendPrimitive(filter, 'feGaussianBlur', {
      in: 'refracted', stdDeviation: '0.6', result: 'base-blur'
    });
    var maskImage = appendPrimitive(filter, 'feImage', {
      x: '0', y: '0', width: '1', height: '1', preserveAspectRatio: 'none', result: 'progressive-mask'
    });
    var progressiveBlur = appendPrimitive(filter, 'feGaussianBlur', {
      in: 'base-blur', stdDeviation: '2', result: 'progressive-blur'
    });
    appendPrimitive(filter, 'feComposite', {
      in: 'progressive-blur', in2: 'progressive-mask', operator: 'in', result: 'inner-blur'
    });
    var blendBlur = appendPrimitive(filter, 'feBlend', {
      in: 'inner-blur', in2: 'base-blur', mode: 'normal', result: 'blurred'
    });
    var specularImage = appendPrimitive(filter, 'feImage', {
      x: '0', y: '0', width: '1', height: '1', preserveAspectRatio: 'none', result: 'specular-map'
    });
    var specularColor = appendPrimitive(filter, 'feColorMatrix', {
      in: 'specular-map', type: 'saturate', values: String(specularSaturationValue(currentConfig.specularSaturation)), result: 'specular-color'
    });
    var specularAlpha = appendPrimitive(filter, 'feComponentTransfer', {
      in: 'specular-color', result: 'specular'
    });
    var alphaFunction = appendPrimitive(specularAlpha, 'feFuncA', { type: 'linear', slope: '.45' });
    var blendSpecular = appendPrimitive(filter, 'feBlend', {
      in: 'specular', in2: 'blurred', mode: 'screen', result: 'liquid-glass'
    });
    defs.appendChild(filter);
    var state = {
      element: element,
      filter: filter,
      displacementImage: displacementImage,
      refract: refract,
      baseBlur: baseBlur,
      maskImage: maskImage,
      progressiveBlur: progressiveBlur,
      blendBlur: blendBlur,
      specularImage: specularImage,
      specularColor: specularColor,
      alphaFunction: alphaFunction,
      blendSpecular: blendSpecular,
      geometry: '',
      frameQueued: false
    };
    attached.set(element, state);
    element.dataset.itLiquidState = 'pending';
    element.style.setProperty('--it-liquid-filter', 'url(#' + filter.id + ')');
    element.style.setProperty('--it-liquid-background-opacity',
      String(currentConfig.backgroundOpacity / 100));
    return state;
  }

  function radiusFor(element, width, height) {
    var style = getComputedStyle(element);
    var value = style.borderTopLeftRadius || '0px';
    var number = parseFloat(value) || 0;
    if (/%$/.test(value)) number = Math.min(width, height) * number / 100;
    return clamp(number, 0, Math.min(width, height) / 2);
  }

  function updateFilterParameters(state, maps) {
    var config = currentConfig;
    state.filter.setAttribute('width', String(maps.width));
    state.filter.setAttribute('height', String(maps.height));
    state.displacementImage.setAttribute('width', String(maps.width));
    state.displacementImage.setAttribute('height', String(maps.height));
    state.maskImage.setAttribute('width', String(maps.width));
    state.maskImage.setAttribute('height', String(maps.height));
    state.specularImage.setAttribute('width', String(maps.width));
    state.specularImage.setAttribute('height', String(maps.height));
    state.refract.setAttribute('scale', String(2 * maps.maxDisplacement * config.refractionLevel / 100));
    state.baseBlur.setAttribute('stdDeviation', String(config.blurLevel / 100));
    state.progressiveBlur.setAttribute('stdDeviation', String(4 * config.progressiveBlurStrength / 100));
    state.specularColor.setAttribute('values', String(specularSaturationValue(config.specularSaturation)));
    state.alphaFunction.setAttribute('slope', String(config.specularOpacity / 100));
    state.element.style.setProperty('--it-liquid-background-opacity',
      String(config.backgroundOpacity / 100));
  }

  function queueResize(state) {
    if (!state || !state.element || !state.element.isConnected) return;
    resizeQueue.add(state);
    if (resizeFrame) return;
    var schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame :
      function (callback) { return setTimeout(callback, 16); };
    resizeFrame = schedule(function () {
      resizeFrame = 0;
      var pending = Array.from(resizeQueue);
      resizeQueue.clear();
      pending.forEach(updateGeometry);
    });
  }

  function updateGeometry(state) {
    var element = state.element;
    if (!element || !element.isConnected || !state.filter) return;
    if (!state.filter.isConnected) {
      var defs = ensureDefs();
      if (defs) defs.appendChild(state.filter);
    }
    var rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) {
      element.dataset.itLiquidState = 'pending';
      return;
    }
    var width = rect.width;
    var height = rect.height;
    var radius = radiusFor(element, width, height);
    var key = geometryKey(width, height, radius, currentConfig);
    if (state.geometry === key) {
      updateFilterParameters(state, state.maps);
      return;
    }
    try {
      var cached = cachedMaps(width, height, radius, currentConfig);
      state.filter.setAttribute('x', '0');
      state.filter.setAttribute('y', '0');
      state.filter.setAttribute('width', String(width));
      state.filter.setAttribute('height', String(height));
      setImageSource(state.displacementImage, cached.displacementUrl);
      setImageSource(state.maskImage, cached.blurMaskUrl);
      setImageSource(state.specularImage, cached.specularUrl);
      state.maps = cached.maps;
      state.geometry = key;
      state.errorReported = false;
      updateFilterParameters(state, cached.maps);
      element.dataset.itLiquidState = 'ready';
    } catch (error) {
      element.dataset.itLiquidState = 'error';
      if (!state.errorReported) {
        state.errorReported = true;
        reportError('generation', error);
      }
      if (typeof console !== 'undefined' && console.error) {
        console.error('[笺] Liquid Glass filter generation failed.', error);
      }
    }
  }

  function supportsRenderer() {
    if (!cssSupportsLiquidGlass()) {
      if (!unsupportedReported && typeof console !== 'undefined' && console.error) {
        unsupportedReported = true;
        console.error('[笺] This Chromium renderer does not support SVG filters as backdrop-filter. Liquid Glass cannot be rendered.');
        reportError('unsupported');
      }
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.dataset.itLiquidGlass = 'unsupported';
      }
      return false;
    }
    return true;
  }

  function ensureObservers() {
    if (typeof ResizeObserver === 'function' && !resizeObserver) {
      resizeObserver = new ResizeObserver(function (entries) {
        entries.forEach(function (entry) { queueResize(attached.get(entry.target)); });
      });
    }
    if (typeof MutationObserver === 'function' && !mutationObserver && typeof document !== 'undefined' && document.documentElement) {
      mutationObserver = new MutationObserver(function () {
        attached.forEach(function (state, element) {
          if (!element.isConnected) {
            attached.delete(element);
            resizeQueue.delete(state);
            if (resizeObserver) resizeObserver.unobserve(element);
          }
        });
      });
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function attach(element) {
    if (!element || !element.style || !element.isConnected) return null;
    var defs = ensureDefs();
    if (!defs) return null;
    var state = attached.get(element);
    if (state) {
      if (!state.filter.isConnected) defs.appendChild(state.filter);
      element.style.setProperty('--it-liquid-filter', 'url(#' + state.filter.id + ')');
      queueResize(state);
      return element;
    }
    if (!supportsRenderer()) {
      element.dataset.itLiquidState = 'unsupported';
      return null;
    }
    state = createFilter(element);
    if (!state) return null;
    ensureObservers();
    if (resizeObserver) resizeObserver.observe(element);
    queueResize(state);
    return element;
  }

  function configure(input) {
    var nextConfig = normalizeConfig(input);
    var geometryChanged = opticalGeometryKey(nextConfig) !== opticalGeometryKey(currentConfig);
    currentConfig = nextConfig;
    ensureDefs();
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.setProperty('--it-liquid-background-opacity',
        String(currentConfig.backgroundOpacity / 100));
    }
    attached.forEach(function (state, element) {
      if (!element.isConnected) {
        attached.delete(element);
        if (resizeObserver) resizeObserver.unobserve(element);
        return;
      }
      if (!state.filter.isConnected) ensureDefs().appendChild(state.filter);
      if (geometryChanged) state.geometry = '';
      element.style.setProperty('--it-liquid-filter', 'url(#' + state.filter.id + ')');
      updateFilterParameters(state, state.maps || { width: 1, height: 1, maxDisplacement: 0 });
      queueResize(state);
    });
    return currentConfig;
  }

  function refresh(scope) {
    ensureDefs();
    ensureObservers();
    attached.forEach(function (state, element) {
      if (!element.isConnected) {
        attached.delete(element);
        resizeQueue.delete(state);
        if (resizeObserver) resizeObserver.unobserve(element);
        return;
      }
      if (!scope || scope === element || (scope.contains && scope.contains(element))) queueResize(state);
    });
  }

  function ensure() {
    ensureDefs();
    ensureObservers();
    attached.forEach(function (state) {
      if (!state.filter.isConnected) ensureDefs().appendChild(state.filter);
    });
  }

  function stateOf(element) {
    return attached.get(element) || null;
  }

  return {
    version: 1,
    defaults: Object.assign({}, DEFAULTS),
    normalize: normalizeConfig,
    generateMaps: generateMaps,
    opticalGeometryKey: opticalGeometryKey,
    specularSaturationValue: specularSaturationValue,
    attach: attach,
    configure: configure,
    refresh: refresh,
    ensure: ensure,
    stateOf: stateOf
  };
});
