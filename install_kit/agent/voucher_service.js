const { sendToTally } = require('./tally_client');

/**
 * Builds the Tally XML Sales Voucher to deduct inventory
 */
function buildSalesVoucherXml({ orderNumber, sku, qty, rate, customerName }) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dateStr = `${year}${month}${day}`;
  const totalAmount = (qty * rate).toFixed(2);

  return `<?xml version="1.0" encoding="utf-8"?>
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
            <NARRATION>WhatsApp Order ${orderNumber} - Buyer: ${customerName || "WhatsApp Customer"}</NARRATION>
            
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>Cash</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
              <AMOUNT>-${totalAmount}</AMOUNT>
            </LEDGERENTRIES.LIST>

            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${sku}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <RATE>${rate.toFixed(2)}/Pcs</RATE>
              <AMOUNT>${totalAmount}</AMOUNT>
              <ACTUALQTY>${qty} Pcs</ACTUALQTY>
              <BILLEDQTY>${qty} Pcs</BILLEDQTY>
              <BATCHALLOCATIONS.LIST>
                <GODOWNNAME>Main Location</GODOWNNAME>
                <BATCHNAME>Primary Batch</BATCHNAME>
                <AMOUNT>${totalAmount}</AMOUNT>
                <ACTUALQTY>${qty} Pcs</ACTUALQTY>
                <BILLEDQTY>${qty} Pcs</BILLEDQTY>
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
}

/**
 * Executes stock deduction in TallyPrime for an order item
 */
async function deductStockInTally(order, item) {
  const sku = item.sku;
  const qty = item.quantity || 1;
  const rate = item.price || 0;
  const customerName = order.shipping_address?.street || "WhatsApp Buyer";

  const xml = buildSalesVoucherXml({
    orderNumber: order.order_number,
    sku,
    qty,
    rate,
    customerName
  });

  try {
    const res = await sendToTally(xml);
    const success = res.body.includes("<CREATED>1</CREATED>") || 
                    res.body.includes("<ALTERED>1</ALTERED>") ||
                    res.body.includes("<EXCEPTIONS>0</EXCEPTIONS>");
    
    return {
      success,
      sku,
      qty,
      orderNumber: order.order_number,
      rawResponse: res.body
    };
  } catch (err) {
    return {
      success: false,
      sku,
      error: err.message
    };
  }
}

module.exports = {
  buildSalesVoucherXml,
  deductStockInTally
};
