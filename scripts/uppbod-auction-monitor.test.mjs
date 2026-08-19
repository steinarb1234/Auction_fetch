import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TRACKED_AUCTION_TYPES,
  buildSnapshot,
  decodeSnapshotFromIssueBody,
  diffSnapshots,
  encodeSnapshot,
  hasChanges,
  renderChangeComment,
  renderIssueBody,
} from './uppbod-auction-monitor.mjs'

const baseline = [
  {
    office: 'Sýslumaðurinn á höfuðborgarsvæðinu',
    location: 'Reykjavík',
    auctionType: 'Framhald uppboðs',
    lotType: 'Fasteign',
    lotName: 'Laugavegur 1',
    lotId: 'A-100',
    lotItems: 'Íbúð',
    auctionDate: '20.08.2026',
    auctionTime: '10:00',
    petitioners: 'Example petitioner',
    respondent: 'Example respondent',
    publishText: 'Initial text',
    auctionTakesPlaceAt: 'Borgartún 7',
  },
]

test('snapshot state round-trips through the issue marker', () => {
  const snapshot = buildSnapshot(baseline, '2026-08-13T12:00:00.000Z')
  const body = renderIssueBody(snapshot, 'Baseline established')
  assert.deepEqual(decodeSnapshotFromIssueBody(body), snapshot)
  assert.deepEqual(snapshot.filters.auctionTypes, TRACKED_AUCTION_TYPES)
  assert.match(body, /Auction type \| Lot type/)
  assert.ok(encodeSnapshot(snapshot).length > 0)
})

test('keeps only the configured auction types', () => {
  const snapshot = buildSnapshot(
    [
      baseline[0],
      {
        ...baseline[0],
        lotId: 'A-UNTRACKED',
        auctionType: 'Nauðungarsala',
      },
      {
        ...baseline[0],
        lotId: 'A-COMPLETE',
        auctionType: '  sölu   lokið  ',
      },
    ],
    '2026-08-13T12:00:00.000Z',
  )

  assert.equal(snapshot.auctions.length, 2)
  assert.deepEqual(
    snapshot.auctions.map(({ display }) => display.lotId).sort(),
    ['A-100', 'A-COMPLETE'],
  )
})

test('detects added, changed, and removed auctions', () => {
  const previous = buildSnapshot(
    [
      ...baseline,
      {
        ...baseline[0],
        lotId: 'A-REMOVED',
        lotName: 'Removed lot',
      },
    ],
    '2026-08-13T12:00:00.000Z',
  )
  const current = buildSnapshot(
    [
      {
        ...baseline[0],
        auctionTime: '11:30',
        publishText: 'Updated text',
      },
      {
        ...baseline[0],
        lotId: 'A-NEW',
        lotName: 'New lot',
      },
    ],
    '2026-08-13T12:15:00.000Z',
  )

  const diff = diffSnapshots(previous, current)
  assert.equal(diff.added.length, 1)
  assert.equal(diff.changed.length, 1)
  assert.equal(diff.removed.length, 1)
  assert.ok(hasChanges(diff))
  assert.deepEqual(
    diff.changed[0].fields.map(({ field }) => field).sort(),
    ['auctionTime', 'publishText'],
  )

  const comment = renderChangeComment(diff, current.generatedAt)
  assert.match(comment, /1 added/)
  assert.match(comment, /1 changed/)
  assert.match(comment, /1 removed/)
  assert.match(comment, /Type: Framhald uppboðs/)
  assert.match(comment, /Removed or left tracked types/)
  assert.match(comment, /Auction time/)
  assert.match(comment, /Published text: changed/)
})

test('reports auction type transitions as changes and includes type in notifications', () => {
  const previous = buildSnapshot(
    [{ ...baseline[0], lotId: '', auctionType: 'Framhald uppboðs' }],
    '2026-08-13T12:00:00.000Z',
  )
  const current = buildSnapshot(
    [{ ...baseline[0], lotId: '', auctionType: 'Sölu lokið' }],
    '2026-08-13T12:15:00.000Z',
  )

  const diff = diffSnapshots(previous, current)
  assert.equal(diff.added.length, 0)
  assert.equal(diff.changed.length, 1)
  assert.equal(diff.removed.length, 0)
  assert.deepEqual(
    diff.changed[0].fields.map(({ field }) => field),
    ['auctionType'],
  )

  const comment = renderChangeComment(diff, current.generatedAt)
  assert.match(comment, /Type: Sölu lokið/)
  assert.match(
    comment,
    /Auction type: `Framhald uppboðs` → `Sölu lokið`/,
  )
})

test('ignores identical data even when the source order changes', () => {
  const first = buildSnapshot(
    [
      baseline[0],
      { ...baseline[0], lotId: 'A-200', lotName: 'Second lot' },
    ],
    '2026-08-13T12:00:00.000Z',
  )
  const second = buildSnapshot(
    [
      { ...baseline[0], lotId: 'A-200', lotName: 'Second lot' },
      baseline[0],
    ],
    '2026-08-13T12:15:00.000Z',
  )

  assert.equal(hasChanges(diffSnapshots(first, second)), false)
})

test('scheduled monitor migrates the filter, stays quiet, then reports a type change', async () => {
  const { runMonitor } = await import('./uppbod-auction-monitor.mjs')
  let currentAuctions = structuredClone(baseline)
  let issue = null
  let labelExists = false
  const comments = []

  const jsonResponse = (body, status = 200) =>
    new Response(body === null ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input)
    const method = options.method || 'GET'

    if (url.hostname === 'island.is') {
      assert.equal(method, 'GET')
      assert.equal(options.headers['Apollo-Require-Preflight'], 'true')
      return jsonResponse({
        data: { getSyslumennAuctions: currentAuctions },
      })
    }

    assert.equal(url.hostname, 'api.github.test')

    if (url.pathname.endsWith('/labels') && method === 'POST') {
      if (labelExists) return jsonResponse({ message: 'Already exists' }, 422)
      labelExists = true
      return jsonResponse({ name: 'uppbod-auction-monitor' }, 201)
    }

    if (url.pathname.endsWith('/issues') && method === 'GET') {
      return jsonResponse(issue ? [issue] : [])
    }

    if (url.pathname.endsWith('/issues') && method === 'POST') {
      const payload = JSON.parse(options.body)
      issue = {
        number: 7,
        html_url: 'https://github.test/example/repo/issues/7',
        title: payload.title,
        body: payload.body,
        state: 'open',
      }
      return jsonResponse(issue, 201)
    }

    if (url.pathname.endsWith('/issues/7/comments') && method === 'POST') {
      comments.push(JSON.parse(options.body).body)
      return jsonResponse({ id: comments.length }, 201)
    }

    if (url.pathname.endsWith('/issues/7') && method === 'PATCH') {
      const payload = JSON.parse(options.body)
      issue = { ...issue, ...payload }
      return jsonResponse(issue)
    }

    throw new Error(`Unexpected request: ${method} ${url}`)
  }

  const env = {
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'example/repo',
    GITHUB_API_URL: 'https://api.github.test',
  }

  const first = await runMonitor({
    env,
    fetchImpl,
    now: new Date('2026-08-13T12:00:00.000Z'),
  })
  assert.equal(first.status, 'baseline-created')
  assert.equal(comments.length, 0)
  assert.ok(decodeSnapshotFromIssueBody(issue.body))

  const legacySnapshot = decodeSnapshotFromIssueBody(issue.body)
  legacySnapshot.version = 1
  delete legacySnapshot.filters
  issue.body = renderIssueBody(legacySnapshot, 'Legacy baseline').replace(
    'UPPBOD_AUCTION_SNAPSHOT_V2',
    'UPPBOD_AUCTION_SNAPSHOT_V1',
  )

  const second = await runMonitor({
    env,
    fetchImpl,
    now: new Date('2026-08-13T12:15:00.000Z'),
  })
  assert.equal(second.status, 'baseline-migrated')
  assert.equal(comments.length, 0)

  const third = await runMonitor({
    env,
    fetchImpl,
    now: new Date('2026-08-13T12:30:00.000Z'),
  })
  assert.equal(third.status, 'unchanged')
  assert.equal(comments.length, 0)

  currentAuctions = [
    { ...baseline[0], auctionType: 'Sölu lokið', auctionTime: '11:30' },
  ]
  const fourth = await runMonitor({
    env,
    fetchImpl,
    now: new Date('2026-08-13T12:45:00.000Z'),
  })
  assert.equal(fourth.status, 'changed')
  assert.equal(comments.length, 1)
  assert.match(comments[0], /Auction time/)
  assert.match(comments[0], /Type: Sölu lokið/)
  assert.match(comments[0], /Auction type/)
  assert.match(issue.body, /11:30/)
  assert.match(issue.body, /Sölu lokið/)
})
