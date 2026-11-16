/* Public GitHub Releases checks. No installer is downloaded or launched here. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ItUpdates = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  var API = 'https://api.github.com/repos/jiuxina/jian-translator/releases/latest';
  var RELEASES = 'https://github.com/jiuxina/jian-translator/releases';
  var INTERVAL = 24 * 60 * 60 * 1000;

  function parseVersion(value) {
    var match = typeof value === 'string' && /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    if (!match) return null;
    var parts = match.slice(1).map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  }

  function compareVersions(left, right) {
    var a = parseVersion(left);
    var b = parseVersion(right);
    if (!a || !b) throw new Error('无法识别发布版本号');
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    }
    return 0;
  }

  function releaseUrl(value) {
    try {
      var url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.port &&
          !url.username && !url.password &&
          /^\/jiuxina\/jian-translator\/releases\/tag\/[^/]+$/.test(url.pathname)) {
        return url.href;
      }
    } catch (error) { /* Invalid release metadata never becomes an external link. */ }
    return RELEASES;
  }

  function shouldAutoCheck(enabled, previous, now) {
    if (!enabled) return false;
    var timestamp = Number(previous);
    return !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now ||
      now - timestamp >= INTERVAL;
  }

  async function checkLatest(currentVersion, fetcher) {
    if (!parseVersion(currentVersion)) throw new Error('当前版本号无效');
    var request = fetcher || (typeof fetch === 'function' && fetch.bind(globalThis));
    if (!request) throw new Error('当前运行环境无法连接更新服务');
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 10000);
    try {
      var response = await request(API, {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (response.status === 404) return { status: 'unpublished', url: RELEASES };
      if (response.status === 403 || response.status === 429) {
        throw new Error('GitHub 检查次数受限，请稍后重试');
      }
      if (!response.ok) throw new Error('更新服务暂不可用（HTTP ' + response.status + '）');
      var release = await response.json();
      if (!release || release.draft || release.prerelease || !parseVersion(release.tag_name)) {
        throw new Error('未获取到有效的正式版本，可前往发布页查看');
      }
      var latest = parseVersion(release.tag_name).join('.');
      return {
        status: compareVersions(latest, currentVersion) > 0 ? 'available' : 'current',
        version: latest,
        url: releaseUrl(release.html_url)
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('检查更新超时，请稍后重试');
      if (error instanceof TypeError) throw new Error('无法连接 GitHub，请检查网络后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    api: API, releases: RELEASES, interval: INTERVAL,
    parseVersion: parseVersion, compareVersions: compareVersions,
    releaseUrl: releaseUrl, shouldAutoCheck: shouldAutoCheck, checkLatest: checkLatest
  };
});
