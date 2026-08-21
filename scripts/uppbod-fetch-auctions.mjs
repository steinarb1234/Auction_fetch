import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { AUCTION_ENDPOINT, fetchAuctions } from './uppbod-auction-monitor.mjs'

export async function createAuctionExport({
  outputPath,
  endpoint = process.env.AUCTION_ENDPOINT || AUCTION_ENDPOINT,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  if (!outputPath) {
    throw new Error('An auction export output path is required')
  }

  const auctions = await fetchAuctions({ endpoint, fetchImpl })
  const fetchedAt = now.toISOString()
  const payload = {
    version: 1,
    fetchedAt,
    endpoint,
    sourceCount: auctions.length,
    auctions,
  }

  const absolutePath = resolve(outputPath)
  await mkdir(dirname(absolutePath), { recursive: true })
  const temporaryPath = `${absolutePath}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, absolutePath)

  return {
    outputPath: absolutePath,
    fetchedAt,
    sourceCount: auctions.length,
  }
}

async function main() {
  const outputPath = process.argv[2] || process.env.AUCTION_OUTPUT_PATH
  const result = await createAuctionExport({ outputPath })
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(error.stack || error)
    process.exitCode = 1
  }
}
