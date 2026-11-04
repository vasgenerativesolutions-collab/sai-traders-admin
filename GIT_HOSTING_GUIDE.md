# Git Hosting & Windows Autonomous Agent Setup Guide

This guide explains how to host the **Sai Traders Agent & Admin Application** on GitHub/GitLab and how to set it up on Windows to auto-run on its own.

---

## 1. Security Check: Protecting Sensitive Keys

Before pushing to Git, verify that secret keys in `.env` are protected from being committed:

1. **`.env` is automatically ignored**: Our `.gitignore` contains `.env` and `.env.*`.
2. **`.env.example` is committed**: A template file with dummy placeholders is included so team members know which environment variables are needed.
3. Check status before committing:
   ```powershell
   git status
   ```
   *Ensure `.env` does **not** appear under "Changes to be committed".*

---

## 2. Steps to Push to GitHub / GitLab

Run the following commands in the project directory (`c:\sai_traders`):

```powershell
# 1. Initialize git repository (if not already initialized)
git init

# 2. Stage all project files (safe files only; .env is ignored)
git add .

# 3. Create your initial commit
git commit -m "feat: Sai Traders Autonomous Agent, Tally ERP connector, and Storefront REST APIs"

# 4. Set branch to main
git branch -M main

# 5. Add your remote GitHub repository URL (replace with your repo URL)
git remote add origin https://github.com/YOUR_ACCOUNT/sai-traders-agent.git

# 6. Push to GitHub
git push -u origin main
```

---

## 3. Autonomous Windows Runners

Two automated Windows launchers are included in the root folder:

### Option A: Interactive Double-Click Launcher (`RUN_SAI_TRADERS.bat`)
- Double-click `RUN_SAI_TRADERS.bat` anytime to start:
  1. Node.js dependency checks.
  2. The Admin Server on `http://localhost:3000`.
  3. The secure Cloudflare Tunnel for public HTTPS access.
  4. Automatically opens the Admin Web Portal in your default browser.

### Option B: Auto-Start on Windows Boot (`AUTO_START_ON_BOOT.bat`)
- Run `AUTO_START_ON_BOOT.bat` once.
- It registers a silent startup shortcut in Windows (`shell:startup`).
- **Result:** Every time the PC or shop workstation powers on, the backend server and secure public tunnel will auto-start in the background on their own with zero human intervention required.

---

## 4. Live Secure Public Tunnel URL for External Angular Storefront

- **Public Base URL**:
  `https://tunes-incidence-minutes-examples.trycloudflare.com`
- **Storefront API Endpoint**:
  `https://tunes-incidence-minutes-examples.trycloudflare.com/api/v1/store/products`
- **Order Webhook Endpoint**:
  `https://tunes-incidence-minutes-examples.trycloudflare.com/api/v1/store/orders`
- **Storefront API Key Header**:
  `x-api-key: sai_store_live_sec_892176`
