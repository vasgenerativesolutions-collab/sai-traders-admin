/**
 * Meta WhatsApp Business Cloud API Integration Helper
 */

import { getSupabaseAdmin } from "./supabase-client.ts";

export interface WhatsAppButton {
  id: string;
  title: string;
}

export interface WhatsAppListRow {
  id: string;
  title: string;
  description?: string;
}

export interface WhatsAppListSection {
  title: string;
  rows: WhatsAppListRow[];
}

export interface MediaDownloadResult {
  buffer: Uint8Array;
  mimeType: string;
  base64: string;
}

/**
 * Verify Meta Webhook HMAC-SHA256 signature
 */
export async function verifyWhatsAppSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string
): Promise<boolean> {
  if (!signatureHeader || !appSecret) return false;
  
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const expectedHash = signatureHeader.substring(prefix.length).trim().toLowerCase();

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(rawBody)
  );

  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const calculatedHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  return calculatedHash === expectedHash;
}

// -----------------------------------------------------------------------------
// WhatsApp credentials, from this function's secrets.
// -----------------------------------------------------------------------------
let cachedToken: string | null = null;
let cachedPhoneId: string | null = null;
let lastCredentialFetch = 0;

export async function resolveWhatsAppCredentials(): Promise<{ token: string; phoneId: string }> {
  const now = Date.now();
  if (cachedToken && cachedPhoneId && now - lastCredentialFetch < 5000) {
    return { token: cachedToken, phoneId: cachedPhoneId };
  }

  // Credentials come from the function's own secrets.
  //
  // They used to be read from app_settings, with the environment only as a fallback.
  // That table was readable with the project's anon key — public by design and
  // published in this repository — so a live Meta access token was handed to anyone who
  // asked for it. It also meant fetching the entire settings table on every message.
  //
  // A secret belongs in the secret store. Rotating one is `supabase secrets set`, which
  // takes effect immediately and needs no deploy.
  cachedToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "";
  cachedPhoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "";
  lastCredentialFetch = now;

  return { token: cachedToken, phoneId: cachedPhoneId };
}

/**
 * Keep a record of what the shop said to a customer.
 *
 * The webhook replies in 39 places and recorded none of them, so the database held one
 * side of every conversation: what was asked, never what was answered. The morning
 * check could see that a customer ordered but not what price they were quoted, and a
 * reply that never arrived left no trace — the customer simply met silence.
 *
 * This lives in the send helpers rather than at the 39 call sites, so a reply is
 * recorded whether or not anyone remembers to, including replies added later.
 *
 * Recorded AFTER WhatsApp answers, with what actually happened. A log of what was
 * composed would be worse than none, because it would be believed.
 */
async function recordOutbound(
  to: string,
  messageType: string,
  content: string,
  result: { success: boolean; data?: unknown; error?: string },
  mediaUrl?: string,
): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    const phone = to.replace(/[^0-9]/g, "");
    if (!phone) return;

    // The conversation this belongs to. Matched on the last ten digits so a number
    // stored with or without its country code still finds its own thread.
    const tail = phone.slice(-10);
    const { data: customer } = await supabase
      .from("customers")
      .select("id")
      .like("phone_number", `%${tail}`)
      .limit(1)
      .maybeSingle();

    if (!customer) return;   // nobody to attach it to; the send still happened

    const { data: conversation } = await supabase
      .from("conversations")
      .select("id")
      .eq("customer_id", customer.id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!conversation) return;

    const sent = result.success;
    const waId = sent
      ? ((result.data as { messages?: { id?: string }[] } | undefined)?.messages?.[0]?.id ?? null)
      : null;

    await supabase.from("messages").insert({
      conversation_id: conversation.id,
      direction: "outbound",
      message_type: messageType,
      content: content.slice(0, 4000),
      media_url: mediaUrl ?? null,
      wa_message_id: waId,
      status: sent ? "sent" : "failed",
      error: sent ? null : (result.error || "unknown error").slice(0, 500),
    });
  } catch (err) {
    // Recording must never break replying. A customer getting an answer matters more
    // than the log of it, so this is the one place a swallowed error is right — and it
    // is logged, so it is not invisible.
    console.error("[whatsapp] could not record an outbound message:", err);
  }
}

export async function sendWhatsAppText(
  to: string,
  text: string,
  previewUrl = false
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const result = await sendWhatsAppTextRaw(to, text, previewUrl);
  await recordOutbound(to, "text", String(text ?? ''), result);
  return result;
}

/**
 * Send standard WhatsApp text message
 */
async function sendWhatsAppTextRaw(
  to: string,
  text: string,
  previewUrl = false
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { token, phoneId } = await resolveWhatsAppCredentials();

  if (!token || !phoneId) {
    return { success: false, error: "Missing WhatsApp credentials in environment" };
  }

  const cleanTo = to.replace(/[^0-9]/g, "");

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanTo,
        type: "text",
        text: {
          preview_url: previewUrl,
          body: text,
        },
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Error sending WhatsApp text:", data);
      if (data?.error?.code === 190) cachedToken = null; // Invalidate on expired token
      return { success: false, error: data?.error?.message || "Failed to send message", data };
    }
    return { success: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Exception sending WhatsApp text:", err);
    return { success: false, error: message };
  }
}

export async function sendWhatsAppImage(
  to: string,
  imageUrl: string,
  caption?: string
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const result = await sendWhatsAppImageRaw(to, imageUrl, caption);
  await recordOutbound(to, "image", String(caption ?? ''), result, imageUrl);
  return result;
}

/**
 * Send WhatsApp Image message with optional caption
 */
async function sendWhatsAppImageRaw(
  to: string,
  imageUrl: string,
  caption?: string
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { token, phoneId } = await resolveWhatsAppCredentials();

  if (!token || !phoneId) {
    return { success: false, error: "Missing WhatsApp credentials in environment" };
  }

  const cleanTo = to.replace(/[^0-9]/g, "");

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanTo,
        type: "image",
        image: {
          link: imageUrl,
          caption: caption || undefined,
        },
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Error sending WhatsApp image:", data);
      return { success: false, error: data?.error?.message || "Failed to send image", data };
    }
    return { success: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Exception sending WhatsApp image:", err);
    return { success: false, error: message };
  }
}

export async function sendWhatsAppInteractiveButtons(
  to: string,
  bodyText: string,
  buttons: WhatsAppButton[],
  headerText?: string,
  footerText?: string
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const result = await sendWhatsAppInteractiveButtonsRaw(to, bodyText, buttons, headerText, footerText);
  await recordOutbound(to, "interactive", String(bodyText ?? ''), result);
  return result;
}

/**
 * Send Interactive Action Buttons (up to 3 buttons)
 */
async function sendWhatsAppInteractiveButtonsRaw(
  to: string,
  bodyText: string,
  buttons: WhatsAppButton[],
  headerText?: string,
  footerText?: string
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { token, phoneId } = await resolveWhatsAppCredentials();

  if (!token || !phoneId) {
    return { success: false, error: "Missing WhatsApp credentials" };
  }

  const cleanTo = to.replace(/[^0-9]/g, "");
  const formattedButtons = buttons.slice(0, 3).map((b) => ({
    type: "reply",
    reply: {
      id: b.id,
      title: b.title.slice(0, 20), // WhatsApp limits button title to 20 chars
    },
  }));

  const interactivePayload: Record<string, unknown> = {
    type: "button",
    body: { text: bodyText },
    action: { buttons: formattedButtons },
  };

  if (headerText) {
    interactivePayload.header = { type: "text", text: headerText };
  }
  if (footerText) {
    interactivePayload.footer = { text: footerText };
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanTo,
        type: "interactive",
        interactive: interactivePayload,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Error sending interactive buttons:", data);
      return { success: false, error: data?.error?.message || "Failed to send buttons", data };
    }
    return { success: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export async function sendWhatsAppInteractiveImageCard(
  to: string,
  imageUrl: string,
  bodyText: string,
  buttons: WhatsAppButton[],
  footerText = "Sai Traders"
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const result = await sendWhatsAppInteractiveImageCardRaw(to, imageUrl, bodyText, buttons, footerText);
  await recordOutbound(to, "interactive", String(bodyText ?? ''), result, imageUrl);
  return result;
}

/**
 * Send Interactive Action Buttons with an Image Header (Unified Product Card)
 */
async function sendWhatsAppInteractiveImageCardRaw(
  to: string,
  imageUrl: string,
  bodyText: string,
  buttons: WhatsAppButton[],
  footerText = "Sai Traders"
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { token, phoneId } = await resolveWhatsAppCredentials();

  if (!token || !phoneId) {
    return { success: false, error: "Missing WhatsApp credentials" };
  }

  const cleanTo = to.replace(/[^0-9]/g, "");
  const formattedButtons = buttons.slice(0, 3).map((b) => ({
    type: "reply",
    reply: {
      id: b.id,
      title: b.title.slice(0, 20),
    },
  }));

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: cleanTo,
    type: "interactive",
    interactive: {
      type: "button",
      header: {
        type: "image",
        image: { link: imageUrl },
      },
      body: { text: bodyText.slice(0, 1024) },
      footer: footerText ? { text: footerText.slice(0, 60) } : undefined,
      action: { buttons: formattedButtons },
    },
  };

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Error sending interactive image card:", data);
      return { success: false, error: data?.error?.message || "Failed to send card", data };
    }
    return { success: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export async function sendWhatsAppInteractiveList(
  to: string,
  bodyText: string,
  buttonTitle: string,
  sections: WhatsAppListSection[],
  headerText?: string,
  footerText?: string
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const result = await sendWhatsAppInteractiveListRaw(to, bodyText, buttonTitle, sections, headerText, footerText);
  await recordOutbound(to, "interactive", String(bodyText ?? ''), result);
  return result;
}

/**
 * Send Interactive List Message (for choosing between multiple sarees)
 */
async function sendWhatsAppInteractiveListRaw(
  to: string,
  bodyText: string,
  buttonTitle: string,
  sections: WhatsAppListSection[],
  headerText?: string,
  footerText?: string
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { token, phoneId } = await resolveWhatsAppCredentials();

  if (!token || !phoneId) {
    return { success: false, error: "Missing WhatsApp credentials" };
  }

  const cleanTo = to.replace(/[^0-9]/g, "");

  const interactivePayload: Record<string, unknown> = {
    type: "list",
    body: { text: bodyText },
    action: {
      button: buttonTitle.slice(0, 20),
      sections: sections,
    },
  };

  if (headerText) {
    interactivePayload.header = { type: "text", text: headerText };
  }
  if (footerText) {
    interactivePayload.footer = { text: footerText };
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanTo,
        type: "interactive",
        interactive: interactivePayload,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Error sending interactive list:", data);
      return { success: false, error: data?.error?.message || "Failed to send list", data };
    }
    return { success: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Download Media (e.g. Saree Photo) from WhatsApp Media API
 */
export async function downloadWhatsAppMedia(mediaId: string): Promise<MediaDownloadResult> {
  const { token } = await resolveWhatsAppCredentials();
  if (!token) throw new Error("Missing WHATSAPP_ACCESS_TOKEN");

  // Step 1: Query Graph API to get the temporary media download URL
  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "curl/7.64.1",
    },
  });

  if (!metaRes.ok) {
    const errText = await metaRes.text();
    console.error("Meta media info error:", errText);
    throw new Error(`Failed to retrieve media URL (${metaRes.status}): ${errText}`);
  }

  const metaData = await metaRes.json();
  const downloadUrl = metaData.url;
  const mimeType = metaData.mime_type || "image/jpeg";

  if (!downloadUrl) {
    throw new Error("No download URL returned by Meta Graph API");
  }

  // Step 2: Download binary data from the media URL using Bearer token and User-Agent
  const mediaRes = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "curl/7.64.1",
    },
  });

  if (!mediaRes.ok) {
    const errText = await mediaRes.text();
    console.error("Meta media binary download error:", errText);
    throw new Error(`Failed to download media binary (${mediaRes.status}) from ${downloadUrl}`);
  }

  const arrayBuffer = await mediaRes.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);

  // Convert buffer to base64 efficiently in 8KB chunks to prevent stack overflow on large mobile photos
  let binary = "";
  const len = buffer.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = buffer.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  const base64 = btoa(binary);

  return {
    buffer,
    mimeType,
    base64,
  };
}

/**
 * Mark a received WhatsApp message as read
 */
export async function markWhatsAppMessageAsRead(messageId: string): Promise<void> {
  const { token, phoneId } = await resolveWhatsAppCredentials();

  if (!token || !phoneId) return;

  try {
    await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
  } catch (err) {
    console.error("Failed to mark message as read:", err);
  }
}
