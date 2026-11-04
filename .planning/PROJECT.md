# Project Overview — Sai Traders WhatsApp Saree Intelligence Bot

## 1. Executive Summary

**Sai Traders** is an AI-powered WhatsApp Commerce & Visual Search system integrated seamlessly with **TallyPrime ERP**, **Google Gemini AI**, and **Supabase (PostgreSQL + pgvector)**. Designed for Shree Sai Traders in Tumakuru, Karnataka, the system bridges digital conversational commerce with physical in-store accounting.

Customers can photograph any saree from social media, weddings, or catalogs, and receive instant, intelligent product recommendations from Sai Traders' live inventory. Orders placed through WhatsApp are automatically synchronized with TallyPrime as GST-compliant Sales Vouchers, decrementing physical stock and updating customer ledgers without manual data entry.

---

## 2. Key Stakeholders

- **Client**: Shree Sai Traders
  - *Location*: SS Puram Main Rd, Opp. Shivdev Petrol Bunk, Coffee Board Colony, S.S. Puram, Tumakuru, Karnataka 572102
- **Developer / Solution Partner**: KalpaCodes
  - *Location*: Near J S S S Depo, Upparahalli, Tumkur 572102
  - *Services*: Websites · Apps · Software · AI Automations

---

## 3. Core Business Objectives

1. **Frictionless Visual Saree Discovery**:
   Allow customers to find sarees by sending photos, eliminating text description barriers and matching exact weaves, borders, and colors using 768-dimensional multimodal vector embeddings.
2. **End-to-End Conversational WhatsApp Checkout**:
   Enable complete order placement directly in WhatsApp with zero app installations, including catalog selection, address capture, and order tracking.
3. **Automated Tally ERP Synchronization**:
   Eliminate dual entry by pushing confirmed WhatsApp sales into TallyPrime as Sales Vouchers with proper inventory deductions and GST ledger allocations.
4. **Unified Admin Web Dashboard**:
   Provide store managers with live visibility into orders, customer profiles, catalog management, AI vision logs, and system health.

---

## 4. Key Systems & Repositories

| Subsystem | Location | Technologies |
|:---|:---|:---|
| **WhatsApp Edge Webhook** | `supabase/functions/whatsapp-webhook/` | Deno, TypeScript, Meta Graph API v21.0 |
| **Multimodal Vision & Search** | `supabase/functions/_shared/gemini.ts` | Google Gemini 2.5 Flash, pgvector (HNSW) |
| **Database & Object Storage** | `supabase/migrations/` | PostgreSQL 15, Supabase Storage, pgvector |
| **Autonomous Tally Agent** | `agent/` | Node.js, XML over HTTP, TallyPrime API (:9000) |
| **Admin Web Dashboard** | `admin/` | Express.js, Vanilla SPA (HTML5/CSS3/ES2022) |
| **Testing & Simulation Suite** | `scripts/` | Node.js health checks, flow simulators |
