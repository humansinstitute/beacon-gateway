import { generateSecretKey, getPublicKey, finalizeEvent, nip19 } from 'nostr-tools'

const $ = (s: string) => document.querySelector(s) as HTMLElement
const listId = $('#list-id')
const listBrain = $('#list-brain')
const inputId = $('#input-id') as HTMLInputElement
const inputBrain = $('#input-brain') as HTMLInputElement
const btnSendId = $('#send-id')
const btnSendBrain = $('#send-brain')
const btnGenKey = $('#gen-key')
const npubEl = $('#npub')

type Box = 'id' | 'brain'
type UiMessage = { id: number; created_at: number; content: string; status?: string }

function loadKey() {
  const raw = localStorage.getItem('beacon-online-nsec')
  if (!raw) return null
  try {
    const { type, data } = nip19.decode(raw)
    if (type !== 'nsec') return null
    const sk = data as string
    const pk = getPublicKey(sk)
    const npub = nip19.npubEncode(pk)
    return { nsec: raw, sk, pk, npub }
  } catch {
    return null
  }
}

function saveKey(sk: string) {
  const nsec = nip19.nsecEncode(sk)
  localStorage.setItem('beacon-online-nsec', nsec)
}

function ensureKey() {
  let k = loadKey()
  if (!k) {
    const sk = generateSecretKey()
    saveKey(sk)
    k = loadKey()
  }
  if (k && npubEl) npubEl.textContent = k.npub
  return k
}

async function fetchMessages(box: Box, pubkey: string) {
  const res = await fetch(`/api/messages?box=${box}&pubkey=${encodeURIComponent(pubkey)}&limit=200`)
  if (!res.ok) throw new Error('fetch failed')
  const j = await res.json()
  return j.messages as UiMessage[]
}

function render(list: HTMLElement, items: UiMessage[]) {
  list.innerHTML = ''
  for (const m of items) {
    const div = document.createElement('div')
    div.className = 'msg'
    const t = new Date((m.created_at || 0) * 1000).toLocaleTimeString()
    const text = document.createElement('span')
    text.textContent = `[${t}] ${m.content}`
    div.appendChild(text)
    if (m.status === 'draft') {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = 'draft'
      div.appendChild(badge)
    }
    list.appendChild(div)
  }
  list.scrollTop = list.scrollHeight
}

async function refreshAll() {
  const k = ensureKey()
  if (!k) return
  const [idItems, brainItems] = await Promise.all([
    fetchMessages('id', k.pk),
    fetchMessages('brain', k.pk),
  ])
  render(listId, idItems)
  render(listBrain, brainItems)
}

async function send(box: Box, text: string) {
  if (!text.trim()) return
  const k = ensureKey()
  if (!k) return
  const created_at = Math.floor(Date.now() / 1000)
  const draft = { kind: 1, created_at, tags: [['box', box]], content: text, pubkey: k.pk }
  const event = finalizeEvent(draft as any, k.sk)
  const type = box === 'brain' ? 'web_brain' : 'web_id'
  const refId = crypto.randomUUID()
  const body = { box, type, refId, event }
  console.log('[beacon-online] sending event', { ...body })
  const res = await fetch('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    console.error('send failed', res.status, await res.text())
    return
  }
  const resp = await res.json().catch(() => ({} as any))
  console.log('[beacon-online] server stored draft', resp)
  await refreshAll()
}

btnGenKey?.addEventListener('click', () => {
  const sk = generateSecretKey()
  saveKey(sk)
  const k = loadKey()
  if (k && npubEl) npubEl.textContent = k.npub
  refreshAll().catch(console.error)
})

btnSendId?.addEventListener('click', async () => {
  const text = (inputId?.value || '')
  if (inputId) inputId.value = ''
  await send('id', text)
})

btnSendBrain?.addEventListener('click', async () => {
  const text = (inputBrain?.value || '')
  if (inputBrain) inputBrain.value = ''
  await send('brain', text)
})

inputId?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') btnSendId?.dispatchEvent(new Event('click')) })
inputBrain?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') btnSendBrain?.dispatchEvent(new Event('click')) })

// Auto-generate on first load if missing
ensureKey()
refreshAll().catch(console.error)

function setupSse(box: Box) {
  const k = ensureKey()
  if (!k) return
  const es = new EventSource(`/api/stream?box=${box}&pubkey=${encodeURIComponent(k.pk)}`)
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data)
      console.log('[beacon-online] SSE', box, data)
      if (data?.type === 'insert' && data?.message) {
        // Append quick; then background refresh to ensure ordering
        const msg: UiMessage = data.message
        if (box === 'id') {
          const items = [msg]
          render(listId, (listId as any)._items ? (listId as any)._items.concat(items) : items)
          ;(listId as any)._items = ((listId as any)._items || []).concat(items)
        } else {
          const items = [msg]
          render(listBrain, (listBrain as any)._items ? (listBrain as any)._items.concat(items) : items)
          ;(listBrain as any)._items = ((listBrain as any)._items || []).concat(items)
        }
        // Background refresh to reconcile any missed changes
        refreshAll().catch(() => {})
      }
    } catch (e) {
      console.warn('bad SSE payload', e)
    }
  }
  es.onerror = () => {
    console.warn('SSE error, retrying in 3s')
    es.close()
    setTimeout(() => setupSse(box), 3000)
  }
}

setupSse('id')
setupSse('brain')
