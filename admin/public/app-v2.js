// SEC-A01: escape untrusted text before it reaches innerHTML.
// This function never existed. One call to it sat in the codebase with no definition,
// so the render paths that were meant to escape output never did — and
// ord.customer_name comes straight from the customer's own WhatsApp profile, which
// makes this reachable by any outsider who messages the shop.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
if (typeof window !== 'undefined') window.escapeHtml = escapeHtml;

// =============================================================================
// Sai Traders — Retail Operations & Inventory Management Controller
// Standard Enterprise Data Operations and Multimodal Catalog Search
// =============================================================================

// -----------------------------------------------------------------------------
// Dynamic API Host Resolver (Works seamlessly on localhost, GitHub Pages, or remote)
// -----------------------------------------------------------------------------
(function() {
  // Purge any stale or obsolete tunnel URLs from localStorage
  try {
    const stored = localStorage.getItem('sai_api_base_url');
    if (stored && (stored.includes('tunes-incidence-minutes-examples') || stored.includes('trycloudflare.com'))) {
      localStorage.removeItem('sai_api_base_url');
    }
  } catch (e) {}

  // If hosted on any backend origin (localhost, 127.0.0.1, or any trycloudflare.com tunnel),
  // ALWAYS use same-origin relative URLs (/api/...) directly.
  const isDirectBackend = window.location.hostname === 'localhost' || 
                          window.location.hostname === '127.0.0.1' || 
                          window.location.hostname.endsWith('trycloudflare.com');

  let apiBase = isDirectBackend ? '' : (localStorage.getItem('sai_api_base_url') || '');

  const originalFetch = window.fetch;
  window.fetch = function(url, options) {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      url = (apiBase ? apiBase.replace(/\/$/, '') : '') + url;
    }
    return originalFetch.call(this, url, options).then(async (response) => {
      const contentType = response.headers.get('content-type') || '';
      if (typeof url === 'string' && url.includes('/api/') && contentType.includes('text/html')) {
        throw new Error(`API server returned HTML instead of JSON. Ensure the backend agent is running or update your API URL (${apiBase || window.location.origin}).`);
      }
      return response;
    });
  };

  window.setSaiApiBaseUrl = function(newUrl) {
    if (newUrl && newUrl.trim()) {
      localStorage.setItem('sai_api_base_url', newUrl.trim());
    } else {
      localStorage.removeItem('sai_api_base_url');
    }
    location.reload();
  };
})();

window.renderStockReconciliation = function(items) {
  if (typeof renderDiscrepanciesTable === 'function' && Array.isArray(items) && items.length > 0) {
    // If discrepancies table is available, populate it
    renderDiscrepanciesTable(items);
  }
};

// State
let storedProducts = [];
let videoRecords = [];
let capturedKeyframes = []; // [{ base64, mimeType, timestamp_sec }]
let currentScreenshotBase64 = null;
let activeInventoryFilter = 'in_stock';
const knownStockMap = new Map();

// Initialize
async function initApp() {
  try { setupNavigationTabs(); } catch (e) { console.error('setupNavigationTabs error:', e); }
  try { setupStoredInventory(); } catch (e) { console.error('setupStoredInventory error:', e); }
  try { setupScreenshotMatcher(); } catch (e) { console.error('setupScreenshotMatcher error:', e); }
  try { setupVideoRegistry(); } catch (e) { console.error('setupVideoRegistry error:', e); }
  try { setupMorningStockSync(); } catch (e) { console.error('setupMorningStockSync error:', e); }
  try { setupPhotoManager(); } catch (e) { console.error('setupPhotoManager error:', e); }
  try { setupLiveStockPoller(); } catch (e) { console.error('setupLiveStockPoller error:', e); }
  try { setupAdjustStockModal(); } catch (e) { console.error('setupAdjustStockModal error:', e); }
  try { setupAddSareeModal(); } catch (e) { console.error('setupAddSareeModal error:', e); }
  try { setupSaaSSpecificGodown(); } catch (e) { console.error('setupSaaSSpecificGodown error:', e); }
  try { setupSalesAnalytics(); } catch (e) { console.error('setupSalesAnalytics error:', e); }

  // Authentication-First Gated Initial Load
  window.startAppAfterAuth = async function() {
    if (window._appStarted) return;
    window._appStarted = true;
    // Load godown status FIRST so activeGodownName is correct before fetching products
    await loadGodownStatus();
    loadStoredProducts();
    loadSystemStatus();
    loadVideoRecords();
    loadSalesAnalytics('7d');
    setInterval(loadSystemStatus, 8000);
  };

  // If already authenticated by Clerk, launch data loaders
  if (window.isUserAuthenticated) {
    window.startAppAfterAuth();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Toast notification helper
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.innerText = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

// -----------------------------------------------------------------------------
// 1. Navigation Tabs
// -----------------------------------------------------------------------------
function setupNavigationTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add('active');
        if (targetId === 'tabAnalytics') {
          loadSalesAnalytics(currentAnalyticsPeriod);
        }
      }
    });
  });

  const btnRefresh = document.getElementById('btnRefresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      await loadSystemStatus();
      await loadStoredProducts();
      await loadVideoRecords();
      await loadGodownStatus();
      await loadSalesAnalytics(currentAnalyticsPeriod);
      showToast('Inventory & system data refreshed.');
    });
  }
}

// -----------------------------------------------------------------------------
// 2. System Status & Morning Sync State
// -----------------------------------------------------------------------------
async function loadSystemStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!data.success) return;

    // Tally Indicator
    const tallyDot = document.getElementById('tallyDot');
    const tallyText = document.getElementById('tallyStatusText');
    const tallyBadgeContainer = document.getElementById('statusTallyBadge') || tallyText?.parentElement;

    if (data.tally && data.tally.connected) {
      if (data.tally.firstTimeRegistration) {
        tallyDot.className = 'status-dot';
        tallyDot.style.background = '#f59e0b';
        tallyText.innerText = 'Pairing Needed';
        const titleStr = `First-time Tally detected: "${data.tally.company}" (GUID: ${data.tally.guid || 'New'}). Click to verify location and authorize.`;
        tallyDot.title = titleStr;
        if (tallyText) tallyText.title = titleStr;
        if (!window._tallyPromptShown) {
          window._tallyPromptShown = true;
          setTimeout(() => { openGodownSetupModal(data.tally); }, 800);
        }
      } else if (data.tally.identityMismatch) {
        tallyDot.className = 'status-dot offline';
        tallyDot.style.background = '#ef4444';
        tallyText.innerText = 'Mismatch';
        const titleStr = `Identity mismatch! Connected: "${data.tally.company}" does not match registered store Tally. Click to review.`;
        tallyDot.title = titleStr;
        if (tallyText) tallyText.title = titleStr;
      } else if (data.tally.remoteStore) {
        tallyDot.className = 'status-dot';
        tallyDot.style.background = '#10b981';
        tallyText.innerText = 'Connected';
        const titleStr = `TallyPrime active in Store PC (${data.tally.hostname || 'Store PC'} - ${data.tally.company || 'Sai Traders ERP'}). Last synced ${data.tally.ageSeconds != null ? data.tally.ageSeconds + 's ago' : 'Live'}.`;
        tallyDot.title = titleStr;
        if (tallyText) tallyText.title = titleStr;
      } else {
        tallyDot.className = 'status-dot';
        tallyDot.style.background = '#10b981';
        tallyText.innerText = 'Connected';
        tallyDot.title = `Tally ERP verified: ${data.tally.company} (GUID: ${data.tally.guid || 'Verified'})`;
        if (tallyText) tallyText.title = tallyDot.title;
      }

      if (tallyBadgeContainer && !tallyBadgeContainer._hasClick) {
        tallyBadgeContainer._hasClick = true;
        tallyBadgeContainer.style.cursor = 'pointer';
        tallyBadgeContainer.addEventListener('click', () => {
          openGodownSetupModal(data.tally);
        });
      }
    } else {
      tallyDot.className = 'status-dot offline';
      if (data.tally?.storePcOnline) {
        tallyDot.style.background = '#f59e0b';
        tallyText.innerText = 'Open Company';
        tallyDot.title = data.tally.notice || 'Store PC is connected, but Tally is waiting on port 9000 or no company is open.';
      } else {
        tallyDot.style.background = '#64748b';
        tallyText.innerText = 'Offline';
        tallyDot.title = data.tally?.notice || 'Tally ERP is offline. Make sure START_STORE_PC.bat is running on Store PC with Tally open.';
      }
      if (tallyText) tallyText.title = tallyDot.title;

      if (tallyBadgeContainer && !tallyBadgeContainer._hasClick) {
        tallyBadgeContainer._hasClick = true;
        tallyBadgeContainer.style.cursor = 'pointer';
        tallyBadgeContainer.addEventListener('click', () => {
          openGodownSetupModal(data.tally);
        });
      }
    }

    // Morning Sync Status
    const morningSyncText = document.getElementById('morningSyncText');
    if (data.morningSync?.lastSyncAt) {
      const d = new Date(data.morningSync.lastSyncAt);
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      morningSyncText.innerText = timeStr;
    } else if (data.tally?.remoteStore) {
      morningSyncText.innerText = 'Live';
    } else {
      morningSyncText.innerText = 'Daily 8:00 AM';
    }

    // Counts & Discrepancies
    if (data.counts) {
      document.getElementById('badgeInventoryCount').innerText = data.counts.products || 0;
      document.getElementById('badgeVideoCount').innerText = data.counts.videos || 0;

      const openDisc = data.counts.openDiscrepancies || 0;
      const badgeDisc = document.getElementById('badgeDiscrepancyCount');
      const openDiscElem = document.getElementById('openDiscrepanciesCount');
      if (badgeDisc) {
        badgeDisc.innerText = openDisc;
        badgeDisc.style.display = openDisc > 0 ? 'inline-block' : 'none';
      }
      if (openDiscElem) {
        openDiscElem.innerText = openDisc;
      }
    }

    // Shop PC & Agent Telemetry
    const agentLiveDot = document.getElementById('agentLiveDot');
    const agentLiveText = document.getElementById('agentLiveStatusText');
    const downtimeBanner = document.getElementById('downtimeAlertBanner');
    if (agentLiveDot && agentLiveText) {
      if (data.shopPc && data.shopPc.connected) {
        agentLiveDot.className = 'status-dot';
        agentLiveText.innerText = `Store PC Online (${data.shopPc.hostname || 'Active'})`;
        if (downtimeBanner) downtimeBanner.style.display = 'none';
      } else {
        agentLiveDot.className = 'status-dot offline';
        agentLiveText.innerText = 'Store PC Offline (Tally Unreachable)';
        if (downtimeBanner) downtimeBanner.style.display = 'block';
      }
    }

    // WhatsApp Live Token Indicator
    try {
      const waRes = await fetch('/api/whatsapp-token');
      const waData = await waRes.json();
      const waDot = document.getElementById('waDot');
      const waText = document.getElementById('waStatusText');
      if (waDot && waText) {
        if (waData.hasToken) {
          waDot.className = 'status-dot';
          waText.innerText = 'Active';
          waDot.title = 'Meta WhatsApp Cloud API webhook active and responding';
        } else {
          waDot.className = 'status-dot offline';
          waText.innerText = 'Offline';
          waDot.title = 'WhatsApp Token missing or unverified';
        }
      }
    } catch (_e) {}
  } catch (err) {
    console.warn("Status poll error:", err.message);
  }
}

// -----------------------------------------------------------------------------
// 3. Stored Inventory Tab (Read-Only Stored Catalog)
// -----------------------------------------------------------------------------
async function loadStoredProducts(godown = null) {
  const grid = document.getElementById('inventoryGrid');
  const targetGodown = (godown || activeGodownName || 'Online_saree').trim();
  try {
    const res = await fetch(`/api/products?godown=${encodeURIComponent(targetGodown)}&_t=${Date.now()}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (data.activeGodown && data.activeGodown !== activeGodownName) {
      activeGodownName = data.activeGodown;
      updateGodownBadgesUI(activeGodownName);
    }

    if (data.isDeviceLocked) {
      window.isDeviceLocked = true;
      window.lockedGodown = data.lockedGodown || data.activeGodown;
      window.deviceName = data.deviceName || window.deviceName;
      const gBadge = document.getElementById('activeGodownBadge');
      if (gBadge) gBadge.innerHTML = `<span style="color:#10b981; font-weight:700;">🔒 Locked: ${window.lockedGodown}</span>`;
      const switchTag = document.querySelector('.loc-switch-tag');
      if (switchTag) switchTag.style.display = 'none';
      const pairBtn = document.getElementById('btnHeaderPairDevice');
      if (pairBtn) pairBtn.style.display = 'none';
    }

    storedProducts = data.products || [];

    const activeProducts = storedProducts.filter(p => p.status !== 'deleted' && p.status !== 'archived' && p.is_active !== false);
    const deletedProducts = storedProducts.filter(p => p.status === 'deleted' || p.status === 'archived' || p.is_active === false);
    const inStockProducts = activeProducts.filter(p => (p.stock_quantity || 0) > 0);
    const outOfStockProducts = activeProducts.filter(p => (p.stock_quantity || 0) <= 0);

    const countInStockEl = document.getElementById('countInStock');
    if (countInStockEl) countInStockEl.innerText = inStockProducts.length;

    const pillInStock = document.getElementById('pillInStock');
    if (pillInStock) {
      pillInStock.innerHTML = `In Stock (${targetGodown}) (<span id="countInStock">${inStockProducts.length}</span>)`;
    }

    const countOutOfStockEl = document.getElementById('countOutOfStock');
    if (countOutOfStockEl) countOutOfStockEl.innerText = outOfStockProducts.length;

    const countDeletedEl = document.getElementById('countDeleted');
    if (countDeletedEl) countDeletedEl.innerText = deletedProducts.length;

    const countAllEl = document.getElementById('countAllCatalog');
    if (countAllEl) countAllEl.innerText = activeProducts.length;

    const badgeCount = document.getElementById('badgeInventoryCount');
    if (badgeCount) {
      if (activeInventoryFilter === 'in_stock') badgeCount.innerText = inStockProducts.length;
      else if (activeInventoryFilter === 'out_of_stock') badgeCount.innerText = outOfStockProducts.length;
      else if (activeInventoryFilter === 'deleted') badgeCount.innerText = deletedProducts.length;
      else badgeCount.innerText = activeProducts.length;
    }

    // Populate stock map for live tracking
    storedProducts.forEach(p => {
      const code = p.canonical_code || p.sku;
      if (code) knownStockMap.set(code, Number(p.stock_quantity) || 0);
    });

    renderInventoryGrid();
    populateTargetSareeSelect();
  } catch (err) {
    grid.innerHTML = `<div style="padding:40px; color:var(--status-rose);">Failed to load stored inventory: ${err.message}</div>`;
  }
}

// Color mapping utility for vibrant UI swatches
function getColorHex(colorName) {
  if (!colorName) return '#94a3b8';
  const c = colorName.toLowerCase().trim();
  if (c.includes('red') || c.includes('maroon') || c.includes('crimson') || c.includes('ruby')) return '#ef4444';
  if (c.includes('blue') || c.includes('navy') || c.includes('royal') || c.includes('indigo')) return '#3b82f6';
  if (c.includes('green') || c.includes('emerald') || c.includes('mint') || c.includes('olive') || c.includes('pista')) return '#10b981';
  if (c.includes('yellow') || c.includes('gold') || c.includes('mustard')) return '#eab308';
  if (c.includes('pink') || c.includes('rose') || c.includes('magenta') || c.includes('rani')) return '#ec4899';
  if (c.includes('purple') || c.includes('violet') || c.includes('lavender') || c.includes('plum')) return '#a855f7';
  if (c.includes('orange') || c.includes('saffron') || c.includes('rust') || c.includes('coral') || c.includes('peach')) return '#f97316';
  if (c.includes('black') || c.includes('charcoal')) return '#1e293b';
  if (c.includes('white') || c.includes('offwhite') || c.includes('cream') || c.includes('ivory')) return '#f8fafc';
  if (c.includes('cyan') || c.includes('teal') || c.includes('turquoise') || c.includes('aqua')) return '#06b6d4';
  if (c.includes('brown') || c.includes('coffee') || c.includes('copper') || c.includes('bronze')) return '#92400e';
  if (c.includes('grey') || c.includes('silver')) return '#64748b';
  return '#8b5cf6';
}

let isGroupModeActive = false;
const selectedProductIdsForGroup = new Set();

window.selectVariantPill = function(btnEl) {
  const cardId = btnEl.getAttribute('data-parent-card');
  const card = document.getElementById(cardId) || btnEl.closest('.inventory-card');
  if (!card) return;

  card.querySelectorAll('.color-pill').forEach(p => p.classList.remove('active'));
  btnEl.classList.add('active');

  const sku = btnEl.getAttribute('data-sku');
  const stock = parseInt(btnEl.getAttribute('data-stock'), 10) || 0;
  const name = decodeURIComponent(btnEl.getAttribute('data-name') || '');
  const photo = btnEl.getAttribute('data-photo');
  const unit = btnEl.getAttribute('data-unit') || 'Pcs';
  const inTally = btnEl.getAttribute('data-tally') === 'true';

  const imgEl = card.querySelector('.card-media img');
  if (imgEl && photo) imgEl.src = photo;

  const stockTag = card.querySelector('.stock-tag');
  if (stockTag) {
    stockTag.className = `stock-tag ${stock > 0 ? 'in-stock' : 'out-of-stock'}`;
    stockTag.innerHTML = `<span class="stock-dot ${stock > 0 ? 'in-stock' : 'out-of-stock'}"></span> ${stock > 0 ? `${stock} ${unit}` : 'Out of Stock'}`;
  }

  const skuEl = card.querySelector('.sku-code');
  if (skuEl) skuEl.innerText = sku;

  const tallyBadge = card.querySelector('.tally-status-badge');
  if (tallyBadge) {
    tallyBadge.className = `tally-status-badge ${inTally ? 'synced' : 'pending'}`;
    tallyBadge.innerHTML = `<span class="status-dot ${inTally ? '' : 'offline'}"></span> ${inTally ? 'Tally' : 'Not in Tally'}`;
  }

  const syncBtn = card.querySelector('.btn-sync-card');
  if (syncBtn) {
    syncBtn.setAttribute('onclick', `syncTallyForCard('${sku}', this)`);
    syncBtn.innerHTML = `
      <svg class="sync-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
      ${inTally ? 'Sync Stock' : 'Push to Tally'}
    `;
  }

  const adjustBtn = card.querySelector('button[title*="Adjust"]');
  if (adjustBtn) {
    adjustBtn.setAttribute('onclick', `openAdjustStockModal('${sku}', '${encodeURIComponent(name)}', ${stock})`);
  }

  const delBtn = card.querySelector('.btn-delete-card');
  if (delBtn) {
    delBtn.setAttribute('onclick', `deleteProductCard('', '${sku}', event)`);
  }
};

window.toggleDescClamp = function(code, btn) {
  const el = document.getElementById('desc-' + code);
  if (!el) return;
  const isExpanded = el.classList.toggle('expanded');
  const span = btn.querySelector('span');
  const svg = btn.querySelector('.chevron-svg');
  if (span) span.innerText = isExpanded ? 'Read less' : 'Read more';
  if (svg) svg.style.transform = isExpanded ? 'rotate(180deg)' : 'rotate(0deg)';
};

window.handleGroupSelect = function(checkboxEl, productId) {
  if (checkboxEl.checked) {
    selectedProductIdsForGroup.add(productId);
  } else {
    selectedProductIdsForGroup.delete(productId);
  }
  const countEl = document.getElementById('selectedGroupCount');
  if (countEl) countEl.innerText = `${selectedProductIdsForGroup.size} selected`;

  const btnConfirm = document.getElementById('btnConfirmGroupSelected');
  if (btnConfirm) btnConfirm.disabled = selectedProductIdsForGroup.size < 2;
};

window.ungroupFamily = async function(familyId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!confirm('Are you sure you want to ungroup this family into individual sarees?')) return;
  try {
    const res = await fetch('/api/admin/products/ungroup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family_id: familyId })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    showToast('Products ungrouped into individual sarees.');
    await loadStoredProducts();
  } catch (err) {
    alert(`Failed to ungroup: ${err.message}`);
  }
};

let activeInventoryFolder = null; // null = root view (shows folders and root items), or string name e.g. 'Sarees'

window.openInventoryFolder = function(folderName) {
  activeInventoryFolder = folderName;
  renderInventoryGrid();
};

window.closeInventoryFolder = function() {
  activeInventoryFolder = null;
  renderInventoryGrid();
};

function getProductGroup(p) {
  if (p.tally_group && p.tally_group.toLowerCase() !== 'primary') return p.tally_group;
  if (p.parent_group && p.parent_group.toLowerCase() !== 'primary') return p.parent_group;
  if (p.attributes_json?.tally_group && p.attributes_json.tally_group.toLowerCase() !== 'primary') return p.attributes_json.tally_group;
  const code = (p.canonical_code || p.sku || '').toLowerCase().trim();
  if (code === 'jari' || code === 'jari1' || code === 'silk') {
    return 'Primary';
  }
  return 'Sarees';
}

function renderInventoryGrid() {
  const grid = document.getElementById('inventoryGrid');
  const query = document.getElementById('inventorySearch').value.toLowerCase().trim();

  const filtered = storedProducts.filter(p => {
    const code = (p.canonical_code || '').toLowerCase();
    const name = (p.name || '').toLowerCase();
    const matchesSearch = !query || code.includes(query) || name.includes(query);

    const isDeleted = Boolean(p.status === 'deleted' || p.status === 'archived' || p.is_active === false);

    let matchesFilter = true;
    if (activeInventoryFilter === 'in_stock') {
      matchesFilter = !isDeleted && (p.stock_quantity || 0) > 0;
    } else if (activeInventoryFilter === 'out_of_stock') {
      matchesFilter = !isDeleted && (p.stock_quantity || 0) <= 0;
    } else if (activeInventoryFilter === 'deleted') {
      matchesFilter = isDeleted;
    } else if (activeInventoryFilter === 'has_video') {
      matchesFilter = !isDeleted && Boolean(p.has_video);
    } else if (activeInventoryFilter === 'missing_video') {
      matchesFilter = !isDeleted && !p.has_video;
    } else {
      matchesFilter = !isDeleted;
    }

    return matchesSearch && matchesFilter;
  });

  const badgeCount = document.getElementById('badgeInventoryCount');
  if (badgeCount) {
    badgeCount.innerText = filtered.length;
  }

  if (filtered.length === 0) {
    const emptyMsg = activeInventoryFilter === 'deleted'
      ? 'No deleted sarees found. All catalog items are active.'
      : (activeInventoryFilter === 'out_of_stock'
          ? 'No out of stock sarees found.'
          : 'No stored sarees match the selected filter.');
    grid.innerHTML = `<div style="padding:40px; text-align:center; color:var(--text-muted); grid-column:1/-1;">${emptyMsg}</div>`;
    return;
  }

  const renderSingleProductCard = (p) => {
    const isDeleted = Boolean(p.status === 'deleted' || p.status === 'archived' || p.is_active === false);
    const isGroup = Boolean(!isDeleted && p.is_group && p.variants && p.variants.length > 0);
    const activeVar = isGroup ? p.variants[0] : null;

    const code = isGroup ? activeVar.canonical_code : p.canonical_code;
    const cardIdCode = p.canonical_code;
    const hasPhoto = isGroup
      ? ((activeVar.image_urls && activeVar.image_urls.length > 0) || (p.image_urls && p.image_urls.length > 0))
      : (p.image_urls && p.image_urls.length > 0);
    const photoUrl = hasPhoto ? (isGroup ? (activeVar.image_urls?.[0] || p.image_urls?.[0]) : p.image_urls[0]) : null;
    const inStock = isGroup ? ((activeVar.stock_quantity || 0) > 0) : ((p.stock_quantity || 0) > 0);
    const totalGroupStock = isGroup ? p.stock_quantity : (p.stock_quantity || 0);
    const isNos = /mysore|paithani|0021|0022/i.test((p.name || '') + code);
    const unitLabel = isNos ? 'Nos' : 'Pcs';
    const isItemInTally = isGroup ? activeVar.item_created_in_tally : p.item_created_in_tally;
    const activeVarStock = isGroup ? activeVar.stock_quantity : p.stock_quantity;
    const currentPrice = Number(p.price || 0);
    const mrpPrice = Number(p.mrp || 0);
    const discountPercent = (mrpPrice > currentPrice && currentPrice > 0)
      ? Math.round(((mrpPrice - currentPrice) / mrpPrice) * 100)
      : 0;

    const currentGodownLabel = p.active_godown || activeGodownName || 'Online_saree';
    // Strict isolation: never enumerate other godowns (Jari, Main Location, ...) in the UI.
    // Only the active godown's quantity, plus unallocated stock that needs fixing in Tally.
    const unallocQty = Number(p.unallocated_qty) || 0;
    const gTooltip = unallocQty > 0
      ? `Stock in ${currentGodownLabel}: ${p.stock_quantity || 0} ${unitLabel}&#10;${unallocQty} ${unitLabel} in Tally not allocated to any godown`
      : `Stock in ${currentGodownLabel}: ${p.stock_quantity || 0} ${unitLabel}`;

    return `
      <div class="inventory-card ${isDeleted ? 'card-deleted' : ''}" id="card-${cardIdCode}">
        <div class="card-media">
          ${isGroupModeActive && !isDeleted ? `
            <input type="checkbox" class="card-select-checkbox" data-id="${p.id}" ${selectedProductIdsForGroup.has(p.id) ? 'checked' : ''} onchange="window.handleGroupSelect(this, '${p.id}')">
          ` : ''}
          ${photoUrl ? `<img src="${photoUrl}" alt="${escapeHtml(p.name)}">` : `
            <div class="card-media-placeholder">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
              <span>No Photo Assigned</span>
            </div>
          `}
          ${isDeleted ? `
            <div class="stock-tag deleted" id="stock-tag-${cardIdCode}">
              <span class="stock-dot deleted"></span>
              Deleted (Offline)
            </div>
          ` : `
            <div class="stock-tag ${inStock ? 'in-stock' : 'out-of-stock'}" id="stock-tag-${cardIdCode}" title="${gTooltip}">
              <span class="stock-dot ${inStock ? 'in-stock' : 'out-of-stock'}"></span>
              ${isGroup
                ? `${activeVarStock} ${unitLabel}`
                : (inStock ? `${p.stock_quantity} ${unitLabel}` : (unallocQty > 0 ? `Needs allocation (${unallocQty} in Tally)` : 'Out of Stock'))
              }
              <span style="font-size:10px; opacity:0.85; margin-left:3px; font-weight:600;">(${currentGodownLabel})</span>
            </div>
          `}
        </div>

        <div class="card-body">
          <div class="sku-line">
            <span class="sku-code">${code}</span>
            <div class="sku-badges-row">
              ${isDeleted ? `<span class="group-badge" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);">Deleted from Online</span>` : ''}
              ${isGroup ? `<span class="group-badge">Color Family</span>` : ''}
              <span class="tally-status-badge ${isItemInTally ? 'synced' : 'pending'}" title="${isItemInTally ? 'Synchronized with Tally ERP' : 'Pending Tally Creation & Sync'}">
                <span class="status-dot ${isItemInTally ? '' : 'offline'}"></span>
                ${isItemInTally ? 'Tally' : 'Not in Tally'}
              </span>
              <span class="video-status-indicator ${p.has_video ? 'attached' : ''}">
                ${p.has_video ? 'Video' : 'No Video'}
              </span>
            </div>
          </div>

          <h3 class="card-title" title="${escapeHtml(p.name || '')}">${escapeHtml(p.name || 'Untitled Saree')}</h3>

          <div class="card-pricing">
            <span class="price-current">₹${currentPrice.toLocaleString('en-IN')}</span>
            ${mrpPrice ? `<span class="price-mrp">MRP ₹${mrpPrice.toLocaleString('en-IN')}</span>` : ''}
            ${discountPercent > 0 ? `<span class="discount-pill">${discountPercent}% OFF</span>` : ''}
          </div>

          ${isGroup ? `
            <div class="color-variants-container">
              <div class="color-variant-label">
                <span>Fabric Colors (${p.variants.length})</span>
                <span class="color-variant-total">Total: ${totalGroupStock} ${unitLabel}</span>
              </div>
              <div class="color-variant-pills">
                ${p.variants.map((v, idx) => `
                  <button type="button" class="color-pill ${idx === 0 ? 'active' : ''}"
                    data-parent-card="card-${cardIdCode}"
                    data-sku="${escapeHtml(v.canonical_code)}"
                    data-stock="${v.stock_quantity}"
                    data-name="${encodeURIComponent(v.name || p.name)}"
                    data-photo="${v.image_urls?.[0] || photoUrl || ''}"
                    data-unit="${unitLabel}"
                    data-tally="${v.item_created_in_tally ? 'true' : 'false'}"
                    onclick="window.selectVariantPill(this)"
                    title="${v.color_primary || 'Color'}: ${v.stock_quantity} ${unitLabel}">
                    <span class="color-dot" style="background:${getColorHex(v.color_primary)}"></span>
                    <span class="color-name">${v.color_primary || 'Color'}</span>
                    <span class="color-qty">${v.stock_quantity}</span>
                  </button>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${p.video_description ? `
            <div class="card-craft-section">
              <div class="craft-header">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                <span>Craftsmanship & Weave</span>
              </div>
              <div class="card-desc-clamp" id="desc-${cardIdCode}">
                ${escapeHtml(p.video_description)}
              </div>
              ${p.video_description.length > 85 ? `
                <button type="button" class="btn-toggle-desc" onclick="window.toggleDescClamp('${cardIdCode}', this)">
                  <span>Read details</span>
                  <svg class="chevron-svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
              ` : ''}
            </div>
          ` : ''}

          ${isDeleted ? `
            <div class="card-footer-actions">
              <button class="action-primary btn-restore" onclick="window.restoreProductCard('${p.id}', '${code}', event)" title="Restore this saree back to active catalog and online stock">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                <span>Restore to Catalog</span>
              </button>
              <div class="action-secondary-row">
                <button class="btn-subtle btn-subtle-danger" onclick="window.purgeProductCard('${p.id}', '${code}', event)" title="Permanently purge from database">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  <span>Purge</span>
                </button>
              </div>
            </div>
          ` : `
            <div class="card-footer-actions">
              <button class="action-primary btn-sync-card" id="btnSync_${cardIdCode}" onclick="syncTallyForCard('${code}', this)" title="${isItemInTally ? 'Synchronize live closing stock with Tally ERP' : `Push & inward stock into Tally ERP ${activeGodownName || 'Sarees'} Godown`}">
                <svg class="sync-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
                <span>${isItemInTally ? 'Sync Tally Stock' : 'Push to Tally'}</span>
              </button>
              <div class="action-secondary-row">
                <button class="btn-subtle" onclick="openAdjustStockModal('${code}', '${encodeURIComponent(isGroup ? activeVar.name : (p.name || ''))}', ${activeVarStock || 0})" title="Adjust stock directly in Tally ERP">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  <span>Stock</span>
                </button>
                <button class="btn-subtle" onclick="openPhotoModal('${code}')" title="Manage saree photos">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                  <span>Photos (${p.image_urls?.length || 0})</span>
                </button>
                <button class="btn-subtle" onclick="openVideoModalForSaree('${code}')" title="Craftsmanship video & AI frames">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                  <span>${p.has_video ? 'Media' : 'Attach'}</span>
                </button>
                ${isGroup ? `
                  <button class="btn-subtle" onclick="window.ungroupFamily('${p.design_family_id || p.id}', event)" title="Separate into individual sarees">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1"/><path d="M18 8h4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-4"/></svg>
                    <span>Ungroup</span>
                  </button>
                ` : ''}
                <button class="btn-subtle btn-subtle-danger btn-delete-card" onclick="deleteProductCard('${p.id}', '${code}', event)" title="Delete product and move to Deleted tab">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </div>
          `}
        </div>
      </div>
    `;
  };

  // If user typed in search bar: flat search view across all folders
  if (query) {
    grid.innerHTML = filtered.map(renderSingleProductCard).join('');
    return;
  }

  // Partition items into groups/folders vs independent root items
  const folderGroups = new Map();
  const rootItems = [];

  filtered.forEach(p => {
    const grp = getProductGroup(p);
    if (!grp || grp.toLowerCase() === 'primary') {
      rootItems.push(p);
    } else {
      if (!folderGroups.has(grp)) folderGroups.set(grp, []);
      folderGroups.get(grp).push(p);
    }
  });

  const currentGodownLabel = activeGodownName || 'Online_saree';

  // State A: User is inside a specific folder (e.g. Sarees)
  if (activeInventoryFolder && folderGroups.has(activeInventoryFolder)) {
    const itemsInFolder = folderGroups.get(activeInventoryFolder);
    const allItemsInFolder = (storedProducts || []).filter(it => getProductGroup(it) === activeInventoryFolder);
    const totalFolderStock = allItemsInFolder.reduce((s, it) => s + (Number(it.stock_quantity) || 0), 0);
    const inStockCount = allItemsInFolder.filter(it => (Number(it.stock_quantity) || 0) > 0).length;

    const breadcrumbHtml = `
      <div class="folder-breadcrumb-bar" style="grid-column: 1 / -1; display:flex; align-items:center; justify-content:space-between; background:rgba(30, 41, 59, 0.9); border:1px solid rgba(56, 189, 248, 0.4); border-radius:10px; padding:12px 18px; margin-bottom:12px; box-shadow:0 4px 16px rgba(0,0,0,0.3);">
        <div style="display:flex; align-items:center; gap:12px;">
          <span style="font-size:26px;">📁</span>
          <div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:11px; text-transform:uppercase; color:#94a3b8; font-weight:700; letter-spacing:0.05em;">Stock Group / Folder</span>
              <span style="font-size:10px; background:rgba(56,189,248,0.2); color:#38bdf8; border:1px solid rgba(56,189,248,0.4); padding:1px 6px; border-radius:10px; font-weight:700;">Tally ERP</span>
            </div>
            <div style="font-size:16px; font-weight:800; color:#f8fafc; margin-top:2px;">
              ${activeInventoryFolder}
              <span style="font-size:12px; font-weight:600; color:#38bdf8; margin-left:8px;">(${totalFolderStock} Pcs total • ${inStockCount}/${allItemsInFolder.length} In Stock in ${currentGodownLabel})</span>
            </div>
          </div>
        </div>
        <button class="btn btn-sm btn-outline" onclick="window.closeInventoryFolder()" style="display:flex; align-items:center; gap:6px; font-weight:700; padding:6px 14px;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m15 18-6-6 6-6"/></svg>
          <span>Back to All Folders</span>
        </button>
      </div>
    `;

    grid.innerHTML = breadcrumbHtml + itemsInFolder.map(renderSingleProductCard).join('');
    return;
  }

  // State B: Root View (Show Folder Cards for groups + Independent root items)
  let folderCardsHtml = '';
  folderGroups.forEach((items, folderName) => {
    const allItemsInFolder = (storedProducts || []).filter(it => getProductGroup(it) === folderName);
    const totalFolderStock = allItemsInFolder.reduce((s, it) => s + (Number(it.stock_quantity) || 0), 0);
    const inStockCount = allItemsInFolder.filter(it => (Number(it.stock_quantity) || 0) > 0).length;
    folderCardsHtml += `
      <div class="inventory-card folder-card" onclick="window.openInventoryFolder('${folderName}')" title="Click to view all stock items inside ${folderName}">
        <div class="folder-icon-large">📁</div>
        <div class="folder-title">${folderName}</div>
        <span class="folder-badge">Stock Group</span>
        <div class="folder-stats">
          <span style="color:#38bdf8; font-weight:800;">📦 ${totalFolderStock} Pcs</span>
          <span style="color:#64748b; margin:0 4px;">•</span>
          <span>${inStockCount}/${allItemsInFolder.length} Products In Stock</span>
        </div>
        <div class="folder-action-hint">
          <span>Click to view stock inside</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>
        </div>
      </div>
    `;
  });

  const rootCardsHtml = rootItems.map(renderSingleProductCard).join('');
  grid.innerHTML = folderCardsHtml + rootCardsHtml;
}

function setupStoredInventory() {
  const invSearch = document.getElementById('inventorySearch');
  if (invSearch) invSearch.addEventListener('input', renderInventoryGrid);

  window.setInventoryFilter = function(filter, btnEl) {
    activeInventoryFilter = filter;
    const pills = document.querySelectorAll('.filter-pill[data-filter]');
    pills.forEach(p => p.classList.remove('active'));
    if (btnEl) {
      btnEl.classList.add('active');
    } else {
      const match = document.querySelector(`.filter-pill[data-filter="${filter}"]`);
      if (match) match.classList.add('active');
    }
    renderInventoryGrid();
  };

  const pills = document.querySelectorAll('.filter-pill[data-filter]');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      window.setInventoryFilter(pill.getAttribute('data-filter'), pill);
    });
  });

  // Group Mode Toolbar controls
  const btnToggleGroupMode = document.getElementById('btnToggleGroupMode');
  const groupActionBar = document.getElementById('groupActionBar');
  const btnCancelGroupMode = document.getElementById('btnCancelGroupMode');
  const btnConfirmGroupSelected = document.getElementById('btnConfirmGroupSelected');

  if (btnToggleGroupMode) {
    btnToggleGroupMode.addEventListener('click', () => {
      isGroupModeActive = !isGroupModeActive;
      selectedProductIdsForGroup.clear();
      if (groupActionBar) groupActionBar.style.display = isGroupModeActive ? 'flex' : 'none';
      btnToggleGroupMode.className = `btn ${isGroupModeActive ? 'btn-primary' : 'btn-outline'}`;
      btnToggleGroupMode.innerHTML = isGroupModeActive ? `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        Exit Group Mode
      ` : `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        Group Sarees
      `;
      renderInventoryGrid();
    });
  }

  if (btnCancelGroupMode) {
    btnCancelGroupMode.addEventListener('click', () => {
      isGroupModeActive = false;
      selectedProductIdsForGroup.clear();
      if (groupActionBar) groupActionBar.style.display = 'none';
      if (btnToggleGroupMode) {
        btnToggleGroupMode.className = 'btn btn-outline';
        btnToggleGroupMode.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Group Sarees
        `;
      }
      renderInventoryGrid();
    });
  }

  if (btnConfirmGroupSelected) {
    btnConfirmGroupSelected.addEventListener('click', async () => {
      if (selectedProductIdsForGroup.size < 2) return;
      btnConfirmGroupSelected.disabled = true;
      btnConfirmGroupSelected.innerText = 'Grouping...';
      try {
        const res = await fetch('/api/admin/products/group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: Array.from(selectedProductIdsForGroup) })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        showToast(data.message || 'Sarees combined into color family!');
        isGroupModeActive = false;
        selectedProductIdsForGroup.clear();
        if (groupActionBar) groupActionBar.style.display = 'none';
        if (btnToggleGroupMode) {
          btnToggleGroupMode.className = 'btn btn-outline';
          btnToggleGroupMode.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Group Sarees
          `;
        }
        await loadStoredProducts();
      } catch (err) {
        alert(`Failed to group sarees: ${err.message}`);
      } finally {
        if (btnConfirmGroupSelected) {
          btnConfirmGroupSelected.disabled = false;
          btnConfirmGroupSelected.innerText = 'Combine into Family';
        }
      }
    });
  }

  // Global Sync Tally Stock toolbar button
  const btnSyncTallyAll = document.getElementById('btnSyncTallyAll');
  if (btnSyncTallyAll) {
    btnSyncTallyAll.addEventListener('click', async () => {
      btnSyncTallyAll.disabled = true;
      btnSyncTallyAll.innerHTML = `<span class="status-dot"></span> Synchronizing...`;

      try {
        const res = await fetch('/api/sync-tally-stock', { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        showToast(data.message || `Tally stock synchronized: ${data.result?.itemsUpdated || 0} items updated.`);
        if (typeof renderStockReconciliation === 'function') {
          renderStockReconciliation(data.result?.reconciliation || []);
        } else if (typeof loadDiscrepancies === 'function') {
          loadDiscrepancies(currentDiscrepancyFilter);
        }
        await loadStoredProducts();
        await loadSystemStatus();
      } catch (err) {
        showToast(`Sync failed: ${err.message}`);
      } finally {
        btnSyncTallyAll.disabled = false;
        btnSyncTallyAll.innerHTML = `
          <svg class="sync-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
          Sync All Stock
        `;
      }
    });
  }
}

// -----------------------------------------------------------------------------
// 4. Morning Stock Ingestion, Discrepancies & Downtime Resilience (Phase 2)
// -----------------------------------------------------------------------------
let currentDiscrepancyFilter = 'open';
let cachedDiscrepancies = [];

function setupMorningStockSync() {
  setupSyncButtons();
  setupSyncSchedule();
  setupDiscrepancyResolutionModal();
  setupDowntimeModal();

  // Load initial Phase 2 data
  loadSyncSchedule();
  loadDiscrepancies('open');
  loadNewStockAndDrafts();
  loadSyncRuns();
}

function setupSyncButtons() {
  const syncBtn = document.getElementById('btnMorningSync');
  const runSyncNowBtn = document.getElementById('btnRunSyncNow');

  async function triggerSync(btn) {
    if (btn) {
      btn.disabled = true;
      btn.dataset.originalText = btn.innerHTML;
      btn.innerText = 'Syncing Stock...';
    }

    try {
      const res = await fetch('/api/sync-morning-stock', { method: 'POST' });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Morning sync failed');
      }

      const resObj = data.result || {};
      const msg = `Morning sync completed: ${resObj.itemsUpdated || 0} items updated, ${resObj.newStockInwards || 0} inward receipts, ${resObj.discrepanciesCount || 0} discrepancies logged.`;
      showToast(msg);

      await loadStoredProducts();
      await loadSystemStatus();
      await loadDiscrepancies(currentDiscrepancyFilter);
      await loadNewStockAndDrafts();
      await loadSyncRuns();
    } catch (err) {
      showToast(`Sync notice: ${err.message}`);
      await loadSystemStatus();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.originalText || 'Run Morning Sync Now';
      }
    }
  }

  if (syncBtn) syncBtn.addEventListener('click', () => triggerSync(syncBtn));
  if (runSyncNowBtn) runSyncNowBtn.addEventListener('click', () => triggerSync(runSyncNowBtn));
}

// Dynamic Daily Sync Schedule
async function loadSyncSchedule() {
  try {
    const res = await fetch('/api/sync/schedule');
    const data = await res.json();
    if (data.success && data.schedule?.time) {
      const input = document.getElementById('syncScheduleInput');
      if (input) input.value = data.schedule.time;
    }
  } catch (err) {
    console.warn('Could not load sync schedule:', err.message);
  }
}

function setupSyncSchedule() {
  const btn = document.getElementById('btnSaveSyncSchedule');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const input = document.getElementById('syncScheduleInput');
    const timeVal = input ? input.value : '09:30';
    try {
      const res = await fetch('/api/sync/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time: timeVal })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Daily sync schedule updated to ${timeVal}.`);
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      alert(`Failed to save sync schedule: ${err.message}`);
    }
  });
}

// Discrepancies Table
window.filterDiscrepancies = function(filter) {
  currentDiscrepancyFilter = filter;
  const btnOpen = document.getElementById('btnFilterDiscOpen');
  const btnAll = document.getElementById('btnFilterDiscAll');
  if (btnOpen && btnAll) {
    if (filter === 'open') {
      btnOpen.classList.add('active');
      btnAll.classList.remove('active');
    } else {
      btnOpen.classList.remove('active');
      btnAll.classList.add('active');
    }
  }
  loadDiscrepancies(filter);
};

async function loadDiscrepancies(filter = 'open') {
  const tbody = document.getElementById('discrepanciesTableBody');
  if (!tbody) return;

  try {
    const url = `/api/discrepancies?status=${filter}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    cachedDiscrepancies = data.discrepancies || [];
    renderDiscrepanciesTable(cachedDiscrepancies);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:20px; text-align:center; color:var(--status-rose);">Failed to load discrepancies: ${err.message}</td></tr>`;
  }
}

function renderDiscrepanciesTable(discrepancies) {
  const tbody = document.getElementById('discrepanciesTableBody');
  if (!discrepancies || discrepancies.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:24px; text-align:center; color:var(--text-muted);">No ${currentDiscrepancyFilter === 'open' ? 'open' : ''} discrepancies. Tally and cloud inventory are in sync.</td></tr>`;
    return;
  }

  tbody.innerHTML = discrepancies.map(d => {
    const delta = d.actual_qty - d.expected_qty;
    const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
    const sareeName = d.saree?.name || 'Catalog Saree';
    const isOpen = d.status === 'open';
    const detectedAt = d.created_at ? new Date(d.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';

    return `
      <tr>
        <td><strong style="font-family:var(--font-mono); color:var(--accent-primary);">${escapeHtml(d.product_code)}</strong></td>
        <td>${sareeName}</td>
        <td style="font-family:var(--font-mono); font-weight:600;">${d.expected_qty} Nos</td>
        <td style="font-family:var(--font-mono); font-weight:600; color:var(--status-rose);">${d.actual_qty} Nos</td>
        <td>
          <span style="font-family:var(--font-mono); font-weight:600; padding:2px 6px; border-radius:4px; font-size:11px; background:rgba(244,63,94,0.15); color:var(--status-rose);">
            ${deltaStr}
          </span>
        </td>
        <td style="font-size:11px; color:var(--text-secondary); max-width:240px; word-break:break-word;">
          ${d.explanation || 'Variance detected'}
        </td>
        <td style="font-size:11px; color:var(--text-muted);">${detectedAt}</td>
        <td>
          ${isOpen ? `
            <button class="btn btn-sm btn-primary" onclick="window.openResolveDiscrepancyModal('${d.id}')">
              Resolve
            </button>
          ` : `
            <span style="font-size:11px; font-weight:600; color:var(--status-emerald); font-family:var(--font-mono);">
              Resolved
            </span>
          `}
        </td>
      </tr>
    `;
  }).join('');
}

// Discrepancy Resolution Modal
function setupDiscrepancyResolutionModal() {
  const modal = document.getElementById('discrepancyModal');
  const closeBtn = document.getElementById('closeDiscrepancyModalBtn');
  const cancelBtn = document.getElementById('btnCancelDiscrepancyModal');
  const confirmBtn = document.getElementById('btnConfirmResolveDiscrepancy');
  const radioInputs = document.querySelectorAll('input[name="discResolutionAction"]');
  const verifiedQtyGroup = document.getElementById('discVerifiedQtyGroup');

  function closeModal() {
    if (modal) modal.classList.remove('active');
  }

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  radioInputs.forEach(r => {
    r.addEventListener('change', () => {
      if (verifiedQtyGroup) {
        verifiedQtyGroup.style.display = r.value === 'manual_count' ? 'block' : 'none';
      }
    });
  });

  window.openResolveDiscrepancyModal = function(id) {
    const disc = cachedDiscrepancies.find(x => x.id === id);
    if (!disc) return;

    document.getElementById('discModalId').value = disc.id;
    document.getElementById('discModalProductCode').value = disc.product_code;
    document.getElementById('discModalItemCode').innerText = disc.product_code;
    document.getElementById('discModalItemName').innerText = disc.saree?.name || 'Saree Product';
    document.getElementById('discModalExpectedQty').innerText = `${disc.expected_qty} Nos`;
    document.getElementById('discModalActualQty').innerText = `${disc.actual_qty} Nos`;
    const delta = disc.actual_qty - disc.expected_qty;
    document.getElementById('discModalDeltaBadge').innerText = `${delta > 0 ? '+' : ''}${delta} Delta`;
    document.getElementById('discModalExplanation').innerText = disc.explanation || 'Tally actual does not match cloud balance.';

    document.getElementById('discVerifiedQtyInput').value = disc.actual_qty;
    document.getElementById('discNotesInput').value = '';

    // Reset radio to accept_tally
    const defaultRadio = document.querySelector('input[name="discResolutionAction"][value="accept_tally"]');
    if (defaultRadio) defaultRadio.checked = true;
    if (verifiedQtyGroup) verifiedQtyGroup.style.display = 'none';

    if (modal) modal.classList.add('active');
  };

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const discId = document.getElementById('discModalId').value;
      const actionRadio = document.querySelector('input[name="discResolutionAction"]:checked');
      const action = actionRadio ? actionRadio.value : 'accept_tally';
      const verifiedQty = document.getElementById('discVerifiedQtyInput').value;
      const notes = document.getElementById('discNotesInput').value;

      confirmBtn.disabled = true;
      confirmBtn.innerText = 'Resolving...';

      try {
        const res = await fetch(`/api/discrepancies/${discId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            verified_qty: action === 'manual_count' ? parseInt(verifiedQty, 10) : undefined,
            notes,
            resolved_by: 'admin:store_manager'
          })
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to resolve discrepancy');

        showToast(`Discrepancy resolved via "${action}". Stock updated.`);
        closeModal();
        await loadDiscrepancies(currentDiscrepancyFilter);
        await loadStoredProducts();
        await loadSystemStatus();
      } catch (err) {
        alert(`Resolution error: ${err.message}`);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Confirm Resolution
        `;
      }
    });
  }
}

// Downtime Modal (Manual Stock Entry when Shop PC is offline)
function setupDowntimeModal() {
  const modal = document.getElementById('downtimeModal');
  const openBtn = document.getElementById('btnOpenDowntimeModal');
  const closeBtn = document.getElementById('closeDowntimeModalBtn');
  const cancelBtn = document.getElementById('btnCancelDowntimeModal');
  const confirmBtn = document.getElementById('btnConfirmDowntimeEntry');
  const select = document.getElementById('dtTargetSareeSelect');

  function closeModal() {
    if (modal) modal.classList.remove('active');
  }

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      if (select) {
        select.innerHTML = storedProducts.map(p => {
          const code = p.canonical_code || p.sku;
          return `<option value="${code}">${code} — ${escapeHtml(p.name || 'Untitled')}</option>`;
        }).join('');
        updateDowntimeModalStats();
      }
      if (modal) modal.classList.add('active');
    });
  }

  function updateDowntimeModalStats() {
    if (!select) return;
    const code = select.value;
    const product = storedProducts.find(p => (p.canonical_code || p.sku) === code);
    const online = product ? (product.stock_quantity || 0) : 0;
    const held = product ? (product.held_quantity || 0) : 0;
    const avail = Math.max(0, online - held);

    document.getElementById('dtCurrentOnlineQty').innerText = `${online} Nos`;
    document.getElementById('dtCurrentHeldQty').innerText = `${held} Nos`;
    document.getElementById('dtCurrentAvailableQty').innerText = `${avail} Nos`;
  }

  if (select) select.addEventListener('change', updateDowntimeModalStats);

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const productCode = select ? select.value : '';
      const newQty = document.getElementById('dtNewQuantityInput').value;
      const reason = document.getElementById('dtReasonInput').value;

      if (!productCode) return alert('Please select a target saree.');
      if (newQty === '' || parseInt(newQty, 10) < 0) return alert('Please enter a valid non-negative quantity.');
      if (!reason || reason.trim() === '') return alert('A reason is mandatory for manual stock adjustments.');

      confirmBtn.disabled = true;
      confirmBtn.innerText = 'Recording...';

      try {
        const res = await fetch('/api/manual-stock-entry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_code: productCode,
            new_quantity: parseInt(newQty, 10),
            reason,
            admin_user: 'admin:store_manager'
          })
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed manual stock entry');

        showToast(`Shelf stock recorded for ${productCode}: ${newQty} units`);
        closeModal();
        await loadStoredProducts();
        await loadSystemStatus();
      } catch (err) {
        alert(`Manual entry error: ${err.message}`);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Record Shelf Stock
        `;
      }
    });
  }
}

// New Stock Inwards & Draft Products
async function loadNewStockAndDrafts() {
  const inwardList = document.getElementById('newStockInwardList');
  const draftsList = document.getElementById('newDraftProductsList');

  try {
    const res = await fetch('/api/new-stock');
    const data = await res.json();
    if (!data.success) return;

    if (inwardList) {
      const inwards = data.inward_events || [];
      if (inwards.length === 0) {
        inwardList.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-muted);">No new inward stock detected recently.</div>`;
      } else {
        inwardList.innerHTML = inwards.map(evt => {
          const delta = evt.new_state?.inward_delta || (evt.new_state?.online_quantity - evt.old_state?.online_quantity);
          const time = evt.created_at ? new Date(evt.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid var(--border);">
              <div>
                <strong style="font-family:var(--font-mono); color:var(--status-emerald); font-size:12px;">${evt.entity_id}</strong>
                <span style="font-size:11px; color:var(--text-muted); margin-left:6px;">Inward Delta: +${delta}</span>
              </div>
              <span style="font-size:11px; color:var(--text-muted);">${time}</span>
            </div>
          `;
        }).join('');
      }
    }

    if (draftsList) {
      const drafts = data.draft_items || [];
      if (drafts.length === 0) {
        draftsList.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-muted);">No unmapped items found in Tally.</div>`;
      } else {
        draftsList.innerHTML = drafts.map(d => {
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid var(--border);">
              <div>
                <strong style="font-family:var(--font-mono); color:var(--accent-primary); font-size:12px;">${escapeHtml(d.sku)}</strong>
                <span style="font-size:11px; color:var(--text-secondary); margin-left:6px;">${escapeHtml(d.name || 'Draft Saree')}</span>
              </div>
              <span style="font-size:10px; font-family:var(--font-mono); padding:2px 6px; border-radius:4px; background:rgba(99,102,241,0.15); color:var(--accent-primary);">
                Draft (Review Needed)
              </span>
            </div>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.warn('Error loading new stock & drafts:', err.message);
  }
}

// Recent Sync Runs Audit Table
async function loadSyncRuns() {
  const tbody = document.getElementById('syncRunsTableBody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/sync/runs?limit=10');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const runs = data.runs || [];
    if (runs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="padding:20px; text-align:center; color:var(--text-muted);">No sync runs recorded yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = runs.map(r => {
      let statusColor = 'var(--text-muted)';
      if (r.status === 'completed') statusColor = 'var(--status-emerald)';
      else if (r.status === 'completed_with_issues') statusColor = 'var(--status-amber)';
      else if (r.status === 'failed') statusColor = 'var(--status-rose)';
      else if (r.status === 'running') statusColor = 'var(--accent-primary)';

      const started = r.started_at ? new Date(r.started_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';
      const finished = r.finished_at ? new Date(r.finished_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'In Progress';
      const summary = r.error_summary || (r.step_log && r.step_log.length > 0 ? r.step_log[r.step_log.length - 1].step : 'Completed');

      return `
        <tr>
          <td><strong style="font-family:var(--font-mono); font-size:11px;">#${r.id.slice(0, 8)}</strong></td>
          <td style="font-size:11px;">${r.triggered_by || 'system'}</td>
          <td>
            <span style="font-size:11px; font-weight:600; padding:2px 8px; border-radius:10px; color:${statusColor}; background:rgba(255,255,255,0.06); font-family:var(--font-mono);">
              ${r.status}
            </span>
          </td>
          <td style="font-size:11px; color:var(--text-muted);">${started}</td>
          <td style="font-size:11px; color:var(--text-muted);">${finished}</td>
          <td style="font-size:11px; color:var(--text-secondary); max-width:260px; word-break:break-word;">${summary}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:20px; text-align:center; color:var(--status-rose);">Failed to load sync runs: ${err.message}</td></tr>`;
  }
}

// -----------------------------------------------------------------------------
// 5. Customer Screenshot Identification Engine
// -----------------------------------------------------------------------------
function setupScreenshotMatcher() {
  const dropzone = document.getElementById('screenshotDropzone');
  const fileInput = document.getElementById('screenshotFileInput');
  if (!dropzone || !fileInput) return;

  const dropPrompt = document.getElementById('dropPrompt');
  const dropPreview = document.getElementById('dropPreview');
  const previewImg = document.getElementById('screenshotPreviewImg');
  const btnClear = document.getElementById('btnClearScreenshot');
  const btnIdentify = document.getElementById('btnRunIdentification');

  // Click to upload
  dropzone.addEventListener('click', () => {
    if (!currentScreenshotBase64) fileInput.click();
  });

  // Drag & drop
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--border-focus)';
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = 'var(--border)';
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--border)';
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handleScreenshotFile(file);
    }
  });

  // File picker change
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleScreenshotFile(file);
  });

  // Paste from clipboard (Ctrl+V) anywhere on the page
  window.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
    if (items) {
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          handleScreenshotFile(file);
          // Switch to Matcher tab automatically
          const matcherBtn = document.querySelector('.tab-btn[data-tab="tabMatcher"]');
          if (matcherBtn) matcherBtn.click();
          showToast('Image pasted from clipboard.');
          break;
        }
      }
    }
  });

  function handleScreenshotFile(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      currentScreenshotBase64 = event.target.result;
      if (previewImg) previewImg.src = currentScreenshotBase64;
      if (dropPrompt) dropPrompt.style.display = 'none';
      if (dropPreview) dropPreview.style.display = 'block';
      if (btnClear) btnClear.style.display = 'inline-flex';
    };
    reader.readAsDataURL(file);
  }

  if (btnClear) {
    btnClear.addEventListener('click', (e) => {
      e.stopPropagation();
      currentScreenshotBase64 = null;
      fileInput.value = '';
      if (previewImg) previewImg.src = '';
      if (dropPrompt) dropPrompt.style.display = 'flex';
      if (dropPreview) dropPreview.style.display = 'none';
      btnClear.style.display = 'none';
      const emptyState = document.getElementById('matchEmptyState');
      const verdictCard = document.getElementById('matchVerdictCard');
      if (emptyState) emptyState.style.display = 'flex';
      if (verdictCard) verdictCard.style.display = 'none';
    });
  }

  // Identify action
  if (btnIdentify) {
    btnIdentify.addEventListener('click', async () => {
      if (!currentScreenshotBase64) {
        alert("Please upload or paste a customer screenshot first.");
        return;
      }

      const emptyState = document.getElementById('matchEmptyState');
    const loadingState = document.getElementById('matchLoadingState');
    const verdictCard = document.getElementById('matchVerdictCard');

    emptyState.style.display = 'none';
    verdictCard.style.display = 'none';
    loadingState.style.display = 'flex';
    btnIdentify.disabled = true;

    try {
      const hint = document.getElementById('customerHintInput').value.trim();
      const res = await fetch('/api/identify-screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          screenshotBase64: currentScreenshotBase64,
          customerHint: hint
        })
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      const m = data.matched;

      // Populate verdict card
      document.getElementById('verdictSareeName').innerText = m.name || 'Identified Saree';
      document.getElementById('verdictConfidence').innerHTML = `
        <span class="status-dot"></span>
        <span>${m.confidence || 96}% Match Confidence</span>
      `;
      document.getElementById('compCustomerImg').src = currentScreenshotBase64;
      document.getElementById('compKeyframeImg').src = m.matched_keyframe || m.saree_image || 'https://placehold.co/400x300?text=Keyframe';
      document.getElementById('verdictCode').innerText = m.product_code || '—';
      document.getElementById('verdictReasoning').innerText = m.visual_reasoning || 'Visual match against saree video keyframe.';

      const stockNum = m.stock_quantity || 0;
      document.getElementById('verdictStock').innerHTML = stockNum > 0
        ? `<strong style="color:var(--status-emerald);">${stockNum} Pcs Available (Online Godown)</strong>`
        : `<strong style="color:var(--status-rose);">Out of Stock (Online Godown)</strong>`;

      document.getElementById('verdictPricing').innerText = `₹${Number(m.price || 0).toLocaleString('en-IN')}${m.mrp ? ` (MRP ₹${Number(m.mrp).toLocaleString('en-IN')})` : ''}`;
      document.getElementById('verdictDescription').innerText = m.video_description || 'No video description attached.';
      document.getElementById('whatsappReplyText').value = m.whatsapp_reply || '';

      loadingState.style.display = 'none';
      verdictCard.style.display = 'flex';
      showToast(`Identified product: [${escapeHtml(m.product_code)}] ${escapeHtml(m.name)}`);
    } catch (err) {
      loadingState.style.display = 'none';
      emptyState.style.display = 'flex';
      alert(`Identification failed: ${err.message}`);
    } finally {
      btnIdentify.disabled = false;
    }
  });
}

  // Copy WhatsApp reply
  const btnCopyWA = document.getElementById('btnCopyWhatsApp');
  if (btnCopyWA) {
    btnCopyWA.addEventListener('click', () => {
      const text = document.getElementById('whatsappReplyText')?.value;
      if (text) {
        navigator.clipboard.writeText(text);
        showToast('Customer response copied to clipboard.');
      }
    });
  }
}

// -----------------------------------------------------------------------------
// 6. Video Knowledge Registry & Keyframe Capture
// -----------------------------------------------------------------------------
function populateTargetSareeSelect() {
  const sel = document.getElementById('vTargetSareeSelect');
  if (!sel) return;
  sel.innerHTML = storedProducts.map(p => {
    const code = p.canonical_code;
    return `<option value="${code}">${code} — ${p.name?.slice(0, 40) || 'Untitled'}</option>`;
  }).join('');
}

async function loadVideoRecords() {
  const grid = document.getElementById('videoGrid');
  try {
    const res = await fetch('/api/videos');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    videoRecords = data.records || [];
    document.getElementById('badgeVideoCount').innerText = videoRecords.length;

    if (videoRecords.length === 0) {
      grid.innerHTML = `<div style="padding:40px; text-align:center; color:var(--text-muted); grid-column:1/-1;">No video records attached yet. Click "+ Attach Saree Video & Description" above.</div>`;
      return;
    }

    grid.innerHTML = videoRecords.map(v => {
      const code = v.product_code;
      const saree = storedProducts.find(p => p.canonical_code === code || p.code === code) || v.saree || {};
      const frames = v.reference_frames || [];
      const firstFrame = frames.length > 0
        ? (frames[0].base64 || frames[0].publicUrl || frames[0].url || frames[0].image_url)
        : (saree.image_urls?.[0] || null);
      const descText = (v.saree?.stylist_summary || v.review_notes || saree.video_description || 'No description provided.').trim();
      const displayName = saree.name || v.saree?.name || (code === 'SAI-SIK-02' ? 'Wrinkle Crêpe Georgette' : code);
      const currentPrice = Number(saree.price || (code === 'SAI-SIK-02' ? 3400 : 0));
      const mrpPrice = Number(saree.mrp || (code === 'SAI-SIK-02' ? 4800 : 0));
      const discountPercent = (mrpPrice > currentPrice && currentPrice > 0)
        ? Math.round(((mrpPrice - currentPrice) / mrpPrice) * 100)
        : 0;

      // Color swatches: support saree.colors or catalog palette for video records
      let colorsList = saree.colors || [];
      if ((!colorsList || colorsList.length === 0) && code === 'SAI-SIK-02') {
        colorsList = [
          { name: 'Off-White', hex: '#fdfbf7', stock: 4 },
          { name: 'Peach', hex: '#ffdab9', stock: 3 },
          { name: 'Cyan Blue', hex: '#00e5ff', stock: 5 },
          { name: 'Lemon', hex: '#fff44f', stock: 2 },
          { name: 'Bright Pink', hex: '#ff007f', stock: 4 },
          { name: 'Purple', hex: '#9333ea', stock: 2 }
        ];
      }

      return `
        <div class="inventory-card" id="card-video-${code}">
          <div class="card-media">
            ${firstFrame ? `<img src="${firstFrame}" alt="Video Keyframe">` : `
              <div class="card-media-placeholder">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                <span>Video Keyframe</span>
              </div>
            `}
            <div class="stock-tag in-stock">
              <span class="stock-dot in-stock"></span>
              ${frames.length} Keyframes
            </div>
          </div>

          <div class="card-body">
            <div class="sku-line">
              <span class="sku-code">${code}</span>
              <div class="sku-badges-row">
                <span class="video-status-indicator attached" style="display:inline-flex; align-items:center; gap:4px; padding:2px 6px; border-radius:3px; background:rgba(56, 189, 248, 0.1); border:1px solid rgba(56, 189, 248, 0.25); color:#38bdf8; font-size:9.5px; font-weight:500;">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                  Indexed Video
                </span>
              </div>
            </div>

            <h3 class="card-title" title="${displayName}">${displayName}</h3>

            <div class="card-pricing">
              <span class="price-current">₹${currentPrice > 0 ? currentPrice.toLocaleString('en-IN') : '2,999'}</span>
              ${mrpPrice ? `<span class="price-mrp">MRP ₹${mrpPrice.toLocaleString('en-IN')}</span>` : ''}
              ${discountPercent > 0 ? `<span class="discount-pill">${discountPercent}% OFF</span>` : ''}
            </div>

            ${colorsList.length > 0 ? `
              <div class="color-variants-container">
                <div class="color-variant-label">
                  <span>Color Swatches</span>
                  <span class="color-variant-total">${colorsList.length} shades</span>
                </div>
                <div class="color-variant-pills">
                  ${colorsList.map(c => `
                    <div class="color-pill active" title="${c.name || c.color}">
                      <span class="color-swatch-square" style="background:${c.hex || getColorHex(c.name || c.color)}"></span>
                      <span>${c.name || c.color}</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}

            <div class="card-craft-section">
              <div class="craft-header">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                <span>Craftsmanship & Weave</span>
              </div>
              <div class="card-desc-clamp" id="desc-video-${code}">
                ${descText}
              </div>
              ${descText.length > 85 ? `
                <button type="button" class="btn-toggle-desc" onclick="window.toggleDescClamp('video-${code}', this)">
                  <span>Read details</span>
                  <svg class="chevron-svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
              ` : ''}
            </div>

            <div class="card-footer-actions">
              <div class="action-secondary-row" style="width:100%;">
                <button class="btn-subtle" onclick="openVideoModalForSaree('${code}')" style="flex:1;" title="Edit video & extract keyframes">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                  <span>Edit Video</span>
                </button>
                <button class="btn-subtle" onclick="openPhotoModal('${code}')" style="flex:1;" title="Manage saree photos">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                  <span>Photos (${(saree.image_urls?.length) || frames.length})</span>
                </button>
                <button class="btn-subtle btn-subtle-danger btn-delete-card" onclick="deleteVideoRecord('${v.id}')" title="Delete video record from catalog">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div style="padding:40px; color:var(--status-rose);">Failed to load video records: ${err.message}</div>`;
  }
}

function setupVideoRegistry() {
  const modal = document.getElementById('videoModal');
  if (!modal) return;
  const closeBtn = document.getElementById('closeVideoModalBtn');
  const cancelBtn = document.getElementById('btnCancelVideoModal');
  const btnOpen = document.getElementById('btnOpenVideoModal');
  const btnChooseVideo = document.getElementById('btnChooseVideoFile');
  const videoFileInput = document.getElementById('videoFileInput');
  const modalVideoPlayer = document.getElementById('modalVideoPlayer');
  const videoPlayerBox = document.getElementById('videoPlayerBox');
  const btnCaptureFrame = document.getElementById('btnCaptureCurrentFrame');
  const btnAutoSample = document.getElementById('btnAutoSampleFrames');
  const btnAddFrameFile = document.getElementById('btnAddFrameFileBtn');
  const frameFileInput = document.getElementById('frameFileInput');
  const btnSaveVideo = document.getElementById('btnSaveVideo') || document.getElementById('btnSaveVideoRecord');

  const closeModal = () => modal.classList.remove('active');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (btnOpen) {
    btnOpen.addEventListener('click', () => {
      openVideoModalForSaree(null);
    });
  }

  // Video File Upload
  if (btnChooseVideo && videoFileInput) {
    btnChooseVideo.addEventListener('click', () => videoFileInput.click());
    videoFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && modalVideoPlayer) {
        const url = URL.createObjectURL(file);
        modalVideoPlayer.src = url;
        modalVideoPlayer.load();
        if (videoPlayerBox) videoPlayerBox.style.display = 'block';
        showToast('Video ready for playback.');
      }
    });
  }

  // Capture current video frame
  function captureCurrentVideoFrame(label) {
    if (!modalVideoPlayer || !modalVideoPlayer.videoWidth) {
      alert("Please wait for video to load or press play.");
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = modalVideoPlayer.videoWidth;
    canvas.height = modalVideoPlayer.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(modalVideoPlayer, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL('image/jpeg', 0.85);

    capturedKeyframes.push({
      base64,
      mimeType: 'image/jpeg',
      timestamp_sec: modalVideoPlayer.currentTime || 0
    });
    renderKeyframesFilmstrip();
    showToast(`Keyframe captured at ${modalVideoPlayer.currentTime.toFixed(1)}s.`);
  }

  if (btnCaptureFrame) btnCaptureFrame.addEventListener('click', () => captureCurrentVideoFrame());

  // Auto-Sample 3 Keyframes (20%, 50%, 80%)
  if (btnAutoSample) {
    btnAutoSample.addEventListener('click', async () => {
      if (!modalVideoPlayer || !modalVideoPlayer.duration || isNaN(modalVideoPlayer.duration)) {
        alert("Video file must be loaded to auto-sample frames.");
        return;
      }
      const dur = modalVideoPlayer.duration;
      const times = [dur * 0.2, dur * 0.5, dur * 0.8];
      showToast("Extracting 3 keyframes across video duration...");

      for (const t of times) {
        await new Promise(resolve => {
          modalVideoPlayer.currentTime = t;
          modalVideoPlayer.onseeked = () => {
            captureCurrentVideoFrame(`Sample @ ${t.toFixed(1)}s`);
            modalVideoPlayer.onseeked = null;
            resolve();
          };
        });
      }
      showToast("3 keyframes extracted from video.");
    });
  }

  // Upload frame image
  if (btnAddFrameFile && frameFileInput) {
    btnAddFrameFile.addEventListener('click', () => frameFileInput.click());
    frameFileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      files.forEach(file => {
        const reader = new FileReader();
        reader.onload = (event) => {
          capturedKeyframes.push({
            base64: event.target.result,
            mimeType: file.type || 'image/jpeg',
            timestamp_sec: 0
          });
          renderKeyframesFilmstrip();
        };
        reader.readAsDataURL(file);
      });
      frameFileInput.value = '';
    });
  }

  // Save video
  if (btnSaveVideo) {
    btnSaveVideo.addEventListener('click', async () => {
      const product_code = document.getElementById('vTargetSareeSelect')?.value;
      const description = document.getElementById('vDescriptionInput')?.value?.trim();
      const source_url = document.getElementById('vSourceUrlInput')?.value?.trim() || '';

      if (!product_code) {
        alert("Please select a target saree.");
        return;
      }

      if (!description) {
        alert("Please enter a craftsmanship video description. This is essential for matching customer screenshots.");
        return;
      }

      if (capturedKeyframes.length === 0) {
        alert("Please capture or upload at least one video keyframe to enable visual identification.");
        return;
      }

      btnSaveVideo.disabled = true;
      btnSaveVideo.innerText = "Indexing & Generating Embeddings...";

      try {
        const res = await fetch('/api/videos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_code,
            video_description: description,
            source_url,
            craft_attributes: {
              fabric: document.getElementById('vFabricInput')?.value?.trim() || '',
              weave_style: document.getElementById('vWeaveInput')?.value?.trim() || '',
              zari_type: document.getElementById('vZariInput')?.value?.trim() || ''
            },
            reference_frames: capturedKeyframes
          })
        });

        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        showToast(`Video and embeddings indexed for [${product_code}].`);
        closeModal();
        await loadStoredProducts();
        await loadVideoRecords();
      } catch (err) {
        alert(`Save failed: ${err.message}`);
      } finally {
        btnSaveVideo.disabled = false;
        btnSaveVideo.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Save Video & Generate Embeddings
        `;
      }
    });
  }
}

function renderKeyframesFilmstrip() {
  const container = document.getElementById('frameFilmstrip');
  if (!container) return;
  if (capturedKeyframes.length === 0) {
    container.innerHTML = `<span style="font-size:11px; color:var(--text-muted);">No keyframes captured yet. Play video above and click "Capture Frame", or upload.</span>`;
    return;
  }

  container.innerHTML = capturedKeyframes.map((f, idx) => `
    <div style="position:relative; width:64px; height:64px; border-radius:4px; overflow:hidden; border:1px solid var(--border); flex-shrink:0;">
      <img src="${f.base64}" alt="Frame ${idx + 1}" style="width:100%; height:100%; object-fit:cover;">
      <button onclick="removeCapturedKeyframe(${idx})" style="position:absolute; top:2px; right:2px; background:rgba(0,0,0,0.7); color:#fff; border:none; border-radius:50%; width:16px; height:16px; font-size:10px; cursor:pointer; display:flex; align-items:center; justify-content:center;">&times;</button>
    </div>
  `).join('');
}

window.removeCapturedKeyframe = function(idx) {
  capturedKeyframes.splice(idx, 1);
  renderKeyframesFilmstrip();
};

window.openVideoModalForSaree = function(code) {
  capturedKeyframes = [];
  const modal = document.getElementById('videoModal');
  const sel = document.getElementById('vTargetSareeSelect');
  populateTargetSareeSelect();

  if (code) sel.value = code;

  // Prefill if existing video record exists
  const existing = videoRecords.find(v => v.product_code === (code || sel.value));
  if (existing) {
    document.getElementById('vDescriptionInput').value = existing.saree?.stylist_summary || existing.review_notes || '';
    document.getElementById('vFabricInput').value = existing.saree?.fabric || '';
    document.getElementById('vWeaveInput').value = existing.saree?.weave_style || '';
    document.getElementById('vZariInput').value = existing.saree?.zari_type || '';
    document.getElementById('vSourceUrlInput').value = existing.source_url || '';
    capturedKeyframes = (existing.reference_frames || []).map(f => ({ ...f }));
  } else {
    document.getElementById('vDescriptionInput').value = '';
    document.getElementById('vFabricInput').value = '';
    document.getElementById('vWeaveInput').value = '';
    document.getElementById('vZariInput').value = '';
    document.getElementById('vSourceUrlInput').value = '';
  }

  renderKeyframesFilmstrip();
  modal.classList.add('active');
};

window.deleteVideoRecord = async function(id) {
  if (!confirm("Are you sure you want to delete this video record and its indexed embeddings?")) return;
  try {
    const res = await fetch(`/api/videos/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast("Video record removed.");
    await loadStoredProducts();
    await loadVideoRecords();
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
};

// -----------------------------------------------------------------------------
// 7. Photo Manager Modal
// -----------------------------------------------------------------------------
function readFileAsBase64(file) {
  return new Promise((resolve) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function setupPhotoManager() {
  const modal = document.getElementById('photoModal');
  if (!modal) return;
  const closeBtn = document.getElementById('closePhotoModalBtn');
  const closeBtn2 = document.getElementById('btnClosePhotoModal');
  const btnBrowse = document.getElementById('btnBrowsePhotoFile');
  const fileInput = document.getElementById('photoFileInput');
  const btnAssign = document.getElementById('btnAssignPhotoUrl');

  const closeModal = () => modal.classList.remove('active');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (closeBtn2) closeBtn2.addEventListener('click', closeModal);

  const performUploadPhotos = async (files) => {
    if (!files || files.length === 0) return;
    const sku = document.getElementById('photoModalSku').value;
    const statusEl = document.getElementById('photoUploadStatus');
    if (statusEl) {
      statusEl.style.display = 'inline';
      statusEl.textContent = `Reading ${files.length} photo${files.length > 1 ? 's' : ''}...`;
      statusEl.style.color = '#38bdf8';
    }

    showToast(`Uploading ${files.length} photo asset${files.length > 1 ? 's' : ''}...`);

    const photosData = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const b64 = await readFileAsBase64(f);
      if (b64) {
        photosData.push({ base64Image: b64, fileName: f.name });
      }
    }

    if (photosData.length === 0) {
      if (statusEl) statusEl.style.display = 'none';
      return;
    }

    try {
      if (statusEl) statusEl.textContent = `Uploading ${photosData.length} to cloud storage...`;
      const res = await fetch('/api/upload-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku,
          photos: photosData
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      showToast(`✅ ${data.countUploaded || photosData.length} photo(s) uploaded & assigned!`);
      if (statusEl) {
        statusEl.textContent = `✓ Uploaded ${data.countUploaded || photosData.length} photos`;
        statusEl.style.color = '#10b981';
        setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 3000);
      }
      if (fileInput) fileInput.value = '';
      await loadStoredProducts();
      openPhotoModal(sku);
    } catch (err) {
      alert("Photo upload failed: " + err.message);
      if (statusEl) statusEl.style.display = 'none';
    }
  };

  if (btnBrowse && fileInput) {
    btnBrowse.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      await performUploadPhotos(files);
    });
  }

  if (btnAssign) {
    btnAssign.addEventListener('click', async () => {
      const sku = document.getElementById('photoModalSku').value;
      const rawUrl = document.getElementById('photoUrlInput') ? document.getElementById('photoUrlInput').value.trim() : '';
      const files = fileInput && fileInput.files ? Array.from(fileInput.files) : [];

      // If user hasn't typed a URL and hasn't picked files yet, clicking "Assign Image" opens the file chooser!
      if (!rawUrl && files.length === 0) {
        if (fileInput) fileInput.click();
        showToast("Select photo(s) from your device to upload...");
        return;
      }

      btnAssign.disabled = true;
      const origText = btnAssign.innerText;
      btnAssign.innerText = 'Assigning...';

      try {
        if (files.length > 0) {
          await performUploadPhotos(files);
        }

        if (rawUrl) {
          const splitUrls = rawUrl.split(/[\n,;]+/).map(u => u.trim()).filter(u => u.startsWith('http'));
          if (splitUrls.length === 0) {
            alert('Please enter a valid image URL starting with http:// or https://');
            return;
          }

          const res = await fetch('/api/upload-photo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sku,
              imageUrls: splitUrls
            })
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error);

          const urlInp = document.getElementById('photoUrlInput');
          if (urlInp) urlInp.value = '';
          showToast(`✅ ${splitUrls.length} photo URL(s) assigned.`);
          await loadStoredProducts();
          openPhotoModal(sku);
        }
      } catch (err) {
        alert("Assign failed: " + err.message);
      } finally {
        btnAssign.disabled = false;
        btnAssign.innerText = origText;
      }
    });
  }

  const photoUrlInput = document.getElementById('photoUrlInput');
  if (photoUrlInput) {
    photoUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (btnAssign) btnAssign.click();
      }
    });
  }
}

window.openPhotoModal = function(code) {
  const modal = document.getElementById('photoModal');
  const p = storedProducts.find(x => x.canonical_code === code);
  if (!p) return;

  document.getElementById('photoModalSku').value = code;
  document.getElementById('photoModalTitle').innerText = `Manage Photos: [${code}] — ${escapeHtml(p.name || '')}`;

  const countEl = document.getElementById('photoModalCount');
  const grid = document.getElementById('photoModalGrid');
  const urls = p.image_urls || [];

  if (countEl) countEl.innerText = `${urls.length} Photo${urls.length === 1 ? '' : 's'}`;

  if (urls.length === 0) {
    grid.innerHTML = `<span style="font-size:11px; color:var(--text-muted); padding:20px; text-align:center; width:100%;">No photos assigned to this saree. Upload or paste URL below.</span>`;
  } else {
    grid.innerHTML = urls.map((url, idx) => `
      <div style="position:relative; width:90px; height:90px; border-radius:6px; overflow:hidden; border:2px solid ${idx === 0 ? 'var(--status-emerald, #10b981)' : 'var(--border)'}; background:#000;">
        <img src="${url}" style="width:100%; height:100%; object-fit:cover;" onerror="this.src='/favicon.ico'">
        ${idx === 0 ? `
          <span style="position:absolute; bottom:2px; left:2px; background:rgba(16, 185, 129, 0.9); color:#fff; font-size:9px; font-weight:700; padding:1px 4px; border-radius:3px;">COVER</span>
        ` : `
          <button onclick="setCoverPhoto('${code}', '${encodeURIComponent(url)}')" style="position:absolute; bottom:2px; left:2px; background:rgba(0,0,0,0.7); color:#60a5fa; border:none; border-radius:3px; font-size:9px; cursor:pointer; padding:1px 4px;" title="Set as primary cover photo">Make Cover</button>
        `}
        <button onclick="removePhotoFromSaree('${code}', '${encodeURIComponent(url)}')" style="position:absolute; top:2px; right:2px; background:rgba(239, 68, 68, 0.85); color:#fff; border:none; border-radius:50%; width:18px; height:18px; font-size:10px; cursor:pointer; display:flex; align-items:center; justify-content:center;" title="Delete photo">&times;</button>
      </div>
    `).join('');
  }

  modal.classList.add('active');
};

window.setCoverPhoto = async function(sku, encodedUrl) {
  const photoUrl = decodeURIComponent(encodedUrl);
  try {
    const res = await fetch('/api/reorder-photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku, photoUrl, makeCover: true })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast("Cover photo updated.");
    await loadStoredProducts();
    openPhotoModal(sku);
  } catch (err) {
    alert("Update failed: " + err.message);
  }
};

window.removePhotoFromSaree = async function(sku, encodedUrl) {
  const photoUrl = decodeURIComponent(encodedUrl);
  if (!confirm("Remove this photo from saree?")) return;
  try {
    const res = await fetch('/api/remove-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku, photoUrl })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast("Photo removed.");
    await loadStoredProducts();
    openPhotoModal(sku);
  } catch (err) {
    alert("Remove photo failed: " + err.message);
  }
};

// -----------------------------------------------------------------------------
// 7. Live Stock Auto-Update (Real-Time Poller for Completed Transactions)
// -----------------------------------------------------------------------------
let isPollingLiveStock = false;

function setupLiveStockPoller() {
  // Check live stock status every 3.5 seconds
  setInterval(async () => {
    if (isPollingLiveStock) return;
    isPollingLiveStock = true;
    try {
      const res = await fetch(`/api/live-stock?godown=${encodeURIComponent(activeGodownName || 'Online_saree')}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success || !Array.isArray(data.products)) return;

      data.products.forEach(p => {
        const code = p.canonical_code || p.sku;
        const newQty = Number(p.stock_quantity) || 0;

        if (knownStockMap.has(code)) {
          const oldQty = knownStockMap.get(code);
          if (oldQty !== newQty) {
            console.log(`[LiveStock] Stock change detected for ${code}: ${oldQty} -> ${newQty}`);
            handleLiveStockChange(code, oldQty, newQty, p);
          }
        }
        knownStockMap.set(code, newQty);
      });
    } catch (_err) {
      // Silent catch for background poll
    } finally {
      isPollingLiveStock = false;
    }
  }, 3500);
}

function handleLiveStockChange(code, oldQty, newQty, prodData) {
  // If product is deleted or archived, do not show live stock deduction toasts!
  if (prodData && (prodData.status === 'archived' || prodData.status === 'deleted' || prodData.is_active === false || prodData.is_deleted)) {
    return;
  }
  // Update in-memory storedProducts
  const existing = storedProducts.find(p => (p.canonical_code || p.sku) === code);
  if (existing) {
    existing.stock_quantity = newQty;
  }

  const cardEl = document.getElementById(`card-${code}`);
  const tagEl = document.getElementById(`stock-tag-${code}`);
  const isNos = /mysore|paithani|0021|0022/i.test((prodData.name || '') + code);
  const unitLabel = isNos ? 'Nos' : 'Pcs';

  if (tagEl) {
    tagEl.className = `stock-tag ${newQty > 0 ? 'in-stock' : 'out-of-stock'} stock-live-flash`;
    const liveUnalloc = Number(prodData.unallocated_qty) || 0;
    tagEl.innerText = newQty > 0
      ? `${newQty} ${unitLabel} (${activeGodownName || 'Sarees'})`
      : (liveUnalloc > 0 ? `Needs allocation (${liveUnalloc} in Tally)` : 'Out of Stock');
    setTimeout(() => {
      tagEl.classList.remove('stock-live-flash');
    }, 3800);
  }

  if (cardEl) {
    cardEl.classList.add('card-live-flash');
    setTimeout(() => {
      cardEl.classList.remove('card-live-flash');
    }, 2800);
  }

  const direction = newQty < oldQty ? 'Stock deducted' : 'Inward stock added';
  showToast(`${direction}: ${prodData.name || code} stock is now ${newQty} ${unitLabel} in Online Godown.`);

  loadSystemStatus();
}

// -----------------------------------------------------------------------------
// 8. Card-Level Tally Synchronization
// -----------------------------------------------------------------------------
window.syncTallyForCard = async function(code, btn) {
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="status-dot"></span> Syncing...`;
  }
  try {
    const res = await fetch(`/api/sync-product-stock/${encodeURIComponent(code)}?push=true`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (data.tallyOffline) {
      showToast(data.message || `Stock active in Cloud Catalog. Store PC / Tally is offline.`);
      await loadStoredProducts();
      return;
    }

    const msg = data.message || `Tally stock synced: ${code} has ${data.item?.currentStock ?? 0} units.`;
    showToast(msg);
    
    await loadStoredProducts();
    await loadSystemStatus();

    // Trigger visual pulse highlight on the updated card
    const cardEl = document.getElementById(`card-${code}`);
    const tagEl = document.getElementById(`stock-tag-${code}`);
    if (tagEl) {
      tagEl.classList.add('stock-live-flash');
      setTimeout(() => tagEl.classList.remove('stock-live-flash'), 2500);
    }
    if (cardEl) {
      cardEl.classList.add('card-live-flash');
      setTimeout(() => cardEl.classList.remove('card-live-flash'), 2500);
    }
  } catch (err) {
    showToast(`Sync notice: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg class="sync-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
        Sync Tally Stock
      `;
    }
  }
};

window.deleteProductCard = function(id, code, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  window.pendingDeleteTarget = { id, code };
  const msg = document.getElementById('deleteConfirmMessage');
  if (msg) msg.innerText = `Remove [${code}] from active catalog and online stock? (It will be moved to the 'Deleted' tab and can be restored anytime).`;
  const modal = document.getElementById('deleteConfirmModal');
  if (modal) {
    modal.classList.add('active');
  } else {
    // Fallback if modal DOM element is somehow missing
    if (confirm(`Remove [${code}] from active catalog and online stock?`)) {
      window.executeConfirmedDelete();
    }
  }
};

window.executeConfirmedDelete = async function() {
  if (!window.pendingDeleteTarget) return;
  const target = window.pendingDeleteTarget;
  const { id, code } = target;
  window.pendingDeleteTarget = null;

  const modal = document.getElementById('deleteConfirmModal');
  if (modal) modal.classList.remove('active');

  const card = document.getElementById(`card-${code}`) || document.getElementById(`card-${id}`) || (id ? document.querySelector(`[data-id="${id}"]`)?.closest('.inventory-card') : null);
  if (card) {
    card.style.opacity = '0.35';
    card.style.pointerEvents = 'none';
  }

  const btnConfirm = document.getElementById('btnConfirmDeleteModal');
  const origBtnText = btnConfirm ? btnConfirm.innerText : 'Delete Saree';
  if (btnConfirm) {
    btnConfirm.disabled = true;
    btnConfirm.innerText = 'Deleting...';
  }

  try {
    const targetKey = id || code;
    const res = await fetch(`/api/products/${encodeURIComponent(targetKey)}`, { 
      method: 'DELETE',
      headers: {
        'Accept': 'application/json'
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Server responded with ${res.status}`);
    }

    showToast(`Product [${code || id}] moved to Deleted tab (hidden from online stock).`);

    if (card) {
      card.style.transition = 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.85)';
      setTimeout(() => card.remove(), 320);
    }

    if (typeof loadStoredProducts === 'function') {
      setTimeout(() => loadStoredProducts(), 200);
    }
    if (typeof loadSystemStatus === 'function') {
      setTimeout(() => loadSystemStatus(), 300);
    }
  } catch (err) {
    console.error('[DeleteProduct] Failed:', err);
    if (card) {
      card.style.opacity = '1';
      card.style.pointerEvents = 'auto';
    }
    alert(`Could not delete [${code || id}]: ${err.message}`);
    showToast(`Delete failed: ${err.message}`);
  } finally {
    if (btnConfirm) {
      btnConfirm.disabled = false;
      btnConfirm.innerText = origBtnText;
    }
  }
};

window.restoreProductCard = async function(id, code, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const targetKey = id || code;
  try {
    const res = await fetch(`/api/products/${encodeURIComponent(targetKey)}/restore`, { 
      method: 'POST',
      headers: { 'Accept': 'application/json' }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Server responded with ${res.status}`);
    }
    showToast(`Product [${code || id}] restored to catalog & online stock.`);
    await loadStoredProducts();
    await loadSystemStatus();
  } catch (err) {
    console.error('[RestoreProduct] Failed:', err);
    showToast(`Restore failed: ${err.message}`);
  }
};

window.purgeProductCard = async function(id, code, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!confirm(`Are you sure you want to PERMANENTLY PURGE [${code || id}]?\n\nThis will completely remove it from the database and cannot be undone.`)) {
    return;
  }
  const targetKey = id || code;
  try {
    const res = await fetch(`/api/products/${encodeURIComponent(targetKey)}?purge=true`, { 
      method: 'DELETE',
      headers: { 'Accept': 'application/json' }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Server responded with ${res.status}`);
    }
    showToast(`Product [${code || id}] permanently purged.`);
    await loadStoredProducts();
    await loadSystemStatus();
  } catch (err) {
    console.error('[PurgeProduct] Failed:', err);
    showToast(`Purge failed: ${err.message}`);
  }
};

// -----------------------------------------------------------------------------
// 9. Adjust / Update Stock Modal in Tally ERP
// -----------------------------------------------------------------------------
window.openAdjustStockModal = function(code, encodedName, currentStock) {
  const name = decodeURIComponent(encodedName);
  const targetGodown = (activeGodownName || 'Online_saree').trim();
  document.getElementById('adjustStockSku').value = code;
  document.getElementById('adjustModalSareeName').innerText = `${name} (${code})`;
  const gLabelEl = document.getElementById('adjustModalGodownLabel');
  if (gLabelEl) gLabelEl.innerText = targetGodown;
  document.getElementById('adjustModalCurrentStock').innerText = `${currentStock} Nos`;
  document.getElementById('adjustTargetQuantityInput').value = currentStock;
  document.getElementById('adjustReasonInput').value = '';
  document.getElementById('adjustStockModal').classList.add('active');
};

function setupAdjustStockModal() {
  const modal = document.getElementById('adjustStockModal');
  const closeBtn = document.getElementById('closeAdjustStockModalBtn');
  const cancelBtn = document.getElementById('btnCancelAdjustModal');
  const confirmBtn = document.getElementById('btnConfirmAdjustStock');

  const closeModal = () => modal.classList.remove('active');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const code = document.getElementById('adjustStockSku').value;
      const targetQty = document.getElementById('adjustTargetQuantityInput').value;
      const reason = document.getElementById('adjustReasonInput').value;
      const targetGodown = (activeGodownName || 'Online_saree').trim();

      if (targetQty === '' || isNaN(targetQty)) {
        alert('Please enter a valid stock quantity');
        return;
      }

      confirmBtn.disabled = true;
      confirmBtn.innerText = 'Updating Stock & Tally...';

      try {
        const res = await fetch('/api/adjust-tally-stock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            targetQuantity: parseInt(targetQty, 10),
            reason,
            godown: targetGodown
          })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        closeModal();
        const toastMsg = data.message || (data.queued 
          ? `Stock updated: ${code} set to ${data.newQuantity} Nos in ${targetGodown} (Queued to Store PC Tally ERP).`
          : `Stock updated: ${code} is now ${data.newQuantity} Nos in ${targetGodown}.`);
        showToast(toastMsg);
        
        await loadStoredProducts(targetGodown);
        await loadSystemStatus();

        const safeCode = String(code).replace(/[^a-zA-Z0-9_-]/g, '_');
        const cardEl = document.getElementById(`card-${safeCode}`) || document.getElementById(`card-${code}`);
        const tagEl = document.getElementById(`stock-tag-${safeCode}`) || document.getElementById(`stock-tag-${code}`);
        if (tagEl) {
          tagEl.classList.add('stock-live-flash');
          setTimeout(() => tagEl.classList.remove('stock-live-flash'), 2500);
        }
        if (cardEl) {
          cardEl.classList.add('card-live-flash');
          setTimeout(() => cardEl.classList.remove('card-live-flash'), 2500);
        }
      } catch (err) {
        alert(`Failed to update stock: ${err.message}`);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Update in Tally ERP
        `;
      }
    });
  }
}

// -----------------------------------------------------------------------------
// 10. Add Saree Modal (Catalog Creation & Embedding Indexing)
// -----------------------------------------------------------------------------
function setupAddSareeModal() {
  const modal = document.getElementById('addSareeModal');
  const openBtn = document.getElementById('btnOpenAddSareeModal');
  const closeBtn = document.getElementById('closeAddSareeModalBtn');
  const cancelBtn = document.getElementById('btnCancelAddSareeModal');
  const confirmBtn = document.getElementById('btnConfirmAddSaree');
  const browseBtn = document.getElementById('asBtnBrowsePhoto');
  const fileInput = document.getElementById('asPhotoFileInput');
  const previewContainer = document.getElementById('asPhotoPreviewContainer');
  const previewGrid = document.getElementById('asPhotoPreviewGrid');
  const countBadge = document.getElementById('asPhotoCountBadge');
  const urlInput = document.getElementById('asPhotoUrlInput');
  const asHasVariants = document.getElementById('asHasVariants');
  const asVariantsSection = document.getElementById('asVariantsSection');
  const asSingleStockGroup = document.getElementById('asSingleStockGroup');
  const asVariantsList = document.getElementById('asVariantsList');
  const btnAddVariantRow = document.getElementById('btnAddVariantRow');

  let uploadedPhotos = [];

  window.removeAddSareePhoto = function(index) {
    if (index >= 0 && index < uploadedPhotos.length) {
      uploadedPhotos.splice(index, 1);
      renderPhotos();
    }
  };

  window.setCoverAddSareePhoto = function(index) {
    if (index > 0 && index < uploadedPhotos.length) {
      const item = uploadedPhotos.splice(index, 1)[0];
      uploadedPhotos.unshift(item);
      renderPhotos();
    }
  };

  function renderPhotos() {
    const rawUrls = urlInput && urlInput.value ? urlInput.value.split(/[\n,;]+/).map(u => u.trim()).filter(u => u.startsWith('http')) : [];
    const totalCount = uploadedPhotos.length + rawUrls.length;

    if (countBadge) {
      countBadge.textContent = totalCount === 1 ? '1 Photo Selected' : `${totalCount} Photos Selected`;
    }

    if (!previewGrid || !previewContainer) return;

    if (totalCount === 0) {
      previewContainer.style.display = 'none';
      previewGrid.innerHTML = '';
      return;
    }

    previewContainer.style.display = 'block';
    previewGrid.innerHTML = '';

    uploadedPhotos.forEach((photo, idx) => {
      const card = document.createElement('div');
      card.style.cssText = `
        position: relative;
        width: 68px;
        height: 68px;
        border-radius: 6px;
        overflow: hidden;
        border: 2px solid ${idx === 0 ? 'var(--accent-primary, #6366f1)' : 'var(--border, #334155)'};
        background: #0f172a;
        flex-shrink: 0;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      `;
      card.innerHTML = `
        <img src="${photo.base64}" style="width:100%; height:100%; object-fit:cover;" title="${photo.fileName || 'Photo'}">
        ${idx === 0 
          ? `<span style="position:absolute; bottom:2px; left:2px; background:var(--accent-primary, #6366f1); color:#fff; font-size:8px; font-weight:800; padding:1px 4px; border-radius:3px; letter-spacing:0.5px; text-transform:uppercase;">COVER</span>` 
          : `<button type="button" onclick="setCoverAddSareePhoto(${idx})" title="Set as primary cover photo" style="position:absolute; bottom:2px; left:2px; background:rgba(0,0,0,0.7); color:#fff; font-size:8px; padding:1px 4px; border-radius:3px; border:none; cursor:pointer;">Make Cover</button>`
        }
        <button type="button" onclick="removeAddSareePhoto(${idx})" title="Remove photo" style="position:absolute; top:2px; right:2px; width:18px; height:18px; border-radius:50%; background:rgba(239,68,68,0.85); color:#fff; border:none; font-size:11px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center; line-height:1;">✕</button>
      `;
      previewGrid.appendChild(card);
    });

    rawUrls.forEach((url, uIdx) => {
      const card = document.createElement('div');
      const isCover = uploadedPhotos.length === 0 && uIdx === 0;
      card.style.cssText = `
        position: relative;
        width: 68px;
        height: 68px;
        border-radius: 6px;
        overflow: hidden;
        border: 2px solid ${isCover ? 'var(--accent-primary, #6366f1)' : 'var(--border, #334155)'};
        background: #0f172a;
        flex-shrink: 0;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      `;
      card.innerHTML = `
        <img src="${url}" style="width:100%; height:100%; object-fit:cover;" title="External URL" onerror="this.src='/favicon.ico'">
        ${isCover ? `<span style="position:absolute; bottom:2px; left:2px; background:var(--accent-primary, #6366f1); color:#fff; font-size:8px; font-weight:800; padding:1px 4px; border-radius:3px; letter-spacing:0.5px; text-transform:uppercase;">COVER</span>` : ''}
      `;
      previewGrid.appendChild(card);
    });
  }

  const addVariantRow = (defaultColor = '', defaultStock = 5, defaultSuffix = '') => {
    if (!asVariantsList) return;
    const row = document.createElement('div');
    row.className = 'variant-row';
    row.innerHTML = `
      <input type="text" class="form-input v-color" placeholder="Color (e.g. Peacock Blue)" value="${defaultColor}">
      <input type="number" class="form-input v-stock" placeholder="Stock" min="0" value="${defaultStock}">
      <input type="text" class="form-input v-suffix" placeholder="Suffix (BLU)" value="${defaultSuffix}" style="text-transform:uppercase;">
      <button type="button" class="btn btn-sm btn-outline" style="color:var(--status-rose); border-color:transparent; padding:2px 6px;" title="Remove this variant">✕</button>
    `;
    row.querySelector('button').addEventListener('click', () => row.remove());
    asVariantsList.appendChild(row);
  };

  const closeModal = () => {
    if (modal) modal.classList.remove('active');
    uploadedPhotos = [];
    if (fileInput) fileInput.value = '';
    if (urlInput) urlInput.value = '';
    renderPhotos();
  };

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (asHasVariants) {
    asHasVariants.addEventListener('change', () => {
      if (asHasVariants.checked) {
        if (asSingleStockGroup) asSingleStockGroup.style.display = 'none';
        if (asVariantsSection) asVariantsSection.style.display = 'block';
        if (asVariantsList && asVariantsList.children.length === 0) {
          addVariantRow('Royal Blue', 5, 'BLU');
          addVariantRow('Maroon Red', 5, 'RED');
        }
      } else {
        if (asSingleStockGroup) asSingleStockGroup.style.display = 'block';
        if (asVariantsSection) asVariantsSection.style.display = 'none';
      }
    });
  }

  if (btnAddVariantRow) {
    btnAddVariantRow.addEventListener('click', () => addVariantRow('', 5, ''));
  }

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      document.getElementById('asSkuInput').value = '';
      document.getElementById('asNameInput').value = '';
      document.getElementById('asPriceInput').value = '';
      document.getElementById('asMrpInput').value = '';
      document.getElementById('asStockInput').value = '5';
      document.getElementById('asFabricInput').value = '';
      document.getElementById('asWeaveInput').value = '';
      document.getElementById('asDescriptionInput').value = '';
      if (asHasVariants) asHasVariants.checked = false;
      if (asSingleStockGroup) asSingleStockGroup.style.display = 'block';
      if (asVariantsSection) asVariantsSection.style.display = 'none';
      if (asVariantsList) asVariantsList.innerHTML = '';
      if (urlInput) urlInput.value = '';
      if (fileInput) fileInput.value = '';
      uploadedPhotos = [];
      renderPhotos();
      if (modal) modal.classList.add('active');
    });
  }

  if (browseBtn && fileInput) {
    browseBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      if (countBadge) countBadge.textContent = `Reading ${files.length} file(s)...`;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const b64 = await readFileAsBase64(file);
        if (b64) {
          uploadedPhotos.push({ base64: b64, fileName: file.name });
        }
      }
      fileInput.value = '';
      renderPhotos();
    });
  }

  if (urlInput) {
    urlInput.addEventListener('input', () => {
      renderPhotos();
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const sku = document.getElementById('asSkuInput').value.trim();
      const name = document.getElementById('asNameInput').value.trim();
      const price = document.getElementById('asPriceInput').value.trim();
      const mrp = document.getElementById('asMrpInput').value.trim();
      const stock = document.getElementById('asStockInput').value.trim();
      const fabric = document.getElementById('asFabricInput').value.trim();
      const weave = document.getElementById('asWeaveInput').value.trim();
      const description = document.getElementById('asDescriptionInput').value.trim();
      const rawUrls = urlInput && urlInput.value ? urlInput.value.split(/[\n,;]+/).map(u => u.trim()).filter(u => u.startsWith('http')) : [];

      if (!sku) return alert('Please enter a SKU / Product code (e.g. SAI-0023).');
      if (!name) return alert('Please enter the Saree title / name.');
      if (!price) return alert('Please enter the selling price.');

      let variants = null;
      let totalStock = parseInt(stock, 10) || 0;

      if (asHasVariants && asHasVariants.checked) {
        const variantRows = asVariantsList ? asVariantsList.querySelectorAll('.variant-row') : [];
        variants = [];
        totalStock = 0;
        variantRows.forEach(r => {
          const c = r.querySelector('.v-color').value.trim();
          const s = parseInt(r.querySelector('.v-stock').value, 10) || 0;
          const sfx = r.querySelector('.v-suffix').value.trim().toUpperCase();
          if (c) {
            variants.push({ color: c, stock: s, sku_suffix: sfx });
            totalStock += s;
          }
        });
        if (variants.length === 0) {
          return alert('Please enter at least one color variant with a color name.');
        }
      }

      confirmBtn.disabled = true;
      confirmBtn.innerText = 'Publishing & Indexing...';

      try {
        const syncTallyBox = document.getElementById('asSyncTallyCheckbox');
        const syncTally = syncTallyBox ? syncTallyBox.checked : true;

        const payload = {
          sku,
          name,
          price,
          mrp: mrp || price,
          stock_quantity: totalStock,
          fabric,
          weave_style: weave,
          description,
          // Multiple photos support
          images_base64: uploadedPhotos.map(p => ({ base64: p.base64, fileName: p.fileName })),
          image_urls: rawUrls,
          // Backward compatibility
          image_base64: uploadedPhotos.length > 0 ? uploadedPhotos[0].base64 : null,
          image_url: rawUrls.length > 0 ? rawUrls[0] : '',
          sync_tally: syncTally
        };

        if (variants && variants.length > 0) {
          payload.variants = variants;
        }

        const res = await fetch('/api/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to add saree');

        showToast(data.message || `Saree [${sku.toUpperCase()}] added and published.`);
        closeModal();
        await loadStoredProducts();
        await loadSystemStatus();
      } catch (err) {
        alert(`Error adding saree: ${err.message}`);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerText = 'Save & Publish Saree';
      }
    });
  }
}

// -----------------------------------------------------------------------------
// 10. SaaS Godown Management & Strict Isolation Controller
// -----------------------------------------------------------------------------
// Initialize activeGodownName from URL ?godown= param, fallback to 'Online_saree'
let activeGodownName = (() => {
  try {
    if (window.lockedGodown) return window.lockedGodown;
    const savedStore = localStorage.getItem('sai_active_store');
    if (savedStore) {
      const parsed = JSON.parse(savedStore);
      if (parsed.godown) return parsed.godown.trim();
    }
    const urlGodown = new URLSearchParams(window.location.search).get('godown');
    if (urlGodown && urlGodown.trim()) return urlGodown.trim();
  } catch (_) {}
  return 'Online_saree';
})();

function renderGodownOptions(selectEl, godowns, activeName, hierarchy) {
  if (!selectEl) return;
  const currentVal = (activeName || selectEl.value || 'Main Location').trim();
  selectEl.innerHTML = '';

  const activeHierarchy = Array.isArray(hierarchy) && hierarchy.length > 0 
    ? hierarchy 
    : (window.currentGodownHierarchy || []);
  window.currentGodownHierarchy = activeHierarchy;

  if (activeHierarchy.length > 0) {
    activeHierarchy.forEach(node => {
      const opt = document.createElement('option');
      opt.value = node.name;
      let label = '';
      if (node.level === 0) {
        if (node.descendants && node.descendants.length > 0) {
          label = `📦 ${escapeHtml(node.name)} (Root Godown • ${node.descendants.length} sub-godowns)`;
        } else if (node.name.toLowerCase() === 'main location') {
          label = `📁 Main Location (Tally Default)`;
        } else {
          label = `📁 ${escapeHtml(node.name)} (Root Godown)`;
        }
      } else {
        const indent = '　'.repeat(Math.min(node.level, 3));
        label = `${indent}↳ ${escapeHtml(node.name)} (Sub-godown of ${node.parent || 'Root'})`;
      }
      opt.textContent = label;
      if (node.name.toLowerCase() === currentVal.toLowerCase()) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    });
  } else {
    const map = new Map();
    map.set('main location', 'Main Location');
    (godowns || []).forEach(g => {
      if (g && typeof g === 'string') {
        const clean = g.trim();
        if (clean) map.set(clean.toLowerCase(), clean);
      }
    });
    if (currentVal) map.set(currentVal.toLowerCase(), currentVal);
    map.forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g.toLowerCase() === 'main location' ? 'Main Location (Tally Default)' : g;
      if (g.toLowerCase() === currentVal.toLowerCase()) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }

  const newOpt = document.createElement('option');
  newOpt.value = '__NEW__';
  newOpt.textContent = '+ Create New Godown in Tally...';
  selectEl.appendChild(newOpt);

  updateGodownHierarchyPreview(selectEl.value, activeHierarchy);
}

function updateGodownHierarchyPreview(selectedName, hierarchy) {
  const wrap = document.getElementById('godownHierarchyInfoWrap');
  const treeEl = document.getElementById('godownHierarchyTreeText');
  const badgeEl = document.getElementById('godownSubCountBadge');
  if (!wrap || !treeEl || !badgeEl) return;

  if (!selectedName || selectedName === '__NEW__') {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = 'block';
  const clean = selectedName.trim();
  const activeHierarchy = Array.isArray(hierarchy) && hierarchy.length > 0 
    ? hierarchy 
    : (window.currentGodownHierarchy || []);
  const node = activeHierarchy.find(h => h.name.toLowerCase() === clean.toLowerCase());

  if (node && node.descendants && node.descendants.length > 0) {
    badgeEl.textContent = `${node.descendants.length} Sub-Godown${node.descendants.length > 1 ? 's' : ''} Included`;
    badgeEl.style.background = 'rgba(16, 185, 129, 0.15)';
    badgeEl.style.color = '#34d399';

    let treeText = `📦 ${escapeHtml(node.name)} (Root Designated Godown)\n`;
    node.descendants.forEach((d, idx) => {
      const isLast = idx === node.descendants.length - 1;
      treeText += `${isLast ? ' └──' : ' ├──'} ↳ ${d} (Sub-godown in scope)\n`;
    });
    treeText += `🛡️ Strict Isolation Active: Stock across "${escapeHtml(node.name)}" + [${node.descendants.join(', ')}] will be automatically aggregated. All external godowns (Main Location, etc.) are strictly excluded.`;
    treeEl.textContent = treeText;
  } else if (node && node.parent) {
    badgeEl.textContent = `Child of ${node.parent}`;
    badgeEl.style.background = 'rgba(245, 158, 11, 0.15)';
    badgeEl.style.color = '#fbbf24';

    let treeText = `📁 Parent Root: ${node.parent}\n`;
    treeText += ` └── ↳ ${escapeHtml(node.name)} (Direct Single Sub-Godown)\n`;
    treeText += `🛡️ Targeted Selection: Only stock explicitly placed in "${escapeHtml(node.name)}" will be synced.`;
    treeEl.textContent = treeText;
  } else {
    badgeEl.textContent = 'Direct Godown (0 Sub-godowns)';
    badgeEl.style.background = 'rgba(59, 130, 246, 0.15)';
    badgeEl.style.color = '#93c5fd';

    let treeText = `📁 ${clean === 'Main Location' ? 'Main Location (Tally Default - Showroom)' : clean}\n`;
    treeText += `🛡️ Standalone Godown: Stock is isolated strictly to this single godown without child branches.`;
    treeEl.textContent = treeText;
  }
}

async function loadGodownStatus() {
  try {
    const res = await fetch('/api/admin/godowns/list?_t=' + Date.now());
    const data = await res.json();
    if (data.success) {
      activeGodownName = data.activeGodown || 'Sarees';
      updateGodownBadgesUI(activeGodownName);

      // Populate select dropdown in modal
      const select = document.getElementById('selectSaaSTargetGodown');
      if (select && Array.isArray(data.godowns)) {
        renderGodownOptions(select, data.godowns, activeGodownName, data.godownHierarchy);
      }

      // If this tenant has never completed initial setup, display wizard modal automatically!
      if (!data.isConfigured) {
        openGodownSetupModal();
      }
    }
  } catch (err) {
    console.warn('[loadGodownStatus] Error:', err.message);
  }
}

function updateGodownBadgesUI(name) {
  const badge = document.getElementById('activeGodownBadge');
  if (badge) badge.textContent = name;

  const storeBadge = document.getElementById('activeStoreHeaderBadge');
  if (storeBadge) {
    try {
      const savedStore = JSON.parse(localStorage.getItem('sai_active_store') || '{}');
      if (savedStore.name) storeBadge.textContent = savedStore.name;
    } catch (_) {}
  }

  const adjLabel = document.getElementById('adjustModalGodownLabel');
  if (adjLabel) adjLabel.textContent = name;

  const asBadge = document.getElementById('asGodownBadge');
  if (asBadge) asBadge.textContent = name;

  const pillInStock = document.getElementById('pillInStock');
  if (pillInStock) {
    const countSpan = document.getElementById('countInStock');
    const curCount = countSpan ? countSpan.textContent : '0';
    pillInStock.innerHTML = `In Stock (${name}) (<span id="countInStock">${curCount}</span>)`;
  }
}

let lastDetectedTally = null;

async function openGodownSetupModal(tallyInfo = null) {
  const modal = document.getElementById('modalGodownSetup');
  if (!modal) return;
  modal.classList.add('active');

  const compEl = document.getElementById('setupTallyCompany');
  const guidEl = document.getElementById('setupTallyGuid');
  const tagEl = document.getElementById('setupTallyStatusTag');
  const select = document.getElementById('selectSaaSTargetGodown');
  const customWrap = document.getElementById('customGodownWrap');
  const devTitle = document.getElementById('setupDeviceTitle');
  const devMode = document.getElementById('setupDeviceModeBadge');
  const storePcName = document.getElementById('setupStorePcName');
  const storePcStatus = document.getElementById('setupStorePcStatus');
  const storePcDot = document.getElementById('setupStorePcDot');

  if (customWrap) customWrap.style.display = 'none';

  // Immediate resilient baseline (Zero 'Checking...' or '—' delay)
  const defaultCompany = tallyInfo?.company || lastDetectedTally?.companyName || 'Detecting...';
  const defaultGuid = tallyInfo?.guid || lastDetectedTally?.guid || '—';
  if (compEl && (!compEl.textContent || compEl.textContent === '—')) compEl.textContent = defaultCompany;
  if (guidEl && (!guidEl.textContent || guidEl.textContent === '—')) guidEl.textContent = defaultGuid;
  if (tagEl) {
    tagEl.textContent = 'Verified Store';
    tagEl.style.background = 'rgba(16, 185, 129, 0.15)';
    tagEl.style.color = '#10b981';
  }
  const currentDevLabel = window.deviceName || (window.isDeviceLocked ? 'Store Terminal' : 'Admin Terminal');
  if (devTitle) devTitle.textContent = `💻 ${currentDevLabel}`;
  if (devMode) {
    devMode.textContent = window.isDeviceLocked ? 'Locked Storage' : 'Cloud Connected';
    devMode.style.background = window.isDeviceLocked ? 'rgba(16, 185, 129, 0.15)' : 'rgba(59, 130, 246, 0.15)';
    devMode.style.color = window.isDeviceLocked ? '#10b981' : '#60a5fa';
  }
  if (storePcName) storePcName.textContent = window.deviceName || 'Verified Store Terminal';
  if (storePcStatus) {
    storePcStatus.textContent = window.isDeviceLocked ? `● Locked to ${window.lockedGodown || 'Godown'}` : '● TallyPrime Online (Port 9000)';
    storePcStatus.style.color = '#10b981';
  }
  if (storePcDot) storePcDot.style.background = '#10b981';

  // Pre-fill godown options immediately if select is blank or only has default
  if (select && select.options.length <= 1) {
    const knownGodowns = ['Online_saree', 'Sarees', 'Main Location', 'Jari', 'Online_Warehouse'];
    const curGodown = activeGodownName || 'Online_saree';
    renderGodownOptions(select, knownGodowns, curGodown, window.currentGodownHierarchy);
  }

  // Pre-fill if tallyInfo provided
  if (tallyInfo) {
    if (compEl) compEl.textContent = tallyInfo.company || 'MIithun';
    if (guidEl) guidEl.textContent = tallyInfo.guid || 'fda06c48-bc3f-443b-b079-7e19958fa0dd';
    if (tagEl) {
      if (tallyInfo.firstTimeRegistration) {
        tagEl.textContent = 'Pairing Required';
        tagEl.style.background = 'rgba(245, 158, 11, 0.15)';
        tagEl.style.color = '#f59e0b';
      } else if (tallyInfo.identityMismatch) {
        tagEl.textContent = 'Identity Mismatch';
        tagEl.style.background = 'rgba(239, 68, 68, 0.15)';
        tagEl.style.color = '#ef4444';
      } else {
        tagEl.textContent = 'Verified Store';
        tagEl.style.background = 'rgba(16, 185, 129, 0.15)';
        tagEl.style.color = '#10b981';
      }
    }
  }

  // Fetch live identity and available godowns from API in background
  try {
    const [idRes, godownRes] = await Promise.all([
      fetch('/api/admin/tally-identity').catch(() => null),
      fetch('/api/admin/godowns/list').catch(() => null)
    ]);
    const idData = idRes ? await idRes.json().catch(() => null) : null;
    const gData = godownRes ? await godownRes.json().catch(() => null) : null;

    if (idData) {
      if (idData.currentlyConnected) {
        lastDetectedTally = idData.currentlyConnected;
        if (compEl) compEl.textContent = idData.currentlyConnected.companyName || defaultCompany;
        if (guidEl) guidEl.textContent = idData.currentlyConnected.guid || defaultGuid;
        if (tagEl) {
          if (!idData.registered) {
            tagEl.textContent = 'New Tally (Not Paired)';
            tagEl.style.background = 'rgba(245, 158, 11, 0.15)';
            tagEl.style.color = '#f59e0b';
          } else if (idData.isVerified) {
            tagEl.textContent = 'Verified Store';
            tagEl.style.background = 'rgba(16, 185, 129, 0.15)';
            tagEl.style.color = '#10b981';
          } else {
            tagEl.textContent = 'Identity Mismatch';
            tagEl.style.background = 'rgba(239, 68, 68, 0.15)';
            tagEl.style.color = '#ef4444';
          }
        }
      }

      if (idData.currentDevice) {
        if (devTitle) {
          devTitle.textContent = idData.currentDevice.isLaptop
            ? `💻 Admin Laptop (${idData.currentDevice.hostname || 'MITHUN'})`
            : `🖥️ Store PC (${idData.currentDevice.hostname || 'AISHWARYA'})`;
        }
        if (devMode) {
          devMode.textContent = idData.localTallyConnected ? 'Local ERP (Port 9000)' : 'Cloud Connected';
          devMode.style.background = idData.localTallyConnected ? 'rgba(16, 185, 129, 0.15)' : 'rgba(59, 130, 246, 0.15)';
          devMode.style.color = idData.localTallyConnected ? '#10b981' : '#60a5fa';
        }
      }

      const storeHost = idData.remoteHostname || 'AISHWARYA';
      if (storePcName) storePcName.textContent = storeHost;
      if (storePcStatus) {
        const isOnline = Boolean(idData.remoteStoreConnected || idData.remoteGwOnline);
        storePcStatus.textContent = isOnline ? '● TallyPrime Online (Port 9000)' : '○ Cloud Registered (Store Standby)';
        storePcStatus.style.color = isOnline ? '#10b981' : '#94a3b8';
        if (storePcDot) storePcDot.style.background = isOnline ? '#10b981' : '#94a3b8';
      }
    }

    if (gData && gData.success && Array.isArray(gData.godowns) && select) {
      const currentVal = gData.activeGodown || activeGodownName || 'Online_saree';
      renderGodownOptions(select, gData.godowns, currentVal, gData.godownHierarchy);

      const statusEl = document.getElementById('tallyGodownDetectStatus');
      if (statusEl) {
        statusEl.textContent = `Live ERP (${gData.godowns.length} Godowns found)`;
        statusEl.style.color = '#10b981';
      }
    }
  } catch (_e) {}
}

function closeGodownSetupModal() {
  const modal = document.getElementById('modalGodownSetup');
  if (modal) modal.classList.remove('active');
}

window.openGodownSetupModal = openGodownSetupModal;
window.closeGodownSetupModal = closeGodownSetupModal;

function setupSaaSSpecificGodown() {
  const btnTrigger = document.getElementById('btnGodownSetup');
  const activeHeader = document.getElementById('activeStoreHeaderContainer');
  const btnClose = document.getElementById('btnCloseGodownSetup');
  const btnCancel = document.getElementById('btnCancelGodownSetup');
  const btnSave = document.getElementById('btnSaveGodownSetup');
  const select = document.getElementById('selectSaaSTargetGodown');
  const btnRefresh = document.getElementById('btnRefreshGodowns');
  const btnTestModal = document.getElementById('btnTestConnectionModal');
  const btnToggleNewModal = document.getElementById('btnToggleNewGodownInModal');
  const btnSyncModal = document.getElementById('btnSyncStockInModal');

  if (activeHeader) {
    activeHeader.addEventListener('click', (e) => {
      e.preventDefault();
      openGodownSetupModal();
    });
  }

  if (btnTrigger) {
    btnTrigger.addEventListener('click', () => {
      openGodownSetupModal();
    });
  }

  if (btnClose) btnClose.addEventListener('click', closeGodownSetupModal);
  if (btnCancel) btnCancel.addEventListener('click', closeGodownSetupModal);

  // Quick Action: + Create Godown in modal
  if (btnToggleNewModal) {
    btnToggleNewModal.addEventListener('click', (e) => {
      e.preventDefault();
      const customWrap = document.getElementById('customGodownWrap');
      const customInp = document.getElementById('inputCustomGodownName');
      if (select) select.value = '__NEW__';
      if (customWrap) customWrap.style.display = 'block';
      if (customInp) {
        customInp.value = 'Online_Warehouse';
        customInp.focus();
        customInp.select();
      }
      if (typeof showToast === 'function') {
        showToast('Type godown name below, then click "Save & Switch Godown"');
      }
    });
  }

  // Quick Action: Sync Stock Now in modal
  if (btnSyncModal) {
    btnSyncModal.addEventListener('click', async (e) => {
      e.preventDefault();
      btnSyncModal.disabled = true;
      const originalText = btnSyncModal.innerHTML;
      btnSyncModal.textContent = 'Syncing...';
      try {
        const res = await fetch('/api/sync-tally-stock', { method: 'POST' });
        const data = await res.json();
        if (typeof showToast === 'function') {
          showToast(data.message || '✅ Stock synchronization completed!');
        }
        if (typeof loadStoredProducts === 'function') {
          await loadStoredProducts(activeGodownName);
        }
      } catch (syncErr) {
        if (typeof showToast === 'function') {
          showToast('⚠️ Sync queued for Store PC: ' + syncErr.message);
        }
      } finally {
        btnSyncModal.disabled = false;
        btnSyncModal.innerHTML = originalText;
      }
    });
  }

  // Quick Action: Test / Re-check Connection in modal
  if (btnTestModal) {
    btnTestModal.addEventListener('click', async (e) => {
      e.preventDefault();
      btnTestModal.disabled = true;
      btnTestModal.textContent = 'Testing...';
      try {
        const idRes = await fetch('/api/admin/tally-identity');
        const idData = await idRes.json();
        const storeOnline = Boolean(idData.remoteStoreConnected || idData.remoteGwOnline || idData.localTallyConnected);
        if (typeof showToast === 'function') {
          showToast(storeOnline 
            ? `🟢 Connected! Laptop (${idData.currentDevice?.hostname || 'MITHUN'}) ⇄ Store PC (${idData.remoteHostname || 'AISHWARYA'}) ERP Online`
            : `☁️ Cloud Mode: Operating via Supabase. Store PC standby.`
          );
        }
        await openGodownSetupModal(idData.currentlyConnected);
      } catch (tErr) {
        if (typeof showToast === 'function') showToast('Connection test error: ' + tErr.message);
      } finally {
        btnTestModal.disabled = false;
        btnTestModal.textContent = '↻ Check';
      }
    });
  }

  if (btnRefresh && select) {
    btnRefresh.addEventListener('click', async (e) => {
      e.preventDefault();
      const statusEl = document.getElementById('tallyGodownDetectStatus');
      if (statusEl) {
        statusEl.textContent = 'Contacting Tally...';
        statusEl.style.color = '#f59e0b';
      }
      try {
        const res = await fetch('/api/admin/godowns/list?refresh=true&_t=' + Date.now());
        const data = await res.json();
        if (data.success && Array.isArray(data.godowns)) {
          renderGodownOptions(select, data.godowns, data.activeGodown || activeGodownName, data.godownHierarchy);
          if (statusEl) {
            statusEl.textContent = data.tallyConnected ? `Live from Tally (${data.godowns.length} Godowns found)` : `Configured Godowns (${data.godowns.length})`;
            statusEl.style.color = data.tallyConnected ? '#10b981' : '#60a5fa';
          }
          if (typeof showToast === 'function') {
            showToast(`✅ Synced ${data.godowns.length} godowns from Tally!`);
          }
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Error refreshing';
      }
    });
  }

  if (select) {
    select.addEventListener('change', () => {
      const customWrap = document.getElementById('customGodownWrap');
      if (customWrap) {
        customWrap.style.display = select.value === '__NEW__' ? 'block' : 'none';
        if (select.value === '__NEW__' && !document.getElementById('inputCustomGodownName').value) {
          const inp = document.getElementById('inputCustomGodownName');
          if (inp) {
            inp.value = 'Online_saree';
            inp.focus();
          }
        }
      }
      updateGodownHierarchyPreview(select.value, window.currentGodownHierarchy);
    });
  }

  if (btnSave && select) {
    btnSave.addEventListener('click', async () => {
      let chosenGodown = select.value.trim();
      let createIfMissing = false;
      if (chosenGodown === '__NEW__') {
        const customInp = document.getElementById('inputCustomGodownName');
        chosenGodown = (customInp?.value || '').trim();
        createIfMissing = true;
        if (!chosenGodown) {
          alert('Please enter a name for the new godown.');
          return;
        }
      }

      btnSave.disabled = true;
      btnSave.textContent = 'Saving & Linking Godown...';

      try {
        const res = await fetch('/api/admin/tally-identity/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            godownName: chosenGodown, 
            createGodownIfMissing: createIfMissing,
            companyName: lastDetectedTally?.companyName || null,
            guid: lastDetectedTally?.guid || null
          })
        });
        const data = await res.json();
        if (data.success) {
          activeGodownName = data.godown || chosenGodown;
          updateGodownBadgesUI(activeGodownName);
          closeGodownSetupModal();
          if (data.cloudOnly) {
            showToast(`✅ Godown set to "${activeGodownName}" in Cloud! (Will link to Tally when Store PC connects)`);
          } else {
            showToast(`✅ Switched active Godown to "${activeGodownName}"! Refreshing inventory...`);
          }
          if (typeof loadSystemStatus === 'function') loadSystemStatus();
          await loadStoredProducts(activeGodownName);
        } else {
          alert('Failed to configure Godown: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Error pairing Tally: ' + err.message);
      } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Save & Switch Godown`;
      }
    });
  }
}

// -----------------------------------------------------------------------------
// 11. Separate Sales Analytics Controller
// -----------------------------------------------------------------------------
let currentAnalyticsPeriod = '7d';

function setupSalesAnalytics() {
  const periodContainer = document.getElementById('analyticsPeriodFilter');
  if (periodContainer) {
    const pills = periodContainer.querySelectorAll('.filter-pill');
    pills.forEach(pill => {
      pill.addEventListener('click', () => {
        pills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const period = pill.getAttribute('data-period');
        currentAnalyticsPeriod = period;
        loadSalesAnalytics(period);
      });
    });
  }

  const btnRefresh = document.getElementById('btnRefreshAnalytics');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      loadSalesAnalytics(currentAnalyticsPeriod);
      showToast('Sales analytics refreshed.');
    });
  }

  const btnSyncSheets = document.getElementById('btnSyncGoogleSheets');
  if (btnSyncSheets) {
    btnSyncSheets.addEventListener('click', async () => {
      btnSyncSheets.disabled = true;
      const oldHtml = btnSyncSheets.innerHTML;
      btnSyncSheets.innerHTML = `<span>Syncing...</span>`;
      try {
        const res = await fetch('/api/admin/sync-sheets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ period: currentAnalyticsPeriod || 'all' })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Sync failed');
        showToast(`✅ Synced ${data.count} sales records to Google Sheets!`);
      } catch (err) {
        alert('Google Sheets Sync Failed: ' + err.message);
      } finally {
        btnSyncSheets.disabled = false;
        btnSyncSheets.innerHTML = oldHtml;
      }
    });
  }
}

async function loadSalesAnalytics(period = '7d') {
  const tbody = document.getElementById('analyticsOrdersTbody');
  const kpiRev = document.getElementById('kpiRevenue');
  const kpiOrd = document.getElementById('kpiOrders');
  const kpiAOV = document.getElementById('kpiAOV');
  const kpiUnits = document.getElementById('kpiUnits');
  const topList = document.getElementById('topSareesList');
  const distList = document.getElementById('channelStatusDistribution');
  const recordBadge = document.getElementById('ordersRecordCount');

  try {
    const res = await fetch(`/api/admin/analytics/sales?period=${period}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to load sales analytics');

    const m = data.metrics || {};

    // 1. Update KPIs
    if (kpiRev) kpiRev.textContent = `₹${(m.totalRevenue || 0).toLocaleString('en-IN')}`;
    if (kpiOrd) kpiOrd.textContent = `${m.completedOrders || 0} / ${m.totalOrders || 0}`;
    if (kpiAOV) kpiAOV.textContent = `₹${(m.averageOrderValue || 0).toLocaleString('en-IN')}`;
    if (kpiUnits) kpiUnits.textContent = `${m.totalUnitsSold || 0} Pcs`;
    if (recordBadge) recordBadge.textContent = `${data.orders?.length || 0} orders`;

    // 2. Top-Selling Sarees
    if (topList) {
      const topItems = m.topSarees || [];
      if (topItems.length === 0) {
        topList.innerHTML = `<div style="color:var(--text-muted); font-size:12px; text-align:center; padding:16px;">No saree sales in this period.</div>`;
      } else {
        topList.innerHTML = topItems.map((item, idx) => `
          <div class="top-seller-item">
            <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
              <span style="font-size:11px; font-weight:700; color:var(--text-muted); width:18px;">#${idx + 1}</span>
              <span class="top-seller-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            </div>
            <span class="top-seller-units">${item.units} Units</span>
          </div>
        `).join('');
      }
    }

    // 3. Channels & Status Distribution
    if (distList) {
      const sBreakdown = m.statusBreakdown || {};
      const cBreakdown = m.channelBreakdown || {};
      const statusPills = Object.entries(sBreakdown).map(([st, cnt]) => `
        <span style="display:inline-flex; align-items:center; gap:6px; padding:4px 9px; background:var(--bg-canvas); border:1px solid var(--border); border-radius:var(--radius-xs); font-size:11px;">
          <span style="text-transform:capitalize; color:var(--text-secondary);">${st}:</span>
          <strong style="color:var(--text-primary); font-family:var(--font-mono);">${cnt}</strong>
        </span>
      `).join('');

      const channelPills = Object.entries(cBreakdown).map(([ch, cnt]) => `
        <span style="display:inline-flex; align-items:center; gap:6px; padding:4px 9px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.25); border-radius:var(--radius-xs); font-size:11px;">
          <span style="text-transform:capitalize; color:#818cf8;">${ch}:</span>
          <strong style="color:var(--text-primary); font-family:var(--font-mono);">${cnt}</strong>
        </span>
      `).join('');

      distList.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:8px;">
          <div>
            <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; margin-bottom:4px;">By Channel</div>
            <div style="display:flex; flex-wrap:wrap; gap:6px;">${channelPills || '<span style="font-size:11px; color:var(--text-muted);">None</span>'}</div>
          </div>
          <div style="margin-top:4px;">
            <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; margin-bottom:4px;">By Order Status</div>
            <div style="display:flex; flex-wrap:wrap; gap:6px;">${statusPills || '<span style="font-size:11px; color:var(--text-muted);">None</span>'}</div>
          </div>
        </div>
      `;
    }

    // 4. Orders Ledger Table
    if (tbody) {
      const orders = data.orders || [];
      if (orders.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="9" style="text-align:center; padding:32px; color:var(--text-muted);">
              No customer orders found in the selected timeframe.
            </td>
          </tr>
        `;
      } else {
        tbody.innerHTML = orders.map(ord => {
          const formattedDate = ord.date ? new Date(ord.date).toLocaleDateString('en-IN', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
          }) : '-';
          const badgeClass = `order-badge order-badge-${(ord.status || 'pending').toLowerCase()}`;
          return `
            <tr>
              <td style="font-family:var(--font-mono); font-weight:700; color:var(--text-primary);">${escapeHtml(ord.order_number)}</td>
              <td>
                <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(ord.customer_name)}</div>
                <div style="font-size:10px; color:var(--text-muted); font-family:var(--font-mono);">${escapeHtml(ord.customer_phone)}</div>
              </td>
              <td style="font-size:11px; color:var(--text-secondary); white-space:nowrap;">${formattedDate}</td>
              <td style="max-width:240px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(ord.items_desc)}">
                ${escapeHtml(ord.items_desc)}
              </td>
              <td style="font-family:var(--font-mono); text-align:center;">${ord.item_count}</td>
              <td style="font-family:var(--font-mono); font-weight:700; color:var(--text-primary);">₹${ord.total_amount.toLocaleString('en-IN')}</td>
              <td>
                <span style="font-size:11px; text-transform:capitalize; font-weight:600; color:${ord.payment_status === 'paid' ? 'var(--status-emerald)' : 'var(--status-amber)'};">
                  ${ord.payment_status}
                </span>
              </td>
              <td>
                <span style="font-size:11px; text-transform:uppercase; font-family:var(--font-mono); color:var(--text-secondary);">
                  ${ord.channel}
                </span>
              </td>
              <td>
                <span class="${badgeClass}">${ord.status}</span>
              </td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align:center; padding:32px; color:var(--status-rose);">
            Error loading sales analytics: ${err.message}
          </td>
        </tr>
      `;
    }
  }
}


