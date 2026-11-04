const fs = require('fs');
const path = require('path');

// Read the high quality transparent logo
const logoPath = 'c:/sai_traders/assets/kalpacodes_logo_transparent.png';
const logoBuf = fs.readFileSync(logoPath);
const logoBase64 = `data:image/png;base64,${logoBuf.toString('base64')}`;

console.log('Logo read, base64 length:', logoBase64.length);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Quotation QT-001 — KalpaCodes × Shree Sai Traders</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      --primary: #00458b;
      --primary-dark: #003366;
      --primary-light: #0284c7;
      --cyan: #06b6d4;
      --table-stripe: #f2f7fc;
      --table-border: #dbeafe;
      --text-main: #1e293b;
      --text-muted: #64748b;
      --bg-page: #ffffff;
      --bg-body: #e2e8f0;
      --accent-badge: #e0f2fe;
    }

    body {
      font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, sans-serif;
      color: var(--text-main);
      background: var(--bg-body);
      font-size: 11.5px;
      line-height: 1.45;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ─── A4 PAGE CONTAINER ─── */
    .page {
      width: 210mm;
      height: 297mm;
      max-height: 297mm;
      margin: 20px auto;
      background: #ffffff;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 32px 40px 24px;
    }

    @media print {
      body {
        background: #ffffff;
      }
      .page {
        margin: 0 !important;
        box-shadow: none !important;
        page-break-after: always;
        break-after: page;
        height: 297mm !important;
        max-height: 297mm !important;
        overflow: hidden !important;
        padding: 28px 36px 20px !important;
      }
      .no-print {
        display: none !important;
      }
    }

    /* ─── FLOATING ACTION BAR ─── */
    .action-bar {
      position: fixed;
      top: 16px;
      right: 24px;
      z-index: 9999;
      display: flex;
      gap: 12px;
    }

    .btn-action {
      background: var(--primary);
      color: #ffffff;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 4px 14px rgba(0, 69, 139, 0.35);
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
    }

    .btn-action:hover {
      background: var(--primary-dark);
      transform: translateY(-1px);
    }

    /* ─── HEADER ─── */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 12px;
    }

    .brand-col {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .brand-logo-img {
      height: 64px;
      width: auto;
      object-fit: contain;
      display: block;
      margin-bottom: 2px;
    }

    .brand-tagline {
      font-size: 10px;
      color: var(--text-muted);
      font-weight: 500;
      letter-spacing: 0.3px;
    }

    .header-doc-col {
      text-align: right;
    }

    .doc-type-title {
      font-size: 36px;
      font-weight: 800;
      letter-spacing: 4px;
      color: var(--primary);
      text-transform: uppercase;
      line-height: 1;
      margin-bottom: 6px;
    }

    .doc-type-sub {
      font-size: 11px;
      font-weight: 700;
      color: var(--primary-light);
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .doc-meta-badge {
      display: inline-block;
      margin-top: 6px;
      background: var(--accent-badge);
      color: var(--primary);
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }

    /* ─── DECORATIVE ACCENT BAR ─── */
    .accent-bar {
      height: 4px;
      background: linear-gradient(90deg, var(--primary) 0%, var(--primary-light) 40%, var(--cyan) 75%, #e2e8f0 75%, #e2e8f0 100%);
      border-radius: 2px;
      margin-bottom: 16px;
    }

    /* ─── META / CLIENT INFORMATION ─── */
    .meta-grid {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 20px;
      background: #f8fafc;
      border: 1px solid var(--table-border);
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 16px;
    }

    .meta-box-label {
      font-size: 9.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: var(--primary-light);
      margin-bottom: 4px;
    }

    .meta-box-name {
      font-size: 13.5px;
      font-weight: 800;
      color: var(--text-main);
      margin-bottom: 3px;
    }

    .meta-box-text {
      font-size: 10.5px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .meta-details-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
      justify-content: center;
    }

    .meta-detail-item {
      display: flex;
      justify-content: space-between;
      font-size: 10.5px;
      padding: 2px 0;
      border-bottom: 1px dashed #e2e8f0;
    }

    .meta-detail-item:last-child {
      border-bottom: none;
    }

    .meta-detail-key {
      color: var(--text-muted);
      font-weight: 500;
    }

    .meta-detail-val {
      color: var(--text-main);
      font-weight: 700;
    }

    /* ─── SECTION TITLE ─── */
    .section-title {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 12px 0 8px;
      font-size: 11.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--primary-dark);
    }

    .section-title-icon {
      width: 18px;
      height: 18px;
      background: var(--primary);
      color: #ffffff;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 800;
    }

    /* ─── MODERN TABLES ─── */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 10px;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--table-border);
      margin-bottom: 10px;
    }

    .data-table thead th {
      background: var(--primary);
      color: #ffffff;
      padding: 7px 10px;
      font-weight: 700;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      font-size: 9.5px;
      text-align: left;
      border: none;
    }

    .data-table tbody td {
      padding: 6.5px 10px;
      border-bottom: 1px solid var(--table-border);
      vertical-align: middle;
      color: var(--text-main);
      line-height: 1.35;
    }

    .data-table tbody tr:nth-child(even) {
      background: var(--table-stripe);
    }

    .data-table tbody tr:last-child td {
      border-bottom: none;
    }

    .col-idx {
      width: 26px;
      text-align: center !important;
      font-weight: 700;
      color: var(--primary);
    }

    .col-title {
      font-weight: 700;
      color: var(--primary-dark);
      white-space: nowrap;
    }

    .col-desc {
      color: #334155;
    }

    /* ─── PAGE 2: TOTALS AREA ─── */
    .totals-wrapper {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 18px;
      margin-top: 12px;
      align-items: start;
    }

    .callout-box {
      background: #f8fafc;
      border: 1px solid var(--table-border);
      border-left: 4px solid var(--primary);
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 10px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .callout-box strong {
      color: var(--text-main);
    }

    .totals-card {
      border: 1px solid var(--table-border);
      border-radius: 6px;
      overflow: hidden;
      background: #ffffff;
    }

    .totals-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 12px;
      font-size: 10.5px;
      border-bottom: 1px solid #f1f5f9;
    }

    .totals-row.grand-total {
      background: var(--primary);
      color: #ffffff;
      padding: 10px 12px;
      font-size: 12px;
      font-weight: 800;
      border-bottom: none;
      letter-spacing: 0.5px;
    }

    .totals-label {
      font-weight: 600;
      color: var(--text-muted);
    }

    .totals-row.grand-total .totals-label {
      color: #e0f2fe;
    }

    .totals-val {
      font-weight: 700;
      color: var(--text-main);
    }

    .totals-row.grand-total .totals-val {
      color: #ffffff;
      font-size: 13px;
    }

    .notice-badge {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 9.5px;
      color: #92400e;
      line-height: 1.45;
      margin-top: 10px;
    }

    /* ─── PAGE 3: TERMS LIST & SIGNATURE ─── */
    .terms-block {
      background: #ffffff;
      border: 1px solid var(--table-border);
      border-radius: 6px;
      padding: 12px 14px;
      margin-bottom: 10px;
    }

    .terms-item-title {
      font-size: 10.5px;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .terms-item-title::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--primary-light);
    }

    .terms-item-body {
      font-size: 10px;
      color: #334155;
      line-height: 1.45;
      padding-left: 12px;
    }

    .terms-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 12px;
    }

    .thankyou-banner {
      text-align: center;
      padding: 10px;
      background: #f0f7ff;
      border-radius: 6px;
      border: 1px dashed var(--primary-light);
      margin: 12px 0 16px;
    }

    .thankyou-title {
      font-size: 13px;
      font-weight: 800;
      color: var(--primary);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .thankyou-sub {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .signatures-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 40px;
      margin-top: 10px;
      padding: 0 10px;
    }

    .sig-box {
      border-top: 1.5px solid var(--primary);
      padding-top: 8px;
      text-align: center;
    }

    .sig-role {
      font-size: 10.5px;
      font-weight: 800;
      color: var(--primary-dark);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .sig-name {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    /* ─── FOOTER ─── */
    .page-footer {
      margin-top: auto;
      padding-top: 10px;
      border-top: 1px solid #e2e8f0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 9.5px;
      color: var(--text-muted);
    }

    .footer-contacts {
      display: flex;
      gap: 16px;
    }

    .footer-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .footer-dot {
      color: var(--primary-light);
      font-size: 12px;
    }

    .page-number-pill {
      background: var(--accent-badge);
      color: var(--primary);
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 9px;
    }
  </style>
</head>
<body>

  <!-- Floating Print Button -->
  <div class="action-bar no-print">
    <button class="btn-action" onclick="window.print()">
      <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4H7v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"></path></svg>
      Print / Save as PDF
    </button>
  </div>

  <!-- ══════════════════════════════════════════════════════════
       PAGE 1: SCOPE OF WORK & FEATURE SPECIFICATION
       ══════════════════════════════════════════════════════════ -->
  <div class="page">
    <!-- Header -->
    <div class="header">
      <div class="brand-col">
        <img src="${logoBase64}" alt="KalpaCodes — Websites • Apps • Software" class="brand-logo-img" />
        <div class="brand-tagline">Near J S S S Depo, Upparahalli, Tumkur - 572102 · Karnataka</div>
      </div>
      <div class="header-doc-col">
        <div class="doc-type-title">Quotation</div>
        <div class="doc-type-sub">Commercial Proposal</div>
        <div class="doc-meta-badge">REF: QT-001</div>
      </div>
    </div>

    <!-- Decorative Bar -->
    <div class="accent-bar"></div>

    <!-- Meta Details Block -->
    <div class="meta-grid">
      <div>
        <div class="meta-box-label">Quotation Prepared For</div>
        <div class="meta-box-name">Shree Sai Traders</div>
        <div class="meta-box-text">
          SS Puram Main Rd, Opp. Shivdev Petrol Bunk,<br/>
          Coffee Board Colony, S.S.Puram, Tumakuru, Karnataka - 572102
        </div>
      </div>
      <div class="meta-details-list">
        <div class="meta-detail-item">
          <span class="meta-detail-key">Quotation Date:</span>
          <span class="meta-detail-val">29 September 2026</span>
        </div>
        <div class="meta-detail-item">
          <span class="meta-detail-key">Validity:</span>
          <span class="meta-detail-val">30 Days (Until 29-10-2026)</span>
        </div>
        <div class="meta-detail-item">
          <span class="meta-detail-key">Project Scope:</span>
          <span class="meta-detail-val" style="color:var(--primary);">WhatsApp AI Saree Bot</span>
        </div>
      </div>
    </div>

    <!-- Section A -->
    <div class="section-title">
      <span class="section-title-icon">A</span>
      <span>WhatsApp AI Automation — 12 Features</span>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th class="col-idx">#</th>
          <th style="width: 175px;">Feature</th>
          <th>Description & Deliverables</th>
        </tr>
      </thead>
      <tbody>
        <tr><td class="col-idx">1</td><td class="col-title">AI Visual Saree Search</td><td class="col-desc">Customers send any saree photo → AI extracts fabric, weave, color, pattern, border, pallu & price.</td></tr>
        <tr><td class="col-idx">2</td><td class="col-title">Smart Catalog Matching</td><td class="col-desc">768-dimensional vector similarity search instantly matches photo against inventory catalog.</td></tr>
        <tr><td class="col-idx">3</td><td class="col-title">Interactive Product Cards</td><td class="col-desc">Rich WhatsApp cards with photo, price, MRP, availability & tap-to-order interactive buttons.</td></tr>
        <tr><td class="col-idx">4</td><td class="col-title">Natural Language Search</td><td class="col-desc">Smart conversational search: <em>"show red silk sarees below ₹8,000"</em> returns instant tailored results.</td></tr>
        <tr><td class="col-idx">5</td><td class="col-title">Conversational Ordering</td><td class="col-desc">End-to-end checkout on WhatsApp: select saree → address input → generate SAI-XXXX order.</td></tr>
        <tr><td class="col-idx">6</td><td class="col-title">Real-Time Order Tracking</td><td class="col-desc">Customers check order status instantly anytime by typing <em>"Track SAI-1001"</em>.</td></tr>
        <tr><td class="col-idx">7</td><td class="col-title">Smart Intent Detection</td><td class="col-desc">AI categorizes greetings, product inquiries, address updates, complaints, and live escalations.</td></tr>
        <tr><td class="col-idx">8</td><td class="col-title">Automated Welcome Experience</td><td class="col-desc">Personalized Namaste greeting with quick-reply buttons for immediate engagement.</td></tr>
        <tr><td class="col-idx">9</td><td class="col-title">Read Receipts & Deduping</td><td class="col-desc">Automated WhatsApp blue-tick handling + webhook deduplication prevents repeated processing.</td></tr>
        <tr><td class="col-idx">10</td><td class="col-title">Customer Profile Store</td><td class="col-desc">Auto-stores phone number, name, shipping address, past orders, and interaction timeline.</td></tr>
        <tr><td class="col-idx">11</td><td class="col-title">Stateful Conversation Engine</td><td class="col-desc">Multi-step conversation state machine (browsing → analyzing → selecting → ordering → confirmed).</td></tr>
        <tr><td class="col-idx">12</td><td class="col-title">Direct Agent Handoff</td><td class="col-desc">Option for customers to request human escalation for high-value custom saree orders.</td></tr>
      </tbody>
    </table>

    <!-- Section B -->
    <div class="section-title">
      <span class="section-title-icon">B</span>
      <span>Tally ERP Integration & Admin Dashboard</span>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th class="col-idx">#</th>
          <th style="width: 175px;">Module / Feature</th>
          <th>Description & Deliverables</th>
        </tr>
      </thead>
      <tbody>
        <tr><td class="col-idx">1</td><td class="col-title">Tally Sales Voucher Sync</td><td class="col-desc">WhatsApp orders auto-created as Tally Sales Vouchers with item, rate, and customer details.</td></tr>
        <tr><td class="col-idx">2</td><td class="col-title">Stock & Inventory Sync</td><td class="col-desc">Bi-directional inventory sync between Tally Prime stock items and WhatsApp bot catalog.</td></tr>
        <tr><td class="col-idx">3</td><td class="col-title">Customer Ledger Mapping</td><td class="col-desc">WhatsApp buyers auto-synced to Tally Sundry Debtors ledger with GST compliant formatting.</td></tr>
        <tr><td class="col-idx">4</td><td class="col-title">Admin Catalog Manager</td><td class="col-desc">Web dashboard to upload, edit, price sarees, attach photos, and trigger AI vector embeddings.</td></tr>
        <tr><td class="col-idx">5</td><td class="col-title">Order Management & Analytics</td><td class="col-desc">Track all orders (Pending → Confirmed → Shipped → Delivered) + revenue & query analytics.</td></tr>
      </tbody>
    </table>

    <!-- Footer -->
    <div class="page-footer">
      <div class="footer-contacts">
        <span class="footer-item"><span class="footer-dot">●</span> <strong>KalpaCodes</strong></span>
        <span class="footer-item"><span class="footer-dot">●</span> Near J S S S Depo, Upparahalli, Tumkur - 572102</span>
        <span class="footer-item"><span class="footer-dot">●</span> Websites · Apps · Software</span>
      </div>
      <div class="page-number-pill">Page 1 of 3</div>
    </div>
  </div>

  <!-- ══════════════════════════════════════════════════════════
       PAGE 2: PRICING & COMMERCIAL TERMS
       ══════════════════════════════════════════════════════════ -->
  <div class="page">
    <!-- Header -->
    <div class="header">
      <div class="brand-col">
        <img src="${logoBase64}" alt="KalpaCodes" class="brand-logo-img" style="height: 52px;" />
        <div class="brand-tagline">Websites · Apps · Software Solutions</div>
      </div>
      <div class="header-doc-col">
        <div class="doc-type-title" style="font-size: 28px;">Pricing</div>
        <div class="doc-type-sub">Commercials & API Rates</div>
        <div class="doc-meta-badge">QT-001 · SHREE SAI TRADERS</div>
      </div>
    </div>

    <div class="accent-bar"></div>

    <!-- KalpaCodes Core Charges -->
    <div class="section-title">
      <span class="section-title-icon">1</span>
      <span>KalpaCodes Professional Service Charges</span>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th class="col-idx">#</th>
          <th>Service Description</th>
          <th style="width: 70px; text-align: center;">Billing</th>
          <th style="width: 85px; text-align: right;">Rate</th>
          <th style="width: 95px; text-align: right;">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="col-idx">1</td>
          <td>
            <div class="col-title">One-Time Setup, Development & Go-Live</div>
            <div class="col-desc">Complete bot architecture, Gemini Vision AI prompt engineering, pgvector DB setup, Tally ERP connector, Admin web dashboard, WhatsApp Meta Cloud API configuration & testing.</div>
          </td>
          <td style="text-align: center; font-weight: 600;">One-Time</td>
          <td style="text-align: right;">₹10,000</td>
          <td style="text-align: right; font-weight: 700; color: var(--primary);">₹10,000</td>
        </tr>
        <tr>
          <td class="col-idx">2</td>
          <td>
            <div class="col-title">Monthly Hosting, Maintenance & Tech Support</div>
            <div class="col-desc">Edge functions hosting, pgvector database maintenance, uptime monitoring, bug fixes, WhatsApp API version updates, backup management, and up to 2 hours of monthly support.</div>
          </td>
          <td style="text-align: center; font-weight: 600;">Monthly</td>
          <td style="text-align: right;">₹5,000 / mo</td>
          <td style="text-align: right; font-weight: 700; color: var(--primary);">₹5,000 / mo</td>
        </tr>
        <tr>
          <td class="col-idx">3</td>
          <td>
            <div class="col-title">Active User Overage (Beyond 1,000 Users / Month)</div>
            <div class="col-desc">Includes 1,000 monthly unique active WhatsApp users in base fee. Additional users charged at nominal pay-as-you-grow rate. ("User" = phone number with ≥1 incoming message/mo).</div>
          </td>
          <td style="text-align: center; font-weight: 600;">Per User</td>
          <td style="text-align: right;">₹5 / user</td>
          <td style="text-align: right; font-weight: 700; color: var(--primary);">₹5 / addl user</td>
        </tr>
      </tbody>
    </table>

    <!-- Third-Party Cloud & API Costs -->
    <div class="section-title">
      <span class="section-title-icon">2</span>
      <span>Third-Party Cloud API Costs (Billed at Actuals · Zero Markup)</span>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th style="width: 140px;">Provider & Service</th>
          <th>Official Rate Structure</th>
          <th style="width: 130px;">Application in Saree Bot</th>
          <th style="width: 95px; text-align: right;">Est. Unit Cost</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="col-title">Google Gemini Flash</td>
          <td class="col-desc">₹0.025 / 1K input tokens · ₹0.21 / 1K output tokens</td>
          <td class="col-desc">Multimodal photo analysis & search intent</td>
          <td style="text-align: right; font-weight: 600;">~₹0.06 / photo</td>
        </tr>
        <tr>
          <td class="col-title">Gemini Text Embedding</td>
          <td class="col-desc">₹0.013 / 1 Million tokens (768-dim vector)</td>
          <td class="col-desc">Catalog indexing & visual vector matching</td>
          <td style="text-align: right; font-weight: 600;">~₹0.00 / query</td>
        </tr>
        <tr>
          <td class="col-title">Meta WhatsApp Service</td>
          <td class="col-desc">First 1,000 customer-initiated service msgs/mo FREE</td>
          <td class="col-desc">Customer shopping & queries</td>
          <td style="text-align: right; font-weight: 600;">FREE (first 1K)</td>
        </tr>
        <tr>
          <td class="col-title">Meta WhatsApp Utility</td>
          <td class="col-desc">₹0.1150 / msg (~₹0.14 incl. 18% GST)</td>
          <td class="col-desc">Order confirmations & delivery tracking</td>
          <td style="text-align: right; font-weight: 600;">~₹0.14 / msg</td>
        </tr>
        <tr>
          <td class="col-title">Meta WhatsApp Marketing</td>
          <td class="col-desc">₹0.8631 / msg (~₹1.02 incl. 18% GST)</td>
          <td class="col-desc">Festival offers & promotional broadcasts</td>
          <td style="text-align: right; font-weight: 600;">~₹1.02 / msg</td>
        </tr>
      </tbody>
    </table>

    <!-- Commercials Summary Card -->
    <div class="totals-wrapper">
      <div class="callout-box">
        <strong>Billing & Commercial Notes:</strong><br/>
        • Setup Fee is billed 100% upfront upon proposal acceptance.<br/>
        • Monthly Retainer (₹5,000) is invoiced on the 1st of each calendar month.<br/>
        • Google & Meta API charges are billed directly at actuals with transparent usage logs.<br/>
        • All KalpaCodes fees are exclusive of applicable GST (18%).
      </div>

      <div class="totals-card">
        <div class="totals-row">
          <span class="totals-label">Setup & Development:</span>
          <span class="totals-val">₹10,000 (One-Time)</span>
        </div>
        <div class="totals-row">
          <span class="totals-label">Base Monthly Retainer:</span>
          <span class="totals-val">₹5,000 / month</span>
        </div>
        <div class="totals-row">
          <span class="totals-label">Est. Gemini AI Usage:</span>
          <span class="totals-val">₹150 – ₹450 / mo</span>
        </div>
        <div class="totals-row">
          <span class="totals-label">Est. WhatsApp API:</span>
          <span class="totals-val">₹1,500 – ₹3,500 / mo</span>
        </div>
        <div class="totals-row grand-total">
          <span class="totals-label">Est. Monthly Total:</span>
          <span class="totals-val">₹6,650 – ₹9,000</span>
        </div>
      </div>
    </div>

    <!-- Notice strip -->
    <div class="notice-badge">
      <strong>Third-Party Price Adjustment Clause:</strong> Google Gemini and Meta WhatsApp rates reflect official vendor pricing as of September 2026. Vendor adjustments are passed through at actuals with 7 days written notice for increases and immediate pass-through for price reductions.
    </div>

    <!-- Footer -->
    <div class="page-footer">
      <div class="footer-contacts">
        <span class="footer-item"><span class="footer-dot">●</span> <strong>KalpaCodes</strong></span>
        <span class="footer-item"><span class="footer-dot">●</span> Near J S S S Depo, Upparahalli, Tumkur - 572102</span>
      </div>
      <div class="page-number-pill">Page 2 of 3</div>
    </div>
  </div>

  <!-- ══════════════════════════════════════════════════════════
       PAGE 3: TERMS OF SERVICE & FORMAL ACCEPTANCE
       ══════════════════════════════════════════════════════════ -->
  <div class="page">
    <!-- Header -->
    <div class="header">
      <div class="brand-col">
        <img src="${logoBase64}" alt="KalpaCodes" class="brand-logo-img" style="height: 52px;" />
        <div class="brand-tagline">Websites · Apps · Software Solutions</div>
      </div>
      <div class="header-doc-col">
        <div class="doc-type-title" style="font-size: 28px;">Terms</div>
        <div class="doc-type-sub">Terms of Service & Acceptance</div>
        <div class="doc-meta-badge">QT-001 · SHREE SAI TRADERS</div>
      </div>
    </div>

    <div class="accent-bar"></div>

    <!-- Terms 2-column grid -->
    <div class="terms-grid">
      <div class="terms-block">
        <div class="terms-item-title">1. Payment & Invoicing</div>
        <div class="terms-item-body">
          Setup fee payable 100% advance before kickoff. Monthly retainer invoiced in advance by 1st of month. Third-party API charges invoiced monthly in arrears based on verified vendor usage logs.
        </div>
      </div>
      <div class="terms-block">
        <div class="terms-item-title">2. API Rate Adjustments</div>
        <div class="terms-item-body">
          Google and Meta API prices are subject to their respective pricing policies. Any vendor revisions are passed through directly at actuals without markup. Decreases take effect immediately.
        </div>
      </div>
      <div class="terms-block">
        <div class="terms-item-title">3. Support & SLA Scope</div>
        <div class="terms-item-body">
          Includes edge function hosting, database maintenance, security patches, and 2 hrs monthly developer support. Support window: Mon–Sat, 10 AM – 7 PM IST. Critical incident response &lt; 4 hours.
        </div>
      </div>
      <div class="terms-block">
        <div class="terms-item-title">4. Active User Scaling</div>
        <div class="terms-item-body">
          Base package includes up to 1,000 unique monthly WhatsApp users. Active users beyond 1,000 are billed at ₹5 per additional user per month, reconciled on the monthly invoice.
        </div>
      </div>
      <div class="terms-block">
        <div class="terms-item-title">5. Data Privacy & Ownership</div>
        <div class="terms-item-body">
          All client catalogs, customer records, and order transaction data remain 100% the exclusive property of Shree Sai Traders. Data is securely partitioned with automated encrypted cloud backups.
        </div>
      </div>
      <div class="terms-block">
        <div class="terms-item-title">6. Contract & Termination</div>
        <div class="terms-item-body">
          Initial commitment of 3 months from project go-live date. Thereafter, either party may terminate with 30 days written notice. Full database export provided upon clearance of dues.
        </div>
      </div>
    </div>

    <!-- Thank you banner -->
    <div class="thankyou-banner">
      <div class="thankyou-title">Thank You For Your Business!</div>
      <div class="thankyou-sub">We look forward to building a long-term technology partnership to automate and scale Shree Sai Traders.</div>
    </div>

    <!-- Formal Acceptance & Signatures -->
    <div style="font-size: 10px; color: var(--text-muted); text-align: center; margin-bottom: 24px;">
      By signing below, the parties confirm acceptance of the scope, deliverables, commercials, and terms set forth in this Quotation (QT-001).
    </div>

    <div class="signatures-row">
      <div class="sig-box">
        <div class="sig-role">Accepted By: Shree Sai Traders</div>
        <div class="sig-name">Authorized Signatory / Proprietor</div>
        <div style="font-size: 9.5px; color: #94a3b8; margin-top: 20px;">Signature & Date</div>
      </div>
      <div class="sig-box">
        <div class="sig-role">Issued By: KalpaCodes</div>
        <div class="sig-name">Authorized Representative · Tumakuru</div>
        <div style="font-size: 9.5px; color: #94a3b8; margin-top: 20px;">Signature & Date</div>
      </div>
    </div>

    <!-- Footer -->
    <div class="page-footer" style="margin-top: auto;">
      <div class="footer-contacts">
        <span class="footer-item"><span class="footer-dot">●</span> <strong>KalpaCodes</strong></span>
        <span class="footer-item"><span class="footer-dot">●</span> Near J S S S Depo, Upparahalli, Tumkur - 572102</span>
        <span class="footer-item"><span class="footer-dot">●</span> Websites · Apps · Software</span>
      </div>
      <div class="page-number-pill">Page 3 of 3</div>
    </div>
  </div>

</body>
</html>
`;

fs.writeFileSync('c:/sai_traders/QUOTATION_QT001_KalpaCodes.html', html, 'utf8');
console.log('Successfully generated c:/sai_traders/QUOTATION_QT001_KalpaCodes.html with embedded base64 logo!');
