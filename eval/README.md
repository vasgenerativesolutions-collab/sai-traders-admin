# Sai Traders — Multimodal AI Vector Matching Evaluation Harness

## 1. Overview
This directory contains the ground-truth benchmark dataset and evaluation harness for measuring and calibrating visual and text matching performance using `gemini-embedding-2` (768-d multimodal) and Supabase `match_sarees_v2` RPC.

## 2. Hard Go-Live Gatekeeper
> **CRITICAL POLICY:** In `app_config.go_live_gates`, the key `eval_set_calibrated` is set to `false`.
> The WhatsApp customer agent and web auto-checkout **MUST NOT** be enabled in production until:
> 1. The store owner / catalog team captures physical camera frames or customer screenshot samples.
> 2. The full evaluation harness is executed (`npm run eval` or `node eval/run_eval.js`).
> 3. Positive vs. negative separation yields **>= 90% Top-3 Recall** and **<= 5% Negative False Positive Rate**.
> 4. All `UNCALIBRATED` placeholder thresholds in `app_config.matching_thresholds` are replaced with data-driven values.

## 3. Dataset Structure (`eval/dataset.json`)
The dataset comprises:
- **30 Positive Samples:** Customer queries, image references, or specific fabric/weave descriptions with known ground-truth `target_part_number` in the catalog.
- **15 Negative Samples (Out-of-Catalog):** Western gowns, bridal lehengas, kurtis, plain t-shirts, synthetic sarees not in catalog, and unanswerable queries. These MUST be rejected by the similarity threshold or routed to human handoff.

### Schema:
```json
{
  "id": "eval-pos-001",
  "type": "positive",
  "query_type": "text", // "text" | "image" | "hybrid"
  "query": "crimson red kanjivaram bridal saree gold zari",
  "target_part_number": "SAI-KANJ-01",
  "notes": "Classic bridal query"
}
```

```json
{
  "id": "eval-neg-001",
  "type": "negative",
  "query_type": "text",
  "query": "heavy velvet embroidered bridal lehenga choli with dupatta",
  "target_part_number": null,
  "notes": "Lehenga query - out of catalog"
}
```

## 4. Running the Evaluation
```bash
node eval/run_eval.js
```
The harness outputs:
- Detailed query-by-query match results
- Top-1 and Top-3 accuracy
- True Negative Rejection rate
- Score distributions (Mean positive similarity, Max negative similarity)
- Recommended optimal decision thresholds
- Generated `eval/EVAL_REPORT.md`
