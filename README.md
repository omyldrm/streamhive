# StreamHive

**One platform for streams, donations and supporters.**
Go live from your phone or browser with no OBS and no powerful PC. Viewers watch, chat, donate and support streamers monthly without leaving the stream.

Team 2 · KdG · Problem statement dated 05.11.2026

---

## How StreamHive answers the problem statement

| Problem (from the problem statement) | What StreamHive does |
|---|---|
| Beginners must install and configure OBS | **Go live in the browser.** Open *Go live*, tap *Use camera* or *Share screen*, add a title, press *Go live*. Nothing to install. |
| Streaming needs a powerful computer | Works on a **phone** or a basic laptop. The browser encodes the video in hardware. You can switch between front and back cameras. |
| Donations live on external services | **Built-in donations** with preset or custom amounts and a message. A fee breakdown (8% commission, payment processing included) is shown before paying. The donation appears as an on-stream alert and in chat. |
| No regular, predictable support | **Monthly supporter tiers** (Bronze €2.99 / Silver €4.99 / Gold €9.99). Supporters get chat badges and a place on the supporter wall. Cancel any time and keep the perks until the paid month ends. Tier changes take effect at the next renewal, so nobody is double-charged. |
| Community spread over different sites | Each channel has **live chat**, a **community wall** and a **supporter wall** in the same place. |
| Viewers follow several streamers | **Follow** channels, get a **live notification** when they go live, and use the *Following* page with live channels on top. |
| Payments must be simple, safe and transparent | All amounts are in euro cents. The 8% commission (business model target 8–10%, below external donation services) is shown up front. Every viewer has a receipt and payment history (*My support*), and every streamer has an earnings dashboard. |

## Features

- **Studio** (`#/live`): camera or screen share (mic and tab/system audio are mixed), camera flip, mute and video toggles, live timer, viewer count, earnings for the current stream, live chat, donation/subscription alerts. Thumbnails are captured automatically for the browse page.
- **Watch page** (`#/c/<username>`): low-latency video, a "tap to unmute" control, full screen, alerts overlay, chat, Follow / Subscribe / Donate, About / Community / Supporters tabs.
- **Browse**: live streams sorted by viewers, category filters, channel search.
- **Creator dashboard**: net/gross earnings, fees, this month's earnings, expected monthly income from supporters, top supporters, recent support, past streams with peak viewers.
- **My support**: active subscriptions (cancel/resume), total given, monthly commitment, full payment history with receipts.
- **Accounts**: sign up / log in (scrypt-hashed passwords, 30-day sessions), profile and bio settings.
- **Public pages**: landing page (`#/`, `#/about`) built around the hive metaphor (Hive = stream, Bees = viewers, Honey = donations, Flowers = regular support), Pricing with a fee calculator and the planned Viewer/Streamer Premium, Help center with a contact form, Community guidelines, Advertise & sponsor, Terms of use and Privacy policy (drafts), and a site-wide footer.
- **Hive Pro** (€19.99/month, "Streamer Premium" in the business model): HD streaming up to 1080p with a higher bitrate, a 6% fee instead of 8%, a PRO badge, boosted placement in Rising channels, Pro analytics in the dashboard, priority support and no ads (the Pro member watches and browses without ads or sponsored messages). Stream recordings and custom alerts/emotes are shown as "coming soon". Cancel anytime; perks last until the end of the paid month.
- **Screen sharing with a camera bubble**: share a window, tab or your whole screen (with tab/system audio mixed with your mic), and turn on a camera bubble that viewers see in the corner. The bubble is sent as a separate small video, so it keeps working while you're in another window; a WebRTC data channel tells viewers when it's on. "Stop sharing" switches back to the camera without dropping viewers.
- **Donate while a streamer is offline**: from the offline channel screen, the Donate button or the 💛 button on Following cards. The donation is tagged "while offline"; when the streamer next goes live they get a summary ("While you were offline, N donations came in") and the messages appear in their chat so they can say thanks.
- **Light and dark theme** with a toggle in the header (remembered per browser, defaults to the device setting).
- **Growth and safety**: a Share button for channel links (social media), confidential Report on every channel, a support/feedback/advertising contact form (stored in `data/db.json` under `feedback`), and self-service account deletion.
- Mobile-first layout with a bottom navigation bar on phones. It can be installed as a web app (manifest included).

## Run it

Requires **Node.js 18 or newer**. There are no dependencies to install.

```bash
npm start
# → StreamHive is running at http://localhost:3000
```

Open <http://localhost:3000>, create an account and press **Go live**.
To watch your own stream, open the channel in a **second browser or a private window** and log in with a different account (or watch anonymously).

### Testing on a phone

Browsers only allow camera access on **HTTPS** (or `localhost`). To go live from a phone on your network, use one of these options:

- **HTTPS directly:** create a certificate (for example with [mkcert](https://github.com/FiloSottile/mkcert)) and start with
  ```bash
  SSL_KEY=key.pem SSL_CERT=cert.pem npm start
  ```
- **Tunnel:** expose port 3000 over HTTPS with a tunnel service such as `cloudflared tunnel --url http://localhost:3000`.

Watching does not need HTTPS. Only going live does.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Where `db.json` is stored |
| `SSL_KEY`, `SSL_CERT` | none | Serve over HTTPS |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | none | TURN relay for viewers behind strict firewalls (comma-separate multiple URLs) |

### Tests

```bash
npm test
```

This runs an end-to-end API test against a real server instance: accounts, account deletion, contact/report messages, follows, going live, WebRTC signalling permissions, chat, donations and fees, the subscription lifecycle (subscribe / no double charge / upgrade at renewal / cancel / resume), community posts, dashboards and ending a stream.

## Architecture

```
public/            Web app (vanilla HTML/CSS/JS, no build step)
  index.html       Landing page (home)
  browse.html      Browse: live streams + discover channels
  following.html   Following: your channels, live on top
  live.html        Go live: the browser studio
  about.html       About us: why we built StreamHive
  contact.html     Contact form
  premium.html     Hive Pro: the €19.99/month streamer plan
  presets.html     Stream presets: ready-made studio setups (source, mic profile, category, title, tips)
  theme.js         Applies the light/dark theme before the page paints
  mock.js          Demo mode with sample data (used when pages are opened as files)
  app.js           Router, pages, WebRTC broadcaster + viewer, chat, payment flows
  style.css
server.js          Node.js server (zero dependencies)
                   • REST API under /api
                   • Server-Sent Events (/api/events) for chat, alerts, live status, WebRTC signalling
                   • JSON file storage in data/db.json
test/api.test.js   End-to-end API test
```

**How video gets from the streamer to the viewers:** the streamer's browser captures the camera or screen and sends it to each viewer over **WebRTC**. The server only relays the small connection-setup messages (offer, answer, ICE candidates) and checks that a peer may only signal between a live streamer and a viewer in that streamer's room. As a result, the server never handles video, which keeps hosting cheap and latency around one second.

## Moving from prototype to production

This is a complete, working product prototype. These parts are deliberately simplified and should be upgraded for a public launch:

1. **Payments run in demo mode.** No real money moves, and every payment screen says so. For production, connect a licensed payment service provider with marketplace payouts, such as **Mollie Connect** (popular in Belgium, supports Bancontact) or **Stripe Connect**. The provider then handles PSD2 / Strong Customer Authentication, KYC of streamers (anti-money-laundering rules), refunds and chargebacks. Card data never touches StreamHive. The `charge()` function in `server.js` is the single place to swap in.
2. **Scaling video.** Peer-to-peer delivery is ideal for beginners with small audiences. Each viewer uses some of the streamer's upload bandwidth, so expect roughly 5–15 viewers on mobile data and more on good Wi-Fi. For larger audiences, route video through an SFU (for example LiveKit or mediasoup). The browser studio stays exactly the same.
3. **TURN server.** Some viewers on corporate or mobile networks need a relay. Set the `TURN_*` variables (for example with coturn).
4. **Database.** Replace the JSON file with PostgreSQL once there are many users.
5. **Moderation and safety.** Add reporting, chat moderation tools (timeouts, banned words), age rating and content policies.
# streamhive
