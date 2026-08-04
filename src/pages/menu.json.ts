import type { APIRoute } from 'astro';
import { getMenu } from '../lib/db';

export const GET: APIRoute = async ({ locals }) => {
  const env = (locals as any).runtime?.env ?? {};
  const { categories, items } = await getMenu(env);
  const sections = categories.map((category) => ({
    name: category.name,
    items: items
      .filter((item) => item.category_id === category.id)
      .map((item) => ({
        name: item.name,
        description: item.description || undefined,
        availability: item.late_night ? 'late-night' : 'daily',
      })),
  })).filter((section) => section.items.length > 0);

  return new Response(JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Menu',
    name: "Grayz'n Buffalo Bar & Grill Menu",
    url: 'https://grayznbuffalo.com/menu',
    sections,
  }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
};
