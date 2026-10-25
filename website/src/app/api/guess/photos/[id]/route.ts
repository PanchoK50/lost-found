import { spotStore } from '@/lib/guess/store';

// GET /api/guess/photos/<id>: uploaded photos when running without Supabase (with it, they come from Storage).
export async function GET(_request: Request, ctx: RouteContext<'/api/guess/photos/[id]'>) {
  const { id } = await ctx.params;
  const image = spotStore.image?.(id);
  if (!image) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(image.data), { headers: { 'Content-Type': image.type, 'Cache-Control': 'public, max-age=31536000, immutable' } });
}
