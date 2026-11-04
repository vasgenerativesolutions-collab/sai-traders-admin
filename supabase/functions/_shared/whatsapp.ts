/**
 * Meta WhatsApp Business Cloud API Integration Helper
 */

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
// Live Dynamic WhatsApp Credentials Resolver (reads Supabase app_settings table)
// -----------------------------------------------------------------------------
let cachedToken: string | null = null;
let cachedPhoneId: string | null = null;
let lastCredentialFetch = 0;

export async function resolveWhatsAppCredentials(): Promise<{ token: string; phoneId: string }> {
  const now = Date.now();
  // Fast cache for 5 seconds to reduce DB roundtrips during bursts, but stay live
  if (cachedToken && cachedPhoneId && now - lastCredentialFetch < 5000) {
    return { token: cachedToken, phoneId: cachedPhoneId };
  }

  // 1. Try reading live dynamically from Supabase app_settings
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && serviceKey) {
      const res = await fetch(`${supabaseUrl}/rest/v1/app_settings?select=key,value`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (res.ok) {
        const rows = await res.json();
        const tokenRow = rows.find((r: { key: string }) => r.key === "WHATSAPP_ACCESS_TOKEN");
        const phoneRow = rows.find((r: { key: string }) => r.key === "WHATSAPP_PHONE_NUMBER_ID");
        if (tokenRow?.value) cachedToken = tokenRow.value;
        if (phoneRow?.value) cachedPhoneId = phoneRow.value;
        lastCredentialFetch = now;
      }
    }
  } catch (err) {
    console.warn("Could not query app_settings, using fallback env:", err);
  }

  // 2. Fallback to Deno.env
  if (!cachedToken) cachedToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "";
  if (!cachedPhoneId) cachedPhoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "";

  return { token: cachedToken, phoneId: cachedPhoneId };
}

/**
 * Send standard WhatsApp text message
 */
export async function sendWhatsAppText(
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

/**
 * Send WhatsApp Image message with optional caption
 */
export async function sendWhatsAppImage(
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

/**
 * Send Interactive Action Buttons (up to 3 buttons)
 */
export async function sendWhatsAppInteractiveButtons(
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

/**
 * Send Interactive Action Buttons with an Image Header (Unified Product Card)
 */
export async function sendWhatsAppInteractiveImageCard(
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

/**
 * Send Interactive List Message (for choosing between multiple sarees)
 */
export async function sendWhatsAppInteractiveList(
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
