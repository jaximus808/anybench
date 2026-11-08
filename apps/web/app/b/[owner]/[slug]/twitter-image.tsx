import { ImageResponse } from "next/og";
import { BenchmarkOg, loadPublicBenchmark, OG_SIZE } from "../../../../components/bench/og-image";

// The same preview as opengraph-image.tsx, for twitter:image (TDM-205).
export const alt = "Anybench benchmark result: the headline answer and every setup, verified";
export const size = OG_SIZE;
export const contentType = "image/png";

type Props = { params: Promise<{ owner: string; slug: string }> };

export default async function Image({ params }: Props) {
  const { owner, slug } = await params;
  const data = await loadPublicBenchmark(owner, slug);
  return new ImageResponse(<BenchmarkOg data={data} owner={owner} slug={slug} />, size);
}
