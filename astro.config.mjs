import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://grayznbuffalo.com',
  output: 'server',
  compressHTML: true,
  // Staff sessions use the existing SESSIONS KV; do not provision Astro SESSION.
  session: false,
  vite: {
    build: {
      assetsInlineLimit: 0,
    },
  },
  integrations: [sitemap({ filter: (page) => !page.includes('/admin') })],
  adapter: cloudflare({ imageService: 'compile' }),
});
