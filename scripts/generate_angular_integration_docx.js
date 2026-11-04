const fs = require('fs');
const path = require('path');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
  WidthType,
  AlignmentType,
  ShadingType,
  Footer,
  Header,
  PageNumber
} = require('docx');

const OUTPUT_PATH = path.join(__dirname, '..', 'word', 'sai-traders-angular-integration-guide.docx');

// Palette
const COLOR_PRIMARY = '0A192F';   // Deep Navy
const COLOR_SECONDARY = '1E293B'; // Dark Slate
const COLOR_ACCENT = 'D4AF37';    // Gold
const COLOR_MUTED = '64748B';     // Muted Gray
const COLOR_BORDER = 'CBD5E1';    // Light Border
const COLOR_BG_HEADER = '0F172A'; // Table Header Dark
const COLOR_BG_ZEBRA = 'F8FAFC';  // Alternate Row
const COLOR_CALLOUT_BG = 'F0FDF4';// Light Green Tint / Soft Blue
const COLOR_CALLOUT_BORDER = '0284C7'; // Blue border
const COLOR_CODE_BG = 'F1F5F9';   // Code block bg

// Helpers
function createTitle(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 240, after: 120 },
    children: [
      new TextRun({
        text,
        size: 38, // 19pt
        bold: true,
        color: COLOR_PRIMARY,
        font: 'Segoe UI'
      })
    ]
  });
}

function createSubtitle(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 360 },
    children: [
      new TextRun({
        text,
        size: 24, // 12pt
        italics: true,
        color: COLOR_MUTED,
        font: 'Segoe UI'
      })
    ]
  });
}

function createHeading1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 140 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 8, color: COLOR_ACCENT }
    },
    children: [
      new TextRun({
        text,
        size: 30, // 15pt
        bold: true,
        color: COLOR_PRIMARY,
        font: 'Segoe UI'
      })
    ]
  });
}

function createHeading2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 260, after: 100 },
    children: [
      new TextRun({
        text,
        size: 24, // 12pt
        bold: true,
        color: COLOR_SECONDARY,
        font: 'Segoe UI'
      })
    ]
  });
}

function createHeading3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 80 },
    children: [
      new TextRun({
        text,
        size: 22, // 11pt
        bold: true,
        color: COLOR_PRIMARY,
        font: 'Segoe UI'
      })
    ]
  });
}

function createParagraph(text, options = {}) {
  const { bold = false, italics = false, color = '1E293B', spaceAfter = 120 } = options;
  return new Paragraph({
    spacing: { after: spaceAfter, line: 276 },
    children: [
      new TextRun({
        text,
        size: 20, // 10pt
        bold,
        italics,
        color,
        font: 'Segoe UI'
      })
    ]
  });
}

function createBullet(text, boldPrefix = '') {
  const children = [];
  if (boldPrefix) {
    children.push(new TextRun({
      text: boldPrefix + ' ',
      bold: true,
      size: 20,
      color: COLOR_SECONDARY,
      font: 'Segoe UI'
    }));
  }
  children.push(new TextRun({
    text,
    size: 20,
    color: '334155',
    font: 'Segoe UI'
  }));

  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 80, line: 260 },
    children
  });
}

function createCallout(title, bodyText, type = 'info') {
  const borderColor = type === 'warning' ? 'EAB308' : (type === 'security' ? 'DC2626' : COLOR_CALLOUT_BORDER);
  const bgColor = type === 'warning' ? 'FEFCE8' : (type === 'security' ? 'FEF2F2' : 'F0F9FF');

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE },
      right: { style: BorderStyle.NONE },
      bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.SINGLE, size: 24, color: borderColor }
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: bgColor, type: ShadingType.CLEAR },
            margins: { top: 120, bottom: 120, left: 180, right: 180 },
            children: [
              new Paragraph({
                spacing: { after: 60 },
                children: [
                  new TextRun({
                    text: `📌 ${title}`,
                    bold: true,
                    size: 20,
                    color: borderColor,
                    font: 'Segoe UI'
                  })
                ]
              }),
              new Paragraph({
                spacing: { after: 0 },
                children: [
                  new TextRun({
                    text: bodyText,
                    size: 19,
                    color: '1E293B',
                    font: 'Segoe UI'
                  })
                ]
              })
            ]
          })
        ]
      })
    ]
  });
}

function createCodeBlock(codeText) {
  const lines = codeText.split('\n');
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      right: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      left: { style: BorderStyle.SINGLE, size: 16, color: COLOR_PRIMARY }
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: COLOR_CODE_BG, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 140, right: 140 },
            children: lines.map(line => new Paragraph({
              spacing: { after: 40, line: 220 },
              children: [
                new TextRun({
                  text: line || ' ',
                  size: 18, // 9pt
                  font: 'Consolas',
                  color: '0F172A'
                })
              ]
            }))
          })
        ]
      })
    ]
  });
}

function createSimpleTable(headers, rowsData) {
  const headerCells = headers.map(h => new TableCell({
    shading: { fill: COLOR_BG_HEADER, type: ShadingType.CLEAR },
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children: [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [
          new TextRun({
            text: h.text,
            bold: true,
            size: 19,
            color: 'FFFFFF',
            font: 'Segoe UI'
          })
        ]
      })
    ]
  }));

  const tableRows = [
    new TableRow({ children: headerCells, tableHeader: true })
  ];

  rowsData.forEach((row, rIdx) => {
    const isZebra = rIdx % 2 === 1;
    const cells = row.map((cellText, cIdx) => new TableCell({
      shading: isZebra ? { fill: COLOR_BG_ZEBRA, type: ShadingType.CLEAR } : undefined,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 2, color: COLOR_BORDER },
        bottom: { style: BorderStyle.SINGLE, size: 2, color: COLOR_BORDER },
        left: { style: BorderStyle.SINGLE, size: 2, color: COLOR_BORDER },
        right: { style: BorderStyle.SINGLE, size: 2, color: COLOR_BORDER }
      },
      children: [
        new Paragraph({
          children: [
            new TextRun({
              text: cellText,
              size: 18,
              font: cIdx === 0 && cellText.includes('/') ? 'Consolas' : 'Segoe UI',
              bold: cIdx === 0,
              color: '1E293B'
            })
          ]
        })
      ]
    }));
    tableRows.push(new TableRow({ children: cells }));
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      right: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER }
    },
    rows: tableRows
  });
}

async function buildDocx() {
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1200, bottom: 1200, left: 1200, right: 1200 }
          }
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: 'SAI TRADERS | ANGULAR STOREFRONT INTEGRATION MANUAL',
                    size: 16,
                    color: COLOR_MUTED,
                    font: 'Segoe UI'
                  })
                ]
              })
            ]
          })
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.SPACE_BETWEEN,
                children: [
                  new TextRun({
                    text: 'CONFIDENTIAL — FOR INTEGRATION PARTNERS ONLY',
                    size: 16,
                    color: COLOR_MUTED,
                    font: 'Segoe UI'
                  }),
                  new TextRun({
                    text: 'Page ',
                    size: 16,
                    color: COLOR_MUTED,
                    font: 'Segoe UI'
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    size: 16,
                    color: COLOR_MUTED,
                    font: 'Segoe UI'
                  })
                ]
              })
            ]
          })
        },
        children: [
          // Header / Title
          createTitle('SAI TRADERS — ANGULAR STOREFRONT INTEGRATION GUIDE'),
          createSubtitle('Official REST API, Dual-Master Seat Hold Engine, and Angular 16+ Client Package'),

          // Document Control Meta Table
          createSimpleTable(
            [{ text: 'Parameter' }, { text: 'Value / Specification' }],
            [
              ['Document Version', 'v2.4.0 (Production Release)'],
              ['Target Audience', 'External Angular Web Engineering & Frontend Development Team'],
              ['Backend Service', 'Sai Traders Operations & Distributed Inventory Gateway'],
              ['Staging Gateway', 'https://api-staging.saitraders.internal (or Cloudflare Tunnel URL)'],
              ['Production Gateway', 'https://api.saitraders.in (Cloudflare Edge TLS 1.3)'],
              ['Authentication Headers', 'x-api-key, X-Storefront-Signature (HMAC-SHA256)'],
              ['Concurrency Header', 'X-Idempotency-Key (UUIDv4)'],
              ['Media CDN Base URL', 'https://pub-3a7d424a015147dbbe6a545151860ab7.r2.dev/catalog'],
              ['Security Clearance', 'Partner Confidential — No internal ERP or Tally XML exposure']
            ]
          ),

          new Paragraph({ spacing: { after: 200 } }),

          createCallout(
            'Executive Integration Summary for Partner Engineers',
            'This specification delivers everything required to seamlessly connect your Angular storefront to Sai Traders: Real-time Saree catalog feeds with color swatches, 10-minute cart seat-hold reservations to prevent overselling against retail walk-ins, and cryptographic purchase webhooks with zero Tally or ERP complexity.',
            'info'
          ),

          new Paragraph({ spacing: { after: 200 } }),

          // CHAPTER 1
          createHeading1('1. Architecture & Security Ingress'),
          createParagraph(
            'Sai Traders operates an authoritative multi-channel commerce platform where inventory is synchronized across retail walk-ins, WhatsApp automated shopping, and your online Angular web storefront. All storefront communication is proxied through a secure Cloudflare Gateway.'
          ),

          createHeading2('1.1 Architecture Topology'),
          createCodeBlock(
`+---------------------------------------------------------------------------------+
|                       ANGULAR WEB STOREFRONT (Partner App)                      |
|  - Saree Catalog & Variant Swatches                                            |
|  - 10-Minute Cart Hold Countdown Timer (BookMyShow Model)                       |
|  - One-Click Checkout with Razorpay / UPI                                       |
+---------------------------------------------------------------------------------+
                                      |
                           HTTPS / TLS 1.3 Requests
            (Headers: x-api-key, X-Idempotency-Key, X-Storefront-Signature)
                                      v
+---------------------------------------------------------------------------------+
|                      CLOUDFLARE EDGE & INGRESS GATEWAY                          |
|  - Cloudflare Named Tunnel (Zero Port-Forwarding, DDoS Mitigation)              |
|  - Cloudflare R2 Media CDN (High-Res Saree Images, Zero Egress Bandwidth Fees)  |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
|               SAI TRADERS OPERATIONS CORE & SEAT-HOLD ENGINE                    |
|  - Real-time Inventory Hold Manager (10-min active lease / auto-release)        |
|  - Authoritative Order Synchronizer & Idempotency Store                         |
|  - Automatic background sync to local TallyPrime ERP (Sarees Godown)            |
+---------------------------------------------------------------------------------+`
          ),

          createHeading2('1.2 Required HTTP Headers Reference'),
          createParagraph('Every request sent by your Angular application must provide the following standard headers:'),
          createSimpleTable(
            [{ text: 'Header Name' }, { text: 'Type' }, { text: 'Mandatory For' }, { text: 'Description' }],
            [
              ['x-api-key', 'String', 'All GET & POST requests', 'Storefront API access key: sai_store_live_sec_892176'],
              ['Content-Type', 'String', 'POST requests', 'Must always be set to application/json'],
              ['X-Idempotency-Key', 'UUID/String', 'Hold & Order POSTs', 'Unique client transaction identifier (e.g. orderNumber or UUIDv4)'],
              ['X-Storefront-Signature', 'String', 'Order Webhook POST', 'Cryptographic HMAC-SHA256 signature (sha256=<hex_digest>)']
            ]
          ),

          new Paragraph({ spacing: { after: 160 } }),

          createCallout(
            'CORS Preflight Configuration',
            'CORS is fully pre-configured on all endpoints. Allowed Origins: * (or your domain in production). Allowed Headers: Content-Type, x-api-key, X-Idempotency-Key, X-Storefront-Signature. Allowed Methods: GET, POST, OPTIONS.',
            'info'
          ),

          // CHAPTER 2
          createHeading1('2. Core API Endpoints Reference'),

          createHeading2('2.1 Gateway Health & CDN Check'),
          createParagraph('Used by your Angular application during boot to verify gateway reachability and retrieve the active Media CDN base URL.'),
          createBullet('GET /api/v1/health', 'Endpoint:'),
          createBullet('Public (No auth required)', 'Authentication:'),
          createParagraph('Sample Response (200 OK):', { bold: true }),
          createCodeBlock(
`{
  "status": "ok",
  "service": "sai-traders-operations-core",
  "version": "1.0.0",
  "environment": "production",
  "r2_media_cdn": {
    "bucket": "saitraders-media",
    "public_base_url": "https://pub-3a7d424a015147dbbe6a545151860ab7.r2.dev"
  }
}`
          ),

          new Paragraph({ spacing: { after: 160 } }),

          createHeading2('2.2 Get Saree Catalog'),
          createParagraph('Returns the complete, authoritative saree collection with real-time stock balances, pricing, fabric details, and color variants.'),
          createBullet('GET /api/v1/store/products', 'Endpoint:'),
          createBullet('x-api-key: sai_store_live_sec_892176', 'Headers:'),
          createBullet('in_stock_only=true (filters out sold items), search=silk (query search)', 'Query Parameters:'),
          createParagraph('Sample Response (200 OK):', { bold: true }),
          createCodeBlock(
`{
  "success": true,
  "count": 2,
  "products": [
    {
      "id": "e8d6bf94-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      "sku": "SAI-VAR-01",
      "name": "Royal Zari Heritage Silk Saree",
      "fabric": "Pure Kanjivaram Silk",
      "weave": "Zari Brocade",
      "color_primary": "Multi",
      "price": 4800,
      "mrp": 6500,
      "stock": 13,
      "in_stock": true,
      "image_urls": [
        "https://pub-3a7d424a015147dbbe6a545151860ab7.r2.dev/catalog/royal_zari_main.jpg"
      ],
      "description": "Authentic handwoven silk saree with traditional temple borders.",
      "is_group": true,
      "design_family_id": "fam_royal_zari_01",
      "variants": [
        {
          "id": "v1",
          "sku": "SAI-VAR-01-RED",
          "name": "Royal Zari Heritage Silk Saree (Maroon Red)",
          "color": "Maroon Red",
          "price": 4800,
          "mrp": 6500,
          "stock": 6,
          "in_stock": true,
          "image_urls": ["https://pub-3a7d424a015147dbbe6a545151860ab7.r2.dev/catalog/royal_zari_red.jpg"]
        },
        {
          "id": "v2",
          "sku": "SAI-VAR-01-BLU",
          "name": "Royal Zari Heritage Silk Saree (Royal Blue)",
          "color": "Royal Blue",
          "price": 4800,
          "mrp": 6500,
          "stock": 7,
          "in_stock": true,
          "image_urls": ["https://pub-3a7d424a015147dbbe6a545151860ab7.r2.dev/catalog/royal_zari_blue.jpg"]
        }
      ]
    }
  ]
}`
          ),

          new Paragraph({ spacing: { after: 160 } }),

          createHeading2('2.3 Acquire Inventory Seat-Hold (10-Minute Cart Lease)'),
          createParagraph(
            'Called by your Angular app when a user adds a saree to their cart or initiates checkout. This temporarily reserves the unit for 10 minutes (600 seconds), preventing retail store staff or WhatsApp users from purchasing the same physical saree.'
          ),
          createBullet('POST /api/v1/inventory/holds/acquire', 'Endpoint:'),
          createBullet('Content-Type: application/json, x-api-key: sai_store_live_sec_892176', 'Headers:'),
          createParagraph('Request Payload:', { bold: true }),
          createCodeBlock(
`{
  "holdId": "hld_cart_98124_usr",
  "sku": "SAI-VAR-01-BLU",
  "quantity": 1,
  "channel": "WEB_STOREFRONT",
  "ttlSeconds": 600,
  "idempotencyKey": "hld_cart_98124_usr"
}`
          ),
          createParagraph('Sample Response (200 OK — Active Reservation):', { bold: true }),
          createCodeBlock(
`{
  "status": "ACTIVE",
  "holdId": "hld_cart_98124_usr",
  "sku": "SAI-VAR-01-BLU",
  "reservedQuantity": 1,
  "expiresAt": "2026-10-30T10:35:00.000Z"
}`
          ),
          createParagraph('Sample Response (409 Conflict — Sold Out or Already Held):', { bold: true }),
          createCodeBlock(
`{
  "status": "REJECTED",
  "error": "INSUFFICIENT_STOCK",
  "availableToReserve": 0,
  "message": "Item is currently held by another shopper or out of stock"
}`
          ),

          new Paragraph({ spacing: { after: 160 } }),

          createHeading2('2.4 Query Hold Status & Countdown'),
          createParagraph('Used by the Angular UI to poll or check the remaining lease duration (e.g. "You have 8m 42s remaining to complete payment").'),
          createBullet('GET /api/v1/inventory/holds/:holdId', 'Endpoint:'),
          createParagraph('Sample Response (200 OK):', { bold: true }),
          createCodeBlock(
`{
  "holdId": "hld_cart_98124_usr",
  "status": "ACTIVE",
  "sku": "SAI-VAR-01-BLU",
  "quantity": 1,
  "expiresAt": "2026-10-30T10:35:00.000Z",
  "timeRemainingSeconds": 522
}`
          ),

          new Paragraph({ spacing: { after: 160 } }),

          createHeading2('2.5 Release Hold (Cart Abandonment / Item Removal)'),
          createParagraph('Called when a customer explicitly removes an item from their cart or clicks "Cancel Checkout". Releases the lock immediately for other shoppers.'),
          createBullet('POST /api/v1/inventory/holds/release', 'Endpoint:'),
          createParagraph('Request Payload:', { bold: true }),
          createCodeBlock(
`{
  "holdId": "hld_cart_98124_usr",
  "sku": "SAI-VAR-01-BLU",
  "reason": "USER_REMOVED_FROM_CART"
}`
          ),
          createParagraph('Sample Response (200 OK):', { bold: true }),
          createCodeBlock(
`{
  "status": "RELEASED",
  "holdId": "hld_cart_98124_usr",
  "sku": "SAI-VAR-01-BLU"
}`
          ),

          new Paragraph({ spacing: { after: 160 } }),

          createHeading2('2.6 Authoritative Order Synchronization Webhook'),
          createParagraph(
            'Called immediately after payment confirmation (e.g. Razorpay payment success). This atomically confirms the order, converts the hold into a permanent sale, updates stock balances, and triggers automated accounting in TallyPrime ERP under the dedicated "Sarees" godown.'
          ),
          createBullet('POST /api/v1/orders/storefront-sync (or /api/v1/store/orders)', 'Endpoint:'),
          createBullet('Content-Type: application/json, X-Idempotency-Key: <orderNumber>, X-Storefront-Signature: sha256=<hex>', 'Headers:'),
          createParagraph('Request Payload:', { bold: true }),
          createCodeBlock(
`{
  "orderNumber": "ORD-WEB-2026-8941",
  "amount": 4800,
  "customer": {
    "name": "Priya Sharma",
    "phone": "+919876543210",
    "email": "priya.sharma@example.com",
    "address": "Flat 402, Lotus Enclave, Indiranagar, Bengaluru, KA 560038"
  },
  "items": [
    {
      "sku": "SAI-VAR-01-BLU",
      "name": "Royal Zari Heritage Silk Saree (Royal Blue)",
      "quantity": 1,
      "price": 4800
    }
  ],
  "paymentMethod": "razorpay_upi",
  "paymentReference": "pay_Oid91kK2La01",
  "holdId": "hld_cart_98124_usr"
}`
          ),
          createParagraph('Sample Response (200 OK — Confirmed):', { bold: true }),
          createCodeBlock(
`{
  "success": true,
  "orderReference": "SAI-ORD-418291-8941",
  "orderNumber": "ORD-WEB-2026-8941",
  "tallyJobId": "TALLY-JOB-891023",
  "status": "ingested",
  "timestamp": "2026-10-30T10:28:14.218Z"
}`
          ),

          new Paragraph({ spacing: { after: 160 } }),

          createCallout(
            'Cryptographic Replay Defense (Idempotency Guarantee)',
            'If network drops or user clicks "Pay" multiple times, our gateway checks X-Idempotency-Key. If the key and payload match an already-processed order, it returns 200 OK with the cached orderReference and "idempotentReplay": true, preventing double-billing or duplicate stock deductions.',
            'security'
          ),

          // CHAPTER 3
          createHeading1('3. Production Angular TypeScript Integration Package'),
          createParagraph('Follow these step-by-step instructions to integrate the API into your Angular 16+ / 17+ / 18+ application.'),

          createHeading2('Step 3.1: Environment Configuration'),
          createParagraph('Add the gateway credentials to your Angular `src/environments/environment.ts` and `environment.prod.ts`:'),
          createCodeBlock(
`export const environment = {
  production: false,
  apiBaseUrl: 'https://api-staging.saitraders.internal/api/v1', // or Cloudflare Tunnel staging URL
  storefrontApiKey: 'sai_store_live_sec_892176',
  storefrontHmacSecret: 'sec_stg_a45981cbd31fefdc05931ff704c9f4b47fc9c4c1b779c8ee73ee22b4ecb14776',
  mediaCdnUrl: 'https://pub-3a7d424a015147dbbe6a545151860ab7.r2.dev/catalog'
};`
          ),

          createHeading2('Step 3.2: TypeScript Data Models'),
          createParagraph('Save the following interfaces to `src/app/models/saree.model.ts`:'),
          createCodeBlock(
`export interface SareeVariant {
  id: string;
  sku: string;
  name: string;
  color: string;
  price: number;
  mrp: number;
  stock: number;
  in_stock: boolean;
  image_urls: string[];
}

export interface SareeProduct {
  id: string;
  sku: string;
  name: string;
  fabric: string;
  weave: string;
  color_primary: string;
  price: number;
  mrp: number;
  stock: number;
  in_stock: boolean;
  image_urls: string[];
  description: string;
  is_group: boolean;
  design_family_id?: string;
  variants?: SareeVariant[];
}

export interface InventoryHoldRequest {
  holdId: string;
  sku: string;
  quantity: number;
  channel: string;
  ttlSeconds: number;
  idempotencyKey: string;
}

export interface InventoryHoldResponse {
  status: 'ACTIVE' | 'REJECTED' | 'EXPIRED' | 'RELEASED';
  holdId: string;
  expiresAt: string;
  sku: string;
  reservedQuantity?: number;
  timeRemainingSeconds?: number;
  error?: string;
  message?: string;
}

export interface CustomerDetails {
  name: string;
  phone: string;
  email?: string;
  address: string;
}

export interface StorefrontOrderRequest {
  orderNumber: string;
  amount: number;
  customer: CustomerDetails;
  items: Array<{
    sku: string;
    name: string;
    quantity: number;
    price: number;
  }>;
  paymentMethod: string;
  paymentReference?: string;
  holdId?: string;
}

export interface StorefrontOrderResponse {
  success: boolean;
  orderReference: string;
  orderNumber: string;
  tallyJobId: string;
  status: string;
  timestamp: string;
  idempotentReplay?: boolean;
}`
          ),

          createHeading2('Step 3.3: Production Angular Service (`SareeStoreService`)'),
          createParagraph('Save the following service to `src/app/services/saree-store.service.ts`:'),
          createCodeBlock(
`import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  SareeProduct,
  InventoryHoldRequest,
  InventoryHoldResponse,
  StorefrontOrderRequest,
  StorefrontOrderResponse
} from '../models/saree.model';

@Injectable({
  providedIn: 'root'
})
export class SareeStoreService {
  private readonly baseUrl = environment.apiBaseUrl;
  private readonly apiKey = environment.storefrontApiKey;

  constructor(private http: HttpClient) {}

  private getBaseHeaders(): HttpHeaders {
    return new HttpHeaders({
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey
    });
  }

  /**
   * 1. Fetch Saree Catalog with live stock & variant swatches
   */
  getCatalog(inStockOnly: boolean = false, search: string = ''): Observable<{ success: boolean; count: number; products: SareeProduct[] }> {
    let params = new HttpParams();
    if (inStockOnly) params = params.set('in_stock_only', 'true');
    if (search.trim()) params = params.set('search', search.trim());

    return this.http.get<{ success: boolean; count: number; products: SareeProduct[] }>(
      \`\${this.baseUrl}/store/products\`,
      { headers: this.getBaseHeaders(), params }
    );
  }

  /**
   * 2. Acquire a 10-minute inventory seat-hold before checkout
   */
  acquireHold(sku: string, quantity: number = 1): Observable<InventoryHoldResponse> {
    const holdId = 'hld_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const payload: InventoryHoldRequest = {
      holdId,
      sku,
      quantity,
      channel: 'WEB_STOREFRONT',
      ttlSeconds: 600,
      idempotencyKey: holdId
    };

    return this.http.post<InventoryHoldResponse>(
      \`\${this.baseUrl}/inventory/holds/acquire\`,
      payload,
      { headers: this.getBaseHeaders() }
    );
  }

  /**
   * 3. Query remaining hold countdown
   */
  getHoldStatus(holdId: string): Observable<InventoryHoldResponse> {
    return this.http.get<InventoryHoldResponse>(
      \`\${this.baseUrl}/inventory/holds/\${encodeURIComponent(holdId)}\`,
      { headers: this.getBaseHeaders() }
    );
  }

  /**
   * 4. Explicitly release hold on cart removal / checkout abandonment
   */
  releaseHold(holdId: string, sku: string, reason: string = 'USER_ABANDONED'): Observable<{ status: string; holdId: string }> {
    return this.http.post<{ status: string; holdId: string }>(
      \`\${this.baseUrl}/inventory/holds/release\`,
      { holdId, sku, reason },
      { headers: this.getBaseHeaders() }
    );
  }

  /**
   * 5. Submit confirmed purchase order with HMAC signature
   */
  submitOrder(orderData: StorefrontOrderRequest, signature: string): Observable<StorefrontOrderResponse> {
    const headers = this.getBaseHeaders()
      .set('X-Idempotency-Key', orderData.orderNumber)
      .set('X-Storefront-Signature', signature);

    return this.http.post<StorefrontOrderResponse>(
      \`\${this.baseUrl}/orders/storefront-sync\`,
      orderData,
      { headers }
    );
  }
}`
          ),

          createHeading2('Step 3.4: Cryptographic HMAC Signature Utility'),
          createParagraph(
            'To protect the webhook against tampering, the `X-Storefront-Signature` header must contain the SHA256 HMAC of the raw JSON payload using the shared secret.'
          ),
          createCodeBlock(
`// Using standard Web Crypto API (supported natively in modern browsers and Node):
export async function computeHmacSignature(payload: object, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(JSON.stringify(payload))
  );
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return 'sha256=' + hex;
}`
          ),

          // CHAPTER 4
          createHeading1('4. Dual-Master Seat-Hold Concurrency Engine'),
          createParagraph(
            'Because Sai Traders sells exclusive, high-value sarees both on the physical retail floor and online, avoiding double-selling is mission-critical. We employ an event-driven 10-Minute Cart Lease (BookMyShow seat hold model):'
          ),
          createSimpleTable(
            [{ text: 'Lifecycle Stage' }, { text: 'Trigger' }, { text: 'State' }, { text: 'Impact on Inventory' }],
            [
              ['1. Catalog Browsing', 'Shopper views product page', 'AVAILABLE', 'Full stock displayed; available to any customer.'],
              ['2. Add to Cart / Checkout', 'User clicks "Buy Now" or "Add to Cart"', 'ACTIVE HOLD (600s)', 'Stock temporarily reserved. Unavailable to other online shoppers.'],
              ['3. Payment Completed', 'Payment Gateway confirms success', 'CONVERTED', 'Permanent stock deduction in PostgreSQL & TallyPrime Sarees godown.'],
              ['4. Cart Abandoned / Timeout', '10-minute timer expires or user leaves', 'RELEASED / EXPIRED', 'Lock cleared immediately by Reconciler Daemon; stock returned to pool.']
            ]
          ),

          new Paragraph({ spacing: { after: 160 } }),

          // CHAPTER 5
          createHeading1('5. Error Handling & HTTP Status Code Matrix'),
          createParagraph('Your Angular application should gracefully handle the following HTTP status codes:'),
          createSimpleTable(
            [{ text: 'HTTP Code' }, { text: 'Error Code / Name' }, { text: 'Cause' }, { text: 'Recommended Angular Action' }],
            [
              ['200 OK', 'SUCCESS', 'Request processed or idempotent replay returned.', 'Render success confirmation; proceed to order tracking.'],
              ['400 Bad Request', 'MISSING_PAYLOAD_FIELD', 'Required field (e.g. sku, orderNumber) was omitted.', 'Log client error; validate form fields before posting.'],
              ['403 Forbidden', 'INVALID_SIGNATURE', 'x-api-key or X-Storefront-Signature HMAC failed verification.', 'Check environment secret matching; verify UTF-8 encoding.'],
              ['404 Not Found', 'HOLD_NOT_FOUND', 'Hold ID not found or already purged by cleanup.', 'Prompt user: "Reservation expired. Please refresh cart."'],
              ['409 Conflict', 'INSUFFICIENT_STOCK', 'Saree is out of stock or currently held by another user.', 'Display banner: "Currently reserved by another shopper."'],
              ['409 Conflict', 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Same X-Idempotency-Key submitted with changed payload.', 'Generate new orderNumber for modified order.'],
              ['500 / 503', 'GATEWAY_ERROR', 'Temporary network or downstream ERP timeout.', 'Retry with exponential backoff (1s, 2s, 4s).']
            ]
          ),

          new Paragraph({ spacing: { after: 160 } }),

          // CHAPTER 6
          createHeading1('6. Developer Quickstart & cURL Test Suite'),
          createParagraph('Your backend and frontend developers can test live integration immediately using these cURL commands:'),

          createHeading2('Test 1: Health & CDN Verification'),
          createCodeBlock(
`curl -X GET "https://api-staging.saitraders.internal/api/v1/health" \\
  -H "Accept: application/json"`
          ),

          createHeading2('Test 2: Query Live Saree Catalog'),
          createCodeBlock(
`curl -X GET "https://api-staging.saitraders.internal/api/v1/store/products?in_stock_only=true" \\
  -H "x-api-key: sai_store_live_sec_892176"`
          ),

          createHeading2('Test 3: Acquire 10-Minute Cart Hold'),
          createCodeBlock(
`curl -X POST "https://api-staging.saitraders.internal/api/v1/inventory/holds/acquire" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: sai_store_live_sec_892176" \\
  -d '{
    "holdId": "hld_test_dev_01",
    "sku": "SAI-VAR-01-BLU",
    "quantity": 1,
    "channel": "WEB_STOREFRONT",
    "ttlSeconds": 600,
    "idempotencyKey": "hld_test_dev_01"
  }'`
          ),

          createHeading2('Test 4: Post Purchase Order Webhook with HMAC Signature'),
          createCodeBlock(
`curl -X POST "https://api-staging.saitraders.internal/api/v1/orders/storefront-sync" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: sai_store_live_sec_892176" \\
  -H "X-Idempotency-Key: ORD-TEST-2026-001" \\
  -H "X-Storefront-Signature: sha256=<compute_hmac_of_body>" \\
  -d '{
    "orderNumber": "ORD-TEST-2026-001",
    "amount": 4800,
    "customer": {
      "name": "Integration Test Customer",
      "phone": "+919876543210",
      "email": "test@partner.com",
      "address": "Bangalore"
    },
    "items": [
      { "sku": "SAI-VAR-01-BLU", "name": "Royal Zari Silk", "quantity": 1, "price": 4800 }
    ],
    "paymentMethod": "razorpay_test"
  }'`
          ),

          new Paragraph({ spacing: { after: 200 } }),

          createCallout(
            'Support & Staging Assistance',
            'For technical inquiries or staging environment access coordination, contact the Sai Traders Core Engineering Operations Team. All staging webhooks can be monitored in real time via our operations telemetry dashboard.',
            'info'
          )
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(OUTPUT_PATH, buffer);
  console.log(`✅ Successfully generated: ${OUTPUT_PATH} (${buffer.length} bytes)`);
}

buildDocx().catch(err => {
  console.error('❌ Failed to generate docx:', err);
  process.exit(1);
});
