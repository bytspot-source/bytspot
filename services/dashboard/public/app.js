const eventsEl = document.getElementById('events');
const ordersEl = document.getElementById('orders');
const refreshBtn = document.getElementById('refresh');
const statusEl = document.getElementById('status');
const orderMeta = document.getElementById('orderMeta');
const orderEvents = document.getElementById('orderEvents');

function append(text) {
  const div = document.createElement('div');
  div.className = 'event';
  div.textContent = text;
  eventsEl.prepend(div);
}

// Live stream
try {
  const es = new EventSource('/stream');
  es.addEventListener('message', (e) => append(`message: ${e.data}`));
  es.addEventListener('order_created', (e) => { append(`order_created: ${e.data}`); loadOrders(); });
  es.addEventListener('order_updated', (e) => { append(`order_updated: ${e.data}`); loadOrders(); if (currentOrderId) loadEvents(currentOrderId); });
  es.onerror = () => append('stream error or disconnected');
} catch (e) {
  append('EventSource not available');
}

async function loadOrders() {
  statusEl.textContent = 'Loading...';
  try {
    const r = await fetch('/api/valet/orders?status=active');
    const rows = await r.json();
    ordersEl.innerHTML = '';
    rows.forEach(row => {
      const li = document.createElement('li');
      const left = document.createElement('div');
      left.innerHTML = `<strong>#${row.id}</strong> <small>${row.status}</small><br/><small class="mono">${row.pickup_lat}, ${row.pickup_lng}</small>`;
      const btn = document.createElement('button');
      btn.textContent = 'View';
      btn.onclick = () => { selectOrder(row); };
      li.append(left, btn);
      ordersEl.append(li);
    });
    statusEl.textContent = `${rows.length} active`;
  } catch (e) {
    statusEl.textContent = 'Failed to load';
  }
}

let currentOrderId = null;
function selectOrder(row) {
  currentOrderId = row.id;
  orderMeta.innerHTML = `<strong>Order #${row.id}</strong> <small>Status: ${row.status}</small>`;
  loadEvents(row.id);
}

async function loadEvents(id) {
  orderEvents.innerHTML = '';
  const r = await fetch(`/api/valet/orders/${id}/events`);
  const rows = await r.json();
  rows.forEach(ev => {
    const div = document.createElement('div');
    div.className = 'event';
    div.textContent = `${ev.created_at} - ${ev.type} ${ev.payload ? JSON.stringify(ev.payload) : ''}`;
    orderEvents.append(div);
  });
}

refreshBtn.onclick = loadOrders;
loadOrders();

// Create test order
const make = document.getElementById('make');
const lat = document.getElementById('lat');
const lng = document.getElementById('lng');
const createBtn = document.getElementById('create');
const createResult = document.getElementById('createResult');

createBtn.onclick = async () => {
  createResult.textContent = '...';
  const body = { vehicle_make: make.value, pickup_lat: Number(lat.value), pickup_lng: Number(lng.value) };
  const r = await fetch('/api/valet/orders', { method: 'POST', headers: { 'content-type':'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });
  const data = await r.json();
  if (r.ok) {
    createResult.textContent = `Created order #${data.id}`;
    loadOrders();
  } else {
    createResult.textContent = `Error: ${data.error || 'unknown'}`;
  }
};

