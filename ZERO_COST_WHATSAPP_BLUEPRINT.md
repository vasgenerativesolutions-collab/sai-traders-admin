# Sai Traders — Zero-Cost WhatsApp Automation Blueprint

**Author:** KalpaCodes Engineering & Enterprise Operations  
**Target:** Shree Sai Traders (Saree Retail & E-Commerce)  
**Objective:** Maintain a 100% Free / Zero-Expense WhatsApp Automation Workflow  

---

## Executive Summary: How Meta WhatsApp Billing Works

Meta’s WhatsApp Cloud API does not charge per message for customer support; it charges **per 24-hour conversation session**.

| Conversation Type | Initiator | Meta Rate (India) | Free Tier Allowance |
| :--- | :--- | :--- | :--- |
| **Service (Customer-Initiated)** | **Customer messages you first** | **₹0.00** (Free Tier)<br>then ~₹0.14/msg | **First 1,000 conversations every calendar month are 100% FREE** |
| **Utility (Order/Shipping Updates)** | Business sends pre-approved template | ~₹0.115 (excl. GST) | Paid if initiated outside 24h window |
| **Marketing (Broadcasts, Promos)** | Business sends promotional blast | **₹0.8631** (excl. GST) | **Always Paid — Never Free** |

By strictly following the **7 Operational Rules** below, Sai Traders can process hundreds of saree inquiries and orders every month with **₹0 in Meta messaging bills**.

---

## The 7 Golden Rules to Keep WhatsApp Automation 100% Free

```
                     ┌──────────────────────────────────────────────┐
                     │ 1. NEVER MESSAGE FIRST (Inbound Only)       │
                     │    QR Code · Website Button · Insta Bio     │
                     └──────────────────────┬───────────────────────┘
                                            │
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │ 2. INSTANT & FULL FIRST REPLY               │
                     │    Photo + Specs + Live Stock + Buy Link     │
                     └──────────────────────┬───────────────────────┘
                                            │
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │ 3. WINDOW-RESET MICRO-PROMPTS               │
                     │    "Reply 2 for Stylist" · "Compare Photo"   │
                     │    (Every customer reply resets 24h timer!) │
                     └──────────────────────┬───────────────────────┘
                                            │
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │ 4. IMMEDIATE IN-WINDOW ORDER RECEIPTS        │
                     │    Send order confirmation while window is   │
                     │    still active (< 24h) for ₹0!             │
                     └──────────────────────┬───────────────────────┘
                                            │
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │ 5. ZERO PAID BROADCASTS POLICY              │
                     │    No marketing blasts (saves ₹0.863/msg)    │
                     └──────────────────────┬───────────────────────┘
                                            │
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │ 6. 72-HOUR FREE ENTRY POINTS                │
                     │    Facebook Page "WhatsApp" Action Button    │
                     └──────────────────────┬───────────────────────┘
                                            │
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │ 7. < 2-HOUR STYLIST ALERT PROTOCOL          │
                     │    Reply before 24h expires to keep it free │
                     └──────────────────────────────────────────────┘
```

---

### Rule 1: Never Message First (100% Inbound Architecture)

**The Rule:** Your bot or staff must **NEVER** initiate an unsolicited outbound message to a customer's phone number. Outbound messages require Meta pre-approved templates and cost up to ₹1.02 per message.

**How Customers Start the Chat (Free Channels):**
1. **Website Floating Button**: Add a persistent *"Chat with Saree Stylist on WhatsApp"* widget on your storefront.
2. **In-Store QR Codes**:
   - Counter Standee: *"Scan to check matching blouse pieces or get video drape on WhatsApp"*.
   - Saree Tag QR Code: Generates a pre-filled message: `Hi Sai Traders, I want to check availability for Saree SKU: SAI-VAR-01`.
3. **Printed Billing Receipts**: Add a small note at the bottom of Tally bills:  
   *"Save this number & WhatsApp us for styling advice and order status tracking"*.
4. **Social Media Bio Link**:  
   Direct link in your Instagram & Facebook profile:  
   `https://wa.me/916363777390?text=Namaste%20Sai%20Traders%20I%20am%20looking%20for%20sarees`

---

### Rule 2: Reply Instantly and in Full (All-in-One First Answer)

**The Rule:** When a customer sends a saree photo or asks about a design, deliver the complete answer in the very first interaction. Do not make them wait or send fragmented messages.

**First Reply Must Include:**
1. **High-Resolution Saree Photo / Keyframe**.
2. **Fabric & Craftsmanship Details** (e.g., Pure Kanjivaram Silk, 150 GSM Mysore Silk, Zari Brocade).
3. **Live Stock Availability** (e.g., `✅ 4 Pcs in Stock (Sarees Godown)`).
4. **Transparent Pricing** (e.g., `₹4,800 (MRP: ₹6,500 - 26% OFF)`).
5. **Direct "View & Buy" Link** pointing to the storefront checkout.

*Benefit:* Answering everything immediately satisfies customer intent inside the open window, leading to instant checkout.

---

### Rule 3: Keep the Customer Messaging to Reset the 24h Window

**The Rule:** Meta's 24-hour service timer **restarts from zero** every single time the customer sends a message.

**How to Trigger Replies Naturally:**  
Always end bot or stylist replies with a clear, short micro-prompt that encourages a tap or single-digit reply:
- *"Reply **1** to reserve this saree in your cart"*
- *"Reply **2** to speak with our Master Draper/Stylist for video inspection"*
- *"Send another saree photo or screenshot to compare fabrics!"*

Each time the customer types `2` or sends another picture, **the 24-hour clock resets for another full day of free messaging**.

---

### Rule 4: Move Conversations to the Website, but Send Receipts on WhatsApp Instantly

**The Rule:** Let your Angular website handle secure payment and cart management, but send the order confirmation message over WhatsApp **immediately** upon purchase.

- **Why Timing Matters:**  
  When a customer buys on your website, their WhatsApp 24-hour customer window is still active. Sending the order confirmation immediately costs **₹0**.
- **What Happens If You Wait > 24 Hours:**  
  If order status is sent 2 days later when shipping, the 24-hour window has expired. You must use a paid Meta **Utility Template** (~₹0.115).
- **Strategy:** Automatically dispatch the order receipt, confirmed SKU, and tracking link via webhook the moment `POST /api/v1/store/orders` succeeds.

---

### Rule 5: Don't Use Broadcasts or Follow-ups (Zero Marketing Spends)

**The Rule:** Do **not** send promotional broadcast messages, "New Festive Collection" blasts, or automated "You left something in your cart" notifications.

- **Cost Reality:**  
  Meta classifies promotional blasts and cart recovery pings as **Marketing Messages**, billed at **₹0.8631 + GST (~₹1.02) per recipient**.
  - A broadcast to 3,000 contacts = **₹3,060** for a single message!
- **Zero-Cost Alternative:**  
  Post your new saree arrivals and festive drops to your **WhatsApp Business Status (Stories)**, Instagram Reels, and Facebook Page for **100% free**. When interested customers message you about a status, their message opens a **free 24-hour service window**!

---

### Rule 6: Leverage 72-Hour Free Entry Points

**The Rule:** If a customer initiates a chat through specific Meta entry points, Meta grants an extended **72-hour Free Conversation Window** (instead of standard 24 hours), and does not charge for any messages exchanged during those 3 days.

**Free Entry Point Setup:**
1. Connect your WhatsApp Business number to your **Official Facebook Business Page**.
2. Set the primary Call-to-Action button on the page to **"Send WhatsApp Message"**.
3. Any customer who clicks that button to message your shop gets a **72-hour completely free communication window**.

---

### Rule 7: Handle Late Replies by Design (< 2-Hour Alert Protocol)

**The Rule:** If a customer is consulting with your human stylist about custom color variants, drape videos, or blouse stitching, the staff must reply before the 24-hour window closes.

**Operational SOP for Store Team:**
1. **The 22nd Hour Check:** If a customer inquiry has been open for 22 hours without final closure, an alert is triggered.
2. **Safe Micro-Prompt:** Staff or the bot sends a gentle check-in before the 24h deadline:  
   *"Namaste! Our stylist is holding this saree for you today. Would you like us to share matching blouse recommendations or hold the piece?"*
3. **Outcome:** When the customer replies, the free window is renewed for an additional 24 hours, completely avoiding any paid template charges.

---

## Monthly Cost Comparison: Standard vs. Zero-Cost Blueprint

| Scenario | Standard Practice | Zero-Cost Blueprint | Monthly Savings |
| :--- | :--- | :--- | :--- |
| **Inbound Customer Queries** | 1,000 chats/mo | 1,000 chats/mo | **₹0** *(Covered by Meta's 1,000 Free Tier)* |
| **Outbound Promotional Blasts** | 2 blasts/mo to 2,000 customers (₹4,080) | **₹0** (Use WhatsApp Status / Social Posts) | **+ ₹4,080 / month** |
| **Abandoned Cart Pings** | 400 marketing messages (₹408) | **₹0** (Incentivize complete first replies) | **+ ₹408 / month** |
| **Order Status Notifications** | Sent after 48h via Utility templates (₹230) | **₹0** (Dispatched instantly via storefront webhook) | **+ ₹230 / month** |
| **Total Meta WhatsApp Bill** | **~₹4,700 – ₹5,500 / month** | **₹0.00 / month** | **Save ₹50,000+ per year!** |

---

## Summary Checklist for Sai Traders Team

- [x] **Store QR Codes**: Placed at billing counter and on saree display tags.
- [x] **No Outbound Blasts**: Strict internal policy against mass promotional broadcasts.
- [x] **Instant First Replies**: Enabled with high-res photos, fabric details, stock counts, and prices.
- [x] **Micro-Prompts**: Prompts ("Reply 2 for Stylist") included to continuously reset the 24h clock.
- [x] **Storefront Webhook Receipts**: Web orders automatically notify customers on WhatsApp inside the open window.
- [x] **Facebook Button**: Configured to unlock the extended 72-hour free window.
- [x] **Stylist Protocol**: All customer consultations followed up within 22 hours.
