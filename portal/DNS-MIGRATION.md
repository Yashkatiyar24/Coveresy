# Putting the portal on admin.coveresy.com

Captured from the live zone on 13 October 2026, before any change.

## Why DNS has to move

Cloudflare Workers only attach to a custom domain when that domain's DNS is
served by Cloudflare. `coveresy.com` is currently on GoDaddy
(`ns49/ns50.domaincontrol.com`). A CNAME from GoDaddy to `workers.dev` does not
work — Cloudflare will not match the route or issue a certificate for it.

So the nameservers move to Cloudflare. Everything else about the domain stays
as it is: the landing page keeps being served by Vercel, and email keeps being
served by Microsoft 365. Cloudflare just answers the DNS questions.

## The actual risk: email

**`coveresy.com` runs company email on Microsoft 365.** If the records below are
not recreated exactly, inbound mail stops and outbound mail starts failing SPF
and DKIM. This is the part to be careful about — not the website.

Cloudflare scans the existing zone when you add the domain and usually imports
all of this automatically. **It is not guaranteed to catch everything**, so check
every row below against what Cloudflare imported before you switch nameservers.

## The records that must exist in Cloudflare before the switch

Proxy status matters. Anything marked **DNS only** must show a grey cloud, not
an orange one — proxying Vercel or mail through Cloudflare breaks them.

| Type | Name | Value | Proxy | Purpose |
|---|---|---|---|---|
| A | `@` | `216.198.79.1` | **Proxied** (orange) | Vercel — landing page |
| CNAME | `www` | `5535e23b6cf5f52b.vercel-dns-017.com` | **Proxied** (orange) | Vercel — landing page |
| MX | `@` | `coveresy-com.mail.protection.outlook.com` priority `0` | n/a | **Email — inbound** |
| TXT | `@` | `v=spf1 include:spf.protection.outlook.com -all` | n/a | **Email — SPF** |
| TXT | `@` | `v=verifydomain MS=3266905` | n/a | **Email — M365 domain proof** |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` | n/a | **Email — DMARC** |
| TXT | `google._domainkey` | see below, one line, no spaces | n/a | **Email — DKIM** |
| CNAME | `autodiscover` | `autodiscover.outlook.com` | **DNS only** | Outlook client setup |
| CNAME | `enterpriseregistration` | `enterpriseregistration.windows.net` | **DNS only** | Entra device join |
| CNAME | `enterpriseenrollment` | `enterpriseenrollment-s.manage.microsoft.com` | **DNS only** | Intune enrolment |
| TXT | `_vercel` | `vc-domain-verify=www.coveresy.com,3abf6354444dfae8401b` | n/a | Vercel ownership |
| TXT | `_vercel` | `vc-domain-verify=coveresy.com,0e77bda91983b76fefa7` | n/a | Vercel ownership |

`_domainconnect` → `_domainconnect.gd.domaincontrol.com` is GoDaddy's own
convenience record. It can be dropped.

### DKIM value, verbatim

The live record is split into two 255-character chunks, as DNS requires. They
join with **no separator**. Paste this as a single line — a stray space silently
breaks mail signing:

```
v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvnZcbI0tPBG5T+0pzUs7EolpuDR/NdoJOM8cmcmVAGxPH0EcY/htbyrTADqL04PGAbFkX/yQWd7vCYRjX9csC1N8zV+0zBgEKS9uUWH/xcgj3FDGxEsIZLIu+xthUH6PqfxcccHFJEc5ja2WxV6LtO6lyP6KV4e+9qLlmIO26Pa6hIVKeNMTySfKK9bYxo0zgXgNa9l3kVoFRb9eT+47xc/EBNRenvZ5I9Kun+6m6xMP6NY5c5bBzr7VJQOc7pbOSNPXkrf3xIQ0xt8nC8KXd0+87HRqmH4aba+Q635cFsNnDWZkHZoeStgA3ul7MtqB3SkPkdGgyZ2l9ze4A3jP6wIDAQAB
```

## Why the website records must be proxied for a /admin path

A Worker route on a path (`admin.coveresy.com*`) only fires if that hostname is
**proxied** through Cloudflare — orange cloud. Cloudflare then sits in front of
the whole domain: it answers `/admin*` from the Worker and passes everything else
through to Vercel.

That is the trade a path makes. `admin.coveresy.com` as a subdomain would leave
Vercel on grey-cloud and completely untouched; `admin.coveresy.com` cannot.

Two settings matter once the apex and `www` are proxied:

- **SSL/TLS mode must be Full (strict).** Anything less loops or breaks, because
  Vercel always serves HTTPS and redirects HTTP.
- **Leave the mail and Microsoft rows unproxied.** MX cannot be proxied at all,
  and `autodiscover`, `enterpriseregistration` and `enterpriseenrollment` must
  stay grey-cloud.

Check `https://www.coveresy.com` immediately after enabling the proxy, before
going further. If anything is off, set those two records back to DNS only — the
landing page returns to being served straight from Vercel.

## Order of work

Do every Cloudflare step first. The GoDaddy nameserver change is the only
irreversible-feeling moment, and by then Cloudflare is already answering
correctly — so it is a no-op for users.

### Step 1 — Add the domain to Cloudflare (nothing changes yet)

1. Sign in at <https://dash.cloudflare.com> on **Anwar's account** (create it if
   needed — a free account is enough; Workers routes work on the Free plan).
2. **Add a domain** → type `coveresy.com` → continue.
3. Choose the **Free** plan.
4. Cloudflare scans the existing GoDaddy zone and lists what it found. This
   changes nothing: GoDaddy is still live and authoritative.
5. At the end Cloudflare shows **two nameservers**, like
   `dana.ns.cloudflare.com` / `rick.ns.cloudflare.com`. Write them down.
   **Do not change anything at GoDaddy yet.**
### Step 2 — Reconcile the records

In Cloudflare → **DNS** → **Records**, compare against the table above. Add
anything missing; the scan is good but not guaranteed to be complete, and the
email rows are the ones that matter.

For this first pass set **every** record to **DNS only** (grey cloud), including
the apex `A` and `www`. That makes Cloudflare behave exactly like GoDaddy does
today — same answers, no proxying, no new behaviour. The orange cloud comes
later, as its own step, so that if anything misbehaves you know which change
caused it.
3. **Verify before switching.** Query Cloudflare's nameservers directly, while
   the domain is still live on GoDaddy — this changes nothing for users:
   ```bash
   CF=<one of the nameservers Cloudflare gives you>
   dig @$CF coveresy.com MX +short
   dig @$CF coveresy.com TXT +short
   dig @$CF google._domainkey.coveresy.com TXT +short
   dig @$CF www.coveresy.com CNAME +short
   ```
   The answers must match the table. **Do not continue until they do.**
4. **Switch nameservers at GoDaddy** to the pair Cloudflare gives you.
   Propagation is usually minutes; allow up to 24 hours. The site and email keep
   working throughout, because both sets of nameservers return the same answers.
5. **Confirm after propagation:**
   ```bash
   dig NS coveresy.com +short          # expect the Cloudflare pair
   dig MX coveresy.com +short          # expect outlook
   curl -sI https://www.coveresy.com   # expect the landing page
   ```
   Send a test email in and out before considering the move done.
### Step 5 — Turn on the proxy (a separate, reversible change)

Only once the site and email have been confirmed healthy on Cloudflare DNS:

1. **SSL/TLS → Overview → Full (strict)**. Do this *before* the orange cloud.
   Any weaker mode causes a redirect loop, because Vercel always serves HTTPS.
2. **DNS → Records**: switch the apex `A` and the `www` CNAME to **Proxied**
   (orange cloud). Leave MX and the Microsoft rows grey.
3. Load `https://www.coveresy.com`. If anything is wrong, set those two records
   back to **DNS only** and you are immediately back to Vercel serving directly.
7. **Only then deploy the portal:** `npm run deploy:prod`. The routes in
   `wrangler.toml` claim `admin.coveresy.com*` and `www.admin.coveresy.com*`;
   everything else on the domain keeps going to Vercel.
8. **Verify the live portal**, which is the §20 acceptance run:
   ```bash
   BASE=https://admin.coveresy.com SETUP_TOKEN=<token> ./test/smoke.sh
   ```

## Rollback

Set the nameservers at GoDaddy back to `ns49.domaincontrol.com` and
`ns50.domaincontrol.com`. GoDaddy keeps the old zone, so this restores the
previous state. Rollback is limited by DNS propagation, which is why step 3
exists — verify before the switch, not after.

## Afterwards

`admin.coveresy.com` is internal. Consider putting Cloudflare Access in front of
that path, so reaching the login page needs a company identity as well as a
password. That is a Cloudflare dashboard setting and needs no change to this
code.

The portal's session cookie is scoped `Path=/admin`, so it is never sent with
requests to the marketing site sharing the domain.
