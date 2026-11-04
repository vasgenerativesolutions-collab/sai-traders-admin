/**
 * Tally ERP Integration & Real-time Stock Availability Connector
 *
 * Connects with Tally Prime / Tally ERP 9 via XML HTTP Gateway (port 9000),
 * with resilient fallback to Supabase synced catalog inventory.
 */

export interface TallyStockResult {
  found: boolean;
  sku: string;
  name: string;
  stockQuantity: number;
  isAvailable: boolean; // stockQuantity > 0
  price: number;
  mrp?: number;
  fabric?: string;
  color?: string;
  imageUrls?: string[];
  source: "tally_live" | "tally_synced_db" | "not_found";
  tallyStatusText?: string;
  rawDetails?: Record<string, unknown>;
}

/**
 * Parses numeric quantity from Tally XML string, e.g. "5.00 Pcs", "12 Nos", "0", "-1 Pcs"
 */
export function parseTallyQuantity(qtyStr: string | null | undefined): number {
  if (!qtyStr) return 0;
  // Match digits with optional decimals and sign
  const match = qtyStr.match(/([-+]?[0-9]+(?:\.[0-9]+)?)/);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  return isNaN(val) ? 0 : Math.max(0, Math.floor(val));
}

/**
 * Builds the standard Tally XML Export Request envelope for a stock item
 */
/**
 * Builds the standard Tally XML Export Request envelope
 */
export function buildTallyStockSummaryRequestXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Stock Summary</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <EXPLODEFLAG>Yes</EXPLODEFLAG>
          <ISITEMWISE>Yes</ISITEMWISE>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/**
 * Queries Tally Prime directly over HTTP XML Gateway on port 9000
 */
export async function queryTallyLive(
  itemCode: string,
  tallyUrl?: string
): Promise<{ success: boolean; stockQuantity?: number; rate?: number; rawXml?: string }> {
  const url = tallyUrl || Deno.env.get("TALLY_URL") || "http://127.0.0.1:9000";
  if (!url) {
    return { success: false };
  }

  const xmlPayload = buildTallyStockSummaryRequestXml();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s timeout

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml;charset=utf-8",
      },
      body: xmlPayload,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`Tally server responded with status: ${res.status}`);
      return { success: false };
    }

    const xmlResponse = await res.text();

    if (xmlResponse.includes("<LINEERROR>") || xmlResponse.includes("Unknown Request")) {
      return { success: false, rawXml: xmlResponse };
    }

    const normTarget = normalizeSku(itemCode);

    // Look for item in Stock Summary DSPDISPNAME blocks
    const itemRegex = /<DSPACCNAME>[\s\S]*?<DSPDISPNAME>([^<]+)<\/DSPDISPNAME>[\s\S]*?<\/DSPACCNAME>[\s\S]*?<DSPSTKCL>[\s\S]*?<DSPCLQTY>([^<]+)<\/DSPCLQTY>(?:[\s\S]*?<DSPCLRATE>([^<]+)<\/DSPCLRATE>)?/gi;

    let match;
    while ((match = itemRegex.exec(xmlResponse)) !== null) {
      const foundName = match[1].trim();
      const qtyStr = match[2].trim();
      const rateStr = match[3] ? match[3].trim() : "";

      if (normalizeSku(foundName) === normTarget || normalizeSku(foundName).includes(normTarget)) {
        const qty = parseTallyQuantity(qtyStr);
        const rate = parseFloat(rateStr.replace(/[^0-9.]/g, "")) || 0;
        return {
          success: true,
          stockQuantity: qty,
          rate: rate || undefined,
          rawXml: match[0],
        };
      }
    }

    // Fallback: Check standard CLOSINGBALANCE
    const closingBalMatch = xmlResponse.match(/<CLOSINGBALANCE>([^<]+)<\/CLOSINGBALANCE>/i);
    const rateMatch = xmlResponse.match(/<RATE>([^<]+)<\/RATE>/i);
    if (closingBalMatch) {
      const qty = parseTallyQuantity(closingBalMatch[1]);
      const rate = rateMatch ? parseFloat(rateMatch[1].replace(/[^0-9.]/g, "")) : 0;
      return {
        success: true,
        stockQuantity: qty,
        rate: rate || undefined,
        rawXml: xmlResponse,
      };
    }

    return { success: false, rawXml: xmlResponse };
  } catch (err) {
    console.warn(`Tally live query error for SKU ${itemCode}:`, err);
    return { success: false };
  }
}

/**
 * Normalizes SKU string for comparison (removes spaces, hyphens, uppercase)
 */
export function normalizeSku(sku: string): string {
  return sku.replace(/[\s\-_]/g, "").toUpperCase();
}

/**
 * Primary Stock Availability Checker:
 * 1. Checks live Tally ERP if reachable.
 * 2. Checks Supabase synced saree catalog.
 * 3. Returns standardized TallyStockResult with in-stock/out-of-stock determination.
 */
export async function checkTallyStockAvailability(
  productCode: string,
  // deno-lint-ignore no-explicit-any
  supabaseClient: any
): Promise<TallyStockResult> {
  const cleanCode = productCode.trim();
  const normalizedTarget = normalizeSku(cleanCode);

  // 1. Query Supabase saree_catalog first for product details & synced stock
  let dbItem: Record<string, unknown> | null = null;

  // Try exact SKU or Part Number match
  const { data: exactMatch } = await supabaseClient
    .from("saree_catalog")
    .select("*")
    .or(`sku.ilike.${cleanCode},tally_part_number.ilike.${cleanCode}`)
    .maybeSingle();

  if (exactMatch) {
    dbItem = exactMatch;
  } else {
    // Try matching without hyphens/spaces or substring
    const { data: allCatalog } = await supabaseClient
      .from("saree_catalog")
      .select("*");

    if (allCatalog && allCatalog.length > 0) {
      dbItem = allCatalog.find((item: Record<string, unknown>) => {
        const itemSkuNorm = normalizeSku(String(item.sku || ""));
        const itemPartNorm = normalizeSku(String(item.tally_part_number || ""));
        const itemNameNorm = normalizeSku(String(item.name || ""));
        return (
          itemSkuNorm === normalizedTarget ||
          itemSkuNorm.includes(normalizedTarget) ||
          normalizedTarget.includes(itemSkuNorm) ||
          itemPartNorm === normalizedTarget ||
          itemNameNorm === normalizedTarget ||
          itemNameNorm.includes(normalizedTarget) ||
          normalizedTarget.includes(itemNameNorm)
        );
      }) || null;
    }
  }

  // 2. Query live Tally Gateway: first with cleanCode, then with full name if needed
  let tallyLive = await queryTallyLive(cleanCode);
  if (!tallyLive.success && dbItem?.name && typeof dbItem.name === "string") {
    tallyLive = await queryTallyLive(dbItem.name);
  }

  // If live Tally responded successfully
  if (tallyLive.success && tallyLive.stockQuantity !== undefined) {
    const qty = tallyLive.stockQuantity;
    const isAvail = qty > 0;
    const itemPrice = dbItem?.price ? Number(dbItem.price) : (tallyLive.rate || 0);

    return {
      found: true,
      sku: (dbItem?.sku as string) || cleanCode,
      name: (dbItem?.name as string) || `Saree (${cleanCode})`,
      stockQuantity: qty,
      isAvailable: isAvail,
      price: itemPrice,
      mrp: (dbItem?.mrp as number) || undefined,
      fabric: (dbItem?.fabric as string) || undefined,
      color: (dbItem?.color_primary as string) || undefined,
      imageUrls: (dbItem?.image_urls as string[]) || [],
      source: "tally_live",
      tallyStatusText: isAvail ? `In Stock in Tally ERP (${qty} pcs in Online godown)` : "Out of Stock in Tally ERP",
      rawDetails: dbItem || undefined,
    };
  }

  // If we found the item in synced catalog
  if (dbItem) {
    const stockQty = Number(dbItem.stock_quantity ?? 0);
    const isAvail = (dbItem.is_active !== false) && stockQty > 0;

    return {
      found: true,
      sku: String(dbItem.sku || cleanCode),
      name: String(dbItem.name || `Saree ${cleanCode}`),
      stockQuantity: stockQty,
      isAvailable: isAvail,
      price: Number(dbItem.price || 0),
      mrp: dbItem.mrp ? Number(dbItem.mrp) : undefined,
      fabric: String(dbItem.fabric || ""),
      color: String(dbItem.color_primary || ""),
      imageUrls: (dbItem.image_urls as string[]) || [],
      source: "tally_synced_db",
      tallyStatusText: isAvail
        ? `In Stock (${stockQty} units available)`
        : "Out of Stock in Tally inventory",
      rawDetails: dbItem,
    };
  }

  // If product code is not found in either system, it's unavailable/out of stock
  return {
    found: false,
    sku: cleanCode,
    name: `Saree Code ${cleanCode}`,
    stockQuantity: 0,
    isAvailable: false,
    price: 0,
    source: "not_found",
    tallyStatusText: "Product code not found in Tally / Out of Stock",
  };
}

/**
 * Automatically pushes a Sales Voucher to TallyPrime to deduct stock in real time from Online Godown
 */
export async function pushTallySalesVoucher(
  orderNumber: string,
  sku: string,
  qty: number,
  rate: number,
  tallyUrl?: string,
  godownName: string = "Online",
  stockItemName?: string
): Promise<{ success: boolean; response?: string }> {
  const url = tallyUrl || Deno.env.get("TALLY_URL") || "http://127.0.0.1:9000";
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dateStr = `${year}${month}${day}`;
  const totalAmount = (qty * rate).toFixed(2);
  const targetItem = stockItemName || sku;
  const isNosUnit = /mysore|paithani|0021/i.test(targetItem + sku);
  const unitLabel = isNosUnit ? "Nos" : "Pcs";

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Sales" ACTION="Create">
            <DATE>${dateStr}</DATE>
            <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${orderNumber}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
            
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>Cash</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
              <AMOUNT>-${totalAmount}</AMOUNT>
            </LEDGERENTRIES.LIST>

            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${targetItem}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <RATE>${rate.toFixed(2)}/${unitLabel}</RATE>
              <AMOUNT>${totalAmount}</AMOUNT>
              <ACTUALQTY>${qty} ${unitLabel}</ACTUALQTY>
              <BILLEDQTY>${qty} ${unitLabel}</BILLEDQTY>
              <BATCHALLOCATIONS.LIST>
                <GODOWNNAME>${godownName}</GODOWNNAME>
                <BATCHNAME>Primary Batch</BATCHNAME>
                <AMOUNT>${totalAmount}</AMOUNT>
                <ACTUALQTY>${qty} ${unitLabel}</ACTUALQTY>
                <BILLEDQTY>${qty} ${unitLabel}</BILLEDQTY>
              </BATCHALLOCATIONS.LIST>
              <ACCOUNTINGALLOCATIONS.LIST>
                <LEDGERNAME>Sales Account</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>${totalAmount}</AMOUNT>
              </ACCOUNTINGALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/xml;charset=utf-8" },
      body: xml,
    });
    const text = await res.text();
    const isSuccess = text.includes("<CREATED>1</CREATED>") || text.includes("<ALTERED>1</ALTERED>");
    return { success: isSuccess, response: text };
  } catch (err) {
    console.warn(`Failed to push sales voucher to Tally for order ${orderNumber}:`, err);
    return { success: false };
  }
}

