const PAGE_SIZE = 50
const SOLD_AUCTION_TYPE = 'Sölu lokið'

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

const EVENT_LABELS = {
  added: 'Added',
  changed: 'Changed',
  removed: 'Removed',
}

const REASON_LABELS = {
  first_seen: 'First seen in source feed',
  reappeared: 'Reappeared after removal',
  source_update: 'Source fields changed',
  missing_from_feed: 'Missing from source feed',
}

const state = {
  archive: null,
  filtered: [],
  visibleCount: PAGE_SIZE,
}

const elements = {
  query: document.querySelector('#query'),
  auctionType: document.querySelector('#auction-type'),
  status: document.querySelector('#status'),
  eventType: document.querySelector('#event-type'),
  sort: document.querySelector('#sort'),
  clear: document.querySelector('#clear-filters'),
  copyLink: document.querySelector('#copy-link'),
  results: document.querySelector('#results'),
  resultCount: document.querySelector('#result-count'),
  empty: document.querySelector('#empty-state'),
  error: document.querySelector('#load-error'),
  showMore: document.querySelector('#show-more'),
  updated: document.querySelector('#archive-updated'),
  latestFetch: document.querySelector('#latest-fetch'),
  latestSourceCount: document.querySelector('#latest-source-count'),
  databaseSize: document.querySelector('#database-size'),
  summaryListings: document.querySelector('#summary-listings'),
  summaryActive: document.querySelector('#summary-active'),
  summaryFinished: document.querySelector('#summary-finished'),
  summaryRemoved: document.querySelector('#summary-removed'),
  summaryEvents: document.querySelector('#summary-events'),
}

const dateFormatter = new Intl.DateTimeFormat('is-IS', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Atlantic/Reykjavik',
})

const numberFormatter = new Intl.NumberFormat('is-IS')

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('is')
    .replaceAll('ð', 'd')
    .replaceAll('þ', 'th')
    .replaceAll('æ', 'ae')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatDate(value) {
  if (!value) return 'Unknown time'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : dateFormatter.format(date)
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'SQLite database'
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function text(value, fallback = '—') {
  const cleaned = String(value ?? '').trim()
  return cleaned || fallback
}

function isFinishedAuctionType(value) {
  return normalize(value) === normalize(SOLD_AUCTION_TYPE)
}

function listingState(listing) {
  const sourcePresent =
    listing.sourcePresent ??
    (listing.status === 'removed' ? false : Boolean(listing.isActive))
  const isFinished =
    listing.isFinished ??
    (sourcePresent && isFinishedAuctionType(listing.current?.auctionType))

  if (!sourcePresent) {
    return { key: 'removed', label: 'Removed from feed', variant: 'removed' }
  }
  if (isFinished) {
    return { key: 'finished', label: 'Finished', variant: 'finished' }
  }
  return { key: 'active', label: 'Active', variant: 'active' }
}

function googleSearchUrl(title) {
  return `https://www.google.com/search?q=${encodeURIComponent(title)}`
}

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag)
  if (options.className) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value !== undefined && value !== null) node.setAttribute(name, value)
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child) node.append(child)
  }
  return node
}

function badge(label, variant = '') {
  return el('span', {
    className: `badge${variant ? ` badge--${variant}` : ''}`,
    text: label,
  })
}

function setFiltersFromUrl() {
  const params = new URLSearchParams(window.location.search)
  elements.query.value = params.get('q') ?? ''
  elements.auctionType.value = params.get('type') ?? ''
  elements.status.value = params.get('status') ?? ''
  elements.eventType.value = params.get('event') ?? ''
  elements.sort.value = params.get('sort') ?? 'latest'
}

function updateUrl() {
  const params = new URLSearchParams()
  const values = {
    q: elements.query.value.trim(),
    type: elements.auctionType.value,
    status: elements.status.value,
    event: elements.eventType.value,
    sort: elements.sort.value === 'latest' ? '' : elements.sort.value,
  }
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value)
  }
  const query = params.toString()
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
}

function currentLocation(listing) {
  return listing.current.auctionTakesPlaceAt || listing.current.location
}

function listingMatches(listing) {
  const terms = normalize(elements.query.value).split(' ').filter(Boolean)
  const searchable = normalize(listing.searchText)
  if (terms.some((term) => !searchable.includes(term))) return false

  if (elements.status.value && listingState(listing).key !== elements.status.value) {
    return false
  }

  const type = elements.auctionType.value
  if (type && !listing.events.some((event) => event.auctionType === type)) return false

  const eventType = elements.eventType.value
  if (eventType && !listing.events.some((event) => event.type === eventType)) return false

  return true
}

function sortListings(listings) {
  const copy = [...listings]
  if (elements.sort.value === 'address') {
    return copy.sort((left, right) =>
      text(left.current.lotName, '').localeCompare(text(right.current.lotName, ''), 'is'),
    )
  }
  if (elements.sort.value === 'first-seen') {
    return copy.sort((left, right) => right.firstSeenAt.localeCompare(left.firstSeenAt))
  }
  return copy.sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt))
}

function currentItem(label, value) {
  return el('div', { className: 'current-item' }, [
    el('span', { text: label }),
    el('strong', { text: text(value) }),
  ])
}

function snapshotDetails(snapshot) {
  const details = el('details', { className: 'snapshot' })
  details.append(el('summary', { text: 'View complete snapshot' }))
  const list = el('dl')
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    list.append(el('dt', { text: label }), el('dd', { text: text(snapshot[field]) }))
  }
  details.append(list)
  return details
}

function changeTable(changes) {
  const table = el('table', { className: 'change-table' })
  const thead = el('thead')
  const headingRow = el('tr')
  for (const heading of ['Field', 'Before', 'After']) {
    headingRow.append(el('th', { text: heading }))
  }
  thead.append(headingRow)
  table.append(thead)

  const tbody = el('tbody')
  for (const change of changes) {
    const row = el('tr')
    row.append(
      el('td', { text: change.label || FIELD_LABELS[change.field] || change.field, attrs: { 'data-label': 'Field' } }),
      el('td', { text: text(change.oldValue, '(empty)'), attrs: { 'data-label': 'Before' } }),
      el('td', { text: text(change.newValue, '(empty)'), attrs: { 'data-label': 'After' } }),
    )
    tbody.append(row)
  }
  table.append(tbody)
  return table
}

function eventCard(event) {
  const card = el('article', { className: 'event' })
  const heading = el('div', { className: 'event__heading' }, [
    el('div', { className: 'listing__badges' }, [
      badge(EVENT_LABELS[event.type] ?? event.type, event.type),
      event.auctionType ? badge(event.auctionType) : null,
    ]),
    el('time', { text: formatDate(event.observedAt), attrs: { datetime: event.observedAt } }),
  ])
  card.append(heading)
  card.append(
    el('p', {
      className: 'event__meta',
      text: REASON_LABELS[event.reason] ?? event.reason,
    }),
  )

  if (event.changes?.length) card.append(changeTable(event.changes))
  card.append(snapshotDetails(event.snapshot))
  return card
}

function listingCard(listing) {
  const details = el('details', { className: 'listing' })
  const summary = el('summary', { className: 'listing__summary' })
  const main = el('div')
  const title = text(listing.current.lotName, 'Unnamed auction')
  const currentState = listingState(listing)
  const titleLink = el('a', {
    className: 'listing__title-link',
    text: title,
    attrs: {
      href: googleSearchUrl(title),
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': `Search Google for ${title} (opens in a new tab)`,
      title: `Search Google for ${title}`,
    },
  })
  titleLink.addEventListener('click', (event) => event.stopPropagation())
  const titleRow = el('div', { className: 'listing__title-row' }, [
    el('h3', {}, [titleLink]),
    badge(currentState.label, currentState.variant),
    listing.current.auctionType ? badge(listing.current.auctionType) : null,
  ])
  main.append(titleRow)
  main.append(
    el('p', {
      className: 'listing__meta',
      text: [
        listing.current.lotId ? `Lot ID ${listing.current.lotId}` : 'No lot ID',
        currentLocation(listing),
        `First seen ${formatDate(listing.firstSeenAt)}`,
        `${listing.events.length} event${listing.events.length === 1 ? '' : 's'}`,
      ]
        .filter(Boolean)
        .join(' · '),
    }),
  )
  summary.append(main, el('span', { className: 'listing__chevron', text: '⌄', attrs: { 'aria-hidden': 'true' } }))
  details.append(summary)

  const body = el('div', { className: 'listing__body' })
  const current = listing.current
  body.append(
    el('div', { className: 'current-grid' }, [
      currentItem('Auction type', current.auctionType),
      currentItem('Auction date', [current.auctionDate, current.auctionTime].filter(Boolean).join(' ')),
      currentItem(
        'Current status',
        currentState.key === 'active'
          ? 'Active — present in source feed'
          : currentState.key === 'finished'
            ? 'Finished (Sölu lokið) — present in source feed'
            : `Removed from source feed ${formatDate(listing.removedAt)}`,
      ),
      currentItem('Lot type', current.lotType),
      currentItem('Location', currentLocation(listing)),
      currentItem('Office', current.office),
    ]),
  )
  body.append(el('h4', { className: 'timeline-title', text: 'Event timeline' }))
  const timeline = el('div', { className: 'timeline' })
  for (const event of listing.events) timeline.append(eventCard(event))
  body.append(timeline)
  details.append(body)
  return details
}

function render() {
  if (!state.archive) return
  updateUrl()
  state.filtered = sortListings(state.archive.listings.filter(listingMatches))
  const visible = state.filtered.slice(0, state.visibleCount)

  elements.results.replaceChildren(...visible.map(listingCard))
  elements.resultCount.textContent = `${numberFormatter.format(state.filtered.length)} matching listing${state.filtered.length === 1 ? '' : 's'}`
  elements.empty.hidden = state.filtered.length !== 0
  elements.showMore.hidden = visible.length >= state.filtered.length
  if (!elements.showMore.hidden) {
    elements.showMore.textContent = `Show ${Math.min(PAGE_SIZE, state.filtered.length - visible.length)} more listings`
  }
}

function applyFilters() {
  state.visibleCount = PAGE_SIZE
  render()
}

function populateArchive(archive) {
  state.archive = archive
  const counts = archive.counts
  const inferredCounts = archive.listings.reduce(
    (result, listing) => {
      result[listingState(listing).key] += 1
      return result
    },
    { active: 0, finished: 0, removed: 0 },
  )
  elements.summaryListings.textContent = numberFormatter.format(counts.listings)
  elements.summaryActive.textContent = numberFormatter.format(
    archive.version >= 2 ? (counts.active ?? inferredCounts.active) : inferredCounts.active,
  )
  elements.summaryFinished.textContent = numberFormatter.format(
    archive.version >= 2
      ? (counts.finished ?? inferredCounts.finished)
      : inferredCounts.finished,
  )
  elements.summaryRemoved.textContent = numberFormatter.format(
    archive.version >= 2
      ? (counts.removed ?? inferredCounts.removed)
      : inferredCounts.removed,
  )
  elements.summaryEvents.textContent = numberFormatter.format(counts.events)
  elements.updated.textContent = archive.generatedAt
    ? `Last recorded change: ${formatDate(archive.generatedAt)}`
    : 'No auction events recorded yet'
  elements.databaseSize.textContent = `${formatBytes(archive.database?.sizeBytes)} · schema v${archive.database?.schemaVersion ?? '—'}`

  for (const type of archive.auctionTypes ?? []) {
    elements.auctionType.append(
      el('option', {
        text: `${type.name} (${numberFormatter.format(type.eventCount)})`,
        attrs: { value: type.name },
      }),
    )
  }
  setFiltersFromUrl()
  render()
}

function populateLatestFetch(fetchStatus, archive) {
  const fetchedAt = fetchStatus?.fetchedAt || archive.generatedAt
  if (fetchedAt) {
    elements.latestFetch.textContent = formatDate(fetchedAt)
    elements.latestFetch.setAttribute('datetime', fetchedAt)
  } else {
    elements.latestFetch.textContent = 'No successful fetch recorded yet'
    elements.latestFetch.removeAttribute('datetime')
  }

  const sourceCount = Number(fetchStatus?.sourceCount)
  elements.latestSourceCount.textContent = Number.isFinite(sourceCount)
    ? `${numberFormatter.format(sourceCount)} source listing${sourceCount === 1 ? '' : 's'}`
    : ''
}

async function loadArchive() {
  try {
    const latestFetchRequest = fetch('data/latest-fetch.json', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
    const response = await fetch('data/history.json', { cache: 'no-cache' })
    if (!response.ok) throw new Error(`History request failed with HTTP ${response.status}`)
    const archive = await response.json()
    if (!Array.isArray(archive.listings)) throw new Error('History file has an unsupported structure')
    populateArchive(archive)
    populateLatestFetch(await latestFetchRequest, archive)
  } catch (error) {
    elements.resultCount.textContent = 'History unavailable'
    elements.error.hidden = false
    elements.error.textContent = `Could not load the auction history: ${error.message}`
    elements.updated.textContent = 'Archive could not be loaded'
    elements.latestFetch.textContent = 'Fetch status unavailable'
    elements.latestFetch.removeAttribute('datetime')
    elements.latestSourceCount.textContent = ''
  }
}

for (const input of [
  elements.query,
  elements.auctionType,
  elements.status,
  elements.eventType,
  elements.sort,
]) {
  input.addEventListener(input === elements.query ? 'input' : 'change', applyFilters)
}

elements.clear.addEventListener('click', () => {
  elements.query.value = ''
  elements.auctionType.value = ''
  elements.status.value = ''
  elements.eventType.value = ''
  elements.sort.value = 'latest'
  applyFilters()
  elements.query.focus()
})

elements.copyLink.addEventListener('click', async () => {
  updateUrl()
  try {
    await navigator.clipboard.writeText(window.location.href)
    const original = elements.copyLink.textContent
    elements.copyLink.textContent = 'Link copied'
    setTimeout(() => {
      elements.copyLink.textContent = original
    }, 1600)
  } catch {
    window.prompt('Copy this search link:', window.location.href)
  }
})

elements.showMore.addEventListener('click', () => {
  state.visibleCount += PAGE_SIZE
  render()
})

await loadArchive()
