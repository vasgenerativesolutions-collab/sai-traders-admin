# Multimodal AI Vector Matching Evaluation Report (Phase 1)

**Run Date:** 2026-10-05T06:03:55.306Z  
**Embedding Engine:** `gemini-embedding-2` (768-dimensional multimodal vector space)  
**Database Matching RPC:** `match_sarees_v2` on Supabase PostgreSQL with `pgvector` HNSW  
**Dataset Reference:** [`eval/dataset.json`](file:///c:/sai_traders/eval/dataset.json)  

---

## 1. Executive Summary

| Metric | Target Goal | Observed Result | Status |
| :--- | :--- | :--- | :--- |
| **Top-1 Retrieval Accuracy** | >= 80.0% | **96.7%** (29/30) | ✅ PASSED |
| **Top-3 Retrieval Recall** | >= 90.0% | **100.0%** (30/30) | ✅ PASSED |
| **Out-of-Catalog Rejection Rate** | >= 90.0% | **100.0%** (15/15) | ✅ PASSED |
| **Average Positive Similarity** | - | **69.1%** | High Affinity |
| **Average Out-of-Catalog Similarity** | - | **38.8%** | Low Affinity |
| **Recommended Decision Threshold** | Data-driven | **0.54 (54%)** | Calibrated Baseline |

---

## 2. Hard Go-Live Gatekeeper Audit

> [!IMPORTANT]
> **GO-LIVE GATE STATUS: STAGED / UNCALIBRATED FOR PHYSICAL SCREENSHOTS**
> While the text-based semantic benchmark demonstrates high separation (100.0% recall), the system policy mandates:
> 1. All threshold configurations in `app_config.matching_thresholds` remain marked **`calibration_status: "UNCALIBRATED"`** until real customer WhatsApp video screenshot frames are uploaded and evaluated through this harness.
> 2. `app_config.go_live_gates.eval_set_calibrated` remains `false` until owner approves final image screenshot calibration run.
> 3. `feature_flags.direct_order_enabled` remains `false` to ensure human approval workflow is preserved.

---

## 3. Score Distribution Analysis

```
Positive Catalog Items (n=30):
Min: 54.8% | Mean: 69.1% | Max: 81.7%

Out-of-Catalog Negatives (n=15):
Min: 31.6% | Mean: 38.8% | Max: 53.2%

Recommended Cutoff Boundary: 54.0%
```

---

## 4. Query-by-Query Performance Breakdown

### Positive Query Samples (30)
| ID | Query Excerpt | Expected Part # | Result | Similarity | Top Matched SKU |
| :--- | :--- | :--- | :--- | :--- | :--- |
| POS-001 | bridal red kanjivaram pure silk sare... | `SAI-KANJ-01` | 🎯 Top-1 | 75.9% | `SAI-KANJ-01` |
| POS-002 | crimson south indian wedding saree r... | `SAI-KANJ-01` | 🎯 Top-1 | 62.1% | `SAI-KANJ-01` |
| POS-003 | deep red silk saree with authentic g... | `SAI-KANJ-01` | 🎯 Top-1 | 66.9% | `SAI-KANJ-01` |
| POS-004 | royal sapphire banarasi katan silk s... | `SAI-BAN-02` | 🎯 Top-1 | 81.4% | `SAI-BAN-02` |
| POS-005 | blue banarasi silk saree rich zari w... | `SAI-BAN-02` | 🎯 Top-1 | 69.7% | `SAI-BAN-02` |
| POS-006 | heavy bridal banarasi saree in deep ... | `SAI-BAN-02` | 🎯 Top-1 | 67.1% | `SAI-BAN-02` |
| POS-007 | pastel mint whisper chanderi silk co... | `SAI-CHAN-04` | 🎯 Top-1 | 75.3% | `SAI-CHAN-04` |
| POS-008 | light green chanderi saree breathabl... | `SAI-CHAN-04` | 🎯 Top-1 | 67.6% | `SAI-CHAN-04` |
| POS-009 | mint pastel comfortable cotton silk ... | `SAI-CHAN-04` | 🎯 Top-1 | 54.8% | `SAI-CHAN-04` |
| POS-010 | blush rose handpainted organza silk ... | `SAI-ORG-05` | 🎯 Top-1 | 80.1% | `SAI-ORG-05` |
| POS-011 | pink sheer organza floral printed pa... | `SAI-ORG-05` | 🎯 Top-1 | 63.4% | `SAI-ORG-05` |
| POS-012 | lightweight pastel pink saree with h... | `SAI-ORG-05` | 🎯 Top-1 | 65.1% | `SAI-ORG-05` |
| POS-013 | marigold yellow bandhani georgette s... | `SAI-BAN-03` | 🎯 Top-1 | 77.7% | `SAI-BAN-03` |
| POS-014 | bright yellow saree for haldi ceremo... | `SAI-BAN-03` | 🎯 Top-1 | 64.9% | `SAI-BAN-03` |
| POS-015 | georgette bandhej saree mustard yell... | `SAI-BAN-03` | 🎯 Top-1 | 70.7% | `SAI-BAN-03` |
| POS-016 | heritage double ikat patola silk sar... | `SAI-PAT-06` | 🎯 Top-1 | 70.6% | `SAI-PAT-06` |
| POS-017 | gujarat patola pure silk saree authe... | `SAI-PAT-06` | 🎯 Top-1 | 68.8% | `SAI-PAT-06` |
| POS-018 | traditional ikat saree with elephant... | `SAI-PAT-06` | 🎯 Top-1 | 57.8% | `SAI-PAT-06` |
| POS-019 | canary red bandhani zari woven silk ... | `SAI-BAN-RED-07` | 🎯 Top-1 | 78.7% | `SAI-BAN-RED-07` |
| POS-020 | red bridal bandhani saree with heavy... | `SAI-BAN-RED-07` | 🎯 Top-1 | 71.8% | `SAI-BAN-RED-07` |
| POS-021 | prussian blue bandhani gaji satin si... | `SAI-GAJI-BLU-08` | 🎯 Top-1 | 69.3% | `SAI-GAJI-BLU-08` |
| POS-022 | dark blue heavy gaji silk saree glos... | `SAI-GAJI-BLU-08` | 🎯 Top-1 | 61.4% | `SAI-GAJI-BLU-08` |
| POS-023 | women art silk dark blue with sky bl... | `SAI-ART-BLU-157` | 🎯 Top-1 | 67.5% | `SAI-ART-BLU-157` |
| POS-024 | budget dark blue art silk saree dual... | `SAI-ART-BLU-157` | ✅ Top-3 | 62.2% | `SR-1042-R` |
| POS-025 | royal blue soft silk saree with anti... | `SR-1042-R` | 🎯 Top-1 | 81.7% | `SR-1042-R` |
| POS-026 | SR-1042-R royal blue saree antique e... | `SR-1042-R` | 🎯 Top-1 | 76.9% | `SR-1042-R` |
| POS-027 | soft silk royal blue wedding guest s... | `SR-1042-R` | 🎯 Top-1 | 67.2% | `SR-1042-R` |
| POS-028 | antique zari border rich royal blue ... | `SR-1042-R` | 🎯 Top-1 | 66.8% | `SR-1042-R` |
| POS-029 | silk saree with ornate elephant figu... | `SR-1042-R` | 🎯 Top-1 | 64.6% | `SR-1042-R` |
| POS-030 | kanjivaram pure silk wedding saree a... | `SAI-KANJ-01` | 🎯 Top-1 | 66.3% | `SAI-KANJ-01` |

### Negative Samples: Out-of-Catalog Queries (15)
| ID | Out-of-Catalog Query | Category | Top False Match | Similarity | Cutoff Action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| NEG-001 | heavy velvet embroidered bridal lehe... | out_of_catalog_lehenga | `SAI-BAN-02` | 48.3% | 🛡️ Rejected (< Cutoff) |
| NEG-002 | western evening ball gown sleeveless... | out_of_catalog_western | `SAI-GAJI-BLU-08` | 33.0% | 🛡️ Rejected (< Cutoff) |
| NEG-003 | men tailored cotton kurta pyjama set... | out_of_catalog_menswear | `SAI-BAN-02` | 40.6% | 🛡️ Rejected (< Cutoff) |
| NEG-004 | denim jacket oversized blue with met... | out_of_catalog_western | `SAI-BAN-02` | 33.1% | 🛡️ Rejected (< Cutoff) |
| NEG-005 | readymade anarkali suit salwar kamee... | out_of_catalog_salwar | `SAI-BAN-RED-07` | 39.1% | 🛡️ Rejected (< Cutoff) |
| NEG-006 | gold plated kundan necklace jeweller... | out_of_catalog_jewellery | `SAI-BAN-02` | 44.2% | 🛡️ Rejected (< Cutoff) |
| NEG-007 | kids festive lehenga dress for 5 yea... | out_of_catalog_kids | `SAI-BAN-02` | 35.6% | 🛡️ Rejected (< Cutoff) |
| NEG-008 | leather bridal stiletto sandals high... | out_of_catalog_footwear | `SAI-BAN-02` | 36.7% | 🛡️ Rejected (< Cutoff) |
| NEG-009 | floral chiffon summer mini skirt hig... | out_of_catalog_western | `SAI-BAN-03` | 34.4% | 🛡️ Rejected (< Cutoff) |
| NEG-010 | embroidered clutch bag bridal potli ... | out_of_catalog_accessories | `SAI-BAN-RED-07` | 41.3% | 🛡️ Rejected (< Cutoff) |
| NEG-011 | black wool winter trench coat double... | out_of_catalog_western | `SAI-BAN-02` | 32.0% | 🛡️ Rejected (< Cutoff) |
| NEG-012 | casual cotton graphic print round ne... | out_of_catalog_western | `SR-1042-R` | 31.6% | 🛡️ Rejected (< Cutoff) |
| NEG-013 | pure pashmina kashmiri shawl with ha... | out_of_catalog_shawl | `SAI-BAN-02` | 53.2% | 🛡️ Rejected (< Cutoff) |
| NEG-014 | cotton bedsheet king size with pillo... | out_of_catalog_home | `SAI-BAN-02` | 41.1% | 🛡️ Rejected (< Cutoff) |
| NEG-015 | unstitched printed cotton dress mate... | out_of_catalog_dress_material | `SAI-CHAN-04` | 38.0% | 🛡️ Rejected (< Cutoff) |

---

## 5. Next Steps for Calibration
1. As the store owner uploads video frame recordings via the newly added **Video Record Editor**, export extracted frame screenshots into `eval/images/`.
2. Add image-to-image queries into `eval/dataset.json`.
3. Re-run `node eval/run_eval.js` to certify the combined vision + text weighted threshold before enabling direct production order checkout.
