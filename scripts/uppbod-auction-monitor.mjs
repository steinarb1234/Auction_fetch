import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

export const AUCTION_ENDPOINT = 'https://island.is/api/graphql'
export const ISSUE_TITLE = 'Uppboð auction monitor'
export const ISSUE_LABEL = 'uppbod-auction-monitor'
export const TRACKED_AUCTION_TYPES = ['Framhald uppboðs', 'Sölu lokið']

export const AUCTION_FIELDS = [
  'office',
  'location',
  'auctionType',
  'lotType',
  'lotName',
  'lotId',
  'lotItems',
  'auctionDate',
  'auctionTime',
  'petitioners',
  'respondent',
  'publishText',
  'auctionTakesPlaceAt',
]

const REPORT_FIELDS = [
  'office',
  'location',
  'auctionType',
  'lotType',
  'lotName',
  'lotId',
  'auctionDate',
  'auctionTime',
  'auctionTakesPlaceAt',
]

const FIELD_LABELS = {
  office: 'Office',
  location: 'Location',
  auctionType: 'Auction type',
  lotType: 'Lot type',
  lotName: 'Lot name',
  lotId: 'Lot ID',
  lotItems: 'Lot items',
  auctionDate: 'Auction date',
  auctionTime: 'Auction time',
  petitioners: 'Petitioners',
  respondent: 'Respondent',
  publishText: 'Published text',
  auctionTakesPlaceAt: 'Auction venue',
}

const GRAPHQL_QUERY = `
  query GetSyslumennAuctions {
    getSyslumennAuctions {
      office
      location
      auctionType
      lotType
      lotName
      lotId
      lotItems
      auctionDate
      auctionTime
      petitioners
      respondent
      publishText
      auctionTakesPlaceAt
    }
  }
`

const SNAPSHOT_VERSION = 2
const SNAPSHOT_MARKER_NAME = 'UPPBOD_AUCTION_SNAPSHOT_V2'
const SNAPSHOT_MARKER_PATTERN =
  /<!-- UPPBOD_AUCTION_SNAPSHOT_V(?:1|2):([A-Za-z0-9+/=]+) -->/
const MAX_ISSUE_BODY_BYTES = 64_000
const DEFAULT_MAX_REPORT_ROWS = 150
const DEFAULT_MAX_CHANGE_ITEMS = 50

class HttpError extends Error {
  constructor(message, status, responseBody) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.responseBody = responseBody
  }
}

function cleanValue(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function auctionTypeKey(value) {
  return cleanValue(value)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('is')
}

const TRACKED_AUCTION_TYPE_KEYS = new Set(
  TRACKED_AUCTION_TYPES.map(auctionTypeKey),
)

export function isTrackedAuctionType(value) {
  return TRACKED_AUCTION_TYPE_KEYS.has(auctionTypeKey(value))
}

function shortHash(value) {
  return createHash('sha256')
    .update(value)
    .digest('base64url')
    .slice(0, 16)
}

function normalizeAuction(rawAuction) {
  return Object.fromEntries(
    AUCTION_FIELDS.map((field) => [field, cleanValue(rawAuction?.[field])]),
  )
}

function fallbackIdentity(auction) {
  return [
    auction.office,
    auction.lotName,
    auction.lotType,
    auction.location,
  ].join('\u001f')
}

function baseAuctionKey(auction) {
  return auction.lotId
    ? `lotId:${auction.lotId}`
    : `derived:${shortHash(fallbackIdentity(auction))}`
}

function auctionSortKey(auction) {
  const display = auction.display ?? auction
  const timestamp = parseAuctionTimestamp(
    display.auctionDate,
    display.auctionTime,
  )

  return [
    Number.isFinite(timestamp) ? String(timestamp).padStart(15, '0') : '9',
    display.lotName,
    display.location,
    display.lotId,
  ].join('\u001f')
}

function parseAuctionTimestamp(dateValue, timeValue) {
  const date = cleanValue(dateValue)
  const time = cleanValue(timeValue)
  let year
  let month
  let day

  let match = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (match) {
    ;[, year, month, day] = match.map(Number)
  } else {
    match = date.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/)
    if (match) {
      day = Number(match[1])
      month = Number(match[2])
      year = Number(match[3])
    }
  }

  if (!year || !month || !day) {
    const parsed = Date.parse(`${date} ${time}`.trim())
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
  }

  const timeMatch = time.match(/^(\d{1,2}):(\d{2})/)
  const hour = timeMatch ? Number(timeMatch[1]) : 0
  const minute = timeMatch ? Number(timeMatch[2]) : 0
  return Date.UTC(year, month - 1, day, hour, minute)
}

export function buildSnapshot(rawAuctions, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(rawAuctions)) {
    throw new TypeError('Auction data must be an array')
  }

  const normalizedAuctions = rawAuctions
    .map(normalizeAuction)
    .filter((auction) => isTrackedAuctionType(auction.auctionType))
  const groups = new Map()

  for (const auction of normalizedAuctions) {
    const baseKey = baseAuctionKey(auction)
    const group = groups.get(baseKey) ?? []
    group.push(auction)
    groups.set(baseKey, group)
  }

  const snapshotAuctions = []

  for (const [baseKey, group] of groups) {
    group.sort((left, right) =>
      fallbackIdentity(left).localeCompare(fallbackIdentity(right), 'is'),
    )

    group.forEach((auction, index) => {
      const key = group.length === 1 ? baseKey : `${baseKey}#${index + 1}`
      const hashes = Object.fromEntries(
        AUCTION_FIELDS.map((field) => [field, shortHash(auction[field])]),
      )
      const display = Object.fromEntries(
        REPORT_FIELDS.map((field) => [field, auction[field]]),
      )

      snapshotAuctions.push({ key, display, hashes })
    })
  }

  snapshotAuctions.sort((left, right) =>
    auctionSortKey(left).localeCompare(auctionSortKey(right), 'is'),
  )

  return {
    version: SNAPSHOT_VERSION,
    generatedAt,
    filters: {
      auctionTypes: [...TRACKED_AUCTION_TYPES],
    },
    auctions: snapshotAuctions,
  }
}

function snapshotUsesCurrentAuctionTypeFilter(snapshot) {
  const configuredTypes = snapshot?.filters?.auctionTypes
  if (snapshot?.version !== SNAPSHOT_VERSION || !Array.isArray(configuredTypes)) {
    return false
  }

  const configuredKeys = [...new Set(configuredTypes.map(auctionTypeKey))].sort()
  const trackedKeys = [...TRACKED_AUCTION_TYPE_KEYS].sort()

  return (
    configuredKeys.length === trackedKeys.length &&
    configuredKeys.every((value, index) => value === trackedKeys[index])
  )
}

export function diffSnapshots(previousSnapshot, currentSnapshot) {
  const previousByKey = new Map(
    (previousSnapshot?.auctions ?? []).map((auction) => [auction.key, auction]),
  )
  const currentByKey = new Map(
    (currentSnapshot?.auctions ?? []).map((auction) => [auction.key, auction]),
  )

  const added = []
  const removed = []
  const changed = []

  for (const [key, current] of currentByKey) {
    const previous = previousByKey.get(key)
    if (!previous) {
      added.push(current)
      continue
    }

    const fields = AUCTION_FIELDS.filter(
      (field) => previous.hashes?.[field] !== current.hashes?.[field],
    ).map((field) => ({
      field,
      oldValue: REPORT_FIELDS.includes(field)
        ? previous.display?.[field] ?? ''
        : undefined,
      newValue: REPORT_FIELDS.includes(field)
        ? current.display?.[field] ?? ''
        : undefined,
    }))

    if (fields.length > 0) {
      changed.push({ previous, current, fields })
    }
  }

  for (const [key, previous] of previousByKey) {
    if (!currentByKey.has(key)) {
      removed.push(previous)
    }
  }

  const sortEntries = (entries) =>
    entries.sort((left, right) =>
      auctionSortKey(left.current ?? left).localeCompare(
        auctionSortKey(right.current ?? right),
        'is',
      ),
    )

  return {
    added: sortEntries(added),
    changed: sortEntries(changed),
    removed: sortEntries(removed),
  }
}

export function hasChanges(diff) {
  return (
    diff.added.length > 0 ||
    diff.changed.length > 0 ||
    diff.removed.length > 0
  )
}

export function encodeSnapshot(snapshot) {
  return gzipSync(JSON.stringify(snapshot), { level: 9 }).toString('base64')
}

export function decodeSnapshotFromIssueBody(issueBody) {
  const match = cleanValue(issueBody).match(SNAPSHOT_MARKER_PATTERN)
  if (!match) {
    return null
  }

  try {
    const snapshot = JSON.parse(
      gunzipSync(Buffer.from(match[1], 'base64')).toString('utf8'),
    )

    if (
      ![1, SNAPSHOT_VERSION].includes(snapshot?.version) ||
      !Array.isArray(snapshot.auctions) ||
      typeof snapshot.generatedAt !== 'string'
    ) {
      throw new Error('Snapshot has an unsupported structure')
    }

    return snapshot
  } catch (error) {
    throw new Error(`Could not decode the previous auction snapshot: ${error.message}`)
  }
}

function snapshotMarker(snapshot) {
  return `<!-- ${SNAPSHOT_MARKER_NAME}:${encodeSnapshot(snapshot)} -->`
}

function escapeTableCell(value, maxLength = 120) {
  const compact = cleanValue(value).replace(/\s+/g, ' ')
  const truncated =
    compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact
  return (truncated || '—').replace(/\|/g, '\\|')
}

function escapeInline(value) {
  return cleanValue(value)
    .replace(/\\/g, '\\\\')
    .replace(/([*_`[\]])/g, '\\$1')
}

function codeValue(value) {
  const compact = cleanValue(value).replace(/\s+/g, ' ')
  if (!compact) {
    return '`(empty)`'
  }
  return `\`${compact.replace(/`/g, 'ˋ').slice(0, 180)}\``
}

function describeAuction(snapshotAuction) {
  const auction = snapshotAuction.display ?? {}
  const name = escapeInline(auction.lotName || 'Unnamed auction')
  const id = escapeInline(auction.lotId || 'no lot ID')
  const auctionType = auction.auctionType
    ? `Type: ${escapeInline(auction.auctionType)}`
    : null
  const dateTime = [auction.auctionDate, auction.auctionTime]
    .filter(Boolean)
    .join(' ')
  const location = auction.auctionTakesPlaceAt || auction.location

  return [
    `**${name}** (${id})`,
    auctionType,
    dateTime ? escapeInline(dateTime) : null,
    location ? escapeInline(location) : null,
  ]
    .filter(Boolean)
    .join(' — ')
}

export function renderChangeComment(
  diff,
  generatedAt,
  maxItems = DEFAULT_MAX_CHANGE_ITEMS,
) {
  const lines = [
    `## Auction changes detected — ${generatedAt}`,
    '',
    `**${diff.added.length} added · ${diff.changed.length} changed · ${diff.removed.length} removed**`,
  ]

  const addSection = (heading, items, renderItem) => {
    if (items.length === 0) return
    lines.push('', `### ${heading}`)
    for (const item of items.slice(0, maxItems)) {
      lines.push(renderItem(item))
    }
    if (items.length > maxItems) {
      lines.push(`- …and ${items.length - maxItems} more`)
    }
  }

  addSection('Added', diff.added, (auction) => `- ${describeAuction(auction)}`)

  addSection('Changed', diff.changed, ({ previous, current, fields }) => {
    const details = fields
      .map(({ field, oldValue, newValue }) => {
        const label = FIELD_LABELS[field] ?? field
        if (REPORT_FIELDS.includes(field)) {
          return `${label}: ${codeValue(oldValue)} → ${codeValue(newValue)}`
        }
        return `${label}: changed`
      })
      .join('; ')

    return `- ${describeAuction(current)}\n  - ${details}`
  })

  addSection('Removed or left tracked types', diff.removed, (auction) =>
    `- ${describeAuction(auction)}`,
  )

  return `${lines.join('\n')}\n`
}

export function renderIssueBody(
  snapshot,
  changeSummary,
  maxRows = DEFAULT_MAX_REPORT_ROWS,
) {
  const rows = snapshot.auctions.slice(0, maxRows).map(({ display }) =>
    [
      display.auctionDate,
      display.auctionTime,
      display.lotName,
      display.auctionType,
      display.lotType,
      display.auctionTakesPlaceAt || display.location,
      display.lotId,
    ]
      .map((value) => escapeTableCell(value))
      .join(' | '),
  )

  const omitted = snapshot.auctions.length - rows.length
  const lines = [
    '# Uppboð — current auction report',
    '',
    'This issue is maintained automatically. It tracks only auctions whose auction type is `Framhald uppboðs` or `Sölu lokið`.',
    '',
    `- **Last detected change:** ${snapshot.generatedAt}`,
    `- **Current tracked auctions:** ${snapshot.auctions.length}`,
    `- **Tracked auction types:** ${TRACKED_AUCTION_TYPES.map((type) => `\`${type}\``).join(' and ')}`,
    `- **Latest change:** ${changeSummary}`,
    '- **Polling schedule:** every 15 minutes, at 07, 22, 37, and 52 minutes past the hour in `Atlantic/Reykjavik`.',
    '',
    '| Date | Time | Auction | Auction type | Lot type | Location | Lot ID |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row} |`),
  ]

  if (omitted > 0) {
    lines.push('', `_The table omits ${omitted} additional auctions._`)
  }

  lines.push(
    '',
    'The compressed state below is used only to compare the next scheduled fetch.',
    snapshotMarker(snapshot),
  )

  const body = `${lines.join('\n')}\n`
  if (Buffer.byteLength(body, 'utf8') > MAX_ISSUE_BODY_BYTES) {
    throw new Error(
      `The generated monitor issue is larger than ${MAX_ISSUE_BODY_BYTES} bytes. Reduce MAX_REPORT_ROWS or move snapshot state to external storage.`,
    )
  }

  return body
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function fetchAuctions({
  endpoint = process.env.AUCTION_ENDPOINT || AUCTION_ENDPOINT,
  fetchImpl = fetch,
  attempts = 3,
  timeoutMs = 20_000,
} = {}) {
  const url = new URL(endpoint)
  url.searchParams.set('operationName', 'GetSyslumennAuctions')
  url.searchParams.set('query', GRAPHQL_QUERY.replace(/\s+/g, ' ').trim())

  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Apollo-Require-Preflight': 'true',
          'Cache-Control': 'no-cache',
          'User-Agent': 'uppbod-auction-monitor/1.0',
        },
        signal: controller.signal,
      })

      const responseText = await response.text()
      let payload
      try {
        payload = responseText ? JSON.parse(responseText) : {}
      } catch {
        throw new HttpError(
          `Auction endpoint returned non-JSON data (HTTP ${response.status})`,
          response.status,
          responseText.slice(0, 1_000),
        )
      }

      if (!response.ok) {
        throw new HttpError(
          `Auction endpoint failed with HTTP ${response.status}`,
          response.status,
          payload,
        )
      }

      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        throw new Error(
          `GraphQL errors: ${payload.errors
            .map((error) => error?.message || 'Unknown GraphQL error')
            .join('; ')}`,
        )
      }

      const auctions = payload.data?.getSyslumennAuctions
      if (!Array.isArray(auctions)) {
        throw new Error('GraphQL response did not contain an auction array')
      }

      return auctions
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await sleep(750 * 2 ** (attempt - 1))
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error(
    `Could not fetch auctions after ${attempts} attempts: ${lastError?.message ?? lastError}`,
    { cause: lastError },
  )
}

async function githubRequest(
  path,
  {
    method = 'GET',
    body,
    token,
    apiUrl,
    fetchImpl = fetch,
  },
) {
  const response = await fetchImpl(`${apiUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'uppbod-auction-monitor/1.0',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const responseText = await response.text()
  let responseBody = null

  if (responseText) {
    try {
      responseBody = JSON.parse(responseText)
    } catch {
      responseBody = responseText
    }
  }

  if (!response.ok) {
    throw new HttpError(
      `GitHub API ${method} ${path} failed with HTTP ${response.status}`,
      response.status,
      responseBody,
    )
  }

  return responseBody
}

function repositoryApiPath(repository) {
  const [owner, repo, ...rest] = cleanValue(repository).split('/')
  if (!owner || !repo || rest.length > 0) {
    throw new Error('GITHUB_REPOSITORY must use the owner/repository format')
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

async function ensureMonitorLabel(github) {
  try {
    await githubRequest(`${github.repositoryPath}/labels`, {
      ...github,
      method: 'POST',
      body: {
        name: ISSUE_LABEL,
        color: '1d76db',
        description: 'Automated reports for changes in the Uppboð auction feed',
      },
    })
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 422) {
      throw error
    }
  }
}

async function findMonitorIssue(github) {
  const query = new URLSearchParams({
    state: 'all',
    labels: ISSUE_LABEL,
    per_page: '100',
    sort: 'updated',
    direction: 'desc',
  })
  const issues = await githubRequest(
    `${github.repositoryPath}/issues?${query.toString()}`,
    github,
  )

  return (
    issues.find(
      (issue) => !issue.pull_request && issue.title === ISSUE_TITLE,
    ) ?? null
  )
}

async function createMonitorIssue(github, body) {
  return githubRequest(`${github.repositoryPath}/issues`, {
    ...github,
    method: 'POST',
    body: {
      title: ISSUE_TITLE,
      body,
      labels: [ISSUE_LABEL],
    },
  })
}

async function updateMonitorIssue(github, issueNumber, body) {
  return githubRequest(`${github.repositoryPath}/issues/${issueNumber}`, {
    ...github,
    method: 'PATCH',
    body: {
      title: ISSUE_TITLE,
      body,
      state: 'open',
    },
  })
}

async function addMonitorComment(github, issueNumber, body) {
  return githubRequest(
    `${github.repositoryPath}/issues/${issueNumber}/comments`,
    {
      ...github,
      method: 'POST',
      body: { body },
    },
  )
}

async function writeStepSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown.trim()}\n`)
}

function changeSummary(diff) {
  return `${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed`
}

export async function runMonitor({
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const token = env.GITHUB_TOKEN
  const repository = env.REPORT_REPOSITORY || env.GITHUB_REPOSITORY
  const apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(
    /\/$/,
    '',
  )

  if (!token) {
    throw new Error('GITHUB_TOKEN is required')
  }
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY or REPORT_REPOSITORY is required')
  }

  const github = {
    token,
    apiUrl,
    fetchImpl,
    repositoryPath: repositoryApiPath(repository),
  }

  const rawAuctions = await fetchAuctions({
    endpoint: env.AUCTION_ENDPOINT || AUCTION_ENDPOINT,
    fetchImpl,
  })
  const currentSnapshot = buildSnapshot(rawAuctions, now.toISOString())

  await ensureMonitorLabel(github)
  const issue = await findMonitorIssue(github)

  if (!issue) {
    const body = renderIssueBody(
      currentSnapshot,
      'Baseline established; no prior snapshot was available',
      Number(env.MAX_REPORT_ROWS) || DEFAULT_MAX_REPORT_ROWS,
    )
    const createdIssue = await createMonitorIssue(github, body)
    const result = {
      status: 'baseline-created',
      issueNumber: createdIssue.number,
      issueUrl: createdIssue.html_url,
      auctionCount: currentSnapshot.auctions.length,
    }

    await writeStepSummary(
      `## Uppboð auction monitor\n\nBaseline created with **${result.auctionCount}** tracked auctions.\n\n${result.issueUrl}`,
    )
    return result
  }

  const previousSnapshot = decodeSnapshotFromIssueBody(issue.body || '')

  if (!previousSnapshot) {
    const body = renderIssueBody(
      currentSnapshot,
      'Baseline reset because the previous issue had no monitor snapshot',
      Number(env.MAX_REPORT_ROWS) || DEFAULT_MAX_REPORT_ROWS,
    )
    await updateMonitorIssue(github, issue.number, body)
    await addMonitorComment(
      github,
      issue.number,
      `## Auction monitor baseline reset — ${currentSnapshot.generatedAt}\n\nThe issue did not contain a readable previous snapshot, so the current ${currentSnapshot.auctions.length} tracked auctions were saved as the new baseline.`,
    )

    const result = {
      status: 'baseline-reset',
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      auctionCount: currentSnapshot.auctions.length,
    }
    await writeStepSummary(
      `## Uppboð auction monitor\n\nBaseline reset with **${result.auctionCount}** tracked auctions.\n\n${result.issueUrl}`,
    )
    return result
  }

  if (!snapshotUsesCurrentAuctionTypeFilter(previousSnapshot)) {
    const body = renderIssueBody(
      currentSnapshot,
      'Baseline migrated to track only Framhald uppboðs and Sölu lokið',
      Number(env.MAX_REPORT_ROWS) || DEFAULT_MAX_REPORT_ROWS,
    )
    await updateMonitorIssue(github, issue.number, body)

    const result = {
      status: 'baseline-migrated',
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      auctionCount: currentSnapshot.auctions.length,
    }
    await writeStepSummary(
      `## Uppboð auction monitor\n\nBaseline migrated without an auction-change notification. Tracking **${result.auctionCount}** auctions of type **Framhald uppboðs** or **Sölu lokið**.\n\n${result.issueUrl}`,
    )
    return result
  }

  const diff = diffSnapshots(previousSnapshot, currentSnapshot)

  if (!hasChanges(diff)) {
    const result = {
      status: 'unchanged',
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      auctionCount: currentSnapshot.auctions.length,
      diff,
    }
    await writeStepSummary(
      `## Uppboð auction monitor\n\nNo tracked auction changes detected. Current tracked count: **${result.auctionCount}**.\n\n${result.issueUrl}`,
    )
    return result
  }

  const summary = changeSummary(diff)
  const comment = renderChangeComment(
    diff,
    currentSnapshot.generatedAt,
    Number(env.MAX_CHANGE_ITEMS) || DEFAULT_MAX_CHANGE_ITEMS,
  )
  const body = renderIssueBody(
    currentSnapshot,
    summary,
    Number(env.MAX_REPORT_ROWS) || DEFAULT_MAX_REPORT_ROWS,
  )

  // Comment first, so a state-update failure cannot silently swallow the report.
  await addMonitorComment(github, issue.number, comment)
  await updateMonitorIssue(github, issue.number, body)

  const result = {
    status: 'changed',
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    auctionCount: currentSnapshot.auctions.length,
    diff,
  }
  await writeStepSummary(
    `## Uppboð auction monitor\n\nDetected **${summary}** among tracked auctions. Current tracked count: **${result.auctionCount}**.\n\n${result.issueUrl}`,
  )
  return result
}

async function main() {
  try {
    const result = await runMonitor()
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    const details =
      error instanceof HttpError && error.responseBody
        ? `\n${JSON.stringify(error.responseBody, null, 2).slice(0, 4_000)}`
        : ''
    console.error(`${error.stack || error}${details}`)
    await writeStepSummary(
      `## Uppboð auction monitor failed\n\n\`${cleanValue(error.message)}\``,
    ).catch(() => {})
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
