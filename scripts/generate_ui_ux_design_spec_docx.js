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

const OUTPUT_PATH = path.join(__dirname, '..', 'word', 'sai-traders-angular-ui-ux-design-spec.docx');

// Colors
const COLOR_PRIMARY = '0A192F';   // Deep Navy
const COLOR_SECONDARY = '1E293B'; // Dark Slate
const COLOR_ACCENT = 'D4AF37';    // Warm Gold
const COLOR_MUTED = '64748B';     // Slate Muted
const COLOR_BORDER = 'CBD5E1';    // Border Gray
const COLOR_BG_HEADER = '0F172A'; // Dark Table Header
const COLOR_BG_ZEBRA = 'F8FAFC';  // Zebra Row
const COLOR_CRIMSON = 'DC2626';   // Warning Crimson
const COLOR_EMERALD = '059669';   // Success Green
const COLOR_CODE_BG = 'F1F5F9';   // Code background

function createTitle(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 240, after: 100 },
    children: [
      new TextRun({
        text,
        size: 36, // 18pt
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
    spacing: { before: 0, after: 320 },
    children: [
      new TextRun({
        text,
        size: 22, // 11pt
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
    spacing: { before: 340, after: 120 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 8, color: COLOR_ACCENT }
    },
    children: [
      new TextRun({
        text,
        size: 28, // 14pt
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
    spacing: { before: 240, after: 90 },
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

function createParagraph(text, options = {}) {
  const { bold = false, italics = false, color = '1E293B', spaceAfter = 120 } = options;
  return new Paragraph({
    spacing: { after: spaceAfter, line: 260 },
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
    spacing: { after: 70, line: 250 },
    children
  });
}

function createCallout(title, bodyText, type = 'info') {
  let borderColor = '0284C7';
  let bgColor = 'F0F9FF';
  let titleColor = '0369A1';

  if (type === 'danger' || type === 'critical') {
    borderColor = COLOR_CRIMSON;
    bgColor = 'FEF2F2';
    titleColor = '991B1B';
  } else if (type === 'warning') {
    borderColor = 'D97706';
    bgColor = 'FFFBEB';
    titleColor = '92400E';
  } else if (type === 'success') {
    borderColor = COLOR_EMERALD;
    bgColor = 'ECFDF5';
    titleColor = '065F46';
  }

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
            margins: { top: 120, bottom: 120, left: 160, right: 160 },
            children: [
              new Paragraph({
                spacing: { after: 60 },
                children: [
                  new TextRun({
                    text: `⚠️ ${title}`,
                    bold: true,
                    size: 20,
                    color: titleColor,
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
              spacing: { after: 30, line: 220 },
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
    margins: { top: 90, bottom: 90, left: 120, right: 120 },
    children: [
      new Paragraph({
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
      margins: { top: 70, bottom: 70, left: 120, right: 120 },
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
              bold: cIdx === 0,
              font: 'Segoe UI',
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
                    text: 'SAI TRADERS | FRONTEND UI/UX DESIGN CONTRACT & ACCEPTANCE STANDARDS',
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
                    text: 'NON-NEGOTIABLE CLIENT SPECIFICATION — STRICT ACCEPTANCE CRITERIA',
                    size: 16,
                    color: COLOR_CRIMSON,
                    font: 'Segoe UI',
                    bold: true
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
          // Title
          createTitle('SAI TRADERS — ANGULAR WEB FRONTEND DESIGN CONTRACT'),
          createSubtitle('Definitive UI/UX Standards, Saree Framing, Square Swatches & Non-Negotiable Acceptance Criteria'),

          // Meta Table
          createSimpleTable(
            [{ text: 'Contract Specification' }, { text: 'Terms & Binding Standards' }],
            [
              ['Document Title', 'Sai Traders Angular Frontend UI/UX Design & Acceptance Contract'],
              ['Vendor Scope', 'External Angular Web Application Engineering Team'],
              ['Effective Date', 'Immediate (Applies to all current and future frontend sprints)'],
              ['Binding Clause', 'Deliverables violating these rules will fail QA acceptance and require remediation before final sign-off.'],
              ['Core Standard 1', 'Zero-Cropping Saree Framing (object-fit: contain !important; 200px-220px container)'],
              ['Core Standard 2', '100% Pure Square Color Swatches (No circles, no bubbly pills, stock count per variant)'],
              ['Core Standard 3', 'Compact Cards with Strictly 2-Line Clamped Description & Expand Toggle'],
              ['Core Standard 4', '10-Minute Cart Hold Reservation Countdown Timer (BookMyShow seat-lock UX)'],
              ['Core Standard 5', 'No Amateur / Generic AI Styles (Plus Jakarta Sans, Obsidian / Gold luxury palette)']
            ]
          ),

          new Paragraph({ spacing: { after: 180 } }),

          createCallout(
            'STRICT BINDING NOTICE: ZERO UNAPPROVED MODIFICATIONS',
            'This document defines the exact visual presentation and user interaction standards mandated by Sai Traders executive leadership. Saree retail is a visual, luxury business. Generic e-commerce templates that crop pallus, bloat card heights, or use circular radio dots are strictly unacceptable. Implement exactly as specified.',
            'critical'
          ),

          new Paragraph({ spacing: { after: 200 } }),

          // CHAPTER 1
          createHeading1('Chapter 1: The Zero-Cropping Saree Framing Standard (MANDATORY)'),
          createParagraph(
            'Sarees are high-value, handcrafted garments where the pallu (decorative end), temple borders, zari motifs, and pleats represent the primary selling points. Generic e-commerce implementations that apply "object-fit: cover" catastrophically cut off borders and drape details.'
          ),

          createHeading2('1.1 The Golden CSS Rule for Saree Media'),
          createParagraph('Every product image container in your Angular templates MUST adhere to the following CSS:'),
          createCodeBlock(
`/* MANDATORY: Saree Photo Frame Container */
.saree-photo-frame {
  height: 220px !important;
  max-height: 220px !important;
  width: 100%;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  background: radial-gradient(circle at center, #1e293b 0%, #0f172a 100%) !important;
  overflow: hidden !important;
  position: relative;
}

/* MANDATORY: Saree Image Containment (ZERO CROPPING) */
.saree-photo-frame img {
  max-height: 100% !important;
  max-width: 100% !important;
  width: auto !important;
  height: auto !important;
  object-fit: contain !important;
  object-position: center center !important;
  transition: transform 0.25s ease-in-out;
}

/* Subtle luxury zoom on hover without overflowing container */
.saree-photo-frame:hover img {
  transform: scale(1.04);
}`
          ),

          createHeading2('1.2 Media CDN Integration & Aspect Ratios'),
          createBullet('Cloudflare R2 Media CDN URL: All high-resolution images are served over our ultra-low latency Cloudflare CDN: https://pub-3a7d424a015147dbbe6a545151860ab7.r2.dev/catalog', 'Source:'),
          createBullet('Zero Distortion: Images may arrive in 3:4 portrait or 1:1 square. By applying object-fit: contain with the radial backdrop, every image sits elegantly inside the frame with zero letterbox distortion and zero clipping.', 'Integrity:'),
          createBullet('Lazy Loading: Add loading="lazy" and decoding="async" to every <img> tag to ensure instantaneous page rendering.', 'Performance:'),

          // CHAPTER 2
          createHeading1('Chapter 2: The Pure Square Color Swatch Standard'),
          createParagraph(
            'Sai Traders saree collections (e.g. Wrinkle Crêpe Georgette, Kanjivaram Brocade) are produced in specific color variants. The variant selector must feel like a fabric sample swatch, NOT a generic software form.'
          ),

          createHeading2('2.1 Absolute Prohibitions'),
          createBullet('DO NOT use HTML <select> dropdown menus.', 'Prohibited:'),
          createBullet('DO NOT use circular radio buttons or round dots.', 'Prohibited:'),
          createBullet('DO NOT use rounded pill buttons (border-radius > 0).', 'Prohibited:'),
          createBullet('DO NOT allow electric blue browser focus outlines (:focus { outline: #38bdf8 }).', 'Prohibited:'),

          createHeading2('2.2 Mandatory Square Swatch Implementation'),
          createParagraph('Color variants MUST be rendered as 100% square fabric swatch boxes with the color name and available stock count in parentheses:'),
          createCodeBlock(
`/* MANDATORY: Square Swatch Selector Container */
.color-variant-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0;
}

/* MANDATORY: Square Swatch Button (ZERO BORDER RADIUS) */
.color-swatch-btn {
  border-radius: 0px !important; /* STRICT: Absolutely zero curvature */
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: #1e293b;
  color: #e2e8f0;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: all 0.15s ease-in-out;
  outline: none !important; /* STRICT: No browser outline */
  box-shadow: none !important;
}

/* 14px Solid Square Fabric Color Indicator */
.color-swatch-box {
  width: 14px !important;
  height: 14px !important;
  border-radius: 0px !important; /* STRICT: Pure square */
  display: inline-block;
  border: 1px solid rgba(0, 0, 0, 0.25);
}

/* Active / Selected Swatch State */
.color-swatch-btn.active {
  border: 1px solid #D4AF37 !important; /* Gold accent border */
  background: #0f172a !important;
  color: #ffffff !important;
}

/* Stock badge inside swatch */
.color-swatch-qty {
  font-size: 10px;
  opacity: 0.75;
  margin-left: 2px;
}`
          ),

          createHeading2('2.3 Interactive Swatch Behavior'),
          createBullet('Instant Image Swap: Clicking a color swatch must immediately update the main image frame to display that specific colorway without page refresh.', 'Requirement 1:'),
          createBullet('Instant Price & Stock Sync: Clicking a swatch must update the active SKU, price, MRP, and live stock count.', 'Requirement 2:'),
          createBullet('Sold-Out Swatches: If a variant has stock === 0, render it with a subtle strike-through and reduced opacity (opacity: 0.45; cursor: not-allowed;).', 'Requirement 3:'),

          // CHAPTER 3
          createHeading1('Chapter 3: Compact Card Architecture & 2-Line Description Clamp'),
          createParagraph(
            'Traditional e-commerce templates allow descriptions to expand unchecked, resulting in cards of uneven 800px+ heights. Sai Traders cards must maintain a compact, uniform luxury grid.'
          ),

          createHeading2('3.1 Card Structure & Dimensions'),
          createSimpleTable(
            [{ text: 'Card Component' }, { text: 'Dimension / Constraint' }, { text: 'Mandatory Rule' }],
            [
              ['Photo Frame', 'Height: 220px fixed', 'Zero cropping; object-fit: contain with dark radial backdrop'],
              ['Card Body Padding', '10px 12px compact', 'Eliminates bloated empty vertical gaps'],
              ['Product Title', '14px bold, max 1-line truncate', 'Ellipsis (...) on title overflow'],
              ['Craftsmanship Box', 'Max-height: 32px (strictly 2 lines)', 'Must use -webkit-line-clamp: 2 with expand toggle'],
              ['Pricing Row', '16px bold INR price + strikethrough MRP', 'Displays current price, MRP, and discount %'],
              ['Action Button', 'Full-width 36px height button', 'Instant Buy Now with stock-aware disabled state']
            ]
          ),

          createHeading2('3.2 Mandatory 2-Line Clamped Description CSS'),
          createCodeBlock(
`/* MANDATORY: 2-Line Clamped Craftsmanship Box */
.saree-description-clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2; /* STRICT: Max 2 lines */
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  max-height: 32px;
  font-size: 11.5px;
  line-height: 16px;
  color: #94a3b8;
  margin: 6px 0 4px 0;
  transition: max-height 0.2s ease-in-out;
}

/* Expanded state when user clicks "Read details ▾" */
.saree-description-clamp.expanded {
  display: block;
  -webkit-line-clamp: unset;
  max-height: 200px;
}

/* Clean inline toggle */
.toggle-description-btn {
  background: none;
  border: none;
  color: #D4AF37; /* Gold */
  font-size: 11px;
  font-weight: 600;
  padding: 0;
  cursor: pointer;
}`
          ),

          // CHAPTER 4
          createHeading1('Chapter 4: Distributed Seat-Hold & Cart Timer UX (BookMyShow Model)'),
          createParagraph(
            'Because Sai Traders sells exclusive single-piece sarees on the physical retail floor simultaneously with online sales, our backend provides a 10-Minute Cart Lease Engine (POST /api/v1/inventory/holds/acquire). Your Angular UI must clearly communicate this reservation to the customer.'
          ),

          createHeading2('4.1 Cart Hold Countdown Timer Banner'),
          createParagraph('As soon as the user clicks "Buy Now" or enters checkout, display a persistent reservation bar:'),
          createCodeBlock(
`<!-- Persistent Countdown Timer Banner -->
<div class="cart-hold-timer-bar" *ngIf="activeHold">
  <span class="timer-icon">🔒</span>
  <span class="timer-text">
    Item reserved for you! Complete payment within 
    <strong class="timer-digits">{{ minutes }}:{{ seconds | number:'2.0-0' }}</strong>
  </span>
</div>`
          ),

          createHeading2('4.2 Mandatory Seat-Hold UX Rules'),
          createBullet('Visual Urgency: Format the countdown timer in bold tabular figures (e.g. 09:42). When under 2 minutes remaining, switch the timer color to Amber/Crimson to urge completion.', 'Countdown:'),
          createBullet('Out-of-Stock Prevention: If an item has stock === 0, immediately disable the button, set text to "Sold Out", and apply opacity: 0.5. Never allow a user to click Buy Now on zero-stock items.', 'Stock Guard:'),
          createBullet('Hold Expiration Modal: If the timer reaches 00:00 before payment, release the hold via POST /api/v1/inventory/holds/release and show a modal: "Your 10-minute reservation has expired. The saree has been returned to available stock."', 'Expiration:'),

          // CHAPTER 5
          createHeading1('Chapter 5: Typography, Color Tokens & Senior Visual Polish'),
          createParagraph('To ensure the storefront exudes luxury and craftsmanship, avoid generic default browser styles:'),

          createSimpleTable(
            [{ text: 'Design Element' }, { text: 'Approved Luxury Token' }, { text: 'Prohibited Generic Token' }],
            [
              ['Primary Font', 'Plus Jakarta Sans / Outfit (Google Fonts)', 'Times New Roman, Arial, default Tailwind sans'],
              ['Background', 'Deep Obsidian (#0A192F / #0F172A)', 'Plain harsh white (#FFFFFF) with zero contrast'],
              ['Surface Cards', 'Refined Glassmorphic Slate (#1E293B, border: rgba(255,255,255,0.08))', 'Default white card with heavy drop shadow'],
              ['Accent Color', 'Warm Gold (#D4AF37) / Radiant Royal Blue (#0284C7)', 'Generic neon blue (#0000FF) or plain green'],
              ['Numerals', 'Pure Crisp White with Tabular Figures (font-variant-numeric: tabular-nums)', 'Variable-width blurry numbers']
            ]
          ),

          new Paragraph({ spacing: { after: 180 } }),

          // CHAPTER 6
          createHeading1('Chapter 6: Complete Angular Component Implementation Template'),
          createParagraph('The following component provides the exact reference implementation meeting all 5 Core Standards:'),
          createCodeBlock(
`// src/app/components/saree-card/saree-card.component.ts
import { Component, Input, Output, EventEmitter } from '@angular/core';

@Component({
  selector: 'app-saree-card',
  templateUrl: './saree-card.component.html',
  styleUrls: ['./saree-card.component.css']
})
export class SareeCardComponent {
  @Input() saree: any;
  @Output() onBuy = new EventEmitter<{ sku: string; holdId: string }>();

  selectedVariant: any = null;
  isExpanded = false;

  ngOnInit() {
    if (this.saree.variants?.length) {
      this.selectedVariant = this.saree.variants[0];
    }
  }

  selectVariant(variant: any) {
    this.selectedVariant = variant;
  }

  get activeSku(): string {
    return this.selectedVariant ? this.selectedVariant.sku : this.saree.sku;
  }

  get activePrice(): number {
    return this.selectedVariant ? this.selectedVariant.price : this.saree.price;
  }

  get activeStock(): number {
    return this.selectedVariant ? this.selectedVariant.stock : this.saree.stock;
  }

  get activeImage(): string {
    if (this.selectedVariant?.image_urls?.length) return this.selectedVariant.image_urls[0];
    if (this.saree.image_urls?.length) return this.saree.image_urls[0];
    return 'assets/placeholder-saree.jpg';
  }

  toggleDescription() {
    this.isExpanded = !this.isExpanded;
  }

  triggerBuy() {
    if (this.activeStock <= 0) return;
    this.onBuy.emit({ sku: this.activeSku, holdId: 'hld_' + Date.now() });
  }
}`
          ),

          new Paragraph({ spacing: { after: 180 } }),

          // CHAPTER 7
          createHeading1('Chapter 7: QA Acceptance Checklist & Sign-Off Matrix'),
          createParagraph(
            'Before any sprint release is approved for payment and deployment, the Sai Traders technical architect will verify compliance against this 12-point matrix:'
          ),

          createSimpleTable(
            [{ text: 'Ref #' }, { text: 'Acceptance Standard' }, { text: 'Verification Method' }, { text: 'Mandatory Status' }],
            [
              ['QA-01', 'Saree Image Containment: Full pallu, borders, and drape visible with zero cropping.', 'Visual inspect 10 sarees on mobile and desktop', 'PASS / FAIL (Gate)'],
              ['QA-02', 'Photo Frame Height: Container fixed at 220px with dark radial backdrop.', 'DevTools Computed CSS inspection', 'PASS / FAIL (Gate)'],
              ['QA-03', 'Square Swatches: Fabric color boxes have border-radius: 0px !important.', 'DevTools Computed CSS inspection', 'PASS / FAIL (Gate)'],
              ['QA-04', 'Swatch Stock Display: Color name + stock count in parentheses (e.g. "Peach (6)").', 'Visual inspection of variants', 'PASS / FAIL (Gate)'],
              ['QA-05', 'No Focus Rings: Active swatch outline has no electric blue default browser rings.', 'Keyboard Tab focus test', 'PASS / FAIL (Gate)'],
              ['QA-06', 'Description Clamping: Craftsmanship text clamped strictly to 2 lines with expand toggle.', 'DevTools text-overflow inspection', 'PASS / FAIL (Gate)'],
              ['QA-07', 'Pricing Row: Selling price in bold, MRP with strikethrough, discount percentage.', 'Visual inspection', 'PASS / FAIL (Gate)'],
              ['QA-08', 'Seat-Hold Acquisition: POST /api/v1/inventory/holds/acquire called on Buy Now.', 'Network tab inspection', 'PASS / FAIL (Gate)'],
              ['QA-09', 'Countdown Timer: 10-minute reservation countdown bar visible in cart / checkout.', 'Timer test to 00:00', 'PASS / FAIL (Gate)'],
              ['QA-10', 'Sold-Out Handling: "Buy Now" disabled with "Sold Out" label when stock is 0.', 'Zero stock item test', 'PASS / FAIL (Gate)'],
              ['QA-11', 'HMAC Webhook: POST /orders/storefront-sync signed with SHA256 HMAC header.', 'Gateway signature verification', 'PASS / FAIL (Gate)'],
              ['QA-12', 'Idempotency Replay: Duplicate orderNumber returns cached 200 OK without double-sync.', 'cURL replay test vector', 'PASS / FAIL (Gate)']
            ]
          ),

          new Paragraph({ spacing: { after: 200 } }),

          createCallout(
            'Sign-Off & Non-Negotiable Contract Clause',
            'Deliverables failing any QA item marked (PASS / FAIL Gate) will be returned to the vendor team for mandatory remediation before invoice approval. This ensures the digital storefront accurately mirrors the luxury craftsmanship of Sai Traders.',
            'critical'
          )
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(OUTPUT_PATH, buffer);
  console.log(`✅ Successfully generated UI/UX Contract: ${OUTPUT_PATH} (${buffer.length} bytes)`);
}

buildDocx().catch(err => {
  console.error('❌ Failed to generate docx:', err);
  process.exit(1);
});
