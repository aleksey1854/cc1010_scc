/** @type {import('next').NextConfig} */
module.exports = {
  // pg — нативный драйвер, в бандл его тащить не надо
  serverExternalPackages: ['pg'],
  async rewrites() {
    // корень отдаёт статический интерфейс из public/
    return [{ source: '/', destination: '/index.html' }];
  }
};
