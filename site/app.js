const PAGE_SIZE = 50
const SOLD_AUCTION_TYPE = 'Sölu lokið'

const FIELD_LABELS = {
  office: 'Embætti',
  location: 'Staðsetning',
  auctionType: 'Tegund uppboðs',
  lotType: 'Tegund eignar',
  lotName: 'Heiti eignar',
  lotId: 'Auðkenni',
  lotItems: 'Uppboðsmunir',
  auctionDate: 'Dagsetning uppboðs',
  auctionTime: 'Tími uppboðs',
  petitioners: 'Gerðarbeiðendur',
  respondent: 'Gerðarþoli',
  publishText: 'Birtingartexti',
  auctionTakesPlaceAt: 'Uppboðsstaður',
}

const EVENT_LABELS = {
  added: 'Bætt við',
  changed: 'Breytt',
  removed: 'Fjarlægt',
}

const REASON_LABELS = {
  first_seen: 'Fyrst séð í gagnagrunni',
  reappeared: 'Birtist aftur eftir að hafa verið fjarlægt',
  source_update: 'Upplýsingum breytt í gagnagrunni',
  missing_from_feed: 'Vantar í gagnagrunn',
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

const ICELANDIC_MONTHS = [
  'janúar',
  'febrúar',
  'mars',
  'apríl',
  'maí',
  'júní',
  'júlí',
  'ágúst',
  'september',
  'október',
  'nóvember',
  'desember',
]

function formatNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value ?? '')
  return Math.trunc(number)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

function formatDecimal(value) {
  return Number(value).toFixed(1).replace('.', ',')
}

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
  if (!value) return 'Óþekktur tími'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value

  // Reykjavík uses UTC year-round, so UTC fields give a stable Icelandic
  // timestamp even in browsers that do not ship the is-IS locale data.
  const day = date.getUTCDate()
  const month = ICELANDIC_MONTHS[date.getUTCMonth()]
  const year = date.getUTCFullYear()
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return `${day}. ${month} ${year} kl. ${hours}:${minutes}`
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'SQLite-gagnagrunnur'
  if (bytes < 1024) return `${formatNumber(bytes)} bæti`
  if (bytes < 1024 ** 2) return `${formatDecimal(bytes / 1024)} KB`
  return `${formatDecimal(bytes / 1024 ** 2)} MB`
}

function text(value, fallback = '—') {
  const cleaned = String(value ?? '').trim()
  return cleaned || fallback
}


function listingCountText(count) {
  const formatted = formatNumber(count)
  return count === 1 ? `${formatted} virkt uppboð` : `${formatted} virk uppboð`
}

function additionalListingCountText(count) {
  const formatted = formatNumber(count)
  return count === 1 ? `${formatted} virkt uppboð` : `${formatted} virk uppboð`
}

function eventCountText(count) {
  const formatted = formatNumber(count)
  return count === 1 ? `${formatted} breyting` : `${formatted} breytingar`
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
    return { key: 'removed', label: 'Fjarlægt', variant: 'removed' }
  }
  if (isFinished) {
    return { key: 'finished', label: SOLD_AUCTION_TYPE, variant: 'finished' }
  }
  return { key: 'active', label: 'Virkt', variant: 'active' }
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
  details.append(el('summary', { text: 'Sýna allar upplýsingar' }))
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
  for (const heading of ['Reitur', 'Fyrra gildi', 'Nýtt gildi']) {
    headingRow.append(el('th', { text: heading }))
  }
  thead.append(headingRow)
  table.append(thead)

  const tbody = el('tbody')
  for (const change of changes) {
    const row = el('tr')
    row.append(
      el('td', { text: FIELD_LABELS[change.field] || change.label || change.field, attrs: { 'data-label': 'Reitur' } }),
      el('td', { text: text(change.oldValue, '(autt)'), attrs: { 'data-label': 'Fyrra gildi' } }),
      el('td', { text: text(change.newValue, '(autt)'), attrs: { 'data-label': 'Nýtt gildi' } }),
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
  const title = text(listing.current.lotName, 'Ónefnt uppboð')
  const currentState = listingState(listing)
  const titleLink = el('a', {
    className: 'listing__title-link',
    text: title,
    attrs: {
      href: googleSearchUrl(title),
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': `Leita að ${title} á Google (opnast í nýjum flipa)`,
      title: `Leita að ${title} á Google`,
    },
  })
  titleLink.addEventListener('click', (event) => event.stopPropagation())
  const lifecycleBadge =
    currentState.key === 'finished'
      ? null
      : badge(currentState.label, currentState.variant)
  const titleRow = el('div', { className: 'listing__title-row' }, [
    el('h3', {}, [titleLink]),
    lifecycleBadge,
    listing.current.auctionType ? badge(listing.current.auctionType) : null,
  ])
  main.append(titleRow)
  main.append(
    el('p', {
      className: 'listing__meta',
      text: [
        listing.current.lotId ? `Auðkenni ${listing.current.lotId}` : 'Ekkert auðkenni',
        currentLocation(listing),
        `Fyrst séð ${formatDate(listing.firstSeenAt)}`,
        eventCountText(listing.events.length),
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
      currentItem('Tegund uppboðs', current.auctionType),
      currentItem('Dagsetning uppboðs', [current.auctionDate, current.auctionTime].filter(Boolean).join(' ')),
      currentItem(
        'Núverandi staða',
        currentState.key === 'active'
          ? 'Virkt — til staðar í gagnagrunni'
          : currentState.key === 'finished'
            ? SOLD_AUCTION_TYPE
            : `Fjarlægt úr gagnagrunni ${formatDate(listing.removedAt)}`,
      ),
      currentItem('Tegund eignar', current.lotType),
      currentItem('Staðsetning', currentLocation(listing)),
      currentItem('Embætti', current.office),
    ]),
  )
  body.append(el('h4', { className: 'timeline-title', text: 'Atburðaferill' }))
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
  elements.resultCount.textContent = `${listingCountText(state.filtered.length)} ${
    state.filtered.length === 1 ? 'passar' : 'passa'
  } við leitina`
  elements.empty.hidden = state.filtered.length !== 0
  elements.showMore.hidden = visible.length >= state.filtered.length
  if (!elements.showMore.hidden) {
    const remaining = Math.min(PAGE_SIZE, state.filtered.length - visible.length)
    elements.showMore.textContent = `Sýna ${additionalListingCountText(remaining)} til viðbótar`
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
  elements.summaryListings.textContent = formatNumber(counts.listings)
  elements.summaryActive.textContent = formatNumber(
    archive.version >= 2 ? (counts.active ?? inferredCounts.active) : inferredCounts.active,
  )
  elements.summaryFinished.textContent = formatNumber(
    archive.version >= 2
      ? (counts.finished ?? inferredCounts.finished)
      : inferredCounts.finished,
  )
  elements.summaryRemoved.textContent = formatNumber(
    archive.version >= 2
      ? (counts.removed ?? inferredCounts.removed)
      : inferredCounts.removed,
  )
  elements.summaryEvents.textContent = formatNumber(counts.events)
  elements.updated.textContent = archive.generatedAt
    ? `Síðasta breyting: ${formatDate(archive.generatedAt)}`
    : 'Engir uppboðsatburðir hafa verið skráðir'
  elements.databaseSize.textContent = `${formatBytes(archive.database?.sizeBytes)} · gagnagrunnssnið v${archive.database?.schemaVersion ?? '—'}`

  for (const type of archive.auctionTypes ?? []) {
    elements.auctionType.append(
      el('option', {
        text: `${type.name} (${formatNumber(type.eventCount)})`,
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
    elements.latestFetch.textContent = 'Engin árangursrík gagnasöfnun hefur verið skráð'
    elements.latestFetch.removeAttribute('datetime')
  }

  const sourceCount = Number(fetchStatus?.sourceCount)
  elements.latestSourceCount.textContent = Number.isFinite(sourceCount)
    ? `${listingCountText(sourceCount)} í gagnagrunni`
    : ''
}

async function loadArchive() {
  try {
    const latestFetchRequest = fetch('data/latest-fetch.json', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
    const response = await fetch('data/history.json', { cache: 'no-cache' })
    if (!response.ok) throw new Error(`Beiðni um söguskrá mistókst með HTTP ${response.status}`)
    const archive = await response.json()
    if (!Array.isArray(archive.listings)) throw new Error('Söguskráin er ekki á studdu sniði')
    populateArchive(archive)
    populateLatestFetch(await latestFetchRequest, archive)
  } catch (error) {
    elements.resultCount.textContent = 'Saga ekki tiltæk'
    elements.error.hidden = false
    elements.error.textContent = `Ekki tókst að hlaða uppboðssögu: ${error.message}`
    elements.updated.textContent = 'Ekki tókst að hlaða safni'
    elements.latestFetch.textContent = 'Staða gagnasöfnunar ekki tiltæk'
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
    elements.copyLink.textContent = 'Tengill afritaður'
    setTimeout(() => {
      elements.copyLink.textContent = original
    }, 1600)
  } catch {
    window.prompt('Afritaðu þennan leitartengil:', window.location.href)
  }
})

elements.showMore.addEventListener('click', () => {
  state.visibleCount += PAGE_SIZE
  render()
})

await loadArchive()
