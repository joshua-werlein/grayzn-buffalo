import { REVIEW_ID, reviewCategory, type ReviewCategory } from './review-preview';

const PAGE_SIZE = 18;
const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export type ReviewGalleryPhoto = {
  id: string;
  category: ReviewCategory;
  description: string;
  display_name: string | null;
  small_width: number;
  medium_width: number;
  medium_height: number;
  updated_at: string;
};

export type ReviewGallery = { photos: ReviewGalleryPhoto[]; next: string | null };

export function reviewGalleryCategory(url: URL): ReviewCategory | null {
  const category = url.searchParams.get('category');
  return reviewCategory(category) ? category : null;
}

export function reviewGalleryHref(category: ReviewCategory | null, cursor?: string | null): string {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (cursor) params.set('before', cursor);
  return '/reviews' + (params.size ? '?' + params : '') + '#gallery';
}

export async function readReviewGallery(env: any, url: URL): Promise<ReviewGallery | null> {
  const category = reviewGalleryCategory(url);
  const [date, id, extra] = (url.searchParams.get('before') ?? '').split('~', 3);
  const before = extra === undefined && timestamp.test(date) && REVIEW_ID.test(id);
  const categorySql = category ? 'AND category = ?' : '';
  const beforeSql = before ? 'AND (updated_at, id) < (?, ?)' : '';
  try {
    const result = await env.DB.withSession('first-primary').prepare(
      `SELECT id, category, description, display_name, small_width, medium_width, medium_height, updated_at
       FROM review_photos WHERE status = 'approved' ${categorySql} ${beforeSql}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).bind(...(category ? [category] : []), ...(before ? [date, id] : []), PAGE_SIZE + 1).all();
    const photos: ReviewGalleryPhoto[] = result.results.slice(0, PAGE_SIZE);
    const last = photos.at(-1);
    return { photos, next: result.results.length > PAGE_SIZE && last ? last.updated_at + '~' + last.id : null };
  } catch {
    return null;
  }
}
