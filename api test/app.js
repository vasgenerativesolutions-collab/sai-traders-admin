/**
 * Sai Traders — Storefront API Interactive Simulator
 * Connects to live backend at http://localhost:3000/api/v1/store/*
 */

const state = {
  apiBaseUrl: localStorage.getItem('sai_api_url') || 'http://localhost:3000',
  apiKey: localStorage.getItem('sai_api_key') || 'sai_store_live_sec_892176',
  products: [],
  selectedVariants: {}, // { [productSku]: variantObj }
  activeModalItem: null
};

// DOM Elements
const productGrid = document.getElementById('productGrid');
const searchInput = document.getElementById('searchInput');
const inStockOnlyCheckbox = document.getElementById('inStockOnly');
const refreshBtn = document.getElementById('refreshBtn');
const inspectorBody = document.getElementById('inspectorBody');
const godownPill = document.getElementById('godownPill');
const apiStatusPill = document.getElementById('apiStatusPill');

// Modal Elements
const purchaseModal = document.getElementById('purchaseModal');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const cancelOrderBtn = document.getElementById('cancelOrderBtn');
const confirmOrderBtn = document.getElementById('confirmOrderBtn');
const modalItemName = document.getElementById('modalItemName');
const modalItemSku = document.getElementById('modalItemSku');
const modalItemPrice = document.getElementById('modalItemPrice');
const syncStepDb = document.getElementById('syncStepDb');
const syncStepTally = document.getElementById('syncStepTally');
const syncStepSheets = document.getElementById('syncStepSheets');

// Config Prompt Button
const configBtn = document.getElementById('configBtn');
if (configBtn) {
  configBtn.addEventListener('click', () => {
    const newUrl = prompt('Enter Backend Base URL:', state.apiBaseUrl);
    if (newUrl) state.apiBaseUrl = newUrl.trim().replace(/\/$/, '');
    const newKey = prompt('Enter Storefront API Key (x-api-key):', state.apiKey);
    if (newKey) state.apiKey = newKey.trim();
    localStorage.setItem('sai_api_url', state.apiBaseUrl);
    localStorage.setItem('sai_api_key', state.apiKey);
    loadCatalog();
  });
}

// -----------------------------------------------------------------------------
// 1. HTTP Inspector Logging
// -----------------------------------------------------------------------------
function logInspector({ method, url, status, duration, requestData, responseData, error }) {
  const isSuccess = status >= 200 && status < 300;
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const methodClass = method === 'GET' ? 'log-badge-get' : 'log-badge-post';
  const statusColor = isSuccess ? '#34d399' : '#f43f5e';

  entry.innerHTML = `
    <div class="log-header">
      <span>
        <strong class="${methodClass}">${method}</strong> 
        <span style="color: #9ca3af; margin-left: 6px;">${url.replace(state.apiBaseUrl, '')}</span>
      </span>
      <span>
        <span style="color: ${statusColor}; font-weight: 700;">${status || 'ERR'}</span>
        <span style="color: #6b7280; margin-left: 6px;">${duration}ms</span>
      </span>
    </div>
    <div class="log-content">${JSON.stringify({
      request: requestData || null,
      response: responseData || error || null
    }, null, 2)}</div>
  `;

  inspectorBody.prepend(entry);

  // Update Telemetry Tracker Node Status
  if (responseData?.stock_updates) {
    document.getElementById('trackDb').className = 'tracker-val success';
    document.getElementById('trackDb').textContent = '✅ Updated';
  }
  if (responseData?.tally_synced !== undefined) {
    const el = document.getElementById('trackTally');
    el.className = responseData.tally_synced ? 'tracker-val success' : 'tracker-val error';
    el.textContent = responseData.tally_synced ? '✅ Synced (Sarees)' : '⚠️ Check ERP';
  }
  if (responseData?.sheets_synced !== undefined) {
    const el = document.getElementById('trackSheets');
    el.className = responseData.sheets_synced ? 'tracker-val success' : 'tracker-val error';
    el.textContent = responseData.sheets_synced ? '✅ Logged' : '⚠️ Offline';
  }
}

// -----------------------------------------------------------------------------
// 2. Fetch Catalog (GET /api/v1/store/products)
// -----------------------------------------------------------------------------
async function loadCatalog() {
  productGrid.innerHTML = `
    <div style="grid-column: 1 / -1; text-align: center; padding: 4rem 1rem; color: #9ca3af;">
      <div style="font-size: 1.5rem; margin-bottom: 0.5rem;">⏳</div>
      <div>Connecting to Sai Traders Inventory API...</div>
    </div>
  `;

  const inStockOnly = inStockOnlyCheckbox.checked;
  const searchVal = searchInput.value.trim();

  let queryUrl = `${state.apiBaseUrl}/api/v1/store/products?`;
  if (inStockOnly) queryUrl += 'in_stock_only=true&';
  if (searchVal) queryUrl += `search=${encodeURIComponent(searchVal)}&`;

  const startTime = performance.now();
  try {
    const res = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        'x-api-key': state.apiKey
      }
    });

    const duration = Math.round(performance.now() - startTime);
    const data = await res.json();

    logInspector({
      method: 'GET',
      url: queryUrl,
      status: res.status,
      duration,
      responseData: data
    });

    if (res.ok && data.success) {
      state.products = data.products || [];
      if (godownPill && data.target_godown) {
        godownPill.textContent = `Godown: ${data.target_godown}`;
      }
      apiStatusPill.className = 'status-pill online';
      apiStatusPill.innerHTML = '<span class="pulse-dot"></span> API Online (200 OK)';

      // Auto-initialize selected variants
      state.products.forEach(p => {
        if (p.is_group && p.variants && p.variants.length > 0 && !state.selectedVariants[p.sku]) {
          state.selectedVariants[p.sku] = p.variants[0];
        }
      });

      renderProducts(state.products);
    } else {
      throw new Error(data.error || 'Failed to fetch catalog');
    }
  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    logInspector({
      method: 'GET',
      url: queryUrl,
      status: 500,
      duration,
      error: err.message
    });
    apiStatusPill.className = 'status-pill';
    apiStatusPill.innerHTML = '⚠️ API Disconnected';
    productGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1rem; color: #f43f5e;">
        <div style="font-size: 1.75rem; margin-bottom: 0.5rem;">❌</div>
        <div style="font-weight: 700;">Could not connect to Storefront API</div>
        <div style="font-size: 0.85rem; color: #9ca3af; margin-top: 0.25rem;">${err.message}</div>
        <button onclick="loadCatalog()" class="btn-icon" style="margin-top: 1rem;">Retry Connection</button>
      </div>
    `;
  }
}

// -----------------------------------------------------------------------------
// 3. Render Product Cards Grid
// -----------------------------------------------------------------------------
function renderProducts(items) {
  if (items.length === 0) {
    productGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 4rem 1rem; color: #9ca3af;">
        <div style="font-size: 1.5rem; margin-bottom: 0.5rem;">🔍</div>
        <div>No sarees found matching your filter criteria.</div>
      </div>
    `;
    return;
  }

  productGrid.innerHTML = items.map(product => {
    const selectedVar = state.selectedVariants[product.sku];
    const currentSku = selectedVar ? selectedVar.sku : product.sku;
    const currentStock = selectedVar ? selectedVar.stock : product.stock;
    const currentPrice = selectedVar ? selectedVar.price : product.price;
    const currentMrp = selectedVar ? selectedVar.mrp : product.mrp;
    const isAvailable = currentStock > 0;

    // First image or variant image fallback
    const imgUrl = (selectedVar?.image_urls?.[0]) || (product.image_urls?.[0]) || '';
    const imgHtml = imgUrl 
      ? `<img src="${imgUrl}" alt="${product.name}" class="product-image" onerror="this.src='https://images.unsplash.com/photo-1610030469983-98e550d6193c?auto=format&fit=crop&w=600&q=80'" />`
      : `<div style="height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #1e293b; color: #64748b;">
           <span style="font-size: 2.5rem;">🥻</span>
           <span style="font-size: 0.75rem; margin-top: 0.4rem;">Photo coming soon</span>
         </div>`;

    // Swatches HTML
    let swatchesHtml = '';
    if (product.is_group && product.variants && product.variants.length > 0) {
      swatchesHtml = `
        <div class="variant-swatch-box">
          <div class="swatch-header">
            <span>Color Variants (${product.variants.length})</span>
            <span>Total Stock: <strong>${product.stock}</strong></span>
          </div>
          <div class="swatch-list">
            ${product.variants.map(v => {
              const isActive = (selectedVar?.sku === v.sku);
              const dotClass = v.stock > 0 ? 'swatch-stock-dot' : 'swatch-stock-dot zero';
              return `
                <button 
                  type="button" 
                  class="swatch-chip ${isActive ? 'active' : ''}" 
                  onclick="selectProductVariant('${product.sku}', '${v.sku}')"
                >
                  <span class="${dotClass}"></span>
                  ${v.color} (${v.stock})
                </button>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    return `
      <div class="product-card" id="card-${product.sku}">
        <div class="product-image-container">
          ${imgHtml}
          <span class="badge-float ${isAvailable ? 'badge-in-stock' : 'badge-out-of-stock'}">
            ${isAvailable ? `${currentStock} in stock` : 'Out of Stock'}
          </span>
          ${product.is_group ? `<span class="badge-group">Color Family</span>` : ''}
        </div>

        <div class="product-content">
          <div class="product-meta">${product.fabric || 'Pure Silk'} • ${product.weave || 'Handloom'}</div>
          <h3 class="product-title">${product.name}</h3>
          <div class="product-sku">SKU: ${currentSku}</div>

          ${swatchesHtml}

          <div class="product-footer">
            <div class="price-display">
              <span class="current-price">₹${Number(currentPrice).toLocaleString('en-IN')}</span>
              ${currentMrp > currentPrice ? `<span class="mrp-strikethrough">₹${Number(currentMrp).toLocaleString('en-IN')}</span>` : ''}
            </div>
            <button 
              class="btn-buy" 
              ${!isAvailable ? 'disabled' : ''} 
              onclick="triggerBuyModal('${product.sku}')"
            >
              ${isAvailable ? 'Simulate Buy →' : 'Sold Out'}
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// -----------------------------------------------------------------------------
// 4. Variant Selection Handling
// -----------------------------------------------------------------------------
window.selectProductVariant = function(productSku, variantSku) {
  const product = state.products.find(p => p.sku === productSku);
  if (!product || !product.variants) return;

  const variant = product.variants.find(v => v.sku === variantSku);
  if (!variant) return;

  state.selectedVariants[productSku] = variant;
  renderProducts(state.products);
};

// -----------------------------------------------------------------------------
// 5. Simulated Purchase Checkout Modal Flow
// -----------------------------------------------------------------------------
window.triggerBuyModal = function(productSku) {
  const product = state.products.find(p => p.sku === productSku);
  if (!product) return;

  const chosenVar = state.selectedVariants[productSku];
  const activeSku = chosenVar ? chosenVar.sku : product.sku;
  const activeName = chosenVar ? chosenVar.name : product.name;
  const activePrice = chosenVar ? chosenVar.price : product.price;

  state.activeModalItem = {
    product,
    variant: chosenVar,
    sku: activeSku,
    name: activeName,
    price: activePrice
  };

  modalItemName.textContent = activeName;
  modalItemSku.textContent = `SKU: ${activeSku}`;
  modalItemPrice.textContent = `₹${Number(activePrice).toLocaleString('en-IN')}`;

  document.getElementById('orderIdInput').value = `ANG-SIM-${Math.floor(1000 + Math.random() * 9000)}`;

  // Reset steps
  resetSyncSteps();

  confirmOrderBtn.disabled = false;
  confirmOrderBtn.textContent = 'Confirm & Send Webhook';
  purchaseModal.classList.add('open');
};

function resetSyncSteps() {
  syncStepDb.className = 'sync-step';
  syncStepDb.innerHTML = `<span>⏳</span> 1. Deduct Stock in Database & Stock Pool`;

  syncStepTally.className = 'sync-step';
  syncStepTally.innerHTML = `<span>⏳</span> 2. Post Sales Voucher in Tally ERP (Sarees Godown)`;

  syncStepSheets.className = 'sync-step';
  syncStepSheets.innerHTML = `<span>⏳</span> 3. Append Transaction to Google Spreadsheet`;
}

function closeModal() {
  purchaseModal.classList.remove('open');
  state.activeModalItem = null;
}

modalCloseBtn.addEventListener('click', closeModal);
cancelOrderBtn.addEventListener('click', closeModal);

// -----------------------------------------------------------------------------
// 6. Submit Purchase Order (POST /api/v1/store/orders)
// -----------------------------------------------------------------------------
confirmOrderBtn.addEventListener('click', async () => {
  if (!state.activeModalItem) return;

  const orderId = document.getElementById('orderIdInput').value.trim();
  const custName = document.getElementById('custNameInput').value.trim() || 'Online Shopper';
  const custPhone = document.getElementById('custPhoneInput').value.trim() || '+919876543210';
  const custAddress = document.getElementById('custAddressInput').value.trim() || 'Bengaluru, Karnataka';

  const orderPayload = {
    order_id: orderId,
    customer: {
      name: custName,
      phone: custPhone,
      email: 'customer@saitraders.in',
      address: custAddress
    },
    items: [
      {
        sku: state.activeModalItem.sku,
        name: state.activeModalItem.name,
        quantity: 1,
        price: state.activeModalItem.price
      }
    ],
    total_amount: state.activeModalItem.price,
    payment_status: 'paid',
    payment_method: 'Online UPI / Razorpay',
    notes: 'Simulated from Angular Storefront Test Suite'
  };

  confirmOrderBtn.disabled = true;
  confirmOrderBtn.textContent = 'Processing Webhook...';

  // Animate steps
  syncStepDb.className = 'sync-step active';
  syncStepDb.innerHTML = `<span>🔄</span> 1. Deducting Database Inventory...`;

  const startTime = performance.now();
  const url = `${state.apiBaseUrl}/api/v1/store/orders`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': state.apiKey
      },
      body: JSON.stringify(orderPayload)
    });

    const duration = Math.round(performance.now() - startTime);
    const data = await res.json();

    logInspector({
      method: 'POST',
      url,
      status: res.status,
      duration,
      requestData: orderPayload,
      responseData: data
    });

    if (res.ok && data.success) {
      // Step 1 Complete
      syncStepDb.className = 'sync-step complete';
      syncStepDb.innerHTML = `<span>✅</span> 1. Stock Deducted for [${state.activeModalItem.sku}]`;

      // Step 2 Tally Complete
      if (data.tally_synced) {
        syncStepTally.className = 'sync-step complete';
        syncStepTally.innerHTML = `<span>✅</span> 2. Tally ERP Sales Voucher Created (${data.target_godown} Godown)`;
      } else {
        syncStepTally.className = 'sync-step active';
        syncStepTally.innerHTML = `<span>⚠️</span> 2. Tally Voucher queued/check connectivity`;
      }

      // Step 3 Sheets Complete
      if (data.sheets_synced) {
        syncStepSheets.className = 'sync-step complete';
        syncStepSheets.innerHTML = `<span>✅</span> 3. Google Spreadsheet Appended`;
      } else {
        syncStepSheets.className = 'sync-step active';
        syncStepSheets.innerHTML = `<span>⚠️</span> 3. Google Sheets script offline`;
      }

      confirmOrderBtn.textContent = 'Order Placed Successfully!';

      // Auto-reload catalog to show decremented stock
      setTimeout(() => {
        closeModal();
        loadCatalog();
      }, 1800);
    } else {
      throw new Error(data.error || 'Order placement failed');
    }
  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    logInspector({
      method: 'POST',
      url,
      status: 500,
      duration,
      requestData: orderPayload,
      error: err.message
    });

    syncStepDb.className = 'sync-step';
    syncStepDb.style.color = '#f43f5e';
    syncStepDb.innerHTML = `<span>❌</span> Error: ${err.message}`;
    confirmOrderBtn.disabled = false;
    confirmOrderBtn.textContent = 'Retry Webhook';
  }
});

// -----------------------------------------------------------------------------
// 7. Quick One-Click API Tests
// -----------------------------------------------------------------------------
window.testUnauthorized = async function() {
  const url = `${state.apiBaseUrl}/api/v1/store/products`;
  const startTime = performance.now();
  try {
    const res = await fetch(url); // No x-api-key header
    const duration = Math.round(performance.now() - startTime);
    const data = await res.json();
    logInspector({ method: 'GET', url, status: res.status, duration, responseData: data });
  } catch (err) {
    logInspector({ method: 'GET', url, status: 500, duration: 10, error: err.message });
  }
};

window.testSingleSku = async function(sku) {
  const url = `${state.apiBaseUrl}/api/v1/store/products/${encodeURIComponent(sku)}`;
  const startTime = performance.now();
  try {
    const res = await fetch(url, { headers: { 'x-api-key': state.apiKey } });
    const duration = Math.round(performance.now() - startTime);
    const data = await res.json();
    logInspector({ method: 'GET', url, status: res.status, duration, responseData: data });
  } catch (err) {
    logInspector({ method: 'GET', url, status: 500, duration: 10, error: err.message });
  }
};

window.clearInspector = function() {
  inspectorBody.innerHTML = '';
};

// -----------------------------------------------------------------------------
// 8. Event Listeners & Boot
// -----------------------------------------------------------------------------
searchInput.addEventListener('input', () => {
  clearTimeout(searchInput._timer);
  searchInput._timer = setTimeout(loadCatalog, 300);
});

inStockOnlyCheckbox.addEventListener('change', loadCatalog);
refreshBtn.addEventListener('click', loadCatalog);

// Boot
loadCatalog();
