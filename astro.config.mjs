import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://grayznbuffalo.com',
  output: 'server',
  vite: {
    build: {
      assetsInlineLimit: 0,
    },
  },
  integrations: [sitemap({ filter: (page) => !page.includes('/admin') })],
  adapter: cloudflare({ platformProxy: { enabled: true } }),
});
