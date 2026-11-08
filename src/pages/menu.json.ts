import type { APIRoute } from 'astro';
import { getMenu } from '../lib/db';
import { getPizzaOptions, isPizzaCategory, PIZZA_SCOPE } from '../lib/pizza-options.js';
import { getMenuSauces, getSaucesSort, saucesIndex, saucesSectionName, MENU_SAUCE_NOTE } from '../lib/menu-sauces';

export const GET: APIRoute = async ({ locals }) => {
  const env = (locals as any).runtime?.env ?? {};
  const { categories, items } = await getMenu(env);
  const pizzaOptions = await getPizzaOptions(env);
  const [sauces, saucesSort] = await Promise.all([getMenuSauces(env), getSaucesSort(env)]);
  const listed = categories.filter((category) => items.some((item) => item.category_id === category.id));
  const sections: Record<string, unknown>[] = listed.map((category) => ({
    name: category.name,
    subtitle: category.subtitle || undefined,
    note: category.note || undefined,
    ...(isPizzaCategory(category.name) ? { pizzaOptions: { ...pizzaOptions, scope: PIZZA_SCOPE } } : {}),
    items: items
      .filter((item) => item.category_id === category.id)
      .map((item) => ({
        name: item.name,
        description: item.description || undefined,
        availability: item.late_night ? 'late-night' : 'daily',
      })),
  }));
  // Same position as the Menu page; the one Wing Wednesday sauce list, no prices.
  if (sauces.length) sections.splice(saucesIndex(listed, saucesSort), 0, { name: saucesSectionName(categories), note: MENU_SAUCE_NOTE, sauces });

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
