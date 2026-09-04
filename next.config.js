/** @type {import('next').NextConfig} */
module.exports = {
  // pg — нативный драйвер, в бандл его тащить не надо
  serverExternalPackages: ['pg'],
  // макет чек-листа лежит файлом рядом с кодом: без этого сборка Vercel
  // его не забирает и выгрузка падает «ENOENT»
  outputFileTracingIncludes: { '/api/[fn]': ['./assets/**'] },
  async headers() {
    // Интерфейс и его скрипты браузер обязан перепроверять на каждом заходе:
    // иначе после выката остаётся старая страница с новым сервером — а это
    // битые выгрузки и «неизвестный метод» на ровном месте.
    return [{
      source: '/:file(index.html|gs-shim.js|ui-select.js|ui-phone.js)?',
      headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate' }]
    }];
  },
  async rewrites() {
    // корень отдаёт статический интерфейс из public/
    return [{ source: '/', destination: '/index.html' }];
  }
};
