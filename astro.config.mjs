import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

const localReviews = process.env.GRAYZN_REVIEWS_LOCAL === '1';
if (localReviews) {
  // Development tooling can otherwise expose fixture originals and staff
  // session data outside the application's authenticated routes.
  process.env.X_LOCAL_EXPLORER = 'false';
  process.env.X_LOCAL_OBSERVABILITY = 'false';
}

export default defineConfig({
  site: 'https://grayznbuffalo.com',
  output: 'server',
  compressHTML: true,
  // Staff sessions use the existing SESSIONS KV; do not provision Astro SESSION.
  session: false,
  ...(localReviews && { devToolbar: { enabled: false } }),
  vite: {
    build: {
      assetsInlineLimit: 0,
    },
  },
  integrations: [sitemap({ filter: (page) => !page.includes('/admin') && !/^\/reviews\/?$/.test(new URL(page).pathname) })],
  adapter: cloudflare({
    imageService: 'compile',
    ...(localReviews && {
      configPath: './wrangler.reviews-local.toml',
      persistState: { path: './.wrangler/reviews-local' },
      remoteBindings: false,
      inspectorPort: false,
    }),
  }),
});
