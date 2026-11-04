# Angular Storefront Integration Guide for Sai Traders

This guide explains how to connect your external **Angular** website to the **Sai Traders ERP & Inventory Backend**.

---

## 1. Quick Overview

- **Base URL**: `http://localhost:3000` (or your production server domain/IP e.g., `https://api.saitraders.in`)
- **Authentication**: `x-api-key` HTTP Header
- **Storefront API Key**: `sai_store_live_sec_892176` (configured in `.env` as `STOREFRONT_API_KEY`)
- **CORS**: Fully enabled (`Access-Control-Allow-Origin: *`, supports preflight `OPTIONS`)

---

## 2. API Endpoints Reference

### 2.1 Get Saree Catalog
Fetch sarees with photo URLs, live stock counts, pricing, and color variants.

- **Method**: `GET`
- **Path**: `/api/v1/store/products`
- **Headers**:
  ```http
  x-api-key: sai_store_live_sec_892176
  ```
- **Query Parameters (Optional)**:
  - `in_stock_only=true` — Only returns items currently in stock (> 0).
  - `search=silk` — Filters items matching saree name, fabric, or color.

#### Example Response (`200 OK`):
```json
{
  "success": true,
  "count": 9,
  "target_godown": "Sarees",
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
        "https://...supabase.co/storage/v1/object/public/saree-catalog-images/sai_var_01_main.jpg"
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
          "image_urls": ["https://.../sai_var_01_red.jpg"]
        },
        {
          "id": "v2",
          "sku": "SAI-VAR-01-BLU",
          "name": "Royal Zari Heritage Silk Saree (Royal Blue)",
          "color": "Royal Blue",
          "price": 4800,
          "mrp": 6500,
          "stock": 4,
          "in_stock": true,
          "image_urls": ["https://.../sai_var_01_blu.jpg"]
        },
        {
          "id": "v3",
          "sku": "SAI-VAR-01-GRN",
          "name": "Royal Zari Heritage Silk Saree (Emerald Green)",
          "color": "Emerald Green",
          "price": 4800,
          "mrp": 6500,
          "stock": 3,
          "in_stock": true,
          "image_urls": ["https://.../sai_var_01_grn.jpg"]
        }
      ]
    }
  ]
}
```

---

### 2.2 Get Single Product or Color Group by SKU
Fetch detailed specs and color swatches for a product page.

- **Method**: `GET`
- **Path**: `/api/v1/store/products/:sku` (e.g. `/api/v1/store/products/SAI-VAR-01` or `/api/v1/store/products/SAI-VAR-01-BLU`)
- **Headers**:
  ```http
  x-api-key: sai_store_live_sec_892176
  ```

---

### 2.3 Post-Purchase Order Webhook
Triggered by Angular when customer completes checkout. Automatically:
1. Deducts live stock in `saree_catalog` and `stock_pool`.
2. Inserts order into database tagged as `channel: 'web'`.
3. Posts Sales Voucher to TallyPrime ERP under the dedicated **`Sarees`** godown.
4. Appends order row directly to your Google Spreadsheet via Apps Script.

- **Method**: `POST`
- **Path**: `/api/v1/store/orders`
- **Headers**:
  ```http
  Content-Type: application/json
  x-api-key: sai_store_live_sec_892176
  ```

#### Request Payload:
```json
{
  "order_id": "ANG-2026-8941",
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
  "total_amount": 4800,
  "payment_status": "paid",
  "payment_method": "Razorpay / UPI",
  "payment_reference": "pay_Oid91kK2La01",
  "notes": "Gift wrap requested"
}
```

#### Example Response (`200 OK`):
```json
{
  "success": true,
  "message": "Order [ANG-2026-8941] received! Inventory updated, Tally Sarees godown synced, and Google Sheets logged.",
  "order_number": "ANG-2026-8941",
  "stock_updates": [
    {
      "sku": "SAI-VAR-01-BLU",
      "deducted": 1
    }
  ],
  "tally_synced": true,
  "sheets_synced": true,
  "target_godown": "Sarees"
}
```

---

## 3. Step-by-Step Angular Implementation

### Step 3.1: Configure Environment
In your Angular project, open `src/environments/environment.ts`:

```typescript
export const environment = {
  production: false,
  apiBaseUrl: 'http://localhost:3000/api/v1/store',
  storefrontApiKey: 'sai_store_live_sec_892176'
};
```

---

### Step 3.2: TypeScript Data Models
Create `src/app/models/saree.model.ts`:

```typescript
export interface SareeVariant {
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
  variants: SareeVariant[];
}

export interface CustomerInfo {
  name: string;
  phone: string;
  email?: string;
  address: string;
}

export interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  price: number;
}

export interface OrderRequest {
  order_id?: string;
  customer: CustomerInfo;
  items: OrderItem[];
  total_amount: number;
  payment_status: 'paid' | 'pending';
  payment_method: string;
  payment_reference?: string;
  notes?: string;
}

export interface OrderResponse {
  success: boolean;
  message: string;
  order_number: string;
  stock_updates: { sku: string; deducted: number }[];
  tally_synced: boolean;
  sheets_synced: boolean;
  target_godown: string;
}
```

---

### Step 3.3: Angular Service (`SareeStoreService`)
Create `src/app/services/saree-store.service.ts`:

```typescript
import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { SareeProduct, OrderRequest, OrderResponse } from '../models/saree.model';

@Injectable({
  providedIn: 'root'
})
export class SareeStoreService {
  private baseUrl = environment.apiBaseUrl;
  private apiKey = environment.storefrontApiKey;

  constructor(private http: HttpClient) {}

  private getHeaders(): HttpHeaders {
    return new HttpHeaders({
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey
    });
  }

  /**
   * Fetch saree catalog with optional stock filtering and search query
   */
  getProducts(inStockOnly: boolean = false, searchQuery: string = ''): Observable<{ success: boolean; count: number; products: SareeProduct[] }> {
    let params = new HttpParams();
    if (inStockOnly) {
      params = params.set('in_stock_only', 'true');
    }
    if (searchQuery.trim()) {
      params = params.set('search', searchQuery.trim());
    }

    return this.http.get<{ success: boolean; count: number; products: SareeProduct[] }>(
      `${this.baseUrl}/products`,
      { headers: this.getHeaders(), params }
    );
  }

  /**
   * Fetch single product or color family by SKU
   */
  getProductBySku(sku: string): Observable<{ success: boolean; product: SareeProduct }> {
    return this.http.get<{ success: boolean; product: SareeProduct }>(
      `${this.baseUrl}/products/${encodeURIComponent(sku)}`,
      { headers: this.getHeaders() }
    );
  }

  /**
   * Notify backend of a completed checkout purchase
   * (Automatically deducts stock, creates Tally Sales Voucher, updates Google Sheets)
   */
  submitOrder(orderData: OrderRequest): Observable<OrderResponse> {
    return this.http.post<OrderResponse>(
      `${this.baseUrl}/orders`,
      orderData,
      { headers: this.getHeaders() }
    );
  }
}
```

---

### Step 3.4: Angular Component Example (Catalog & Checkout)
Create `src/app/components/saree-list/saree-list.component.ts`:

```typescript
import { Component, OnInit } from '@angular/core';
import { SareeStoreService } from '../../services/saree-store.service';
import { SareeProduct, SareeVariant, OrderRequest } from '../../models/saree.model';

@Component({
  selector: 'app-saree-list',
  templateUrl: './saree-list.component.html',
  styleUrls: ['./saree-list.component.css']
})
export class SareeListComponent implements OnInit {
  sarees: SareeProduct[] = [];
  selectedVariants: { [productSku: string]: SareeVariant } = {};
  isLoading = true;
  isSubmitting = false;
  orderFeedback: string | null = null;

  constructor(private sareeService: SareeStoreService) {}

  ngOnInit(): void {
    this.loadCatalog();
  }

  loadCatalog(): void {
    this.isLoading = true;
    this.sareeService.getProducts().subscribe({
      next: (res) => {
        this.sarees = res.products;
        // Default to first variant if product has color variants
        this.sarees.forEach(s => {
          if (s.variants && s.variants.length > 0) {
            this.selectedVariants[s.sku] = s.variants[0];
          }
        });
        this.isLoading = false;
      },
      error: (err) => {
        console.error('Failed to load catalog:', err);
        this.isLoading = false;
      }
    });
  }

  selectVariant(productSku: string, variant: SareeVariant): void {
    this.selectedVariants[productSku] = variant;
  }

  getActiveSku(saree: SareeProduct): string {
    return this.selectedVariants[saree.sku]?.sku || saree.sku;
  }

  getActiveStock(saree: SareeProduct): number {
    return this.selectedVariants[saree.sku]?.stock ?? saree.stock;
  }

  buyNow(saree: SareeProduct): void {
    const chosenVariant = this.selectedVariants[saree.sku];
    const itemSku = chosenVariant ? chosenVariant.sku : saree.sku;
    const itemName = chosenVariant ? chosenVariant.name : saree.name;
    const itemPrice = chosenVariant ? chosenVariant.price : saree.price;

    const orderPayload: OrderRequest = {
      order_id: `ANG-${Date.now().toString().slice(-6)}`,
      customer: {
        name: 'Online Shopper',
        phone: '+919876543210',
        email: 'customer@saitraders.in',
        address: 'MG Road, Bengaluru, Karnataka'
      },
      items: [
        {
          sku: itemSku,
          name: itemName,
          quantity: 1,
          price: itemPrice
        }
      ],
      total_amount: itemPrice,
      payment_status: 'paid',
      payment_method: 'Online Razorpay'
    };

    this.isSubmitting = true;
    this.orderFeedback = 'Processing purchase & syncing inventory...';

    this.sareeService.submitOrder(orderPayload).subscribe({
      next: (resp) => {
        this.isSubmitting = false;
        this.orderFeedback = `✅ Order Confirmed! (ID: ${resp.order_number}). Tally ERP & Google Sheets synced.`;
        // Refresh catalog to reflect new stock
        this.loadCatalog();
      },
      error: (err) => {
        this.isSubmitting = false;
        this.orderFeedback = `❌ Order failed: ${err.message || 'Unknown error'}`;
      }
    });
  }
}
```

---

### Step 3.5: Component Template (`saree-list.component.html`)

```html
<div class="container my-4">
  <header class="d-flex justify-content-between align-items-center mb-4">
    <h2>Sai Traders — Exclusive Saree Collection</h2>
    <span class="badge bg-primary fs-6">{{ sarees.length }} Sarees in Live Stock</span>
  </header>

  <div *ngIf="orderFeedback" class="alert alert-info">
    {{ orderFeedback }}
  </div>

  <div *ngIf="isLoading" class="text-center py-5">
    <div class="spinner-border text-primary" role="status"></div>
    <p class="mt-2">Connecting to Sai Traders Inventory...</p>
  </div>

  <div class="row row-cols-1 row-cols-md-3 g-4" *ngIf="!isLoading">
    <div class="col" *ngFor="let saree of sarees">
      <div class="card h-100 shadow-sm">
        <!-- Main Image -->
        <img
          [src]="(saree.image_urls && saree.image_urls.length > 0) ? saree.image_urls[0] : 'assets/placeholder-saree.jpg'"
          class="card-img-top"
          alt="{{ saree.name }}"
          style="height: 320px; object-fit: cover;"
        />

        <div class="card-body d-flex flex-column">
          <h5 class="card-title">{{ saree.name }}</h5>
          <p class="card-text text-muted small">{{ saree.fabric }} | {{ saree.weave }}</p>

          <!-- Color Swatches if Product has Variants -->
          <div *ngIf="saree.is_group && saree.variants?.length" class="mb-3">
            <label class="form-label small fw-bold">Select Color:</label>
            <div class="d-flex gap-2">
              <button
                *ngFor="let v of saree.variants"
                type="button"
                class="btn btn-sm"
                [class.btn-primary]="selectedVariants[saree.sku]?.sku === v.sku"
                [class.btn-outline-secondary]="selectedVariants[saree.sku]?.sku !== v.sku"
                (click)="selectVariant(saree.sku, v)"
              >
                {{ v.color }} ({{ v.stock }})
              </button>
            </div>
          </div>

          <!-- Price & Stock -->
          <div class="mt-auto d-flex justify-content-between align-items-center">
            <div>
              <span class="fs-5 fw-bold text-success">₹{{ saree.price | number }}</span>
              <del *ngIf="saree.mrp > saree.price" class="text-muted ms-2 small">₹{{ saree.mrp | number }}</del>
            </div>
            <span class="badge" [class.bg-success]="getActiveStock(saree) > 0" [class.bg-danger]="getActiveStock(saree) === 0">
              {{ getActiveStock(saree) > 0 ? getActiveStock(saree) + ' in stock' : 'Out of Stock' }}
            </span>
          </div>

          <!-- Action Button -->
          <button
            class="btn btn-dark w-100 mt-3"
            [disabled]="getActiveStock(saree) <= 0 || isSubmitting"
            (click)="buyNow(saree)"
          >
            {{ getActiveStock(saree) > 0 ? 'Buy Now' : 'Sold Out' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</div>
```

---

## 4. Verification Checklist

1. **Verify CORS**: From any browser console or Angular dev server (`http://localhost:4200`), run:
   ```javascript
   fetch('http://localhost:3000/api/v1/store/products', {
     headers: { 'x-api-key': 'sai_store_live_sec_892176' }
   }).then(r => r.json()).then(console.log);
   ```
2. **Verify Tally ERP**:
   - Check TallyPrime -> Display More Reports -> Inventory Books -> Godowns Summary -> **`Sarees`**.
   - After order placement, you will see a new **Sales Voucher** created under `Sarees` godown.
3. **Verify Google Sheets**:
   - The transaction row is appended immediately to your live Google Spreadsheet.
