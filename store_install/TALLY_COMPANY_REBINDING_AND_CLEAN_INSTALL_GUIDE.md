# Sai Traders — Tally Company Rebinding & Store PC Clean Install Guide

## 1. Overview & Context

Sai Traders enforces a strict security gate (**SEC-07 Company Identity Lock**) in the store sync engine. This ensures that only the authorized Tally company and godown can sync stock or process orders with the cloud storefront.

### Why the Test PC Was Locked
- The Cloud database was previously bound to company **`MIithun`** (`fda06c48-bc3f-443b-b079-7e19958fa0dd`) on godown `Online_saree`.
- The test machine (**`SK`**, LAN IP `10.207.20.201`) loaded company **`SYED`** (GUID: `a6ad0fef-6d04-4c21-8b82-a31796fd6e9b`) with godowns `Main Location` and `SAREE`.
- When `START_STORE_PC.bat` ran, the local server detected that the loaded company (`SYED`) did not match the registered identity (`MIithun`), triggering an **`IDENTITY MISMATCH`** block and preventing cloud synchronization.

---

## 2. What Was Done: Option A (Rebound to `SYED` & `SAREE`)

We executed **Option A**: updated the cloud authority in Supabase so company **`SYED`** and godown **`SAREE`** are the authorized store identity.

### Supabase Cloud Updates
The script [`scripts/rebind_tally_company.js`](file:///c:/sai_traders/scripts/rebind_tally_company.js) was executed to update the following keys in `app_settings` and `shops`:

1. **`registered_tally_identity`** (`app_settings`):
   ```json
   {
     "companyName": "SYED",
     "guid": "a6ad0fef-6d04-4c21-8b82-a31796fd6e9b",
     "companyNumber": "100000",
     "registeredAt": "2026-11-05T11:25:27.533Z",
     "hostname": "SK",
     "godown": "SAREE"
   }
   ```
2. **`target_godown`** (`app_settings`):
   Set to `"SAREE"`.
3. **`tally_discovered_godowns`** (`app_settings`):
   Set to `["Main Location", "SAREE"]`.
4. **`tally_godown_hierarchy`** (`app_settings`):
   Updated hierarchy tree for `Main Location` and `SAREE`.
5. **`in_store_tally_status`** (`app_settings`):
   Set heartbeat to active with `identityVerified: true`, `company: "SYED"`, `guid: "a6ad0fef-6d04-4c21-8b82-a31796fd6e9b"`, `godown: "SAREE"`.
6. **`shops` table** (`code = 'SAI'`):
   Updated `settings.online_godown` to `"SAREE"`.
7. **Stock Matrices Reset**:
   `tally_unallocated_stock` and `tally_godown_stock_matrix` reset to `{}` to clear out stale records from the previous company.

---

## 3. How to Activate on the Test PC (`SK`) Now

On your test Windows PC:

1. **Stop any existing store processes**:
   - Double-click `STOP_STORE_PC.bat`.
2. **Start the store services**:
   - Double-click `START_STORE_PC.bat`.
3. **Check the Web Dashboard**:
   - Open `http://localhost:3000` (or `http://10.207.20.201:3000`).
   - The status badge will now show **`Verified Store`** (green) with Company: **`SYED`** and Godown: **`SAREE`**.
   - Sync and order polling will operate normally.

> [!NOTE]
> **Stock Items in `SYED`:**
> The preflight check showed that `SYED` currently has 0 stock items. When creating stock items in Tally:
> 1. Press **F11** in TallyPrime → **Inventory Features** → Set **Maintain Batch-wise details: Yes**.
> 2. On each item's Opening Balance (or Voucher), allocate stock to godown **`SAREE`**.

---

## 4. Moving to the Real Store PC: Clean Installation Guide

When you are ready to implement this on the actual physical Store PC, follow these steps:

### Step 1: Prerequisites on the Real Store PC
1. **Operating System**: Windows 10 or 11 (64-bit).
2. **Node.js**: Install Node.js LTS (v20 or v22) from [nodejs.org](https://nodejs.org).
3. **TallyPrime**:
   - Install TallyPrime and load your target store company (e.g., `MIithun` or your shop company).
   - In TallyPrime, enable the XML Server:
     - Press **F12** (Configure) → **Advanced Configuration**.
     - Set **TallyPrime is acting as**: `Both` (or `Server`).
     - Set **Port number**: `9000`.
     - Restart TallyPrime and reload your company.

### Step 2: Deploy the Kit
1. Copy the `store_install` (or `install_kit`) folder from this repository to the Store PC (e.g. `C:\SaiTradersStore`).
2. Verify that `.env` is present with valid Supabase and Cloudflare credentials.

### Step 3: Run the Preflight Check First
Before starting services, run the non-destructive preflight diagnostic:
- Double-click **`CHECK_STORE_PC.bat`**.
- It tests:
  - Machine specs, Node runtime, LAN IP.
  - Tally on disk and XML port 9000 responsiveness.
  - Loaded company name and GUID.
  - Available godowns and batch/godown item attribution.
- If everything is green, proceed. If any blocker appears, the report `store_preflight_report.json` will state the exact fix.

### Step 4: Rebind Company (If Using a Different Company on Store PC)
If the real Store PC uses `MIithun` (or any other company), bind the cloud to it by running:

```powershell
node scripts/rebind_tally_company.js --company "MIithun" --guid "<GUID_from_preflight>" --godown "Online_saree" --hostname "<STORE_PC_HOSTNAME>"
```

*(You can get the exact GUID and godown names from the report produced by `CHECK_STORE_PC.bat`)*.

### Step 5: Start Store PC
1. Double-click **`START_STORE_PC.bat`**.
2. It initializes:
   - Local Operations Core on `http://localhost:3000`.
   - Store Supervisor & Watchdog (`scripts\store_supervisor.js`).
   - Cloudflare Public Tunnel.
   - Local network URL on Wi-Fi (e.g. `http://192.168.x.x:3000`).
3. The store browser opens automatically with **`Verified Store`**.

### Step 6: End of Day Shutdown
- Double-click **`STOP_STORE_PC.bat`** to safely terminate background daemon processes.

