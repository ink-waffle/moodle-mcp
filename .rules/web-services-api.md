# Moodle Web Services / External API — Reference

> **Scope of this document.** Everything about *talking to* a Moodle site over its
> external-function API: how external functions are defined and gated, every
> transport endpoint and its exact URL, the complete token/authentication
> landscape (including the mobile-app SSO flow), calling conventions and error
> semantics, file download/upload over web services, a catalogue of the external
> functions that matter, and how the function set changed between releases.
>
> **What lives in the sibling docs — do not look for it here:**
>
> | File | Covers |
> |---|---|
> | `data-model.md` | DB schema, contexts / roles / capabilities model, gradebook internals, completion internals, calendar internals, Files API internals (`mdl_files`, file areas, draft areas) |
> | `activity-modules.md` | Per-`mod_*` details: what each activity's WS functions actually do, attempt/submission state machines, module-specific response shapes |
> | `integration-cookbook.md` | Practical patterns, pitfalls, workarounds, per-site quirks, debugging recipes |
>
> **Provenance.** Source claims cite the Moodle file path; unless stated otherwise
> the branch read is `MOODLE_405_STABLE`
> (`https://raw.githubusercontent.com/moodle/moodle/MOODLE_405_STABLE/<path>`).
> Claims marked **[verified on 4.5.13]** were confirmed by live HTTP calls against
> a production Moodle 4.5.13 (`release: "4.5.13 (Build: 20260810)"`,
> `version: "2024100713"`) in September 2026, using a `moodle_mobile_app` token
> belonging to a non-admin student account. Read-only functions only were called,
> so anything requiring a write is marked **[not verified]**.

---

## Table of contents

1. [Architecture: what an external function is](#1-architecture-what-an-external-function-is)
   - 1.1 [The three-part definition](#11-the-three-part-definition)
   - 1.2 [`db/services.php`: the `$functions` array](#12-dbservicesphp-the-functions-array)
   - 1.3 [`db/services.php`: the `$services` array and built-in services](#13-dbservicesphp-the-services-array-and-built-in-services)
   - 1.4 [Registration lifecycle and the `external_functions` table](#14-registration-lifecycle-and-the-external_functions-table)
   - 1.5 [The gate: `external_api::call_external_function()`](#15-the-gate-external_apicall_external_function)
   - 1.6 [`ajax`, `loginrequired`, `readonlysession` semantics](#16-ajax-loginrequired-readonlysession-semantics)
   - 1.7 [Capability checks inside functions](#17-capability-checks-inside-functions)
   - 1.8 [The description language (`external_value` & friends)](#18-the-description-language-external_value--friends)
   - 1.9 [`external_settings`: the text/file formatting singleton](#19-external_settings-the-textfile-formatting-singleton)
2. [Transports and endpoints](#2-transports-and-endpoints)
   - 2.1 [Endpoint map](#21-endpoint-map)
   - 2.2 [REST: `/webservice/rest/server.php`](#22-rest-webservicerestserverphp)
   - 2.3 [XML-RPC and SOAP](#23-xml-rpc-and-soap)
   - 2.4 [`/lib/ajax/service.php`](#24-libajaxservicephp)
   - 2.5 [`/lib/ajax/service-nologin.php`](#25-libajaxservice-nologinphp)
   - 2.6 [Batching: `tool_mobile_call_external_functions`](#26-batching-tool_mobile_call_external_functions)
3. [Authentication and tokens](#3-authentication-and-tokens)
   - 3.1 [Token model](#31-token-model)
   - 3.2 [`/login/token.php`](#32-logintokenphp)
   - 3.3 [Token reuse, expiry, IP restriction](#33-token-reuse-expiry-ip-restriction)
   - 3.4 [`/user/managetoken.php` and capabilities](#34-usermanagetokenphp-and-capabilities)
   - 3.5 [The mobile-app SSO launch flow (`/admin/tool/mobile/launch.php`)](#35-the-mobile-app-sso-launch-flow-admintoolmobilelaunchphp)
   - 3.6 [QR login](#36-qr-login)
   - 3.7 [`privatetoken` and `tool_mobile_get_autologin_key`](#37-privatetoken-and-tool_mobile_get_autologin_key)
   - 3.8 [`tool_mobile_get_public_config`: the unauthenticated capability probe](#38-tool_mobile_get_public_config-the-unauthenticated-capability-probe)
   - 3.9 [Authentication error codes at the transport layer](#39-authentication-error-codes-at-the-transport-layer)
4. [Calling conventions](#4-calling-conventions)
   - 4.1 [Parameter flattening](#41-parameter-flattening)
   - 4.2 [Types, booleans, nulls, defaults, extra keys](#42-types-booleans-nulls-defaults-extra-keys)
   - 4.3 [The `moodlewssetting*` request settings](#43-the-moodlewssetting-request-settings)
   - 4.4 [The `warnings[]` convention](#44-the-warnings-convention)
   - 4.5 [Error responses and `errorcode` catalogue](#45-error-responses-and-errorcode-catalogue)
5. [File handling over web services](#5-file-handling-over-web-services)
   - 5.1 [The `pluginfile.php` URL shape](#51-the-pluginfilephp-url-shape)
   - 5.2 [Three file-serving endpoints compared](#52-three-file-serving-endpoints-compared)
   - 5.3 [Uploading: `/webservice/upload.php` and draft item ids](#53-uploading-webserviceuploadphp-and-draft-item-ids)
6. [Catalogue of external functions by domain](#6-catalogue-of-external-functions-by-domain)
   - 6.1 [How to read these tables](#61-how-to-read-these-tables)
   - 6.2 [`core_webservice`, `tool_mobile`](#62-core_webservice-tool_mobile)
   - 6.3 [`core_course`](#63-core_course)
   - 6.4 [`core_enrol`, `enrol_*`](#64-core_enrol-enrol_)
   - 6.5 [`core_user`](#65-core_user)
   - 6.6 [`core_calendar`](#66-core_calendar)
   - 6.7 [`core_completion`](#67-core_completion)
   - 6.8 [Grades: `core_grades`, `gradereport_*`](#68-grades-core_grades-gradereport_)
   - 6.9 [`core_message`, `message_*`](#69-core_message-message_)
   - 6.10 [`core_files`](#610-core_files)
   - 6.11 [`core_group`, `core_cohort`, `core_role`](#611-core_group-core_cohort-core_role)
   - 6.12 [`core_notes`, `core_comment`, `core_rating`, `core_tag`](#612-core_notes-core_comment-core_rating-core_tag)
   - 6.13 [`core_search`, `core_blog`, `core_badges`](#613-core_search-core_blog-core_badges)
   - 6.14 [`core_block`, `block_*`](#614-core_block-block_)
   - 6.15 [`core_reportbuilder`, `core_table`, `core_xapi`, misc infrastructure](#615-core_reportbuilder-core_table-core_xapi-misc-infrastructure)
   - 6.16 [`core_competency` / `tool_lp`](#616-core_competency--tool_lp)
   - 6.17 [`mod_*` entry points (names only)](#617-mod_-entry-points-names-only)
7. [Versioning, feature detection and deprecation](#7-versioning-feature-detection-and-deprecation)
   - 7.1 [`core_webservice_get_site_info.functions[].version` — what it really is](#71-core_webservice_get_site_infofunctionsversion--what-it-really-is)
   - 7.2 [Feature-detection recipe](#72-feature-detection-recipe)
   - 7.3 [Function-set diffs 3.9 → 5.0](#73-function-set-diffs-39--50)
   - 7.4 [Deprecation policy](#74-deprecation-policy)
8. [Appendix: verified request/response transcripts](#8-appendix-verified-requestresponse-transcripts)

---

## 1. Architecture: what an external function is

An **external function** is a PHP static method, described by machine-readable
parameter and return-value declarations, registered in a plugin's
`db/services.php`, and exposed through one or more **external services**. Every
transport (REST, AJAX, SOAP, the mobile batch wrapper) is a thin adapter over the
same core: `core_external\external_api::call_external_function()`.

Source of truth: `lib/external/classes/external_api.php`,
`webservice/lib.php`, `lib/db/services.php`.
Docs: <https://moodledev.io/docs/apis/subsystems/external/>

### 1.1 The three-part definition

Modern (Moodle 4.2+) style — one class per function, autoloaded from
`<component>/classes/external/<name>.php`:

```php
namespace local_groupmanager\external;

use core_external\external_api;
use core_external\external_function_parameters;
use core_external\external_value;
use core_external\external_single_structure;
use core_external\external_warnings;

class create_groups extends external_api {

    public static function execute_parameters(): external_function_parameters {
        return new external_function_parameters([
            'courseid' => new external_value(PARAM_INT, 'Course id'),
            'names'    => new \core_external\external_multiple_structure(
                new external_value(PARAM_TEXT, 'group name')
            ),
        ]);
    }

    public static function execute(int $courseid, array $names): array {
        // 1. Validate + normalise parameters. ALWAYS first.
        $params = self::validate_parameters(self::execute_parameters(),
            ['courseid' => $courseid, 'names' => $names]);

        // 2. Establish + validate the context. Sets $PAGE, theme, lang, filters.
        $context = \context_course::instance($params['courseid']);
        self::validate_context($context);

        // 3. Capability check.
        require_capability('moodle/course:managegroups', $context);

        // ... do work ...
        return ['groups' => $groups, 'warnings' => []];
    }

    public static function execute_returns(): external_single_structure {
        return new external_single_structure([
            'groups'   => new \core_external\external_multiple_structure(/* ... */),
            'warnings' => new external_warnings(),
        ]);
    }

    // Optional. Return true to mark the function deprecated.
    public static function execute_is_deprecated(): bool {
        return false;
    }
}
```

`external_function_info()` (`lib/external/classes/external_api.php:52`) looks for
exactly these four method names, derived from the `methodname`:

| Derived name | Required? | Purpose |
|---|---|---|
| `<methodname>` | yes | the implementation |
| `<methodname>_parameters` | yes | must return an `external_function_parameters` |
| `<methodname>_returns` | yes | `external_description` or `null` (void) |
| `<methodname>_is_deprecated` | no | returning `true` sets `$function->deprecated` |
| `<methodname>_is_allowed_from_ajax` | no | **deprecated**; triggers a `DEBUG_DEVELOPER` notice telling you to use `'ajax' => true` in `db/services.php` instead |

Legacy style (still all over core in 4.5): a single
`<component>/externallib.php` holding `xxx_external extends external_api` with
`get_foo_parameters()` / `get_foo()` / `get_foo_returns()`. Both styles coexist;
`external_function_info()` first tries class autoloading and only falls back to
`require_once`-ing `classpath` (or `<component>/externallib.php`).

### 1.2 `db/services.php`: the `$functions` array

The array key is the **public function name** used on the wire. Convention:
`<component>_<verb>_<noun>`, e.g. `core_course_get_contents`,
`mod_forum_get_forums_by_courses`. Frankenstyle component prefix is mandatory
for third-party plugins (`local_x_...`, `mod_x_...`).

```php
$functions = [
    'local_groupmanager_create_groups' => [
        'classname'       => 'local_groupmanager\external\create_groups',
        'methodname'      => 'execute',          // default when omitted (4.2+)
        'classpath'       => '',                 // legacy; avoid
        'description'     => 'Creates new groups.',
        'type'            => 'write',            // 'read' | 'write'
        'ajax'            => true,               // callable from /lib/ajax/service.php
        'loginrequired'   => true,               // default true
        'readonlysession' => false,              // default false
        'capabilities'    => 'moodle/course:managegroups',
        'services'        => [MOODLE_OFFICIAL_MOBILE_SERVICE],
    ],
];
```

| Key | Type | Default | Effect |
|---|---|---|---|
| `classname` | string | — | Namespaced class (autoloaded) or legacy class name |
| `methodname` | string | `execute` | Method on the class |
| `classpath` | string | `<component>/externallib.php` | Only used if the class does not autoload. Deprecated style |
| `description` | string | `null` | Human text; shown in the admin UI and the WS documentation page |
| `type` | `read`\|`write` | none | **Advisory only.** It is *not* enforced anywhere in `call_external_function()`. It drives admin-UI grouping and lets site admins reason about a service. Do not rely on it as a safety property of a call |
| `ajax` | bool | `false` | If `false`, `/lib/ajax/service.php` and `/lib/ajax/service-nologin.php` refuse the call with `servicenotavailable`. Has **no effect** on REST |
| `loginrequired` | bool | `true` | If `false`, the function may be called with no session at all — this is what makes `/lib/ajax/service-nologin.php` work. Ignored when `WS_SERVER` is true (i.e. token transports always authenticate) |
| `readonlysession` | bool | `false` | If `true` *and* `$CFG->enable_read_only_sessions` is on, the session is not opened for writing, so concurrent requests do not serialise on the session lock |
| `capabilities` | string | `''` | Comma-separated capability list. **Purely informational** — used by the admin "check user capability" screen and `webservice::get_missing_capabilities_by_users()`. It does *not* gate the call. The real check must be inside the function |
| `services` | array | `[]` | Shortnames of built-in services this function is auto-added to. In practice the only value used in core is `MOODLE_OFFICIAL_MOBILE_SERVICE` |
| `testclientpath` | string | — | Path used by the WS test client (`admin/webservice/testclient.php`) |

> **Load-bearing subtlety:** `capabilities` and `type` are metadata. The only
> things that actually gate a call are (a) whether the function is in a service
> the token is bound to, (b) `ajax`/`loginrequired` for the AJAX transports, and
> (c) `validate_context()` + `require_capability()` inside the implementation.
> Source: `lib/external/classes/external_api.php:126-167` (metadata read) and
> `:181-282` (the actual gate).

### 1.3 `db/services.php`: the `$services` array and built-in services

```php
// lib/db/services.php, tail
$services = array(
   'Moodle mobile web service'  => array(
        'functions' => array(),  // unused for core; third parties list functions here
        'enabled' => 0,
        'restrictedusers' => 0,
        'shortname' => MOODLE_OFFICIAL_MOBILE_SERVICE,
        'downloadfiles' => 1,
        'uploadfiles' => 1
    ),
);
```

`define('MOODLE_OFFICIAL_MOBILE_SERVICE', 'moodle_mobile_app');` —
`lib/moodlelib.php:555`.

| `$services` key | Meaning |
|---|---|
| `functions` | Function names in this service. Core leaves this empty and instead tags each function with `'services' => [MOODLE_OFFICIAL_MOBILE_SERVICE]` |
| `enabled` | 0/1. `moodle_mobile_app` ships **disabled**; it is enabled by the admin toggling *Enable web services for mobile devices* (`$CFG->enablemobilewebservice`) |
| `restrictedusers` | 0/1. If 1, only users listed in `external_services_users` may use it, each optionally with their own `validuntil` and `iprestriction` |
| `downloadfiles` | 0/1. Gates `/webservice/pluginfile.php` for tokens on this service |
| `uploadfiles` | 0/1. Gates `/webservice/upload.php` |
| `requiredcapability` | (DB column, settable in the UI) a system capability the user must hold to use the service at all |
| `shortname` | The string passed as `service=` to `/login/token.php` and `launch.php` |

There is exactly **one** built-in service in core: `moodle_mobile_app`. Everything
else (the classic "Create a custom service, tick the boxes" flow) is created by
the site admin at *Site administration → Server → Web services → External
services*, and its shortname is whatever the admin typed.

**Practical consequence for integrators:** on an arbitrary Moodle you cannot
assume a custom service exists. `moodle_mobile_app` is the only service you can
name blind, and it is enabled on the vast majority of sites because the mobile
app needs it. On the live 4.5.13 site the `moodle_mobile_app` service exposes
**450 functions** (176 `core_*`, 215 `mod_*`, plus `tool_*`, `gradereport_*`,
`enrol_*`, `block_*`, `message_*`, `qtype_*`, `report_*`, `aiplacement_*`, and 4
`local_intelliboard_*` from a third-party plugin). **[verified on 4.5.13]**

### 1.4 Registration lifecycle and the `external_functions` table

1. Plugin ships `db/services.php`.
2. On install/upgrade, `external_update_descriptions()` (`lib/upgradelib.php`)
   syncs `$functions` into the `external_functions` DB table and `$services`
   into `external_services`, and populates `external_services_functions` from
   each function's `services` key.
3. At call time `external_api::external_function_info($name)` does
   `$DB->get_record('external_functions', ['name' => $name], '*', MUST_EXIST)`.
   A name that is not in the table raises
   `dml_missing_record_exception` / `errorcode: invalidrecord`, message
   `"Can't find data record in database table external_functions."`
   **[verified on 4.5.13]**
4. `external_function_info()` then *re-includes* the component's
   `db/services.php` at runtime to read `description`, `type`, `ajax`,
   `loginrequired`, `readonlysession`, `testclientpath` — these are **not**
   stored in the DB, they are read from disk on every call
   (`external_api.php:126-167`).

Relevant tables (details in `data-model.md`): `external_functions`,
`external_services`, `external_services_functions`, `external_services_users`,
`external_tokens`.

### 1.5 The gate: `external_api::call_external_function()`

`lib/external/classes/external_api.php:181`. Every transport funnels through it.
Order of operations:

```
1.  external_function_info($function)                  → invalidrecord if unknown
2.  session write-lock handling (readonlysession)
3.  save $PAGE/$COURSE; create a fresh moodle_page
4.  if ($ajaxonly && !allowed_from_ajax)               → servicenotavailable
5.  if ($loginrequired && !WS_SERVER):
        if (NO_MOODLE_COOKIES)                         → servicerequireslogin
        if (!isloggedin())                             → servicerequireslogin
        else require_sesskey()                         → invalidsesskey
6.  validate_parameters(parameters_desc, $args)        → invalidparameter
7.  plugin hook: override_webservice_execution
8.  call the implementation
9.  clean_returnvalue(returns_desc, $result)           → invalidresponse
10. restore $PAGE/$COURSE
```

Returns `['error' => bool, 'data' => mixed]` or
`['error' => true, 'exception' => {...}]`. When `debugging(DEBUG_DEVELOPER)` is
off, `debuginfo` and `backtrace` are stripped from the exception before it is
returned.

Two things to internalise:

- **Step 5 is skipped entirely under `WS_SERVER`.** `webservice/rest/server.php`
  does `define('WS_SERVER', true)`, so `loginrequired` is irrelevant over REST —
  a token is always required, even for `loginrequired => false` functions.
  Confirmed: calling `tool_mobile_get_public_config` (a `loginrequired => false`
  function) over REST with an empty `wstoken` returns
  `{"errorcode":"invalidtoken"}`. **[verified on 4.5.13]**
- **Step 5 enforces `sesskey` for the AJAX transports.** A logged-in browser
  session alone is not enough; you must also send a valid `sesskey`, which is
  what makes CSRF against `/lib/ajax/service.php` hard.

### 1.6 `ajax`, `loginrequired`, `readonlysession` semantics

| Flag | REST (`WS_SERVER`) | `/lib/ajax/service.php` | `/lib/ajax/service-nologin.php` |
|---|---|---|---|
| `ajax => false` | ignored — callable | `servicenotavailable` | `servicenotavailable` |
| `ajax => true` | ignored — callable | callable | callable only if `loginrequired => false` |
| `loginrequired => true` | ignored (token auth) | session + `sesskey` required | `servicerequireslogin` (`NO_MOODLE_COOKIES` is defined) |
| `loginrequired => false` | still needs a token | callable | callable |
| `readonlysession => true` | avoids session write lock | same | same |

In `MOODLE_405_STABLE`'s `lib/db/services.php`: **392** core functions, of which
**273** are `ajax => true`, **174** are tagged into `moodle_mobile_app`, and
exactly **17** are `loginrequired => false`:

```
core_auth_confirm_user, core_auth_request_password_reset, core_auth_is_minor,
core_auth_is_age_digital_consent_verification_enabled,
core_auth_resend_confirmation_email, core_blog_get_entries,
core_blog_view_entries, core_fetch_notifications,
core_form_get_filetypes_browser_data, core_get_component_strings,
core_get_string, core_get_strings, core_output_load_template,
core_output_load_template_with_dependencies, core_output_load_fontawesome_icon_map,
core_output_load_fontawesome_icon_system_map, core_user_set_user_preferences
```

Plus, from `admin/tool/mobile/db/services.php`:
`tool_mobile_get_plugins_supporting_mobile`, `tool_mobile_get_public_config`,
`tool_mobile_validate_subscription_key`, `tool_mobile_get_tokens_for_qr_login`;
and from `admin/tool/policy/db/services.php`: `tool_policy_get_policy_version`.

Only **7** core functions declare `readonlysession => true`:
`core_calendar_get_action_events_by_timesort`,
`core_check_get_result_admintree`,
`core_course_get_enrolled_courses_with_action_events_by_timeline_classification`,
`core_enrol_get_potential_users`, `core_message_get_unread_conversations_count`,
`core_message_send_instant_messages`, `core_output_poll_stored_progress`.

> `core_user_set_user_preferences` being `loginrequired => false` looks alarming;
> it is guarded internally — it only accepts a whitelist of preferences for the
> *current* user, and the guest/not-logged-in path is limited. Its `capabilities`
> metadata claims `moodle/site:config`, which is (as always) advisory.

### 1.7 Capability checks inside functions

The mandated pattern (<https://moodledev.io/docs/apis/subsystems/external/security>):

```php
$params  = self::validate_parameters(self::execute_parameters(), [...]);
$context = context_module::instance($cm->id);   // most specific context
self::validate_context($context);               // NOT require_login()
require_capability('mod/foo:view', $context);
```

- **`validate_context()` (`external_api.php:495`) is the only correct entry
  point.** It does the access check *and* sets `$PAGE`'s context, which is what
  makes theme, language, and filters resolve correctly. Do not call
  `require_login()` in an external function — that is for page scripts — and do
  not call `$PAGE->set_context()` yourself (it emits a debugging notice).
- `validate_context()` throws `restricted_context_exception`
  (`errorcode: restrictedcontextexception`) if a `set_context_restriction()` is
  active and the requested context is outside it, and
  `invalid_parameter_exception` ("Context does not exist") for a bogus context.
- `get_context_from_params(['contextid' => N])` /
  `(['contextlevel' => 'course', 'instanceid' => N])` is the standard helper for
  functions that take a context as a parameter. Bad `contextlevel` →
  `invalid_parameter_exception('Invalid context level = ...')`.
- **Capability failures surface as `errorcode: nopermissions`** (from
  `require_capability()`) or as an entry in `warnings[]` when the function is
  bulk-oriented and chooses to degrade rather than fail (see §4.4).

### 1.8 The description language (`external_value` & friends)

Classes live in `lib/external/classes/` (namespace `core_external`); the old
global aliases in `lib/externallib.php` still work for cross-version plugins.

| Class | Wire shape |
|---|---|
| `external_value($type, $desc, $required, $default, $allownull)` | a scalar; `$type` is a `PARAM_*` constant |
| `external_single_structure(array $keys, $desc, $required, $default, $allownull)` | a JSON object with fixed keys |
| `external_multiple_structure($content, $desc, $required, $default, $allownull)` | a JSON array of `$content` |
| `external_function_parameters(array $keys)` | subclass of `external_single_structure`; the top level of a parameter list |
| `external_warnings($itemdesc, $itemiddesc, $warningcodedesc)` | the standard `warnings[]` array (§4.4) |
| `external_format_value('xxxformat')` | the companion `*format` int for a text field |
| `external_files()` | the standard file-list structure (`filename`, `filepath`, `filesize`, `fileurl`, `timemodified`, `mimetype`, `isexternalfile`, `repositorytype`) |

`VALUE_*` / `NULL_*` constants — `lib/moodlelib.php:347-367`:

```php
define('VALUE_REQUIRED', 1);
define('VALUE_OPTIONAL', 2);
define('VALUE_DEFAULT',  0);
define('NULL_NOT_ALLOWED', false);
define('NULL_ALLOWED',     true);
```

Default `$required` is `VALUE_REQUIRED` for all three description classes.
Default `$allownull` is `NULL_ALLOWED` for `external_value` but
`NULL_NOT_ALLOWED` for `external_single_structure`
(`lib/external/classes/external_value.php`,
`lib/external/classes/external_single_structure.php`).

Semantics, from `validate_parameters()` (`external_api.php:316`) and
`clean_returnvalue()` (`:405`):

| Situation | `validate_parameters` (request) | `clean_returnvalue` (response) |
|---|---|---|
| key absent, `VALUE_REQUIRED` | `invalid_parameter_exception: "Missing required key in single structure: <k>"` | `invalid_response_exception: "Error in response - Missing following required key in a single structure: <k>"` |
| key absent, `VALUE_DEFAULT` | default is injected (and itself validated) | default is injected — **only for `external_value`**, not for nested structures |
| key absent, `VALUE_OPTIONAL` | silently omitted | **silently omitted from the JSON** ← this is why response objects have inconsistent key sets between calls |
| unexpected extra key | `invalid_parameter_exception: "Unexpected keys (a, b) detected in parameter array."` | silently dropped |
| `null` with `NULL_ALLOWED` | passes through as `null` | passes through as `null` |
| `PARAM_BOOL` | accepts `true/false/0/1/'0'/'1'` only, returns a real bool | same |
| any other scalar | `validate_param($v, $type, $allownull, $debuginfo)` | same, but re-wrapped as `invalid_response_exception` |
| array where scalar expected | `"Scalar type expected, array or object received."` | same |

Nested failures are re-thrown with a breadcrumb path: `"options => timestart =>
Invalid parameter value detected"`, so `debuginfo` (when debugging is on) tells
you exactly which key failed.

### 1.9 `external_settings`: the text/file formatting singleton

`lib/external/classes/external_settings.php` — a per-request singleton that
external functions consult when formatting text and rewriting `@@PLUGINFILE@@`
placeholders.

| Property | Default in a normal page | Default under `WS_SERVER`/`AJAX_SCRIPT`/`CLI` | Request override |
|---|---|---|---|
| `raw` | `false` | `false` | `moodlewssettingraw` |
| `filter` | **`true`** | **`false`** | `moodlewssettingfilter` |
| `fileurl` | `true` | `true` | `moodlewssettingfileurl` |
| `file` | `pluginfile.php` | `webservice/pluginfile.php` | *(no request param)* |
| `lang` | `''` | `''` | `moodlewssettinglang` |
| `timezone` | `''` | `''` | `moodlewssettingtimezone` |

The constructor branches on `AJAX_SCRIPT == false && CLI_SCRIPT == false &&
WS_SERVER == false`, which is why REST responses embed
`.../webservice/pluginfile.php/...` URLs while the same field fetched over
`/lib/ajax/service.php` embeds `.../pluginfile.php/...` — `lib/ajax/service.php`
explicitly calls `$settings->set_file('pluginfile.php')` and
`$settings->set_filter(true)`.


---

## 2. Transports and endpoints

### 2.1 Endpoint map

All paths are relative to `$CFG->wwwroot`.

| Endpoint | Auth | Which functions | Notes |
|---|---|---|---|
| `/webservice/rest/server.php` | `wstoken` (or `wsusername`+`wspassword` if the "simple" auth plugin is enabled) | any function in the token's service | The endpoint you want. `moodlewsrestformat=json`\|`xml`, default **`xml`** |
| `/webservice/xmlrpc/server.php` | `wstoken` | same | **Removed in Moodle 4.1.** Present in 3.9 and 4.0; returns 404 from 4.1 onward. Confirmed 404 on the live 4.5.13 site **[verified on 4.5.13]** |
| `/webservice/soap/server.php` | `wstoken` | same | Still shipped in 4.5 and 5.0; **removed on `main` (post-5.0)**. Returns 200 on the live 4.5.13 site. Also `/webservice/soap/simpleserver.php` for username/password auth. WSDL at `?wstoken=...&wsdl=1` |
| `/lib/ajax/service.php` | Moodle session cookie **+ `sesskey`** | `ajax => true` only | `?sesskey=<sesskey>&info=<fnname>`; `info` is purely for the access log. Body is a JSON **array** of requests |
| `/lib/ajax/service-nologin.php` | none (`NO_MOODLE_COOKIES`) | `ajax => true` **and** `loginrequired => false` | Also sets `ALLOW_GET_PARAMETERS`, so `?args=<json>&cachekey=<ts>` works and can be cached for 90 days |
| `/webservice/pluginfile.php/...` | `?token=<wstoken>` | — | Serves files; requires the service to have `downloadfiles = 1` |
| `/tokenpluginfile.php/<key>/...` | `userprivateaccesskey` from `core_webservice_get_site_info` | — | User-key based, no WS token in the URL |
| `/pluginfile.php/...` | session cookie | — | The normal browser path |
| `/webservice/upload.php` | `?token=<wstoken>` | — | Multipart upload into the caller's **draft** file area; requires `uploadfiles = 1` |
| `/login/token.php` | username + password + service | — | Mints/returns a permanent token |
| `/admin/tool/mobile/launch.php` | interactive browser session | — | The app SSO flow; ends in a `<scheme>://token=<base64>` redirect |
| `/webservice/wsdoc.php` (`enablewsdocumentation`) | session, admin/token owner | — | Human-readable auto-generated docs, off by default |
| `/admin/webservice/testclient.php` | site admin session | — | The built-in test client |

### 2.2 REST: `/webservice/rest/server.php`

`webservice/rest/server.php` + `webservice/rest/locallib.php`.

```
define('NO_DEBUG_DISPLAY', true);
define('WS_SERVER', true);
$server = new webservice_rest_server(WEBSERVICE_AUTHMETHOD_PERMANENT_TOKEN);
$server->run();
```

If `webservice_protocol_is_enabled('rest')` is false the script emits a bare
`HTTP/1.0 403 Forbidden` with no body — a useful signal that REST is off on a
site even though `enablewebservices` is on.

**Request parsing** (`webservice_rest_server::parse_request()`):

```php
$methodvariables = array_merge($_GET, $_POST);
// consumed and removed: moodlewssetting{raw,fileurl,filter,lang,timezone}
// then: moodlewsrestformat, wstoken (or wsusername/wspassword), wsfunction
$this->parameters = $methodvariables;   // everything left is a function parameter
```

Consequences, all confirmed live:

- **Only `$_GET` and `$_POST` are read.** A JSON request body is *ignored
  entirely*. Posting `Content-Type: application/json` with
  `{"userid":135266}` to `core_enrol_get_users_courses` returns
  `invalidparameter` because `userid` never arrived. **[verified on 4.5.13]**
  Use `application/x-www-form-urlencoded` (or multipart), or the query string.
- GET and POST are both accepted and merged. Query string works fine for reads;
  use POST for anything long (URL length limits) or secret (tokens in query
  strings end up in access logs).
- The token can **only** be `wstoken` as a GET/POST parameter. There is no
  `Authorization` header support: sending `Authorization: <token>` yields
  `invalidtoken`. **[verified on 4.5.13]**
- Any parameter you send that the function does not declare produces
  `invalidparameter` ("Unexpected keys ... detected in parameter array") — you
  cannot smuggle extra fields. **[verified on 4.5.13]**
- **`moodlewsrestformat` defaults to `xml`.** Omit it and you get an XML
  `<RESPONSE><SINGLE><KEY name="...">` document. Always send
  `moodlewsrestformat=json`. **[verified on 4.5.13]**

Minimal call:

```bash
curl -sS "$WWWROOT/webservice/rest/server.php" \
  -d "wstoken=$TOKEN" \
  -d "moodlewsrestformat=json" \
  -d "wsfunction=core_webservice_get_site_info"
```

**Response format.** HTTP status is **200 for everything**, including errors.
Success is the function's return value serialised directly at the top level (an
object, or a bare array, or even a bare scalar). Failure is:

```json
{"exception":"core\\exception\\moodle_exception",
 "errorcode":"invalidtoken",
 "message":"Invalid token - token not found"}
```

with `debuginfo` and `reproductionlink` added when the site runs with
`DEBUG_DEVELOPER`. Note the exception class names changed in 4.5: core exceptions
moved to the `core\exception\` namespace, so `exception` is now
`"core\\exception\\moodle_exception"` /
`"core\\exception\\invalid_parameter_exception"` rather than the bare
`"moodle_exception"` / `"invalid_parameter_exception"` seen on ≤4.4.
**Match on `errorcode`, never on `exception`.** **[verified on 4.5.13]**

`message` is **localised to the site's language**, not the caller's — on a
Finnish-default site `invalidtoken` comes back as
`"Virheellinen avain - avainta ei löytynyt"`. Never parse `message`.
**[verified on 4.5.13]**

`webservice_rest_server::send_error()` sets no special status code; the XML error
form is `<EXCEPTION class="..."><ERRORCODE>...</ERRORCODE><MESSAGE>...</MESSAGE></EXCEPTION>`.

**Username/password ("simple") auth.** If the site enables the *REST protocol*
with the simple auth plugin, `WEBSERVICE_AUTHMETHOD_USERNAME` accepts
`wsusername` + `wspassword` in place of `wstoken`. Core's shipped
`/webservice/rest/server.php` hard-codes `WEBSERVICE_AUTHMETHOD_PERMANENT_TOKEN`,
so this path is only reachable via `/webservice/rest/simpleserver.php`. Errors:
`missingusername`, `missingpassword`, `wrongusernamepassword`.

### 2.3 XML-RPC and SOAP

- **XML-RPC** (`webservice/xmlrpc/`): deprecated in 3.9, **removed in 4.1**
  (MDL-70889 line of work). Endpoint returns 404 on 4.1+. Do not build against it.
- **SOAP** (`webservice/soap/`): still present in 4.5 and 5.0, removed on `main`.
  Endpoint `/webservice/soap/server.php?wstoken=<t>&wsdl=1` for the WSDL,
  `/webservice/soap/simpleserver.php` for username/password. It builds a virtual
  PHP class at runtime (`webservice_base_server::init_service_class()` +
  `generate_simple_struct_class()`), which means: parameters that are optional
  arrays raise `erroroptionalparamarray`, and optional array params with
  non-empty defaults raise `errornotemptydefaultparamarray`
  (`webservice/lib.php:1669`, `:1697`). Many modern functions therefore simply do
  not work over SOAP. **Use REST.**

### 2.4 `/lib/ajax/service.php`

This is what the Moodle web UI itself uses. Full source is ~120 lines
(`lib/ajax/service.php`); the salient bits:

```php
define('AJAX_SCRIPT', true);
define('READ_ONLY_SESSION', true);
if (!empty($_GET['nosessionupdate'])) { define('NO_SESSION_UPDATE', true); }
require_once(__DIR__ . '/../../config.php');

$settings = external_settings::get_instance();
$settings->set_file('pluginfile.php');
$settings->set_fileurl(true);
$settings->set_filter(true);
$settings->set_raw(false);

foreach ($requests as $request) {
    $methodname = clean_param($request['methodname'], PARAM_ALPHANUMEXT);
    $index      = clean_param($request['index'], PARAM_INT);
    $response   = external_api::call_external_function($methodname, $request['args'], true);
    $responses[$index] = $response;
    if ($response['error']) { ... break; }   // stop on first error
}
header('Content-Type: application/json; charset=utf-8');
echo json_encode($responses);
```

**Contract:**

```
POST /lib/ajax/service.php?sesskey=<SESSKEY>&info=<first_method_name>
Cookie: MoodleSession<sitecookie>=<sessid>
Content-Type: application/json

[{"index":0,"methodname":"core_course_get_enrolled_courses_by_timeline_classification",
  "args":{"classification":"inprogress","limit":10,"offset":0}}]
```

Response is a JSON **array**, positionally aligned with `index`:

```json
[{"error":false,"data":{...}}]
```

or

```json
[{"error":true,"exception":{"message":"...","errorcode":"servicenotavailable",
  "link":"https://site/","moreinfourl":"https://docs.moodle.org/405/en/error/webservice/servicenotavailable"}}]
```

Notes:

- `sesskey` is **not** validated by `service.php` itself; it is validated inside
  `call_external_function()` step 5 via `require_sesskey()`, and only for
  `loginrequired => true` functions. A bad sesskey on a login-required function
  yields `invalidsesskey`. `info` is metadata only (it shows up in the web
  server access log so ops can see which method a POST was for).
- Batch semantics: **processing stops at the first error** when cookies are in
  play, so the response array can be shorter than the request array. This is
  deliberate — later requests may depend on earlier ones.
- Because `NO_MOODLE_COOKIES` is *not* defined here, an unauthenticated caller
  hits `servicerequireslogin`; an `ajax => false` function hits
  `servicenotavailable` *before* any login check. On the live site, POSTing
  `core_course_get_contents` (which is `ajax => false`) with a bogus sesskey and
  no cookie returned `servicenotavailable`. **[verified on 4.5.13]**
- Only useful if you already hold a browser session (e.g. Playwright-driven
  scraping, or a plugin's own JS). For server-to-server integrations, REST.

### 2.5 `/lib/ajax/service-nologin.php`

Three lines:

```php
define('NO_MOODLE_COOKIES', true);
define('ALLOW_GET_PARAMETERS', true);
require_once('service.php');
```

So it is `service.php` with (a) no session at all and (b) GET support. Because
`NO_MOODLE_COOKIES` is defined, `call_external_function()` step 5 rejects any
`loginrequired => true` function with `servicerequireslogin`; and step 4 rejects
any `ajax => false` function with `servicenotavailable`.

Two request styles:

```bash
# POST body
curl -sS "$WWWROOT/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config" \
  -H 'Content-Type: application/json' \
  -d '[{"index":0,"methodname":"tool_mobile_get_public_config","args":{}}]'

# GET, cacheable
curl -sS -G "$WWWROOT/lib/ajax/service-nologin.php" \
  --data-urlencode 'args=[{"index":0,"methodname":"tool_mobile_get_public_config","args":{}}]' \
  --data 'info=tool_mobile_get_public_config'
```

Both verified working on the live site. **[verified on 4.5.13]**

If `cachekey` is a positive int `<= time()`, the response gets
`Cache-Control: public, max-age=7776000, immutable` (90 days) — this is how
Moodle ships its mustache templates and FontAwesome icon maps to browsers.

**This endpoint is the single most useful unauthenticated probe** for an
integration: it lets you call `tool_mobile_get_public_config` (see §3.8),
`core_get_string`/`core_get_strings`, and `core_auth_*` without any credentials.

### 2.6 Batching: `tool_mobile_call_external_functions`

`admin/tool/mobile/classes/external.php:518`. Wraps N calls in one REST
round-trip. Declared `type => write`, `ajax` not set (so REST-only), and it
**hard-requires `wstoken`** (`required_param('wstoken', PARAM_ALPHANUM)`), which
is why it cannot be used from the AJAX transports.

Parameters — `requests[i][...]`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `function` | `PARAM_ALPHANUMEXT` | required | function name |
| `arguments` | `PARAM_RAW` | `'{}'` | **JSON-encoded object** of named args |
| `settingraw` | `PARAM_BOOL` | `false` | per-request `raw` |
| `settingfilter` | `PARAM_BOOL` | `false` | per-request `filter` |
| `settingfileurl` | `PARAM_BOOL` | `true` | per-request `fileurl` |
| `settinglang` | `PARAM_LANG` | `''` | per-request language (also sets `$SESSION->lang`) |

Response:

```json
{"responses":[
  {"error":false,"data":"<json string>"},
  {"error":true,"exception":"<json string>"}
]}
```

`data` and `exception` are **JSON strings**, not objects — you must
`JSON.parse`/`json.loads` them a second time. **[verified on 4.5.13]**

Behaviour verified live:

- A function not in the token's service yields, without executing anything:
  `{"error":true,"exception":"{\"errorcode\":\"accessexception\",\"module\":\"webservice\"}"}`
  (note: `module`, not `message`, when debugging is off). **[verified on 4.5.13]**
- **Processing stops at the first error** — the `responses` array is truncated,
  so `responses.length < requests.length` means "something failed at index
  `responses.length - 1`". **[verified on 4.5.13]**
- `$_GET`/`$_POST` are cloned and restored around each inner call, because some
  external functions read superglobals directly.
- Inner argument encoding is JSON, so nested structures are natural here and you
  avoid the `options[0][name]=` flattening dance:

```bash
curl -sS "$WWWROOT/webservice/rest/server.php" \
  -d "wstoken=$T" -d "moodlewsrestformat=json" \
  -d "wsfunction=tool_mobile_call_external_functions" \
  -d "requests[0][function]=core_webservice_get_site_info" \
  -d "requests[0][arguments]={}" \
  --data-urlencode 'requests[1][function]=core_course_get_contents' \
  --data-urlencode 'requests[1][arguments]={"courseid":58849,"options":[{"name":"sectionnumber","value":"0"}]}'
```

Available since Moodle 3.7. Present unchanged in 3.9 → 5.0.

---

## 3. Authentication and tokens

### 3.1 Token model

A token is a row in `external_tokens`:

| Column | Meaning |
|---|---|
| `token` | 32 lowercase hex chars — `md5(uniqid(rand(), true))` |
| `tokentype` | `EXTERNAL_TOKEN_PERMANENT` = 0, `EXTERNAL_TOKEN_EMBEDDED` = 1 (`lib/moodlelib.php:506,514`) |
| `userid` | the user the token acts as |
| `externalserviceid` | FK to `external_services` — **the token is bound to exactly one service** |
| `sid` | for `EXTERNAL_TOKEN_EMBEDDED`, the PHP session id it is tied to; the token dies with the session |
| `contextid`, `creatorid` | audit |
| `iprestriction` | subnet spec (`address_in_subnet()` syntax) or null |
| `validuntil` | unix ts, 0 = never |
| `timecreated`, `lastaccess` | `lastaccess` is throttled to one write per `TOKEN_LASTACCESS_UPDATE_SECS = 60` |
| `privatetoken` | `random_string(64)`; **never** sent over plain HTTP nor to site admins |
| `name` | display label |

`webservice::authenticate_user($token)` (`webservice/lib.php:70`) is the single
gate for the file endpoints; `webservice_base_server::authenticate_by_token()`
(`:1147`) is the equivalent for REST/SOAP. Both walk the same checklist — see
§3.9 for the exact error each step throws.

**Tokens are bearer credentials with no scopes beyond the service.** There is no
refresh, no OAuth, no per-function grant. The blast radius of a leaked token is
"every function in that service, as that user".

### 3.2 `/login/token.php`

`login/token.php`. `AJAX_SCRIPT`, `NO_MOODLE_COOKIES`,
`Access-Control-Allow-Origin: *`.

```bash
curl -sS "$WWWROOT/login/token.php" \
  -d "username=alice" -d "password=s3cret" -d "service=moodle_mobile_app"
```

| Parameter | Type | Notes |
|---|---|---|
| `username` | `PARAM_USERNAME` | lowercased and trimmed server-side |
| `password` | `PARAM_RAW` | |
| `service` | `PARAM_ALPHANUMEXT` | service **shortname**, e.g. `moodle_mobile_app` |
| `appsitecheck` | `PARAM_INT` | if 1, short-circuits: returns `{"appsitecheck":"ok"}` and exits. Used by the app to test reachability + that WS are on. **[verified on 4.5.13]** |

Success:

```json
{"token":"a94533547ad3b4e003d07f6a0f7075d6","privatetoken":"<64 chars>"}
```

`privatetoken` is `null` unless the connection is HTTPS **and** the user is not a
site admin (`is_https() && !has_capability('moodle/site:config', system)`).

Error responses (HTTP 200, `errorcode` is the reliable field):

| `errorcode` | When |
|---|---|
| `missingparam` | any of `username`/`password`/`service` absent. `error` names the missing one. **[verified on 4.5.13]** |
| `enablewsdescription` | `$CFG->enablewebservices` is off |
| `invalidlogin` | wrong credentials — **and also** when the credentials are wrong *and* the service does not exist, because authentication runs first. **[verified on 4.5.13]** |
| `restoredaccountresetpassword` | the account came from a restore and must reset its password |
| `sitemaintenance` | site in maintenance mode and the user lacks `moodle/site:maintenanceaccess` |
| `noguest` | credentials resolved to the guest account |
| `usernotconfirmed` | `$user->confirmed` is 0 |
| `passwordisexpired` | auth plugin reports the password expired |
| `servicenotavailable` | credentials were fine but no **enabled** service has that shortname |
| `cannotcreatetoken` | no existing token and the user lacks `moodle/webservice:createtoken` (or `moodle/webservice:createmobiletoken` for `moodle_mobile_app`) |
| `usernotallowed` | service has `restrictedusers=1` and this user is not on the allow-list |
| `invalidtimedtoken` / `invalidiptoken` | the allow-list entry has expired / the caller's IP is not permitted |
| `missingrequiredcapability` | the service declares a `requiredcapability` the user lacks |

Note the ordering: **`invalidlogin` masks `servicenotavailable`.** You cannot
probe for service existence with bad credentials. **[verified on 4.5.13]**

SSO-only sites (Shibboleth, CAS, OAuth2) will return `invalidlogin` for every
attempt — there is no local password. On those sites you must use the launch
flow (§3.5). `tool_mobile_get_public_config.typeoflogin` tells you which
(§3.8).

### 3.3 Token reuse, expiry, IP restriction

`core_external\util::generate_token_for_current_user($service)`
(`lib/external/classes/util.php:336`) is used by `/login/token.php`,
`/admin/tool/mobile/launch.php` and `tool_mobile_get_tokens_for_qr_login`.
It is **idempotent-ish**, not "mint a new token every time":

1. `core_user::require_active_user($USER, true, true)` — rejects guest,
   suspended, deleted, `auth=nologin`.
2. Service `requiredcapability` check → `missingrequiredcapability`.
3. `restrictedusers` checks → `usernotallowed` / `invalidtimedtoken` /
   `invalidiptoken`.
4. Loads **all** `EXTERNAL_TOKEN_PERMANENT` tokens for `(userid, serviceid)`
   ordered by `timecreated ASC`, then drops any whose `sid` session is gone
   (deleting the row), whose `validuntil` has passed (deleting the row), or
   whose `iprestriction` excludes the caller (skipped, not deleted).
5. **If any survive, the most recent one is returned** — you get the same token
   string back on repeated logins.
6. Otherwise a new token is created, requiring
   `moodle/webservice:createmobiletoken` (for `moodle_mobile_app`) or
   `moodle/webservice:createtoken` **and `!is_siteadmin()`** for other services.
   Failure → `cannotcreatetoken`.
   `validuntil = timecreated + $CFG->tokenduration`.

`$CFG->tokenduration` is an `admin_setting_configduration` defined in
`admin/settings/security.php:135` with **default `12 * WEEKSECS` (12 weeks)**
and a minimum step of one week. So on a default site tokens silently expire
after 12 weeks and the next `/login/token.php` mints a fresh one.

> Site admins are **deliberately blocked** from auto-creating tokens for
> non-mobile services (`!is_siteadmin($USER)` in the condition at
> `util.php:412`). An admin must create their token by hand in the admin UI.

Expiry and IP behaviour at call time (`webservice/lib.php:92-112`):

- expired token → the row is **deleted** and `accessexception` is thrown with
  debuginfo `"Invalid token - token expired - check validuntil time for the
  token"`. A `\core\event\webservice_login_failed` event is logged with
  `reason: token_expired`.
- IP mismatch → `accessexception`, debuginfo
  `"Invalid token - IP:<addr> is not supported"`, `reason: ip_restricted`. The
  row is *not* deleted.

There is no token-refresh endpoint. To rotate, delete and re-mint (via
`/user/managetoken.php?action=resetwstoken&tokenid=<id>` in a browser session).

### 3.4 `/user/managetoken.php` and capabilities

`user/managetoken.php` — the "Security keys" page on a user's profile. Shown when
**all** of: not a site admin, `$CFG->enablewebservices`, and the user holds
`moodle/webservice:createtoken` **in their own user context**.

```php
if ( !is_siteadmin($USER->id)
    && !empty($CFG->enablewebservices)
    && has_capability('moodle/webservice:createtoken', $usercontext )) { ... }
```

- `?action=resetwstoken&tokenid=<id>&confirm=1&sesskey=<s>` deletes the token and
  immediately regenerates one against the same service via
  `util::generate_token($tokentype, $service, $userid, $context)`.
- `webservice::generate_user_ws_tokens($USER->id)` auto-creates tokens for every
  enabled service the user is authorised for and lacks a token for.
- The same page also shows the **RSS/calendar** user key, which is a different
  thing entirely (`user_private_key` table, not `external_tokens`).

Relevant capabilities (`lib/db/access.php`):

| Capability | Grants |
|---|---|
| `moodle/webservice:createtoken` | create a token for a non-mobile service (self-service page + `/login/token.php`) |
| `moodle/webservice:createmobiletoken` | create a token for `moodle_mobile_app` — allowed to authenticated users by default so the app works out of the box. Present since at least 3.9 |
| `moodle/webservice:managealltokens` | admin-level token management for other users |
| `webservice/rest:use`, `webservice/soap:use` | per-protocol gate; `webservice_base_server::authenticate_user()` throws `accessexception` "You are not allowed to use the rest protocol" if missing |

Site admin UI locations: *Server → Web services →* Overview / External services /
Manage tokens / Manage protocols.

### 3.5 The mobile-app SSO launch flow (`/admin/tool/mobile/launch.php`)

This is how the Moodle App gets a token on a site where the user authenticates
through SSO (Shibboleth/SAML/CAS/OAuth2) rather than a local password. It is also
the only sane way for a *third-party* app to acquire a token on such a site.

**Step 1 — discover.** Unauthenticated call to `tool_mobile_get_public_config`
(§3.8) gives you `launchurl` and `typeoflogin`.

**Step 2 — open the launch URL in a real browser** (system browser for
`typeoflogin=2`, in-app/embedded browser for `typeoflogin=3`):

```
GET /admin/tool/mobile/launch.php
      ?service=moodle_mobile_app
      &passport=<random float/string you generate>
      &urlscheme=moodlemobile            (optional, default 'moodlemobile')
      &oauthsso=<issuer id>              (optional)
      &confirmed=0                       (optional, set by the confirm flow)
```

| Param | Type | Notes |
|---|---|---|
| `service` | `PARAM_ALPHANUMEXT`, **required** | service shortname; must exist **and be enabled**, else `servicenotavailable` **[verified on 4.5.13]** |
| `passport` | `PARAM_RAW`, **required** | client-generated nonce. Missing → error page. **[verified on 4.5.13]** |
| `urlscheme` | `PARAM_NOTAGS`, default `moodlemobile` | must match `/^[a-zA-Z][a-zA-Z0-9-\+\.]*$/`, else a hard error: *"Invalid parameter: the value of urlscheme isn't valid. It should start with a letter and can only contain letters, numbers and the characters "." "+" "-"."* **[verified on 4.5.13]** |
| `confirmed` | `PARAM_BOOL` | set when returning from the account-confirmation page; makes the page render a "click here to launch the app" interstitial |
| `oauthsso` | `PARAM_INT` | OAuth2 issuer id; redirects straight to `/auth/oauth2/login.php?id=<n>&sesskey=<s>&wantsurl=<this launch url>` |

**Step 3 — the `tool_mobile_launch` cookie.** *Before* `require_login()`,
launch.php sets:

```php
$ldata = json_encode(['service' => $serviceshortname, 'passport' => $passport,
    'urlscheme' => $urlscheme, 'confirmed' => (int) $confirmed, 'oauthsso' => $oauthsso]);
setcookie('tool_mobile_launch', $ldata, time() + 15 * MINSECS,
          $CFG->sessioncookiepath, $CFG->sessioncookiedomain);
```

15-minute TTL. This survives the SSO round-trip so that auth plugins (and the
signup-confirmation flow) can bounce the user back into launch.php with the same
parameters. It is deleted immediately after `require_login()` returns.

**Step 4 — gating.** If the user is not already mid-login
(`$SESSION->justloggedin` empty), OAuth2 is not enabled, and
`tool_mobile/typeoflogin` is neither `LOGIN_VIA_BROWSER` (2) nor
`LOGIN_VIA_EMBEDDED_BROWSER` (3) → `pluginnotenabledorconfigured` (tool_mobile).
In other words, an admin must have switched the site to browser-based login (or
enabled OAuth2) for this flow to be usable at all.

If the request comes from the in-app browser (`core_useragent::is_moodle_app()`),
`Secure` and `Partitioned` are appended to the `MoodleSession` cookie —
a Moodle 4.5 addition for Chrome's CHIPS.

**Step 5 — `require_login(0, false)` + `core_user::require_active_user($USER)`.**

**Step 6 — mint the token** with `util::generate_token_for_current_user($service)`
(same reuse logic as §3.3). `privatetoken` is suppressed unless this request is
the one that just logged the user in:

```php
if (empty($SESSION->justloggedin) and $token->timecreated < $timenow) {
    $privatetoken = null;
}
```

**Step 7 — build the payload.**

```php
$siteid   = md5($CFG->wwwroot . $passport);
$apptoken = $siteid . ':::' . $token->token;
if ($privatetoken and is_https() and !$siteadmin) {
    $apptoken .= ':::' . $privatetoken;
}
$apptoken = base64_encode($apptoken);
```

So the decoded payload is:

```
md5(wwwroot + passport) ":::" token [ ":::" privatetoken ]
```

i.e. `<32 hex>:::<32 hex>` or `<32 hex>:::<32 hex>:::<64 alnum>`.

The client **must** verify `md5(wwwroot + passport)` against the passport it
generated — that is the entire anti-hijack mechanism, and passports are
single-use (the app deletes its stored passport once consumed).

> Note the doc comment says "site id" but the hash is over
> `$CFG->wwwroot . $passport`, **not** over the numeric site id. Do not confuse
> it with `siteid` from `core_webservice_get_site_info` (which is `SITEID` = 1).

**Step 8 — redirect.**

```php
$forcedurlscheme = get_config('tool_mobile', 'forcedurlscheme');
if (!empty($forcedurlscheme)) { $urlscheme = $forcedurlscheme; }
$location = "$urlscheme://token=$apptoken";
```

`$CFG->forcedurlscheme` (stored as the `tool_mobile/forcedurlscheme` config, set
at *Site administration → General → Mobile app → Mobile features → Forced URL
scheme*) **overrides whatever the client asked for**. Admins set it to lock the
site to their own branded app build; if a site has it set, your custom
`urlscheme` is ignored and the redirect goes to their scheme. There is no way to
detect this in advance from `get_public_config` — you find out when the redirect
does not come home.

Delivery differs by platform:

- **Android / everything else:** a plain `HTTP 302 Location: moodlemobile://token=...`.
- **iOS, or `confirmed=1`:** a rendered HTML page with a link
  `id="launchapp"` plus `window.onload = () => document.getElementById('launchapp').click();`
  — iOS 10+ refuses to follow a custom-scheme redirect that was not user-initiated.

The default scheme is `moodlemobile`. `moodlemobile://token=<base64>` is the URL
the app registers for.

**What this means for a non-app integration:** you can reuse the whole flow with
your own `urlscheme` (register a custom scheme, or run a loopback HTTP listener
and pass `urlscheme=http` — *not* recommended, the regex allows it but the
redirect target `http://token=...` is not a usable URL). The realistic options
are: (a) a real registered custom scheme in a desktop/mobile app, (b) driving a
headless browser and intercepting the `Location:` header before it is followed.

### 3.6 QR login

Two settings, `tool_mobile/qrcodetype`
(`admin/tool/mobile/classes/api.php:59-63`):

| Value | Constant | Meaning |
|---|---|---|
| 0 | `QR_CODE_DISABLED` | no QR code offered |
| 1 | `QR_CODE_URL` | the QR code just encodes the site URL |
| 2 | `QR_CODE_LOGIN` | the QR code encodes a one-shot login key |

Reported as `tool_mobile_qrcodetype` in `get_public_config`. The live site
reports `2`. **[verified on 4.5.13]**

**Flow for `QR_CODE_LOGIN`:**

1. A logged-in user opens their profile → *Mobile app* → QR code. Moodle calls
   `api::get_qrlogin_key($mobilesettings)` which does
   `delete_user_key('tool_mobile/qrlogin', $USER->id)` then
   `create_user_key('tool_mobile/qrlogin', $USER->id, null, $iprestriction, $validuntil)`.
   TTL = `tool_mobile/qrkeyttl` or `LOGIN_QR_KEY_TTL = 600` seconds.
   `$iprestriction = getremoteaddr()` only if `tool_mobile/qrsameipcheck` is set.
2. The QR encodes the site URL + `qrloginkey` + `userid`.
3. The app calls, **unauthenticated** (`loginrequired => false`, `ajax => true`):

```
tool_mobile_get_tokens_for_qr_login(qrloginkey: PARAM_ALPHANUMEXT, userid: PARAM_INT)
  → { token, privatetoken, warnings }
```

Server-side checks, in order (`admin/tool/mobile/classes/external.php:628`):

| Check | Error |
|---|---|
| `qrcodetype != QR_CODE_LOGIN` | `qrcodedisabled` (tool_mobile) |
| `!core_useragent::is_moodle_app()` | **`apprequired`** (tool_mobile) |
| `api::check_autologin_prerequisites($userid)` | `enablewsdescription` / `httpsrequired` / `autologinnotallowedtoadmins` |
| `validate_user_key(...)` fails/expired | `invalidkey` |
| key's `userid` ≠ param `userid` | `invalidkey` |
| `moodle_mobile_app` service missing/disabled | `servicenotavailable` |

The key is **deleted immediately** after validation (`delete_user_key`), so it is
strictly single-use. `privatetoken` is returned as `''` when absent (not null).

Available since Moodle 3.9. **[not verified]** — calling it requires a Moodle-App
user agent and a fresh key.

### 3.7 `privatetoken` and `tool_mobile_get_autologin_key`

`privatetoken` is a 64-char `random_string()` stored alongside the token. Its
*only* purpose is to prove, in a later request, that the caller is the same
client that originally obtained the token — so that the app can request a
short-lived key to seamlessly log the user into an embedded browser view.

`tool_mobile_get_autologin_key(privatetoken: PARAM_ALPHANUM)` →
`{ key, autologinurl, warnings }`.
Source: `admin/tool/mobile/classes/external.php:283`. Declared `type => write`,
`ajax` not set, mobile service only.

Restrictions, in order:

| Check | Error code |
|---|---|
| `validate_context(system)` — but `usernotfullysetup` and `forcepasswordchangenotice` are tolerated | (rethrown otherwise) |
| `!core_useragent::is_moodle_app()` | **`apprequired`** (tool_mobile) |
| `!$CFG->enablewebservices \|\| !$CFG->enablemobilewebservice` | `enablewsdescription` (webservice) |
| `!is_https()` | `httpsrequired` (tool_mobile) |
| user has `moodle/site:config` or `is_siteadmin` | `autologinnotallowedtoadmins` (tool_mobile) |
| `isset($_GET['privatetoken'])` — i.e. sent in the query string | `invalidprivatetoken` (tool_mobile) |
| empty `privatetoken` | `invalidprivatetoken` |
| **rate limit** | `autologinkeygenerationlockout` |
| no `external_tokens` row matching `(userid, token = required_param('wstoken'), privatetoken)` | `invalidprivatetoken` |

The rate limit is a per-user preference `tool_mobile_autologin_request_last`;
minimum interval is `tool_mobile/autologinmintimebetweenreq` seconds, defaulting
to `6 * MINSECS = 360`. The live site reports `tool_mobile_autologinmintimebetweenreq: "360"`
via `tool_mobile_get_config`. **[verified on 4.5.13]**

The returned `key` is created by `api::get_autologin_key()`:
`delete_user_key('tool_mobile', $USER->id)` then
`create_user_key('tool_mobile', $USER->id, null, getremoteaddr(), time() + LOGIN_KEY_TTL)`
with `LOGIN_KEY_TTL = 60` seconds. So: **single active key per user, IP-locked,
60-second life.** It is consumed at
`autologinurl` = `/admin/tool/mobile/autologin.php?userid=<id>&key=<key>&urlscheme=<scheme>`.

**Takeaway for third-party integrations:** `privatetoken` is effectively useless
to you. Both functions that consume it (`get_autologin_key`,
`get_tokens_for_qr_login`) hard-require `core_useragent::is_moodle_app()`, i.e. a
user agent containing the MoodleMobile marker. Spoofing it is possible but is
explicitly the attack the check exists to stop. Store `privatetoken` if you get
one, do not build on it.


### 3.8 `tool_mobile_get_public_config`: the unauthenticated capability probe

The single most important call when pointing an integration at an unknown Moodle.
`ajax => true`, `loginrequired => false`, so it works with **no credentials at
all** — but only through `/lib/ajax/service-nologin.php`, because REST always
demands a token.

```bash
curl -sS "$WWWROOT/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config" \
  -H 'Content-Type: application/json' \
  -d '[{"index":0,"methodname":"tool_mobile_get_public_config","args":{}}]'
```

Real response from the live 4.5.13 site (reformatted): **[verified on 4.5.13]**

```json
[{"error":false,"data":{
  "wwwroot":"https://moodle.tuni.fi",
  "httpswwwroot":"https://moodle.tuni.fi",
  "sitename":"TUNI Moodle | Tampere universities",
  "guestlogin":0,
  "rememberusername":0,
  "authloginviaemail":0,
  "registerauth":"",
  "forgottenpasswordurl":"",
  "authinstructions":"",
  "authnoneenabled":0,
  "enablewebservices":1,
  "enablemobilewebservice":1,
  "maintenanceenabled":0,
  "maintenancemessage":"<h3 ...>TUNI Moodle service break ...</h3>",
  "typeoflogin":2,
  "launchurl":"https://moodle.tuni.fi/admin/tool/mobile/launch.php",
  "mobilecssurl":"",
  "tool_mobile_disabledfeatures":"",
  "identityproviders":[{"name":"Kirjaudu TUNI tunnuksella","iconurl":"",
                        "url":"https://moodle.tuni.fi/auth/shibboleth/index.php"}],
  "country":"FI",
  "agedigitalconsentverification":false,
  "supportpage":"",
  "supportavailability":0,
  "autolang":1,
  "lang":"fi",
  "langmenu":1,
  "langlist":"",
  "locale":"",
  "tool_mobile_minimumversion":"",
  "tool_mobile_iosappid":"633359593",
  "tool_mobile_androidappid":"com.moodle.moodlemobile",
  "tool_mobile_setuplink":"",
  "tool_mobile_qrcodetype":2,
  "warnings":[],
  "showloginform":1
}}]
```

Every field, its source, and what it implies for an integration
(`admin/tool/mobile/classes/api.php:172` and
`admin/tool/mobile/classes/external.php:136`):

| Field | Source | What it tells you |
|---|---|---|
| `wwwroot` | `$CFG->wwwroot` | **Canonical base URL.** If it differs from the URL you called, follow it — all other URLs in the API are built from it |
| `httpswwwroot` | `$CFG->wwwroot` | Legacy duplicate of `wwwroot` (loginhttps was removed in 3.4). Ignore |
| `sitename` | `format_string($SITE->fullname)` | Display name, already filtered |
| `guestlogin` | `$CFG->guestloginbutton` | 1 = guest access button shown; guest users can hold tokens but almost nothing works |
| `rememberusername` | `$CFG->rememberusername` | UI hint only |
| `authloginviaemail` | `$CFG->authloginviaemail` | 1 = the user may type an email instead of a username at `/login/token.php` |
| `registerauth` | `$CFG->registerauth` | non-empty (usually `email`) ⇒ self-signup is on |
| `forgottenpasswordurl` | `clean_param($CFG->forgottenpasswordurl, PARAM_URL)` | may legitimately be a `mailto:` |
| `authinstructions` | `format_text($CFG->auth_instructions)` | HTML shown on the login screen |
| `authnoneenabled` | `(int) is_enabled_auth('none')` | 1 = the "no authentication" plugin is on (dev sites) |
| **`enablewebservices`** | `$CFG->enablewebservices` | **0 ⇒ nothing in this document works.** Bail out |
| **`enablemobilewebservice`** | `$CFG->enablemobilewebservice` | **0 ⇒ the `moodle_mobile_app` service is disabled**, so `/login/token.php?service=moodle_mobile_app` returns `servicenotavailable` and you need a custom service shortname from the admin |
| `maintenanceenabled` | `$CFG->maintenance_enabled` | 1 ⇒ every authenticated call returns `sitemaintenance` unless you hold `moodle/site:maintenanceaccess` |
| `maintenancemessage` | `format_text($CFG->maintenance_message)` | HTML |
| **`typeoflogin`** | `tool_mobile/typeoflogin`, defaulting to `LOGIN_VIA_APP` | see table below |
| **`launchurl`** | `/admin/tool/mobile/launch.php` | Always present (built unconditionally in 4.5). The SSO entry point (§3.5) |
| `mobilecssurl` | `$CFG->mobilecssurl` | Custom CSS for the app; irrelevant to non-app clients |
| **`tool_mobile_disabledfeatures`** | `tool_mobile/disabledfeatures` | Comma-separated list of app feature identifiers the admin has switched off, e.g. `CoreCourseModuleDelegate_AddonModQuiz,NoDelegate_CoreOffline,$mmSideMenuDelegate_mmaCalendar`. Identifiers come from `api::get_features_list()`. **A polite client honours these**; nothing on the server enforces them, they are pure UI policy |
| `identityproviders[]` | `auth_plugin_base::get_identity_providers()` | `{name, iconurl, url}`. **Non-empty ⇒ the site has SSO buttons.** Each `url` is a login-initiating URL. Combined with `typeoflogin` this is how you decide between password login and browser login |
| `country` | `$CFG->country` | |
| `agedigitalconsentverification` | `\core_auth\digital_consent::is_age_digital_consent_verification_enabled()` | If true, signup requires an age/consent step and `supportname`/`supportemail` are also returned |
| `supportname`, `supportemail` | `$CFG->supportname`, `$CFG->supportemail` | **Only present** when `agedigitalconsentverification` is true *or* `supportavailability == CONTACT_SUPPORT_ANYONE` |
| `supportpage` | `$CFG->supportpage` (blank unless support is public) | |
| `supportavailability` | `$CFG->supportavailability` | 0 = nobody, 1 = authenticated users, 2 = anyone |
| `autolang` | `$CFG->autolang` | 1 = detect language from the browser |
| `lang` | `clean_param($CFG->lang, PARAM_LANG)` | site default language code |
| `langmenu`, `langlist` | `$CFG->langmenu`, `$CFG->langlist` | whether a language menu is shown, and the whitelist (empty = all installed) |
| `locale` | `$CFG->locale` | |
| `tool_mobile_minimumversion` | `tool_mobile/minimumversion` | Minimum app version the admin will accept. Non-empty ⇒ older clients are told to upgrade |
| `tool_mobile_iosappid` | default `633359593` | App Store id |
| `tool_mobile_androidappid` | default `com.moodle.moodlemobile` | Play package. **Non-default values mean a custom-branded app build**, which usually also means `forcedurlscheme` is set (§3.5) |
| `tool_mobile_setuplink` | `tool_mobile/setuplink` | Where to send users to install the app |
| **`tool_mobile_qrcodetype`** | `tool_mobile/qrcodetype` | 0 disabled / 1 URL only / 2 QR login enabled (§3.6) |
| `logourl`, `compactlogourl` | `$OUTPUT->get_logo_url()` | `VALUE_OPTIONAL` — absent if the theme returns nothing |
| `showloginform` | `get_config('core','showloginform')` | 0 ⇒ the username/password form is hidden and only SSO buttons are offered. Strong signal that `/login/token.php` will not work for real users |
| `warnings` | standard | |

**`typeoflogin` values.** Constants are in `admin/tool/mobile/classes/api.php:47-51`
and are mirrored in the Moodle App as `TypeOfLogin`
(`src/core/classes/sites/unauthenticated-site.ts`):

| Value | Constant | Meaning |
|---|---|---|
| **1** | `LOGIN_VIA_APP` | The client collects username+password itself and calls `/login/token.php`. Default when the setting is unset |
| **2** | `LOGIN_VIA_BROWSER` | Open `launchurl` in the **system browser**; the token comes back via the custom URL scheme |
| **3** | `LOGIN_VIA_EMBEDDED_BROWSER` | Same, but in an **in-app / embedded** browser |

> **There is no value 6.** Moodle core defines only 1, 2 and 3 in both
> `MOODLE_405_STABLE` and `MOODLE_500_STABLE`, and the Moodle App's `TypeOfLogin`
> enum on `main` likewise defines only `APP = 1`, `BROWSER = 2`, `EMBEDDED = 3`.
> The app treats *anything that is not 2 or 3* as "in-app login"
> (`isSSOLoginNeeded(code) => code === BROWSER || code === EMBEDDED`). If you see
> a 6 in the wild it is a site-local hack or a stale note — handle unknown values
> by falling back to `LOGIN_VIA_APP` behaviour, exactly as the app does.

**Decision table for "how do I log in to this site?"**

```
config = tool_mobile_get_public_config()

if !config.enablewebservices:                      → impossible, stop
if config.maintenanceenabled:                      → retry later
if config.typeoflogin in (2, 3) or !config.showloginform or config.identityproviders:
                                                   → browser flow via config.launchurl  (§3.5)
else:                                              → POST /login/token.php with
                                                     service = 'moodle_mobile_app'
                                                     (only if enablemobilewebservice == 1)
```

### 3.9 Authentication error codes at the transport layer

`webservice::authenticate_user()` (`webservice/lib.php:70`) and
`webservice_base_server::authenticate_by_token()` (`:1147`), in execution order:

| # | Condition | `errorcode` | debuginfo (only with DEBUG_DEVELOPER) |
|---|---|---|---|
| 1 | `!$CFG->enablewebservices` | `accessexception` | "Web services are not enabled in Advanced features." |
| 2 | token row not found | **`invalidtoken`** | — (message: "Invalid token - token not found") |
| 3 | `validuntil` passed | `accessexception` | "Invalid token - token expired - check validuntil time for the token" (row deleted) |
| 4 | `iprestriction` mismatch | `accessexception` | "Invalid token - IP:\<addr\> is not supported" |
| 5 | `sid` set but session gone | `accessexception` | "Invalid session based token - session not found or expired" |
| 6 | maintenance mode, no `moodle/site:maintenanceaccess` | `sitemaintenance` | — |
| 7 | service row missing or `enabled = 0` | `accessexception` | "Web service is not available (it doesn't exist or might be disabled)" |
| 8 | service `requiredcapability` not held | `accessexception` | "The capability \<cap\> is required." |
| 9 | `restrictedusers` and user not on the allow-list | `accessexception` | "The user is not allowed for this service. ..." |
| 10 | allow-list entry `validuntil` passed | `accessexception` | "Invalid service - service expired - ..." |
| 11 | allow-list entry `iprestriction` mismatch | `accessexception` | "Invalid service - IP:\<addr\> is not supported - check this allowed user" |
| 12 | `!$user->confirmed` | `usernotconfirmed` | |
| 13 | `$user->suspended` | `wsaccessusersuspended` | |
| 14 | `$user->auth == 'nologin'` | `wsaccessusernologin` | |
| 15 | password expired | `passwordisexpired` | |
| 16 | protocol capability `webservice/rest:use` missing | `accessexception` | "You are not allowed to use the rest protocol ..." |
| 17 | function not in any service the token/user may use | `accessexception` | a long 7-point explanation listing the possible causes (`webservice/lib.php:1462`) |

The practical shape of this: **`invalidtoken` means "wrong/unknown token";
everything else about tokens, services and users collapses into
`accessexception`.** With debugging off you get only
`{"exception":"webservice_access_exception","errorcode":"accessexception",
"message":"Access control exception"}` and must guess. **[verified on 4.5.13]**

`\core\event\webservice_login_failed` is logged with
`other.reason ∈ {invalid_token, token_expired, ip_restricted, user_unconfirmed,
user_suspended, nologin, password_expired}` — ask a site admin to check the
report if you are stuck.

---

## 4. Calling conventions

### 4.1 Parameter flattening

REST has no native nesting, so structured parameters are expressed with PHP's
bracket syntax in `application/x-www-form-urlencoded` (or query-string) form.
`array_merge($_GET, $_POST)` gives PHP's parser a normal nested array.

| Declared shape | Wire form |
|---|---|
| `external_value(PARAM_INT)` named `courseid` | `courseid=5` |
| `external_multiple_structure(external_value(PARAM_INT))` named `courseids` | `courseids[0]=5&courseids[1]=7` |
| `external_multiple_structure(external_single_structure([...]))` named `options` | `options[0][name]=excludecontents&options[0][value]=1` |
| `external_single_structure([...])` named `options` | `options[timestart]=1780000000&options[siteevents]=0` |
| nested: `events[courseids][]` | `events[courseids][0]=58849` |

Verified live:

```bash
# array of scalars — indices REQUIRED
core_user_get_users_by_field  field=id  values[0]=135266                  # OK
core_user_get_users_by_field  field=id  values=135266                     # invalidparameter

# array of objects
core_course_get_contents  courseid=58849 \
    options[0][name]=sectionnumber  options[0][value]=0                   # OK  → 1 section

# single structure with named keys
core_calendar_get_calendar_events \
    events[courseids][0]=58849  options[timestart]=1780000000 \
    options[siteevents]=0  options[userevents]=0                          # OK
```

**[verified on 4.5.13]**

Rules and gotchas:

- **Indices are mandatory for multiple structures.** `values=1` is a scalar, not
  an array, and fails `validate_parameters` immediately. Bare `values[]=1` also
  works in PHP but is less explicit; prefer explicit indices.
- Indices must be integers but need not be contiguous or ordered; PHP will build
  a keyed array and `validate_parameters` iterates values, discarding keys.
- **Unknown keys are fatal at the top level and inside every
  `external_single_structure`** — `"Unexpected keys (bogusparam) detected in
  parameter array."` Adding `limitnum` to `core_calendar_get_calendar_events`'s
  `options` (which has no such key) fails the whole call. **[verified on 4.5.13]**
- **Many functions have a *second*, hand-rolled whitelist** for `options[].name`
  or `field` values, which throws a different error. e.g.
  `core_course_get_contents` with `options[0][name]=bogus` returns
  `{"errorcode":"errorinvalidparam","message":"The param \"bogus\" is invalid."}`
  — not `invalidparameter`. **[verified on 4.5.13]**
  (`course/externallib.php`, the `switch ($name)` in `get_course_contents`.)
- **Prefer `tool_mobile_call_external_functions` when the structure is deep** —
  its `arguments` field is JSON, sidestepping the whole flattening problem
  (§2.6).
- The AJAX endpoints take a JSON body, so flattening never applies there.

### 4.2 Types, booleans, nulls, defaults, extra keys

| Concern | Behaviour |
|---|---|
| **Booleans** | `PARAM_BOOL` accepts **only** `0`, `1`, `'0'`, `'1'` (and real PHP bools, which REST can't send). `returnusercount=false` → `invalidparameter`; `returnusercount=2` → `invalidparameter`; `returnusercount=0` and `=1` work. **[verified on 4.5.13]** Booleans come *back* as real JSON `true`/`false` |
| **Nulls** | You cannot send `null` over form-encoded REST. An empty value is an empty string, which fails `PARAM_INT`/`PARAM_FLOAT` etc. `timesortto=` on `core_calendar_get_action_events_by_timesort` → `invalidparameter`, even though the parameter is declared `VALUE_DEFAULT, null`. **Omit the parameter entirely to get its default.** **[verified on 4.5.13]** Over `tool_mobile_call_external_functions` you *can* send JSON `null` |
| **Defaults** | Omitted `VALUE_DEFAULT` keys are filled in server-side and the default is itself validated. Omitted `VALUE_OPTIONAL` keys are simply absent |
| **Required** | Omitted `VALUE_REQUIRED` key → `invalidparameter` ("Missing required key in single structure: x") |
| **Extra keys** | Fatal (see §4.1) |
| **Ordering** | Irrelevant; `validate_parameters` re-sorts into declaration order before `call_user_func_array` |
| **Case** | Function names are `clean_param(..., PARAM_ALPHANUMEXT)` on the AJAX path; over REST the name is matched against the DB verbatim — use exact lowercase |
| **Response nulls** | `NULL_ALLOWED` fields come back as JSON `null` (e.g. `progress: null`, `completed: null` in `core_enrol_get_users_courses` for a course without completion). Do not assume a key's type is stable |
| **Response ints** | Some functions return numeric strings rather than ints — e.g. `core_grades_get_gradeitems` returns `"id":"637581"` (a string) because it is declared `PARAM_RAW`/`PARAM_TEXT`. **[verified on 4.5.13]** Coerce defensively |
| **Response key casing** | Usually snake_case/lowercase, but not always: `core_grades_get_gradeitems` returns the top-level key **`gradeItems`** (camelCase). **[verified on 4.5.13]** |

Common `PARAM_*` types you will meet in parameter declarations:
`PARAM_INT`, `PARAM_FLOAT`, `PARAM_BOOL`, `PARAM_ALPHA`, `PARAM_ALPHANUM`,
`PARAM_ALPHANUMEXT`, `PARAM_TEXT`, `PARAM_RAW`, `PARAM_CLEANHTML`, `PARAM_NOTAGS`,
`PARAM_SAFEDIR`, `PARAM_PATH`, `PARAM_FILE`, `PARAM_URL`, `PARAM_LOCALURL`,
`PARAM_EMAIL`, `PARAM_USERNAME`, `PARAM_LANG`, `PARAM_TIMEZONE`, `PARAM_THEME`,
`PARAM_COMPONENT`, `PARAM_PLUGIN`, `PARAM_AREA`, `PARAM_SEQUENCE` (comma-separated
ints — used by `core_course_get_courses_by_field` with `field=ids`).

### 4.3 The `moodlewssetting*` request settings

Intercepted and removed from the parameter list by
`webservice_server::set_web_service_call_settings()` (`webservice/lib.php:1205`).
They apply to **REST and SOAP only** (the AJAX endpoints hard-code their own
values; `tool_mobile_call_external_functions` has per-request equivalents).

| Parameter | Type | REST default | Effect |
|---|---|---|---|
| `moodlewssettingraw` | `PARAM_BOOL` | `0` | `1` = return the **raw** DB text without running `format_text()`. `@@PLUGINFILE@@` placeholders are *not* rewritten and the accompanying `*format` field tells you the format (0 MOODLE, 1 HTML, 2 PLAIN, 4 MARKDOWN). Use this if you intend to render/store the source yourself |
| `moodlewssettingfilter` | `PARAM_BOOL` | **`0`** | `1` = run the site's text **filters** (MathJax, multilang, media embedding, glossary auto-linking…). Off by default over WS, which is the opposite of a normal page render. Turn it on if you want what a browser would see |
| `moodlewssettingfileurl` | `PARAM_BOOL` | `1` | `1` = rewrite `@@PLUGINFILE@@` to absolute URLs. `0` = leave the placeholders. Only affects **embedded** text; the separate `fileurl` fields in file structures are always absolute |
| `moodlewssettinglang` | `PARAM_LANG` | `''` | Language for all server-generated strings in the response. Invalid codes are silently dropped by `PARAM_LANG` and you get the site default |
| `moodlewssettingtimezone` | `PARAM_TIMEZONE` | `''` | Timezone for date formatting inside the request. Added in Moodle 4.0 |

Verified live on `core_course_get_contents` for one section's
`modules[].modplural`: **[verified on 4.5.13]**

```
(no setting)                → ["Forums", "Pages", "URLs"]
moodlewssettinglang=fi      → ["Keskustelualueet", "Sivut", "Verkko-osoitteet"]
moodlewssettinglang=zz      → ["Forums", "Pages"]        (invalid → site default)
```

> There is **no** `moodlewssettingfile` request parameter. The `file` setting
> (`pluginfile.php` vs `webservice/pluginfile.php`) is decided by the transport,
> not by the caller. This is why REST responses always give you
> `webservice/pluginfile.php` URLs, which need `?token=` appended (§5).

### 4.4 The `warnings[]` convention

`core_external\external_warnings` (`lib/external/classes/external_warnings.php`).
Bulk-oriented functions do **not** fail the whole call when one item is
inaccessible; they skip it and append a warning:

```php
new external_multiple_structure(
    new external_single_structure([
        'item'        => new external_value(PARAM_TEXT, 'item', VALUE_OPTIONAL),
        'itemid'      => new external_value(PARAM_INT, 'item id', VALUE_OPTIONAL),
        'warningcode' => new external_value(PARAM_ALPHANUM, '...'),   // REQUIRED
        'message'     => new external_value(PARAM_RAW, 'untranslated english message ...'),
    ], 'warning'),
    'list of warnings',
    VALUE_OPTIONAL
)
```

Live examples: **[verified on 4.5.13]**

```json
// core_course_get_courses_by_field field=ids value=49939, user not enrolled
"warnings":[{"item":"course","itemid":49939,"warningcode":"1",
             "message":"No access rights in course context"}]

// core_calendar_get_calendar_events with a non-existent course id
"warnings":[{"item":"course","itemid":999999,"warningcode":"nopermissions",
             "message":"No access rights in course context Can't find data record ..."}]
```

Rules to code against:

- `warnings` is `VALUE_OPTIONAL`, so **the key may be absent entirely.** Default
  it to `[]`.
- `warningcode` is `PARAM_ALPHANUM` and is **not standardised**. Some functions
  use symbolic codes (`nopermissions`, `couldnotdeletewarning`,
  `cannotviewreport`), some use bare digits (`"1"`). Treat it as an opaque
  per-function enum.
- `message` is described in core as "untranslated english message" but in
  practice it is `get_string()`-derived and **may be localised, and may carry a
  stack trace** when the site has debugging on (see the second example above).
- **A response with warnings is still HTTP 200 with `error: false`.** If you need
  completeness guarantees you must inspect `warnings` yourself — silently missing
  courses/users are the number-one source of "why is my sync incomplete".

### 4.5 Error responses and `errorcode` catalogue

Every transport returns **HTTP 200** for application-level failures. Detect
failure by:

| Transport | Failure marker |
|---|---|
| REST/JSON | the top-level object has an `exception` key |
| REST/XML | the document is `<EXCEPTION class="...">` |
| `/lib/ajax/service*.php` | `response[i].error === true`, details in `response[i].exception` |
| `tool_mobile_call_external_functions` | `responses[i].error === true`, `responses[i].exception` is a **JSON string** |

Shape (REST/JSON):

```json
{
  "exception": "core\\exception\\invalid_parameter_exception",
  "errorcode": "invalidparameter",
  "message": "Invalid parameter value detected",
  "debuginfo": "...",              // only with DEBUG_DEVELOPER
  "reproductionlink": "https://…"  // only with DEBUG_DEVELOPER
}
```

Shape (AJAX) adds `link` and `moreinfourl`
(`https://docs.moodle.org/405/<lang>/error/<module>/<errorcode>`) — the
`moreinfourl` is a handy way to learn the Moodle version and language of a site.

**Catalogue of the codes you will actually hit:**

| `errorcode` | Exception class (4.5) | Meaning / typical cause |
|---|---|---|
| `invalidtoken` | `core\exception\moodle_exception` | `wstoken` missing, malformed, or no matching `external_tokens` row. **[verified]** |
| `accessexception` | `webservice_access_exception` | Catch-all: token expired, IP restricted, service disabled, function not in the service, protocol capability missing, restricted-user list. Message is always `"Access control exception"` **[verified]** |
| `servicenotavailable` | `core\exception\moodle_exception` | (a) AJAX endpoint + `ajax => false` function; (b) `/login/token.php` or `launch.php` with a service shortname that does not exist or is disabled. **[verified]** |
| `servicerequireslogin` | `core\exception\moodle_exception` | AJAX endpoint, `loginrequired => true`, no session (or `NO_MOODLE_COOKIES`) |
| `invalidsesskey` | `core\exception\moodle_exception` | `/lib/ajax/service.php` without a valid `sesskey` for a login-required function |
| `invalidparameter` | `core\exception\invalid_parameter_exception` | Missing required param, wrong scalar type, unexpected extra key, array-vs-scalar mismatch. Also what you get when `wsfunction` itself is missing. **[verified]** |
| `invalidrecord` | `dml_missing_record_exception` | Unknown `wsfunction` name (`"Can't find data record in database table external_functions."`), and also many "id does not exist" cases inside functions. **[verified]** |
| `invalidresponse` | `invalid_response_exception` | Server-side bug: the function returned something its `_returns()` does not describe. Report to the site admin |
| `nopermissions` | `required_capability_exception` | `require_capability()` failed. `message` names the capability |
| `requireloginerror` | `require_login_exception` | Raised by `validate_context()` → `require_login()` chain: not enrolled, activity hidden, course not visible, guest access denied |
| `restrictedcontextexception` | `restricted_context_exception` | `set_context_restriction()` active and the target context is outside it (embedded-token scenarios) |
| `errorinvalidparam` | `core\exception\moodle_exception` (webservice) | A function's own `options[].name` / mode whitelist rejected a value. **[verified]** |
| `sitemaintenance` | `core\exception\moodle_exception` (admin) | Site in maintenance mode |
| `enablewsdescription` | `core\exception\moodle_exception` (webservice) | `$CFG->enablewebservices` is off |
| `missingparam` | (AJAX-script error json) | `/login/token.php` or `/webservice/upload.php` missing a required GET/POST param. **[verified]** |
| `invalidlogin` | `core\exception\moodle_exception` | `/login/token.php` credentials rejected. **[verified]** |
| `usernotconfirmed`, `wsaccessusersuspended`, `wsaccessusernologin`, `wsaccessuserdeleted`, `wsaccessuserunconfirmed`, `wsaccessuserexpired`, `passwordisexpired`, `noguest` | | Account-state rejections at authentication time (§3.9) |
| `cannotcreatetoken`, `usernotallowed`, `invalidtimedtoken`, `invalidiptoken`, `missingrequiredcapability`, `nocapabilitytousethisservice` | | Token-minting rejections (§3.3) |
| `apprequired`, `invalidprivatetoken`, `autologinkeygenerationlockout`, `autologinnotallowedtoadmins`, `httpsrequired`, `qrcodedisabled`, `invalidkey` | tool_mobile | Autologin / QR restrictions (§3.6, §3.7) |
| `globalsearchdisabled` | `core\exception\moodle_exception` | `core_search_*` on a site without global search. **[verified]** |
| `coding_error` / `codingerror` | `coding_exception` | Server-side bug or a deliberately-thrown "invalid field parameter" (e.g. `core_user_get_users_by_field` with an unsupported `field`) |

**Never branch on `exception` or `message`.** The class names moved into
`core\exception\` in 4.5, and `message` is localised to the site language.
`errorcode` is the stable contract.

---

## 5. File handling over web services

Deep Files-API internals (`mdl_files`, contenthash, file areas, draft areas) live
in `data-model.md`. This section covers only the WS surface.

### 5.1 The `pluginfile.php` URL shape

```
/pluginfile.php/<contextid>/<component>/<filearea>/<itemid>/<filepath><filename>
```

- `<contextid>` — numeric context id (`context_module::instance($cmid)->id` for
  activity files, `context_course` for course files, `context_user` for private
  and draft files).
- `<component>` — Frankenstyle, e.g. `mod_resource`, `mod_folder`, `course`,
  `user`, `mod_assign`.
- `<filearea>` — e.g. `content`, `intro`, `overviewfiles`, `private`, `draft`,
  `submission_files`.
- `<itemid>` — 0 when the area has no item dimension; otherwise the record id
  (or draft item id).
- `<filepath>` — always starts and ends with `/`, e.g. `/` or `/subdir/`.

Some areas omit `<itemid>` from the URL entirely (Moodle knows which do); this is
why you should **never construct these URLs yourself**. Take the `fileurl` the
API hands you and only append the token.

Query parameters honoured by `pluginfile.php`:

| Param | Effect |
|---|---|
| `forcedownload=1` | send `Content-Disposition: attachment` |
| `preview=thumb`\|`bigthumb`\|`tinyicon`… | serve a generated preview instead of the original |
| `offline=1` | for external-repository files, export and serve the content instead of redirecting |

### 5.2 Three file-serving endpoints compared

| | `/pluginfile.php` | `/webservice/pluginfile.php` | `/tokenpluginfile.php` |
|---|---|---|---|
| Auth | `MoodleSession` cookie | `?token=<wstoken>` (**query param only**) | `userprivateaccesskey` as the **first path segment** |
| Cookies | required | `NO_MOODLE_COOKIES` | `NO_MOODLE_COOKIES` |
| Extra gate | normal capability checks | service must have `downloadfiles = 1`, else `accessexception` | `require_user_key_login('core_files', null, $token)` |
| `forcedownload` | honoured | **forced to 0** — `file_pluginfile($relativepath, 0, $preview, $offline)` hard-codes it | honoured (it delegates to `pluginfile.php`) |
| `preview`, `offline` | yes | yes (`PARAM_ALPHANUM`, `PARAM_BOOL`) | yes |
| CORS | no | `Access-Control-Allow-Origin: *`, `Allow-Headers: range`, `Expose-Headers: Content-Range` | same |
| Where the URL comes from | `moodlewssettingfileurl` under a browser render | any `fileurl` in a REST response | you build it |

Verified live: **[verified on 4.5.13]**

```bash
# fileurl straight out of core_course_get_courses_by_field
U="$WWWROOT/webservice/pluginfile.php/5074700/course/overviewfiles/data100.jpg"

curl -o/dev/null -w'%{http_code} %{content_type}\n' "$U"
  → 200 application/json   ...but the body is
     {"error":"...","errorcode":"missingparam",...}     # token is required

curl -o/dev/null -w'%{http_code} %{content_type} %{size_download}\n' "$U?token=$T"
  → 200 image/jpeg 139362                               # works

curl -H "Authorization: $T" "$U"
  → {"errorcode":"invalidtoken",...}                    # header auth NOT supported

curl -D- "$U?token=$T&forcedownload=1" | grep -i content-disposition
  → Content-Disposition: inline; filename="data100.jpg" # forcedownload IGNORED

curl "$U?token=deadbeef"
  → {"error":"...","errorcode":"invalidtoken","stacktrace":null,"debuginfo":null,
     "reproductionlink":null}
```

Note that `/webservice/pluginfile.php` errors are `AJAX_SCRIPT` JSON with an
`error` key (not `message`), which is a *different* error envelope from
`/webservice/rest/server.php`.

**`tokenpluginfile.php`** exists so you do not have to put a full WS token in an
`<img src>`. Get the key from `core_webservice_get_site_info.userprivateaccesskey`
(it is `get_user_key('core_files', $USER->id)`), then:

```
/tokenpluginfile.php/<userprivateaccesskey>/<contextid>/<component>/<filearea>/<itemid>/<path>
```

Verified: this returns `200 image/jpeg`. The `?token=` **query** form returns
**404** — because of this loose comparison in `tokenpluginfile.php`:

```php
$relativepath = get_file_argument();
$token = optional_param('token', '', PARAM_ALPHANUM);
if (0 == strpos($relativepath, '/token/')) {   // strpos returns false; 0 == false is TRUE
    $pathparts = explode('/', ltrim($relativepath, '/'), 2);
    $token = clean_param($pathparts[0], PARAM_ALPHANUM);
    $relativepath = "/{$pathparts[1]}";
}
require_user_key_login('core_files', null, $token);
require_once('pluginfile.php');
```

The branch fires for **every** path that does not literally contain `/token/`, so
the first path segment is always eaten as the key. **Always use the path form.**
**[verified on 4.5.13]**

**Which URL do you get back?** Under REST, `external_settings::$file` is
`webservice/pluginfile.php`, so every `fileurl` in a `external_files()` structure
already points there and you only need to append `?token=`. But **not every URL
in a response goes through that machinery** — e.g. in
`core_course_get_courses_by_field` the `overviewfiles[].fileurl` is
`.../webservice/pluginfile.php/...` while the sibling `courseimage` field is
`.../pluginfile.php/...` (it is built by course-image code, not by the files
formatter). **[verified on 4.5.13]** Check each field; when in doubt, rewrite
`(^|/)pluginfile\.php/` → `/webservice/pluginfile.php/` and append the token.

Also note that theme-served images (`/theme/image.php/...`, used for
`userpictureurl`, `profileimageurl`, `modicon`) are **public** and need no token.

### 5.3 Uploading: `/webservice/upload.php` and draft item ids

`webservice/upload.php`. `AJAX_SCRIPT`, `NO_MOODLE_COOKIES`, CORS `*`.

```bash
curl -sS "$WWWROOT/webservice/upload.php" \
  -F "token=$TOKEN" \
  -F "filepath=/" \
  -F "itemid=0" \
  -F "file_1=@/local/path/report.pdf"
```

| Param | Type | Default | Notes |
|---|---|---|---|
| `token` | `PARAM_ALPHANUM`, required | — | missing → `{"errorcode":"missingparam"}` **[verified on 4.5.13]** |
| `filepath` | `PARAM_PATH` | `/` | directory inside the draft area |
| `itemid` | `PARAM_INT` | `0` | **0 or negative ⇒ a fresh draft item id is allocated** via `file_get_unused_draft_itemid()`. Pass a previously returned id to add more files to the same draft area across requests |
| `<anything>` (file fields) | — | — | Every entry in `$_FILES` is uploaded. Field names are arbitrary (`file_1`, `file_2`, …) |

Everything lands in `context_user::instance($USER->id)` / `component = 'user'` /
`filearea = 'draft'` / the chosen `itemid`.

Preconditions: service `uploadfiles = 1` (else `accessexception` "Web service
file upload must be enabled in external service settings"); antivirus scan
(`\core\antivirus\manager::scan_file`); `$CFG->maxbytes`; and
`get_user_max_upload_file_size()` against the user's quota
(`file_exception` / `userquotalimit` if the batch total exceeds it).

**Response** is a JSON array, one entry per file:

```json
[{"component":"user","contextid":123,"userid":42,"filearea":"draft",
  "filename":"report.pdf","filepath":"/","itemid":987654321,
  "license":"allrightsreserved","author":"Alice Smith","source":"...","filesize":10432}]
```

Per-file failures do **not** fail the request; they appear as entries with
`errortype` + `error`:

| `errortype` | Cause |
|---|---|
| `fileoversized` | file bigger than `$CFG->maxbytes` |
| `filenameexist` | a file with that name already exists in the draft area |

Whole-request failures raise `moodle_exception`s from
`repository_upload` (`upload_error_ini_size`, `upload_error_form_size`,
`upload_error_partial`, `upload_error_no_file`, `upload_error_no_tmp_dir`,
`upload_error_cant_write`, `upload_error_extension`) or `nofile`.

**Then hand the `itemid` to a save function.** Standard pattern:

| Target | Function | Draft param |
|---|---|---|
| user private files | `core_user_add_user_private_files` | `draftid` |
| user profile picture | `core_user_update_picture` | `draftitemid` (+ `delete`, `userid`) |
| assignment submission | `mod_assign_save_submission` | `plugindata[files_filemanager]` |
| forum post attachments | `mod_forum_add_discussion` / `add_discussion_post` | `options[0][name]=attachmentsid` |
| glossary entry | `mod_glossary_add_entry` | `options[].name = 'attachmentsid'` / `'inlineattachmentsid'` |
| data entry | `mod_data_add_entry` | per-field `field_<id>_file` |
| wiki page | `mod_wiki_edit_page` | — (uses `mod_wiki_get_page_for_editing` first) |

Helpers: `core_files_get_unused_draft_itemid()` (`type => write`) allocates an id
without uploading anything; `core_files_delete_draft_files(draftitemid, files[])`
cleans up.

**[not verified]** — all upload/save paths are writes.


---

## 6. Catalogue of external functions by domain

### 6.1 How to read these tables

- **R/W** — the declared `type` in `db/services.php`. Advisory (§1.2) but a good
  smell test. `view_*` functions are `write` because they log a viewed event.
- **AJ** — `ajax => true`, i.e. callable from `/lib/ajax/service.php`.
- **M** — included in the `moodle_mobile_app` service, i.e. reachable with a
  standard mobile token. **If this column is blank, a `moodle_mobile_app` token
  cannot call it** and you need a custom service.
- Parameter lists are the top-level keys from `*_parameters()` in
  `MOODLE_405_STABLE`. `[d=x]` = `VALUE_DEFAULT x`; `[opt]` = `VALUE_OPTIONAL`;
  otherwise required.
- Flags and metadata were extracted from `lib/db/services.php`,
  `admin/tool/*/db/services.php`, `grade/report/*/db/services.php`,
  `enrol/*/db/services.php`, `blocks/*/db/services.php`,
  `message/output/*/db/services.php` on `MOODLE_405_STABLE`.

### 6.2 `core_webservice`, `tool_mobile`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `core_webservice_get_site_info` | read | | Y | `serviceshortnames[]` **(deprecated, ignored)** |
| `tool_mobile_get_public_config` | read | Y | Y | — (`loginrequired => false`) |
| `tool_mobile_get_config` | read | | Y | `section` `[d='']` |
| `tool_mobile_get_plugins_supporting_mobile` | read | Y | Y | — (`loginrequired => false`) |
| `tool_mobile_get_content` | read | | Y | `component`, `method`, `args[][{name,value}]` `[opt]` |
| `tool_mobile_call_external_functions` | write | | Y | `requests[]` (§2.6) |
| `tool_mobile_get_autologin_key` | write | | Y | `privatetoken` |
| `tool_mobile_get_tokens_for_qr_login` | read | Y | Y | `qrloginkey`, `userid` (`loginrequired => false`) |
| `tool_mobile_validate_subscription_key` | write | Y | Y | `key` (`loginrequired => false`) |

**`core_webservice_get_site_info`** is the handshake. It requires only a valid
token, does no capability checks, and returns
(`webservice/externallib.php`, `get_site_info()`):

| Field | Meaning |
|---|---|
| `sitename`, `siteurl`, `siteid` | site identity; `siteid` is always `SITEID` (1) |
| `username`, `firstname`, `lastname`, `fullname`, `userid`, `userpictureurl`, `lang` | the token's user |
| `functions[]` | `{name, version}` for **every function in the token's service** — the definitive capability list. See §7.1 |
| `release`, `version` | e.g. `"4.5.13 (Build: 20260810)"`, `"2024100713"`. **Only returned when a `wstoken` was used** |
| `downloadfiles`, `uploadfiles` | the service's flags — whether §5 endpoints will work |
| `advancedfeatures[]` | `{name, value}` for `usecomments`, `usetags`, `enablenotes`, `messaging`, `enableblogs`, `enablecompletion`, `enablebadges`, `messagingallusers`, `enablecustomreports`, `enableglobalsearch`, `mnet_dispatcher_mode`, `enablecompetencies` |
| `usercanmanageownfiles` | `moodle/user:manageownfiles` |
| `userquota` | bytes, `0` = unlimited/ignorable |
| `usermaxuploadfilesize` | bytes, `-1` = no limit |
| `userhomepage` | `0` site, `1` dashboard, `2` my courses (4.x), `3` = URL → then `userhomepageurl` is also present |
| `userprivateaccesskey` | the `core_files` user key for `/tokenpluginfile.php` (§5.2) |
| `sitecalendartype`, `usercalendartype` | e.g. `gregorian` |
| `userissiteadmin` | bool |
| `theme` | current theme name |
| `mobilecssurl` | |
| `limitconcurrentlogins` | int; if non-zero, `usersessionscount` is also returned |
| `policyagreed` | int |

Live example (abridged): **[verified on 4.5.13]**

```json
{"sitename":"TUNI Moodle | Tampere universities","username":"drv382@tuni.fi",
 "userid":135266,"siteurl":"https://moodle.tuni.fi","downloadfiles":1,"uploadfiles":1,
 "release":"4.5.13 (Build: 20260810)","version":"2024100713","siteid":1,
 "usercanmanageownfiles":true,"userquota":524288000,"usermaxuploadfilesize":1073741824,
 "userhomepage":1,"userprivateaccesskey":"a54703e0…","sitecalendartype":"gregorian",
 "usercalendartype":"gregorian","userissiteadmin":false,"theme":"maisteriboost",
 "limitconcurrentlogins":0,"policyagreed":1,
 "advancedfeatures":[{"name":"usecomments","value":1},…],
 "functions":[{"name":"core_badges_get_user_badges","version":"2024100713"},…]}
```

The `serviceshortnames` parameter is explicitly marked
`'DEPRECATED PARAMETER - it was a design error in the original implementation.
It is ignored now.'` — passing it changes nothing. **[verified on 4.5.13]**

**`tool_mobile_get_config`** returns `{settings: [{name, value}], warnings}` for a
named section, or every section when `section` is empty. Sections include
`frontpagesettings`, `sitepolicysettings`, `mobileapp`, `calendar`,
`coursecolors`, `supportcontact`, `graceperiodsettings`, `navigation`, `search`,
`h5psettings`. Values are strings (or null). Useful keys observed live:
`sitepolicy`, `sitepolicyhandler`, `mygradesurl`, `tool_mobile_disabledfeatures`,
`tool_mobile_filetypeexclusionlist`, `tool_mobile_custommenuitems`,
`tool_mobile_autologinmintimebetweenreq`, `tool_mobile_autologout`,
`tool_mobile_autologouttime`, `calendartype`, `calendar_startwday`,
`calendar_lookahead`, `calendar_maxevents`, `searchengine`, `timezone`,
`forcetimezone`, `customusermenuitems`, `enabledashboard`. **[verified on 4.5.13]**

### 6.3 `core_course`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `core_course_get_contents` | read | | Y | `courseid`, `options[][{name,value}]` |
| `core_course_get_courses` | read | Y | Y | `options{ids[]}` |
| `core_course_get_courses_by_field` | read | | Y | `field`, `value` `[d='']` |
| `core_course_search_courses` | read | Y | Y | `criterianame`, `criteriavalue`, `page` `[d=0]`, `perpage` `[d=0]`, `requiredcapabilities[]`, `limittoenrolled` `[d=0]`, `onlywithcompletion` `[d=0]` |
| `core_course_get_categories` | read | | Y | `criteria[][{key,value}]`, `addsubcategories` `[d=1]` |
| `core_course_get_course_module` | read | | Y | `cmid` |
| `core_course_get_course_module_by_instance` | read | | Y | `module`, `instance` |
| `core_course_get_enrolled_courses_by_timeline_classification` | read | Y | Y | `classification`, `limit` `[d=0]`, `offset` `[d=0]`, `sort` `[d=null]`, `customfieldname`, `customfieldvalue`, `searchvalue`, `requiredfields[]` |
| `core_course_get_enrolled_courses_with_action_events_by_timeline_classification` | read | Y | Y | as above + `eventsfrom`/`eventsto` style filters |
| `core_course_get_recent_courses` | read | Y | Y | `userid` `[d=0]`, `limit` `[d=0]`, `offset` `[d=0]`, `sort` `[d=null]` |
| `core_course_check_updates` | read | Y | Y | `courseid`, `tocheck[][{contextlevel,id,since}]`, `filter[]` |
| `core_course_get_updates_since` | read | Y | Y | `courseid`, `since`, `filter[]` |
| `core_course_get_user_navigation_options` | read | | Y | `courseids[]` |
| `core_course_get_user_administration_options` | read | | Y | `courseids[]` |
| `core_course_set_favourite_courses` | read | Y | Y | `courses[][{id,favourite}]` |
| `core_course_view_course` | write | | Y | `courseid`, `sectionnumber` `[d=0]` |
| `core_course_create_courses` | write | | | `courses[]` |
| `core_course_update_courses` | write | | | `courses[]` |
| `core_course_delete_courses` | write | | | `courseids[]` |
| `core_course_duplicate_course` | write | | | `courseid`, `fullname`, `shortname`, `categoryid`, `visible`, `options[]` |
| `core_course_import_course` | write | | | `importfrom`, `importto`, `deletecontent`, `options[]` |
| `core_course_create_categories` / `update_categories` / `delete_categories` | write | | | `categories[]` |
| `core_course_delete_modules` | write | | | `cmids[]` |
| `core_course_edit_module` / `edit_section` / `get_module` | write/read | Y | | `action`, `id`, `sectionreturn` |
| `core_course_get_enrolled_users_by_cmid` | read | Y | | `cmid`, `groupid` `[d=0]`, `onlyactive` `[d=false]` |
| `core_course_get_course_content_items` | read | Y | | `courseid`, `sectionnum` |
| `core_course_add_content_item_to_user_favourites` / `remove_…` | write | Y | | `componentname`, `contentitemid` |
| `core_courseformat_get_state` | read | Y | | `courseid` |
| `core_courseformat_update_course` | write | Y | | `action`, `courseid`, `ids[]`, `targetsectionid`, `targetcmid` |
| `core_courseformat_create_module` / `new_module` | write | Y | | 4.5+ |

**`core_course_get_contents` options** (`course/externallib.php`, whitelist —
anything else → `errorinvalidparam`):

| `name` | Type | Effect |
|---|---|---|
| `excludemodules` | bool | return sections only |
| `excludecontents` | bool | drop the `contents[]` file lists |
| `includestealthmodules` | bool | include "available but not shown" modules |
| `sectionid` | int | only that section (by DB id) |
| `sectionnumber` | int | only that section (by position) — **[verified on 4.5.13]** |
| `cmid` | int | only that course module |
| `modid` | int | only that module instance (needs `modname`) |
| `modname` | plugin name | filter by module type |

Section shape: `{id, name, visible, summary, summaryformat, section,
hiddenbynumsections, uservisible, component, itemid, modules[]}`.
Module shape: `{id, url, name, instance, contextid, visible, uservisible,
visibleoncoursepage, modicon, modname, purpose, branded, modplural, indent,
onclick, afterlink, activitybadge, customdata, noviewlink, completion,
completiondata?, downloadcontent, dates[], groupmode, contents[]?, availability?,
description?}`. `customdata` is a **JSON string**, per-module. **[verified on 4.5.13]**

**`core_course_get_courses_by_field` `field` whitelist**
(`course/externallib.php:3293`): `id`, `ids` (`PARAM_SEQUENCE`, comma-separated),
`shortname`, `idnumber`, `category`, `sectionid`. Anything else →
`invalid_parameter_exception('Invalid field name')`. Empty `field` returns **all**
courses. Returns `{courses[], warnings[]}` with courses the user cannot see
reported in `warnings` rather than omitted silently.

**`core_course_search_courses` `criterianame`**: `search`, `modulelist`,
`blocklist`, `tagid`. Returns `{total, courses[], warnings[]}`.
**[verified on 4.5.13]**

**`core_course_check_updates` vs `get_updates_since`.** Both return
`{instances: [{contextlevel, id, updates: [{name, timeupdated?, itemids[]?}]}],
warnings[]}`. `check_updates` takes an explicit `tocheck[]` list with a `since`
per item; `get_updates_since` takes one `since` for the whole course and checks
everything. Update `name`s seen live: `configuration`, `contentfiles`,
`introfiles`, `discussions`, `gradeitems`, `outcomes`, `comments`, `ratings`,
`completion`. This is the correct primitive for incremental sync.
**[verified on 4.5.13]**

### 6.4 `core_enrol`, `enrol_*`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `core_enrol_get_users_courses` | read | | Y | `userid`, `returnusercount` `[d=true]` |
| `core_enrol_get_enrolled_users` | read | | Y | `courseid`, `options[][{name,value}]` |
| `core_enrol_get_course_enrolment_methods` | read | | Y | `courseid` |
| `core_enrol_search_users` | read | Y | Y | `courseid`, `search`, `searchanywhere`, `page`, `perpage`, `contextid` |
| `core_enrol_get_potential_users` | read | Y | | `courseid`, `enrolid`, `search`, `searchanywhere`, `page`, `perpage` |
| `core_enrol_get_enrolled_users_with_capability` | read | | | `coursecapabilities[]`, `options[]` |
| `core_enrol_submit_user_enrolment_form` | write | Y | | `formdata` (urlencoded form) |
| `core_enrol_unenrol_user_enrolment` | write | Y | | `ueid` |
| `core_role_assign_roles` / `core_role_unassign_roles` | write | | | `assignments[]` |
| `enrol_self_get_instance_info` | read | | Y | `instanceid` |
| `enrol_self_enrol_user` | write | | Y | `courseid`, `password` `[d='']`, `instanceid` `[d=0]` |
| `enrol_guest_get_instance_info` | read | | Y | `instanceid` |
| `enrol_guest_validate_password` | write | | Y | `instanceid`, `password` |
| `enrol_manual_enrol_users` / `unenrol_users` | write | | | `enrolments[]` — **not** in the mobile service |

**`core_enrol_get_users_courses`** is the workhorse for "what is this user
enrolled in". `userid` is **required** (no default to self) — omitting it gives
`invalidparameter`. **[verified on 4.5.13]** Returned per course:

```json
{"id":58849,"shortname":"...","fullname":"...","displayname":"...",
 "enrolledusercount":45,"idnumber":"otm-…","visible":1,"summary":"",
 "summaryformat":1,"format":"onetopic",
 "courseimage":"https://…/pluginfile.php/6001538/course/generated/course.svg",
 "showgrades":true,"lang":"","enablecompletion":false,
 "completionhascriteria":false,"completionusertracked":false,"category":8,
 "progress":null,"completed":null,"startdate":1787518800,"enddate":1791838800,
 "marker":0,"lastaccess":1787916634,"isfavourite":false,"hidden":false,
 "overviewfiles":[],"showactivitydates":false,"showcompletionconditions":null,
 "timemodified":1786908035}
```

`returnusercount=0` **removes** `enrolledusercount` from the response entirely
(it is `VALUE_OPTIONAL`) — it does not set it to 0. Setting it to 0 is a
meaningful performance win on large sites. **[verified on 4.5.13]**

**`core_enrol_get_enrolled_users` options whitelist**
(`enrol/externallib.php`, `get_enrolled_users()`):
`withcapability`, `groupid`, `onlyactive`, `onlysuspended`,
`userfields` (comma-separated), `limitfrom`, `limitnumber`,
`sortby` (`id` | `firstname` | `lastname` | `siteorder`), `sortdirection`
(`ASC`/`DESC`). Unknown `sortby` → `invalid_parameter_exception` listing the
allowed values. Returns an array of user objects, each with a `roles[]` array
scoped to the course context. **[verified on 4.5.13]**

`core_enrol_get_course_enrolment_methods` returns `[]` for a course whose enrol
instances are all non-self/non-guest — it only reports methods that expose an
instance-info endpoint. **[verified on 4.5.13]**

### 6.5 `core_user`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `core_user_get_users_by_field` | read | | Y | `field`, `values[]` |
| `core_user_get_users` | read | | | `criteria[][{key,value}]` |
| `core_user_get_course_user_profiles` | read | | Y | `userlist[][{userid,courseid}]` |
| `core_user_get_user_preferences` | read | | Y | `name` `[d='']`, `userid` `[d=0]` |
| `core_user_set_user_preferences` | write | Y | Y | `preferences[][{name,value,userid}]` — `loginrequired => false` |
| `core_user_update_user_preferences` | write | | Y | `userid` `[d=0]`, `emailstop` `[d=null]`, `preferences[][{type,value}]` |
| `core_user_get_private_files_info` | read | | Y | `userid` `[d=0]` |
| `core_user_add_user_private_files` | write | | Y | `draftid` |
| `core_user_update_private_files` | write | | Y | 4.5+ |
| `core_user_prepare_private_files_for_edition` | write | | Y | 4.5+ |
| `core_user_update_picture` | write | | Y | `draftitemid` `[d=false]`, `delete` `[d=false]`, `userid` `[d=0]` |
| `core_user_add_user_device` | write | | Y | `appid`, `name`, `model`, `platform`, `version`, `pushid`, `uuid`, `publickey` |
| `core_user_remove_user_device` | write | | Y | `uuid` `[d='']`, `appid` `[d='']` |
| `core_user_update_user_device_public_key` | write | | Y | 4.1+ |
| `core_user_view_user_list` | write | | Y | `courseid` |
| `core_user_view_user_profile` | write | | Y | `userid`, `courseid` `[d=0]` |
| `core_user_agree_site_policy` | write | | Y | — |
| `core_user_create_users` / `update_users` / `delete_users` | write | | | **not in the mobile service** |
| `core_user_search_identity` | read | Y | | `query` (4.0+) |

`core_user_get_users_by_field` `field` whitelist (`user/externallib.php`):
`id`, `idnumber`, `username`, `email`. Anything else → `coding_exception`
("invalid field parameter"). Values are cleaned with the property's own type and
a value that changes under cleaning raises `invalid_parameter_exception`.
Returns an array (possibly empty — a user you cannot see is silently omitted,
**no warning**). Fields returned depend on your capabilities in the target
context; `preferences[]` is included for your own record.
**[verified on 4.5.13]**

`core_user_get_users` `criteria[].key` whitelist: `id`, `lastname`, `firstname`,
`idnumber`, `username`, `email`, `auth`, `confirmed`, `lastaccess`, `deleted`,
`suspended`, `firstaccess`, `city`, `country`. Each key may be used **once**
(`keyalreadyset` otherwise). `%` wildcards allowed on text keys. Requires
`moodle/user:viewalldetails` at system level in practice.

### 6.6 `core_calendar`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `core_calendar_get_action_events_by_timesort` | read | Y | Y | `timesortfrom` `[d=0]`, `timesortto` `[d=null]`, `aftereventid` `[d=0]`, `limitnum` `[d=20]`, `limittononsuspendedevents` `[d=false]`, `userid` `[d=null]`, `searchvalue` `[d=null]` |
| `core_calendar_get_action_events_by_course` | read | Y | Y | `courseid`, `timesortfrom`, `timesortto`, `aftereventid` `[d=0]`, `limitnum` `[d=20]`, `searchvalue` |
| `core_calendar_get_action_events_by_courses` | read | Y | Y | `courseids[]`, `timesortfrom`, `timesortto`, `limitnum` `[d=10]`, `searchvalue` |
| `core_calendar_get_calendar_events` | read | | Y | `events{eventids[],courseids[],groupids[],categoryids[]}`, `options{userevents,siteevents,timestart,timeend,ignorehidden}` |
| `core_calendar_get_calendar_event_by_id` | read | Y | Y | `eventid` |
| `core_calendar_get_calendar_monthly_view` | read | Y | Y | `year`, `month`, `courseid` `[d=SITEID]`, `categoryid`, `includenavigation` `[d=true]`, `mini` `[d=false]`, `day` `[d=1]`, `view` `[d='month']` |
| `core_calendar_get_calendar_day_view` | read | Y | Y | `year`, `month`, `day`, `courseid` `[d=SITEID]`, `categoryid` |
| `core_calendar_get_calendar_upcoming_view` | read | Y | Y | `courseid` `[d=SITEID]`, `categoryid` |
| `core_calendar_get_calendar_access_information` | read | | Y | `courseid` `[d=0]` |
| `core_calendar_get_allowed_event_types` | read | | Y | `courseid` `[d=0]` |
| `core_calendar_get_calendar_export_token` | read | | Y | — |
| `core_calendar_get_timestamps` | read | Y | | `data[][{key,year,month,day,hour,minute}]` |
| `core_calendar_create_calendar_events` | write | | Y | `events[]` |
| `core_calendar_delete_calendar_events` | write | Y | Y | `events[][{eventid,repeat}]` |
| `core_calendar_submit_create_update_form` | write | Y | Y | `formdata` |
| `core_calendar_update_event_start_day` | write | Y | Y | `eventid`, `daytimestamp` |
| `core_calendar_delete_subscription` | write | Y | | `subscriptionid` |

`get_action_events_by_timesort` is the "what's due" feed used by the Timeline
block; it is one of the 7 `readonlysession => true` functions. Live event shape:

```json
{"id":2137873,"name":"… on palautettava viimeistään","description":"","descriptionformat":1,
 "location":"","categoryid":null,"groupid":null,"userid":2873,"repeatid":null,
 "eventcount":null,"component":"mod_assign","modulename":"assign",
 "activityname":"Learning Diary Week 01","activitystr":"Assignment is due",
 "instance":4461003,"eventtype":"due","timestart":1788433200,"timeduration":0,
 "timesort":1788433200,"timeusermidnight":1788382800,"visible":1,
 "timemodified":1788242926,"overdue":true,
 "icon":{"key":"monologo","component":"assign","alttext":"Activity event","iconurl":"…"},
 "course":{"id":58630,"fullname":"…","viewurl":"…","courseimage":"data:image/svg+xml;base64,…"},
 "url":"…","action":{"name":"Add submission","url":"…","itemcount":1,"actionable":true}}
```

Note `courseimage` can be a **`data:` URI** for auto-generated course images —
budget for large responses. **[verified on 4.5.13]**

`core_calendar_get_calendar_export_token` returns
`{token: "<40 hex>", warnings: []}` — the `authtoken` for the iCal export URL
`/calendar/export_execute.php?userid=<id>&authtoken=<token>&preset_what=all&preset_time=recentupcoming`.
**[verified on 4.5.13]** This is a *different* token type (`user_private_key`,
`calendar/export`), not a WS token, and it is the cleanest way to get a calendar
feed URL you can hand to another system.

### 6.7 `core_completion`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `core_completion_get_activities_completion_status` | read | | Y | `courseid`, `userid` |
| `core_completion_get_course_completion_status` | read | | Y | `courseid`, `userid` |
| `core_completion_update_activity_completion_status_manually` | write | Y | Y | `cmid`, `completed` |
| `core_completion_override_activity_completion_status` | write | Y | | `userid`, `cmid`, `newstate` |
| `core_completion_mark_course_self_completed` | write | | Y | `courseid` |

`get_activities_completion_status` returns `{statuses: [{cmid, modname, instance,
state, timecompleted, tracking, overrideby, valueused, hascompletion,
isautomatic, istrackeduser, uservisible, details[]}], warnings}`.
**On a course with completion disabled it returns `{"statuses":[],"warnings":[]}`
— an empty list, not an error.** **[verified on 4.5.13]** `state` is
`COMPLETION_INCOMPLETE 0`, `COMPLETION_COMPLETE 1`, `COMPLETION_COMPLETE_PASS 2`,
`COMPLETION_COMPLETE_FAIL 3`. `get_course_completion_status` needs
`report/completion:view` for other users and throws `nopermissions` otherwise.
Semantics of completion criteria live in `data-model.md`.

### 6.8 Grades: `core_grades`, `gradereport_*`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `gradereport_user_get_grade_items` | read | | Y | `courseid`, `userid` `[d=0]`, `groupid` `[d=0]` |
| `gradereport_user_get_grades_table` | read | | Y | `courseid`, `userid` `[d=0]`, `groupid` `[d=0]` |
| `gradereport_user_get_access_information` | read | | Y | `courseid` |
| `gradereport_user_view_grade_report` | write | | Y | `courseid`, `userid` `[d=0]` |
| `gradereport_overview_get_course_grades` | read | | Y | `userid` `[d=0]` |
| `gradereport_overview_view_grade_report` | write | | Y | `courseid` `[d=0]`, `userid` `[d=0]` |
| `gradereport_grader_get_users_in_report` | read | Y | Y | `courseid` |
| `gradereport_singleview_get_grade_items_for_search_widget` | read | Y | Y | `courseid`, `actionbaritemtype` |
| `core_grades_get_gradeitems` | read | Y | Y | `courseid`, `itemtype`… |
| `core_grades_get_gradable_users` | read | Y | Y | `courseid`, `groupid`, `onlyactive` |
| `core_grades_get_enrolled_users_for_search_widget` | read | Y | Y | `courseid`, `actionbaritemtype` |
| `core_grades_get_groups_for_selector` | read | Y | Y | `courseid` |
| `core_grades_get_feedback` | read | Y | | `courseid`, `userid`, `itemid` |
| `core_grades_get_grade_tree` | read | Y | | `courseid` |
| `core_grades_grader_gradingpanel_point_fetch` / `_store` | write | Y | Y | `component`, `contextid`, `itemname`, `gradeduserid`, (`formdata`) |
| `core_grades_grader_gradingpanel_scale_fetch` / `_store` | write | Y | Y | as above |
| `core_grades_update_grades` | write | | | `source`, `component`, `activityid`, `itemnumber`, `grades[]` |
| `core_grading_get_definitions` / `get_gradingform_instances` / `save_definitions` | read/write | | | advanced grading (rubrics/guides) — **not in the mobile service** |

**`gradereport_user_get_grade_items`** is the one you want: structured, not HTML.
Returns `{usergrades: [{courseid, courseidnumber, userid, userfullname,
useridnumber, maxdepth, gradeitems: [...]}], warnings}` where each grade item is:

```json
{"id":637568,"itemname":"Exercise 1 (submission)","itemtype":"mod",
 "itemmodule":"workshop","iteminstance":5179,"itemnumber":0,"idnumber":"palautus1",
 "categoryid":97862,"outcomeid":null,"scaleid":null,"locked":null,"cmid":4283972,
 "graderaw":null,"gradedatesubmitted":null,"gradedategraded":null,
 "gradehiddenbydate":false,"gradeneedsupdate":false,"gradeishidden":false,
 "gradeislocked":null,"gradeisoverridden":null,"gradeformatted":"-",
 "grademin":0,"grademax":48,"rangeformatted":"0&ndash;48",
 "percentageformatted":"-","feedback":"","feedbackformat":0}
```

**[verified on 4.5.13]** `itemtype` ∈ `mod` | `category` | `course` | `manual`.
`gradeformatted` is a display string (may contain HTML entities like `&ndash;`
and may be `"-"` for no grade); `graderaw` is the numeric value **only when the
caller may see raw grades**, otherwise `null`. `gradereport_user_get_grades_table`
returns the same data pre-rendered as HTML table cells — avoid it.

`gradereport_overview_get_course_grades(userid)` gives the one-line-per-course
summary: `{grades: [{courseid, grade, rawgrade}], warnings}`. `grade` is the
formatted string, `rawgrade` the number or null. **[verified on 4.5.13]**

`gradereport_user_get_access_information(courseid)` →
`{canviewusergradereport, canviewmygrades, canviewallgrades, warnings}` — call it
first to decide whether to bother. **[verified on 4.5.13]**

`core_grades_get_gradeitems(courseid)` returns
`{"gradeItems":[{"id":"637581","itemname":"…","category":"…"}]}` — note the
**camelCase key** and the **string ids**. It is the search-widget feed, not a
full gradebook dump. **[verified on 4.5.13]**

Gradebook internals (categories, aggregation, `grade_grades` vs `grade_items`,
hidden/locked semantics) are in `data-model.md`.

### 6.9 `core_message`, `message_*`

All of `core_message_*` is `ajax => true` and in the mobile service.

**Reads:** `get_conversations`, `get_conversation`,
`get_conversation_between_users`, `get_self_conversation`,
`get_conversation_messages`, `get_conversation_members`,
`get_conversation_counts`, `get_unread_conversation_counts`,
`get_unread_conversations_count`, `get_unread_notification_count`,
`get_user_contacts`, `get_contact_requests`,
`get_received_contact_requests_count`, `get_blocked_users`, `get_member_info`,
`get_messages`, `search_contacts`, `message_search_users`,
`data_for_messagearea_search_messages`, `get_user_message_preferences`,
`get_user_notification_preferences`, `get_message_processor`.

**Writes:** `send_instant_messages`, `send_messages_to_conversation`,
`create_contact_request`, `confirm_contact_request`, `decline_contact_request`,
`delete_contacts`, `block_user`, `unblock_user`, `mute_conversations`,
`unmute_conversations`, `set_favourite_conversations`,
`unset_favourite_conversations`, `mark_message_read`, `mark_notification_read`,
`mark_all_notifications_as_read`, `mark_all_conversation_messages_as_read`,
`delete_message`, `delete_message_for_all_users`, `delete_conversations_by_id`,
`message_processor_config_form`.

Key signatures:

| Function | Params |
|---|---|
| `core_message_get_conversations` | `userid` `[d=0]`, `limitfrom` `[d=0]`, `limitnum` `[d=0]`, `type` `[d=null]`, `favourites` `[d=null]`, `mergeself` `[d=false]` |
| `core_message_get_conversation` | `userid`, `conversationid`, `includecontactrequests` `[d=0]`, `includeprivacyinfo` `[d=0]`, `memberlimit` `[d=0]`, `memberoffset` `[d=0]`, `messagelimit` `[d=100]`, `messageoffset` `[d=0]`, `newestmessagesfirst` `[d=true]` |
| `core_message_get_conversation_messages` | `currentuserid`, `convid`, `limitfrom` `[d=0]`, `limitnum` `[d=0]`, `newest` `[d=false]`, `timefrom` `[d=0]` |
| `core_message_get_messages` | `useridto`, `useridfrom` `[d=0]`, `type` `[d='both']`, `read` `[d=1]`, `newestfirst` `[d=true]`, `limitfrom` `[d=0]`, `limitnum` `[d=0]` |
| `core_message_send_instant_messages` | `messages[][{touserid,text,textformat,clientmsgid}]` |
| `core_message_send_messages_to_conversation` | `conversationid`, `messages[][{text,textformat}]` |
| `core_message_get_unread_conversation_counts` | `userid` `[d=0]` |
| `message_popup_get_popup_notifications` | `useridto`, `newestfirst`, `limit`, `offset` |
| `message_popup_get_unread_popup_notification_count` | `useridto` |
| `message_airnotifier_get_user_devices` | `appid`, `userid` |
| `message_airnotifier_enable_device` | `deviceid`, `enable` |
| `message_airnotifier_is_system_configured` / `are_notification_preferences_configured` | — / `userids[]` |

`get_conversations` returns `{conversations: [...]}` with **no `warnings` key at
all**. Conversation `type`: 1 = individual, 2 = group, 3 = self. Each item
carries `members[]` (the *other* participants) and `messages[]` (the most recent
one). **[verified on 4.5.13]**

`core_message_get_messages` predates the conversation API and is still the
easiest way to pull raw notifications (`type='notifications'`).

Site-wide gates: `advancedfeatures.messaging` from `get_site_info` must be 1;
`messagingallusers` controls whether you can message non-contacts outside shared
courses.

### 6.10 `core_files`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `core_files_get_files` | read | | Y | `contextid`, `component`, `filearea`, `itemid`, `filepath` `[d=null]`, `filename` `[d=null]`, `modified` `[d=null]`, `contextlevel` `[d=null]`, `instanceid` `[d=null]` |
| `core_files_upload` | write | | | `contextid`, `component`, `filearea`, `itemid`, `filepath`, `filename`, `filecontent` (base64), `contextlevel`, `instanceid` — **not in the mobile service**; use `/webservice/upload.php` instead |
| `core_files_get_unused_draft_itemid` | write | | Y | — |
| `core_files_delete_draft_files` | write | | Y | `draftitemid`, `files[][{filepath,filename}]` |

`get_files` accepts **either** `contextid` **or** the pair
`contextlevel`+`instanceid` (pass `contextid=0` to use the latter). Returns
`{parents: [{contextid, component, filearea, itemid, filepath, filename}],
files: [{contextid, component, filearea, itemid, filepath, filename, isdir,
url, timemodified, timecreated, filesize, author, license}]}`. An empty private
area returns `{"parents":[],"files":[]}`. **[verified on 4.5.13]**

`core_files_upload` takes base64 in a single parameter — it is memory-hostile and
not in the mobile service. Use `/webservice/upload.php` (§5.3).

### 6.11 `core_group`, `core_cohort`, `core_role`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `core_group_get_course_user_groups` | read | | Y | `courseid` `[d=0]`, `userid` `[d=0]`, `groupingid` `[d=0]` |
| `core_group_get_course_groups` | read | Y | Y | `courseid` |
| `core_group_get_course_groupings` | read | | Y | `courseid` |
| `core_group_get_activity_allowed_groups` | read | | Y | `cmid` `[d=0]`, `userid` `[d=0]` |
| `core_group_get_activity_groupmode` | read | | Y | `cmid` |
| `core_group_get_groups_for_selector` | read | Y | Y | `courseid` |
| `core_group_get_groups` | read | | | `groupids[]` |
| `core_group_get_group_members` | read | | | `groupids[]` |
| `core_group_get_groupings` | read | | | `groupingids[]`, `returngroups` `[d=0]` |
| `core_group_create_groups` / `update_groups` / `delete_groups` | write | | | `groups[]` / `groupids[]` |
| `core_group_add_group_members` / `delete_group_members` | write | | | `members[][{groupid,userid}]` |
| `core_group_create_groupings` / `update_groupings` / `delete_groupings` | write | | | `groupings[]` / `groupingids[]` |
| `core_group_assign_grouping` / `unassign_grouping` | write | | | `assignments[][{groupingid,groupid}]` |
| `core_cohort_get_cohorts` / `get_cohort_members` / `search_cohorts` | read | | | **not in the mobile service** |
| `core_cohort_create_cohorts` / `update_cohorts` / `delete_cohorts` / `add_cohort_members` / `delete_cohort_members` | write | | | |
| `core_role_assign_roles` / `unassign_roles` | write | | | `assignments[][{roleid,userid,contextid\|contextlevel+instanceid}]` |

`core_group_get_course_user_groups` returns `{groups: [], warnings: []}` — an
empty list when there are no groups, not an error. **[verified on 4.5.13]**

Note the asymmetry: the *read* functions in the mobile service are the
user-scoped ones (`get_course_user_groups`, `get_activity_allowed_groups`); the
admin-scoped ones (`get_groups`, `get_group_members`) are not, so a mobile token
cannot enumerate group membership across a course.

### 6.12 `core_notes`, `core_comment`, `core_rating`, `core_tag`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `core_notes_get_course_notes` | read | | Y | `courseid` `[d=0]`, `userid` `[d=0]` |
| `core_notes_view_notes` | write | | Y | `courseid` `[d=0]`, `userid` `[d=0]` |
| `core_notes_create_notes` | write | Y | Y | `notes[][{userid,publishstate,courseid,text,format,clientnoteid}]` |
| `core_notes_delete_notes` | write | | Y | `notes[]` (ids) |
| `core_notes_get_notes` / `update_notes` | read/write | | | not in mobile service |
| `core_comment_get_comments` | read | | Y | `contextlevel`, `instanceid`, `component`, `itemid`, `area` `[d='']`, `page` `[d=0]`, `sortdirection` `[d='DESC']` |
| `core_comment_add_comments` | write | | Y | `comments[][{contextlevel,instanceid,component,content,itemid,area}]` |
| `core_comment_delete_comments` | write | Y | Y | `comments[]` (ids) |
| `core_rating_get_item_ratings` | read | | Y | `contextlevel`, `instanceid`, `component`, `ratingarea`, `itemid`, `scaleid`, `sort` |
| `core_rating_add_rating` | write | | Y | `contextlevel`, `instanceid`, `component`, `ratingarea`, `itemid`, `scaleid`, `rating`, `rateduserid`, `aggregation` |
| `core_tag_get_tagindex` / `get_tagindex_per_area` / `get_tag_cloud` / `get_tag_collections` / `get_tag_areas` | read | Y | Y | various |

`core_notes_*` requires `advancedfeatures.enablenotes == 1` and
`moodle/notes:view` / `moodle/notes:manage`.

### 6.13 `core_search`, `core_blog`, `core_badges`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `core_search_get_results` | read | | Y | `query`, `page` `[d=0]`, `filters{}`, `context` |
| `core_search_get_search_areas_list` | read | | Y | `cat` |
| `core_search_get_top_results` | read | | Y | `query`, `filters{}` |
| `core_search_view_results` | write | | Y | `query`, `filters{}`, `page` |
| `core_search_get_relevant_users` | read | Y | | `query`, `courseid` |
| `core_blog_get_entries` | read | Y | Y | `filters[][{name,value}]`, `page` `[d=0]`, `perpage` `[d=10]` — `loginrequired => false` |
| `core_blog_view_entries` | read | Y | Y | `filters[]` — `loginrequired => false` |
| `core_blog_add_entry` / `update_entry` / `delete_entry` / `prepare_entry_for_edition` / `get_access_information` | write/read | | Y | 4.5+ (`add_entry`, `update_entry`, `delete_entry`, `prepare_entry_for_edition` are **new in 4.5**) |
| `core_badges_get_user_badges` | read | | Y | `userid` `[d=0]`, `courseid` `[d=0]`, `page`, `perpage`, `search` `[d='']`, `onlypublic` `[d=false]` |
| `core_badges_get_user_badge_by_hash` | read | | Y | `hash` (4.3+) |
| `core_badges_get_badge` | read | | Y | `id` (**new in 4.5**) |
| `core_badges_enable_badges` / `disable_badges` | write | Y | | 4.5+, admin |

`core_search_*` all declare `capabilities => moodle/search:query` and **fail hard
when global search is off**:
`{"errorcode":"globalsearchdisabled","message":"Global searching is not enabled."}`
— check `advancedfeatures.enableglobalsearch` in `get_site_info` first.
**[verified on 4.5.13]**

`core_blog_get_entries` `filters[].name` ∈ `tag`, `tagid`, `userid`, `cmid`,
`entryid`, `groupid`, `courseid`, `search`. Requires
`advancedfeatures.enableblogs == 1`.

`core_badges_get_user_badges` requires `advancedfeatures.enablebadges == 1` and
`moodle/badges:viewotherbadges` for other users.

### 6.14 `core_block`, `block_*`

| Function | R/W | AJ | M | Params |
|---|---|---|---|---|
| `core_block_get_dashboard_blocks` | read | | Y | `userid` `[d=0]`, `returncontents` `[d=false]`, `mypage` `[d='__default']` |
| `core_block_get_course_blocks` | read | | Y | `courseid`, `returncontents` `[d=false]` |
| `core_block_fetch_addable_blocks` | read | Y | Y | `pagecontextid`, `pagetype`, `pagelayout`, `subpage` |
| `block_recentlyaccesseditems_get_recent_items` | read | Y | Y | `limit` `[d=0]` |
| `block_starredcourses_get_starred_courses` | read | Y | Y | `limit` `[d=0]`, `offset` `[d=0]` |

`core_block_get_dashboard_blocks` returns
`{blocks: [{instanceid, name, region, positionid, collapsible, dockable, weight,
visible, configs?: [{name, value, type}], contents?: {title, content, footer,
files[]}}], warnings}`. `configs[].value` is a **JSON-encoded string**
(`"\"courses\""`, `"\"1\""`) — decode twice. `type` is `plugin` or `instance`.
`contents` only appears with `returncontents=1`. **[verified on 4.5.13]**

This is the correct way to discover *what a user's dashboard actually shows*, and
therefore which of `block_timeline` / `block_myoverview` /
`block_recentlyaccesseditems` data to fetch.

### 6.15 `core_reportbuilder`, `core_table`, `core_xapi`, misc infrastructure

| Function | R/W | AJ | M | Notes |
|---|---|---|---|---|
| `core_reportbuilder_list_reports` | read | | Y | 4.1+ |
| `core_reportbuilder_retrieve_report` | read | | Y | `reportid`, `page`, `perpage` — 4.1+ |
| `core_reportbuilder_retrieve_system_report` | read | | Y | 4.3+ |
| `core_reportbuilder_can_view_system_report` | read | | Y | 4.3+ |
| `core_reportbuilder_view_report` | write | | Y | 4.1+ |
| `core_reportbuilder_*` (columns/conditions/filters/audiences/schedules) | write | Y | | report *editing* UI; 4.0+ |
| `core_table_get_dynamic_table_content` | read | Y | Y | the generic "give me this table's rows" endpoint used by many admin/report screens |
| `core_xapi_statement_post` | write | | Y | H5P xAPI ingest |
| `core_xapi_get_state` / `post_state` / `delete_state` / `get_states` / `delete_states` | read/write | | Y | 4.3+ |
| `core_get_string` / `core_get_strings` | read | Y | | `loginrequired => false`; `stringid`, `component`, `lang`, `stringparams[]` |
| `core_get_component_strings` | read | Y | Y | `component`, `lang` — `loginrequired => false`. **The way to localise your own UI from the site's lang packs** |
| `core_get_user_dates` | read | Y | | `contextid`, `timestamps[][{timestamp,format,type,fixday,fixhour}]` — server-side date formatting |
| `core_output_load_template` / `_with_dependencies` | read | Y | | `loginrequired => false`; mustache templates |
| `core_output_load_fontawesome_icon_map` | read | Y | | **removed in 5.0**; use `_system_map` |
| `core_fetch_notifications` | read | Y | | `contextid`; session notification queue |
| `core_session_touch` / `core_session_time_remaining` | read | Y | | keep-alive |
| `core_form_dynamic_form` | write | Y | | generic dynamic-form submit; `formdata`, `form` |
| `core_get_fragment` | read | Y | | render a server-side HTML fragment |
| `core_update_inplace_editable` | write | Y | | `component`, `itemtype`, `itemid`, `value` |
| `core_h5p_get_trusted_h5p_file` | read | Y | Y | `url`, `frame`, `export`, `embed`, `copyright` |
| `core_filters_get_available_in_context` / `get_all_states` | read | | Y | which text filters apply — pair with `moodlewssettingfilter` |
| `core_question_update_flag` | write | | Y | `qubaid`, `questionid`, `qaid`, `slot`, `checksum`, `newstate` |
| `core_my_view_page` | write | | Y | `page` |
| `core_change_editmode` | write | Y | | 4.0+ |
| `core_payment_get_available_gateways` | read | Y | | 4.0+ |
| `core_ai_get_policy_status` / `set_policy_status` | read/write | Y | Y | **new in 4.5** |
| `tool_policy_get_user_acceptances` / `set_acceptances_status` | read/write | | Y | site policy consent |
| `tool_dataprivacy_get_access_information` / `create_data_request` / `get_data_requests` / `cancel_data_request` / `contact_dpo` | read/write | | Y | GDPR subject requests |
| `tool_moodlenet_search_courses` / `verify_webfinger` | read | Y | Y | 4.2+ |
| `tool_analytics_potential_contexts` | read | Y | Y | |
| `report_insights_action_executed` / `set_fixed_prediction` / `set_notuseful_prediction` | write | Y | Y | |

### 6.16 `core_competency` / `tool_lp`

~70 `core_competency_*` functions, all `ajax => true`, but only a handful are in
the mobile service:
`core_competency_competency_viewed`, `core_competency_delete_evidence`,
`core_competency_get_scale_values`, `core_competency_grade_competency_in_course`,
`core_competency_list_course_competencies`,
`core_competency_user_competency_plan_viewed`,
`core_competency_user_competency_viewed`,
`core_competency_user_competency_viewed_in_course`,
`core_competency_user_competency_viewed_in_plan`.

The `tool_lp_data_for_*_page` family (`data_for_plan_page`, `data_for_plans_page`,
`data_for_course_competencies_page`, `data_for_user_competency_summary*`,
`data_for_user_evidence_list_page`, `data_for_user_evidence_page`) *is* in the
mobile service and returns renderer-ready, denormalised payloads — much more
practical than assembling the raw `core_competency_*` reads.

Everything requires `advancedfeatures.enablecompetencies == 1`.

### 6.17 `mod_*` entry points (names only)

Details, semantics and state machines: **`activity-modules.md`**.
The live 4.5.13 site exposes **215** `mod_*` functions across these modules
(counts include third-party `mod_customcert`, `mod_choicegroup`, `mod_subcourse`):

| Module | n | Functions (suffix after `mod_<name>_`) |
|---|---|---|
| `assign` | 24 | `get_assignments`, `get_grades`, `get_participant`, `get_submission_status`, `get_submissions`, `get_user_flags`, `get_user_mappings`, `list_participants`, `lock_submissions`, `remove_submission`, `reveal_identities`, `revert_submissions_to_draft`, `save_grade`, `save_grades`, `save_submission`, `save_user_extensions`, `set_user_flags`, `start_submission`, `submit_for_grading`, `submit_grading_form`, `unlock_submissions`, `view_assign`, `view_grading_table`, `view_submission_status` |
| `quiz` | 18 | `get_attempt_access_information`, `get_attempt_data`, `get_attempt_review`, `get_attempt_summary`, `get_combined_review_options`, `get_quiz_access_information`, `get_quiz_feedback_for_grade`, `get_quiz_required_qtypes`, `get_quizzes_by_courses`, `get_user_attempts`, `get_user_best_grade`, `process_attempt`, `save_attempt`, `start_attempt`, `view_attempt`, `view_attempt_review`, `view_attempt_summary`, `view_quiz` |
| `forum` | 17 | `add_discussion`, `add_discussion_post`, `can_add_discussion`, `delete_post`, `get_discussion_post`, `get_discussion_posts`, `get_forum_access_information`, `get_forum_discussions`, `get_forums_by_courses`, `prepare_draft_area_for_post`, `set_lock_state`, `set_pin_state`, `set_subscription_state`, `toggle_favourite_state`, `update_discussion_post`, `view_forum`, `view_forum_discussion` |
| `workshop` | 19 | `add_submission`, `delete_submission`, `evaluate_assessment`, `evaluate_submission`, `get_assessment`, `get_assessment_form_definition`, `get_grades`, `get_grades_report`, `get_reviewer_assessments`, `get_submission`, `get_submission_assessments`, `get_submissions`, `get_user_plan`, `get_workshop_access_information`, `get_workshops_by_courses`, `update_assessment`, `update_submission`, `view_submission`, `view_workshop` |
| `glossary` | 18 | `add_entry`, `delete_entry`, `get_authors`, `get_categories`, `get_entries_by_author`, `get_entries_by_author_id`, `get_entries_by_category`, `get_entries_by_date`, `get_entries_by_letter`, `get_entries_by_search`, `get_entries_by_term`, `get_entries_to_approve`, `get_entry_by_id`, `get_glossaries_by_courses`, `prepare_entry_for_edition`, `update_entry`, `view_entry`, `view_glossary` |
| `lesson` | 17 | `finish_attempt`, `get_attempts_overview`, `get_content_pages_viewed`, `get_lesson`, `get_lesson_access_information`, `get_lessons_by_courses`, `get_page_data`, `get_pages`, `get_pages_possible_jumps`, `get_questions_attempts`, `get_user_attempt`, `get_user_attempt_grade`, `get_user_grade`, `get_user_timers`, `launch_attempt`, `process_page`, `view_lesson` |
| `feedback` | 14 | `get_analysis`, `get_current_completed_tmp`, `get_feedback_access_information`, `get_feedbacks_by_courses`, `get_finished_responses`, `get_items`, `get_last_completed`, `get_non_respondents`, `get_page_items`, `get_responses_analysis`, `get_unfinished_responses`, `launch_feedback`, `process_page`, `view_feedback` |
| `data` | 11 | `add_entry`, `approve_entry`, `delete_entry`, `get_data_access_information`, `get_databases_by_courses`, `get_entries`, `get_entry`, `get_fields`, `search_entries`, `update_entry`, `view_database` |
| `bigbluebuttonbn` | 10 | `can_join`, `completion_validate`, `end_meeting`, `get_bigbluebuttonbns_by_courses`, `get_join_url`, `get_recordings`, `get_recordings_to_import`, `meeting_info`, `update_recording`, `view_bigbluebuttonbn` |
| `wiki` | 10 | `edit_page`, `get_page_contents`, `get_page_for_editing`, `get_subwiki_files`, `get_subwiki_pages`, `get_subwikis`, `get_wikis_by_courses`, `new_page`, `view_page`, `view_wiki` |
| `chat` | 9 | `get_chat_latest_messages`, `get_chat_users`, `get_chats_by_courses`, `get_session_messages`, `get_sessions`, `login_user`, `send_chat_message`, `view_chat`, `view_sessions` |
| `scorm` | 9 | `get_scorm_access_information`, `get_scorm_attempt_count`, `get_scorm_sco_tracks`, `get_scorm_scoes`, `get_scorm_user_data`, `get_scorms_by_courses`, `insert_scorm_tracks`, `launch_sco`, `view_scorm` |
| `h5pactivity` | 7 | `get_attempts`, `get_h5pactivities_by_courses`, `get_h5pactivity_access_information`, `get_results`, `get_user_attempts`, `log_report_viewed`, `view_h5pactivity` |
| `choice` | 6 | `delete_choice_responses`, `get_choice_options`, `get_choice_results`, `get_choices_by_courses`, `submit_choice_response`, `view_choice` |
| `survey` | 4 | `get_questions`, `get_surveys_by_courses`, `submit_answers`, `view_survey` |
| `lti` | 3 | `get_ltis_by_courses`, `get_tool_launch_data`, `view_lti` |
| `book`, `folder`, `imscp`, `page`, `resource`, `url` | 2 each | `get_<name>s_by_courses`, `view_<name>` |
| `label` | 1 | `get_labels_by_courses` |

**The universal pattern:** every module implements
`mod_<name>_get_<name>s_by_courses(courseids[])` returning the instances plus
per-instance `intro`, `introfiles`, `visible`, `coursemodule`, and a `warnings[]`
for courses you cannot see; and `mod_<name>_view_<name>(<name>id)` which logs a
view event and (where applicable) ticks "view" completion. Most also have
`mod_<name>_get_<name>_access_information(...)` returning a `can*` boolean map —
**call that before attempting any write**.


---

## 7. Versioning, feature detection and deprecation

### 7.1 `core_webservice_get_site_info.functions[].version` — what it really is

**It is the *component's* `version.php` version, not an API version and not the
Moodle version.** From `webservice/externallib.php`:

```php
if ($function->component == 'moodle' || $function->component == 'core') {
    $version = $CFG->version;            // e.g. 2024100713 (4.5.13)
} else {
    include("<component dir>/version.php");
    $version = $plugin->version;          // e.g. 2024100700 for mod_assign in 4.5
}
```

Observed on the live 4.5.13 site: **[verified on 4.5.13]**

| `version` | Count | Which |
|---|---|---|
| `2024100713` | 176 | every `core_*` function (= `$CFG->version`, includes the `.13` point release) |
| `2024100700` | 239 | all core plugins shipped with 4.5.0 — `mod_*`, `tool_mobile_*`, `gradereport_*`, `enrol_*`, `block_*`, `message_*`, `aiplacement_*` (plugin versions are **not** bumped by point releases) |
| `2024100701` | 22 | `mod_feedback`, `tool_lp` (bumped once during the 4.5 series) |
| `2025111703`, `2026013100`, `2026010500`, `2025032001`, `2024042219` | 9 | third-party plugins (`local_intelliboard`, `mod_choicegroup`, `qtype_stack`, `mod_subcourse`, `mod_customcert`) |

So:

- The `version` value **cannot** be compared across components.
- For core functions it *is* `$CFG->version`, so it does double as a site-version
  signal — but `release`/`version` at the top level of `get_site_info` are the
  proper fields for that.
- A function whose `version` is far in the future relative to
  `get_site_info.version` is from a third-party plugin.

### 7.2 Feature-detection recipe

**Never branch on `release`.** Sites run point releases, distro forks and
back-ported plugins; the function set is what matters.

```python
info = call('core_webservice_get_site_info')
have = {f['name'] for f in info['functions']}
adv  = {a['name']: a['value'] for a in info.get('advancedfeatures', [])}

# 1. Is the function present at all?
if 'core_badges_get_badge' in have:        # 4.5+
    ...

# 2. Is the subsystem switched on?
if adv.get('enableglobalsearch'):
    call('core_search_get_results', query='x')

# 3. Are files usable?
if info['downloadfiles']:
    fetch(fileurl + '?token=' + TOKEN)
if info['uploadfiles']:
    upload(...)

# 4. Version floor, only as a last resort
major = tuple(int(x) for x in info['release'].split(' ')[0].split('.')[:2])
```

Unauthenticated pre-flight, before you even have a token:

```python
cfg = ajax_nologin('tool_mobile_get_public_config')
assert cfg['enablewebservices'] == 1
mobile_ok = cfg['enablemobilewebservice'] == 1
sso_only  = cfg['typeoflogin'] in (2, 3) or not cfg.get('showloginform', 1)
```

Signals worth caching per site: `wwwroot`, `enablemobilewebservice`,
`typeoflogin`, `launchurl`, `tool_mobile_qrcodetype`, `tool_mobile_disabledfeatures`,
plus, after auth, `functions[]`, `advancedfeatures`, `downloadfiles`,
`uploadfiles`, `usermaxuploadfilesize`, `userquota`.

### 7.3 Function-set diffs 3.9 → 5.0

Core only (`lib/db/services.php`), counted by definition entries in each stable
branch. Plugin functions (`mod_*`, `tool_*`, `gradereport_*`…) are not included.

| Branch | Core external functions |
|---|---|
| `MOODLE_39_STABLE` | 318 |
| `MOODLE_400_STABLE` | 338 |
| `MOODLE_401_STABLE` | 345 |
| `MOODLE_403_STABLE` | 374 |
| `MOODLE_405_STABLE` | 392 |
| `MOODLE_500_STABLE` | 398 |

**3.9 → 4.0** — +35, **−15**. The big one: the entire legacy messaging API was
removed after a long deprecation.

*Removed in 4.0:* `core_enrol_edit_user_enrolment`, `core_grades_get_grades`,
`core_message_block_contacts`, `core_message_create_contacts`,
`core_message_data_for_messagearea_contacts`,
`core_message_data_for_messagearea_conversations`,
`core_message_data_for_messagearea_get_most_recent_message`,
`core_message_data_for_messagearea_get_profile`,
`core_message_data_for_messagearea_messages`,
`core_message_data_for_messagearea_search_users`,
`core_message_data_for_messagearea_search_users_in_course`,
`core_message_delete_conversation`, `core_message_get_contacts`,
`core_message_mark_all_messages_as_read`, `core_message_unblock_contacts`.

> Migration map: `get_contacts` → `core_message_get_user_contacts`;
> `create_contacts` → `core_message_create_contact_request`;
> `block_contacts`/`unblock_contacts` → `core_message_block_user`/`unblock_user`;
> `delete_conversation` → `core_message_delete_conversations_by_id`;
> `mark_all_messages_as_read` → `core_message_mark_all_conversation_messages_as_read`;
> `data_for_messagearea_*` → the `core_message_get_conversation*` family;
> `core_grades_get_grades` → `gradereport_user_get_grade_items`;
> `core_enrol_edit_user_enrolment` → `core_enrol_submit_user_enrolment_form`.

*Added in 4.0:* the whole `core_reportbuilder_*` editing API (20 functions),
`core_courseformat_get_state`, `core_courseformat_update_course`,
`core_course_get_enrolled_courses_with_action_events_by_timeline_classification`,
`core_block_fetch_addable_blocks`, `core_calendar_get_calendar_export_token`,
`core_calendar_delete_subscription`, `core_change_editmode`,
`core_contentbank_set_content_visibility`, `core_dynamic_tabs_get_content`,
`core_files_delete_draft_files`, `core_files_get_unused_draft_itemid`,
`core_form_dynamic_form`, `core_message_get_unread_notification_count`,
`core_payment_get_available_gateways`, `core_user_search_identity`.
Also: **XML-RPC removed** (`webservice/xmlrpc/` gone from 4.1; still present in
4.0 — the removal lands in 4.1). `moodlewssettingtimezone` added.

**4.0 → 4.1** — +7, −0: `core_grades_get_gradable_users`,
`core_grades_get_groups_for_search_widget`, `core_reportbuilder_list_reports`,
`core_reportbuilder_retrieve_report`, `core_reportbuilder_set_filters`,
`core_reportbuilder_view_report`, `core_user_update_user_device_public_key`.
**`/webservice/xmlrpc/server.php` returns 404 from 4.1.**

**4.1 → 4.3** (via 4.2) — +29, −0. Notables:
`core_search_get_results`, `core_search_get_search_areas_list`,
`core_search_get_top_results`, `core_search_view_results` (search finally
reachable over WS); the `core_xapi_*_state*` family (5);
`core_grades_get_gradeitems`, `core_grades_get_grade_tree`,
`core_grades_get_feedback`, `core_grades_get_groups_for_selector`;
`core_group_get_groups_for_selector`; `core_badges_get_user_badge_by_hash`;
`core_moodlenet_*` (5); `core_my_view_page`; `core_courseformat_file_handlers`;
`core_reportbuilder_can_view_system_report`,
`core_reportbuilder_retrieve_system_report`; `core_admin_set_plugin_state` /
`set_plugin_order` / `set_block_protection`; `core_backup_get_async_backup_links_restore`;
`core_contentbank_copy_content`.

**4.3 → 4.5** (via 4.4) — +19, **−1**.
*Added:* `core_ai_get_policy_status`, `core_ai_set_policy_status`,
`core_ai_set_action`; `core_badges_get_badge`, `core_badges_enable_badges`,
`core_badges_disable_badges`; the writable blog API
(`core_blog_add_entry`, `update_entry`, `delete_entry`,
`prepare_entry_for_edition`, `get_access_information`);
`core_check_get_result_admintree`; `core_courseformat_create_module`,
`core_courseformat_new_module`; `core_filters_get_all_states`;
`core_output_poll_stored_progress`; `core_sms_set_gateway_status`;
`core_user_prepare_private_files_for_edition`, `core_user_update_private_files`.
*Removed:* `core_question_submit_tags_form`.
Also in 4.5: core exception classes moved to the `core\exception\` namespace, so
the `exception` field in error payloads changed string value (see §2.2).

**4.5 → 5.0** — +8, **−2**.
*Added:* `core_ai_delete_provider_instance`, `core_ai_set_provider_order`,
`core_ai_set_provider_status`, `core_message_get_unsent_message`,
`core_message_set_unsent_message`, `core_message_set_default_notification`,
`core_question_move_questions`, `core_question_search_shared_banks`.
*Removed:* `core_grades_get_groups_for_search_widget` (superseded by
`core_grades_get_groups_for_selector`), `core_output_load_fontawesome_icon_map`
(superseded by `core_output_load_fontawesome_icon_system_map`).
SOAP is still present in 5.0 but **removed on `main`** (post-5.0), so plan for
REST-only.

### 7.4 Deprecation policy

Moodle's rule (<https://moodledev.io/general/development/policies/deprecation>)
for external functions specifically:

1. **Mark**: add `<methodname>_is_deprecated()` returning `true`, and (older
   style) a `@deprecated since X.Y` PHPDoc tag. The function keeps working.
   `external_function_info()` sets `$function->deprecated = true`, which the
   admin UI and the WS documentation page surface.
2. **Wait**: the function must remain for at least **4 major releases** (~1 year
   under the current 2-per-year cadence; historically stated as "one year").
   External functions are held to a *stricter* bar than internal APIs precisely
   because third-party clients depend on them.
3. **Remove**: delete the entry from `db/services.php` and the implementation.
   The upgrade step drops it from `external_functions` and every service.

Practical consequences:

- **A deprecated function is invisible over the wire.** `get_site_info` does not
  expose the deprecated flag; there is no `deprecated` field in
  `functions[]`. You only learn about it from release notes or the site's WS
  documentation page. Track the upgrade notes at
  <https://moodledev.io/docs/devupdate> per release.
- **Removal is a hard break**: calling a removed name yields
  `errorcode: invalidrecord`, indistinguishable from a typo. Always
  feature-detect against `get_site_info.functions` rather than assuming.
- **Return-value additions are not versioned.** Fields are added to
  `*_returns()` structures freely between releases (e.g. `courseimage`,
  `showactivitydates`, `pdfexportfont`, `activitybadge`, `branded`, `purpose`
  all appeared in the 4.x series). Parse permissively: ignore unknown keys,
  never assume a `VALUE_OPTIONAL` key is present.
- **`0`, `null`, `""` and "key absent" are all distinct** and the choice between
  them has changed for individual fields across releases. Normalise on ingest.
- Parameters are only ever *added* with a `VALUE_DEFAULT`, never removed or
  reordered — the positional `call_user_func_array` in `call_external_function`
  makes reordering a breaking change core avoids.

---

## 8. Appendix: verified request/response transcripts

All against `https://moodle.tuni.fi` (Moodle **4.5.13**, `2024100713`),
`moodle_mobile_app` token, non-admin student. `$T` = token.

**Handshake**

```bash
curl -sS "$W/webservice/rest/server.php" \
  -d "wstoken=$T" -d "moodlewsrestformat=json" \
  -d "wsfunction=core_webservice_get_site_info"
# → {"sitename":"…","userid":135266,"release":"4.5.13 (Build: 20260810)",
#    "version":"2024100713","downloadfiles":1,"uploadfiles":1,
#    "userprivateaccesskey":"a54703e0…","functions":[{…}×450],"advancedfeatures":[…]}
```

**Error taxonomy** (all HTTP 200)

```bash
# unknown function
-d wsfunction=core_nonexistent_function
→ {"exception":"dml_missing_record_exception","errorcode":"invalidrecord",
   "message":"Can't find data record in database table external_functions."}

# no wsfunction at all
→ {"exception":"core\\exception\\invalid_parameter_exception",
   "errorcode":"invalidparameter","message":"Invalid parameter value detected"}

# bad token
-d wstoken=deadbeef
→ {"exception":"core\\exception\\moodle_exception","errorcode":"invalidtoken",
   "message":"Virheellinen avain - avainta ei löytynyt"}      # site language!

# function not in the token's service
-d wsfunction=core_user_create_users
→ {"exception":"webservice_access_exception","errorcode":"accessexception",
   "message":"Access control exception"}

# missing / mistyped parameter
-d wsfunction=core_course_get_contents            (no courseid)
-d wsfunction=core_course_get_contents -d courseid=abc
→ {"errorcode":"invalidparameter", …} in both cases

# function-level option whitelist
-d wsfunction=core_course_get_contents -d courseid=58849 \
  -d 'options[0][name]=bogus' -d 'options[0][value]=1'
→ {"exception":"core\\exception\\moodle_exception","errorcode":"errorinvalidparam",
   "message":"The param \"bogus\" is invalid."}

# no moodlewsrestformat → XML
→ <?xml version="1.0" encoding="UTF-8" ?>\n<RESPONSE>\n<SINGLE>\n<KEY name="sitename">…
```

**Unauthenticated probe**

```bash
curl -sS "$W/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config" \
  -H 'Content-Type: application/json' \
  -d '[{"index":0,"methodname":"tool_mobile_get_public_config","args":{}}]'
# → [{"error":false,"data":{"wwwroot":"…","enablewebservices":1,
#     "enablemobilewebservice":1,"typeoflogin":2,"launchurl":"…/launch.php",
#     "identityproviders":[{"name":"Kirjaudu TUNI tunnuksella","url":"…/auth/shibboleth/index.php"}],
#     "tool_mobile_qrcodetype":2,"showloginform":1,…}}]

# same function over REST with an empty token → invalidtoken
```

**AJAX endpoints reject the wrong kind of function**

```bash
curl -sS "$W/lib/ajax/service.php?sesskey=xxxx&info=core_course_get_contents" \
  -H 'Content-Type: application/json' \
  -d '[{"index":0,"methodname":"core_course_get_contents","args":{"courseid":58849}}]'
# → [{"error":true,"exception":{"errorcode":"servicenotavailable",
#     "moreinfourl":"https://docs.moodle.org/405/fi/error/webservice/servicenotavailable"}}]
#   (core_course_get_contents is ajax => false)
```

*(Parameter flattening, boolean/null handling and the `moodlewssetting*` transcripts are inline in §4.1–§4.3.)*

**JSON bodies are ignored by REST**

```bash
curl -sS "$W/webservice/rest/server.php?wstoken=$T&moodlewsrestformat=json&wsfunction=core_enrol_get_users_courses" \
  -H 'Content-Type: application/json' -d '{"userid":135266}'
# → {"errorcode":"invalidparameter"}   (userid never arrived)
```

**Batching**

```bash
-d "wsfunction=tool_mobile_call_external_functions" \
-d "requests[0][function]=core_user_create_users" -d "requests[0][arguments]={}" \
-d "requests[1][function]=core_webservice_get_site_info"
# → {"responses":[{"error":true,
#      "exception":"{\"errorcode\":\"accessexception\",\"module\":\"webservice\"}"}]}
#   note: only ONE response — processing stopped at the first error
```

**Files**

```bash
U="$W/webservice/pluginfile.php/5074700/course/overviewfiles/data100.jpg"
curl "$U"                          # 200 application/json  {"errorcode":"missingparam"}
curl "$U?token=$T"                 # 200 image/jpeg  139362 bytes
curl -H "Authorization: $T" "$U"   # 200 application/json  {"errorcode":"invalidtoken"}
curl -D- "$U?token=$T&forcedownload=1" | grep -i content-disposition
                                   # Content-Disposition: inline  ← forcedownload ignored
curl "$U?token=deadbeef"           # {"error":"…","errorcode":"invalidtoken","stacktrace":null,…}

K=<userprivateaccesskey from get_site_info>
curl "$W/tokenpluginfile.php/$K/5074700/course/overviewfiles/data100.jpg"   # 200 image/jpeg
curl "$W/tokenpluginfile.php/5074700/course/overviewfiles/data100.jpg?token=$K"  # 404
```

**Token endpoints**

```bash
curl "$W/login/token.php?appsitecheck=1"        → {"appsitecheck":"ok"}
curl "$W/login/token.php"                       → {"errorcode":"missingparam", "error":"…(username)…"}
curl "$W/login/token.php" -d username=nobody -d password=x -d service=moodle_mobile_app
                                                → {"errorcode":"invalidlogin"}
curl "$W/login/token.php" -d username=nobody -d password=x -d service=does_not_exist
                                                → {"errorcode":"invalidlogin"}   # auth runs first

curl "$W/admin/tool/mobile/launch.php?service=nope&passport=1234"
                                                → HTML error page, servicenotavailable
curl "$W/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=1234&urlscheme=9bad"
                                                → "Invalid parameter: the value of urlscheme isn't valid…"
curl "$W/admin/tool/mobile/launch.php?service=moodle_mobile_app"      # no passport
                                                → HTML error page (missing required param)
```

**Warnings, not failures**

```bash
-d "wsfunction=core_course_get_courses_by_field" -d "field=ids" -d "value=49939"
# → {"courses":[{…}],"warnings":[{"item":"course","itemid":49939,
#     "warningcode":"1","message":"No access rights in course context"}]}
#   HTTP 200, error:false — the course IS returned, partially.

-d "wsfunction=core_calendar_get_calendar_events" -d "events[courseids][0]=999999" …
# → {"events":[],"warnings":[{"item":"course","itemid":999999,
#     "warningcode":"nopermissions","message":"No access rights in course context
#      Can't find data record … #0 /var/moodle/…"}]}
#   ← note the leaked stack trace: this site runs with debugging on.
```

**Endpoint availability on 4.5.13**

```
/webservice/rest/server.php    → 200
/webservice/soap/server.php    → 200
/webservice/xmlrpc/server.php  → 404   (removed in 4.1)
```

---

### Source index

| Claim area | File(s) read (`MOODLE_405_STABLE`) |
|---|---|
| external function registration, the gate, validation | `lib/external/classes/external_api.php` |
| description classes | `lib/external/classes/external_{value,single_structure,function_parameters,warnings,settings}.php`, `lib/moodlelib.php` (constants) |
| token auth, service checks, protocol servers | `webservice/lib.php`, `webservice/rest/server.php`, `webservice/rest/locallib.php` |
| token minting / reuse | `lib/external/classes/util.php`, `login/token.php`, `user/managetoken.php`, `admin/settings/security.php` |
| AJAX transports | `lib/ajax/service.php`, `lib/ajax/service-nologin.php` |
| mobile SSO, autologin, QR, public config | `admin/tool/mobile/launch.php`, `admin/tool/mobile/classes/api.php`, `admin/tool/mobile/classes/external.php`, `admin/tool/mobile/db/services.php` |
| batching | `admin/tool/mobile/classes/external.php` |
| files | `webservice/pluginfile.php`, `tokenpluginfile.php`, `webservice/upload.php` |
| function catalogue & flags | `lib/db/services.php`, `{course,enrol,user,calendar,message,files,group,notes,webservice}/externallib.php`, `completion/classes/external.php`, `blog/classes/external.php`, `grade/report/*/`, `enrol/*/`, `blocks/*/`, `message/output/*/db/services.php` |
| version diffs | `lib/db/services.php` on `MOODLE_{39,400,401,403,405,500}_STABLE` |
| `typeoflogin` / QR enums client side | moodleapp `src/core/classes/sites/unauthenticated-site.ts` (`main`), `src/core/constants.ts` (`v4.5.0`) |
| docs | moodledev.io `/docs/apis/subsystems/external/{,functions,writing-a-service,security}`, `/general/development/policies/deprecation` |
