
const https = require('https');

const DEFAULT_REPOSITORIES = [
  {
    id: 'vietnamese-movie',
    name: 'Vietnamese Movie',
    url: 'https://gitlab.com/tearrs/movie/-/raw/main/repo.json'
  },
  {
    id: 'vietnamese-extension',
    name: 'Vietnamese Extension',
    url: 'https://raw.githubusercontent.com/h0dev/0cs3/refs/heads/movie/repo.json'
  }
];

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT = 6500;

function isPrivateHost(host) {
  const h = host.toLowerCase();

  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) {
      return reject(new Error('Quá nhiều redirect.'));
    }

    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error('URL không hợp lệ.'));
    }

    if (
      parsed.protocol !== 'https:' ||
      isPrivateHost(parsed.hostname)
    ) {
      return reject(
        new Error('Chỉ cho phép URL HTTPS công khai.')
      );
    }

    const req = https.get(
      parsed,
      {
        headers: {
          'user-agent': 'CS3-Stremio-Bridge/0.2.0',
          accept: 'application/json'
        }
      },
      res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const next = new URL(
            res.headers.location || '',
            parsed
          ).toString();

          res.resume();
          return resolve(fetchJson(next, redirects + 1));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(
            new Error('HTTP ' + res.statusCode)
          );
        }

        let body = '';

        res.on('data', chunk => {
          body += chunk;

          if (Buffer.byteLength(body) > MAX_BYTES) {
            req.destroy(
              new Error('Dữ liệu vượt quá 2 MB.')
            );
          }
        });

        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new Error('Phản hồi không phải JSON hợp lệ.')
            );
          }
        });
      }
    );

    req.setTimeout(TIMEOUT, () => {
      req.destroy(new Error('Hết thời gian chờ.'));
    });

    req.on('error', reject);
  });
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function getPluginTypes(plugin) {
  const value = plugin.tvTypes || plugin.type || [];

  if (Array.isArray(value)) {
    return value.map(String);
  }

  if (typeof value === 'string') {
    return value.split(/[,;|]/).map(x => x.trim()).filter(Boolean);
  }

  return [];
}

function classifyPlugin(plugin) {
  const types = getPluginTypes(plugin)
    .map(x => x.toLowerCase());

  const name = [
    plugin.name,
    plugin.internalName,
    plugin.description
  ].filter(Boolean).join(' ').toLowerCase();

  const hasMovie = types.some(x => x.includes('movie'));
  const hasSeries = types.some(
    x =>
      x.includes('series') ||
      x.includes('tvshow') ||
      x.includes('tv show')
  );

  const hasAnime =
    types.some(x => x.includes('anime')) ||
    /\banime\b|hoathinh|hoat hinh/.test(name);

  if (
    /1dpi|1sync|subtitle|subtitles|player|translator/.test(name) &&
    types.length === 0
  ) {
    return 'utility';
  }

  if (hasAnime && (hasMovie || hasSeries)) {
    return 'anime';
  }

  if (hasAnime) {
    return 'anime';
  }

  if (hasMovie && hasSeries) {
    return 'movie-series';
  }

  if (hasMovie) {
    return 'movie';
  }

  if (hasSeries) {
    return 'series';
  }

  return 'unknown';
}

function getStatus(plugin) {
  if (
    plugin.status === 0 ||
    plugin.status === '0'
  ) {
    return 'disabled';
  }

  if (
    plugin.status === 1 ||
    plugin.status === '1'
  ) {
    return 'active';
  }

  return 'unknown';
}

function normalizePlugin(plugin, repository) {
  const name =
    plugin.name ||
    plugin.internalName ||
    'Unnamed plugin';

  const internalName =
    plugin.internalName ||
    plugin.name ||
    name;

  return {
    key: normalizeText(internalName),
    name,
    internalName,
    version: plugin.version || null,
    language: plugin.language || null,
    description: plugin.description || '',
    tvTypes: getPluginTypes(plugin),
    category: classifyPlugin(plugin),
    status: getStatus(plugin),
    repositories: [repository.id],
    repositoryNames: [repository.name],
    integration: 'pending-js-adapter'
  };
}

async function loadRepository(repository) {
  const manifest = await fetchJson(repository.url);

  if (
    !manifest ||
    !Array.isArray(manifest.pluginLists)
  ) {
    throw new Error(
      repository.name + ': manifest không có pluginLists.'
    );
  }

  const lists = await Promise.all(
    manifest.pluginLists.map(url => fetchJson(url))
  );

  const plugins = lists.flatMap(list => {
    if (Array.isArray(list)) {
      return list;
    }

    if (Array.isArray(list?.plugins)) {
      return list.plugins;
    }

    return [];
  });

  return {
    id: repository.id,
    name: manifest.name || repository.name,
    description: manifest.description || '',
    totalPlugins: plugins.length,
    plugins
  };
}

function mergePlugins(repositories) {
  const registry = new Map();

  for (const repository of repositories) {
    for (const raw of repository.plugins) {
      if (!raw || typeof raw !== 'object') continue;

      const plugin = normalizePlugin(raw, repository);
      const key = plugin.key || normalizeText(plugin.name);

      if (!key) continue;

      const existing = registry.get(key);

      if (!existing) {
        registry.set(key, plugin);
        continue;
      }

      existing.repositories.push(repository.id);
      existing.repositoryNames.push(repository.name);

      if (!existing.description && plugin.description) {
        existing.description = plugin.description;
      }

      if (!existing.version && plugin.version) {
        existing.version = plugin.version;
      }

      if (
        existing.category === 'unknown' &&
        plugin.category !== 'unknown'
      ) {
        existing.category = plugin.category;
      }

      existing.tvTypes = [
        ...new Set([
          ...existing.tvTypes,
          ...plugin.tvTypes
        ])
      ];

      existing.repositories = [
        ...new Set(existing.repositories)
      ];

      existing.repositoryNames = [
        ...new Set(existing.repositoryNames)
      ];
    }
  }

  return Array.from(registry.values()).sort(
    (a, b) => a.name.localeCompare(b.name)
  );
}

async function handler(req, res) {
  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  if (req.method !== 'GET') {
    res.statusCode = 405;

    return res.end(JSON.stringify({
      error: 'Method not allowed'
    }));
  }

  try {
    const results = await Promise.allSettled(
      DEFAULT_REPOSITORIES.map(loadRepository)
    );

    const repositories = [];
    const errors = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        repositories.push(result.value);
      } else {
        errors.push({
          repository: DEFAULT_REPOSITORIES[index].name,
          error: result.reason?.message || 'Unknown error'
        });
      }
    });

    if (repositories.length === 0) {
      throw new Error(
        'Không đọc được repository nào: ' +
        errors.map(x => x.error).join('; ')
      );
    }

    const plugins = mergePlugins(repositories);

    const stats = {
      repositoriesLoaded: repositories.length,
      repositoriesFailed: errors.length,
      totalUniquePlugins: plugins.length,
      categories: {},
      statuses: {}
    };

    for (const plugin of plugins) {
      stats.categories[plugin.category] =
        (stats.categories[plugin.category] || 0) + 1;

      stats.statuses[plugin.status] =
        (stats.statuses[plugin.status] || 0) + 1;
    }

    res.statusCode = 200;

    return res.end(JSON.stringify({
      version: '0.2.0',
      registry: 'CS3 Provider Registry',
      generatedAt: new Date().toISOString(),
      repositories,
      errors,
      stats,
      plugins
    }));
  } catch (error) {
    res.statusCode = 500;

    return res.end(JSON.stringify({
      error: error.message || 'Registry failed'
    }));
  }
}

module.exports = handler;
