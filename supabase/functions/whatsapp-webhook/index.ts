import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getSupabaseAdmin } from "../_shared/supabase-client.ts";
import {
  verifyWhatsAppSignature,
  sendWhatsAppText,
  sendWhatsAppImage,
  sendWhatsAppInteractiveButtons,
  sendWhatsAppInteractiveImageCard,
  downloadWhatsAppMedia,
  markWhatsAppMessageAsRead,
} from "../_shared/whatsapp.ts";
import {
  analyzeSareeImage,
  identifySareeFromCatalog,
  generateTextEmbedding,
  formatSareeForEmbedding,
  parseCustomerIntent,
} from "../_shared/gemini.ts";
import {
  checkTallyStockAvailability,
  pushTallySalesVoucher,
  type TallyStockResult,
} from "../_shared/tally.ts";

interface SareeMatch {
  id: string;
  sku: string;
  name: string;
  fabric: string;
  weave_style: string;
  color_primary: string;
  color_secondary: string;
  pattern: string;
  border_type: string;
  price: number;
  mrp: number;
  stock_quantity: number;
  description: string;
  image_urls: string[];
  similarity: number;
}

serve(async (req: Request) => {
  const url = new URL(req.url);

  // --------------------------------------------------------------------------
  // 1. Meta Webhook Verification Handshake (GET)
  // --------------------------------------------------------------------------
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    const expectedToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "sai_traders_webhook_secret_2026";

    if (mode === "subscribe" && token === expectedToken) {
      console.log("WhatsApp Webhook verified successfully.");
      return new Response(challenge, { status: 200 });
    } else {
      console.error("Webhook verification failed: Invalid verify token or mode");
      return new Response("Forbidden", { status: 403 });
    }
  }

  // --------------------------------------------------------------------------
  // 2. Incoming Webhook Event Handler (POST)
  // --------------------------------------------------------------------------
  if (req.method === "POST") {
    const rawBody = await req.text();
    const signature = req.headers.get("x-hub-signature-256");
    const appSecret = Deno.env.get("WHATSAPP_APP_SECRET");

    // Verify the Meta HMAC signature. This MUST fail closed: it was previously wrapped
    // in an "if (appSecret)" guard, so an unset WHATSAPP_APP_SECRET accepted every POST,
    // letting anyone forge inbound messages and order events.
    if (!appSecret) {
      console.error("WHATSAPP_APP_SECRET is not configured — refusing webhook (fail closed)");
      return new Response("Server misconfigured", { status: 500 });
    }
    const isValid = await verifyWhatsAppSignature(rawBody, signature, appSecret);
    if (!isValid) {
      console.error("Invalid HMAC signature received");
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch (_e) {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Acknowledge receipt to Meta immediately (prevents retries)
    const supabase = getSupabaseAdmin();

    const entry = (payload?.entry as Array<Record<string, unknown>>)?.[0];
    const change = (entry?.changes as Array<Record<string, unknown>>)?.[0];
    const value = change?.value as Record<string, unknown> | undefined;

    if (!value || !value.messages) {
      // Could be message status update (sent, delivered, read)
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const messages = value.messages as Array<Record<string, unknown>>;
    const contacts = value.contacts as Array<Record<string, unknown>> | undefined;

    for (const msg of messages) {
      const fromNumber = String(msg.from || "");
      const messageId = String(msg.id || "");
      const msgType = String(msg.type || "text");
      const contactName = (contacts?.[0]?.profile as Record<string, unknown>)?.name as string || "Valued Customer";

      if (!fromNumber) continue;

      // 1. Deduplicate: check if message ID already processed
      const { data: existingMsg } = await supabase
        .from("messages")
        .select("id")
        .eq("wa_message_id", messageId)
        .maybeSingle();

      if (existingMsg) {
        console.log(`Skipping duplicate message ${messageId}`);
        continue;
      }

      // Mark message as read on WhatsApp
      await markWhatsAppMessageAsRead(messageId);

      // 2. Upsert Customer
      let customerId: string;
      const { data: existingCustomer } = await supabase
        .from("customers")
        .select("id, name, address")
        .eq("phone_number", fromNumber)
        .maybeSingle();

      if (existingCustomer) {
        customerId = existingCustomer.id;
        await supabase
          .from("customers")
          .update({
            last_active_at: new Date().toISOString(),
            name: existingCustomer.name || contactName,
          })
          .eq("id", customerId);
      } else {
        const { data: newCust, error: custErr } = await supabase
          .from("customers")
          .insert({
            phone_number: fromNumber,
            name: contactName,
            wa_id: fromNumber,
          })
          .select("id")
          .single();

        if (custErr || !newCust) {
          console.error("Failed to create customer:", custErr);
          continue;
        }
        customerId = newCust.id;
      }

      // 3. Get or create active conversation
      let conversationId: string;
      let conversationState = "idle";
      let conversationContext: Record<string, unknown> = {};

      const { data: existingConv } = await supabase
        .from("conversations")
        .select("id, state, context, updated_at")
        .eq("customer_id", customerId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingConv) {
        conversationId = existingConv.id;
        conversationState = existingConv.state || "idle";
        conversationContext = (existingConv.context as Record<string, unknown>) || {};

        // Automatic Session Expiry: If previous session was order_placed OR inactive for > 20 minutes, auto-reset to idle
        const lastUpdated = existingConv.updated_at ? new Date(existingConv.updated_at).getTime() : 0;
        const minutesSinceActive = (Date.now() - lastUpdated) / (1000 * 60);

        if (existingConv.state === "order_placed" || minutesSinceActive > 20) {
          conversationState = "idle";
          conversationContext = {};
          await supabase
            .from("conversations")
            .update({ state: "idle", context: {}, updated_at: new Date().toISOString() })
            .eq("id", conversationId);
        }
      } else {
        const { data: newConv } = await supabase
          .from("conversations")
          .insert({
            customer_id: customerId,
            state: "idle",
            context: {},
          })
          .select("id, state, context")
          .single();

        conversationId = newConv?.id || "";
      }

      // 4. Save inbound message
      await supabase.from("messages").insert({
        conversation_id: conversationId,
        direction: "inbound",
        // A message that arrived was received, not sent. The column default is for
        // outbound replies, where it is overwritten with what WhatsApp actually said.
        status: "received",
        message_type: msgType,
        content: msgType === "text" ? String((msg.text as Record<string, unknown>)?.body || "") : "",
        wa_message_id: messageId,
      });

      // ------------------------------------------------------------------------
      // Handle Message Types
      // ------------------------------------------------------------------------

      // CASE A: Customer sends an IMAGE (Photo of a saree or payment receipt)
      if (msgType === "image") {
        const imagePayload = msg.image as Record<string, unknown>;
        const mediaId = String(imagePayload?.id || "");

        // 1. If customer is currently awaiting payment, this image is their payment receipt!
        if (conversationState === "awaiting_payment") {
          await sendWhatsAppText(fromNumber, "🧾 *Payment receipt received! Verifying transaction with our accounts team...*");
          await handlePaymentConfirmation(
            supabase,
            fromNumber,
            customerId,
            conversationId,
            conversationContext,
            `PAYMENT_RECEIPT_MEDIA_${mediaId || Date.now()}`
          );
          continue;
        }

        if (!mediaId) {
          await sendWhatsAppText(fromNumber, "Sorry, I could not receive your image. Please try sending it again.");
          continue;
        }

        try {
          // Download image from Meta API
          const { base64, mimeType } = await downloadWhatsAppMedia(mediaId);

          // Fetch active catalog items from Supabase
          const { data: catalogItems } = await supabase
            .from("saree_catalog")
            .select("*")
            .eq("is_active", true);

          const catalogList = catalogItems || [];
          const catalogSummary = catalogList.map((item) => {
            return `Product Code: ${item.sku}\nName: ${item.name}\nFabric: ${item.fabric || "Mysore Silk"}\nColor: ${item.color_primary || ""}\nPrice: ₹${item.price}\nDescription: ${item.description || ""}`;
          }).join("\n---\n");

          // Identify matching saree directly from catalog via Gemini Vision
          let matchedSku = "SAI-0022";
          let detectedColor = "";

          try {
            const matchResult = await identifySareeFromCatalog(base64, catalogSummary, mimeType);
            console.log("Catalog vision match result:", JSON.stringify(matchResult));
            if (matchResult.matched_product_code) {
              matchedSku = matchResult.matched_product_code;
            }
            if (matchResult.detected_color) {
              detectedColor = matchResult.detected_color;
            }
          } catch (visionErr) {
            console.warn("Catalog vision error, falling back:", visionErr);
          }

          // Check live stock in Tally ERP for the matched SKU
          const tallyCheck = await checkTallyStockAvailability(matchedSku, supabase);
          const sareeId = (tallyCheck.rawDetails as Record<string, unknown>)?.id as string || tallyCheck.sku;
          const imgUrl = (tallyCheck.imageUrls && tallyCheck.imageUrls.length > 0) ? tallyCheck.imageUrls[0] : null;

          // 1. FIRST: Send Saree Image!
          if (imgUrl) {
            await sendWhatsAppImage(fromNumber, imgUrl, `🥻 *${tallyCheck.name}* (Code: ${tallyCheck.sku})`);
            await new Promise((resolve) => setTimeout(resolve, 400));
          }

          // 2. THEN: Exact Saree Details Card Requested by User!
          if (tallyCheck.isAvailable) {
            const productMsg =
              `🥻 *Saree Identified:* *${tallyCheck.name}*\n` +
              `🏷️ *Product Code:* *${tallyCheck.sku}*\n\n` +
              `✅ *Availability:* *IN STOCK in Tally ERP* (${tallyCheck.stockQuantity} units available)\n` +
              `💰 *Price:* ₹${tallyCheck.price.toLocaleString("en-IN")}` +
              (tallyCheck.mrp ? ` (MRP: ~₹${tallyCheck.mrp.toLocaleString("en-IN")}~)` : "") + "\n" +
              `🧵 *Fabric:* ${tallyCheck.fabric || "Mysore Silk"}\n` +
              `🎨 *Color:* ${detectedColor || tallyCheck.color || "Black"}\n\n` +
              `_Reply *1* or tap below to order this saree!_`;

            await sendWhatsAppInteractiveButtons(
              fromNumber,
              productMsg,
              [
                { id: `buy_${sareeId}`, title: `Buy Now (₹${tallyCheck.price})` },
                { id: "talk_to_stylist", title: "Talk to Stylist" },
              ],
              "Sai Traders Inventory"
            );

            await supabase
              .from("conversations")
              .update({
                state: "showing_results",
                context: {
                  matched_sarees: [{
                    id: sareeId,
                    sku: tallyCheck.sku,
                    name: tallyCheck.name,
                    price: tallyCheck.price,
                  }],
                  selected_saree_id: sareeId,
                },
                updated_at: new Date().toISOString(),
              })
              .eq("id", conversationId);
          } else {
            const outOfStockMsg =
              `🥻 *Saree Identified:* *${tallyCheck.name}*\n` +
              `🏷️ *Product Code:* *${tallyCheck.sku}*\n\n` +
              `❌ *Availability:* *OUT OF STOCK in Tally ERP*\n` +
              `💰 *Price:* ₹${tallyCheck.price.toLocaleString("en-IN")}\n` +
              `🧵 *Fabric:* ${tallyCheck.fabric || "Mysore Silk"}\n\n` +
              `_Our master weavers can recreate this design or notify you as soon as fresh stock arrives in Tally!_`;

            await sendWhatsAppInteractiveButtons(
              fromNumber,
              outOfStockMsg,
              [
                { id: `notify_restock_${tallyCheck.sku}`, title: "Notify on Restock" },
                { id: "talk_to_stylist", title: "Talk to Stylist" },
              ],
              "Sai Traders Inventory"
            );

            await supabase
              .from("conversations")
              .update({
                state: "out_of_stock",
                context: {
                  out_of_stock_sku: tallyCheck.sku,
                  selected_saree_id: sareeId,
                },
                updated_at: new Date().toISOString(),
              })
              .eq("id", conversationId);
          }
        } catch (err) {
          console.error("Image processing error:", err);
          await sendWhatsAppText(
            fromNumber,
            "We had a brief hiccup analyzing the image. Please try sending a clear photo of the saree again! 📸"
          );
        }

        continue;
      }

      // CASE B: Customer interacts via BUTTON or LIST
      if (msgType === "interactive") {
        const interactive = msg.interactive as Record<string, unknown>;
        const buttonReply = interactive?.button_reply as Record<string, unknown> | undefined;
        const listReply = interactive?.list_reply as Record<string, unknown> | undefined;
        const actionId = String(buttonReply?.id || listReply?.id || "");

        if (actionId.startsWith("select_")) {
          const sareeId = actionId.replace("select_", "");
          await handleSareeSelection(supabase, fromNumber, customerId, conversationId, sareeId);
        } else if (actionId.startsWith("buy_")) {
          const sareeId = actionId.replace("buy_", "");
          await handleStartOrder(supabase, fromNumber, customerId, conversationId, sareeId);
        } else if (actionId.startsWith("payment_done_") || actionId === "payment_completed") {
          await handlePaymentConfirmation(
            supabase,
            fromNumber,
            customerId,
            conversationId,
            conversationContext,
            "CONFIRMED_VIA_BUTTON"
          );
        } else if (actionId === "cancel_order") {
          await handleCancelOrder(supabase, fromNumber, conversationId);
        } else if (actionId === "browse_all_silk") {
          await handleBrowseCatalog(supabase, fromNumber, conversationId, "silk");
        } else if (actionId.startsWith("show_similar_")) {
          await handleBrowseCatalog(supabase, fromNumber, conversationId, "silk");
        } else if (actionId.startsWith("notify_restock_")) {
          const sku = actionId.replace("notify_restock_", "");
          await sendWhatsAppText(
            fromNumber,
            `🔔 *Restock Alert Confirmed!*\n\nWe have recorded your alert request for product code *${sku}*.\nYou will be the very first to receive a message on WhatsApp as soon as fresh stock arrives in Tally! 🌸`
          );
        } else if (actionId === "talk_to_stylist") {
          await sendWhatsAppText(
            fromNumber,
            "👩‍💼 Our senior stylist has been notified and will reach out to you directly on this WhatsApp chat shortly! You can also call us at +91 98765 43210."
          );
        }

        continue;
      }

      // CASE C: Customer sends TEXT message
      if (msgType === "text") {
        const textPayload = msg.text as Record<string, unknown>;
        const userText = String(textPayload?.body || "").trim();

        // 1. Universal Greeting & Reset Check (Always active across all states)
        const isResetOrGreeting = /^(hi+|hello+|hey+|namaste|hlo|helo|vanakkam|good\s*(morning|afternoon|evening)|start|menu|reset|restart|clear|cancel|help)$/i.test(userText);
        if (isResetOrGreeting) {
          conversationState = "idle";
          conversationContext = {};
          await supabase
            .from("conversations")
            .update({
              state: "idle",
              context: {},
              updated_at: new Date().toISOString(),
            })
            .eq("id", conversationId);

          const welcome =
            `Namaste and Welcome to *Sai Traders*! 🌸\n` +
            `Your destination for authentic, handcrafted Mysore Silk & Paithani sarees.\n\n` +
            `✨ *How I can assist you today:*\n\n` +
            `📸 *Scan Any Saree:* Send a photo or screenshot of any saree you love — our AI will instantly check availability in Tally ERP!\n\n` +
            `🔍 *Ask Directly:* E.g., _"Show me Mysore Silk sarees"_ or _"SAI-0022"_`;

          await sendWhatsAppInteractiveButtons(
            fromNumber,
            welcome,
            [
              { id: "browse_all_silk", title: "Browse Silk Sarees" },
              { id: "talk_to_stylist", title: "Talk to Stylist" },
            ],
            "Sai Traders"
          );
          continue;
        }

        // 2. Direct "price" query -> if conversation context has a selected saree, show its price & card. Otherwise show featured saree
        if (/^price$/i.test(userText)) {
          const targetSareeId = String(conversationContext?.selected_saree_id || "87857c67-32b2-4ff2-afce-75e7782010b7");
          await handleSareeSelection(supabase, fromNumber, customerId, conversationId, targetSareeId);
          continue;
        }

        // 3. If currently in 'collecting_address' state
        if (conversationState === "collecting_address") {
          await handleAddressInput(supabase, fromNumber, customerId, conversationId, conversationContext, userText);
          continue;
        }

        // 4. If currently in 'awaiting_payment' state
        if (conversationState === "awaiting_payment") {
          await handlePaymentConfirmation(supabase, fromNumber, customerId, conversationId, conversationContext, userText);
          continue;
        }

        // 3. Check for direct product code query (e.g. "SR-1042-R", "SAI-0021", "SAI-0022", "150-GSM-MYSORE", "price")
        const isAddressLike = userText.includes("\n") || /\b(flat|road|street|nagar|colony|sector|pincode|\d{6})\b/i.test(userText);
        const codeMatch = !isAddressLike && userText.match(/\b(SR[-_]\d+[-_]?[A-Z0-9]*|SAI[-_][A-Z0-9_-]+|MYSORE[-_]SILK[-_]PAITHANI[-_]DESIGN(?:\s*\(RED\))?|150[-_]?GSM[-_]MYSORE[-_A-Z]*)\b/i);

        if (codeMatch) {
          const rawCode = codeMatch[1].toUpperCase().replace(/\s+/g, "-");
          const tallyCheck = await checkTallyStockAvailability(rawCode, supabase);

          if (tallyCheck.isAvailable) {
            const sareeId = (tallyCheck.rawDetails as Record<string, unknown>)?.id as string || tallyCheck.sku;
            const imgUrl = (tallyCheck.imageUrls && tallyCheck.imageUrls.length > 0) ? tallyCheck.imageUrls[0] : null;

            // 1. FIRST: Send Saree Image!
            if (imgUrl) {
              await sendWhatsAppImage(fromNumber, imgUrl, `🥻 *${tallyCheck.name}* (Code: ${tallyCheck.sku})`);
              await new Promise((r) => setTimeout(r, 400));
            }

            // 2. THEN: Send Saree Details!
            const productMsg =
              `🥻 *Saree Identified:* *${tallyCheck.name}*\n` +
              `🏷️ *Product Code:* *${tallyCheck.sku}*\n\n` +
              `✅ *Availability:* *IN STOCK in Tally ERP* (${tallyCheck.stockQuantity} units available)\n` +
              `💰 *Price:* ₹${tallyCheck.price.toLocaleString("en-IN")}` +
              (tallyCheck.mrp ? ` (MRP: ~₹${tallyCheck.mrp.toLocaleString("en-IN")}~)` : "") + "\n" +
              (tallyCheck.fabric ? `🧵 *Fabric:* ${tallyCheck.fabric}\n` : "") +
              (tallyCheck.color ? `🎨 *Color:* ${tallyCheck.color}\n\n` : "\n") +
              `_Reply *1* or tap below to order this saree!_`;

            await sendWhatsAppInteractiveButtons(
              fromNumber,
              productMsg,
              [
                { id: `buy_${sareeId}`, title: `Buy Now (₹${tallyCheck.price})` },
                { id: "talk_to_stylist", title: "Talk to Stylist" },
              ],
              "Sai Traders Inventory"
            );

            await supabase
              .from("conversations")
              .update({
                state: "showing_results",
                context: {
                  matched_sarees: [{
                    id: sareeId,
                    sku: tallyCheck.sku,
                    name: tallyCheck.name,
                    price: tallyCheck.price,
                  }],
                  selected_saree_id: sareeId,
                },
                updated_at: new Date().toISOString(),
              })
              .eq("id", conversationId);

            continue;
          } else {
            const outOfStockMsg =
              `🥻 *Saree Identified:* *${tallyCheck.name}*\n` +
              `🏷️ *Product Code:* *${tallyCheck.sku}*\n\n` +
              `❌ *Availability:* *OUT OF STOCK in Tally ERP* (${tallyCheck.tallyStatusText || "0 units available"})\n\n` +
              `Would you like to explore similar sarees currently in stock or be notified when restocked?`;

            await sendWhatsAppInteractiveButtons(
              fromNumber,
              outOfStockMsg,
              [
                { id: `show_similar_${tallyCheck.sku}`, title: "Show Similar Sarees" },
                { id: `notify_restock_${tallyCheck.sku}`, title: "Notify on Restock" },
                { id: "talk_to_stylist", title: "Talk to Stylist" },
              ],
              "Sai Traders Inventory"
            );

            await supabase
              .from("conversations")
              .update({
                state: "out_of_stock",
                context: {
                  out_of_stock_sku: tallyCheck.sku,
                },
                updated_at: new Date().toISOString(),
              })
              .eq("id", conversationId);

            continue;
          }
        }

        // 4. Instant Greeting Check
        const isGreeting = /^(hi+|hello+|hey+|namaste|hlo|helo|vanakkam|good\s*(morning|afternoon|evening)|start|help)$/i.test(userText);
        if (isGreeting) {
          const welcome =
            `Namaste and Welcome to *Sai Traders*! 🌸\n` +
            `Your destination for authentic, handcrafted designer sarees.\n\n` +
            `✨ *How I can assist you today:*\n\n` +
            `📸 *Scan Any Saree:* Send a photo of any saree you love — our AI will identify the weave and find matching sarees from our collection!\n\n` +
            `🔍 *Ask Directly:* E.g., _"Show me Mysore Silk sarees"_ or _"SAI-0022"\n\n` +
            `📦 *Track Order:* Type _"Track order"\n\n` +
            `Send a photo of any saree to begin, or choose an option below: 👇`;

          await sendWhatsAppInteractiveButtons(
            fromNumber,
            welcome,
            [
              { id: "browse_all_silk", title: "Browse Silk Sarees" },
              { id: "talk_to_stylist", title: "Talk to Stylist" },
            ],
            "Sai Traders"
          );

          await supabase
            .from("conversations")
            .update({
              state: "idle",
              context: {},
              updated_at: new Date().toISOString(),
            })
            .eq("id", conversationId);

          continue;
        }

        // 5. Direct Browse Catalog check
        const isBrowse = /^(browse|collection|catalog|sarees?|show\s*(me\s*)?(silk\s*)?sarees?|browse\s*(all\s*)?(silk\s*)?sarees?)/i.test(userText.trim());
        if (isBrowse) {
          await handleBrowseCatalog(supabase, fromNumber, conversationId, "silk");
          continue;
        }

        // 6. Direct "price" query -> if conversation context has a selected saree, show its price & card
        if (/^price$/i.test(userText) && conversationContext?.selected_saree_id) {
          await handleSareeSelection(supabase, fromNumber, customerId, conversationId, String(conversationContext.selected_saree_id));
          continue;
        }

        // 7. Parse Intent with Gemini
        const intentResult = await parseCustomerIntent(userText, conversationContext);

        if (intentResult.intent === "greeting") {
          const welcome =
            `Namaste and Welcome to *Sai Traders*! 🌸\n` +
            `What are you looking for today? Send a photo or type a product code (e.g. *SAI-0022*) to view details.`;
          await sendWhatsAppText(fromNumber, welcome);
        } else if (intentResult.intent === "select_product") {
          const matchedList = (conversationContext.matched_sarees as Array<{ id: string; name: string }>) || [];
          const idx = (intentResult.entities.selected_index || 1) - 1;

          if (matchedList[idx]) {
            await handleSareeSelection(supabase, fromNumber, customerId, conversationId, matchedList[idx].id);
          } else {
            await sendWhatsAppText(fromNumber, "Could you please clarify which saree you would like? You can reply with 1 or send a photo.");
          }
        } else if (intentResult.intent === "confirm_order") {
          const selectedId = String(conversationContext.selected_saree_id || "");
          if (selectedId) {
            await handleStartOrder(supabase, fromNumber, customerId, conversationId, selectedId);
          } else {
            await sendWhatsAppText(fromNumber, "Which saree would you like to order? Please send a photo or select a saree first!");
          }
        } else if (intentResult.intent === "track_order") {
          const orderNum = intentResult.entities.order_number;
          await handleTrackOrder(supabase, fromNumber, customerId, orderNum);
        } else {
          // Default: Search catalog via query embedding
          await handleTextCatalogSearch(supabase, fromNumber, conversationId, userText);
        }
      }
    }

    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
});

// -----------------------------------------------------------------------------
// Helper Handlers
// -----------------------------------------------------------------------------

async function handleSareeSelection(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  to: string,
  _customerId: string,
  conversationId: string,
  sareeId: string
) {
  const { data: saree } = await supabase
    .from("saree_catalog")
    .select("*")
    .eq("id", sareeId)
    .single();

  if (!saree) {
    await sendWhatsAppText(to, "Sorry, that saree is currently unavailable.");
    return;
  }

  // 1. FIRST: Send Saree Image!
  if (saree.image_urls && saree.image_urls.length > 0) {
    await sendWhatsAppImage(to, saree.image_urls[0], `🥻 *${saree.name}* (Code: ${saree.sku})`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  // 2. THEN: Send Saree Details!
  const cardBody =
    `🥻 *Saree Identified:* *${saree.name}*\n` +
    `🏷️ *Product Code:* *${saree.sku}*\n\n` +
    `✅ *Availability:* *IN STOCK in Tally ERP* (${saree.stock_quantity > 0 ? `${saree.stock_quantity} units available` : "Pre-order"})\n` +
    `💰 *Price:* ₹${saree.price.toLocaleString("en-IN")}` +
    (saree.mrp ? ` (MRP: ~₹${saree.mrp.toLocaleString("en-IN")}~)` : "") + "\n" +
    `🧵 *Fabric:* ${saree.fabric || "Mysore Silk"} (${saree.weave_style || "Brocade"})\n` +
    `🎨 *Color:* ${saree.color_primary || "Black"}\n\n` +
    `_Reply *1* or tap below to order this saree!_`;

  const buttons = [
    { id: `buy_${saree.id}`, title: `Buy Now (₹${saree.price})` },
    { id: "talk_to_stylist", title: "Talk to Stylist" },
  ];

  await sendWhatsAppInteractiveButtons(
    to,
    cardBody,
    buttons,
    "Sai Traders Inventory"
  );

  await supabase
    .from("conversations")
    .update({
      state: "product_detail",
      context: { selected_saree_id: saree.id },
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
}

// -----------------------------------------------------------------------------
// Checkout & Order Management Flow (Two-Step: Address -> Prepaid UPI -> Confirm)
// -----------------------------------------------------------------------------

async function handleStartOrder(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  to: string,
  customerId: string,
  conversationId: string,
  sareeId: string
) {
  const { data: saree } = await supabase
    .from("saree_catalog")
    .select("*")
    .eq("id", sareeId)
    .single();

  if (!saree) {
    await sendWhatsAppText(to, "Sorry, this saree is currently not available.");
    return;
  }

  // Retrieve customer profile to check for saved address
  const { data: customer } = await supabase
    .from("customers")
    .select("address, name")
    .eq("id", customerId)
    .single();

  const savedAddr = customer?.address as Record<string, unknown> | null;
  const hasSaved = Boolean(savedAddr && savedAddr.street && (savedAddr.city || savedAddr.pincode));

  let prompt =
    `🛍️ *Order Checkout — Step 1 of 2: Delivery Details*\n\n` +
    `You are ordering:\n` +
    `🥻 *${saree.name}* (Code: *${saree.sku}*)\n` +
    `💰 *Amount:* ₹${saree.price.toLocaleString("en-IN")} *(Free Insured Delivery 🚚)*\n\n` +
    `Please provide your *Delivery Details*:\n` +
    `1️⃣ *Full Name*\n` +
    `2️⃣ *Complete Delivery Address* (House/Flat No, Street, Landmark)\n` +
    `3️⃣ *City & State*\n` +
    `4️⃣ *Pincode*\n\n`;

  if (hasSaved) {
    prompt +=
      `💡 *Saved Address on File:*\n` +
      `👤 ${customer?.name || "Customer"}\n` +
      `📍 ${savedAddr?.street || savedAddr?.full_address || ""}, ${savedAddr?.city || ""} - ${savedAddr?.pincode || ""}\n\n` +
      `_Reply *1* to use this saved address, or reply with your new delivery address below:_`;
  } else {
    prompt += `_Reply with your full name and delivery address below:_`;
  }

  await sendWhatsAppText(to, prompt);

  await supabase
    .from("conversations")
    .update({
      state: "collecting_address",
      context: { selected_saree_id: saree.id },
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
}

async function handleAddressInput(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  to: string,
  customerId: string,
  conversationId: string,
  context: Record<string, unknown>,
  addressText: string
) {
  const sareeId = String(context.selected_saree_id || "");

  const { data: saree } = await supabase
    .from("saree_catalog")
    .select("*")
    .eq("id", sareeId)
    .single();

  if (!saree) {
    await sendWhatsAppText(to, "Could not find your selected saree. Please choose a saree again.");
    await supabase.from("conversations").update({ state: "idle" }).eq("id", conversationId);
    return;
  }

  // Check if customer replied "1" or "yes" to use saved address
  const isConfirmSaved = /^(1|yes|confirm|saved|ok|use saved)$/i.test(addressText.trim());

  let finalAddress: Record<string, unknown>;
  let finalName = "Customer";

  const { data: customer } = await supabase
    .from("customers")
    .select("address, name")
    .eq("id", customerId)
    .single();

  if (isConfirmSaved && customer?.address && (customer.address as Record<string, unknown>).street) {
    finalAddress = customer.address as Record<string, unknown>;
    finalName = customer.name || "Customer";
  } else {
    const lines = addressText.split("\n").map((l) => l.trim()).filter(Boolean);
    const pinMatch = addressText.match(/\b\d{6}\b/);
    const pincode = pinMatch ? pinMatch[0] : "";

    let parsedName = customer?.name || "";
    let streetLines = lines;
    if (lines.length > 1 && !/\d|flat|road|street|nagar|house|plot|colony|near|sector/i.test(lines[0])) {
      parsedName = lines[0];
      streetLines = lines.slice(1);
    }

    finalName = parsedName || customer?.name || "Customer";
    finalAddress = {
      full_address: addressText,
      street: streetLines.join(", "),
      city: "As provided",
      pincode: pincode,
    };

    // Update customer in database
    await supabase
      .from("customers")
      .update({
        name: finalName,
        address: finalAddress,
      })
      .eq("id", customerId);
  }

  // STEP 2: PAYMENT REQUIRED (NO CASH ON DELIVERY!)
  const paymentMsg =
    `📍 *Delivery Address Confirmed:*\n` +
    `👤 *Name:* ${finalName}\n` +
    `🏠 *Address:* ${finalAddress.street || finalAddress.full_address}\n` +
    (finalAddress.pincode ? `📮 *Pincode:* ${finalAddress.pincode}\n` : "") +
    `\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💳 *Order Checkout — Step 2 of 2: UPI / QR Payment*\n` +
    `*(Note: Cash on Delivery is NOT available. 100% Prepaid Safe Dispatch)*\n\n` +
    `🥻 *Saree:* ${saree.name}\n` +
    `💰 *Total Amount Payable:* *₹${saree.price.toLocaleString("en-IN")}*\n\n` +
    `📲 *Pay via UPI:*\n` +
    `• *UPI ID:* \`saitraders@upi\`\n` +
    `• *Google Pay / PhonePe / Paytm:* \`+91 98765 43210\`\n` +
    `• *Beneficiary:* Sai Traders\n\n` +
    `👉 After transferring ₹${saree.price.toLocaleString("en-IN")}, please reply with your **Transaction ID / UTR Number** (or send a payment receipt screenshot) to confirm your order!`;

  await sendWhatsAppInteractiveButtons(
    to,
    paymentMsg,
    [
      { id: `payment_done_${saree.id}`, title: "✅ Payment Done" },
      { id: "cancel_order", title: "❌ Cancel Order" },
    ],
    "Sai Traders Payment"
  );

  await supabase
    .from("conversations")
    .update({
      state: "awaiting_payment",
      context: {
        selected_saree_id: saree.id,
        confirmed_address: finalAddress,
        customer_name: finalName,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
}

async function handlePaymentConfirmation(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  to: string,
  customerId: string,
  conversationId: string,
  context: Record<string, unknown>,
  proofText: string
) {
  const sareeId = String(context.selected_saree_id || "");

  const { data: saree } = await supabase
    .from("saree_catalog")
    .select("*")
    .eq("id", sareeId)
    .single();

  if (!saree) {
    await sendWhatsAppText(to, "Could not find your selected saree. Please choose a saree again.");
    await supabase.from("conversations").update({ state: "idle" }).eq("id", conversationId);
    return;
  }

  const confirmedAddress = (context.confirmed_address as Record<string, unknown>) || {};
  const customerName = String(context.customer_name || "Customer");

  // Create Order in Supabase
  const { data: newOrder, error } = await supabase
    .from("orders")
    .insert({
      customer_id: customerId,
      items: [
        {
          saree_id: saree.id,
          sku: saree.sku,
          name: saree.name,
          price: saree.price,
          quantity: 1,
        },
      ],
      total_amount: saree.price,
      shipping_address: confirmedAddress,
      status: "confirmed",
      payment_status: "paid",
      notes: `PREPAID_UPI | Ref: ${proofText.slice(0, 80)}`,
      channel: "whatsapp",
    })
    .select("order_number")
    .single();

  if (error || !newOrder) {
    console.error("Order creation error:", error);
    await sendWhatsAppText(to, "There was an issue recording your order. Please message our staff at +91 98765 43210.");
    return;
  }

  // Deduct stock from Tally ERP via Sales Voucher
  try {
    await pushTallySalesVoucher(
      newOrder.order_number,
      saree.sku,
      1,
      saree.price,
      undefined,
      "Online",
      saree.name || saree.sku
    );
  } catch (tErr) {
    console.warn("Tally voucher push notice:", tErr);
  }

  // Update catalog stock
  await supabase
    .from("saree_catalog")
    .update({ stock_quantity: Math.max(0, (saree.stock_quantity || 1) - 1) })
    .eq("id", saree.id);

  // Update stock_pool so dashboard reflects real-time quantity
  const { data: poolRow } = await supabase
    .from("stock_pool")
    .select("id, online_quantity")
    .eq("product_code", saree.sku)
    .maybeSingle();

  if (poolRow) {
    await supabase
      .from("stock_pool")
      .update({
        online_quantity: Math.max(0, (poolRow.online_quantity || 1) - 1),
        updated_at: new Date().toISOString(),
      })
      .eq("id", poolRow.id);
  }

  const confirmationMsg =
    `🎉 *Payment Received & Order Confirmed!*\n\n` +
    `🧾 *Order Number:* *${newOrder.order_number}*\n` +
    `🥻 *Product:* ${saree.name}\n` +
    `🏷️ *Product Code:* ${saree.sku}\n` +
    `💰 *Amount Paid:* ₹${saree.price.toLocaleString("en-IN")} *(Prepaid via UPI ✅)*\n` +
    `📍 *Delivering To:*\n${customerName}\n${confirmedAddress.street || confirmedAddress.full_address || ""}\n\n` +
    `📦 *Stock Reserved:* Live unit deducted from Tally ERP Online stock.\n` +
    `🚚 Our packaging team is preparing your parcel for insured courier dispatch.\n` +
    `You can track your order anytime by replying *"Track ${newOrder.order_number}"*!\n\n` +
    `_Thank you for choosing Sai Traders! 🌸_`;

  await sendWhatsAppText(to, confirmationMsg);

  await supabase
    .from("conversations")
    .update({
      state: "order_placed",
      context: { last_order_number: newOrder.order_number },
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
}

async function handleCancelOrder(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  to: string,
  conversationId: string
) {
  await sendWhatsAppText(
    to,
    "❌ Order checkout cancelled. You can browse our collection or send a photo of any saree anytime! 🌸"
  );
  await supabase
    .from("conversations")
    .update({
      state: "idle",
      context: {},
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
}

async function handleTrackOrder(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  to: string,
  customerId: string,
  orderNumber?: string
) {
  let query = supabase.from("orders").select("*").eq("customer_id", customerId);

  if (orderNumber) {
    query = query.eq("order_number", orderNumber);
  }

  const { data: orders } = await query.order("created_at", { ascending: false }).limit(1);

  if (!orders || orders.length === 0) {
    await sendWhatsAppText(
      to,
      "We could not find any active orders for your account. If you placed an order recently, please share the order number (e.g. *SAI-1001*)."
    );
    return;
  }

  const order = orders[0];
  const items = (order.items as Array<{ name: string; price: number }>) || [];
  const itemName = items[0]?.name || "Saree";

  const statusEmojis: Record<string, string> = {
    pending: "⏳ Order Placed & Pending Confirmation",
    confirmed: "✅ Confirmed & Assigned to Packaging",
    packed: "📦 Packed with Care",
    shipped: "🚚 Out for Delivery / In Transit",
    delivered: "🎉 Delivered",
    cancelled: "❌ Cancelled",
  };

  const statusText = statusEmojis[order.status] || order.status;

  const msg =
    `📦 *Order Status Update: ${order.order_number}*\n\n` +
    `• *Item:* ${itemName}\n` +
    `• *Status:* ${statusText}\n` +
    `• *Total:* ₹${Number(order.total_amount).toLocaleString("en-IN")}\n` +
    `• *Tracking Number:* ${order.tracking_number || "Will be updated once dispatched"}\n` +
    `• *Payment:* ${order.payment_status === "paid" ? "Prepaid via UPI ✅" : "Pending UPI Transfer"}\n\n` +
    `Need changes or help? Just reply to this chat! 🌸`;

  await sendWhatsAppText(to, msg);
}

async function handleTextCatalogSearch(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  to: string,
  conversationId: string,
  query: string
) {
  try {
    const queryEmbedding = await generateTextEmbedding(query);

    const { data: matchedSarees } = await supabase.rpc("match_sarees", {
      query_embedding: queryEmbedding,
      match_threshold: 0.22,
      match_count: 3,
      filter_active: true,
    });

    const matches: SareeMatch[] = (matchedSarees as SareeMatch[]) || [];

    if (matches.length === 0) {
      await sendWhatsAppText(
        to,
        `We couldn't find an exact match for *"${query}"* in our immediate stock. Would you like to send a photo of the style you're looking for, or speak with our stylist?`
      );
      return;
    }

    await sendWhatsAppText(to, `✨ *Here are sarees matching "${query}":*`);

    for (let i = 0; i < matches.length; i++) {
      const saree = matches[i];

      // 1. FIRST: Send Saree Image!
      if (saree.image_urls && saree.image_urls.length > 0) {
        await sendWhatsAppImage(to, saree.image_urls[0], `🥻 *Option ${i + 1}: ${saree.name}* (Code: ${saree.sku})`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      // 2. THEN: Send Details!
      const caption =
        `🥻 *Option ${i + 1}: ${saree.name}*\n` +
        `💰 *Price:* ₹${saree.price.toLocaleString("en-IN")}\n` +
        `🧵 *Fabric:* ${saree.fabric} (${saree.weave_style})\n\n` +
        `_Reply *${i + 1}* to select!_`;

      await sendWhatsAppText(to, caption);
    }

    const buttons = matches.slice(0, 3).map((m, idx) => ({
      id: `select_${m.id}`,
      title: `Select #${idx + 1}`,
    }));

    await sendWhatsAppInteractiveButtons(
      to,
      "Choose any saree to see full details and order:",
      buttons,
      "Matching Results"
    );

    await supabase
      .from("conversations")
      .update({
        state: "showing_results",
        context: {
          matched_sarees: matches.map((m) => ({ id: m.id, name: m.name, price: m.price })),
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
  } catch (err) {
    console.error("Text search error:", err);
    await sendWhatsAppText(
      to,
      "Feel free to send a photo of the saree you love, and we will find the closest designs for you! 📸"
    );
  }
}

async function handleBrowseCatalog(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  to: string,
  conversationId: string,
  _category: string
) {
  // Fetch active sarees (newest first, so uploaded sarees appear first)
  const { data: sarees } = await supabase
    .from("saree_catalog")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(3);

  if (!sarees || sarees.length === 0) {
    await sendWhatsAppText(to, "Our collection is being updated. Please send a photo of what you are looking for!");
    return;
  }

  await sendWhatsAppText(
    to,
    `✨ *Here are our featured designer sarees in stock:*`
  );

  for (let i = 0; i < sarees.length; i++) {
    const s = sarees[i];

    // 1. FIRST: Send Saree Image!
    if (s.image_urls && s.image_urls.length > 0) {
      await sendWhatsAppImage(to, s.image_urls[0], `🥻 *Option ${i + 1}: ${s.name}* (Code: ${s.sku})`);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    // 2. THEN: Send Saree Details!
    const cardBody =
      `🥻 *Option ${i + 1}: ${s.name}*\n\n` +
      `🏷️ *Product Code:* *${s.sku}*\n` +
      `💰 *Price:* ₹${s.price.toLocaleString("en-IN")}` +
      (s.mrp ? ` (MRP: ~₹${s.mrp.toLocaleString("en-IN")}~)` : "") + "\n" +
      `🧵 *Fabric:* ${s.fabric} (${s.weave_style})\n` +
      `📦 *Stock:* ${s.stock_quantity > 0 ? "In Stock in Tally ERP" : "Pre-order"}\n\n` +
      `_Tap below to begin order checkout:_`;

    const buttons = [
      { id: `buy_${s.id}`, title: `Buy Now (₹${s.price})` },
      { id: `select_${s.id}`, title: `View Details #${i + 1}` },
    ];

    await sendWhatsAppInteractiveButtons(
      to,
      cardBody,
      buttons,
      "Sai Traders Collection"
    );
  }

  await supabase
    .from("conversations")
    .update({
      state: "showing_results",
      context: {
        matched_sarees: sarees.map((s) => ({ id: s.id, name: s.name, price: s.price })),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
}
