import { Mwn } from "mwn";

async function syncSingleImg(
  oldSite: Mwn,
  newSite: Mwn,
  imgTitle: string,
): Promise<void> {
  console.log(`[Sync] 开始同步图片: ${imgTitle}`);
}

export { syncSingleImg };
