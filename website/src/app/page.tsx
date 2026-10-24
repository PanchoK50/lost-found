import { Explorer } from '@/components/explorer/explorer';
import { listArt } from '@/lib/art';
import { listBuildings } from '@/lib/buildings/catalog';

export default async function Home({ searchParams }: PageProps<'/'>) {
  const { b } = await searchParams;
  const [catalog, art] = await Promise.all([listBuildings(), listArt()]);
  return <Explorer catalog={catalog} art={art} initialId={typeof b === 'string' ? b : undefined} />;
}
