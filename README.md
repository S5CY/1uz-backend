# 1uz backend

Stores story choices, question-room answers, and progress for the `1uz♡` game. It is a Cloudflare Worker backed by D1.

## What is included

- `POST /api/events` — records a choice or written answer.
- `POST /api/progress` — saves the latest progress snapshot for an ID.
- `GET /api/admin/events` — private answer history, optionally filtered by `storyId`.
- `GET /api/admin/progress` — private progress list.
- `/admin` — simple private dashboard displaying `ID [x]: answer` records.
- Origin checks, input length limits, prepared SQL statements, and an admin bearer token.

## First-time setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Log into Cloudflare:

   ```bash
   npx wrangler login
   ```

3. Create the database:

   ```bash
   npx wrangler d1 create 1uz-answers
   ```

4. Copy the returned database ID into `wrangler.jsonc` in place of the all-zero placeholder ID.

5. Create a strong admin token and store it as a Worker secret:

   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```

6. Create the tables and deploy:

   ```bash
   npm run db:remote
   npm run deploy
   ```

7. Copy the deployed Worker URL into `js/config.js` in the frontend repository.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, replace its example token, then run:

```bash
npm install
npm run db:local
npm run dev
```

Do not commit `.dev.vars`, your admin token, Cloudflare credentials, or any private key. The public frontend never receives the admin token.

## Data shape

An answer event stores:

```json
{
  "storyId": "their chosen ID",
  "sessionId": "browser session identifier",
  "eventType": "choice or written-answer",
  "scene": "11.1 or question-room",
  "prompt": "the question shown",
  "answer": "what they selected or wrote",
  "clientTimestamp": "ISO timestamp",
  "metadata": {}
}
```

Anyone who knows a story ID can submit under it, because the game intentionally does not use accounts or passwords. The admin dashboard is still private. If stronger identity is needed later, add email or passkey authentication before treating IDs as proof of identity.
