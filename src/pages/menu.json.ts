import { runtimeEnv } from '../lib/runtime-env';
import type { APIRoute } from 'astro';
import { getMenu } from '../lib/db';
import { getPizzaOptions, isPizzaCategory, PIZZA_SCOPE } from '../lib/pizza-options.js';
import { getMenuSauces, MENU_SAUCE_NOTE } from '../lib/menu-sauces';
import { SAUCES_SECTION, SIDES_SECTION, getSectionSort, sectionIndex, sectionName, interleave } from '../lib/menu-sections';
import {
  getMenuOptions, greensText, hasShell, isSaladCategory, isWrapCategory, SALAD_OPTIONS_KEY, SALAD_SHELL_NOTE,
  SUBSTITUTE_SIDES_KEY, SUBSTITUTE_SIDES_NOTE, WRAP_OPTIONS_KEY,
} from '../lib/menu-options.js';

export const GET: APIRoute = async ({ locals }) => {
  const env = runtimeEnv(locals);
  const { categories, items } = await getMenu(env);
  const [pizzaOptions, sauces, saucesSort, sidesSort, wrapOptions, saladOptions, sidesOptions] = await Promise.all([
    getPizzaOptions(env), getMenuSauces(env), getSectionSort(env, SAUCES_SECTION), getSectionSort(env, SIDES_SECTION),
    getMenuOptions(env, WRAP_OPTIONS_KEY), getMenuOptions(env, SALAD_OPTIONS_KEY), getMenuOptions(env, SUBSTITUTE_SIDES_KEY),
  ]);
  const listed = categories.filter((category) => items.some((item) => item.category_id === category.id));
  const sections: Record<string, unknown>[] = listed.map((category) => {
    const own = items.filter((item) => item.category_id === category.id);
    const salad = isSaladCategory(category.name), shells = salad && own.some((item) => hasShell(saladOptions, item.name));
    return {
      name: category.name,
      subtitle: category.subtitle || undefined,
      note: category.note || undefined,
      ...(isPizzaCategory(category.name) ? { pizzaOptions: { ...pizzaOptions, scope: PIZZA_SCOPE } } : {}),
      ...(isWrapCategory(category.name) && wrapOptions.notes.length ? { wrapOptions } : {}),
      ...(salad && (saladOptions.dressings.length || saladOptions.greens.length || shells) ? { saladOptions: {
        dressings: saladOptions.dressings, greens: saladOptions.greens, greensNote: greensText(saladOptions.greens) || undefined,
        ...(shells ? { shellNote: SALAD_SHELL_NOTE } : {}),
      } } : {}),
      items: own.map((item) => ({
        name: item.name,
        description: item.description || undefined,
        availability: item.late_night ? 'late-night' : 'daily',
        ...(salad && hasShell(saladOptions, item.name) ? { shell: true } : {}),
      })),
    };
  });
  // Same positions as the Menu page. No prices anywhere.
  const virtual = [
    ...(sauces.length ? [{ index: sectionIndex(listed, saucesSort, SAUCES_SECTION),
      block: { name: sectionName(categories, SAUCES_SECTION), note: MENU_SAUCE_NOTE, sauces } }] : []),
    ...(sidesOptions.sides.length ? [{ index: sectionIndex(listed, sidesSort, SIDES_SECTION),
      block: { name: sectionName(categories, SIDES_SECTION), note: SUBSTITUTE_SIDES_NOTE, substituteSides: sidesOptions.sides, lateNight: sidesOptions.lateNight } }] : []),
  ];

  return new Response(JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Menu',
    name: "Grayz'n Buffalo Bar & Grill Menu",
    url: 'https://grayznbuffalo.com/menu',
    sections: interleave(sections, virtual),
  }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
};
