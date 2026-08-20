import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUCTION_TYPES,
  buildSnapshot,
  decodeSnapshotFromIssueBody,
  diffSnapshots,
  encodeSnapshot,
  fetchAuctions,
  filterMonitoredSnapshot,
  hasChanges,
  renderChangeComment,
  renderIssueBody,
  runMonitor,
} from './uppbod-auction-monitor.mjs'

const continuationAuction = {
  office: 'Sýslumaðurinn á höfuðborgarsvæðinu',
  location: 'Reykjavík',
  auctionType: AUCTION_TYPES.CONTINUATION,
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
}

const soldAuction = {
  ...continuationAuction,
  auctionType: AUCTION_TYPES.SOLD,
  lotId: 'A-SOLD',
  lotName: 'Sold listing',
}

const startAuction = {
  ...continuationAuction,
  auctionType: AUCTION_TYPES.START,
  lotId: 'A-START',
  lotName: 'Start listing',
}

function createHarness({ auctions, existingIssue = null }) {
  let currentAuctions = structuredClone(auctions)
  let issue = existingIssue ? structuredClone(existingIssue) : null
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
      assert.equal(method, 'POST')
      assert.equal(url.search, '')
      assert.equal(options.headers['Content-Type'], 'application/json')
      assert.equal(
        options.headers['X-Apollo-Operation-Name'],
        'GetSyslumennAuctions',
      )
      const request = JSON.parse(options.body)
      assert.equal(request.operationName, 'GetSyslumennAuctions')
      assert.deepEqual(request.variables, {})
      assert.match(request.query, /getSyslumennAuctions/)
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

  return {
    env: {
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'example/repo',
      GITHUB_API_URL: 'https://api.github.test',
    },
    fetchImpl,
    comments,
    getIssue: () => issue,
    setAuctions: (nextAuctions) => {
      currentAuctions = structuredClone(nextAuctions)
    },
  }
}

test('auction fetch uses a JSON POST request', async () => {
  let capturedRequest

  const auctions = await fetchAuctions({
    attempts: 1,
    fetchImpl: async (input, options) => {
      capturedRequest = { input: String(input), options }
      return new Response(
        JSON.stringify({
          data: { getSyslumennAuctions: [continuationAuction] },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  })

  assert.equal(auctions.length, 1)
  assert.equal(capturedRequest.input, 'https://island.is/api/graphql')
  assert.equal(capturedRequest.options.method, 'POST')
  assert.equal(
    capturedRequest.options.headers['Content-Type'],
    'application/json',
  )
  assert.equal(
    capturedRequest.options.headers['X-Apollo-Operation-Name'],
    'GetSyslumennAuctions',
  )
  assert.deepEqual(JSON.parse(capturedRequest.options.body).variables, {})
})

test('auction fetch preserves a 400 response and does not retry it', async () => {
  let calls = 0
  const responseBody = {
    errors: [{ message: 'Invalid GraphQL request' }],
  }

  await assert.rejects(
    fetchAuctions({
      attempts: 3,
      fetchImpl: async () => {
        calls += 1
        return new Response(JSON.stringify(responseBody), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      },
    }),
    (error) => {
      assert.equal(calls, 1)
      assert.equal(error.status, 400)
      assert.deepEqual(error.responseBody, responseBody)
      assert.match(error.message, /after 1 attempt/)
      assert.match(error.message, /HTTP 400/)
      return true
    },
  )
})

test('auction fetch retries temporary endpoint failures', async () => {
  let calls = 0

  const auctions = await fetchAuctions({
    attempts: 3,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1
      if (calls < 3) {
        return new Response(
          JSON.stringify({ message: 'Temporarily unavailable' }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      return new Response(
        JSON.stringify({
          data: { getSyslumennAuctions: [soldAuction] },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  })

  assert.equal(calls, 3)
  assert.equal(auctions[0].auctionType, AUCTION_TYPES.SOLD)
})

test('issue state stores and displays only continuation and sold listings', () => {
  const fullSnapshot = buildSnapshot(
    [continuationAuction, soldAuction, startAuction],
    '2026-08-13T12:00:00.000Z',
  )
  const body = renderIssueBody(fullSnapshot, 'Baseline established')
  const storedSnapshot = decodeSnapshotFromIssueBody(body)

  assert.equal(storedSnapshot.version, 2)
  assert.equal(storedSnapshot.scope, 'continuation-and-sold')
  assert.deepEqual(
    storedSnapshot.auctions.map(({ display }) => display.auctionType).sort(),
    [AUCTION_TYPES.CONTINUATION, AUCTION_TYPES.SOLD].sort(),
  )
  assert.match(body, /Auction type/)
  assert.match(body, /Framhald uppboðs/)
  assert.match(body, /Sölu lokið/)
  assert.doesNotMatch(body, /Start listing/)
  assert.ok(encodeSnapshot(storedSnapshot).length > 0)
})

test('tracks auction type changes and includes types in every notification section', () => {
  const previous = filterMonitoredSnapshot(
    buildSnapshot(
      [continuationAuction, soldAuction, startAuction],
      '2026-08-13T12:00:00.000Z',
    ),
  )
  const current = buildSnapshot(
    [
      {
        ...continuationAuction,
        auctionType: AUCTION_TYPES.SOLD,
        auctionTime: '11:30',
        publishText: 'Updated text',
      },
      {
        ...continuationAuction,
        lotId: 'A-NEW',
        lotName: 'New continuation listing',
      },
      { ...startAuction, auctionTime: '12:00' },
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
    ['auctionTime', 'auctionType', 'publishText'],
  )

  const comment = renderChangeComment(diff, current.generatedAt)
  assert.match(comment, /Added to tracked auctions/)
  assert.match(comment, /Removed from source feed/)
  assert.match(comment, /Auction type: \*\*Framhald uppboðs\*\*/)
  assert.match(comment, /Auction type: \*\*Sölu lokið\*\*/)
  assert.match(
    comment,
    /Auction type: `Framhald uppboðs` → `Sölu lokið`/,
  )
  assert.doesNotMatch(comment, /Start listing/)
})

test('ignores additions, removals, and field changes for start-only listings', () => {
  const previous = filterMonitoredSnapshot(
    buildSnapshot([startAuction], '2026-08-13T12:00:00.000Z'),
  )
  const current = buildSnapshot(
    [
      { ...startAuction, auctionTime: '13:00' },
      { ...startAuction, lotId: 'A-START-2', lotName: 'Another start listing' },
    ],
    '2026-08-13T12:15:00.000Z',
  )

  const diff = diffSnapshots(previous, current)
  assert.equal(hasChanges(diff), false)
  assert.deepEqual(diff, { added: [], changed: [], removed: [] })
})

test('reports leaving the tracked types as a type change, not a feed removal', () => {
  const previous = filterMonitoredSnapshot(
    buildSnapshot([continuationAuction], '2026-08-13T12:00:00.000Z'),
  )
  const current = buildSnapshot(
    [{ ...continuationAuction, auctionType: AUCTION_TYPES.START }],
    '2026-08-13T12:15:00.000Z',
  )

  const diff = diffSnapshots(previous, current)
  assert.equal(diff.added.length, 0)
  assert.equal(diff.changed.length, 1)
  assert.equal(diff.removed.length, 0)
  assert.deepEqual(diff.changed[0].fields.map(({ field }) => field), [
    'auctionType',
  ])

  const comment = renderChangeComment(diff, current.generatedAt)
  assert.match(comment, /left the tracked auction types/)
  assert.match(
    comment,
    /Auction type: `Framhald uppboðs` → `Byrjun uppboðs`/,
  )
})

test('reports a tracked listing that disappears from the source feed', () => {
  const previous = filterMonitoredSnapshot(
    buildSnapshot([soldAuction], '2026-08-13T12:00:00.000Z'),
  )
  const current = buildSnapshot([], '2026-08-13T12:15:00.000Z')

  const diff = diffSnapshots(previous, current)
  assert.equal(diff.added.length, 0)
  assert.equal(diff.changed.length, 0)
  assert.equal(diff.removed.length, 1)

  const comment = renderChangeComment(diff, current.generatedAt)
  assert.match(comment, /Removed from source feed/)
  assert.match(comment, /Auction type: \*\*Sölu lokið\*\*/)
})

test('ignores identical tracked data even when source order changes', () => {
  const first = filterMonitoredSnapshot(
    buildSnapshot(
      [continuationAuction, soldAuction],
      '2026-08-13T12:00:00.000Z',
    ),
  )
  const second = buildSnapshot(
    [soldAuction, continuationAuction],
    '2026-08-13T12:15:00.000Z',
  )

  assert.equal(hasChanges(diffSnapshots(first, second)), false)
})

test('tracks auction type changes when the source record has no lot ID', () => {
  const withoutId = { ...continuationAuction, lotId: '' }
  const previous = filterMonitoredSnapshot(
    buildSnapshot([withoutId], '2026-08-13T12:00:00.000Z'),
  )
  const current = buildSnapshot(
    [{ ...withoutId, auctionType: AUCTION_TYPES.SOLD }],
    '2026-08-13T12:15:00.000Z',
  )

  const diff = diffSnapshots(previous, current)
  assert.equal(diff.added.length, 0)
  assert.equal(diff.changed.length, 1)
  assert.equal(diff.removed.length, 0)
  assert.deepEqual(diff.changed[0].fields.map(({ field }) => field), [
    'auctionType',
  ])
})

test('scheduled monitor reports a type change and then a true removal', async () => {
  const harness = createHarness({
    auctions: [continuationAuction, startAuction],
  })

  const first = await runMonitor({
    env: harness.env,
    fetchImpl: harness.fetchImpl,
    now: new Date('2026-08-13T12:00:00.000Z'),
  })
  assert.equal(first.status, 'baseline-created')
  assert.equal(first.auctionCount, 1)
  assert.equal(first.sourceAuctionCount, 2)
  assert.equal(harness.comments.length, 0)
  assert.match(harness.getIssue().body, /Laugavegur 1/)
  assert.match(harness.getIssue().body, /Auction type/)
  assert.doesNotMatch(harness.getIssue().body, /Start listing/)

  const second = await runMonitor({
    env: harness.env,
    fetchImpl: harness.fetchImpl,
    now: new Date('2026-08-13T12:15:00.000Z'),
  })
  assert.equal(second.status, 'unchanged')
  assert.equal(harness.comments.length, 0)

  harness.setAuctions([
    { ...continuationAuction, auctionType: AUCTION_TYPES.SOLD },
    startAuction,
  ])
  const third = await runMonitor({
    env: harness.env,
    fetchImpl: harness.fetchImpl,
    now: new Date('2026-08-13T12:30:00.000Z'),
  })
  assert.equal(third.status, 'changed')
  assert.equal(harness.comments.length, 1)
  assert.match(
    harness.comments[0],
    /Auction type: `Framhald uppboðs` → `Sölu lokið`/,
  )
  assert.match(harness.getIssue().body, /Sölu lokið/)

  harness.setAuctions([startAuction])
  const fourth = await runMonitor({
    env: harness.env,
    fetchImpl: harness.fetchImpl,
    now: new Date('2026-08-13T12:45:00.000Z'),
  })
  assert.equal(fourth.status, 'changed')
  assert.equal(fourth.diff.removed.length, 1)
  assert.equal(harness.comments.length, 2)
  assert.match(harness.comments[1], /Removed from source feed/)
  assert.match(harness.comments[1], /Auction type: \*\*Sölu lokið\*\*/)
  assert.match(harness.getIssue().body, /Current tracked auctions:\*\* 0/)
})

test('upgrades an existing unfiltered V1 snapshot without false removals', async () => {
  const oldSnapshot = buildSnapshot(
    [continuationAuction, startAuction],
    '2026-08-13T11:45:00.000Z',
  )
  oldSnapshot.version = 1
  delete oldSnapshot.scope
  const oldBody = [
    '# Old unfiltered monitor',
    '',
    `<!-- UPPBOD_AUCTION_SNAPSHOT_V1:${encodeSnapshot(oldSnapshot)} -->`,
  ].join('\n')

  const harness = createHarness({
    auctions: [continuationAuction, startAuction],
    existingIssue: {
      number: 7,
      html_url: 'https://github.test/example/repo/issues/7',
      title: 'Uppboð auction monitor',
      body: oldBody,
      state: 'open',
    },
  })

  const result = await runMonitor({
    env: harness.env,
    fetchImpl: harness.fetchImpl,
    now: new Date('2026-08-13T12:00:00.000Z'),
  })

  assert.equal(result.status, 'configuration-updated')
  assert.equal(result.diff.removed.length, 0)
  assert.equal(harness.comments.length, 0)
  assert.match(harness.getIssue().body, /UPPBOD_AUCTION_SNAPSHOT_V2/)
  assert.match(harness.getIssue().body, /Framhald uppboðs/)
  assert.doesNotMatch(harness.getIssue().body, /Start listing/)
})
