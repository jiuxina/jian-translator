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
  var OPTICAL_DEFAULTS = {
    surfaceProfile: 'convex-circle',
    bezelWidth: 60,
    glassThickness: 50,
    refractiveIndex: 1.5,
  };
  var DEFAULTS = {
    card: {
      specularOpacity: 40, specularSaturation: 6, refractionLevel: 100,
      blurLevel: 1, progressiveBlurStrength: 1, backgroundOpacity: 60
    },
    pill: {
      specularOpacity: 50, specularSaturation: 6, refractionLevel: 100, blurLevel: .2
    },
    button: {
      specularOpacity: 50, specularSaturation: 9, refractionLevel: 100
    }
  };
  var PROFILES = ['convex-circle', 'convex-squircle', 'concave', 'lip'];
  var attached = new Map();
  var geometryCache = new Map();
  var appliedStyles = new WeakMap();
  var currentConfig = normalizePresets(DEFAULTS);
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

  function roundedNumber(value, min, max, fallback, digits) {
    return Number(clamp(numberOr(value, fallback), min, max).toFixed(digits || 0));
  }

  function normalizeOptics(input) {
    var source = input && typeof input === 'object' ? input : {};
    var result = {};
    result.surfaceProfile = PROFILES.indexOf(source.surfaceProfile) >= 0
      ? source.surfaceProfile : OPTICAL_DEFAULTS.surfaceProfile;
    result.bezelWidth = roundedNumber(source.bezelWidth, 1, 128, OPTICAL_DEFAULTS.bezelWidth, 4);
    result.glassThickness = roundedNumber(source.glassThickness, .01, 200, OPTICAL_DEFAULTS.glassThickness, 4);
    result.refractiveIndex = roundedNumber(source.refractiveIndex, 1, 2.5, OPTICAL_DEFAULTS.refractiveIndex, 1);
    return result;
  }

  function normalizePresets(input) {
    var source = input && typeof input === 'object' ? input : {};
    var result = {};
    Object.keys(DEFAULTS).forEach(function (name) {
      var values = source[name] && typeof source[name] === 'object' ? source[name] : {};
      var defaults = DEFAULTS[name];
      var config = {
        specularOpacity: roundedNumber(values.specularOpacity, 0, 100, defaults.specularOpacity),
        specularSaturation: roundedNumber(values.specularSaturation, 0, 50, defaults.specularSaturation),
        refractionLevel: roundedNumber(values.refractionLevel, 0, 100, defaults.refractionLevel)
      };
      if (name !== 'button') config.blurLevel = roundedNumber(values.blurLevel, 0, 40, defaults.blurLevel, 1);
      if (name === 'card') {
        config.progressiveBlurStrength = roundedNumber(values.progressiveBlurStrength, 0, 10,
          defaults.progressiveBlurStrength, 2);
        config.backgroundOpacity = roundedNumber(values.backgroundOpacity, 0, 100, defaults.backgroundOpacity);
      }
      result[name] = config;
    });
    return result;
  }

  function presetName(value) {
    return Object.prototype.hasOwnProperty.call(DEFAULTS, value) ? value : 'card';
  }

  function opticalPreset(name, radius) {
    var result = normalizeOptics(OPTICAL_DEFAULTS);
    if (name === 'pill') result.surfaceProfile = 'lip';
    var bezel = Math.max(1, Math.min(result.bezelWidth, numberOr(radius, 1) || 1));
    // Resize the reference optical cross-section as one shape. Keeping a
    // 50px thickness when a small component has a 12px bezel creates a much
    // stronger lens than the reference's 60:50 bezel/thickness proportion.
    var scale = bezel / result.bezelWidth;
    result.bezelWidth = bezel;
    result.glassThickness *= scale;
    return result;
  }

  function presetOpacity(name, config, active) {
    if (name === 'pill') return active ? .1 : 1;
    if (name === 'button') return 0;
    return config.backgroundOpacity / 100;
  }

  function interactionParameters(name, input, active) {
    var resolved = presetName(name);
    var source = {};
    source[resolved] = input;
    var config = normalizePresets(source)[resolved];
    var ratio = resolved === 'pill' ? (active ? .9 : .4) : 1;
    return {
      refractionRatio: ratio * config.refractionLevel / 100,
      backgroundOpacity: presetOpacity(resolved, config, !!active)
    };
  }

  function progressiveLevels(value) {
    var strength = roundedNumber(value, 0, 10, DEFAULTS.card.progressiveBlurStrength, 2);
    return [Math.sqrt(Math.sqrt(strength)) / 2, Math.sqrt(strength), strength];
  }

  function circleHeight(t) {
    return Math.sqrt(Math.max(0, 1 - Math.pow(1 - t, 2)));
  }

  function squircleHeight(t) {
    return Math.pow(Math.max(0, 1 - Math.pow(1 - t, 4)), .25);
  }

  function profileHeight(profile, t) {
    t = clamp(t, 0, 1);
    if (profile === 'convex-circle') return circleHeight(t);
    if (profile === 'concave') return 1 - circleHeight(t);
    if (profile === 'lip') {
      var blend = 6 * Math.pow(t, 5) - 15 * Math.pow(t, 4) + 10 * Math.pow(t, 3);
      return squircleHeight(2 * t) * (1 - blend) + (1 - circleHeight(t) + .1) * blend;
    }
    return squircleHeight(t);
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

  function mapDimensions(width, height) {
    var scale = Math.min(1, MAX_MAP_SIDE / Math.max(width, height),
      Math.sqrt(MAX_MAP_PIXELS / (width * height)));
    return {
      width: Math.max(4, Math.round(width * scale)),
      height: Math.max(4, Math.round(height * scale))
    };
  }

  function generateMaps(width, height, radius, input) {
    var config = normalizeOptics(input);
    width = Math.max(4, numberOr(width, 4));
    height = Math.max(4, numberOr(height, 4));
    radius = clamp(numberOr(radius, 0), 0, Math.min(width, height) / 2);
    var dimensions = mapDimensions(width, height);
    var mapWidth = dimensions.width;
    var mapHeight = dimensions.height;
    var displacement = new Uint8ClampedArray(mapWidth * mapHeight * 4);
    var specular = new Uint8ClampedArray(mapWidth * mapHeight * 4);
    var vectorsX = new Float32Array(mapWidth * mapHeight);
    var vectorsY = new Float32Array(mapWidth * mapHeight);
    var maxDisplacement = 0;
    var bezel = Math.min(config.bezelWidth, radius || Math.min(width, height) / 2);
    var thickness = config.glassThickness;
    var indexRatio = 1 / config.refractiveIndex;
    var lightAngle = Math.PI / 3;
    var lightX = Math.cos(lightAngle);
    var lightY = Math.sin(lightAngle);

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
        displacement[offset] = 128;
        displacement[offset + 1] = 128;
        displacement[offset + 2] = 128;
        displacement[offset + 3] = 255;
        specular[offset] = 255;
        specular[offset + 1] = 255;
        specular[offset + 2] = 255;
        specular[offset + 3] = 0;
        if (!inside) continue;

        // The reference specular map is a directional grey/white rim. Color
        // comes from the displaced scene later, never from an invented hue.
        var rimCurve = Math.sqrt(Math.max(0, 1 - Math.pow(1 - distance, 2)));
        var illumination = Math.abs(shape.nx * lightX - shape.ny * lightY) * rimCurve;
        var grey = Math.round(clamp(illumination, 0, 1) * 255);
        specular[offset] = grey;
        specular[offset + 1] = grey;
        specular[offset + 2] = grey;
        specular[offset + 3] = Math.round(255 * illumination * illumination);
        if (distance >= bezel || config.refractiveIndex <= 1) continue;

        var delta = .0001;
        var t = bevelAmount;
        var heightAtPoint = profileHeight(config.surfaceProfile, t);
        var nextT = t + delta <= 1 ? t + delta : t - delta;
        var slope = (profileHeight(config.surfaceProfile, nextT) - heightAtPoint) / (nextT - t);
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
        var travel = thickness + heightAtPoint * bezel;
        var shiftX = -travel * rayX / Math.max(.001, rayZ);
        var shiftY = -travel * rayY / Math.max(.001, rayZ);
        var shiftLength = Math.hypot(shiftX, shiftY);
        vectorsX[index] = shiftX;
        vectorsY[index] = shiftY;
        maxDisplacement = Math.max(maxDisplacement, shiftLength);

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
      specular: specular
    };
  }

  function geometryKey(width, height, radius, config) {
    return [width.toFixed(2), height.toFixed(2), radius.toFixed(2), opticalGeometryKey(config)].join(':');
  }

  function opticalGeometryKey(input) {
    var config = normalizeOptics(input);
    return [config.surfaceProfile, config.bezelWidth, config.glassThickness,
      config.refractiveIndex].join(':');
  }

  function specularSaturationValue(input) {
    return roundedNumber(input, 0, 50, DEFAULTS.card.specularSaturation);
  }

  function rendererSupport(userAgent, supportsCss) {
    var ua = typeof userAgent === 'string' ? userAgent : '';
    var chromium = /(?:Chrome|Chromium|Edg|Electron)\/\d+/i.test(ua);
    var excluded = /(?:Firefox|FxiOS|CriOS|EdgiOS|OPiOS)\/|iP(?:hone|ad|od)/i.test(ua);
    return {
      supported: !!supportsCss && chromium && !excluded,
      reason: !chromium || excluded ? 'non-chromium' : !supportsCss ? 'css-filter-unavailable' : ''
    };
  }

  function cssSupportsLiquidGlass() {
    if (typeof document === 'undefined' || !document.createElementNS) return false;
    if (typeof CSS === 'undefined' || !CSS.supports) return false;
    var urlSupported = CSS.supports('backdrop-filter', 'url(#it-liquid-glass-check)') ||
      CSS.supports('-webkit-backdrop-filter', 'url(#it-liquid-glass-check)');
    var svgSupported = !!document.createElementNS(SVG_NS, 'filter');
    var ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return rendererSupport(ua, urlSupported && svgSupported).supported;
  }

  function setImageSource(image, source) {
    if (image.getAttribute('href') !== source) image.setAttribute('href', source);
    if (image.getAttributeNS(XLINK_NS, 'href') !== source) {
      image.setAttributeNS(XLINK_NS, 'xlink:href', source);
    }
  }

  function setAttributeIfChanged(element, name, value) {
    value = String(value);
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }

  function setStyleIfChanged(element, name, value) {
    value = String(value);
    var current = element.style.getPropertyValue(name);
    if (current === value) return;
    var styles = appliedStyles.get(element);
    var previous = styles && styles[name];
    // CSSOM rounds values such as blur(.7071067811865476px). Compare both
    // the requested value and its last serialization without reducing the
    // precision sent to the renderer, and still repair external style edits.
    if (previous && previous.requested === value && previous.serialized === current) return;
    element.style.setProperty(name, value);
    if (!styles) {
      styles = Object.create(null);
      appliedStyles.set(element, styles);
    }
    styles[name] = { requested: value, serialized: element.style.getPropertyValue(name) };
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
      // The filter only needs these scalars after the two PNGs are encoded.
      // Retaining the RGBA arrays here also pins them in every attached state.
      maps: {
        width: maps.width,
        height: maps.height,
        mapWidth: maps.mapWidth,
        mapHeight: maps.mapHeight,
        radius: maps.radius,
        maxDisplacement: maps.maxDisplacement
      },
      displacementUrl: canvasPng(maps.displacement, maps.mapWidth, maps.mapHeight),
      specularUrl: canvasPng(maps.specular, maps.mapWidth, maps.mapHeight)
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
      attached.forEach(function (state, element) {
        if (!element.isConnected) {
          discardState(state, element);
        } else if (state.filter) {
          defs.appendChild(state.filter);
        }
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

  function createSurfaceLayers(element, name) {
    var background = document.createElement('span');
    background.setAttribute('data-it-liquid-background', '');
    background.setAttribute('aria-hidden', 'true');
    background.inert = true;
    background.style.pointerEvents = 'none';
    element.insertBefore(background, element.firstChild);
    var progressive = null;
    var layers = [];
    if (name === 'card') {
      progressive = document.createElement('span');
      progressive.setAttribute('data-it-liquid-progressive', '');
      progressive.setAttribute('aria-hidden', 'true');
      progressive.inert = true;
      progressive.style.pointerEvents = 'none';
      var fades = [[70, 100], [50, 75], [20, 55]];
      fades.forEach(function (fade, index) {
        var layer = document.createElement('span');
        layer.setAttribute('data-it-liquid-progressive-layer', String(index + 1));
        layer.style.pointerEvents = 'none';
        var mask = 'linear-gradient(to bottom,#000 ' + fade[0] + '%,transparent ' + fade[1] + '%)';
        layer.style.maskImage = mask;
        layer.style.webkitMaskImage = mask;
        progressive.appendChild(layer);
        layers.push(layer);
      });
      element.insertBefore(progressive, background.nextSibling);
    }
    return { background: background, progressive: progressive, layers: layers };
  }

  function ensureSurfaceLayers(state) {
    var element = state.element;
    if (!element || !element.isConnected) return;
    if (state.background.parentNode !== element) {
      element.insertBefore(state.background, element.firstChild);
    }
    if (state.progressive && state.progressive.parentNode !== element) {
      element.insertBefore(state.progressive, state.background.nextSibling);
    }
  }

  function createFilter(element, name) {
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
    var config = currentConfig[name];
    var baseBlur = appendPrimitive(filter, 'feGaussianBlur', {
      in: 'SourceGraphic', stdDeviation: String(config.blurLevel || 0), result: 'base-blur'
    });
    var displacementImage = appendPrimitive(filter, 'feImage', {
      x: '0', y: '0', width: '1', height: '1', preserveAspectRatio: 'none', result: 'displacement-map'
    });
    var refract = appendPrimitive(filter, 'feDisplacementMap', {
      in: 'base-blur', in2: 'displacement-map', scale: '0',
      xChannelSelector: 'R', yChannelSelector: 'G', result: 'refracted'
    });
    var previousBlur = 'refracted';
    var specularImage = appendPrimitive(filter, 'feImage', {
      x: '0', y: '0', width: '1', height: '1', preserveAspectRatio: 'none', result: 'specular-map'
    });
    var specularColor = appendPrimitive(filter, 'feColorMatrix', {
      in: previousBlur, type: 'saturate', values: String(config.specularSaturation),
      result: 'displaced-saturated'
    });
    appendPrimitive(filter, 'feComposite', {
      in: 'displaced-saturated', in2: 'specular-map', operator: 'in', result: 'specular-saturated'
    });
    appendPrimitive(filter, 'feBlend', {
      in: 'specular-saturated', in2: previousBlur, mode: 'normal', result: 'with-saturation'
    });
    var specularAlpha = appendPrimitive(filter, 'feComponentTransfer', {
      in: 'specular-map', result: 'specular'
    });
    var alphaFunction = appendPrimitive(specularAlpha, 'feFuncA', { type: 'linear', slope: '.45' });
    var blendSpecular = appendPrimitive(filter, 'feBlend', {
      in: 'specular', in2: 'with-saturation', mode: 'normal', result: 'liquid-glass'
    });
    defs.appendChild(filter);
    var layers = createSurfaceLayers(element, name);
    var state = {
      element: element,
      presetName: name,
      interactionActive: false,
      filter: filter,
      displacementImage: displacementImage,
      refract: refract,
      baseBlur: baseBlur,
      background: layers.background,
      progressive: layers.progressive,
      progressiveLayers: layers.layers,
      specularImage: specularImage,
      specularColor: specularColor,
      alphaFunction: alphaFunction,
      blendSpecular: blendSpecular,
      geometry: ''
    };
    attached.set(element, state);
    element.dataset.itLiquidState = 'pending';
    element.dataset.itLiquidPreset = name;
    element.dataset.itLiquidActive = 'false';
    element.style.setProperty('--it-liquid-filter', 'url(#' + filter.id + ')');
    element.style.setProperty('--it-liquid-background-opacity',
      String(presetOpacity(name, config, false)));
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
    var config = currentConfig[state.presetName];
    var ratio = state.presetName === 'pill' ? (state.interactionActive ? .9 : .4) : 1;
    var opacity = presetOpacity(state.presetName, config, state.interactionActive);
    setAttributeIfChanged(state.filter, 'width', maps.width);
    setAttributeIfChanged(state.filter, 'height', maps.height);
    setAttributeIfChanged(state.displacementImage, 'width', maps.width);
    setAttributeIfChanged(state.displacementImage, 'height', maps.height);
    setAttributeIfChanged(state.specularImage, 'width', maps.width);
    setAttributeIfChanged(state.specularImage, 'height', maps.height);
    // Keep the reference demo's scale convention: normalized map maximum ×
    // slider ratio. SVG interprets each channel around .5; doubling this here
    // would produce a stronger lens than the reference's 100% preset.
    setAttributeIfChanged(state.refract, 'scale', maps.maxDisplacement * (ratio * config.refractionLevel / 100));
    setAttributeIfChanged(state.baseBlur, 'stdDeviation', config.blurLevel || 0);
    var levels = progressiveLevels(config.progressiveBlurStrength || 0);
    state.progressiveLayers.forEach(function (layer, index) {
      var blur = 'blur(' + levels[index] + 'px)';
      setStyleIfChanged(layer, 'backdrop-filter', blur);
      setStyleIfChanged(layer, '-webkit-backdrop-filter', blur);
      setStyleIfChanged(state.element, '--it-liquid-progressive-' + (index + 1), levels[index] + 'px');
    });
    setAttributeIfChanged(state.specularColor, 'values', config.specularSaturation);
    setAttributeIfChanged(state.alphaFunction, 'slope', config.specularOpacity / 100);
    setStyleIfChanged(state.element, '--it-liquid-background-opacity', opacity);
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
      // Read every local border box before any SVG/style writes. Inserting
      // filters between measurements forces one layout per surface.
      var measurements = pending.map(measureGeometry);
      pending.forEach(function (state, index) { updateGeometry(state, measurements[index]); });
    });
  }

  function markReady(element) {
    if (element.dataset.itLiquidState !== 'ready') element.dataset.itLiquidState = 'ready';
    if (document.documentElement.dataset.itLiquidGlass !== 'ready' &&
        document.documentElement.dataset.itLiquidGlass !== 'error' &&
        document.documentElement.dataset.itLiquidGlass !== 'unsupported') {
      document.documentElement.dataset.itLiquidGlass = 'ready';
    }
  }

  function measureGeometry(state) {
    var element = state.element;
    if (!element || !element.isConnected || !state.filter) return null;
    // SVG user-space follows the local border box. Bounding rect dimensions
    // include dialog/selection scale animations and would permanently bake a
    // transient transform into the map without triggering ResizeObserver.
    var width = element.offsetWidth;
    var height = element.offsetHeight;
    if (typeof width !== 'number' || typeof height !== 'number') {
      var rect = element.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
    }
    return {
      width: width,
      height: height,
      radius: width >= 4 && height >= 4 ? radiusFor(element, width, height) : 0
    };
  }

  function updateGeometry(state, measurement) {
    var element = state.element;
    if (!measurement || !element || !element.isConnected || !state.filter) return;
    if (!state.filter.isConnected) {
      var defs = ensureDefs();
      if (defs) defs.appendChild(state.filter);
    }
    var width = measurement.width;
    var height = measurement.height;
    if (width < 4 || height < 4) {
      // Attribute observers refresh newly shown surfaces. Rewriting the same
      // pending value for a hidden surface would schedule another refresh on
      // every frame forever.
      if (element.dataset.itLiquidState !== 'pending') element.dataset.itLiquidState = 'pending';
      return;
    }
    var radius = measurement.radius;
    var optics = opticalPreset(state.presetName, radius);
    var key = geometryKey(width, height, radius, optics);
    if (state.geometry === key) {
      updateFilterParameters(state, state.maps);
      markReady(element);
      return;
    }
    try {
      var cached = cachedMaps(width, height, radius, optics);
      setImageSource(state.displacementImage, cached.displacementUrl);
      setImageSource(state.specularImage, cached.specularUrl);
      state.maps = cached.maps;
      state.geometry = key;
      state.errorReported = false;
      updateFilterParameters(state, cached.maps);
      markReady(element);
    } catch (error) {
      element.dataset.itLiquidState = 'error';
      document.documentElement.dataset.itLiquidGlass = 'error';
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
      mutationObserver = new MutationObserver(function (mutations) {
        var removedSurface = false;
        mutations.forEach(function (mutation) {
          var state = attached.get(mutation.target);
          if (state) ensureSurfaceLayers(state);
          mutation.removedNodes.forEach(function (node) {
            if (node.nodeType === 1 && (attached.has(node) ||
                node.querySelector('[data-it-liquid-preset]'))) removedSurface = true;
          });
        });
        // Streaming text replaces short-lived spans on every frame. Only
        // removing an actual surface (or its ancestor) needs a registry scan.
        if (removedSurface) attached.forEach(function (state, element) {
          if (!element.isConnected) discardState(state, element);
        });
      });
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function attach(element, name) {
    if (!element || !element.style || !element.isConnected) return null;
    var targetPreset = presetName(name || element.dataset.itLiquidPreset);
    var defs = ensureDefs();
    if (!defs) return null;
    var state = attached.get(element);
    if (state && state.presetName !== targetPreset) {
      discardState(state, element);
      state = null;
    }
    if (state) {
      ensureSurfaceLayers(state);
      setAttributeIfChanged(element, 'data-it-liquid-preset', targetPreset);
      if (!state.filter.isConnected) defs.appendChild(state.filter);
      setStyleIfChanged(element, '--it-liquid-filter', 'url(#' + state.filter.id + ')');
      queueResize(state);
      return element;
    }
    if (!supportsRenderer()) {
      element.dataset.itLiquidState = 'unsupported';
      element.dataset.itLiquidPreset = targetPreset;
      return null;
    }
    state = createFilter(element, targetPreset);
    if (!state) return null;
    ensureObservers();
    if (resizeObserver) resizeObserver.observe(element);
    queueResize(state);
    return element;
  }

  function discardState(state, element) {
    attached.delete(element);
    resizeQueue.delete(state);
    if (resizeObserver) resizeObserver.unobserve(element);
    if (state.filter && state.filter.parentNode) state.filter.parentNode.removeChild(state.filter);
    if (state.background && state.background.parentNode) state.background.parentNode.removeChild(state.background);
    if (state.progressive && state.progressive.parentNode) state.progressive.parentNode.removeChild(state.progressive);
  }

  function configure(input) {
    currentConfig = normalizePresets(input);
    ensureDefs();
    if (typeof document !== 'undefined' && document.documentElement) {
      setStyleIfChanged(document.documentElement, '--it-liquid-background-opacity',
        currentConfig.card.backgroundOpacity / 100);
    }
    attached.forEach(function (state, element) {
      if (!element.isConnected) {
        discardState(state, element);
        return;
      }
      if (!state.filter.isConnected) ensureDefs().appendChild(state.filter);
      ensureSurfaceLayers(state);
      setStyleIfChanged(element, '--it-liquid-filter', 'url(#' + state.filter.id + ')');
      updateFilterParameters(state, state.maps || { width: 1, height: 1, maxDisplacement: 0 });
      queueResize(state);
    });
    return currentConfig;
  }

  function setInteraction(scope, active) {
    if (!scope) return 0;
    var updated = 0;
    attached.forEach(function (state, element) {
      if (state.presetName !== 'pill' ||
          !(scope === element || (scope.contains && scope.contains(element)))) return;
      state.interactionActive = !!active;
      setAttributeIfChanged(element, 'data-it-liquid-active', state.interactionActive ? 'true' : 'false');
      if (state.maps) updateFilterParameters(state, state.maps);
      updated++;
    });
    return updated;
  }

  function refresh(scope) {
    ensureDefs();
    ensureObservers();
    attached.forEach(function (state, element) {
      if (!element.isConnected) {
        discardState(state, element);
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
      ensureSurfaceLayers(state);
    });
  }

  function stateOf(element) {
    return attached.get(element) || null;
  }

  return {
    version: 4,
    defaults: normalizePresets(DEFAULTS),
    presetDefaults: normalizePresets(DEFAULTS),
    normalize: normalizePresets,
    normalizePresets: normalizePresets,
    normalizeOptics: normalizeOptics,
    generateMaps: generateMaps,
    opticalGeometryKey: opticalGeometryKey,
    opticalPreset: opticalPreset,
    profileHeight: profileHeight,
    interactionParameters: interactionParameters,
    progressiveLevels: progressiveLevels,
    specularSaturationValue: specularSaturationValue,
    rendererSupport: rendererSupport,
    attach: attach,
    configure: configure,
    setInteraction: setInteraction,
    refresh: refresh,
    ensure: ensure,
    stateOf: stateOf
  };
});
