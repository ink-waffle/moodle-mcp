# The Moodle Integration Cookbook

Practical, battle-tested notes on building integrations against **arbitrary** Moodle sites —
different universities, different versions, different admin configurations, none of which you
control.

The sibling documents in this directory describe what Moodle *is*. This one describes what
actually happens when you try to use it.

| Document | Covers |
|---|---|
| `web-services-api.md` | Endpoints, token mechanics, calling conventions, REST/XML-RPC formats, the error-code catalogue, the function catalogue |
| `data-model.md` | Schema, contexts and roles, gradebook internals, completion, calendar, the file API |
| `activity-modules.md` | Per-`mod_*` details and state machines |
| **`integration-cookbook.md`** (this file) | Recipes, traps, and decisions: how to authenticate against a site you have never seen, how to feature-detect, what breaks in practice, and how to debug it |

Where this file needs a fact that belongs to a sibling — the exact shape of a response, the
meaning of a context level — it names the sibling rather than restating it.

## How claims in this file are marked

The value of this document is that most of it was *executed*, not read.

- **[verified on 4.5.13]** — reproduced live against a production Moodle
  `4.5.13 (Build: 20260810)`, version string `2024100713`, a Finnish university site with
  Shibboleth SSO, 450 exposed web-service functions, running as an ordinary enrolled
  **student** (no elevated capabilities). Exact request and exact response text are quoted.
- **[per docs]** — from moodledev.io / docs.moodle.org / the Moodle source on
  `MOODLE_405_STABLE`, not exercised here.
- **[reported]** — from the Moodle tracker or community forums; other people's failures.
  Cited with the issue key or discussion id so you can read the original. Where a Moodle HQ
  developer answered, they are quoted verbatim and named — those answers are the closest thing
  to authoritative documentation that exists for several of the behaviours below.

**Read [§3.0](#30-the-one-principle-that-unifies-most-of-this-section) before anything
else.** It states the single behaviour that explains most of the surprises in this document,
and it is the one thing that will not be obvious from the API reference.

A student token was deliberately used, because that is the hard case. Anything an admin
token can do is a superset, and most of the painful surprises in this document are
permission-shaped: they simply do not reproduce for an admin.

Everything below was produced with **read-only** calls (`_get_`, `_search_`, `_is_`,
`_can_`, `_check_`). Nothing was submitted, posted, enrolled, started, or marked viewed.
That constraint is itself a recipe — see [§8](#8-security-and-etiquette).

---

## Table of contents

1. [Connecting to a site you have never seen](#1-connecting-to-a-site-you-have-never-seen)
   - 1.1 [The probe](#11-the-probe-tool_mobile_get_public_config)
   - 1.2 [The decision tree](#12-the-decision-tree)
   - 1.3 [typeoflogin 1: direct token exchange](#13-typeoflogin1-direct-token-exchange)
   - 1.4 [typeoflogin 2/3: browser SSO and launch.php](#14-typeoflogin23-browser-sso-and-launchphp)
   - 1.5 [When managetoken.php is blocked](#15-when-usermanagetokenphp-is-blocked)
   - 1.6 [The fallback ladder](#16-the-fallback-ladder)
   - 1.7 [Session cookies and /lib/ajax/service.php](#17-session-cookies-and-libajaxservicephp)
2. [Capability discovery](#2-capability-discovery) — feature-detect with `functions[]`, build a support matrix, degrade honestly
3. [**The gotcha catalogue**](#3-the-gotcha-catalogue) — 28 entries, index table then one subsection each
4. [Rate limits, sizes and performance](#4-rate-limits-sizes-and-performance) — measured costs, batching (and its fail-fast trap), caching, pagination
5. [Text handling](#5-text-handling) — `moodlewssetting*`, `@@PLUGINFILE@@`, multilang, HTML→markdown for an LLM
6. [Files: download and upload](#6-files-download-and-upload) — signing URLs, the JSON-instead-of-a-file trap, the draft-itemid dance
7. [Version differences that bite](#7-version-differences-that-bite) — 3.9 → 5.2, what moved and how to span it
8. [Security and etiquette](#8-security-and-etiquette) — what a token is worth, storing it, not hammering a university
9. [Debugging recipes](#9-debugging-recipes) — `curl` per transport, the four failure classes, shell traps
10. [Reference implementation notes](#10-reference-implementation-notes) — a working MCP server, read as a worked example

- [Appendix A: the read-only function allow-list](#appendix-a-the-read-only-function-allow-list)
- [Appendix B: the reproduction environment](#appendix-b-the-reproduction-environment)
- [Appendix C: sources](#appendix-c-sources) — including a table of **claims this document deliberately does not make**

---

## 1. Connecting to a site you have never seen

You have a hostname. You do not know the Moodle version, whether web services are on,
whether the site uses a local password or SAML, or whether your user is allowed to mint a
token. Everything follows from one unauthenticated call.

### 1.1 The probe: `tool_mobile_get_public_config`

This is the single most useful call in Moodle, and the only interesting one that needs no
credentials. It is what the official Moodle app fires the instant you type a site URL.

**Do not call it through `/webservice/rest/server.php`.** That endpoint always demands a
token, even for functions marked as available to unauthenticated callers:

```bash
curl -s -X POST https://moodle.example.edu/webservice/rest/server.php \
  -d 'moodlewsrestformat=json' \
  -d 'wsfunction=tool_mobile_get_public_config'
```

```json
{"exception":"core\\exception\\moodle_exception","errorcode":"invalidtoken",
 "message":"Virheellinen avain - avainta ei löytynyt"}
```

**[verified on 4.5.13]** — and note the message came back in **Finnish**, the site's default
language, because with no token there is no user whose language preference could be used.
This is your first encounter with the rule that governs all Moodle error handling: *match on
`errorcode`, never on `message`*. See [§3.14](#314-error-messages-arrive-in-a-language-you-did-not-choose).

The correct endpoint is the AJAX no-login service:

```bash
curl -s -X POST \
  'https://moodle.example.edu/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config' \
  -H 'Content-Type: application/json' \
  -d '[{"index":0,"methodname":"tool_mobile_get_public_config","args":{}}]' \
  | python3 -m json.tool
```

The reply is a *list* — the AJAX service is a batch protocol — whose single element has
`error` and `data`:

```json
[
  {
    "error": false,
    "data": {
      "wwwroot": "https://moodle.tuni.fi",
      "sitename": "TUNI Moodle | Tampere universities",
      "guestlogin": 0,
      "registerauth": "",
      "forgottenpasswordurl": "",
      "authnoneenabled": 0,
      "enablewebservices": 1,
      "enablemobilewebservice": 1,
      "maintenanceenabled": 0,
      "maintenancemessage": "<h3 class=\"h6 font-weight-bold mb-0\">TUNI Moodle service break Wed 26.8.2026 6:00-7:00</h3>",
      "typeoflogin": 2,
      "launchurl": "https://moodle.tuni.fi/admin/tool/mobile/launch.php",
      "tool_mobile_disabledfeatures": "",
      "identityproviders": [
        { "name": "Kirjaudu TUNI tunnuksella", "iconurl": "",
          "url": "https://moodle.tuni.fi/auth/shibboleth/index.php" }
      ],
      "country": "FI",
      "agedigitalconsentverification": false,
      "autolang": 1,
      "lang": "fi",
      "langmenu": 1,
      "tool_mobile_minimumversion": "",
      "tool_mobile_qrcodetype": 2,
      "warnings": [],
      "showloginform": 1
    }
  }
]
```

**[verified on 4.5.13]**

Fields that decide what you do next:

| Field | Meaning | What it forces |
|---|---|---|
| `enablewebservices` | Site-wide web services master switch | `0` → nothing works. Stop. |
| `enablemobilewebservice` | The `moodle_mobile_app` service is enabled | `0` → **no token can be minted by you at all**. See [§1.6](#16-the-fallback-ladder). |
| `typeoflogin` | How users authenticate | `1` → password exchange; `2`/`3` → browser; `6` → app-only |
| `launchurl` | Override for `admin/tool/mobile/launch.php` | Use it verbatim if present |
| `identityproviders[]` | SSO buttons (SAML2, Shibboleth, OAuth2, CAS) | Tells the human which button to click |
| `maintenanceenabled` | Site is in maintenance mode | Back off; see [§8.4](#84-respect-maintenance-mode) |
| `tool_mobile_disabledfeatures` | Comma-separated list of app features the admin switched off | Some sites disable e.g. `NoDelegate_CoreOffline`, messaging, or grades wholesale |
| `showloginform` | Whether the local login form is shown at all | `0` + `identityproviders` → SSO is mandatory |
| `lang` / `autolang` | Site default language | Explains the language of unauthenticated error text |

`enablewebservices` and `enablemobilewebservice` are the two that most often end an
integration before it starts. Many institutions run Moodle with web services on for internal
integrations but the mobile service off, which means the official app does not work either —
if the students can use the app, you can mint a token.

### 1.2 The decision tree

```
GET /lib/ajax/service-nologin.php?info=tool_mobile_get_public_config
│
├── HTTP error / not JSON / no "data"
│      └── Not a Moodle site, or wrong URL, or a WAF in front of it.
│          Try https:// and non-https, with and without a /moodle path suffix.
│
├── enablewebservices == 0
│      └── STOP. No web-service route exists. Browser automation only. (§1.6)
│
├── enablemobilewebservice == 0
│      └── STOP for token minting. /login/token.php will refuse for the
│          moodle_mobile_app service. An admin could create a bespoke service
│          plus a token for you; you cannot self-serve. (§1.5, §1.6)
│
├── maintenanceenabled == 1
│      └── WAIT. Show maintenancemessage to the user; retry later. (§8.4)
│
├── typeoflogin == 1        (login via the Moodle form, local accounts)
│      └── POST /login/token.php with username+password     → §1.3
│
└── typeoflogin == 2 or 3   (login via browser / embedded browser; SSO)
       └── Browser login, then GET admin/tool/mobile/launch.php and
           capture the urlscheme:// redirect                    → §1.4

   (any other integer: not a core value — treat as 1, "app-native login")
```

`typeoflogin` comes from `tool_mobile`'s constants. **Core defines exactly three**, and they
have been unchanged since Moodle 3.2 **[per source, `admin/tool/mobile/classes/api.php`]**:

```php
const LOGIN_VIA_APP = 1;               // app renders its own form, POSTs to /login/token.php
const LOGIN_VIA_BROWSER = 2;           // SSO via the system browser + launch.php
const LOGIN_VIA_EMBEDDED_BROWSER = 3;  // SSO via an in-app browser + launch.php
```

There is **no value 4, 5 or 6** in core — despite what several third-party write-ups claim.
The server reads the admin setting and returns it with no validation beyond `PARAM_INT`,
so a branded distribution, Moodle Workplace, or a direct database write *could* emit any
integer. **Treat any value other than 2 and 3 as "app-native login" (i.e. try
`/login/token.php`).** For an integration, the only distinction that matters is
"can I POST a password?" versus "must a human drive a browser?".

> **Practical note.** `typeoflogin` describes the *site's* preference, not a hard rule. A
> site with `typeoflogin: 2` may still have local accounts whose password `/login/token.php`
> would accept. It is legitimate to try the password exchange first when you already hold
> credentials, and fall back to the browser flow on `invalidlogin`. Do **not** do this
> speculatively with guessed credentials — see [§8.5](#85-login-lockout-is-real).

### 1.3 `typeoflogin=1` — direct token exchange

```bash
curl -s -X POST https://moodle.example.edu/login/token.php \
  -d 'username=jdoe' \
  -d 'password=hunter2' \
  -d 'service=moodle_mobile_app'
```

Success:

```json
{"token":"a94533547ad3b4e003d07f6a0f7075d6","privatetoken":"XXXX"}
```

Failure **[verified on 4.5.13]**, with deliberately wrong credentials on a `typeoflogin: 2`
site:

```json
{"error":"Kirjautuminen epäonnistui, yritä uudelleen","errorcode":"invalidlogin",
 "stacktrace":null,"debuginfo":null,"reproductionlink":null}
```

Note the envelope: `{"error": ..., "errorcode": ...}`. This is **not** the same shape as a
web-service exception (`{"exception":..., "errorcode":..., "message":...}`). You need both
parsers. See [§3.2](#32-there-are-three-different-error-envelopes).

Error codes you will meet here **[per docs]**:

| `errorcode` | Meaning | Recovery |
|---|---|---|
| `invalidlogin` | Wrong username or password | Ask again — but count attempts ([§8.5](#85-login-lockout-is-real)) |
| `enablewsdescription` | Web services are disabled site-wide | Dead end |
| `usernotconfirmed` | Account never confirmed by email | User must confirm |
| `sitepolicynotagreed` | Site policy pending | User must accept it in a browser first |
| `forcepasswordchangenotice` | Password change required | Browser |
| `potentialidporigin` / `noguest` | Guest account tried | Not usable |
| `servicenotavailable` | The named service exists but this user is not authorised for it | The service is in "authorised users only" mode — an admin must add this user to it |

`service=moodle_mobile_app` is the built-in service name and has been stable since 2.x
**[per docs]**. If an admin created a custom service, its *shortname* goes there instead —
and note it matches `external_services.shortname`, a field older admin UIs did not let you
edit **[[MDL-30229](https://tracker.moodle.org/browse/MDL-30229)]**.

**Three constraints that decide whether this route is available at all:**

- **`/login/token.php` is username/password only.** A user whose account is `auth = oauth2`
  (Google/Microsoft sign-in) or SAML **cannot mint a token here** — they get plain
  `invalidlogin`, indistinguishable from a typo **[reported —
  [d=358237](https://moodle.org/mod/forum/discuss.php?d=358237), no replies]**. This is the
  practical reason [§1.4](#14-typeoflogin23-browser-sso-and-launchphp) is not optional: for
  federated accounts the browser flow is the *only* flow, regardless of what `typeoflogin`
  says.
- **Always POST.** Credentials sent via GET land in web-server access logs; Moodle 5.3 will
  reject them outright **[[MDL-87010](https://tracker.moodle.org/browse/MDL-87010)]**.
- **`&lang=` controls the error language here.** This endpoint is outside the reach of
  `moodlewssettinglang`, so appending `&lang=en` is the one lever that makes
  `token.php` errors readable **[[MOBILE-4390](https://tracker.moodle.org/browse/MOBILE-4390),
  fixed 4.3.0]** — *"we just need to append `&lang=X` to any request going to
  login/token.php."* Useful for [§3.14](#314-error-messages-arrive-in-a-language-you-did-not-choose).

Ops note for anyone running an integration at scale: a single misbehaving mobile client has
been observed generating **4 000 failed `token.php` calls per day** and HTTP 500s
**[reported — [d=455729](https://moodle.org/mod/forum/discuss.php?d=455729)]**. Do not retry
this endpoint in a loop ([§8.5](#85-login-lockout-is-real)).

**`privatetoken`.** When present, it can be exchanged via
`tool_mobile_get_autologin_key` for a one-shot URL that logs a browser in as that user. It
is strictly more dangerous than the web-service token. If you do not need SSO-into-browser,
**discard it** — do not persist it.

### 1.4 `typeoflogin=2/3` — browser SSO and `launch.php`

For SSO sites there is no password to POST. The flow Moodle's own app uses:

1. Send the human to `{wwwroot}/login/index.php` in a real browser and let them complete
   whatever the institution requires — SAML, Shibboleth, MFA, a consent screen.
2. With that browser session's cookies, request:

```
{launchurl}?service=moodle_mobile_app&passport=<random>&urlscheme=moodlemobile
```

   where `{launchurl}` is `public_config.launchurl`, defaulting to
   `{wwwroot}/admin/tool/mobile/launch.php`.

3. Moodle answers **HTTP 303** with a `Location:` header pointing at a custom scheme:

```
Location: moodlemobile://token=<base64>
```

   The scheme is whatever you sent as `urlscheme` — **unless** the site sets
   `tool_mobile/forcedurlscheme`, which overrides it **[per source]**. Parse the `token=`
   query parameter out of the `Location` header regardless of scheme rather than matching
   on `moodlemobile://`.

4. Base64-decode the `token=` value. The plaintext is colon-triple separated. From the
   server source **[per source, `admin/tool/mobile/launch.php`, unchanged 3.9 → 5.2]**:

```php
$siteid   = md5($CFG->wwwroot . $passport);
$apptoken = $siteid . ':::' . $token->token;
if ($privatetoken && is_https() && !$siteadmin) { $apptoken .= ':::' . $privatetoken; }
$location = "$urlscheme://token=" . base64_encode($apptoken);
```

   So element `[0]` is `md5(wwwroot . passport)` — a **signature**, not the passport itself.
   The official app recomputes it to prove the token came back from the site it asked
   (retrying with `http`↔`https` swapped). Element `[1]` is the web-service token you want.

   Note the conditions on `privatetoken`: it is withheld over plain HTTP, **and withheld
   entirely for site administrators**. An admin account therefore can never use the
   auto-login / QR-login flow.

**The critical mechanic:** you must capture the `Location` header *without following it*.
The `moodlemobile://` hop has no handler, so a browser aborts the navigation and a naive
`fetch`/`curl` with redirect-following reports a failure — after the header you needed has
already gone past.

```bash
# with a cookie jar already holding a logged-in session
curl -s -D - -o /dev/null --max-redirs 0 \
  'https://moodle.example.edu/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=123456789&urlscheme=moodlemobile' \
  -b cookies.txt | grep -i '^location:'
```

Interpreting what comes back:

| Response | Meaning | Action |
|---|---|---|
| 303 with `Location: moodlemobile://token=...` | Success | Decode and store |
| 303 to `/login/index.php` | Not logged in yet | Keep polling; the human is not done |
| 200 with a rendered HTML page | The site interposes a confirmation/consent step | Show it to the human — do not try to auto-submit it |
| 303 to an IdP host | SSO handshake mid-flight | Follow it *in the browser*, not in your HTTP client |

Two implementation details that matter, both settled by the reference implementation
(`/Users/ink_waffle/MCPs/moodle-mcp/src/auth.ts`):

- **Probe headlessly first.** If the automation profile already holds a session, the token
  arrives with no window ever opening. Only when that fails do you need to show a human
  anything.
- **Poll, do not block.** Returning a `"waiting"` status and letting the caller re-invoke is
  much better than holding a request open for the minutes an SSO login can take. An MCP
  client or an HTTP caller will time out long before a user finishes typing a TOTP code.

### 1.5 When `/user/managetoken.php` is blocked

The obvious manual route — "log in, go to Preferences → Security keys, copy the token" —
is unavailable to students on a large share of institutional Moodles, which is exactly the
population you most often need to support.

**[verified on 4.5.13]**, unauthenticated:

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://moodle.tuni.fi/user/managetoken.php
# 303 https://moodle.tuni.fi/login/index.php
```

which only proves it requires login. The interesting case is a *logged-in student*, who
typically gets `nopermissions` on the page, because viewing it requires the
`moodle/webservice:createtoken` capability, which the default **Authenticated user** role
does not hold and many institutions do not grant to students **[per docs]**.

Why this matters:

- **You cannot tell the user "just paste your token"** as a universal fallback. For a large
  fraction of users the page does not exist.
- **The user cannot revoke your token.** `managetoken.php` is also the *only* self-service
  revocation UI. If it is blocked, the token you minted through `launch.php` can be killed
  only by an administrator, or by whatever expiry the admin configured, or by the site's
  `webservice` token cleanup. Say this out loud in your onboarding text
  ([§8.3](#83-a-token-you-cannot-revoke)).
- **`launch.php` still works.** This is the key asymmetry: `moodle/webservice:createtoken`
  gates the *manual* token page, but the mobile launch flow issues tokens for the
  `moodle_mobile_app` service under a different check (`enablemobilewebservice` plus the
  user being allowed to use the service). A student who cannot see `managetoken.php` can
  virtually always still mint a mobile token. **Prefer `launch.php` over asking for a
  pasted token, always.**

### 1.6 The fallback ladder

Try these in order. Each rung is meaningfully worse than the one above it.

| # | Route | Requires | Gets you |
|---|---|---|---|
| 1 | `launch.php` after browser login | `enablemobilewebservice=1` | A full web-service token. **Best.** |
| 2 | `/login/token.php` username+password | `typeoflogin=1`-ish, local password | Same token, no browser |
| 3 | User pastes a token from `managetoken.php` | `moodle/webservice:createtoken` | Same token; usually unavailable to students |
| 4 | Admin creates a bespoke service + token | An admin who will talk to you | A token scoped to exactly the functions you asked for. Best for institutional integrations, useless for a personal tool |
| 5 | Session cookie + `/lib/ajax/service.php` | A logged-in browser session | **A small, awkward subset.** See below |
| 6 | Full browser automation, scraping HTML | A logged-in browser | Everything a user can see, slowly and brittly |

Rung 5 deserves its own section because it looks far more promising than it is.

### 1.7 Session cookies and `/lib/ajax/service.php`

When no token is possible, the remaining machine-readable surface is the endpoint Moodle's
own web UI uses. It authenticates with the `MoodleSession` cookie plus a `sesskey`, and it
speaks the same batch-of-JSON protocol as `service-nologin.php`:

```bash
curl -s -X POST \
  'https://moodle.example.edu/lib/ajax/service.php?sesskey=SESSKEY&info=core_course_get_enrolled_courses_by_timeline_classification' \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '[{"index":0,"methodname":"core_course_get_enrolled_courses_by_timeline_classification","args":{"classification":"inprogress","limit":10,"offset":0}}]'
```

`sesskey` is embedded in every rendered page — it appears in the JS config blob as
`"sesskey":"..."`, and in form inputs named `sesskey`.

**The severe limitation.** `service.php` will only dispatch a function whose declaration in
`db/services.php` carries `'ajax' => true`. That flag was added for the functions Moodle's
*own front end* calls, and it is a small minority. Concretely, the functions you would
actually want are mostly **not** ajax-enabled **[per docs, `lib/db/services.php` on
`MOODLE_405_STABLE`]**:

| Function | `ajax`? |
|---|---|
| `core_course_get_enrolled_courses_by_timeline_classification` | yes |
| `core_calendar_get_action_events_by_timesort` | yes |
| `core_course_get_contents` | **no** |
| `gradereport_user_get_grade_items` | **no** |
| `mod_assign_get_assignments` | **no** |
| `mod_forum_get_forum_discussions` | yes |
| `mod_forum_get_discussion_posts` | yes |
| `core_webservice_get_site_info` | **no** |
| `core_message_get_conversations` | yes |

Calling a non-ajax function through `service.php` fails with `servicerequireslogin` or an
access exception rather than returning data. So the cookie route gives you the dashboard,
the calendar and the forums — and **not** course structure, files, or the gradebook, which
are usually the whole point.

Additional friction on this rung:

- Sessions expire (typically 8 hours, `sessiontimeout`), and `sesskey` rotates with them.
- Some sites set `SameSite` and CSRF protections that make a non-browser client awkward.
- You are now indistinguishable from a scraper in the logs. See
  [§8](#8-security-and-etiquette).

**Recommendation:** treat rung 5 as a diagnostic curiosity, not an architecture. If
`enablemobilewebservice=0`, tell the user plainly that their institution has switched off the
interface you need, name the setting, and stop. That is a far better outcome than a fragile
half-integration that silently returns partial data.

---

## 2. Capability discovery

Never assume a function exists. Sites differ by version, by installed plugins, by which
functions the admin added to the mobile service, and by the calling user's role.

### 2.1 The one call that tells you everything

`core_webservice_get_site_info` returns, among much else, a `functions[]` array listing
**exactly** what this token may call.

```bash
curl -s -X POST "$MURL/webservice/rest/server.php" \
  -d "wstoken=$MTOK" -d 'moodlewsrestformat=json' \
  -d 'wsfunction=core_webservice_get_site_info' -o siteinfo.json
```

**[verified on 4.5.13]** the site returned **450** functions and these decision-relevant
fields:

```
release            = '4.5.13 (Build: 20260810)'
version            = '2024100713'
userid             = 135266
username           = 'drv382@tuni.fi'
lang               = 'en'
siteurl            = 'https://moodle.tuni.fi'
downloadfiles      = 1
uploadfiles        = 1
usercanmanageownfiles = True
userquota          = 524288000
usermaxuploadfilesize = 1073741824
userissiteadmin    = False
sitecalendartype   = 'gregorian'
usercalendartype   = 'gregorian'
limitconcurrentlogins = 0
advancedfeatures   = {'usecomments': 1, 'usetags': 1, 'enablenotes': 1, 'messaging': 1,
                      'enableblogs': 0, 'enablecompletion': 1, 'enablebadges': 0,
                      'messagingallusers': 0, 'enablecustomreports': 1,
                      'enableglobalsearch': 0, 'mnet_dispatcher_mode': 0,
                      'enablecompetencies': 0}
```

Three things to lift from this immediately:

- **`userid`** — you need it constantly, and several functions *require* it explicitly
  ([§3.4](#34-gradereport_user_get_grade_items-defaults-to-all-users)). Store it with the token.
- **`advancedfeatures`** — a direct, cheap feature matrix. `enableglobalsearch: 0` here
  told me before I ever called it that `core_search_get_results` would fail
  ([§3.9](#311-global-search-is-off-on-most-sites)). `enablecompletion`, `messaging`,
  `enablebadges`, `enablecompetencies` are equally load-bearing.
- **`downloadfiles` / `uploadfiles`** — whether this *service* permits file transfer at all.
  An admin can enable the service but leave file download off, and then every
  `pluginfile.php?token=` fetch fails no matter how correct your URL is.

### 2.2 `functions[].version` is not what you think

Each entry is `{"name": "...", "version": "..."}`. It is tempting to read `version` as
"the Moodle version in which this function's current signature was introduced". It is not —
it is the **version of the plugin that declares the function**.

**[verified on 4.5.13]** the distribution of `version` values across the 450 functions was:

```
2024100700 : 239   <- core, this Moodle release
2024100713 : 176   <- core, this Moodle release + patch level
2024100701 :  22
2026010500 :   3   <- a third-party plugin
2025111703 :   4   <- another
2026013100 :   4
2025032001 :   1
2024042219 :   1
```

So `version` distinguishes core from third-party plugins, and nothing else useful. **Use
presence in `functions[]` as your only signal.** Do not try to infer capability from the
number.

The same site's function list, by component **[verified on 4.5.13]**:

```
mod_*        : 215      core_*  : 176      tool_*  : 26
gradereport_*:   8      message_*: 6       enrol_* :  4
local_*      :   4      report_*:  3       qtype_* :  3
aiplacement_*:   3      block_* :  2
```

and the `mod_*` plugins exposing functions:

```
assign, bigbluebuttonbn, book, chat, choice, choicegroup, customcert, data,
feedback, folder, forum, glossary, h5pactivity, imscp, label, lesson, lti,
page, quiz, resource, scorm, subcourse, survey, url, wiki, workshop
```

Note `choicegroup`, `customcert` and `subcourse` — third-party modules, present on this site
and absent from a stock Moodle. Conversely a stock site would have `mod_*` functions this
one lacks. **This list is per-site data, not a constant.**

### 2.3 Building a support matrix

The pattern that works: declare, for each *feature* your product offers, the functions it
needs; intersect with `functions[]` at connect time; report the gaps to the human in their
terms, not in Moodle's.

```ts
const FEATURES: { feature: string; needs: string[] }[] = [
  { feature: "course list",           needs: ["core_enrol_get_users_courses"] },
  { feature: "course structure",      needs: ["core_course_get_contents"] },
  { feature: "activity lookup",       needs: ["core_course_get_course_module"] },
  { feature: "assignments",           needs: ["mod_assign_get_assignments"] },
  { feature: "submission state",      needs: ["mod_assign_get_submission_status"] },
  { feature: "per-course grades",     needs: ["gradereport_user_get_grade_items"] },
  { feature: "course totals",         needs: ["gradereport_overview_get_course_grades"] },
  { feature: "deadlines",             needs: ["core_calendar_get_action_events_by_timesort"] },
  { feature: "forums",                needs: ["mod_forum_get_forums_by_courses",
                                              "mod_forum_get_discussion_posts"] },
  { feature: "messages",              needs: ["core_message_get_conversations"] },
  { feature: "quizzes",               needs: ["mod_quiz_get_quizzes_by_courses"] },
  { feature: "file download",         needs: [] /* gated by siteinfo.downloadfiles */ },
];

function supportReport(info: SiteInfo): { ok: string[]; missing: {feature:string; why:string}[] } {
  const have = new Set(info.functions.map(f => f.name));
  const ok: string[] = [];
  const missing: {feature:string; why:string}[] = [];
  for (const { feature, needs } of FEATURES) {
    const gaps = needs.filter(n => !have.has(n));
    if (gaps.length === 0) ok.push(feature);
    else missing.push({ feature, why: `needs ${gaps.join(", ")}` });
  }
  if (!info.downloadfiles) missing.push({ feature: "file download",
    why: "the web service has file download disabled (siteinfo.downloadfiles = 0)" });
  return { ok, missing };
}
```

and then, at connect time, say something a human can act on:

```
Connected to TUNI Moodle | Tampere universities (https://moodle.tuni.fi)
as Damir Kairov <drv382@tuni.fi>, userid 135266, Moodle 4.5.13
450 web-service functions available.

Not available on this site (these features will be unavailable):
  - global search — the site has enableglobalsearch = 0
  - badges       — the site has enablebadges = 0
```

The rule is: **degrade the feature, do not fail the call.** A tool that returns
"this site has messaging switched off" is useful; one that returns
`[accessexception] Access control exception (core_message_get_conversations)` is not.

### 2.4 Feature-detect capability, not just existence

`functions[]` tells you what the *service* exposes. It says nothing about what your *role*
may do with it. `gradereport_user_get_grade_items` is present for every student and refuses
half its parameter space for them ([§3.4](#34-gradereport_user_get_grade_items-defaults-to-all-users)).

There is no "what capabilities do I have" web-service function. The realistic options:

1. **Read `advancedfeatures`** for site-level switches. Free, exact.
2. **Probe once, cheaply, and cache the answer.** For example, call
   `gradereport_overview_get_course_grades` (no arguments, cheap) at connect time; if it
   throws `nopermissions`, mark the grades feature degraded for this site+user.
3. **Derive from returned data.** `mod_forum_get_discussion_posts` returns a
   `capabilities` object *per post* **[verified on 4.5.13]**:

   ```json
   {"view":true,"edit":false,"delete":false,"split":false,"reply":false,
    "selfenrol":false,"export":false,"controlreadstatus":false,"canreplyprivately":false}
   ```

   Similarly `mod_assign_get_submission_status` returns `lastattempt.canedit` /
   `cansubmit`, and `core_course_get_contents` returns `uservisible` per module. Prefer
   these over guessing.

4. **Never probe by writing.** Do not "test" whether you can post by posting.

---
## 3. The gotcha catalogue

### 3.0 The one principle that unifies most of this section

**Moodle web services degrade by *omitting fields*, not by returning errors.**

If your token lacks a capability the function consults, you very often get **HTTP 200, no
`exception`, no `warnings[]` entry — and a response that is quietly missing properties**. This
is not a bug; it is the documented design. Andrew Lyons (Moodle HQ), answering a report that
`core_course_get_courses` lists the *write* capability `moodle/course:update` among its
requirements **[reported —
[moodle.org d=465079](https://moodle.org/mod/forum/discuss.php?d=465079), Jan 2025]**:

> "This is not a security bug but more of a confusing legacy part of Moodle's Web Service
> infrastructure. The list provided is a list of capabilities that the service **may** check,
> consume, or use to modify the output. **The list is used as an indication only and no checks
> are performed based on this list**, rather the service itself may use these capabilities at
> some point."

The reporter's concrete finding: without `moodle/course:update`, `core_course_get_courses`
still returns 200 OK but **drops `visible`, `maxbytes`, `categorysortorder`, `idnumber` and
`showgrades`**. He was debugging a missing `visible`.

The same shape recurs throughout this document:

| Where | What silently vanishes |
|---|---|
| `core_course_get_courses` | `visible`, `idnumber`, `showgrades`, `maxbytes` without `moodle/course:update` |
| `core_course_get_contents` | `availabilityinfo` and module settings for **student** tokens ([§3.13](#313-uservisible-false-hides-modules-you-can-still-see)) |
| `core_enrol_get_enrolled_users` | participants, without `moodle/user:viewdetails` (MDL-87242, fixed only in **5.2**) |
| `core_user_get_users` | **`email`**, depending on each user's `maildisplay` ([§3.29](#329-core_user_get_users-drops-email-and-being-an-admin-makes-it-worse)) |
| `gradereport_user_get_grade_items` | whole grade items, with no flag saying why ([§3.18](#318-hidden-and-locked-grade-items)) |
| `mod_assign_get_assignments` | modules, reported only in `warnings[]` ([§3.16](#316-warnings-is-where-your-missing-data-went)) |

**Therefore: validate the *shape* of every response, not just the absence of an `exception`.**

```ts
function expectFields<T extends object>(obj: T, required: (keyof T)[], ctx: string) {
  const missing = required.filter(k => !(k in obj));
  if (missing.length) {
    log.warn(`${ctx}: Moodle omitted ${missing.join(", ")} — almost certainly a capability ` +
             `your token lacks. The call did NOT fail; the data is incomplete.`);
  }
  return missing;
}
```

A corollary worth internalising: **a student token and a teacher token calling the same
function on the same course receive structurally different documents.** If you test as an
admin and ship to students, you will ship bugs you cannot reproduce.

### 3.0.1 Index

Scannable index first; details below. "V" = verified live on 4.5.13, "D" = from docs or
source, "R" = reported by others (forum/tracker).

| # | Symptom | Root cause | Fix | |
|---|---|---|---|---|
| [3.1](#31-errorcode-is-sometimes-a-sentence-and-sometimes-absent) | `errorcode` is a whole English sentence, or missing entirely | Moodle throws `moodle_exception` with a message as its code; PHP `Error`s leak raw | Treat `errorcode` as optional and untrusted | V |
| [3.2](#32-there-are-three-different-error-envelopes) | Your error parser returns `undefined` | WS, `token.php` and `pluginfile.php` use three different JSON error shapes | Parse all three | V |
| [3.3](#33-core_calendar_get_action_events_by_timesort-caps-limitnum-at-50) | `Limit must be between 1 and 50 (inclusive)` | Hard-coded cap in the function | Clamp to 1..50, page with `aftereventid` | V |
| [3.4](#34-gradereport_user_get_grade_items-defaults-to-all-users) | `nopermissions` reading your *own* grades | Omitting `userid` means "all users in the course" | Always pass an explicit `userid`; `0` does not mean "me" | V |
| [3.5](#35-mod_forum_get_forum_discussions-rejects-sortbysortdirection) | `invalidparameter` on an obviously correct forum call | `sortby`/`sortdirection` belong to the deprecated `_paginated` variant | Use the integer `sortorder`, or omit it | V |
| [3.6](#36-empty-string-is-not-null) | `??` produces blanks; `if (x === null)` never fires | Moodle returns `""` for many empty strings and `"-"` for empty grades | Normalise `""`/`"-"` explicitly | V |
| [3.7](#37-ids-that-are-not-the-id-you-think) | `Call to a member function get_forum_id() on null` | `discussion.id` ≠ discussion id; calendar `instance` = **cmid**; `cm.section` = section **id** | Learn the four id families | V |
| [3.8](#38-the-calendar-emits-many-events-per-activity) | Duplicate deadlines in your UI | One activity emits several action events, several activities share a timestamp | Dedup on `(course, module, instance, timesort)` | V |
| [3.9](#39-html-entities-survive-in-plain-text-fields) | `Correlation &amp; Regression` | Section/course names are stored HTML-escaped and never decoded | Decode entities on every "plain text" field | V |
| [3.10](#310-moodle-45-subsections-appear-twice) | Activities counted twice; empty "subsection" rows | A 4.5 subsection is *both* a module and a delegated section | Join `section.itemid` ↔ `module.instance` | V |
| [3.11](#311-global-search-is-off-on-most-sites) | `globalsearchdisabled` | Global search needs a search engine backend most admins never set up | Client-side search over cached content | V |
| [3.12](#312-lti-activities-are-opaque) | An activity with no description, no files, no state | LTI content lives on the tool provider, not in Moodle | Surface name + cmid + gradebook item; say so | V |
| [3.13](#313-uservisible-false-hides-modules-you-can-still-see) | Modules with a name but no content | Availability restrictions strip payload but keep the stub | Branch on `uservisible`, render `availabilityinfo` | V |
| [3.14](#314-error-messages-arrive-in-a-language-you-did-not-choose) | Finnish error text on an English integration | Messages are rendered in the *user's* (or site's) language | Never match on `message` | V |
| [3.15](#315-dateslabel-is-localised-and-tense-inflected) | Date labels change between calls | `label` is `"Opens:"` before and `"Opened:"` after | Key on `dates[].dataid` | V |
| [3.16](#316-warnings-is-where-your-missing-data-went) | Fewer records than expected, no error | Partial failures are reported in `warnings[]`, not thrown | Always read `warnings[]` | V |
| [3.17](#317-one-bad-id-can-kill-a-whole-batch) | `Attempt to assign property "contextvalidated" on null` | `core_course_get_courses_by_field` crashes if any id is unknown | Validate ids first, or call one at a time | V |
| [3.18](#318-hidden-and-locked-grade-items) | Grades your user cannot actually see | `gradeishidden`, `gradehiddenbydate`, `gradeislocked` | Respect the flags; do not use `graderaw` blindly | V |
| [3.19](#319-gradeformatted-is-locale-formatted-prose) | `"12,00"`, `"-"`, `"Error"` fail `parseFloat` | Formatted fields are for display only | Use `graderaw` for arithmetic | V |
| [3.20](#320-optional-response-fields-are-absent-not-null) | `TypeError: cannot read property of undefined` | `VALUE_OPTIONAL` fields are omitted from the JSON entirely | Optional-chain everything not `VALUE_REQUIRED` | V |
| [3.21](#321-timezone-99-and-the-day-boundary-problem) | Deadlines off by hours; "today" is wrong | `timezone: "99"` means "server default"; timestamps are UTC epochs | Resolve 99 → site default; do day maths in the user's zone | V |
| [3.22](#322-mod__view__-functions-are-writes) | Completion flips; activity marked viewed | `*_view_*` functions log an event and can complete the activity | Never call them for reading | D |
| [3.23](#323-group-mode-silently-filters-data) | A forum looks empty; classmates missing | `SEPARATEGROUPS` filters per caller, without error | Read `groupmode`; explain rather than show nothing | D/V |
| [3.24](#324-the-payload-is-mostly-course-artwork) | 500 KB for 50 calendar events | `course.courseimage` is an inlined base64 data URI, repeated per record | Strip it before it reaches your consumer | V |
| [3.25](#325-guest-access-and-courses-you-are-not-enrolled-in) | Course visible in the browser, absent from the API | `core_enrol_get_users_courses` lists *enrolments* only | Also try `core_course_get_courses_by_field` | V |
| [3.26](#326-a-missing-function-and-a-missing-record-look-identical) | `invalidrecord` — but for what? | Both raise `dml_missing_record_exception` | Disambiguate on the table name in `message` | V |
| [3.27](#327-content-that-is-not-in-the-course-contents) | Descriptions empty for some module types | `core_course_get_contents` does not carry every module's body | Fall back to `mod_*_get_*_by_courses` | V |
| [3.28](#328-third-party-modules-and-local_-functions) | Code works on one university, not another | Sites install different modules | Feature-detect per `modname` | V |
| [3.29](#329-core_user_get_users-drops-email-and-being-an-admin-makes-it-worse) | Users come back with no `email` | Each user's `maildisplay` setting; evaluated per shared course | Cannot be fixed by capabilities. Expect it | R |
| [3.30](#330-a-site-can-silently-rewrite-any-function) | A function behaves nothing like the docs | `override_webservice_execution` lets a plugin replace any function wholesale | Never assume documented behaviour on an unknown site | D/R |
| [3.31](#331-your-old-code-worked-because-of-a-cve) | An integration broke after a routine Moodle update | Two CVE fixes *removed* data that WS used to over-share | Re-test group and grade visibility after upgrades | R |

---

### 3.1 `errorcode` is sometimes a sentence, and sometimes absent

Everyone writes `if (err.errorcode === 'invalidtoken')`. Moodle breaks that in two
directions.

**Direction one — the code is a sentence.** `core_calendar_get_action_events_by_timesort`
validates `limitnum` by throwing `new moodle_exception('Limit must be between 1 and 50 (inclusive)')`,
which puts the human message where the machine code belongs **[verified on 4.5.13]**:

```json
{"exception":"core\\exception\\moodle_exception",
 "errorcode":"Limit must be between 1 and 50 (inclusive)",
 "message":"error/Limit must be between 1 and 50 (inclusive)"}
```

Note `message` is the literal string `error/` + the code — Moodle failed to find a language
string named "Limit must be between 1 and 50 (inclusive)" and fell back to showing the
lookup key. When you see a `message` beginning `error/`, you are looking at a missing
language string, and the text after the slash is the raw `errorcode`.

**Direction two — there is no code at all.** Pass a wrong id to
`mod_forum_get_discussion_posts` and an unhandled PHP `TypeError` escapes
**[verified on 4.5.13]**:

```bash
ws mod_forum_get_discussion_posts -d 'discussionid=2766887'
```
```json
{"exception":"Error","message":"Call to a member function get_forum_id() on null"}
```

No `errorcode`. No `debuginfo`. Same for `core_course_get_courses_by_field` with an unknown
id ([§3.17](#317-one-bad-id-can-kill-a-whole-batch)):

```json
{"exception":"Error","message":"Attempt to assign property \"contextvalidated\" on null"}
```

**Recipe.**

```ts
class MoodleError extends Error {
  constructor(readonly errorcode: string, message: string, readonly fn: string) {
    super(`[${errorcode}] ${message}  (${fn})`);
  }
}

function toError(body: any, fn: string): MoodleError | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  // WS exception envelope
  if (body.exception) {
    return new MoodleError(body.errorcode ?? "exception", body.message ?? "unknown error", fn);
  }
  // token.php / pluginfile.php envelope (§3.2)
  if (body.error && body.errorcode) {
    return new MoodleError(body.errorcode, String(body.error), fn);
  }
  return null;
}
```

`errorcode ?? "exception"` is the load-bearing part: a raw PHP `Error` produces a usable
object instead of `undefined` propagating into your comparison chain.

### 3.2 There are three different error envelopes

Same server, same failure class, three shapes. All **[verified on 4.5.13]**.

**(a) Web-service exception** — `/webservice/rest/server.php`:

```json
{"exception":"core\\exception\\required_capability_exception",
 "errorcode":"nopermissions",
 "message":"Sorry, but you do not currently have permissions to do that (View grades of other users)."}
```

Keys: `exception`, `errorcode`, `message`, and — only when developer debugging is on —
`debuginfo`, `reproductionlink`.

**(b) Login endpoint** — `/login/token.php`:

```json
{"error":"Kirjautuminen epäonnistui, yritä uudelleen","errorcode":"invalidlogin",
 "stacktrace":null,"debuginfo":null,"reproductionlink":null}
```

Keys: `error` (not `message`), `errorcode`, and three always-present nulls. **No
`exception` key.**

**(c) File endpoint** — `/webservice/pluginfile.php`:

```json
{"error":"Virheellinen avain - avainta ei löytynyt","errorcode":"invalidtoken",
 "stacktrace":null,"debuginfo":null,"reproductionlink":null}
```

Same as (b) — but delivered with **HTTP 200** and `Content-Type: application/json` where you
were expecting a PDF. See [§6.3](#63-the-json-instead-of-a-file-trap).

**(d) A fourth, inside batches.** `tool_mobile_call_external_functions` wraps each sub-call's
error as a **JSON string** in `responses[i].exception`, needing a second parse
([§4.3](#43-batching-with-tool_mobile_call_external_functions)).

**One version caveat.** In **Moodle 4.0** permission failures changed exception class from
`webservice_access_exception` to `moodle_exception` **[per source]**, so the `exception` and
`errorcode` values for access errors differ before and after 4.0. Another reason to branch on
a small set of `errorcode` values rather than on `exception` class names.

### 3.3 `core_calendar_get_action_events_by_timesort` caps `limitnum` at 50

**[verified on 4.5.13]** — the boundary was probed directly:

| `limitnum` | Result |
|---|---|
| `0` | `errorcode: "Limit must be between 1 and 50 (inclusive)"` |
| `1` | 1 event |
| `26` | OK |
| `50` | OK — 50 events |
| `51` | `errorcode: "Limit must be between 1 and 50 (inclusive)"` |
| `100` | same error |
| *omitted* | **20 events** (the default) |

So the usable range is exactly `1..50` inclusive, and the default is `20` — which means the
most common bug here is not the error at all, it is *silently getting 20 items* and
concluding the user has no other deadlines.

**Recipe.**

```ts
const limit = Math.min(Math.max(requested ?? 50, 1), 50);   // always explicit
```

To get more than 50, page with `aftereventid`. The response envelope carries **`firstid`**
and **`lastid`** alongside `events[]` precisely for this — use `lastid`, do not dig the last
event's id out of the array yourself.

**[verified on 4.5.13]**:

```bash
ws core_calendar_get_action_events_by_timesort \
   -d 'timesortfrom=1756000000' -d 'timesortto=1800000000' -d 'limitnum=5'
# envelope keys: ['events', 'firstid', 'lastid']
# firstid=1420967  lastid=1420971
# ids: [1420967, 1420968, 1420969, 1420970, 1420971]

ws core_calendar_get_action_events_by_timesort \
   -d 'timesortfrom=1756000000' -d 'timesortto=1800000000' -d 'limitnum=5' \
   -d 'aftereventid=1420971'
# ids: [1420972, 1420973, 1420974, 1420975, 1506645]   -> no overlap, no gap
```

```ts
async function allEvents(client: MoodleClient, from: number, to: number) {
  const out: ActionEvent[] = [];
  let after: number | undefined;
  for (;;) {
    const r = await client.call<{events: ActionEvent[]; lastid?: number}>(
      "core_calendar_get_action_events_by_timesort",
      { timesortfrom: from, timesortto: to, limitnum: 50, aftereventid: after });
    out.push(...r.events);
    if (r.events.length < 50 || r.lastid === undefined || r.lastid === after) break;
    after = r.lastid;
  }
  return out;
}
```

Do **not** try to page by advancing `timesortfrom` — several events share a timestamp
([§3.8](#38-the-calendar-emits-many-events-per-activity)), so you will drop or duplicate rows
at the boundary. That is exactly why this function uses a cursor rather than an offset.

### 3.4 `gradereport_user_get_grade_items` defaults to all users

The parameter `userid` is optional. Its default is `0`, and `0` means **"every user in the
course"**, which requires `moodle/grade:viewall`. A student therefore cannot call this
function without arguments, even to read their own grades.

**[verified on 4.5.13]**:

```bash
ws gradereport_user_get_grade_items -d 'courseid=42767'
```
```json
{"exception":"core\\exception\\required_capability_exception","errorcode":"nopermissions",
 "message":"Sorry, but you do not currently have permissions to do that (View grades of other users)."}
```

And — the part that catches people who "fixed" it — passing `userid=0` explicitly fails
identically:

```bash
ws gradereport_user_get_grade_items -d 'courseid=42767' -d 'userid=0'
# same nopermissions error
```

`0` is not a sentinel for "me". Only the real numeric user id works:

```bash
ws gradereport_user_get_grade_items -d 'courseid=42767' -d "userid=$MUID"
```
```json
{"usergrades":[{"courseid":42767,"userid":135266,"userfullname":"Damir Kairov",
  "maxdepth":3,"gradeitems":[ ... 29 items ... ]}]}
```

**Recipe.** Capture `userid` from `core_webservice_get_site_info` at connect time and store
it beside the token. Every per-user function needs it —
`core_enrol_get_users_courses`, `core_message_get_conversations` (`userid`),
`core_message_get_conversation_messages` (`currentuserid`), and this one. The reference
implementation makes it a field of the persisted `Site` record precisely so it can never be
forgotten.

The same "optional parameter that defaults to a privileged meaning" pattern appears
elsewhere: `core_enrol_get_enrolled_users` with no `groupid` means all groups;
`mod_assign_get_submission_status` with no `userid` means the calling user (safe), but with
someone else's needs `mod/assign:grade`.

### 3.5 `mod_forum_get_forum_discussions` rejects `sortby`/`sortdirection`

There are two functions with confusingly similar names and *different parameter sets*:

- `mod_forum_get_forum_discussions_paginated` — **deprecated**. Takes `sortby` (string:
  `timemodified`, `timestart`, `id`) and `sortdirection` (`ASC`/`DESC`).
- `mod_forum_get_forum_discussions` — **current**. Takes an **integer** `sortorder`.

Passing the old parameters to the new function **[verified on 4.5.13]**:

```bash
ws mod_forum_get_forum_discussions -d 'forumid=291971' \
   -d 'sortby=timemodified' -d 'sortdirection=DESC'
```
```json
{"exception":"core\\exception\\invalid_parameter_exception",
 "errorcode":"invalidparameter","message":"Invalid parameter value detected"}
```

Note how uninformative that is: `invalidparameter` never says *which* parameter. With
developer debugging on, `debuginfo` would name it; on production it will not
([§9.2](#92-debuginfo-and-developer-debugging)).

**Recipe.** Omit `sortorder` — the default (`SORTORDER_LASTPOST_DESC`) is what you want
anyway — and page with `page`/`perpage`:

```bash
ws mod_forum_get_forum_discussions -d 'forumid=291971' -d 'page=0' -d 'perpage=10'
```

This is also a general lesson: when a Moodle function has a `_paginated`, `_by_courses`, or
`_v2` sibling, **the parameter sets are not compatible**, and copy-pasting a snippet from a
2016 forum post is how you end up here.

### 3.6 Empty string is not null

Moodle's external API declares string fields with `PARAM_TEXT`/`PARAM_RAW` and a default of
`''`. `NULL_ALLOWED` is opt-in and frequently not used. The result: "no value" arrives as an
**empty string**, so `x ?? fallback` and `x || fallback` behave differently, and
`if (x === null)` never fires.

Verified instances, all **[verified on 4.5.13]**:

| Field | Empty value | Not |
|---|---|---|
| `gradeitem.itemname` on `itemtype: "category"` rows | `""` | `null` |
| `gradeitem.itemname` on the `itemtype: "course"` row | `""` | `null` |
| `gradeitem.feedback` when there is no feedback | `""` | `null` |
| `conversation.name` for a 1:1 chat | `""` | `null` |
| `course.summary` when unset | `""` | `null` |
| `event.location` when unset | `""` | `null` |
| `user.description` when unset | `""` | `null` |

From the live gradebook of course 42767 (29 items):

```
itemtype='category'  itemmodule=None  itemname=''   gradeformatted='-'
itemtype='course'    itemmodule=None  itemname=''   gradeformatted='-'
itemtype='mod'       itemmodule='quiz' itemname='Quiz 1' gradeformatted='6.57'
```

Six of the 29 rows had `itemname === ""` — four category aggregates plus the course total.
An integration that renders `item.itemname ?? "(unnamed)"` produces **six blank rows** and
loses the course total, which is the one number the user cares about.

Worse, *the same object* mixes conventions. From `core_message_get_conversations`
**[verified on 4.5.13]**:

```
id=259917 type=1 name='' subname=None members=1 unread=None
```

`name` is `""`, `subname` is `null`, `unreadcount` is `null` — in one record.

**Recipe.** Normalise at the boundary, once, and never think about it again:

```ts
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "-" ? null : s;
};
```

Then give the aggregate rows real labels from `itemtype`:

```ts
const label = (it: GradeItem) =>
  it.itemname ||
  (it.itemtype === "course"   ? "COURSE TOTAL"
 : it.itemtype === "category" ? "— category total"
 : it.itemtype);
```

(The `"-"` in that helper is [§3.19](#319-gradeformatted-is-locale-formatted-prose).)

### 3.7 Ids that are not the id you think

Moodle has four id families that all appear as bare integers in the same JSON documents, and
mixing them produces either an empty result or a PHP crash.

| Family | What it is | Where it appears |
|---|---|---|
| **cmid** (course-module id) | Identifies a *placement* of an activity in a course | `module.id`, `cm.id`, URLs `view.php?id=` |
| **instance id** | Identifies the activity record in `mdl_assign`, `mdl_quiz`, … | `module.instance`, `cm.instance`, `forum.id`, `assign.id` |
| **section id** vs **section number** | DB id vs ordinal position | `cm.section` (id!), `cm.sectionnum` (ordinal), `section.id`, `section.section` |
| **post id** vs **discussion id** | First post vs the thread | `discussion.id` (post!), `discussion.discussion` (thread) |

Three verified traps:

**(a) The calendar's `instance` is a cmid.** Despite the name.
`core_calendar_get_action_events_by_timesort` returned `instance: 3614829` for an assignment
event. Resolving that number **[verified on 4.5.13]**:

```bash
ws core_course_get_course_module -d 'cmid=3614829'
```
```json
{"cm":{"id":3614829,"course":51279,"module":1,
  "name":"A1. Introduction to Automation and Control Engineering",
  "modname":"assign","instance":234093,"section":593779,"sectionnum":2,
  "groupmode":0,"groupingid":0,"completion":0,"downloadcontent":1}}
```

`cm.id` is 3614829 — the number the calendar called `instance`. The *actual* module instance
is 234093. Confirmed across three module types on the same site:

| Calendar `instance` | Resolves to | `modname` | Real `cm.instance` |
|---|---|---|---|
| 3614829 | `cm.id` 3614829 | assign | 234093 |
| 3692649 | `cm.id` 3692649 | quiz | 90659 |
| 3952407 | `cm.id` 3952407 | workshop | 4731 |

This is genuinely useful once you know it — the calendar hands you a cmid you can feed
straight to `core_course_get_course_module` or a `view.php?id=` URL — but it will silently
return the wrong activity if you pass it to `mod_assign_get_assignments` expecting an
instance id. Corroborated by the `action.url` in the same records:
`.../mod/assign/view.php?id=3614829` — a cmid-shaped URL.

**(b) `discussion.id` is the first post's id.** From
`mod_forum_get_forum_discussions` **[verified on 4.5.13]**:

```json
{"id":2766887,"discussion":1445630,"name":"If you use Matlab on the course...","parent":0,...}
```

Pass `id` where `discussionid` is wanted and you get an unhandled PHP error
([§3.1](#31-errorcode-is-sometimes-a-sentence-and-sometimes-absent)):

```bash
ws mod_forum_get_discussion_posts -d 'discussionid=2766887'
# {"exception":"Error","message":"Call to a member function get_forum_id() on null"}
```

Pass `discussion` and it works:

```bash
ws mod_forum_get_discussion_posts -d 'discussionid=1445630'
# {"posts":[{"id":2766887,"discussionid":1445630,"parentid":null, ...}]}
```

Note the returned post's `id` is 2766887 — the same number — closing the loop on why the
confusion arises.

**(c) `forumid` is an instance id, not a cmid.** In the same course
**[verified on 4.5.13]**, the News forum is `cmid 4283948`, `instance 291971`, and
`mod_forum_get_forums_by_courses` returns `{"id": 291971, "cmid": 4283948, ...}`.
`mod_forum_get_forum_discussions` wants `forumid=291971`.

**Recipe.** In your own types, never call a field `id`. Name them `cmid`, `instanceId`,
`discussionId`, `sectionId`, `sectionNum`. The cost is a one-time mapping layer; the benefit
is that these bugs become type errors. And keep `core_course_get_course_module` in your back
pocket — it is the universal cmid → `{course, modname, instance, sectionnum}` resolver, and
it is cheap.

### 3.8 The calendar emits many events per activity

Two distinct duplication effects, both **[verified on 4.5.13]** over a 50-event window.

**(a) One activity, several events.** A `workshop` produces both a `closesubmission` and a
`closeassessment` event; a `quiz` produces `open` and `close`; an `assign` produces `due`
and (for graders) `gradingdue`. The *same* `instance` therefore appears at multiple
timestamps:

```
inst=3952407 closesubmission  2026-01-26T08:00:00  'Exercise Submission for 3rd week (palautusten määräaika)'
inst=3952407 closeassessment  2026-02-02T08:00:00  'Exercise Submission for 3rd week (arviointiaika loppuu)'
inst=3952409 closesubmission  2026-02-02T08:00:00  'Exercise Submission for week 4 (palautusten määräaika)'
inst=3952409 closeassessment  2026-02-09T08:00:00  'Exercise Submission for week 4 (arviointiaika loppuu)'
```

**(b) Several activities, one timestamp.** Courses schedule everything for the same
weekly deadline, so a naive "group by time" collapses unrelated work:

```
2025-11-13T08:00:00
   [assign] inst=3692665 due    'Wk4 Subgroup tasks on palautettava viimeistään'
   [quiz]   inst=3692662 close  'Wk4 Get started exercises sulkeutuu'
   [quiz]   inst=3692663 close  'Wk4 Weekly exercises sulkeutuu'
```

The event-type distribution over that window was
`{due: 23, close: 10, closesubmission: 9, closeassessment: 8}` across
`{assign: 23, workshop: 17, quiz: 10}`.

**Recipe.** Deduplicate on the composite key, and *merge* rather than discard, keeping the
actionable variant:

```ts
const merged = new Map<string, Event & { alsoLabelled?: string[] }>();
for (const e of events) {
  const key = `${e.course?.id ?? 0}-${e.modulename ?? e.eventtype}-${e.instance}-${e.timesort}`;
  const prev = merged.get(key);
  if (!prev) { merged.set(key, { ...e }); }
  else if (!prev.action?.actionable && e.action?.actionable) {
    merged.set(key, { ...e, alsoLabelled: [...(prev.alsoLabelled ?? []), prev.activitystr!] });
  } else if (e.activitystr && e.activitystr !== prev.activitystr) {
    prev.alsoLabelled = [...(prev.alsoLabelled ?? []), e.activitystr];
  }
}
```

Including `timesort` in the key is deliberate: it keeps the workshop's two genuinely
different deadlines apart while collapsing true duplicates at one instant.

**A second, separate trap in this function:** it only returns events that still *need
action*. Submit the assignment and the event vanishes. So an empty result means "nothing
outstanding", **not** "no deadlines exist" — a distinction worth spelling out in your UI, or
users will think your tool is broken.

Finally, prefer `activityname` + `activitystr` over `name`:

```
name        = 'Wk4 Get started exercises sulkeutuu'   <- stored, in the author's language
activityname= 'Wk4 Get started exercises'
activitystr = 'Quiz closes'                            <- rendered now, in the reader's language
```

`name` is frozen at event-creation time in whoever created it's language — hence Finnish
strings on an `lang: 'en'` account. `activitystr` is generated per request. See
[§3.14](#314-error-messages-arrive-in-a-language-you-did-not-choose).

### 3.9 HTML entities survive in "plain text" fields

Section names, course names and activity names are stored HTML-escaped and handed back
escaped, even though nothing about the field says HTML.

**[verified on 4.5.13]**, `core_course_get_contents` on course 58849:

```
sec#  2 id=713613 name='Week 1: Correlation &amp; Regression'
```

Across the payloads captured for this document, a raw-JSON scan found:

```
&amp;  ×87     &ndash;  ×29     &nbsp;  ×23
```

`&nbsp;` is especially nasty because it survives as U+00A0 after decoding and then breaks
`split(" ")`, `trim()`, and every regex using `\s` in engines without Unicode mode.

**Recipe.** Decode entities on every "plain" field — names, labels, `rangeformatted`,
`weightformatted` — and normalise NBSP to a space:

```ts
export function decodeEntities(s: string): string {
  return s
    .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}
```

Decode `&amp;` **last**, or `&amp;lt;` turns into `<`. For *HTML* fields
(`summary`, `description`, `message`) do not do this — run them through a real HTML
converter instead ([§5](#5-text-handling)), which handles entities as a side effect.

### 3.10 Moodle 4.5 subsections appear twice

Moodle 4.5 added `mod_subsection`. A subsection is represented **twice** in
`core_course_get_contents`: once as an activity module of `modname: "subsection"` sitting
where the teacher placed it, and once as a top-level section carrying
`component: "mod_subsection"` and `itemid` = the subsection's instance id.

**[verified on 4.5.13]** on course 58630 — 13 sections, four of them delegated:

```
sec#  1 id=738168 name='Kurssi-info' component=None itemid=None mods=8
     -> subsection cmid=4460916 name='Weekly Reflective Learning Diaries' instance=22079
     -> subsection cmid=4452153 name='Practice Exam'                      instance=21747
     -> subsection cmid=4464337 name='Week Exam Results'                  instance=22241
     -> subsection cmid=4445210 name='Guest Lectures'                     instance=21470
...
sec#  9 id=744147 name='Guest Lectures'                  component='mod_subsection' itemid=21470 mods=1
sec# 10 id=745250 name='Practice Exam'                   component='mod_subsection' itemid=21747 mods=2
sec# 11 id=747015 name='Weekly Reflective Learning Diaries' component='mod_subsection' itemid=22079 mods=1
sec# 12 id=747616 name='Week Exam Results'               component='mod_subsection' itemid=22241 mods=1
```

The join is **`section.itemid` ↔ `module.instance`** (not `module.id`, which is the cmid).

Consequences if you ignore it:

- Activity counts are inflated — the subsection stub counts as an activity.
- Rendering sections in order produces four orphan sections at the bottom, detached from the
  place the teacher put them.
- The `subsection` module has **no** `description`, no `contents`, and `noviewlink: true`,
  so a generic "show me this activity" path shows an empty box.

**Recipe.**

```ts
// section.itemid -> section.section, for delegated sections
const delegated = new Map<number, number>();
for (const s of sections) if (s.component && s.itemid) delegated.set(s.itemid, s.section);

// when rendering a module:
const target = delegated.get(m.instance);
if (m.modname === "subsection" && target !== undefined) {
  render(`${m.name} — contents in §${target}`);
}
```

and either splice the delegated section's modules inline at that point, or render them in
place with a back-reference. Either is fine; silently doing neither is not.

On Moodle < 4.5, `component` and `itemid` are simply absent from section objects, so the map
stays empty and the code is a no-op. That is the right way to handle this class of version
difference ([§7](#7-version-differences-that-bite)).

### 3.11 Global search is off on most sites

`core_search_get_results` requires the *global search* subsystem, which requires a configured
search engine backend (Solr, Elasticsearch, or the slow built-in `simpledb`). Most
institutions never set one up.

**[verified on 4.5.13]**:

```bash
ws core_search_get_results -d 'query=regression' -d 'page=0'
```
```json
{"exception":"core\\exception\\moodle_exception","errorcode":"globalsearchdisabled",
 "message":"Global searching is not enabled."}
```

You can know this **before calling**, from `core_webservice_get_site_info`:

```
advancedfeatures: {..., 'enableglobalsearch': 0, ...}
```

Two further constraints:

- **The search functions do not exist before Moodle 4.3.** `core_search_get_results`,
  `core_search_get_search_areas_list`, `core_search_get_top_results` and
  `core_search_view_results` were all added in 4.3 (MDL-56020) **[per source]**. On 3.9–4.2
  there is no web-service search API at all, and you get `invalidrecord` /
  `external_functions` ([§3.26](#326-a-missing-function-and-a-missing-record-look-identical)).
- **`enableglobalsearch: 1` is necessary but not sufficient** — a search *engine* (Solr,
  Elasticsearch, or the slow built-in `simpledb`) must also be configured and indexed.

Note the sibling function is `core_search_get_search_areas_list`, **not**
`core_search_get_search_areas` — the shorter name does not exist and returns
`invalidrecord` **[verified on 4.5.13]**, which is easy to misread as "search is
unavailable" when it actually means "you typed the wrong function name".

**Recipe.** Client-side search over content you already cache. It is not a downgrade in
practice — you have `core_course_get_contents` cached anyway, and it lets you search fields
Moodle's index does not cover (file names, activity names, section summaries):

```ts
const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (text: string) => {
  const t = text.toLowerCase();
  return needles.every(n => t.includes(n));
};
for (const s of sections) {
  if (matches(`${s.name} ${html2md(s.summary, 8000)}`)) hit(`§${s.section} ${decodeEntities(s.name)}`);
  for (const m of s.modules) {
    const body = html2md(m.description, 20_000);
    const files = (m.contents ?? []).map(c => c.filename).join(" ");
    if (matches(`${m.name} ${body} ${files}`)) hit(`${m.modname} "${m.name}" (cmid ${m.id})`);
  }
}
```

Scope it to enrolled courses, cache the contents, and it is fast enough to feel instant.

### 3.12 LTI activities are opaque

An `mod_lti` activity is a launch point into an external tool (MATLAB Grader, Turnitin,
Kaltura, a publisher's homework system). Moodle stores the launch configuration and a
gradebook item; the *content* lives on the provider and is only reachable through a signed
LTI launch that you cannot replay from an integration.

**[verified on 4.5.13]** — the full key set of an LTI module in `core_course_get_contents`:

```
afterlink, branded, completion, completiondata, contextid, customdata, dates,
downloadcontent, groupmode, id, indent, instance, modicon, modname, modplural,
name, noviewlink, onclick, purpose, url, uservisible, visible, visibleoncoursepage
```

Note what is *missing*: no `description` on most of them, no `contents`, no
`contentsinfo`. Course 58666 had 20+ modules named `MATLAB Grader: Exercise N, Task M` and
nothing readable behind any of them.

**Recipe.** Do not pretend. Surface:

- `name` and `cmid`
- the `url` (so the user can open it in a browser, where the LTI launch works)
- `dates[]` if present — deadlines *are* usually mirrored into Moodle
- the matching gradebook row from `gradereport_user_get_grade_items` (join on `cmid`) —
  this is the one substantive piece of state Moodle holds
- an explicit note that the content is external

`mod_lti_get_ltis_by_courses` exists and adds `intro`, `timecreated`, and launch config, but
not content. Worth calling if you want the intro text; do not expect more.

### 3.13 `uservisible: false` hides modules you can still see

A module restricted by an availability condition (date, grade, group, completion of
something else) is still listed, still has a name, and has had its payload stripped. Three
fields govern this and they mean different things:

| Field | Meaning |
|---|---|
| `visible` | The teacher hid the activity (`0` = hidden) |
| `visibleoncoursepage` | Present but not shown on the course page ("stealth" activity) |
| `uservisible` | **This user** can currently access it — the one that matters |

**[verified on 4.5.13]**, course 58666:

```
lti cmid=4176603 name='MATLAB Grader: Exercise 3, Task 1'
    visible=1  uservisible=False
    availabilityinfo='Available from <strong>7 September 2026, 8:15 AM</strong>'
```

`visible: 1` — the teacher did not hide it. `uservisible: false` — a date restriction is in
force. Testing `visible` alone would have shown it as fully available.

Note `availabilityinfo` is **HTML**, not text — `<strong>` tags in a field whose name
suggests a sentence.

**The capability caveat — this is [§3.0](#30-the-one-principle-that-unifies-most-of-this-section)
in action.** Juan Leyva (Moodle HQ, mobile lead) **[reported —
[moodle.org d=313178](https://moodle.org/mod/forum/discuss.php?d=313178)]**:

> "Regarding availability information, 'Modules availability' should be enabled at site and
> the course level and **the user you are using for requesting the information via web
> services should have permissions (teacher or admin) to see the module settings**."

So on many sites a **student** token gets `uservisible: false` with **no `availabilityinfo`
at all**, while a teacher token on the identical course gets the explanation. The test site
did return it to a student **[verified on 4.5.13]** — but do not rely on that. Always write
`m.availabilityinfo ?? "not currently available"`, and never treat the field's absence as
evidence the module is unrestricted: **`uservisible` is the signal; `availabilityinfo` is a
courtesy.**

Leyva adds in the same thread that `core_course_get_contents` is deliberately generic and
carries **no module-specific data** (no SCORM package URL, no quiz settings) — the reason
[§3.27](#327-content-that-is-not-in-the-course-contents) exists.

**A related structural report:** nested sections are **flattened** by this function — the
parent section comes back empty and its children appear as siblings **[reported —
[d=434893](https://moodle.org/mod/forum/discuss.php?d=434893), no replies]**. That is
consistent with what [§3.10](#310-moodle-45-subsections-appear-twice) observed live on 4.5.13,
and it means the `itemid`↔`instance` join there is not optional cosmetics — it is the only
way to rebuild the real tree.

Hidden *sections* behave differently again: their modules are removed entirely
**[verified on 4.5.13]**, course 42767:

```
sec#  7 id=495632 name='Kurssin päätös ja palaute' visible=0 uservisible=False mods=0
sec#  8 id=536240 name="Teachers' area"           visible=0 uservisible=False mods=0
```

Both report `mods=0` — you get the section's existence and name, and nothing inside. So the
absence of modules in a section is not evidence the section is empty.

**Recipe.**

```ts
if (!m.uservisible) {
  bits.push(`restricted: ${html2line(m.availabilityinfo ?? "not available yet")}`);
  // do not try to fetch contents/description — they are not there
} else if (m.visible === 0) {
  bits.push("hidden by teacher");
}
```

Surfacing "restricted — available from 7 September" is *more* useful to a student than
hiding the row, so keep it and label it.

### 3.14 Error messages arrive in a language you did not choose

Moodle renders exception messages through its language-string system, using the *user's*
language when there is a session, and the *site default* when there is not. On the test site
(`lang: 'fi'` site default, `lang: 'en'` user) this produced both, from the same server,
minutes apart **[verified on 4.5.13]**:

```
# no token -> no user -> site language (Finnish)
{"errorcode":"invalidtoken","message":"Virheellinen avain - avainta ei löytynyt"}

# bad credentials, no session -> Finnish
{"error":"Kirjautuminen epäonnistui, yritä uudelleen","errorcode":"invalidlogin"}

# valid token -> user's language (English)
{"errorcode":"nopermissions","message":"Sorry, but you do not currently have permissions to do that (View grades of other users)."}
```

The `pluginfile.php` error was Finnish too — `"Vaadittu parametri (token) puuttui"` for a
missing parameter.

Three consequences:

1. **Never branch on `message`.** Ever. Use `errorcode`.
2. **Never show `message` to a user without context.** They may not read that language.
   Map known `errorcode`s to your own strings and use `message` only as a fallback detail.
3. **`moodlewssettinglang` does not reliably fix this.** It is accepted as a request
   parameter, but on the test site it changed nothing observable for these errors
   **[verified on 4.5.13]** — the exception text is produced before the setting applies in
   several paths. And it does not reach `/login/token.php` at all, which needs `&lang=`
   ([§1.3](#13-typeoflogin1-direct-token-exchange)).

4. **Exception messages are localised; *warning* messages are not.** Every
   `external_warnings()` structure documents `warnings[].message` as *"untranslated
   **english** message to explain the warning"*, while
   [Errors handling in web services](https://docs.moodle.org/dev/Errors_handling_in_web_services)
   documents exception `message` as translated and `debuginfo` as untranslated
   **[per docs]**. Two different rules inside one response body. The English-only
   `warnings[].message` is genuinely useful — it is the one human-readable string you can
   pattern-match without worrying about the site's language.

**This is by design, and Moodle knows it is unhelpful.** From "Exceptions translation mess"
**[reported — [d=218027](https://moodle.org/mod/forum/discuss.php?d=218027), Dec 2012]** —
Dan Poltawski (Moodle HQ):

> "Non-searchable error messages presented to users. If an error message is in a different
> language to english, its often impossible to search for on google or docs.moodle.org."

and Jérôme Mouneyrac, author of the Moodle web-service layer:

> "At the moment the web service exception format is: errorcode / translated message /
> debuginfo. I agree with you Dan. **Web service exceptions don't need to be translated. They
> just need an errorcode and debug info, not even a message at all.**"

The thread produced no change, which is why real-world reports are still full of
`"Excepción al control de acceso"` and `"Exception du contrôle d'accès"` that nobody can
search for. Expect this to remain true.

The same effect hits *content*, not just errors: calendar `event.name` values were Finnish
(`'Wk4 Get started exercises sulkeutuu'`) on an English account, because the string was
frozen when the teacher created the event
([§3.8](#38-the-calendar-emits-many-events-per-activity)).

### 3.15 `dates[]`.`label` is localised and tense-inflected

Course modules carry a `dates[]` array. It looks like a stable key-value list. It is not:
`label` is a rendered, localised, **tense-inflected** human string that changes as time
passes, while `dataid` is the stable machine key.

**[verified on 4.5.13]**, sampled across five courses:

| `modname` | `dataid` | `label` seen |
|---|---|---|
| quiz | `timeopen` | `'Opens:'` *and* `'Opened:'` |
| quiz | `timeclose` | `'Closes:'` *and* `'Closed:'` |
| choice | `timeopen` | `'Opens:'` *and* `'Opened:'` |
| choice | `timeclose` | `'Closes:'` *and* `'Closed:'` |
| assign | `allowsubmissionsfromdate` | `'Opens:'` *and* `'Opened:'` |
| assign | `duedate` | `'Due:'` |
| workshop | `submissionend` | `'Submissions close:'` |
| workshop | `assessmentend` | `'Assessments close:'` |

The same `dataid` yields a different `label` depending on whether the timestamp is in the
past. Every label also carries a **trailing colon**.

**Recipe.** Key on `dataid`; use `label` only for display, stripped:

```ts
const DUE_KEYS = new Set(["duedate", "timeclose", "submissionend", "cutoffdate"]);
const due = m.dates?.find(d => DUE_KEYS.has(d.dataid))?.timestamp;

// for display only:
const shown = `${decodeEntities(d.label).replace(/:$/, "")} ${fmtDate(d.timestamp)}`;
```

`dates[]` also carries `relativeto` (null in every sample here) used by relative-date
activities.

### 3.16 `warnings[]` is where your missing data went

Many Moodle functions accept a list of ids and are *partially* successful: they return what
they could and report the rest in a `warnings[]` array, with **no exception at all**. If you
do not read `warnings[]`, data disappears silently.

**[verified on 4.5.13]** — asking `mod_assign_get_assignments` for one course I am enrolled
in and one I am not:

```bash
ws mod_assign_get_assignments -d 'courseids[0]=58849' -d 'courseids[1]=2'
```
```json
{"courses":[{"id":58849, ...}],
 "warnings":[
   {"item":"course","itemid":2,"warningcode":"2",
    "message":"User is not enrolled or does not have requested capability"},
   {"item":"module","itemid":4284047,"warningcode":"1",
    "message":"No access rights in module context"}
 ]}
```

The first warning is expected. **The second is the dangerous one:** module 4284047 lives in
course 58849 — a course I *am* enrolled in — and was dropped from the results. Without
reading `warnings[]`, an assignment simply would not exist as far as my integration was
concerned, with a 200 OK and no signal.

**Recipe.** Treat `warnings[]` as a first-class part of every response:

```ts
function unwrap<T>(res: T & { warnings?: Warning[] }, fn: string): T {
  for (const w of res.warnings ?? []) {
    log.warn(`${fn}: ${w.item} ${w.itemid} omitted — ${w.message} (code ${w.warningcode})`);
  }
  return res;
}
```

and surface a count to the user when it is non-zero: *"3 items were not readable with your
permissions"* is honest; silence is not.

Functions that use this pattern heavily: `mod_assign_get_assignments`,
`mod_forum_get_forums_by_courses`, all `mod_*_get_*_by_courses`,
`core_course_get_courses_by_field`, `core_enrol_get_enrolled_users`,
`core_user_get_users_by_field`.

### 3.17 One bad id can kill a whole batch

`core_course_get_courses_by_field` with `field=ids` is the natural way to resolve a list of
course ids. On 4.5.13 it **crashes with an unhandled PHP error** if *any* id in the list does
not exist.

**[verified on 4.5.13]**, five valid ids:

```bash
ws core_course_get_courses_by_field -d 'field=ids' -d 'value=58630,58666,58849,42767,51279'
# {"courses":[ ...5 courses... ],"warnings":[]}
```

The same call with one valid and one bogus id:

```bash
ws core_course_get_courses_by_field -d 'field=ids' -d 'value=58630,999999999'
```
```json
{"exception":"Error","message":"Attempt to assign property \"contextvalidated\" on null"}
```

No `errorcode`, no `warnings[]` — the whole call is lost, including the course that *was*
valid. (Contrast with `mod_assign_get_assignments` in
[§3.16](#316-warnings-is-where-your-missing-data-went), which degrades gracefully. The
inconsistency is the point.)

**Recipe.** Either resolve ids from a source you trust (`core_enrol_get_users_courses`), or
call one id at a time and tolerate failures, or fall back on error:

```ts
try {
  return await client.call("core_course_get_courses_by_field", { field: "ids", value: ids.join(",") });
} catch {
  const out = [];
  for (const id of ids) {
    try { out.push(...(await client.call<any>("core_course_get_courses_by_field",
                                              { field: "id", value: id })).courses); }
    catch { /* skip this one */ }
  }
  return { courses: out, warnings: [] };
}
```

Note the field name changes: `ids` (plural, comma-separated) vs `id` (singular).

### 3.18 Hidden and locked grade items

`gradereport_user_get_grade_items` returns flags that decide whether a number is meaningful.
The **[verified on 4.5.13]** key set of one grade item:

```
categoryid, cmid, feedback, feedbackformat, gradedategraded, gradedatesubmitted,
gradeformatted, gradehiddenbydate, gradeishidden, gradeislocked, gradeisoverridden,
grademax, grademin, gradeneedsupdate, graderaw, id, idnumber, iteminstance,
itemmodule, itemname, itemnumber, itemtype, locked, outcomeid, percentageformatted,
rangeformatted, scaleid
```

Things to notice:

- The flags are **`gradeishidden`, `gradeislocked`, `gradehiddenbydate`**, not `hidden` /
  `locked`. There *are* also `locked` and `hidden` fields on the item in some paths, which
  is why so much integration code checks the wrong one and finds `undefined`.
- `gradeisoverridden` — a teacher typed a number over the computed one.
- `gradeneedsupdate` — the gradebook is stale; the value may change on next recalculation.
- `weightformatted` was **absent entirely** from every item in this response — it is
  `VALUE_OPTIONAL` and only appears when the report is configured to show weights
  ([§3.20](#320-optional-response-fields-are-absent-not-null)).

Separately, the *course total* is often hidden from students by the `moodle/grade:hidden`
setting or by the report's "hide totals if they contain hidden items" configuration. In that
case the `itemtype: "course"` row is present but `graderaw: null` and `gradeformatted: "-"`,
which is indistinguishable from "not yet graded".

**Recipe.** Do not render a grade whose `gradeishidden` is true. Do not compute an average
across items with `gradeneedsupdate`. And when the course total is `"-"` while individual
items have grades, say *"course total not published"* rather than *"0"*.

### 3.19 `gradeformatted` is locale-formatted prose

`gradeformatted`, `percentageformatted`, `rangeformatted` and `weightformatted` are rendered
for a human in the user's locale. They are **not** numbers.

**[verified on 4.5.13]**, from one gradebook:

```
graderaw=12       gradeformatted='12.00'   percentageformatted='60.00 %'
graderaw=6.56667  gradeformatted='6.57'    percentageformatted='65.67 %'
graderaw=None     gradeformatted='-'       percentageformatted='-'
graderaw=4        gradeformatted='4'       percentageformatted='80 %'
```

Values you must handle: `'-'` for ungraded, a trailing `' %'` with a **space** before it,
rounding to the item's `decimals` setting, and — on a site with a comma decimal separator —
`'12,00'`. Confirming that the comma case is live on this site, a teacher's *feedback* field
read `'Total points: 79,4'`.

Other formatted values seen in the wild **[reported]**: `'Error'` when
`gradeneedsupdate` and recalculation failed, and scale names (`'Excellent'`) instead of
numbers when the item uses a scale (`scaleid` is non-null).

**Recipe.** `graderaw` for arithmetic, `gradeformatted` for display, never the reverse.
Compute your own percentage from `graderaw`, `grademin`, `grademax`:

```ts
const pct = (g: GradeItem) =>
  g.graderaw === null || g.grademax === g.grademin
    ? null
    : (100 * (g.graderaw - g.grademin)) / (g.grademax - g.grademin);
```

### 3.20 Optional response fields are absent, not null

Moodle's external API declares response fields with `VALUE_REQUIRED`, `VALUE_OPTIONAL` or
`VALUE_DEFAULT`. A `VALUE_OPTIONAL` field that has no value is **omitted from the JSON
entirely** — not set to `null` **[per docs, `core_external\external_value`]**.

Verified consequences on 4.5.13:

- `weightformatted` — absent from all 29 grade items on a site that does not display weights.
  Code doing `item.weightformatted.trim()` throws; `item.weightformatted ?? ""` is fine.
- `availabilityinfo` — present only on restricted modules.
- `description` — present on some modules and not others *of the same type*: of the
  MATLAB Grader LTI modules in course 58666, one had `description` and four did not.
- `completiondata` — present only when the module has completion tracking enabled.
- `contents` / `contentsinfo` — present only on modules with files.
- `component` / `itemid` on sections — present only on Moodle ≥ 4.5 delegated sections.
- `exception` inside a batch response — present only when `error` is true.

**Recipe.** Generate or hand-write types where everything not documented `VALUE_REQUIRED` is
optional, and turn on `strictNullChecks` / `noUncheckedIndexedAccess`. In TypeScript this is
the single highest-yield safety measure for Moodle work, because the compiler then forces the
`?.` at every site where Moodle will actually omit a field.

This also means **`Object.keys()` differs between two records of the same type**, so
schema-inference tooling pointed at one sample will produce a type that crashes on the next.

### 3.21 Timezone `99` and the day-boundary problem

All Moodle timestamps in web-service responses are **Unix epoch seconds, UTC**. That part is
easy. The hard part is that "which day is this deadline on" is a per-user question.

**[verified on 4.5.13]**, `core_user_get_users_by_field` for my own account:

```json
{"id":135266,"timezone":"99","lang":"en","calendartype":null,"city":null,"country":null}
```

`timezone: "99"` is Moodle's sentinel for **"use the site default"** — it is not an offset,
not an index, and not a valid IANA name **[per docs]**. You must then read the site's
default, which is *not* exposed by `core_webservice_get_site_info`.

Practical resolution order:

1. If `user.timezone` is a real IANA name (`Europe/Helsinki`), use it.
2. If it is `"99"`, fall back to the site's `country` from `tool_mobile_get_public_config`
   (`"FI"` here) as a hint, or to the *client machine's* timezone, and say which you used.
3. `core_calendar_get_action_events_by_timesort` returns `timeusermidnight` on every event —
   the epoch of the start of that event's day **in the user's timezone as Moodle computes
   it**. This is the most reliable day-boundary signal available, because Moodle did the
   resolution for you. **[verified on 4.5.13]**: `timestart: 1756392300`,
   `timeusermidnight: 1756328400` (a difference of 63 900 s = 17:45 into the day).

Also present per event: `formattedtime`, an HTML string Moodle rendered in the user's zone
and language — useful for display, useless for computation.

**A correction that matters more than the bucketing.** `timeusermidnight` is right for
*bucketing events you already received*. It does **not** save you from the calendar's
*selection* bug **[reported — [MOBILE-3486](https://tracker.moodle.org/browse/MOBILE-3486),
status **Open**]**:

> "Calendar events are displayed in wrong day/month if server timezone is different. **The WS
> to get the events of a certain day/month uses the server timezone to calculate which events
> to return.** This means that the app might display events that aren't in that day/month in
> the device timezone (or don't display events that should be in that day/month)."

So `core_calendar_get_calendar_monthly_view` and `core_calendar_get_calendar_day_view` choose
*which* events to return using **server** time. No amount of client-side re-bucketing recovers
an event the server never sent.

**Recipe:** avoid the month/day view functions for anything date-critical. Use
`core_calendar_get_action_events_by_timesort` with `timesortfrom`/`timesortto` **that you
computed yourself in the target user's timezone**, which puts the boundary decision on your
side of the wire:

```ts
// "October 2026 in Europe/Helsinki", computed client-side
const from = Math.floor(Date.parse("2026-10-01T00:00:00+03:00") / 1000);
const to   = Math.floor(Date.parse("2026-11-01T00:00:00+02:00") / 1000);  // note the DST shift
```

DST specifically: a "Friday 23:59" deadline set before a DST change and read after it is
still the same epoch, but the *local* wall clock shifts by an hour. Do not cache
"days remaining" — recompute from the epoch each time.

Historical trap in the other direction: `PARAM_ALPHANUMEXT` on the user timezone field
rejected `/`, so IANA names could not be written at all until 2.0.4
**[[MDL-27759](https://tracker.moodle.org/browse/MDL-27759)]**. Both the legacy float form
(`'-12.5'`) and the IANA form still circulate in copy-pasted integration code.

`sitecalendartype`/`usercalendartype` (`'gregorian'` here) can be `'hijri'` on some
sites, which changes how Moodle formats dates but not the epochs.

### 3.22 `mod_*_view_*` functions are writes

`mod_page_view_page`, `mod_forum_view_forum`, `mod_resource_view_resource`,
`core_course_view_course`, `mod_assign_view_assign` and their siblings look like getters.
They are not. Each one **[per docs]**:

- triggers a `\*\event\course_module_viewed` event, which lands in the site's logs and in the
  teacher's activity reports;
- updates the user's "last access" for the course;
- **marks the activity complete** when its completion condition is "view the activity" —
  which is the default for a large share of resources and pages.

That last one is the serious one. Calling `mod_page_view_page` while "reading" a course
flips completion from 0 to 1, changes the student's progress bar, can satisfy an availability
restriction that gates a *later* activity, and — where completion feeds a course-completion
criterion that feeds a certificate or a grade — can move a grade.

**Recipe.**

- Build an allow-list of read-only verbs and enforce it in your generic "call any function"
  escape hatch. `_get_`, `_search_`, `_is_`, `_can_`, `_check_` is a good approximation.
  On the test site, 247 of the 450 available functions matched it.
- Explicitly deny `_view_`. It is the trap that *looks* safe. Of the 450 functions on the
  test site, **43** contained `_view_`.
- If you genuinely want to mark something viewed, make it an explicit, separately-authorised
  user action, never a side effect of reading.

```ts
const READ_ONLY = /_(?:get|search|is|can|check)_/;
const NEVER = /_view_|_(?:create|update|delete|add|set|submit|start|process|save|send|mark|toggle|launch)_/;

function assertReadOnly(fn: string) {
  if (NEVER.test(fn) || !READ_ONLY.test(fn)) {
    throw new Error(`${fn} is not a read-only function; refusing to call it automatically.`);
  }
}
```

### 3.23 Group mode silently filters data

A course or activity in **separate groups** mode (`groupmode: 1` = `SEPARATEGROUPS`,
`2` = `VISIBLEGROUPS`, `0` = none) restricts what each user sees, and the web-service layer
applies the same restriction **[per docs]**. The failure mode is not an error — it is a
short list.

**[verified on 4.5.13]** the distribution across 267 modules in five courses was
`{0: 265, 2: 1, 1: 1}` — group mode is rare but not absent, and the one `SEPARATEGROUPS`
module is exactly the one where an integration would quietly under-report.

Where it bites:

- `mod_forum_get_forum_discussions` returns only discussions in your groups. Discussions
  carry `groupid`; `-1` means "all groups" **[verified on 4.5.13]**.
- `core_enrol_get_enrolled_users` returns only your group's members unless you have
  `moodle/site:accessallgroups`.
- `mod_assign_get_submission_status` for a team submission depends on grouping.
- A user in **no** group, in a `SEPARATEGROUPS` activity, sees **nothing** — and gets no
  error explaining why.

**Recipe.** Read `groupmode` from `core_course_get_course_module` or the module record, and
when it is `1`, annotate the result rather than presenting it as complete: *"separate groups
are in force; this shows only your group."* `core_group_get_course_user_groups` tells you
which groups the user is in, if the function is exposed.

### 3.24 The payload is mostly course artwork

Moodle inlines the course image as a **base64 `data:` URI** into `course` objects, and
repeats it on **every record** that embeds a course.

**[verified on 4.5.13]** — a single `core_calendar_get_action_events_by_timesort` call with
`limitnum=50`:

```
total payload                              : 532 779 bytes
spent on repeated course.courseimage URIs  : 393 499 bytes  (73 %)
spent on event description HTML            :  17 327 bytes
```

Nearly three quarters of the response was the same handful of generated SVG placeholders,
base64-encoded, once per event. `core_enrol_get_users_courses` carries `courseimage` too, as
does `core_course_get_courses_by_field`.

**Recipe.** Strip it at the transport layer, before anything else sees the response:

```ts
const DROP = new Set(["courseimage", "modicon", "iconurl", "userpictureurl", "profileimageurl",
                      "profileimageurlsmall", "overviewfiles", "summaryfiles"]);

function trim(v: any): any {
  if (Array.isArray(v)) return v.map(trim);
  if (v && typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (DROP.has(k)) continue;
      if (typeof val === "string" && val.startsWith("data:") && val.length > 512) continue;
      out[k] = trim(val);
    }
    return out;
  }
  return v;
}
```

This matters disproportionately when the consumer is an LLM: 393 KB of base64 is roughly
100 000 wasted tokens, for a grey square.

### 3.25 Guest access and courses you are not enrolled in

`core_enrol_get_users_courses` returns **enrolments**, so a course the user can enter as a
guest, or a publicly-visible course they browse without enrolling, does not appear —
even though it is plainly visible in their browser.

**[verified on 4.5.13]** the call returned 11 courses, with these fields:

```
category, completed, completionhascriteria, completionusertracked, courseimage,
displayname, enablecompletion, enddate, format, fullname, hidden, id, idnumber,
isfavourite, lang, lastaccess, marker, overviewfiles, progress, shortname,
showactivitydates, showcompletionconditions, showgrades, startdate, summary,
summaryformat, timemodified, visible
```

**And it is stranger than that.** Whether a guest-accessible course appears in
`core_enrol_get_users_courses` depends on **the guest enrolment plugin's configuration**
**[reported — [MDL-83149](https://tracker.moodle.org/browse/MDL-83149), status Open]**:

| Guest access setting | Course returned by `core_enrol_get_users_courses`? |
|---|---|
| Disabled | **No** |
| Enabled, **with** a password | **No** |
| Enabled, no password | **Yes** |

An *enrolment*-listing call whose output hinges on a *guest* setting is about as
counter-intuitive as Moodle gets, and it is still open.

Two further guest hazards:

- **Guests can read full course content.** `core_course_get_contents` returns course material
  to guest users **[reported — [d=458124](https://moodle.org/mod/forum/discuss.php?d=458124),
  [MOBILE-4583](https://tracker.moodle.org/browse/MOBILE-4583)]**. Dani Palou (Moodle HQ):
  *"the only workaround I can think of is to **override the WebService
  `core_course_get_contents` in your site**"* — see
  [§3.30](#330-a-site-can-silently-rewrite-any-function).
- **`autologinguests = true`** silently logs a web-service caller in as the **guest account**,
  which holds none of the capabilities. The symptom is `requireloginerror` / `nopermissions`
  with nothing in the request explaining why.

**Recipe.** If a user insists a course is missing, try `core_course_get_courses_by_field`
with `field=id` — it applies course-visibility rules rather than enrolment rules and will
return courses the user can see but is not enrolled in. Guest-accessible content then usually
reads fine through `core_course_get_contents`.

Also note from the same response, for [§3.6](#36-empty-string-is-not-null) and
[§3.20](#320-optional-response-fields-are-absent-not-null):

```
id=58849 enablecompletion=False progress=None  completed=None
id=58666 enablecompletion=True  progress=0     completed=False
id=58630 enablecompletion=True  progress=None  completed=False
```

`progress` is `null` even where completion is *enabled* (58630) — it is null whenever there
are no completion-tracked activities yet. `progress === null` and `progress === 0` are
different states and must render differently ("not tracked" vs "0 %").

### 3.26 A missing function and a missing record look identical

Both raise `dml_missing_record_exception` with `errorcode: "invalidrecord"`. The only
difference is the **table name inside the message**.

**[verified on 4.5.13]**:

```bash
ws totally_made_up_function_xyz
# {"exception":"dml_missing_record_exception","errorcode":"invalidrecord",
#  "message":"Can't find data record in database table external_functions."}

ws core_course_get_contents -d 'courseid=999999999'
# {"exception":"dml_missing_record_exception","errorcode":"invalidrecord",
#  "message":"Can't find data record in database table course."}
```

`external_functions` → the function does not exist on this site (wrong name, or a plugin
that is not installed). Any other table → your *arguments* referred to something that does
not exist.

This is the one place you are forced to look at `message` despite
[§3.14](#314-error-messages-arrive-in-a-language-you-did-not-choose). Fortunately the table
name is not localised — match on the identifier, not the sentence:

```ts
const isMissingFunction = (e: MoodleError) =>
  e.errorcode === "invalidrecord" && /\bexternal_functions\b/.test(e.message);
```

Better still, avoid the situation: check `functions[]` from
`core_webservice_get_site_info` before calling ([§2](#2-capability-discovery)), and you will
never see the `external_functions` variant.

### 3.27 Content that is not in the course contents

`core_course_get_contents` gives you structure plus files, but the *body* of several module
types is not in it. A `mod_page`'s HTML is the clearest case: `core_course_get_contents`
gives the page's `description` (the intro shown on the course page) but not its `content`.

**[verified on 4.5.13]**, `mod_page_get_pages_by_courses` on the same course returned pages
with `content` fields absent from the contents payload:

```json
{"pages":[{"id":279731,"coursemodule":4283949,"course":58849,
  "name":"Working on the course and grading",
  "intro":"<p>Essential info about working on the course and how the grade is formed</p>",
  "introformat":1,"content":"<p> </p>\r\n<p>The grade consists of your performance in weekly exercises and the exam...",
  "contentformat":1,"lang":"","revision":...}]}
```

Note the two pairs: `intro`/`introformat` (the course-page blurb) and
`content`/`contentformat` (the actual page). The generic pattern is
`mod_<name>_get_<plural>_by_courses`, which exists for most core modules:

```ts
async function getModInstances<T>(client, modname: string, plural: string, courseid: number) {
  const res = await client.call<Record<string, T[]>>(
    `mod_${modname}_get_${plural}_by_courses`, { courseids: [courseid] });
  return res[plural] ?? [];
}
// getModInstances(c, "page", "pages", 58849)
// getModInstances(c, "url", "urls", 58849)
// getModInstances(c, "label", "labels", 58849)
// getModInstances(c, "quiz", "quizzes", 58849)   <- note the irregular plural
```

The plural is irregular often enough to need a table: `quiz → quizzes`,
`glossary → glossaries`, `data → databases`, `scorm → scorms`, `imscp → imscps`,
`lti → ltis`, `wiki → wikis`, `assign → assignments` (and `mod_assign_get_assignments`
does *not* take the `_by_courses` suffix at all).

**[verified on 4.5.13]** several of these returned an empty envelope rather than an error
when the course has no such module: `mod_quiz_get_quizzes_by_courses` on course 58849
returned 28 bytes — `{"quizzes":[],"warnings":[]}`. Cheap to call speculatively.

### 3.28 Third-party modules and `local_*` functions

Two sites running the identical Moodle version expose different function sets, because
plugins add their own.

**[verified on 4.5.13]** the test site exposed `mod_choicegroup_*`, `mod_customcert_*`,
`mod_subcourse_*`, three `aiplacement_*` functions and four `local_*` functions — none of
which exist on a stock Moodle. Conversely, a stock site has modules this one lacks.

**Recipe.** When you meet a `modname` you do not recognise in `core_course_get_contents`:

1. Check whether `mod_<modname>_get_<plural>_by_courses` is in `functions[]`.
2. If it is, call it — third-party modules that expose web services usually follow the core
   naming convention.
3. If it is not, fall back to what `core_course_get_contents` gave you: `name`, `cmid`,
   `url`, `dates[]`, `completiondata`, `contents[]`, and the gradebook row joined on `cmid`.
   That is a genuinely useful amount, and it works for *every* module type including ones
   invented after you shipped.

This "degrade to the generic record" strategy is what makes an integration survive contact
with an unknown university.

### 3.29 `core_user_get_users` drops `email`, and being an admin makes it worse

The cleanest illustration of [§3.0](#30-the-one-principle-that-unifies-most-of-this-section)
in the whole corpus **[reported —
[d=396087](https://moodle.org/mod/forum/discuss.php?d=396087), Moodle 3.7.1]**: users came
back **without an `email` field**. HTTP 200, no exception, no warning.

Three natural hypotheses were burned before the real cause surfaced:

1. *"Add `moodle/user:viewhiddendetails`"* — the reporter already had it.
2. *"Use `core_user_get_users_by_field` instead"* — *"has exactly the same problems"*; both
   route through the same `user_get_user_details()`.
3. *"Run as an admin"* — **this makes it worse.** Andreas Grabs:

   > "If you have your capabilities system wide like an admin… then **you won't get the email
   > address at all**. If you have less rights like a trainer you might get the email address
   > depending on your capabilities in the course the user you ask for is enrolled in."

   The code path is `user_get_user_details_courses()`, which evaluates per **shared course**.
   A site admin shares no course with anyone, so the per-course check finds nothing to grant.

**The actual cause** is not a capability at all — it is each target user's own **`maildisplay`
preference**. Set to `2` ("allow only course members to see my email address"), the address is
**never** returned by web services, whatever your role
**[[MDL-67781](https://tracker.moodle.org/browse/MDL-67781)]**.

**Recipe.** Treat `email` as optional on every user record. There is no capability that fixes
this and no error that announces it. If you need addresses for an institutional integration,
that is a conversation with the administrator about `maildisplay` defaults, not a code change.

Related capability trap in the same family: `core_group_get_group_members` requires
`moodle/course:managegroups`, which **non-editing teachers lack** — even though they can see
the same groups in the participants UI **[reported —
[d=412883](https://moodle.org/mod/forum/discuss.php?d=412883)]**.

### 3.30 A site can silently rewrite any function

`external_api::call_external_function()` invokes the **`override_webservice_execution`**
plugin callback before dispatching **[per source]**. Any installed plugin may therefore
replace the implementation of **any** web-service function, wholesale, and return whatever it
likes — under the standard function name, with the standard response schema, and with nothing
on the wire indicating that it happened.

This is not theoretical. Moodle HQ recommends it as the *supported* fix for the guest-access
leak in [§3.25](#325-guest-access-and-courses-you-are-not-enrolled-in) — Dani Palou:
*"the only workaround I can think of is to **override the WebService
`core_course_get_contents` in your site** to avoid returning the course contents if the user
is a guest."*

**What this means for you.** On a site you do not control:

- Documented behaviour is a **strong default, not a guarantee**.
- A function can return less than the docs promise (a local policy override), more, or
  differently shaped data — and `functions[]` still lists it normally.
- The `local_*` entries in a site's function list
  ([§3.28](#328-third-party-modules-and-local_-functions)) are a hint that such plugins exist;
  the test site had four **[verified on 4.5.13]**.

**Recipe.** This is one more argument for validating response *shape*
([§3.0](#30-the-one-principle-that-unifies-most-of-this-section)) rather than trusting a
schema you read on moodledev.io. When a site behaves inexplicably and consistently, an
override is a real candidate — ask the administrator rather than assuming a Moodle bug.

### 3.31 Your old code worked because of a CVE

Two security fixes *removed* data that web services had been over-sharing. Integrations built
before them broke on what looked like a routine point upgrade.

**Group filtering (2015).** `core_enrol_get_enrolled_users` **ignored separate-groups mode
entirely** until 2.9.3 / 2.8.9 / 2.7.11
**[[MSA-15-0043 / MDL-51861 / CVE-2015-5339](https://moodle.org/mod/forum/discuss.php?d=323234)]**:
*"it is possible to retrieve list of course participants who would not be visible when using
web site."* Code written against the leaky behaviour started returning filtered — or empty —
lists after the fix. See [§3.23](#323-group-mode-silently-filters-data).

**Hidden grades (2014).** `core_grades_get_grades` **exposed hidden grades to students** until
2.8 / 2.7.3
**[[MSA-14-0038 / MDL-47766 / CVE-2014-7831](https://moodle.org/mod/forum/discuss.php?d=275153)]**.
The official mitigation was blunt: *"Do not enable `core_grades_get_grades` in web
services."* That function was later removed outright in 4.0
([§7.2](#72-functions-removed-between-39-and-45)). See
[§3.18](#318-hidden-and-locked-grade-items).

**The lesson generalises.** When an integration breaks after an upgrade and the new behaviour
returns *less* data, the first hypothesis should be "a visibility rule that should always have
applied now applies", not "Moodle regressed". Re-test group visibility and grade visibility
after every upgrade, **as a student**, not as an admin.

More still-open reports in this family, worth knowing before you rely on the calls:

| Issue | Status |
|---|---|
| [MDL-87242](https://tracker.moodle.org/browse/MDL-87242) — WS participant list shorter than the web page's without `moodle/user:viewdetails` | Fixed only in **5.2** |
| [MDL-85160](https://tracker.moodle.org/browse/MDL-85160) — wrong `gradingstatus` for group submissions | Open |
| [MDL-73574](https://tracker.moodle.org/browse/MDL-73574) — `mod_assign_get_grades` misses group grades | Open |
| [d=401621](https://moodle.org/mod/forum/discuss.php?d=401621) — `mod_assign_get_submissions` returns `"files":[]` for group submissions | No replies |
| [MDL-64304](https://tracker.moodle.org/browse/MDL-64304) — grade **category** rows return `itemname: ""` ([§3.6](#36-empty-string-is-not-null)) | Fixed only in **5.3** |
| [d=453324](https://moodle.org/mod/forum/discuss.php?d=453324) — grade items simply missing, *"not hidden nor locked"* | Unanswered, 4 months |
| [MDL-57255](https://tracker.moodle.org/browse/MDL-57255) — an empty grade takes down the **entire call** with `invalid_response_exception` | Fixed |

Note the [MDL-64304](https://tracker.moodle.org/browse/MDL-64304) row: the empty
`itemname` on category rows that [§3.6](#36-empty-string-is-not-null) verified live is a known
defect, unfixed until 5.3 — so the `itemtype`-based labelling workaround there is required on
every version you will realistically meet.

---
## 4. Rate limits, sizes and performance

### 4.1 What Moodle actually enforces

The short version: **Moodle core has no web-service rate limiting.** There is no per-token
quota, no 429, no `Retry-After`. What exists is:

| Control | Where | Default |
|---|---|---|
| Login lockout | `lockoutthreshold` / `lockoutduration` | Often 5–10 failed logins, 30 min. Applies to `/login/token.php` **[per docs]** |
| Token expiry | Per-token `validuntil`, set by the admin | Usually unset for mobile tokens |
| Token IP restriction | Per-token `iprestriction` | Usually unset |
| `limitconcurrentlogins` | Site setting | `0` (unlimited) on the test site **[verified on 4.5.13]** |
| PHP `max_input_vars` | Server config | Commonly 1000 — matters for flattened arrays, see [§4.5](#45-request-size-and-the-max_input_vars-cliff) |
| PHP `post_max_size` | Server config | Commonly 8–64 MB |
| PHP `max_execution_time` | Server config | Commonly 30–300 s |
| Web server / WAF | Institutional | **Unknowable. Assume something is watching.** |

The absence of a documented limit is not permission to hammer. A university Moodle serves
tens of thousands of students during a lecture break; your background sync competes with
them. See [§8.6](#86-do-not-hammer-a-universitys-server).

### 4.2 Measured costs

**[verified on 4.5.13]**, wall-clock from a residential connection to a Finnish university:

| Call | Payload | Time |
|---|---|---|
| `core_course_get_contents` (course 58630, 13 sections) | 39 653 B | 0.49 s |
| `core_course_get_contents` (course 58666, 8 sections) | 79 479 B | 0.44 s |
| `core_course_get_contents` (course 58849, 9 sections, 98 modules) | 119 845 B | 0.62 s |
| `core_course_get_contents` (course 42767) | 49 608 B | 0.67 s |
| `core_course_get_contents` (course 51279) | 67 790 B | 0.67 s |
| `core_webservice_get_site_info` | 31 081 B | ~0.3 s |
| `core_calendar_get_action_events_by_timesort` `limitnum=50` | 532 779 B | ~1 s |
| `core_course_get_course_module` (one cmid) | ~300 B | ~0.28 s |

Two lessons. First, **latency dominates**: a 300-byte call costs 0.28 s and a 120 KB call
costs 0.62 s, so the per-request overhead is most of the bill. Second,
`core_course_get_contents` is the expensive one in *bytes* — and it is called per course, so
a user with 11 enrolments costs ~700 KB and ~6 s to enumerate fully.

### 4.3 Batching with `tool_mobile_call_external_functions`

This is the single highest-leverage optimisation available, and it is dramatically effective.

**[verified on 4.5.13]**, the same 10 calls:

| Approach | Time |
|---|---|
| 10 sequential `core_course_get_course_module` requests | **2.78 s** |
| 1 batched request containing the same 10 calls | **0.39 s** |

A **7× speedup**, and it scales:

| Batch size | Response | Time |
|---|---|---|
| 10 | 3 175 B | 0.39 s |
| 40 | 12 655 B | 0.79 s |
| 100 | 31 615 B | **1.52 s** |

100 calls in 1.52 s versus roughly 28 s sequentially. **No cap was enforced at 100**
**[verified on 4.5.13]**; core does not declare a maximum. Be a good citizen anyway and keep
batches in the 20–50 range for expensive functions.

**The wire format.** Each request is a `function` name plus `arguments` as a **JSON string**:

```bash
curl -s -X POST "$MURL/webservice/rest/server.php" \
  -d "wstoken=$MTOK" -d 'moodlewsrestformat=json' \
  -d 'wsfunction=tool_mobile_call_external_functions' \
  -d 'requests[0][function]=core_webservice_get_site_info' \
  -d 'requests[0][arguments]={}' \
  -d 'requests[1][function]=core_course_get_contents' \
  -d 'requests[1][arguments]={"courseid":58849}' \
  -d 'requests[2][function]=core_course_get_contents' \
  -d 'requests[2][arguments]={"courseid":2}'
```

**The response is double-encoded.** `responses[i].data` and `responses[i].exception` are
JSON **strings**, requiring a second `JSON.parse` **[verified on 4.5.13]**:

```
 [0] error=False exception=None datalen=31081
 [1] error=False exception=None datalen=119845
 [2] error=True  exception='{"message":"You cannot execute functions in the course context (course id:2)...","errorcode":"errorcoursecontextnotvalid","link":"https:\/\/moodle.tuni.fi\/","moreinfourl":"https:\/\/docs.moodle.org\/405\/en\/error\/webservice\/errorcoursecontextnotvalid"}' datalen=0
```

**`moreinfourl`.** The batched exception carries a documentation link
(`https://docs.moodle.org/405/en/error/webservice/errorcoursecontextnotvalid`) that the plain
REST error does not. Useful when debugging an unfamiliar code — and note the `405` path
segment encodes the Moodle version.

#### The fail-fast trap

The example above is misleading, and the misreading is easy to make: request 2 failed while
requests 0 and 1 returned data, which looks like per-call failure isolation. **It is not.**
The failing call simply happened to be *last*.

The server loop is **[per source, `admin/tool/mobile/classes/external.php`]**:

```php
foreach ($requests as $request) {
    ...
    $responses[] = $response;
    if ($response['error']) {
        break;          // <-- everything after this point is never executed
    }
}
```

Re-run with the failing call **first** **[verified on 4.5.13]**:

```
requests sent: 3   responses returned: 1
 [0] error=True  datalen=0     exc={"message":"You cannot execute functions in the course context (course 2)...
 => FAIL-FAST
```

Three requests in, **one** response out. Requests 1 and 2 were never executed and are not
reported at all.

Consequences you must handle:

- **`responses.length` can be shorter than `requests.length`.** Never zip them by assuming
  equal length; match **positionally** and treat any index beyond `responses.length` as
  "not executed", not as "succeeded" and not as "failed".
- **One inaccessible course poisons the whole batch.** Since permission errors are the most
  common failure ([§3.16](#316-warnings-is-where-your-missing-data-went)), a batch spanning
  several courses is fragile by construction.
- **Order your batch so the calls most likely to fail come last**, or better, pre-filter to
  ids you know are accessible.
- **Re-enqueue the unexecuted tail** rather than retrying the whole batch.

Corrected recipe:

```ts
async function callBatch(client: MoodleClient, calls: {fn: string; params: Params}[]) {
  const flat: Record<string,string> = {};
  calls.forEach((c, i) => {
    flat[`requests[${i}][function]`] = c.fn;
    flat[`requests[${i}][arguments]`] = JSON.stringify(c.params);
  });
  const res = await client.call<{responses: {error: boolean; data?: string; exception?: string}[]}>(
    "tool_mobile_call_external_functions", flat);

  return calls.map((c, i) => {
    const r = res.responses[i];
    if (!r) return { state: "not_executed" as const, fn: c.fn };   // fail-fast truncated the batch
    if (r.error) {
      const e = JSON.parse(r.exception ?? "{}");
      return { state: "error" as const, fn: c.fn,
               error: new MoodleError(e.errorcode ?? "exception", e.message ?? "", c.fn) };
    }
    return { state: "ok" as const, fn: c.fn, data: JSON.parse(r.data ?? "null") };
  });
}

// drive it to completion, re-enqueueing whatever fail-fast skipped
async function callBatchAll(client: MoodleClient, calls: {fn: string; params: Params}[]) {
  const out: any[] = [];
  let pending = calls;
  while (pending.length) {
    const res = await callBatch(client, pending);
    const cut = res.findIndex(r => r.state === "not_executed");
    if (cut === -1) { out.push(...res); break; }
    out.push(...res.slice(0, cut));
    pending = pending.slice(cut + 1);      // skip the one that failed; it is already recorded
    if (cut === 0 && pending.length === calls.length) break;  // no progress; bail
  }
  return out;
}
```

Two further per-source notes on this function:

- **It is declared `'type' => 'write'`**, even though the calls inside it may all be reads.
  If you enforce a read-only policy, apply it to each sub-call rather than to the wrapper
  ([Appendix A](#appendix-a-the-read-only-function-allow-list)).
- **Per-request `settingraw` / `settingfilter` / `settingfileurl` / `settinglang`** are
  accepted per sub-request, and the **defaults differ from plain REST**: `settingfileurl`
  defaults to `true` here. Sending a `settinglang` the site does not have installed fails
  the whole call, which is why the official app hoists language to a top-level
  `moodlewssettinglang` instead ([§5.1](#51-the-moodlewssetting-request-parameters)).

Feature-detect it: `tool_mobile_call_external_functions` was added in **Moodle 3.7**
**[per source]** and is present on essentially every site with the mobile service on, but
check `functions[]` and fall back to sequential calls.

### 4.4 Making `core_course_get_contents` cheaper

The function accepts an `options[]` array. **[verified on 4.5.13]** on course 58849:

| Options | Payload | vs baseline |
|---|---|---|
| *(none)* | 119 845 B | — |
| `excludemodules=1` | **7 869 B** | **15× smaller** |
| `excludecontents=1` | 92 712 B | 23 % smaller |
| `includestealthmodules=1` | 119 845 B | unchanged here |

```bash
curl -s -X POST "$MURL/webservice/rest/server.php" \
  -d "wstoken=$MTOK" -d 'moodlewsrestformat=json' \
  -d 'wsfunction=core_course_get_contents' -d 'courseid=58849' \
  -d 'options[0][name]=excludemodules' -d 'options[0][value]=1'
```

`excludemodules` is excellent for "what sections does this course have" — a
navigation/skeleton view — at 1/15th the cost. `excludecontents` drops the per-file
`contents[]` arrays while keeping modules, which is right when you want structure but not
downloads.

Other options **[per docs]**: `sectionid`, `sectionnumber`, `cmid`, `modname`, `modid` — all
server-side filters that are much cheaper than fetching everything and filtering locally.
Fetching one module:

```bash
-d 'options[0][name]=cmid' -d 'options[0][value]=4283949'
```

### 4.5 Request size and the `max_input_vars` cliff

Moodle's REST server takes nested structures as **flattened form keys**:

```
{ courseids: [5, 9] }            ->  courseids[0]=5&courseids[1]=9
{ options: { onlyfetch: true } } ->  options[onlyfetch]=1
{ requests: [{function: "x"}] }  ->  requests[0][function]=x
```

Every leaf is a separate POST variable, and PHP's `max_input_vars` counts them.

**The failure mode is worse than truncation — it is silent corruption.** Moodle used to ship
a `workaround_max_input_vars()` helper; it was abandoned because it made things worse
**[[MDL-47665](https://tracker.moodle.org/browse/MDL-47665), closed *Won't Do*]**:

> "workaround_max_input_vars() not working well with array query params… the `$_REQUEST` now
> contains **invalid values and some vars are duplicated**."

PHP itself emits only an `E_WARNING`, which a production Moodle does not surface. So over the
limit you get **wrong data**, not missing data, and no exception.

Moodle replaced the workaround with a hard environment requirement
**[[MDL-71390](https://tracker.moodle.org/browse/MDL-71390), fixed 3.5.18 / 3.8.9 / 3.9.7 /
3.10.4]**. Current rule **[per docs,
[Environment — max_input_vars](https://docs.moodle.org/502/en/Environment_-_max_input_vars)]**:

| Site | Effective budget |
|---|---|
| PHP 8, meeting Moodle's requirement | **`max_input_vars >= 5000`** — mandatory |
| PHP 7 or a non-compliant site | **1000** (the PHP default), with corruption beyond it |

So a compliant modern site gives you roughly 5000 leaves and a neglected one gives you 1000.
Since you cannot detect which from the client, **budget for 1000.**

Operational footnote from the same docs, worth passing to an administrator: *"If you had to
change a PHP parameter, your web service needs to be restarted so the new setting is then
recognized."*

Rough budgets at `max_input_vars=1000`:

- `tool_mobile_call_external_functions`: 2 vars per sub-call → ~500 calls max. Well above
  the 100 verified working.
- `core_course_get_courses_by_field` with `field=ids`: **1 var** (comma-separated `value`),
  so no limit from this direction — but see
  [§3.17](#317-one-bad-id-can-kill-a-whole-batch) for why it fails anyway.
- `courseids[0..N]` style: 1 var each → ~1000 courses.

**[verified on 4.5.13]** a 3 014-byte POST body carrying 500 comma-separated course ids was
accepted by the server (it failed on the unknown-id bug, not on size). Body size is rarely
the constraint; variable *count* is.

**Recipe.** Prefer comma-separated `value` forms where a function offers them; chunk
`courseids[]` at 100; chunk batches at 50.

### 4.6 Change detection with `core_course_get_updates_since`

Rather than re-fetching a course, ask what changed.

**[verified on 4.5.13]**, course 58849, `since` = 30 days ago:

```bash
ws core_course_get_updates_since -d 'courseid=58849' -d "since=$((`date +%s` - 2592000))"
```
```json
{"instances":[
  {"contextlevel":"module","id":4283948,"updates":[{"name":"discussions"}]},
  {"contextlevel":"module","id":4283949,"updates":[{"name":"configuration","timeupdated":1788167153}]},
  {"contextlevel":"module","id":4283966,"updates":[{"name":"configuration","timeupdated":1787251401},
                                                   {"name":"contentfiles"}]},
  ... 33 instances ...
], "warnings":[]}
```

`id` is a **cmid**. `updates[].name` values include `configuration`, `contentfiles`,
`introfiles`, `discussions`, `gradeitems`, `outcomes`, `comments`, `ratings`, `completion`.
Note `timeupdated` is `VALUE_OPTIONAL` and absent on some update kinds
([§3.20](#320-optional-response-fields-are-absent-not-null)).

**Recipe.** Store `lastSync` per course. On each poll, call `get_updates_since`; if
`instances` is empty, serve the cache and do nothing else. If it is not empty, either
re-fetch the whole course (simple, and usually right — the full fetch is under a second) or
fetch just the affected cmids with `core_course_get_contents` + `options[cmid]`.

Caveat: 33 of ~98 modules reported updates over 30 days on an active course, so this is a
good "has anything changed at all" gate and a mediocre delta.

### 4.7 Caching: what and for how long

Everything here is a judgement call, not a Moodle rule. These TTLs have worked well:

| Data | Function | TTL | Why |
|---|---|---|---|
| Site info / capability matrix | `core_webservice_get_site_info` | **session** or 24 h | Changes only when an admin acts |
| Enrolled courses | `core_enrol_get_users_courses` | **15 min** | Enrolments change rarely; `lastaccess` and `progress` drift |
| Course contents | `core_course_get_contents` | **15 min**, or invalidate on `get_updates_since` | The expensive one; teachers edit during term |
| Assignments | `mod_assign_get_assignments` | 15 min | |
| Grades | `gradereport_user_get_grade_items` | **2–5 min** | Users refresh this exact page hoping for a change |
| Submission status | `mod_assign_get_submission_status` | **do not cache** | The user just submitted; a stale answer is actively harmful |
| Calendar / deadlines | `core_calendar_get_action_events_by_timesort` | **1–5 min** | Cheap enough, and staleness is visible |
| Forum discussions | `mod_forum_get_forum_discussions` | 5 min | |
| Files (`pluginfile.php`) | — | **forever, keyed by URL** | Moodle's URLs contain a revision/itemid; content at a URL is immutable |

Always provide an explicit `refresh: true` escape hatch. Users who suspect stale data will
otherwise restart your application, which is worse for the server than one extra fetch.

A minimal disk cache, from the reference implementation:

```ts
export async function cached<T>(client, name: string, producer: () => Promise<T>,
                                opts: { refresh?: boolean; ttlMs?: number } = {}): Promise<T> {
  const path = join(CACHE_DIR, client.site.key, `${name}.json`);
  const ttl = opts.ttlMs ?? 15 * 60 * 1000;
  if (!opts.refresh) {
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as { at: number; data: T };
      if (Date.now() - raw.at < ttl) return raw.data;
    } catch { /* miss */ }
  }
  const data = await producer();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ at: Date.now(), data })).catch(() => {});
  return data;
}
```

Keying the cache directory by **site host** matters as soon as a user connects to two
Moodles — course id 58849 exists on both, and mixing them is a data-leak-shaped bug.

### 4.8 Pagination is inconsistent across functions

There is no single pagination convention. Four coexist:

| Convention | Functions |
|---|---|
| `page` + `perpage` (0-based page) | `mod_forum_get_forum_discussions`, `core_search_get_results`, `mod_glossary_get_entries_by_*` |
| `limitfrom` + `limitnum` (offset) | `core_message_get_conversations`, `core_message_get_conversation_messages`, `core_notes_get_course_notes` |
| `limitnum` + a cursor (`aftereventid`) | `core_calendar_get_action_events_by_timesort` |
| `offset` + `limit` | `core_course_get_enrolled_courses_by_timeline_classification` |
| **none at all** | `core_course_get_contents`, `core_enrol_get_users_courses`, `gradereport_user_get_grade_items`, `mod_assign_get_assignments` |

The last row is the important one: the biggest responses are the ones you *cannot* page. A
course with 500 activities returns all 500 or nothing. Use the `options[]` filters
([§4.4](#44-making-core_course_get_contents-cheaper)) instead.

Cross-cutting hazards:

- **Caps differ and are undocumented.** `limitnum` is capped at 50 for the calendar
  ([§3.3](#33-core_calendar_get_action_events_by_timesort-caps-limitnum-at-50)) and
  uncapped elsewhere. Probe rather than assume.
- **Defaults are small and silent.** The calendar defaults to 20
  **[verified on 4.5.13]**. `perpage` defaults vary by function.
- **`perpage=0` sometimes means "all" and sometimes means "none".** Never send `0`.
- **Total counts are usually absent.** `mod_forum_get_forum_discussions` returns no total,
  so "is there another page" means "did I get exactly `perpage` items". That is
  ambiguous on the last page; fetch one extra and discard it if you need certainty.
- **Ordering is not guaranteed stable** across pages while content is being written. For
  forums this is mostly theoretical; for the calendar, where many events share a timestamp
  ([§3.8](#38-the-calendar-emits-many-events-per-activity)), offset-based paging genuinely
  drops rows — which is why that function uses a cursor.

---

## 5. Text handling

Almost every human-readable field Moodle returns is HTML, written by teachers in a WYSIWYG
editor, and it is *bad* HTML: nested colour spans, `<font>` tags, MS Word paste artifacts,
inline styles, empty paragraphs.

Real example **[verified on 4.5.13]**, a calendar event description:

```html
<p>Files of L01, E01 and LAB shared. Voluntary <strong>PC Exercise 01</strong> aka
<strong>PCE01</strong> on Thu<span style="color:#0055ff;"> 28.08.</span> from
<span style="color:#0055ff;">16:15 to 17:15 </span>o'clock. Files
<span style="color:#ff0000;">Derivate and Integral.pdf</span>, ...</p>
<p><span style="color:#2bff00;">Calculus Exercise of Thu does not need any returns.</span></p>
```

Three sentences, five colour spans, zero semantic value in the markup.

### 5.1 The `moodlewssetting*` request parameters

Moodle exposes three request-level switches that change how text fields are processed
**[per docs, `core_external\external_settings`]**. They are sent as ordinary POST parameters
alongside `wstoken`:

| Parameter | Default | Effect |
|---|---|---|
| `moodlewssettingfilter` | `false` | Run Moodle's text **filters** (multilang, MathJax, media embedding, glossary auto-linking) before returning |
| `moodlewssettingfileurl` | `true` | Rewrite `@@PLUGINFILE@@` placeholders into absolute `webservice/pluginfile.php` URLs |
| `moodlewssettingraw` | `false` | Return the raw stored text, no `format_text()` at all |
| `moodlewssettinglang` | *(user's)* | Language to render strings in |
| `moodlewssettingtimezone` | *(user's)* | Timezone to format dates in (**Moodle 3.10+**) **[per source]** |

**[verified on 4.5.13]** — an important negative result. On the test site these settings
produced **byte-identical responses** for `core_course_get_contents` (119 845 B in all four
configurations) and for `mod_page_get_pages_by_courses` (8 294 B in all six configurations
including `moodlewssettinglang=fi`).

Why: these settings only take effect on fields the module passes through
`external_format_text()`. Fields built directly — notably `contents[].fileurl`, which was
already an absolute `.../webservice/pluginfile.php/...` URL in every variant — are unaffected.
And a site with no multilang content and no `@@PLUGINFILE@@` in its descriptions has nothing
for the filters to do.

**The practical reading:** do not rely on these switches to normalise anything. Set them if
you have a specific need, but write your client so it copes whether or not the server
honoured them:

- Handle `@@PLUGINFILE@@` **and** absolute `pluginfile.php` URLs.
- Handle `<span class="multilang" lang="xx">` **and** already-filtered text.

### 5.2 `@@PLUGINFILE@@` rewriting

Moodle stores embedded-file references as the literal placeholder `@@PLUGINFILE@@`:

```html
<img src="@@PLUGINFILE@@/diagram.png" alt="Bode plot">
```

With `moodlewssettingfileurl` at its default (`true`), the external API rewrites this to an
absolute URL that includes the context, component, filearea and itemid:

```
https://moodle.example.edu/webservice/pluginfile.php/6162684/mod_page/content/3/diagram.png
```

If you ever see a raw `@@PLUGINFILE@@` in your data — because a site or a specific field did
not rewrite it — you must reconstruct the URL yourself from the module's `contextid` (present
on modules in `core_course_get_contents` **[verified on 4.5.13]**), the component
(`mod_<modname>`), the filearea (`intro`, `content`, `attachment`, depending on the module),
and the itemid. This is fiddly; prefer the rewritten form and treat the placeholder as an
error case you log.

Either way, the resulting URL still needs a token appended before it will serve bytes —
see [§6](#6-files-download-and-upload).

### 5.3 Multilang spans

Sites serving several languages store *all* translations in one field, wrapped in spans that
the multilang filter strips at render time:

```html
<span class="multilang" lang="en">Introduction to Control</span>
<span class="multilang" lang="fi">Säätötekniikan perusteet</span>
```

With `moodlewssettingfilter=0` (the default!) you get **both**, concatenated, which reads
like gibberish and doubles your token count.

**[verified on 4.5.13]** — no multilang content was present on the test site's courses
(`multilang` occurrences: 0 across all captured payloads), so this could not be reproduced
live. The handling below is **[per docs]** plus defensive coding.

**Recipe.** Strip client-side rather than hoping the filter ran:

```ts
function pickLang(html: string, want = "en"): string {
  if (!/class="multilang"/.test(html)) return html;
  // Collapse each run of sibling multilang spans down to the preferred language.
  return html.replace(
    /(?:<span\s+class="multilang"\s+lang="([a-z_-]+)"\s*>([\s\S]*?)<\/span>\s*)+/gi,
    (run) => {
      const alts = [...run.matchAll(/<span\s+class="multilang"\s+lang="([a-z_-]+)"\s*>([\s\S]*?)<\/span>/gi)];
      const hit = alts.find(a => a[1].toLowerCase().startsWith(want)) ?? alts[0];
      return hit?.[2] ?? "";
    });
}
```

Moodle also supports the older `{mlang xx}...{mlang}` syntax from the `filter_multilang2`
plugin, which is extremely common at European universities:

```ts
const pickMlang2 = (s: string, want = "en") => {
  const blocks = [...s.matchAll(/\{mlang\s+([a-z_,-]+)\}([\s\S]*?)\{mlang\}/gi)];
  if (blocks.length === 0) return s;
  const hit = blocks.find(b => b[1].split(",").some(l => l.trim().startsWith(want))) ?? blocks[0];
  return hit[2];
};
```

### 5.4 HTML → text for an LLM

If the consumer is a language model, the goal is: **keep structure, drop paint**. Headings,
lists, links, tables and code carry meaning. Colours, fonts, alignment and inline styles do
not, and they cost tokens.

The approach that works (and what the reference implementation settled on) is Turndown with
two customisations:

```ts
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",         // "## Heading", not underlines
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});
turndown.remove(["script", "style"]);
// Teacher HTML is drowning in colour spans; keep the words, drop the paint.
turndown.addRule("unwrapSpans", {
  filter: ["span", "font"],
  replacement: (content) => content,
});

export function html2md(html: string | null | undefined, maxChars = 4000): string {
  if (!html) return "";
  let md: string;
  try { md = turndown.turndown(html); }
  catch { md = html.replace(/<[^>]+>/g, " "); }   // never let bad HTML crash a read
  md = md
    .replace(/ /g, " ")        // NBSP -> space (§3.9)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (md.length > maxChars) md = `${md.slice(0, maxChars)}\n…[truncated, ${md.length} chars total]`;
  return md;
}
```

Points worth copying:

- **`unwrapSpans` is the single biggest win.** It removes the colour/style noise while
  keeping every word, and it is three lines.
- **The `catch` fallback matters.** Teacher HTML includes genuinely malformed markup;
  a parser exception must degrade to a tag-strip, not fail the whole course read.
- **Truncate with a visible marker** including the true length, so the consumer knows
  something was cut and can ask for the rest.
- **A one-line variant** for table cells and list rows:

```ts
export function html2line(html: string | null | undefined, maxChars = 300): string {
  const md = html2md(html, maxChars * 4).replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ");
  return md.length > maxChars ? `${md.slice(0, maxChars)}…` : md;
}
```

**Emit tables, not JSON.** When handing structured Moodle data to an LLM, a pipe table costs
a fraction of the equivalent JSON and reads better:

```ts
export function table(headers: string[], rows: (string|number|null|undefined)[][]): string {
  const cell = (v: any) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${headers.join(" | ")} |`,
          `|${headers.map(() => "---").join("|")}|`,
          ...rows.map(r => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}
```

Escaping `|` and flattening newlines inside cells is not optional — Moodle content contains
both.

### 5.5 The `*format` fields

Every HTML field has a companion integer telling you what it actually is
**[per docs]**:

| Value | Constant | Meaning |
|---|---|---|
| `0` | `FORMAT_MOODLE` | Legacy: plain text with auto-linebreaks and some HTML |
| `1` | `FORMAT_HTML` | HTML. The overwhelmingly common case |
| `2` | `FORMAT_PLAIN` | Plain text — **do not** run an HTML parser over it |
| `4` | `FORMAT_MARKDOWN` | Markdown |

`descriptionformat`, `introformat`, `contentformat`, `summaryformat`, `messageformat`,
`feedbackformat` all appear. **[verified on 4.5.13]** every sampled field was `1`.

Handling format `2` matters: running Turndown over plain text containing `<` or `&` mangles
it. Branch:

```ts
const toText = (v: string, format: number) =>
  format === 2 ? v
: format === 4 ? v            // already markdown
: html2md(v);
```

---

## 6. Files: download and upload

### 6.1 The URL you are given

`core_course_get_contents` returns per-module `contents[]` entries whose `fileurl` is already
absolute and already points at the **web-service** file endpoint
**[verified on 4.5.13]**:

```
https://moodle.tuni.fi/webservice/pluginfile.php/6162684/mod_resource/content/2/R_nano_guide.pdf?forcedownload=1
```

The path segments are `/<contextid>/<component>/<filearea>/<itemid>/<filename>`. Note it
already carries `?forcedownload=1` — which sets up the most common mistake.

There are two endpoints and they are not interchangeable:

| Endpoint | Auth |
|---|---|
| `/pluginfile.php/...` | Session cookie |
| `/webservice/pluginfile.php/...` | `token` query parameter |

If a `fileurl` comes back pointing at `/pluginfile.php` (some functions do this), swap the
path to `/webservice/pluginfile.php` before adding your token.

### 6.2 Signing the URL

Append `token=<wstoken>` **as a query parameter**, respecting any query string already
present.

**[verified on 4.5.13]**, the wrong way — naive string concatenation:

```bash
curl -s "${FURL}?token=$MTOK"
# {"error":"Vaadittu parametri (token) puuttui","errorcode":"missingparam",...}
```

The URL became `...R_nano_guide.pdf?forcedownload=1?token=...`, a second `?` that PHP folds
into the value of `forcedownload`. The error says "required parameter (token) missing" — in
Finnish — which sends people hunting for an auth problem that does not exist.

The right way:

```bash
curl -s -D - "${FURL}&token=$MTOK" -o out.pdf
```
```
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: inline; filename="R_nano_guide.pdf"
Content-Length: 129655
```
```
downloaded: 129655 bytes; magic: %PDF-
```

Do not do this by hand. Use a URL parser, which handles both cases:

```ts
fileUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  u.searchParams.set("token", this.site.token);
  return u.toString();
}
```

**[verified on 4.5.13]** the same file also downloads correctly with `forcedownload`
stripped entirely (`${BASE}?token=$MTOK` → 129 655 B, `application/pdf`), so you may
normalise it away if you prefer.

### 6.3 The JSON-instead-of-a-file trap

This is the one that produces corrupt files on disk. When the token is missing, wrong, or
lacks download rights, `pluginfile.php` answers **HTTP 200** with a **JSON error body**.

**[verified on 4.5.13]**, no token at all:

```
HTTP 200  Content-Type: application/json; charset=utf-8  size: 132
{"error":"Vaadittu parametri (token) puuttui","errorcode":"missingparam",...}
```

Bad token, correct syntax:

```
HTTP 200  Content-Type: application/json; charset=utf-8
{"error":"Virheellinen avain - avainta ei löytynyt","errorcode":"invalidtoken",...}
```

**Status-code checking does not save you.** A downloader that writes `res.body` to
`lecture.pdf` produces a 132-byte "PDF" containing Finnish JSON, and the failure surfaces
hours later when someone opens it.

**Recipe.** Check `Content-Type` before writing a single byte:

```ts
async download(rawUrl: string): Promise<{ body: ArrayBuffer; mimetype: string; filename?: string }> {
  const res = await fetch(this.fileUrl(rawUrl), { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${rawUrl}`);
  const mimetype = res.headers.get("content-type") ?? "application/octet-stream";
  // Moodle answers with JSON (not a file) when the token is rejected.
  if (mimetype.includes("application/json")) {
    const err = await res.json() as { errorcode?: string; error?: string };
    throw new MoodleError(err.errorcode ?? "download_error", err.error ?? "download rejected", "pluginfile");
  }
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return { body: await res.arrayBuffer(), mimetype,
           filename: m?.[1] ? decodeURIComponent(m[1]) : undefined };
}
```

The one false positive to be aware of: a course file that genuinely *is* a `.json` document
will also have `Content-Type: application/json`. If that matters, additionally require the
body to parse as an object containing an `errorcode` key.

Related site-level gate: if `core_webservice_get_site_info` reports `downloadfiles: 0`,
**every** such fetch fails regardless of URL correctness. Check it once at connect time and
disable the feature rather than failing per file ([§2.1](#21-the-one-call-that-tells-you-everything)).

### 6.4 Filenames

Three sources, in decreasing reliability:

1. `contents[].filename` from the API — the authoritative name, correct Unicode.
2. `Content-Disposition` — **[verified on 4.5.13]** `inline; filename="R_nano_guide.pdf"`.
   May use RFC 5987 `filename*=UTF-8''...` for non-ASCII names, which needs
   `decodeURIComponent`.
3. The last path segment of the URL — percent-encoded, and a last resort.

All three are attacker-influenced in the sense that a teacher chose them, so sanitise before
touching the filesystem:

```ts
const safeName = (name: string) =>
  basename(name).replace(/[/\\]/g, "_").replace(/^\.+/, "_") || "download";
```

`basename` plus stripping leading dots defeats `../../etc/passwd` and `.bashrc`-style names.
Also note `contents[].filepath` is a *virtual* path inside the file area (`"/"` usually) and
must not be joined onto a local path without the same treatment.

### 6.5 The draft-itemid upload dance

Writing files into Moodle is a two-step protocol **[per docs]** — included for completeness;
the read-only constraint of this document means it was **not** exercised live.

**Step 1 — upload to a draft area.** POST multipart to `/webservice/upload.php`:

```bash
curl -s -X POST "https://moodle.example.edu/webservice/upload.php" \
  -F "token=$MTOK" \
  -F "filearea=draft" \
  -F "itemid=0" \
  -F "filepath=/" \
  -F "file_1=@report.pdf"
```

Response — note it is a **bare array**, and that errors here use yet another shape:

```json
[{"component":"user","contextid":123,"userid":"456","filearea":"draft",
  "filename":"report.pdf","filepath":"/","itemid":987654321,"license":"allrightsreserved",
  "author":"Jane Doe","source":""}]
```

`itemid: 987654321` is the **draft item id**. Passing `itemid=0` asks Moodle to allocate a
new draft area; pass the returned id on subsequent uploads to add more files to the *same*
draft.

**Step 2 — attach the draft to something.** Hand the draft itemid to whichever function
consumes files:

```bash
# mod_assign: submit the draft as the file submission
-d 'assignmentid=234093' \
-d 'plugindata[files_filemanager]=987654321'

# mod_forum: attach to a post
-d 'options[0][name]=attachmentsid' -d 'options[0][value]=987654321'
```

Constraints that bite:

- The draft area expires (Moodle garbage-collects unused drafts, typically after a few
  days). Do step 2 promptly.
- `usermaxuploadfilesize` and `userquota` from `core_webservice_get_site_info` cap you —
  **[verified on 4.5.13]** `usermaxuploadfilesize: 1073741824` (1 GB) and
  `userquota: 524288000` (500 MB) on the test site. The *activity* also has its own limit,
  usually much smaller.
- `uploadfiles: 1` must be set on the service, and `usercanmanageownfiles` must be true.
- The upload endpoint takes `token=` as a **form field**, not `wstoken=`.
- Errors come back as `{"error": "...", "errorcode": "..."}` — envelope (b) from
  [§3.2](#32-there-are-three-different-error-envelopes) — inside a 200 response.

---
## 7. Version differences that bite

Moodle 3.9 (LTS, 2020) through 5.0 (2025) spans five years of external-API churn. Sites in
the wild run all of it — 3.9 and 4.1 and 4.5 are all LTS releases with long institutional
tails.

The data in this section comes from diffing `lib/db/services.php` and `course/externallib.php`
across the release branches on `github.com/moodle/moodle` **[per source]**, plus live
observation on 4.5.13.

> **The rule that governs this whole section: Moodle backports new web-service functions and
> new response fields into point releases.** Branch tips and `.0` tags disagree. For example
> `core_courseformat_new_module` landed in 5.0.0 but is also present at the 4.5.13 tip; the
> module `candisplay` field arrived in the 5.0.4 and 5.1.1 *point* releases. A site running
> "4.5" may therefore have functions the 4.5.0 release notes do not mention.
>
> **Never gate behaviour on a release number. Feature-detect against `functions[]`**
> ([§2](#2-capability-discovery)). Everything below is orientation for *why* something is
> missing, not a substitute for detection.

### 7.1 The core function count over time

Core web-service functions declared in `lib/db/services.php` **[per source]**:

| Branch | Core functions |
|---|---|
| `MOODLE_39_STABLE` | 317 |
| `MOODLE_400_STABLE` | 339 |
| `MOODLE_401_STABLE` | 347 |
| `MOODLE_403_STABLE` | 376 |
| `MOODLE_404_STABLE` | 382 |
| `MOODLE_405_STABLE` | 394 |
| `MOODLE_500_STABLE` | 399 |

(A live site adds its `mod_*` and plugin functions on top; the test 4.5.13 site exposed 450
in total, of which 176 were `core_*`.)

### 7.2 Functions removed between 3.9 and 4.5

These exist on a 3.9 site and are **gone** by 4.5 **[per source, diff of
`lib/db/services.php`]**:

```
core_enrol_edit_user_enrolment
core_grades_get_grades
core_message_block_contacts
core_message_create_contacts
core_message_data_for_messagearea_contacts
core_message_data_for_messagearea_conversations
core_message_data_for_messagearea_get_most_recent_message
core_message_data_for_messagearea_get_profile
core_message_data_for_messagearea_messages
core_message_data_for_messagearea_search_users
core_message_data_for_messagearea_search_users_in_course
core_message_delete_conversation
core_message_get_contacts
core_message_mark_all_messages_as_read
core_message_unblock_contacts
core_question_submit_tags_form
```

The `core_message_*` cluster is the fallout of the **conversations API rewrite** (3.6+). Any
tutorial or snippet using `core_message_get_contacts` or the `data_for_messagearea_*`
family is dead on modern Moodle. The replacements are
`core_message_get_conversations`, `core_message_get_conversation_messages`,
`core_message_get_user_contacts`, `core_message_block_user` / `unblock_user`,
`core_message_delete_conversations_by_id`.

`core_grades_get_grades` is the other one that catches people: it was the "read grades"
function in old documentation, and it was **removed in 4.0** (MDL-72433) **[per source]**.
Use `gradereport_user_get_grade_items` (per course, with an explicit `userid` —
[§3.4](#34-gradereport_user_get_grade_items-defaults-to-all-users)) and
`gradereport_overview_get_course_grades` (course totals) instead.

**[verified on 4.5.13]** — confirming the removals on a live site, these are all absent from
the 450-function list: `core_grades_get_grades`,
`mod_forum_get_forum_discussions_paginated`.

#### The deprecation timeline for functions integrations actually use

**[per source]**. Note that **nothing over the wire tells a client a function is
deprecated** — deprecation is signalled only by a `*_is_deprecated()` PHP method and a
`** DEPRECATED **` prefix in the server-side `db/services.php` description. There is no
`deprecated` flag in `functions[]`.

| Function | Deprecated | Removed | Replacement |
|---|---|---|---|
| `core_message_*` (13 legacy functions) | 3.6 | **3.10** | conversations API |
| `mod_forum_get_forum_discussion_posts` | ≤3.9 | **4.0** | `mod_forum_get_discussion_posts` |
| `core_grades_get_grades` | ≤3.9 | **4.0** | `gradereport_user_get_grade_items` |
| `core_enrol_edit_user_enrolment` | ≤3.9 | **4.0** | `core_enrol_submit_user_enrolment_form` |
| `core_grades_create_gradecategory` | 3.11 | **4.3** | `core_grades_create_gradecategories` |
| **`mod_forum_get_forum_discussions_paginated`** | **3.11** | **4.4** | `mod_forum_get_forum_discussions` |
| `core_question_submit_tags_form` | 4.0 | **4.4** | `qbank_tagquestion_submit_tags_form` |
| `core_output_load_fontawesome_icon_map` | 3.10 | **5.0** | `..._icon_system_map` |
| `core_grades_get_*_for_search_widget` | 4.2/4.3 | **5.0** | `..._for_selector` |
| `mod_quiz_get_user_attempts` | **5.0** | — | `mod_quiz_get_user_quiz_attempts` |
| `core_course_edit_module` / `edit_section` / `get_module` | **5.0** | planned 6.0 | `core_courseformat_update_course` |
| `core_courseformat_create_module` | **5.0** (one release after being added) | — | `core_courseformat_new_module` |

#### Which versions are still alive

**[per docs, moodledev.io/general/releases]**, as of September 2026:

| Version | Released | Security support ends | Min PHP |
|---|---|---|:-:|
| 3.9 LTS | 2020-06 | 2023-12 — **dead** | 7.2 |
| 3.11 | 2021-05 | 2023-12 — **dead** | 7.2/7.3 |
| 4.0 | 2022-04 | 2023-12 — **dead** | 7.3 |
| 4.1 LTS | 2022-11 | 2025-12 — **dead** | 7.4 |
| 4.3 | 2023-10 | 2025-04 — **dead** | 8.0 |
| 4.4 | 2024-04 | 2025-12 — **dead** | 8.1 |
| **4.5 LTS** | 2024-10 | **2027-10** | 8.1 |
| **5.0** | 2025-04 | **2026-10** | 8.2 |
| **5.1** | 2025-10 | **2027-04** | 8.2 |
| **5.2** | 2026-04 | **2027-10** | 8.3 |

"Dead" means no security patches, which does **not** mean nobody is running it — universities
run unsupported Moodles for years. But it does mean **4.5 LTS is the realistic floor for new
work**, with 4.1 as the "we still have to support it" tier and 3.9/3.11 as legacy.

Two platform changes worth knowing because they affect where you look things up, not what
you call:

- **XML-RPC was removed from core in 4.1.** Only `rest` and `soap` remain. If a tutorial
  tells you to use XML-RPC, it predates 4.1.
- **Moodle 5.1 moved the webroot into `public/`.** `$CFG->wwwroot` is unchanged, so
  `/webservice/rest/server.php`, `/login/token.php` and pluginfile URLs all keep working —
  but **raw source paths change** to `public/lib/db/services.php` etc. If a client starts
  seeing `/public/` inside returned URLs, the site is misconfigured.

### 7.3 `mod_forum_get_forum_discussions_paginated`

**[per source]** — presence in `mod/forum/db/services.php`:

| Branch | Present? |
|---|---|
| 3.9 | yes |
| 4.0 | yes |
| 4.1 | yes |
| 4.5 | **absent** |
| 5.0 | **absent** |

Precisely: **deprecated in 3.11** (MDL-66138), **removed in 4.4** (MDL-70483)
**[per source]**. Also confirmed absent from the live 4.5.13 function list
**[verified on 4.5.13]**.

The replacement, `mod_forum_get_forum_discussions`, has an **incompatible parameter set** —
an integer `sortorder` instead of the string `sortby`/`sortdirection`
([§3.5](#35-mod_forum_get_forum_discussions-rejects-sortbysortdirection)). The `sortorder`
values come from `\mod_forum\local\vaults\discussion_list` and are identical from 3.9 to
5.1 **[per source]**:

| Value | Meaning | | Value | Meaning |
|---|---|---|---|---|
| `-1` | site default | | `7` | discussion name desc |
| `1` | last post desc **(default)** | | `8` | discussion name asc |
| `2` | last post asc | | `9` | starter name desc |
| `3` | created desc | | `10` | starter name asc |
| `4` | created asc | | `11` | group desc |
| `5` | replies desc | | `12` | group asc |
| `6` | replies asc | | | |

Good news: the **response structure of `mod_forum_get_forum_discussions` is unchanged from
3.9 through 5.1** **[per source]**, so you can migrate to it on every version in range and
keep one parsing path.

**Version-spanning recipe:**

```ts
const have = new Set(siteInfo.functions.map(f => f.name));
if (have.has("mod_forum_get_forum_discussions")) {
  return call("mod_forum_get_forum_discussions", { forumid, page, perpage });
}
if (have.has("mod_forum_get_forum_discussions_paginated")) {
  return call("mod_forum_get_forum_discussions_paginated",
              { forumid, page, perpage, sortby: "timemodified", sortdirection: "DESC" });
}
throw new FeatureUnavailable("forum discussions");
```

Prefer the new one when both exist — on 3.9–4.1 both are present.

### 7.4 Response fields, by the version they appeared

Counted by grepping `course/externallib.php` (which defines `core_course_get_contents`)
per branch **[per source]**:

| Field (on `core_course_get_contents`) | First appeared |
|---|---|
| `section.uservisible`, `section.availabilityinfo`, `module.uservisible`, `module.visibleoncoursepage` | 3.3 |
| `module.onclick`, `afterlink`, `customdata`, `completion`, `completiondata` | 3.6 |
| `module.contentsinfo`, `contents[].tags`, `completiondata.valueused` | **3.7** |
| `module.noviewlink` | 3.8 |
| `module.contextid` | **3.10** |
| **`module.dates[]`** (`label`, `timestamp`) | **3.11** |
| `completiondata` re-based on `completion_info_exporter` (+5 fields) | **3.11** |
| `dates[].relativeto`, `dates[].dataid` | **4.1** (backported into 4.0.x) |
| **`module.downloadcontent`** | **4.0** |
| `module.activitybadge` | **4.3** |
| **`module.groupmode`** | **4.3** |
| `module.purpose`, `module.branded` | **4.4** |
| **`section.component`**, **`section.itemid`** | **4.5** (delegated sections / subsections) |
| `module.candisplay` | **5.0.4 / 5.1.1** (point releases) |

`core_course_get_contents`' **parameters** are unchanged 3.9 → 5.1 **[per source]** — the
`options[]` keys in [§4.4](#44-making-core_course_get_contents-cheaper) work on every version
in range.

Two further notes:

- **`lang` is not and never was a field of `core_course_get_contents`.** It appears on
  `mod_*_get_*_by_courses` responses, from **4.1**, via the shared
  `helper_for_get_mods_by_courses` exporter — which from 4.1 standardises
  `id, coursemodule, course, name, intro, introformat, introfiles, section, visible,
  groupmode, groupingid, lang` across every such function.
- **Section `name` became `PARAM_RAW` in 3.10** (was `PARAM_TEXT`), which is when HTML and
  entities started surviving in it — the direct cause of
  [§3.9](#39-html-entities-survive-in-plain-text-fields). On 4.5+, if the request's
  User-Agent looks like the Moodle app, delegated-section names are additionally wrapped in
  `<span class="course-mod_subsection">…</span>`. **Do not spoof the Moodle app
  User-Agent** unless you strip that.

The two that change behaviour most:

**`dates[]` (3.11).** On 3.9 and 3.10 there is no per-module date array at all; you must call
`mod_assign_get_assignments` / `mod_quiz_get_quizzes_by_courses` to learn a due date. From
3.11 the dates are inline in `core_course_get_contents`, which removes a whole round of
calls — but `dataid` (the stable key you should be matching on,
[§3.15](#315-dateslabel-is-localised-and-tense-inflected)) only arrives in **4.1**. On
3.11–4.0 you are stuck matching the localised `label`, which is a genuine reason to prefer
the per-module functions on those versions. Write both paths:

```ts
const due = m.dates?.find(d => DUE_KEYS.has(d.dataid))?.timestamp
         ?? (await dueDateFromModuleFunction(m));   // 3.9 fallback
```

**`section.component` / `itemid` (4.5).** Subsections
([§3.10](#310-moodle-45-subsections-appear-twice)). On < 4.5 the fields are simply absent, so
code written as `if (s.component && s.itemid)` is automatically a no-op on older sites. This
is the ideal shape for a version difference — no branching required.

**Completion — and a widely-repeated wrong version number.** The `completiondata` object is
often described as having been overhauled in 4.3. It was not. The real timeline
**[per source, `completion/classes/external/completion_info_exporter.php`]**:

| Version | `completiondata` |
|---|---|
| 3.6 | `state`, `timecompleted`, `overrideby` |
| **3.7** | `+ valueused` |
| **3.11** | Re-based on `completion_info_exporter`, adding **five** fields at once: `hascompletion`, `isautomatic`, `istrackeduser`, `uservisible`, `details[]` |
| 4.0 – 4.2 | byte-identical to 3.11 |
| **4.3** | **No schema change.** A behavioural hack only (see below) |
| **4.4** | `+ isoverallcomplete` |
| 4.5 – 5.1 | unchanged |

So `details[]` is **3.11**, `valueused` is **3.7**, and `isoverallcomplete` is **4.4**.

**The 4.3-only landmine.** Moodle 4.3 shipped a coercion in `get_other_values()`, commented
in the source as *"Temporary fix for 4.3 only"*: when `state == COMPLETION_COMPLETE_FAIL (3)`
but the activity is nonetheless overall-complete, `state` is silently reported as
`COMPLETION_COMPLETE (1)`. **This was reverted in 4.4.** If you are reading completion on a
4.3.x site, a "complete-fail" is indistinguishable from a plain "complete".

**[verified on 4.5.13]** the live shape:

```json
{"state":0,"timecompleted":0,"overrideby":null,"valueused":false,
 "hascompletion":true,"isautomatic":false,"istrackeduser":true,
 "uservisible":true,"details":[],"isoverallcomplete":false}
```

Read `completiondata.isoverallcomplete` when present (4.4+) and fall back to interpreting
`state` otherwise:

```ts
const done = m.completiondata?.isoverallcomplete ?? ((m.completiondata?.state ?? 0) > 0);
```

Note `state` is **not boolean**: `0` incomplete, `1` complete, `2` complete-pass,
`3` complete-fail **[per docs]**. `state > 0` is right; `state === 1` silently drops
complete-pass and complete-fail.

> `overallstatus` appears in the exporter's computed values from 3.11 to 4.3 but is **never
> declared in its properties**, so the return validator strips it and it does not reach the
> wire. Do not rely on it. **[per source]**

The same exporter backs `core_completion_get_activities_completion_status`, so its
`statuses[]` gained the identical fields on the identical schedule.

### 7.5 Functions added, by era

**3.9 → 4.0** — the course-index / course-format rewrite:

```
core_courseformat_get_state
core_courseformat_update_course
core_course_get_enrolled_courses_with_action_events_by_timeline_classification
```

`core_courseformat_get_state` returns the course-index structure (sections, cmids, ordering,
completion) in a compact form, and it is `ajax => true`, so it is one of the few genuinely
useful functions reachable over the cookie route
([§1.7](#17-session-cookies-and-libajaxservicephp)).

**But it is not in the `moodle_mobile_app` service**, so a token client cannot call it.
**[verified on 4.5.13]** — both `core_courseformat_get_state` and
`core_courseformat_update_course` are **absent** from the live 450-function list, on a site
running 4.5.13 where they certainly exist in the codebase. This is the cleanest live
demonstration of the rule in [§2.2](#22-functionsversion-is-not-what-you-think): *a function
existing in Moodle and a function being callable by your token are different questions*, and
only `functions[]` answers the second.

The same applies to `core_courseformat_get_section_content_items` and
`core_customfield_toggle_shared` (5.1). Reaching any of them from a token client requires an
administrator to build a custom external service that includes them.

Both `core_courseformat_*` state functions also return **`PARAM_RAW` — a JSON string you must
decode a second time** **[per source]**, the same double-encoding as
[§4.3](#43-batching-with-tool_mobile_call_external_functions).

**4.4 → 4.5** — AI, badges, subsections **[per source]**:

```
core_ai_get_policy_status, core_ai_set_action, core_ai_set_policy_status
core_badges_disable_badges, core_badges_enable_badges, core_badges_get_badge
core_courseformat_create_module, core_courseformat_new_module
core_output_poll_stored_progress
core_sms_set_gateway_status
core_user_prepare_private_files_for_edition, core_user_update_private_files
```

Note `mod_subsection` itself declares no web-service functions — subsections surface purely
through `core_course_get_contents`, which is why
[§3.10](#310-moodle-45-subsections-appear-twice) is a structural gotcha rather than a
new-function gotcha.

**4.5 → 5.0** **[per source]**:

```
added:   core_ai_delete_provider_instance, core_ai_set_provider_order,
         core_ai_set_provider_status, core_message_get_unsent_message,
         core_message_set_default_notification, core_message_set_unsent_message,
         core_question_move_questions, core_question_search_shared_banks
removed: core_grades_get_enrolled_users_for_search_widget
         core_grades_get_groups_for_search_widget
         core_output_load_fontawesome_icon_map
```

**Correction to a comfortable assumption:** the `lib/db/services.php` diff above makes 5.0
look harmless, but that file only covers `core_*`. Diffing **every** `db/services.php` in the
tree tells a different story **[per source]** — 5.0 removed:

- **all 8 `mod_chat_*` functions and all 4 `mod_survey_*` functions**, because
  **Chat and Survey were removed from core in 5.0** (MDL-82457) and became contrib plugins;
- `report_insights_set_fixed_prediction`, `report_insights_set_notuseful_prediction`.

Also removed from core in 5.0 (no WS impact, but they change what a site looks like): the
Atto editor, `auth_cas`, all MNet plugins, `mlbackend_php`. Oracle and SQLite support were
dropped.

For a *reading* integration that does not touch Chat or Survey, **5.0 changes essentially
nothing** — code that works on 4.5 works on 5.0. But if you enumerate module types
generically ([§3.28](#328-third-party-modules-and-local_-functions)), note that `chat` and
`survey` activities can still appear in `core_course_get_contents` on a 5.0 site that
installed the contrib plugins, while their WS functions may or may not be present. Feature-
detect per `modname`, exactly as that section says.

**5.1** added the activity-overview API — `core_courseformat_get_overview_information`,
`core_courseformat_get_section_content_items`, `core_course_view_module_instance_list`,
`mod_forum_set_forum_subscription`, `mod_forum_set_forum_tracking` — and **5.2** removed all
five `core_moodlenet_*` functions when MoodleNet was retired in April 2026 **[per source]**.

The larger 3.9→4.5 additions relevant to integrations:
`core_grades_get_grade_tree` and `core_grades_get_gradeitems` (4.x — a structured gradebook
tree, richer than `gradereport_user_get_grade_items`),
`core_reportbuilder_*` (4.0+, custom reports — gated by `enablecustomreports`),
`core_calendar_get_calendar_export_token` (an iCal feed token, an excellent alternative to
polling the calendar), and `core_files_get_unused_draft_itemid` (4.x — cleaner than
`itemid=0` for [§6.5](#65-the-draft-itemid-upload-dance)).

### 7.6 Mobile / token-flow changes

**[per docs]** plus **[verified on 4.5.13]** for current behaviour:

- `tool_mobile_get_public_config` has accumulated fields over time. Ones that may be
  **absent on older sites** **[per source]**:

  | Added | Fields |
  |---|---|
  | 3.3 | `mobilecssurl`, `tool_mobile_disabledfeatures`, `identityproviders[]` |
  | 3.5 | `country`, `agedigitalconsentverification`, `supportname`, `supportemail`, `autolang`, `lang`, `langmenu`, `langlist`, `locale` |
  | 3.8 | `tool_mobile_minimumversion`, `tool_mobile_iosappid`, `tool_mobile_androidappid`, `tool_mobile_setuplink` |
  | **4.0** | `supportpage`, `tool_mobile_qrcodetype` |
  | **4.1** | `supportavailability` |
  | **4.5** | `showloginform` |
  | 5.2 | `tool_mfa_enabled`, `enableloginrecaptcha`, `enableforgotpasswordrecaptcha` |

  **Treat every field except `wwwroot`, `sitename`, `typeoflogin`, `launchurl` and the two
  `enable*` switches as optional.** `httpswwwroot` is a legacy alias for `wwwroot`;
  `warnings` is always `[]`.
- `launchurl` may be absent; default to `{wwwroot}/admin/tool/mobile/launch.php`.
- `urlscheme` in the launch request: the official app uses `moodlemobile`. Sites can
  configure a custom scheme for a branded app build (`tool_mobile/forcedurlscheme`), which
  **overrides whatever the client sent**. **Parse the `token=` parameter out of the
  `Location` header regardless of scheme** rather than matching `moodlemobile://`.
- **`launch.php`'s parameter set is unchanged 3.9 → 5.2** **[per source]**:
  `service` (required), `passport` (required), `urlscheme` (default `moodlemobile`),
  `confirmed`, `oauthsso`. The `:::`-separated payload format is equally stable. This is the
  single most version-stable thing in the whole auth story.
- `/login/token.php` parameters are likewise stable: `username`, `password`, `service`.
  Note **`moodlewsrestformat` is not a parameter here** — the script always returns JSON.
  ⚠️ **Moodle 5.3dev will reject credentials sent via GET** (MDL-87010); always POST.
- Token lifetime: a new token from `/login/token.php` gets
  `validuntil = timecreated + $CFG->tokenduration`, **12 weeks by default** **[per source]**.
  Plan for re-authentication rather than assuming a permanent credential.
- **Moodle 4.3 made web-service tokens read-once in the admin UI** (MDL-76656). If you write
  provisioning instructions for an administrator, they must say *"copy the token now; it will
  never be displayed again."*
- `tool_mobile_get_autologin_key` is much more restricted than usually described
  **[per source]**: it requires `core_useragent::is_moodle_app()` to be true (so a
  third-party client is rejected with `apprequired`), requires HTTPS, refuses site admins,
  requires `privatetoken` to be **POSTed**, is rate-limited by
  `tool_mobile/autologinmintimebetweenreq` (**default 360 s**, i.e. 6 minutes — not 6 hours),
  and the key it returns has a **60-second TTL** and is IP-bound and single-use.
- QR login: `tool_mobile_qrcodetype` (4.0+) is `0` disabled, `1` URL-only, `2` instant login
  **[per source, constants `QR_CODE_DISABLED` / `QR_CODE_URL` / `QR_CODE_LOGIN`]**. Type 2 is
  HTTPS-only, keyed with a 600 s TTL, and in 5.x is flagged as a Moodle Apps Portal premium
  feature.
- `service=moodle_mobile_app` has been the built-in service shortname throughout —
  `MOODLE_OFFICIAL_MOBILE_SERVICE` is byte-identical in `lib/moodlelib.php` from 3.9 to 5.2
  **[per source]**.
- **Nothing that still exists was ever removed from the mobile service** in this range
  **[per source]**. Mobile-service membership grew 372 (3.9) → 432 (4.5) → 429 (5.1); the 5.0
  dip is entirely the removal of Chat, Survey and the insights plugins from core.

### 7.7 Writing code that spans versions

Five rules, in order of value:

1. **Feature-detect with `functions[]`, never version-sniff.** A site's exposed function set
   depends on version *and* on which functions the admin put in the service *and* on installed
   plugins. `release` tells you none of that.

2. **When you must branch on version, parse `release` defensively.** It is a human string:
   `'4.5.13 (Build: 20260810)'` **[verified on 4.5.13]**. The numeric `version`
   (`'2024100713'`) is a `YYYYMMDDXX` date stamp and is a *better* comparison key:

   ```ts
   const numericVersion = (info: SiteInfo) => Number(info.version); // 2024100713
   const releaseParts = (info: SiteInfo) =>
     (info.release.match(/^(\d+)\.(\d+)(?:\.(\d+))?/) ?? []).slice(1).map(Number);
   // ['4','5','13'] -> [4,5,13];  '4.5+ (Build: ...)' -> [4,5]  (note: patch may be absent)
   ```

   Watch for `+` suffixes on development/weekly builds (`'4.5.13+'`) and for `release`
   strings that omit the patch level entirely.

3. **Treat every response field as optional.** This single rule absorbs most of §7.4.
   `?.` and `??` everywhere; no non-null assertions on Moodle data.

4. **Prefer the newer function, fall back to the older.** As in
   [§7.3](#73-mod_forum_get_forum_discussions_paginated). Never the reverse — deprecated
   functions get removed.

5. **Degrade the feature, do not crash the app.** A missing function should turn one
   capability off with a sentence the user can act on
   ([§2.3](#23-building-a-support-matrix)), not abort the whole sync.

A useful mental model: **the union of what Moodle 3.9 and 5.0 both support is large enough
to build a complete reading integration.** `core_webservice_get_site_info`,
`core_enrol_get_users_courses`, `core_course_get_contents`,
`core_course_get_course_module`, `mod_assign_get_assignments`,
`mod_assign_get_submission_status`, `gradereport_user_get_grade_items`,
`gradereport_overview_get_course_grades`,
`core_calendar_get_action_events_by_timesort`, `mod_forum_get_forums_by_courses`,
`mod_forum_get_discussion_posts`, `core_message_get_conversations`,
`tool_mobile_call_external_functions` and `webservice/pluginfile.php` all exist across the
entire 3.9→5.0 range with compatible semantics. Build on that set and the version problem
mostly evaporates.

---

## 8. Security and etiquette

### 8.1 What a web-service token actually is

**A Moodle web-service token is a bearer credential equivalent to the user's password**, for
every function in its service, with no expiry by default, no scope narrowing, and no
second factor.

With a `moodle_mobile_app` token you can, as that user: read every course, every grade,
every private message, every forum post, and every file they can reach; **submit assignments;
post to forums; take quizzes; send messages**. On a site where `privatetoken` is issued
alongside, you can additionally mint a browser auto-login key and become that user in a web
session.

It survives a password change on many configurations. It is not listed anywhere the user
routinely looks. Treat it accordingly.

### 8.2 Storing it

- **File mode `0600`, owner-only.** The reference implementation writes
  `~/.moodle-mcp/config.json` with `{ mode: 0o600 }` *and* a follow-up `chmod`, because the
  mode argument is not honoured when the file already exists.
- **Never in a git-tracked file**, never in a `.env` that gets committed, never in a
  screenshot. A Moodle token is 32 hex characters and looks exactly like a hundred harmless
  hashes — reviewers do not recognise it.
- **Never log it.** Redact `wstoken` and `token` in any request logging, including the
  `pluginfile.php` URLs, which carry it in the query string and therefore end up in browser
  history, proxy logs, and `Referer` headers if you ever put one in an HTML page.
- **Do not put a signed `pluginfile.php` URL in anything shareable.** It is a public link to
  a private file for as long as the token lives.
- **Prefer OS keychain** over a dotfile where the platform makes that easy.
- **Discard `privatetoken`** unless you specifically need browser auto-login.
- **One token per site, keyed by host.** Never let a token for site A be sent to site B —
  key your storage by hostname and look it up by the request's target.

### 8.3 A token you cannot revoke

This is the ethically significant one. On sites where `/user/managetoken.php` is blocked for
students ([§1.5](#15-when-usermanagetokenphp-is-blocked)) — which is common — **the user has no
way to revoke the token you minted.** Only an administrator can.

Therefore:

- **Say so during onboarding**, in plain language, before minting: *"This creates an access
  key with the same reach as your Moodle password. On your site you may not be able to
  revoke it yourself; you would need to ask the Moodle administrator."*
- **Deleting your local copy is not revocation.** Say that too. The reference implementation
  is explicit about it on disconnect: *"The token itself stays valid on the Moodle server
  until it expires or an admin resets it."*
- Where the site *does* allow it, link the user straight to
  `{wwwroot}/user/managetoken.php`.

### 8.4 Respect maintenance mode

`tool_mobile_get_public_config` returns `maintenanceenabled` and `maintenancemessage`
**[verified on 4.5.13]** — the test site advertised a scheduled break in its message field
even while `maintenanceenabled: 0`.

When `maintenanceenabled` is `1`, **stop**. Do not retry in a loop: maintenance windows exist
because someone is running an upgrade, and a background sync retrying every 30 seconds during
a database migration is precisely the load nobody wants. Surface `maintenancemessage` to the
user and back off for tens of minutes.

### 8.5 Login lockout is real

`/login/token.php` is subject to Moodle's account-lockout policy (`lockoutthreshold`,
commonly 5–10) **[per docs]**. Repeated `invalidlogin` responses will lock the user out of
**Moodle entirely**, not just your integration — including the web UI, in the middle of an
exam.

Never retry a failed credential automatically. Never iterate candidate passwords. Surface
`invalidlogin` to the human immediately and let them decide.

### 8.6 Do not hammer a university's server

There is no rate limit ([§4.1](#41-what-moodle-actually-enforces)). That makes restraint your
responsibility, not the server's.

- **Batch** ([§4.3](#43-batching-with-tool_mobile_call_external_functions)) — 100 calls in
  one request instead of 100 requests is better for them *and* 18× faster for you.
- **Cache** ([§4.7](#47-caching-what-and-for-how-long)).
- **Poll on the order of minutes, not seconds.** Course content changes daily; grades change
  weekly.
- **Use `core_course_get_updates_since`** as a cheap gate before expensive re-fetches
  ([§4.6](#46-change-detection-with-core_course_get_updates_since)).
- **Send an honest `User-Agent`** identifying your tool. When an admin investigates unusual
  traffic, being identifiable is much better than looking like a scraper.
- **Serialise, don't parallelise.** A concurrency of 1–2 against one institution's server is
  plenty given batching. Fan-out across many courses simultaneously is what gets noticed.
- **Back off on 5xx and on slow responses.** A Moodle under load returns 500s; retrying
  immediately makes it worse.

### 8.7 The ethics and ToS angle

Automating an LMS account occupies real, and genuinely contested, ground. The honest framing:

**Generally fine.** Reading *your own* data — your courses, your deadlines, your grades, your
files — through the same officially-supported interface the institution's own mobile app
uses. You are a user, using a supported API, to see things you are entitled to see. This is
what the mobile web service exists for.

**Requires thought.** Automating *writes*. Submitting an assignment through an API is
usually indistinguishable from submitting it through the browser, but "usually" is doing
work: some institutions require submission through the web UI for plagiarism-declaration
reasons, and an academic-integrity declaration you clicked through programmatically is a
declaration you arguably did not make.

**Not fine.** Anything that reads other students' data beyond what your role grants;
anything that exploits a permission bug rather than reporting it; scraping at volumes that
degrade service; sharing a token; using an integration to gain a timing or information
advantage in an assessment; and — obviously — having an LLM complete graded work through your
integration.

**Concretely:**

- **Check the institution's acceptable-use policy.** Many explicitly permit personal API use
  and prohibit sharing credentials — which is exactly the shape of the rules above.
- **Prefer read-only by construction, not by intention.** Enforce it in code
  ([§3.22](#322-mod__view__-functions-are-writes)). The whole of this document was produced
  under such a constraint, which is why it contains no accidental forum posts.
- **If you find a permission bug, report it** to the institution's Moodle administrators or
  to Moodle's security process — do not build on it.
- **Never build a shared service on one user's token.** It is that user's identity; every
  action is logged as theirs.
- **Be prepared to explain yourself.** If you would not be comfortable describing your
  integration to the Moodle administrator, that is the signal.

---

## 9. Debugging recipes

### 9.1 A `curl` one-liner for every transport

Set up once:

```bash
export MURL=https://moodle.example.edu
export MTOK=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ws() { fn="$1"; shift; curl -s -X POST "$MURL/webservice/rest/server.php" \
   -d "wstoken=$MTOK" -d "moodlewsrestformat=json" -d "wsfunction=$fn" "$@"; }
```

| Transport | Command |
|---|---|
| **REST/JSON** (the default) | `ws core_webservice_get_site_info \| python3 -m json.tool` |
| **REST/XML** (omit `moodlewsrestformat`) | `curl -s -X POST "$MURL/webservice/rest/server.php" -d "wstoken=$MTOK" -d "wsfunction=core_webservice_get_site_info"` |
| **Public config** (no auth) | `curl -s -X POST "$MURL/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config" -H 'Content-Type: application/json' -d '[{"index":0,"methodname":"tool_mobile_get_public_config","args":{}}]'` |
| **Token mint (password)** | `curl -s -X POST "$MURL/login/token.php" -d 'username=U' -d 'password=P' -d 'service=moodle_mobile_app'` |
| **Token mint (SSO)** | `curl -s -D- -o /dev/null --max-redirs 0 -b cookies.txt "$MURL/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=1&urlscheme=moodlemobile" \| grep -i ^location:` |
| **AJAX (cookie session)** | `curl -s -X POST "$MURL/lib/ajax/service.php?sesskey=$SK&info=F" -H 'Content-Type: application/json' -b cookies.txt -d '[{"index":0,"methodname":"F","args":{}}]'` |
| **File download** | `curl -s -D- "$FILEURL&token=$MTOK" -o out.bin` |
| **Batch** | `curl -s -X POST "$MURL/webservice/rest/server.php" -d "wstoken=$MTOK" -d moodlewsrestformat=json -d wsfunction=tool_mobile_call_external_functions -d 'requests[0][function]=core_webservice_get_site_info' -d 'requests[0][arguments]={}'` |

Array and object parameters flatten into bracket notation:

```bash
ws core_course_get_contents -d 'courseid=58849' \
   -d 'options[0][name]=excludemodules' -d 'options[0][value]=1'
ws mod_assign_get_assignments -d 'courseids[0]=58849' -d 'courseids[1]=51279'
```

### 9.2 `debuginfo` and developer debugging

A Moodle exception can carry `debuginfo` and `reproductionlink`, which name the *actual*
offending parameter — the difference between `invalidparameter` and
`invalidparameter: Invalid external api parameter: the value is "DESC", the server was expecting "int" type`.

They appear **only when the site's debugging level is DEVELOPER and "Display debug messages"
is on**. On production, they are absent **[verified on 4.5.13]**:

```bash
ws core_course_get_contents -d 'courseid=abc'
```
```json
{"exception":"core\\exception\\invalid_parameter_exception",
 "errorcode":"invalidparameter","message":"Invalid parameter value detected"}
```

No `debuginfo`. You will not get one on a university site, and you should not ask an admin
to turn it on.

Two related traps:

- **Do not use Moodle's built-in Web Service Test Client.** The accepted answer on the most
  cited Stack Overflow question about `accessexception` is blunt **[reported —
  [SO 31482243](https://stackoverflow.com/questions/31482243/)]**: *"the Web Service Test
  Client is hopelessly broken… I'd suggest not wasting your time even trying to use this
  'tool'."* Test with real HTTP calls ([§9.1](#91-a-curl-one-liner-for-every-transport)).
- **MoodleCloud-hosted sites cannot enable developer debugging at all**, so `debuginfo` is
  permanently unavailable to those users. If your user is on MoodleCloud, skip straight to
  reproducing locally.

**Recipe: reproduce against a Moodle you control.** Stand up a throwaway Moodle
(`docker run -p 8080:8080 bitnami/moodle` or the official
`moodlehq/moodle-php-apache` dev images), set *Site administration → Development →
Debugging* to **DEVELOPER** with display on, create the same shape of data, and replay the
failing call. `debuginfo` then tells you exactly which parameter is wrong. This is far
faster than bisecting parameters against a production site, and it does not add load to
someone else's server.

### 9.3 Telling the four failure classes apart

This decision table is the single most useful debugging artifact in this document. All rows
**[verified on 4.5.13]**.

| You sent | You get back | Class |
|---|---|---|
| `wsfunction=totally_made_up_function_xyz` | `{"exception":"dml_missing_record_exception","errorcode":"invalidrecord","message":"Can't find data record in database table external_functions."}` | **Function does not exist on this site** |
| `wsfunction=core_user_create_users` (exists, not in this service) | `{"exception":"webservice_access_exception","errorcode":"accessexception","message":"Access control exception"}` | **Function not exposed to this token** |
| `core_course_get_contents` with no `courseid` | `{"exception":"core\\exception\\invalid_parameter_exception","errorcode":"invalidparameter","message":"Invalid parameter value detected"}` | **Missing required parameter** |
| `core_course_get_contents` with `courseid=notanumber` | same as above | **Wrong parameter type** — indistinguishable from the previous without `debuginfo` |
| `core_course_get_contents` with `courseid=2` (real course, no access) | `{"exception":"core\\exception\\moodle_exception","errorcode":"errorcoursecontextnotvalid","message":"You cannot execute functions in the course context (course id:2). The context error message was: Course or activity not accessible."}` | **No permission** |
| `gradereport_user_get_grade_items` without `userid` | `{"exception":"core\\exception\\required_capability_exception","errorcode":"nopermissions","message":"Sorry, but you do not currently have permissions to do that (View grades of other users)."}` | **No capability** (names the capability!) |
| `core_course_get_contents` with `courseid=999999999` | `{"exception":"dml_missing_record_exception","errorcode":"invalidrecord","message":"Can't find data record in database table course."}` | **Record does not exist** |
| `wstoken=deadbeef` | `{"exception":"core\\exception\\moodle_exception","errorcode":"invalidtoken","message":"Virheellinen avain - avainta ei löytynyt"}` | **Bad/expired token → re-authenticate** |
| no `wsfunction` at all | `{"exception":"core\\exception\\invalid_parameter_exception","errorcode":"invalidparameter","message":"Invalid parameter value detected"}` | **Malformed request** |

Distilled into code:

```ts
type Class = "missing_function" | "not_in_service" | "bad_params" | "no_permission"
           | "missing_record" | "reauth" | "site_broken" | "unknown";

function classify(e: MoodleError): Class {
  switch (e.errorcode) {
    case "invalidtoken":
    case "invalidparameter:token":
      return "reauth";
    case "accessexception":
      return "not_in_service";       // …or the token is dead; see note below
    case "nopermissions":
    case "requireloginerror":
    case "errorcoursecontextnotvalid":
    case "cannotviewprofile":
    case "notenrolledtocourse":
      return "no_permission";
    case "invalidparameter":
      return "bad_params";
    case "invalidrecord":
      return /\bexternal_functions\b/.test(e.message) ? "missing_function" : "missing_record";
    case "globalsearchdisabled":
    case "servicenotavailable":
      return "no_permission";        // feature switched off — degrade
    default:
      return e.errorcode === "exception" ? "site_broken" : "unknown";
  }
}
```

**A note on `accessexception`.** It is genuinely ambiguous: it means both "this function is
not in your service" and, in some paths, "your token is no longer valid". The reference
implementation treats it as a re-auth trigger alongside `invalidtoken`:

```ts
get needsReauth(): boolean {
  return ["invalidtoken", "accessexception", "invalidparameter:token"].includes(this.errorcode);
}
```

That is the right trade-off for an interactive tool — a spurious "please reconnect" is much
cheaper than a permanently broken integration — but check `functions[]` first so you do not
send users to re-authenticate over a function the site simply does not have.

Field notes on `accessexception`, all **[reported]**:

- The debuginfo lists **seven** possible causes, and multiple can be true at once. One
  three-week debugging thread on Moodle 4.1 ended with *two* independent faults: the function
  was missing from the external service **and** *"the 'rights' of my role assigned to my new
  service were overridden by other roles. I changed the order"*
  **[[d=444454](https://moodle.org/mod/forum/discuss.php?d=444454)]**. Role-assignment
  precedence at a different context is a cause no amount of reading the response will reveal.
- **`{$a}` is sometimes not interpolated.** The protocol-capability variant reads literally
  `You are not allowed to use the {$a} protocol (missing capability: webservice/xmlrpc:use)`
  **[[d=205934](https://moodle.org/mod/forum/discuss.php?d=205934)]**. Never pattern-match it.
- **Reads work but writes fail** is the signature of "only some functions were added to the
  service" **[[SO 71966962](https://stackoverflow.com/questions/71966962/)]**.
- Sending `token=` and `method=` instead of **`wstoken=` and `wsfunction=`** produces
  `accessexception` with debuginfo *"Invalid token - token not found"*
  **[[d=204875](https://moodle.org/mod/forum/discuss.php?d=204875)]** — an auth-shaped error
  for a spelling mistake.

Finally, a *view* function masquerading as a getter, which cost two people in one thread real
time **[[d=353543](https://moodle.org/mod/forum/discuss.php?d=353543)]**:
`core_user_view_user_list` returns only `{"status":1,"warnings":[]}`. It is a write
([§3.22](#322-mod__view__-functions-are-writes)), not a listing.

**Timeouts are a fifth class, and there is nothing client-side to do about them.** On large
courses `gradereport_user_get_grade_items` and `core_course_get_contents` can exceed the
server's execution limit. Bret Miller's answer is the one to quote to a user **[reported —
[d=462403](https://moodle.org/mod/forum/discuss.php?d=462403), Moodle 4.4.3]**:

> "That's a server-level setting. PHP has a default maximum execution time of 30 seconds…
> Moodle also has a setting in **Site Administration / Server / Performance for 'maximum time
> limit'** in seconds. It defaults to zero to use the Moodle default… **from the client side
> of the API, I'm not sure there is much you can do if it's the server timing out.**"

Your only levers are the server-side filters in
[§4.4](#44-making-core_course_get_contents-cheaper) — `excludemodules`, `excludecontents`,
`cmid`, `sectionid` — which reduce the work the server does rather than the bytes it sends.
For the record, the largest observed `core_course_get_contents` response is **over 80 MB**,
on a course with 53 sections **[reported —
[MOBILE-4590](https://tracker.moodle.org/browse/MOBILE-4590)]**; the 120 KB measured in
[§4.2](#42-measured-costs) is not an upper bound.

**`{"exception":"Error", ...}` with no `errorcode`** is its own class: an unhandled PHP error
([§3.1](#31-errorcode-is-sometimes-a-sentence-and-sometimes-absent),
[§3.17](#317-one-bad-id-can-kill-a-whole-batch)). It almost always means you passed a
syntactically valid but semantically impossible argument. Bisect your arguments.

### 9.4 Reproducing a failing call outside your app

Build a "raw call" escape hatch into the integration itself. The reference implementation
exposes `moodle_call` — an arbitrary function name plus a JSON parameter object, gated by the
read-only allow-list ([§3.22](#322-mod__view__-functions-are-writes)) — plus
`moodle_functions` to list what the site supports. This turns "my tool says grades are
broken" into a two-minute investigation instead of a rebuild.

To go from a failing call to a `curl` you can paste into a bug report:

1. Log the flattened form parameters, **with `wstoken` redacted**, at the transport layer.
2. Re-emit them as a `curl` line. `URLSearchParams` → `-d 'k=v'` pairs is mechanical:

```ts
function asCurl(url: string, flat: Record<string,string>): string {
  const parts = Object.entries(flat)
    .map(([k, v]) => `  -d ${JSON.stringify(`${k}=${k === "wstoken" ? "$MTOK" : v}`)}`);
  return [`curl -s -X POST ${JSON.stringify(url)} \\`, ...parts].join(" \\\n");
}
```

3. Confirm the raw call fails the same way outside your app. If it does not, the bug is
   yours — most often parameter flattening
   ([§4.5](#45-request-size-and-the-max_input_vars-cliff)) or a boolean serialised as
   `"true"` instead of `"1"`.

### 9.5 Shell traps that look like Moodle bugs

Two that cost real time, both encountered while researching this document:

**`echo` mangles JSON.** In `zsh` and in POSIX `sh`, the builtin `echo` interprets backslash
escapes. Capturing a response in a variable and echoing it to a file converts the JSON's
`\r` and `\n` **escape sequences into literal control characters**, producing a file that
`JSON.parse` rejects with *"Bad control character in string literal"* and Python rejects with
*"Invalid control character"*. It looks exactly like a server emitting invalid JSON. It is
not.

```bash
s='{"a":"x\r\ny"}'
echo "$s"    > bad.json     # -> {"a":"x<CR><LF>y"}   INVALID JSON
printf '%s' "$s" > good.json # -> {"a":"x\r\ny"}       valid
```

**Always write responses with `curl -o file`,** never through a shell variable. If you must
capture, use `printf '%s'`.

**Unquoted brackets and braces.** `-d requests[0][function]=x` unquoted is subject to zsh
globbing and brace expansion. Quote every `-d` argument containing `[`, `]`, `{`, `}`, or
`*`. Symptoms are `invalidparameter` on a call that is obviously correct.

### 9.6 A minimal health-check script

Run this against any site before debugging anything else:

```bash
#!/bin/bash
set -u
: "${MURL:?}"; : "${MTOK:?}"
echo "== public config =="
curl -s -X POST "$MURL/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config" \
  -H 'Content-Type: application/json' \
  -d '[{"index":0,"methodname":"tool_mobile_get_public_config","args":{}}]' \
  -o /tmp/pc.json
python3 - <<'PY'
import json
d=json.load(open('/tmp/pc.json'))[0].get('data',{})
for k in ("sitename","typeoflogin","enablewebservices","enablemobilewebservice",
          "maintenanceenabled","launchurl","lang"):
    print(f"  {k:26} {d.get(k)!r}")
PY
echo "== site info =="
curl -s -X POST "$MURL/webservice/rest/server.php" -d "wstoken=$MTOK" \
  -d moodlewsrestformat=json -d wsfunction=core_webservice_get_site_info -o /tmp/si.json
python3 - <<'PY'
import json
d=json.load(open('/tmp/si.json'))
if 'exception' in d: print("  TOKEN PROBLEM:", d.get('errorcode'), d.get('message')); raise SystemExit(1)
print(f"  release   {d['release']}  version {d['version']}")
print(f"  user      {d['fullname']} <{d['username']}> id={d['userid']}")
print(f"  functions {len(d['functions'])}   downloadfiles={d['downloadfiles']} uploadfiles={d['uploadfiles']}")
print("  features ", {x['name']: x['value'] for x in d['advancedfeatures']})
PY
```

If the first block succeeds and the second fails with `invalidtoken`, the site is fine and
your credential is not. That single distinction resolves most reported "it stopped working".

---

## 10. Reference implementation notes

There is a working TypeScript MCP server at **`/Users/ink_waffle/MCPs/moodle-mcp`** that
implements most of this document. It is worth reading as a worked example; the patterns
below are the ones it settled on after contact with a real site.

```
src/
  ws.ts        MoodleClient, parameter flattening, error mapping, file download/upload
  auth.ts      the auth ladder: public config -> password / browser launch.php
  config.ts    per-site token storage (0600), site resolution, env override
  api.ts       typed wrappers for the read functions used, plus the disk cache
  format.ts    HTML -> markdown, tables, date/size formatting, entity decoding
  browser.ts   Playwright context for the SSO login flow
  server.ts    MCP tool registry (39 tools)
  http.ts      Streamable-HTTP transport, one process, many sessions
  tools/       read tools, submissions, interactions, interactive-pages, raw
```

### 10.1 The auth ladder (`auth.ts`, `tools/site.ts`)

`planConnection(baseUrl)` maps the public-config probe onto exactly three strategies, and
returns a *reason string* alongside — so the failure message a user sees names the setting
that blocked them:

```ts
if (!config.enablewebservices || !config.enablemobilewebservice) {
  return { config, strategy: "unsupported", reason:
    "This site has the mobile web service switched off (enablemobilewebservice=0), so no " +
    "token can be issued and this server cannot read it. A browser-automation MCP pointed " +
    "straight at the site is the only route left." };
}
if (config.typeoflogin === 1) {
  return { config, strategy: "password", reason:
    "Site accepts direct username/password token exchange (typeoflogin=1); no browser needed." };
}
return { config, strategy: "mobile-launch", reason:
  `Site logs in via browser/SSO (typeoflogin=${config.typeoflogin}); token is minted through launch.php after you log in.` };
```

The browser path (`mintTokenViaBrowser`) is worth studying for three decisions:

- **Headless probe first.** `getContext({ headless: true })` and one `tryLaunch` — a profile
  that still holds a session yields a token with no window ever appearing.
- **`ctx.request.get(url, { maxRedirects: 0 })`** rather than a navigation, so the token is
  captured from the `Location` header without disturbing the user's open tabs. A real
  navigation is the *fallback*, used only when launch.php renders a page instead of
  redirecting.
- **Return `"waiting"` instead of blocking.** SSO takes minutes; MCP clients time out in
  seconds. Calling `moodle_connect` again resumes against the same live browser.

Credentials in the password path are exchanged and **never stored** — only the resulting
token is persisted.

### 10.2 Parameter flattening (`ws.ts`)

One recursive walk turns idiomatic JS objects into Moodle's bracket notation, including the
boolean→`"1"`/`"0"` conversion that Moodle requires and the `undefined`/`null` pruning that
prevents empty parameters from being sent as the string `"undefined"`:

```ts
export function flattenParams(params: Params): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(`${prefix}[${k}]`, v);
    } else if (typeof value === "boolean") {
      out[prefix] = value ? "1" : "0";
    } else {
      out[prefix] = String(value);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out;
}
```

The dropped-`null` behaviour is load-bearing: it makes `{ userid: maybeUndefined }` safe, and
it is why omitting an optional parameter is spelled `undefined` rather than a conditional
spread at every call site.

### 10.3 Error mapping and re-auth signalling (`ws.ts`)

```ts
export class MoodleError extends Error {
  constructor(readonly errorcode: string, message: string, readonly fn: string) {
    super(`[${errorcode}] ${message}  (${fn})`);
    this.name = "MoodleError";
  }
  /** True when the stored token is dead and the user has to re-authenticate. */
  get needsReauth(): boolean {
    return ["invalidtoken", "accessexception", "invalidparameter:token"].includes(this.errorcode);
  }
}
```

Three details that matter, each corresponding to a gotcha above:

- The message always carries the **function name**, because a bare
  `[nopermissions] Sorry, but you do not currently have permissions to do that` in a log is
  useless.
- `err.errorcode ?? "exception"` at the throw site, so a raw PHP `Error` with no code still
  produces a well-formed object ([§3.1](#31-errorcode-is-sometimes-a-sentence-and-sometimes-absent)).
- Empty and literal-`"null"` bodies are handled before `JSON.parse`, and a non-JSON body
  becomes `bad_response` with the first 200 characters attached — which is how you discover
  an HTML maintenance page or a WAF block page:

```ts
const text = await res.text();
if (text.trim() === "" || text.trim() === "null") return null as T;
let data: unknown;
try { data = JSON.parse(text); }
catch { throw new MoodleError("bad_response", `Response was not JSON: ${text.slice(0, 200)}`, fn); }
if (data && typeof data === "object" && !Array.isArray(data)) {
  const err = data as MoodleExceptionBody;
  if (err.exception) throw new MoodleError(err.errorcode ?? "exception", err.message ?? "unknown error", fn);
}
```

Note the `!Array.isArray(data)` guard: several functions return a bare array
(`core_enrol_get_users_courses`, `mod_forum_get_forums_by_courses`), and treating an array as
a potential error envelope would be wrong.

### 10.4 Encoding the gotchas as comments

The most valuable thing about `api.ts` is not the code, it is that each hard-won constraint
sits *at the call site*, where the next person to touch it will read it:

```ts
export async function getGradeItems(client: MoodleClient, courseid: number): Promise<GradeItem[]> {
  // userid must be explicit: omitting it means "all users" and fails with nopermissions.
  const res = await client.call<{ usergrades: { gradeitems: GradeItem[] }[] }>(
    "gradereport_user_get_grade_items", { courseid, userid: client.site.userid });
  return res.usergrades?.[0]?.gradeitems ?? [];
}

export async function getDiscussions(client: MoodleClient, forumid: number, perpage = 10) {
  // Note: sortby/sortdirection belong to the deprecated *_paginated variant and are
  // rejected here; this function takes an integer sortorder, whose default is fine.
  const res = await client.call<{ discussions: Discussion[] }>(
    "mod_forum_get_forum_discussions", { forumid, page: 0, perpage });
  return res.discussions ?? [];
}
```

and in the type declarations:

```ts
export interface CourseSection {
  ...
  /** Moodle 4.5 subsections come back as their own section, delegated to a module. */
  component?: string | null;
  itemid?: number | null;
}
export interface ActionEvent {
  ...
  instance: number; // course-module id for activity events
}
```

That last comment is [§3.7](#37-ids-that-are-not-the-id-you-think) in eight words, at the
exact point of confusion.

Also note the `?.[0]?.` and `?? []` chains — the discipline from
[§3.20](#320-optional-response-fields-are-absent-not-null) applied consistently.

### 10.5 Caching and projection

`cached()` ([§4.7](#47-caching-what-and-for-how-long)) is a JSON-file helper namespaced per
site host, with an explicit `refresh` flag threaded up to the user-facing tools. An on-disk
cache survives process restarts, which for a tool invoked repeatedly by an agent is most of
the benefit.

Past the TTL it does not refetch blindly. `cached()` takes an optional `validate(cachedAt)`
callback, and `courseSections` supplies one built on `core_course_get_updates_since`: if
Moodle reports no module changed since the entry was written, the entry is re-stamped and
reused, so one small call replaces a course-contents payload of tens of kilobytes. A
six-hour ceiling still forces a full refetch, because `updates_since` reports module-level
changes only and would miss a renamed section
([§4.6](#46-change-detection-with-core_course_get_updates_since)).

The projection layer is where the real win is. Every tool converts Moodle's JSON into a
**compact markdown table**, discarding fields nothing needs:

```ts
const body = table(
  ["id", "shortname", "name", "starts", "ends", "state", "progress"],
  rows.map((c) => [
    c.id, c.shortname, c.fullname,
    fmtDate(c.startdate), fmtDate(c.enddate),
    classify(c, now) + (c.hidden ? ", hidden" : ""),
    c.progress === null ? "" : `${Math.round(c.progress)}%`,
  ]),
);
```

For an LLM consumer this is the difference between a usable tool and one that blows the
context window: `core_enrol_get_users_courses` for 11 courses is tens of kilobytes of JSON,
most of it base64 course artwork ([§3.24](#324-the-payload-is-mostly-course-artwork)); the
table above is under a kilobyte and strictly more readable. Note `c.progress === null ? ""`
— the null/zero distinction from
[§3.25](#325-guest-access-and-courses-you-are-not-enrolled-in), preserved.

The same discipline appears in `courseSections`: descriptions are truncated per module
(`html2md(m.description, 4000)`), section summaries to 800 characters and rendered as
blockquotes, and file lists collapsed to `contentsinfo.filescount`.

### 10.6 Gotcha handling, mapped to code

| Gotcha | Where it is handled |
|---|---|
| [§3.3](#33-core_calendar_get_action_events_by_timesort-caps-limitnum-at-50) `limitnum` 1..50 | `tools/agenda.ts`: `Math.min(Math.max(opts.limit ?? 50, 1), 50)` with the reason in a comment |
| [§3.4](#34-gradereport_user_get_grade_items-defaults-to-all-users) explicit `userid` | `api.ts: getGradeItems`, from the persisted `Site.userid` |
| [§3.5](#35-mod_forum_get_forum_discussions-rejects-sortbysortdirection) forum sort params | `api.ts: getDiscussions` — omitted entirely |
| [§3.6](#36-empty-string-is-not-null) `""` vs `null` | `tools/agenda.ts`: `it.itemname \|\| (itemtype === "course" ? "COURSE TOTAL" : …)` — `\|\|`, not `??` |
| [§3.8](#38-the-calendar-emits-many-events-per-activity) calendar dedup | `tools/agenda.ts`: merge map keyed `course-module-instance-timesort`, preferring `action.actionable` |
| [§3.9](#39-html-entities-survive-in-plain-text-fields) entities | `format.ts: decodeEntities`, applied to section names, `rangeformatted`, `weightformatted`, date labels |
| [§3.10](#310-moodle-45-subsections-appear-twice) subsections | `tools/courses.ts`: `delegated: Map<itemid, sectionnum>`, rendered as `contents in §N` |
| [§3.11](#311-global-search-is-off-on-most-sites) no global search | `tools/courses.ts`: client-side search over cached contents |
| [§3.13](#313-uservisible-false-hides-modules-you-can-still-see) `uservisible` | `tools/courses.ts`: `if (!m.uservisible) bits.push("restricted")` |
| [§3.15](#315-dateslabel-is-localised-and-tense-inflected) date labels | `tools/courses.ts`: `decodeEntities(d.label).replace(/:$/, "")` for display |
| [§3.19](#319-gradeformatted-is-locale-formatted-prose) `"-"` grades | `tools/agenda.ts`: `it.gradeformatted === "-" ? "" : …` |
| [§6.2](#62-signing-the-url) URL signing | `ws.ts: fileUrl` — `URL.searchParams.set`, never concatenation |
| [§6.3](#63-the-json-instead-of-a-file-trap) JSON-instead-of-file | `ws.ts: download` — content-type check before writing |
| [§6.4](#64-filenames) filename safety | `tools/files.ts: safeName` — `basename` + strip leading dots |
| [§8.2](#82-storing-it) token at rest | `config.ts: save` — `{ mode: 0o600 }` plus explicit `chmod` |
| [§8.3](#83-a-token-you-cannot-revoke) revocation honesty | `tools/site.ts: disconnect` — states that the token stays valid server-side |

### 10.7 Student writes and remaining gaps

Dedicated tools now cover draft uploads; assignment file/online-text saves and finalization;
quiz start, rendered-page read, autosave and finish; workshop submissions and assessments;
and choice, forum, feedback, lesson, glossary, database, wiki and legacy survey writes.
They use the same web-service token as the read tools; browser login is for SSO,
not the transport for these API calls. The generic `moodle_call` remains read-verb-only.
`moodle_activity` reports LTI/SCORM/H5P runtimes, unfamiliar Moodle 4.5 quiz question
types, unsupported assignment submission plugins, and no-draft submission statements;
`moodle_quiz_page` warns that rendered HTML may omit usable visual or interactive context.
These are **advisories, not a completeness test**: even a built-in question type can embed
media or site-specific scripts. A missing warning does not prove API-only completion is
safe. Use a separate browser tool if appropriate, or ask the student to inspect and act;
this MCP does not drive the exercise runtime itself.

The write path checks Moodle warnings and preflights editability where available. Assignment
saves on no-draft activities can submit immediately; a no-draft assignment that requires a
submission statement is intentionally left to the browser because `save_submission` cannot
record its acceptance. Workshop updates replace the entire content and attachment list.
Forum attachments require `cancreateattachment`, or Moodle silently discards them.
Site-level feedback needs the same `courseid` for launch, page reads, and page submissions;
ordinary course feedback does not. Starting an attempt or finalizing work is real,
potentially irreversible student activity; the write paths were source-audited,
**not** exercised against live courses. There is no automated integration test suite.

Remaining gaps:

- **Quiz media and scripted questions.** `moodle_quiz_page` returns `questions[].html`, not
  image bytes, video playback or a transcript. Its HTML exposes ordinary text and exact
  answer-field names, but embedded media URLs require separate authenticated retrieval and
  MathJax/STACK controls may need Moodle's browser runtime. `moodle_download({cmid})` does
  not enumerate images embedded in quiz questions. Reading an in-progress page requires an
  attempt, which may start a timer and consume a limited attempt.
- **External or package runtimes.** LTI/Turnitin/MATLAB Grader content is held by its provider;
  H5P and SCORM need their respective browser/package runtimes. Direct SCORM track writes
  could change grades without running the package and are not exposed as exercise tools.
- **Read projections still omit some `warnings[]`.** Dedicated writes reject warnings, but
  older read tools can still hide partial failures ([§3.16](#316-warnings-is-where-your-missing-data-went)).
- **No `tool_mobile_call_external_functions` batching** and **no multilang handling**
  ([§5.3](#53-multilang-spans)). The generic read allow-list is a heuristic: for example,
  `mod_assign_get_submission_status` creates a harmless `new` submission row on first read.

---

## Appendix A: the read-only function allow-list

The generic `moodle_call` currently gates names with this heuristic in `tools/raw.ts`;
write functions are registered separately as dedicated, validated tools. `_view_` calls
are excluded because they may mark activities complete.

```ts
const READ_VERBS = /_(get|search|is|can|check)_/;
if (!READ_VERBS.test(fn)) throw new Error(`Use a dedicated tool for ${fn}`);
```

Known safe-looking-but-dangerous names to deny explicitly:

```
core_course_view_course          mod_assign_view_assign        mod_assign_view_submission_status
mod_forum_view_forum             mod_forum_view_forum_discussion
mod_page_view_page               mod_url_view_url              mod_resource_view_resource
mod_book_view_book               mod_folder_view_folder        mod_quiz_view_quiz
mod_lesson_view_lesson           mod_scorm_view_scorm          mod_glossary_view_glossary
mod_lti_view_lti                 mod_h5pactivity_view_h5pactivity
core_completion_update_activity_completion_status_manually
```

Genuinely read-only despite an unusual name:

```
core_webservice_get_site_info                      tool_mobile_get_public_config
tool_mobile_get_config                             core_course_get_updates_since
gradereport_overview_get_course_grades             core_calendar_get_action_events_by_timesort
core_enrol_get_users_courses                       core_message_get_conversations
```

`tool_mobile_call_external_functions` is neither: it is as read-only as the calls you put
inside it. Apply the allow-list to each sub-call, not to the wrapper.

## Appendix B: the reproduction environment

Everything marked **[verified on 4.5.13]** was executed against:

```
site        https://moodle.tuni.fi  ("TUNI Moodle | Tampere universities")
release     4.5.13 (Build: 20260810)
version     2024100713
role        ordinary enrolled student, userissiteadmin = false
auth        Shibboleth SSO (typeoflogin = 2), token minted via admin/tool/mobile/launch.php
functions   450 exposed (176 core_*, 215 mod_*, 26 tool_*, 4 local_*)
site lang   fi (user lang en) — which is why several errors above are in Finnish
features    enableglobalsearch=0, enablecompletion=1, messaging=1,
            enablebadges=0, enablecompetencies=0, enablecustomreports=1
courses     58630, 58666, 58849, 42767 (completed, full gradebook), 51279
date        2026-09-03
```

All calls were read-only. Where a claim could not be reproduced on this site — multilang
spans, the upload flow, `SEPARATEGROUPS` at scale, sites with `typeoflogin=1` — it is marked
**[per docs]** and says so in place.

## Appendix C: sources

- Moodle External services API — <https://moodledev.io/docs/apis/subsystems/external/>
  (functions, description, security, writing a service)
- Web services FAQ — <https://docs.moodle.org/en/Web_services_FAQ>
- Mobile web services — <https://docs.moodle.org/en/Mobile_web_services>
- Moodle source — <https://github.com/moodle/moodle>, raw files at
  `https://raw.githubusercontent.com/moodle/moodle/<branch>/<path>`, at refs
  `MOODLE_{39,310,311,400,401,402,403,404,405,500,501,502}_STABLE`. Files used for the
  diffs in [§7](#7-version-differences-that-bite) and the per-source claims throughout:
  every `*/db/services.php` in the tree (not only `lib/db/services.php` — this is what
  surfaced the 5.0 Chat/Survey removals), `course/externallib.php`,
  `course/classes/external/helper_for_get_mods_by_courses.php`,
  `completion/classes/external/completion_info_exporter.php`,
  `calendar/classes/external/event_exporter_base.php`,
  `course/format/classes/stateactions.php`,
  `admin/tool/mobile/{classes/api.php,classes/external.php,launch.php,db/services.php}`,
  `login/token.php`, `lib/moodlelib.php`, `webservice/rest/locallib.php`,
  `mod/forum/db/services.php`, `admin/environment.xml`, and per-component `upgrade.txt` /
  `UPGRADING.md`.
  **Note:** from Moodle 5.1 these paths are prefixed `public/`.
- Moodle release notes — <https://moodledev.io/general/releases>
- Moodle tracker — <https://tracker.moodle.org> (REST API `/rest/api/2` for issue lookup).
  Issues cited: MDL-27759, MDL-30229, MDL-47665, MDL-47766, MDL-51861, MDL-56020, MDL-57255,
  MDL-64304, MDL-64444, MDL-67781, MDL-68605, MDL-69759, MDL-70110, MDL-70483, MDL-71390,
  MDL-72433, MDL-73574, MDL-76656, MDL-82457, MDL-83149, MDL-85160, MDL-87010, MDL-87242,
  MOBILE-3486, MOBILE-4390, MOBILE-4583, MOBILE-4590
- Security advisories — MSA-14-0038 / CVE-2014-7831 (hidden grades),
  MSA-15-0043 / CVE-2015-5339 (group filtering)
- Moodle community forums (Web services, Mobile app) — <https://moodle.org/mod/forum/>.
  Discussions cited: d=190049, d=204875, d=205934, d=218027, d=275153, d=313178, d=323234,
  d=353543, d=358237, d=377517, d=382951, d=396087, d=401621, d=412883, d=434893, d=438343,
  d=444454, d=453324, d=455729, d=458124, d=462403, d=465079
- Stack Overflow — questions 31482243, 56345808, 71966962
- Errors handling in web services — <https://docs.moodle.org/dev/Errors_handling_in_web_services>
- Environment — max_input_vars — <https://docs.moodle.org/502/en/Environment_-_max_input_vars>
- Moodle App source (for the client side of the token flow) —
  <https://github.com/moodlehq/moodleapp>
- Reference implementation — `/Users/ink_waffle/MCPs/moodle-mcp`

### A note on claims this document deliberately does **not** make

Several assertions that circulate widely were checked and found to be **wrong**; they are
absent here on purpose, and listed so nobody re-adds them:

| Common claim | Reality |
|---|---|
| `typeoflogin` has a value `6` | No such core constant. Only 1, 2, 3 exist ([§1.2](#12-the-decision-tree)) |
| `tool_mobile_call_external_functions` isolates per-call failures | It is **fail-fast** and truncates the batch ([§4.3](#43-batching-with-tool_mobile_call_external_functions)) |
| `dates[]` arrived in 4.0 | **3.11**; `dataid` in 4.1 ([§7.4](#74-response-fields-by-the-version-they-appeared)) |
| The 4.3 "completion overhaul" added `isoverallcomplete`/`details` | `details` is 3.11, `isoverallcomplete` is 4.4; 4.3 changed only `state` behaviour, temporarily ([§7.4](#74-response-fields-by-the-version-they-appeared)) |
| `mod_bigbluebuttonbn` was removed in 4.4 | It was **added** to core in 4.0 and is still there |
| `mod_subsection` exposes web-service functions | It exposes **none** ([§3.10](#310-moodle-45-subsections-appear-twice)) |
| `core_search_get_results` has always existed | **4.3+ only** ([§3.11](#311-global-search-is-off-on-most-sites)) |
| `tool_mobile_get_autologin_key` is limited to one per 6 hours | 6 **minutes** between requests; the key itself lives 60 **seconds** ([§7.6](#76-mobile-token-flow-changes)) |
| `lang` is a field of `core_course_get_contents` modules | It is not; it is on `mod_*_get_*_by_courses`, from 4.1 |
| Moodle returned invalid JSON with raw control characters | That was a **shell** artifact, not Moodle ([§9.5](#95-shell-traps-that-look-like-moodle-bugs)) |
| The capability list on a function's docs page is enforced | It is **advisory only**; Moodle HQ confirmed no checks are performed from it ([§3.0](#30-the-one-principle-that-unifies-most-of-this-section)) |
| A missing capability produces an error | Usually it produces a **200 with fields silently omitted** ([§3.0](#30-the-one-principle-that-unifies-most-of-this-section)) |
| Running as a site admin returns the most data | For `core_user_get_users` an admin gets **less** — no `email` at all ([§3.29](#329-core_user_get_users-drops-email-and-being-an-admin-makes-it-worse)) |
| Exceeding `max_input_vars` truncates the request | It **corrupts and duplicates** parameters, with only an `E_WARNING` ([§4.5](#45-request-size-and-the-max_input_vars-cliff)) |
| `timeusermidnight` makes calendar timezones safe | It fixes *bucketing*; the month/day view functions still **select** in server time ([§3.21](#321-timezone-99-and-the-day-boundary-problem)) |
| A documented function behaves the same on every site | `override_webservice_execution` lets a plugin replace any of them ([§3.30](#330-a-site-can-silently-rewrite-any-function)) |
| Moodle's Web Service Test Client is a good way to debug | *"hopelessly broken"* — use real HTTP calls ([§9.2](#92-debuginfo-and-developer-debugging)) |
