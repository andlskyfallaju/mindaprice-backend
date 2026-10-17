# MindaPrice Backend

The Node.js/Express backend for [MindaPrice ZW](https://github.com/andlskyfallaju/mindaprice-zw-app), a Flutter app for Zimbabwean farmers. It handles the parts of the app that can't run safely on the phone: push notifications, AI-generated farming advisories, the "Minda" AI farming mentor chat, and weather-based advice.

It is a single-file service (`index.js`) built on Express, Firebase Admin (Auth, Firestore and Cloud Messaging), the Google Gemini API and the free Open-Meteo weather API. The live deployment runs on [Render](https://render.com).

## What it does

- **Minda, the AI farming mentor.** A chat endpoint that answers farming questions as "Minda", a friendly Zimbabwean agricultural mentor. It uses the farmer's profile, location and live weather as context, replies in the farmer's preferred language, and can analyse photos of crops, pests and soil.
- **Automated daily advisories.** A cron-triggered endpoint reads the regions where users are active, fetches the weather for each, has Gemini draft a short advisory, saves it to Firestore and pushes it to everyone subscribed to that region's FCM topic.
- **Admin advisories.** Admins can send a manual advisory to all users, or ask Gemini to draft one first.
- **Weather advisory.** A rule-based endpoint that turns the current conditions into a one-line recommendation (rain, wind or heat).
- **Marketplace notifications.** Push notifications for new chat messages and new ratings.
- **Housekeeping.** Advisories older than 3 days are archived automatically.

## Tech stack

| Concern | Library / service |
|---|---|
| Server | Express 4 |
| Auth | Firebase Auth ID tokens, verified with `firebase-admin` |
| Database | Cloud Firestore |
| Push notifications | Firebase Cloud Messaging (FCM) |
| AI | Google Gemini via `@google/generative-ai` |
| Weather | [Open-Meteo](https://open-meteo.com) (no API key needed) |
| Rate limiting | `express-rate-limit` |
| Concurrency control | `p-limit` |
| Config | `dotenv` |

**Requires Node.js 18 or newer**, since the code uses the built-in `fetch`.

## Getting started

### 1. Install

```bash
git clone https://github.com/andlskyfallaju/mindaprice-backend.git
cd mindaprice-backend
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root. The server **refuses to start** if any of the three required variables is missing.

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | API key from [Google AI Studio](https://aistudio.google.com/) |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | Yes | Your Firebase service account JSON, base64-encoded |
| `CRON_SECRET` | Yes | Shared secret that protects the cron and maintenance endpoints |
| `PORT` | No | Port to listen on (default `8080`) |

To produce the service account value:

```bash
# macOS / Linux
base64 -w 0 serviceAccount.json

# Windows (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("serviceAccount.json"))
```

Generate a service account in the Firebase console under **Project settings → Service accounts → Generate new private key**.

`.env`, `serviceAccount.json` and `firebase-adminsdk*.json` are git-ignored. Never commit them.

### 3. Run

```bash
npm start
```

The server logs `Minda Backend live on port 8080`. Opening the root URL returns a plain "MindaPrice ZW Backend is running!" message you can use as a health check.

## Authentication

Most endpoints require a Firebase ID token in the `Authorization` header:

```
Authorization: Bearer <firebase-id-token>
```

Admin endpoints additionally require the caller's Firestore document `users/{uid}` to have `role: "admin"`.

The cron and maintenance endpoints don't use Firebase auth. They take the `CRON_SECRET` instead, either as an `x-cron-secret` header (preferred, since query strings tend to end up in logs) or a `?secret=` query parameter.

## API reference

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | None | Health check |
| GET | `/weather/advisory` | None | Current weather plus a rule-based advisory |
| POST | `/users/register-location` | User | Register a user's region so it gets daily advisories |
| POST | `/ai/advisor-chat` | User, rate limited | Chat with Minda |
| POST | `/advisories/send` | Admin | Send a manual advisory to all users |
| POST | `/advisories/ai-draft` | Admin, rate limited | Generate an AI advisory draft |
| GET | `/advisories/trigger-ai` | Cron secret | Run the automated advisory job |
| GET | `/advisories/maintenance` | Cron secret | Archive old advisories and back-fill `isArchived` |
| POST | `/messages/notify` | User | Push a chat notification to another user |
| POST | `/ratings/notify` | User | Push a new-rating notification to another user |
| GET | `/ai/debug` | None | List the Gemini models available to the API key |

The AI endpoints are limited to **10 requests per minute per IP** (`429` with `{ "error": "Too many requests, please slow down." }`).

### `GET /weather/advisory`

Query parameters (both optional, default to central Harare): `lat`, `lon`.

```json
{
  "weather": {
    "temperature": 24.1,
    "precipitation_probability": 10,
    "precipitation": 0,
    "wind_speed": 12.4
  },
  "advisory": "Weather conditions are stable. Proceed with normal farming activities."
}
```

The advisory is chosen by these rules, checked in order:

| Condition | Advisory |
|---|---|
| Rain probability ≥ 70% or rain > 3 mm | Delay fertilizer application and prepare drainage |
| Wind > 25 km/h | Secure light materials and avoid spraying |
| Temperature > 32 °C | Water crops early and monitor heat stress |
| Otherwise | Conditions are stable, proceed as normal |

### `POST /users/register-location`

Called by the app on login or launch. Upserts a document in the `active_regions` collection, one per region topic, which the daily cron job uses to decide where to send advisories.

```json
{
  "locationTopic": "advisories_Harare_Zimbabwe",
  "lat": -17.8292,
  "lon": 31.0522,
  "locationName": "Harare"
}
```

`locationTopic`, `lat` and `lon` are required. The topic follows the format `advisories_<City>_<Country>`, with non-alphanumeric characters removed, which is the same name the app subscribes to in FCM.

### `POST /ai/advisor-chat`

Chat with Minda.

```json
{
  "message": "My maize leaves are turning yellow. What should I check?",
  "history": [
    { "role": "user", "text": "Hi Minda" },
    { "role": "model", "text": "Mhoro! How is the farm?" }
  ],
  "farmProfile": "2 hectares of maize near Marondera",
  "location": "Marondera",
  "lat": -18.18,
  "lon": 31.55,
  "preferredLanguage": "Shona",
  "imageBase64": "<optional base64 image data>",
  "imageMimeType": "image/jpeg"
}
```

Only `message` or `imageBase64` is required. Messages are truncated to 2,000 characters, `preferredLanguage` defaults to English, and `imageMimeType` defaults to `image/jpeg`.

Response: `{ "response": "..." }`

Minda's system prompt includes the farm profile, the live weather for the supplied coordinates, and rules to stay warm and concise, answer entirely in the preferred language, prioritise safety warnings in dangerous weather, avoid financial advice outside agriculture, and point farmers to resources like Agritex when unsure.

### `POST /advisories/send` (admin)

```json
{ "message": "Heavy rain expected tomorrow. Delay spraying." }
```

Saves the advisory to Firestore (`source: "manual"`) and sends a high-priority push to every device subscribed to the `advisories` FCM topic. Messages are limited to 2,000 characters.

### `POST /advisories/ai-draft` (admin)

Generates a draft for an admin to review before sending. Nothing is saved or pushed.

```json
{
  "location": "Mutare",
  "lat": -18.97,
  "lon": 32.67,
  "weather": { "temp": 27, "rain": 0, "wind": 10 }
}
```

All fields are optional. If `weather` is omitted, live weather is fetched from the coordinates (default Harare). Response: `{ "result": "..." }`

### `GET /advisories/trigger-ai` (cron)

Designed to be called by an external scheduler (for example a free cron service pinging the URL once a day). It responds `202` immediately so the scheduler doesn't time out, then works in the background:

1. Reads all documents in `active_regions`. If none exist, it falls back to five default provinces: Harare, Matabeleland, Manicaland, Midlands and Masvingo.
2. For each region, fetches current weather and asks Gemini for a short advisory. Regions are processed with at most **3 concurrent** Gemini calls to stay within free-tier rate limits.
3. Saves each advisory to the `advisories` collection (`source: "cron-job"`, tagged with the region's `topic`) and pushes it to that region's FCM topic only.
4. Archives advisories older than 3 days.

```bash
curl -H "x-cron-secret: $CRON_SECRET" https://<your-host>/advisories/trigger-ai
```

### `GET /advisories/maintenance`

Protected by `CRON_SECRET`. Archives advisories older than 3 days and sets `isArchived: false` on any advisory that doesn't have the field yet. Safe to run repeatedly.

### `POST /messages/notify` and `POST /ratings/notify`

Send a push notification to one user's stored FCM token (`users/{recipientUid}.fcmToken`).

`/messages/notify` body: `recipientUid`, `senderUid`, `senderName`, `message` (all required). It uses the `chat_channel` notification channel.

`/ratings/notify` body: `recipientUid`, `score`, `senderName` (all required). It respects the recipient's opt-out: if `users/{uid}.reviewNotificationsEnabled` is `false`, or there's no FCM token, it returns `{ "success": true, "skipped": true }` without sending.

### `GET /ai/debug`

Returns the list of Gemini models available to your API key. Useful when a model name has been retired and the fallback chain needs updating.

## AI model fallback

Gemini model availability and quotas change often, so every AI call tries models in order and moves to the next on **any** error (404, 403, 429 and so on):

`gemini-2.5-flash` → `gemini-2.0-flash` → `gemini-flash-latest` → `gemini-pro-latest` → `gemini-2.5-pro` → `gemini-pro`

If all of them fail, the server logs the models actually available for the key and returns an error. To change the order, edit the `models` array in `callGemini` in `index.js`.

## Firestore data model

| Collection | Document | Fields used by this backend |
|---|---|---|
| `users` | `{uid}` | `role` (`"admin"` for admins), `fcmToken`, `reviewNotificationsEnabled` |
| `advisories` | auto ID | `message`, `createdAt`, `source` (`manual` or `cron-job`), `topic`, `isAutomated`, `isArchived` |
| `active_regions` | `{locationTopic}` | `topic`, `lat`, `lon`, `name`, `lastUpdated` |

## Push notification channels

All notifications are sent as high-priority Android messages.

| Channel ID | Used for |
|---|---|
| `advisory_channel` | Manual and automated advisories |
| `chat_channel` | Chat messages and rating notifications |

The Flutter app must create these channels for notifications to display.

## Deployment (Render)

1. Create a new **Web Service** from this repository.
2. Build command: `npm install`. Start command: `npm start`.
3. Add `GEMINI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_BASE64` and `CRON_SECRET` under **Environment**.
4. Set up an external scheduler to call `/advisories/trigger-ai` with the `x-cron-secret` header. On Render's free tier the service sleeps when idle, so this ping also wakes it.

The server calls `app.set("trust proxy", 1)` so rate limiting sees the real client IP behind Render's proxy.

## Project structure

```
mindaprice-backend/
├── index.js          The whole service: routes, auth, Gemini and FCM helpers
├── package.json
├── scratch/          Throwaway scripts used while debugging (model checks, retry logic, p-limit)
└── scratch_test.js   Firebase credential check
```

## Known limitations

- **Hour-of-day for weather:** `/weather/advisory` picks the current hour using the server's clock rather than the location's timezone, so on a server running in UTC the reading can be a couple of hours off for Zimbabwe.
- **Rate limiting is in-memory,** so counters reset on restart and aren't shared if you run more than one instance.
- **No automated tests.** The `scratch/` scripts are manual checks, not a test suite.
- Android notifications only. iOS payload options aren't configured.
