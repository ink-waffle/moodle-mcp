# Moodle core data model and subsystems

**Purpose.** This is a reference for engineers and AI agents building integrations against
*arbitrary* Moodle sites. It explains the schema and the concepts behind it, so that when a
web-service response looks strange you know *why*. Everything below is written against
**Moodle 4.5 LTS** (branch `MOODLE_405_STABLE`, `$CFG->version` 2024100713).

Claims marked **[verified 4.5.13]** were confirmed by live read-only web-service calls against a
production Moodle 4.5.13 (Build 20260810) — a large multi-faculty university site. Claims marked
**[source]** come from reading the 4.5 source tree; the file path is given. Where something could
not be confirmed live it says so explicitly.

## What this covers / what lives elsewhere

| Doc | Covers |
|---|---|
| **this file — `data-model.md`** | Identity/ID semantics, contexts & capabilities, course structure, availability, enrolment, gradebook, completion, calendar, groups, files, text formats, users |
| `web-services-api.md` | The external API itself: endpoints, tokens, auth, REST/JSON conventions, `moodlews*` settings, function catalogue, error/exception shapes |
| `activity-modules.md` | Per-module tables and state machines: `assign`, `quiz`, `forum`, `workshop`, `lesson`, `choice`, `lti`, `resource`, `page`, `subsection`, … |
| `integration-cookbook.md` | Practical recipes, known pitfalls, debugging, rate/permission workarounds |

When this doc mentions a specific web-service function it does so only to illustrate a *data-model*
point; look up its parameters and return schema in `web-services-api.md`.

## Table of contents

1. [Identity of things — the ID table](#1-identity-of-things--the-id-table)
2. [Contexts, roles and capabilities](#2-contexts-roles-and-capabilities)
3. [Course structure](#3-course-structure)
4. [Availability and access restrictions](#4-availability-and-access-restrictions)
5. [Enrolment](#5-enrolment)
6. [The gradebook](#6-the-gradebook)
7. [Activity completion and course completion](#7-activity-completion-and-course-completion)
8. [Calendar and events](#8-calendar-and-events)
9. [Groups and groupings](#9-groups-and-groupings)
10. [The Files API](#10-the-files-api)
11. [Text formats and filters](#11-text-formats-and-filters)
12. [Users, profile fields and preferences](#12-users-profile-fields-and-preferences)
13. [Appendix A — constant reference](#appendix-a--constant-reference)
14. [Appendix B — what was verified live](#appendix-b--what-was-verified-live)

Conventions: Moodle table names are written without the site prefix (`{course_modules}` in Moodle
SQL, `mdl_course_modules` on a default install). Every core table has an `id` `BIGINT` autoincrement
primary key unless stated. Timestamps are UNIX epoch seconds in `INT(10)` columns; `0` conventionally
means "unset", not 1970.

---

# 1. Identity of things — the ID table

**This is the single largest source of integration bugs.** Moodle has at least five different
integer identifiers that all describe "an activity", and the external API is inconsistent about
which one it hands you and what it calls it.

## 1.1 The five identities of one activity

Take one assignment sitting in a course. It simultaneously has:

```
{course_modules}.id      = 4445248   "cmid"      — the activity's identity ON THE COURSE PAGE
{assign}.id              = 284465    "instance"  — the assignment's identity IN ITS OWN TABLE
{context}.id             = 6388018   "contextid" — the security/file container for that activity
{grade_items}.id         = 476878    "gradeitemid" — the gradebook column it feeds
{course_sections}.id     = 738168    "sectionid" — the section row it lives in (NOT the section number)
```

`course_modules` is the *join table* between a course and a module instance:

```
course_modules.id       -> the cmid; what /mod/assign/view.php?id=... takes
course_modules.course   -> course.id
course_modules.module   -> modules.id  (a per-site integer for the module TYPE, e.g. 40 = subsection)
course_modules.instance -> the primary key in the module's own table ({assign}.id, {quiz}.id, …)
course_modules.section  -> course_sections.id
```

`modules.id` is **site-specific**. Never hard-code it. Resolve `modules.name` (`'assign'`, `'quiz'`,
`'subsection'`, …) instead — the external API already does this for you and gives you `modname`.
[verified 4.5.13] on the sample site `subsection` happened to be `modules.id = 40`; on another site
it will differ.

## 1.2 The mapping table

| What the API calls it | Underlying column | What it identifies | Notes |
|---|---|---|---|
| `id` (inside `modules[]` of `core_course_get_contents`) | `course_modules.id` | **cmid** | The one you put in `/mod/x/view.php?id=` |
| `cmid` | `course_modules.id` | cmid | Used by completion, `core_course_get_course_module`, `gradereport_user_get_grade_items` |
| `coursemodule` | `course_modules.id` | cmid | Used by `mod_*_get_*_by_courses` return structures |
| `coursemoduleid` | `course_modules.id` | cmid | DB column name in `course_modules_completion`, `course_modules_viewed` |
| `instance` (in `core_course_get_contents`) | `course_modules.instance` | module instance id | e.g. `{assign}.id` |
| `instance` (in `core_calendar_get_calendar_events`) | `event.instance` | module instance id | matches the above |
| `instance` (in `core_calendar_get_action_events_by_*`) | **`course_modules.id`** | **cmid** | ⚠️ *same key name, different meaning* — see §1.3 |
| `iteminstance` (gradebook) | `grade_items.iteminstance` | module instance id when `itemtype='mod'`; **`grade_categories.id`** when `itemtype` is `category` or `course` | |
| `contextid` | `context.id` | the module/course/etc. context | needed for `pluginfile.php` URLs |
| `courseid` / `course` | `course.id` | a course | site/front page is `course.id = 1` (`SITEID`) |
| `categoryid` / `category` (course) | `course.category` → `course_categories.id` | a course category | |
| `categoryid` (gradebook item) | `grade_items.categoryid` → `grade_categories.id` | the grade category the item is *inside* | `null` for category/course total rows |
| `section` (in `core_course_get_contents` section objects) | `course_sections.section` | the **section NUMBER** (0,1,2,…) | |
| `id` (in `core_course_get_contents` section objects) | `course_sections.id` | the **section ROW id** | |
| `section` (in `core_course_get_course_module`) | `course_sections.id` | the section ROW id | |
| `sectionnum` (in `core_course_get_course_module`) | `course_sections.section` | the section NUMBER | |
| `userid` / `id` (user records) | `user.id` | a user | site-wide, stable |
| `itemid` (files) | `files.itemid` | plugin-defined sub-key of a file area | often 0, often a post/submission id |
| `itemid` (course section, 4.5+) | `course_sections.itemid` | the delegating plugin's instance id | see §3.6 |
| `groupid` | `groups.id` | a group | course-scoped |
| `groupingid` | `groupings.id` | a grouping | course-scoped |
| `roleid` | `role.id` | a role definition | site-wide; 1..8 on a default install but **not guaranteed** |
| `enrolid` | `enrol.id` | an *enrolment instance* (a plugin configured in one course) | not a plugin name |
| `id` in `user_enrolments` | `user_enrolments.id` | one user's enrolment via one instance | |

## 1.3 The calendar `instance` trap — verified

The exact same calendar event, fetched by two different functions, returns two different values
under the key `instance`. [verified 4.5.13]

```jsonc
// core_calendar_get_calendar_events  -> "raw"-ish event record
{ "id": 2133415, "modulename": "assign", "eventtype": "due",
  "instance": 284465,        // <-- {assign}.id   (event.instance column)
  "timestart": 1788469200 }

// core_calendar_get_action_events_by_timesort  -> exported action event
{ "id": 2133415, "modulename": "assign", "eventtype": "due",
  "instance": 4445248,       // <-- course_modules.id  (the CMID!)
  "url": "https://…/mod/assign/view.php?id=4445248",
  "timesort": 1788469200, "overdue": false }
```

[source] `calendar/classes/external/event_exporter_base.php`, constructor:

```php
if ($cm = $event->get_course_module()) {
    $data->modulename = $cm->get('modname');
    $data->instance   = $cm->get('id');      // cm_info::id === course_modules.id
    $data->activityname = $cm->get('name');
```

Rule of thumb: **if the payload also contains a `url` pointing at `/mod/…/view.php?id=N`, then
`instance == N == cmid`.** If it is a bare event record from the `event` table, `instance` is the
module instance id.

## 1.4 Getting from one id to another

| From | To | How |
|---|---|---|
| cmid | everything else | `core_course_get_course_module(cmid)` → returns `course`, `module`, `modname`, `instance`, `section` (row id), `sectionnum` |
| modname + instance | cmid | `core_course_get_course_module_by_instance(module, instance)` |
| courseid | all cmids + instances | `core_course_get_contents(courseid)` |
| cmid | contextid | `core_course_get_contents` gives `contextid` per module; otherwise `context_module::instance(cmid)` server-side |
| cmid | grade item | `gradereport_user_get_grade_items` returns `cmid` on `itemtype='mod'` rows |
| grade item | cmid | same call, or `grade_items.itemmodule` + `iteminstance` → `course_modules` where `module = modules.id(itemmodule)` |

There is no core web service that maps an arbitrary `contextid` back to a cmid; you must build the
map from `core_course_get_contents`.

## 1.5 ID stability

* `user.id`, `course.id`, `course_modules.id`, `context.id` are stable for the life of the object on
  one site. They are **not** stable across sites, backups or restores.
* Restoring a course produces entirely new `course_modules.id`, `context.id`, `grade_items.id`,
  `course_sections.id`. `course.idnumber`, `course_modules.idnumber` and `grade_items.idnumber` are
  the human-assigned, restore-surviving keys — a well-run institution populates them (the sample
  site sets `course.idnumber` to a Sisu/Peppi course-realisation UUID and `grade_items.idnumber` to
  short codes like `hw0`, `f50`, `totalpoints` [verified 4.5.13]).
* Deleting an activity removes the `course_modules` row and its `context` row; the `context.id` is
  never reused, so a stale cmid gives "Invalid course module ID", not someone else's activity.
* `course_modules.deletioninprogress = 1` marks an activity queued for asynchronous deletion. It is
  still in the table but must be treated as gone.

---

# 2. Contexts, roles and capabilities

Everything about "may user U do thing T" in Moodle is `has_capability($capability, $context, $user)`.
Understanding the two halves — the context tree and the permission aggregation — explains almost
every `nopermissions` exception you will ever get from the API.

Reference: <https://moodledev.io/docs/apis/subsystems/access>, source `lib/accesslib.php`,
`lib/classes/context.php` and the `lib/classes/context/*.php` subclasses.

## 2.1 The context tree

`{context}`:

| Column | Type | Meaning |
|---|---|---|
| `id` | int | The **contextid** used everywhere (file URLs, role assignments, capability overrides) |
| `contextlevel` | int | One of the `CONTEXT_*` constants below |
| `instanceid` | int | The id of the thing at that level (`course.id`, `course_modules.id`, `user.id`, …) |
| `path` | char(255) | `/`-separated list of **context ids** from the system context down to *and including* this one, e.g. `/1/25/9188/6345135` |
| `depth` | int | number of segments in `path` |
| `locked` | int | 1 = this context and its children are "locked": all `write` capabilities are denied (4.0+) |

Unique index on `(contextlevel, instanceid)`.

| Constant | Value | `instanceid` points at | Parent |
|---|---|---|---|
| `CONTEXT_SYSTEM` | 10 | `0` (there is exactly one, normally `context.id = 1`) | — |
| `CONTEXT_USER` | 30 | `user.id` | system |
| `CONTEXT_COURSECAT` | 40 | `course_categories.id` | system or parent category |
| `CONTEXT_COURSE` | 50 | `course.id` | its category (front page course id 1 hangs off system) |
| `CONTEXT_MODULE` | 70 | `course_modules.id` (the **cmid**) | its course |
| `CONTEXT_BLOCK` | 80 | `block_instances.id` | whatever the block is placed in |

[source] `lib/accesslib.php` lines 113–136. Note there is no context level 20 or 60 — the numbering
has gaps deliberately, so third parties could insert levels. `CONTEXT_USER` (30) sits **directly
under the system context**, *not* under any course: a user context is where a user's private files,
blogs and personal preferences live, and it is why "view this user's profile" permissions behave
differently from "view this course's participants".

Two consequences that bite integrators:

* **A module context's parent is the course, never the section.** Sections have no context. Section
  visibility is enforced by course-level logic, not by the context tree.
* **`context.path` is a path of context ids, not of course/category ids.** Do not try to parse
  course ids out of it.

`context_helper::preload_from_record()` and `context::get_parent_context_ids()` walk it:

```php
// lib/classes/context.php
public function get_parent_context_ids($includeself = false) {
    $parentcontexts = trim($this->_path, '/');
    $parentcontexts = explode('/', $parentcontexts);
    if (!$includeself) { array_pop($parentcontexts); }
    return array_reverse($parentcontexts);   // bottom-up
}
```

## 2.2 Roles

`{role}`: `id`, `name` (may be empty → the localised archetype name is used), `shortname` (unique),
`description`, `sortorder` (unique), `archetype`.

A **default install** ships these, and most sites keep them, but *nothing in the code guarantees the
ids* — always resolve by `shortname`:

| shortname | archetype | typical id | Assignable at |
|---|---|---|---|
| `manager` | manager | 1 | system, category, course |
| `coursecreator` | coursecreator | 2 | system, category |
| `editingteacher` | editingteacher | 3 | course, module |
| `teacher` (non-editing) | teacher | 4 | course, module |
| `student` | student | 5 | course, module |
| `guest` | guest | 6 | (not assignable) |
| `user` | user | 7 | (the "authenticated user" role, assigned implicitly site-wide) |
| `frontpage` | frontpage | 8 | (the "authenticated user on front page" role) |

[verified 4.5.13] `core_enrol_get_enrolled_users` returned `{"roleid":3,"shortname":"editingteacher"}`
and `{"roleid":5,"shortname":"student"}` with `"name": ""` — the empty `name` means "not renamed in
this context, use the standard localised string". Renames live in `{role_names}` keyed by
`(roleid, contextid)`.

`role.archetype` is **not** a live permission source: it is the template used when the role is
created or reset (`admin/roles/…`). Sites freely edit the resulting permissions afterwards, so
"student archetype allows X" only tells you the default.

`{role_context_levels}` (`roleid`, `contextlevel`) restricts *where* a role may be assigned.

`{role_allow_assign}`, `{role_allow_override}`, `{role_allow_switch}`, `{role_allow_view}` control
which roles may act on which other roles.

## 2.3 Role assignments

`{role_assignments}`: `roleid`, `contextid`, `userid`, `component`, `itemid`, `timemodified`,
`modifierid`, `sortorder`.

* A role is assigned **in a context**, and applies to that context *and everything below it*. A
  `manager` assigned at a category context is a manager in every course in that category.
* `component` + `itemid` say *who* made the assignment: empty component = assigned manually;
  `'enrol_manual'` / `'enrol_lti'` / `'enrol_self'` etc. with `itemid = enrol.id` = created
  automatically by an enrolment instance. Those cannot be removed through the normal UI.
* A user can hold several roles in the same context; permissions from all of them aggregate.
* **Role assignment ≠ enrolment.** They are separate tables and separate concepts. A user with a
  `teacher` role assignment at course level but no `user_enrolments` row is *not* enrolled: they will
  not appear in participants lists or the gradebook, and `enrol_get_users_courses` will not return
  the course. Conversely an enrolment without a role assignment (possible with meta/LTI plugins)
  gives a user access with no permissions beyond the site-wide authenticated-user role. See §5.

## 2.4 Capabilities

`{capabilities}`: `name` (`moodle/course:view`, `mod/assign:submit`, `gradereport/user:view`, …),
`captype` (`read` | `write`), `contextlevel` (the *lowest* level at which the capability makes
sense), `component`, `riskbitmask`.

`{role_capabilities}`: `(roleid, contextid, capability, permission)`, unique on the first three.
`permission` is one of:

| Constant | Value | Meaning |
|---|---|---|
| `CAP_INHERIT` | 0 | "Not set" — take whatever the parent context says |
| `CAP_ALLOW` | 1 | Allow |
| `CAP_PREVENT` | -1 | Deny *unless* another role allows it |
| `CAP_PROHIBIT` | -1000 | Deny, absolutely, and nothing can override it anywhere below |

Rows at `contextid` = system context are the role *definition*; rows at any lower context are
*overrides*.

`riskbitmask` flags what a capability lets you do wrong — `RISK_MANAGETRUST` 0x1, `RISK_CONFIG` 0x2,
`RISK_XSS` 0x4, `RISK_PERSONAL` 0x8, `RISK_SPAM` 0x10, `RISK_DATALOSS` 0x20.

## 2.5 Permission resolution — the actual algorithm

[source] `lib/accesslib.php::has_capability_in_accessdata()`:

1. Build `$paths` = this context's path plus every ancestor path, **bottom-up**
   (`/1/25/9188/6345135`, `/1/25/9188`, `/1/25`, `/1`).
2. Collect every role the user holds at any of those paths → `$roles`.
3. For each role, walk `$paths` bottom-up and take the **first** (i.e. most specific) explicit
   permission found for the capability. That is that role's verdict.
   * If **any** role's verdict anywhere is `CAP_PROHIBIT`, return `false` immediately.
4. Return `true` iff **at least one** role's verdict is `CAP_ALLOW`.

So the aggregation is: *most-specific-wins per role*, then *OR across roles*, with `CAP_PROHIBIT` as
a hard veto. `CAP_PREVENT` only removes that role's allow — a second role that allows still wins.

Two short-circuits happen before all of this, in `has_capability()`:

* Site administrators (`$CFG->siteadmins`, a comma-separated list of user ids in `{config}`) get
  `true` for everything unless `$doanything = false`. Admin-ness is **not** a role — it is a config
  setting. There is no `moodle/site:doanything` capability any more.
* Guests and not-logged-in users are hard-denied any capability that is `captype = 'write'` or
  carries `RISK_XSS | RISK_CONFIG | RISK_DATALOSS`, whatever the roles say.
* If `$CFG->contextlocking` is on and `context.locked = 1`, every `write` capability is denied in
  that context and below (except `moodle/site:managecontextlocks`).

`require_capability($cap, $context)` is `has_capability()` plus `throw new
required_capability_exception(...)`. Over the web-service layer that surfaces as:

```json
{"exception":"core\\exception\\required_capability_exception",
 "errorcode":"nopermissions",
 "message":"Sorry, but you do not currently have permissions to do that (View grades of other users)."}
```

[verified 4.5.13] — this is exactly what `gradereport_user_get_grade_items` returns if you omit
`userid` (it then defaults to "all users" and demands `moodle/grade:viewall`). Note the class name
is namespaced `core\exception\...` in 4.5; older sites emit `required_capability_exception`
unnamespaced. Match on `errorcode`, not on `exception`.

## 2.6 What a typical student can and cannot do

The single most surprising fact:

> **`moodle/course:view` is NOT granted to students.** Its only default archetype is `manager`.

[source] `lib/db/access.php`:

```php
'moodle/course:view' => array(
    'captype' => 'read',
    'contextlevel' => CONTEXT_COURSE,
    'archetypes' => array('manager' => CAP_ALLOW,)
),
```

`moodle/course:view` means *"can enter this course **without being enrolled**"*. Students get into a
course through **enrolment** (`is_enrolled()`), not through this capability. If your integration
tests "can this user see the course?" with `moodle/course:view`, it will say *no* for every legitimate
student on the site. Test enrolment instead (`enrol_get_users_courses`, or `core_course_get_contents`
succeeding).

Default archetype grants for the capabilities that matter to integrations, straight from
`lib/db/access.php` (4.5):

| Capability | captype | contextlevel | Default archetypes | Notes |
|---|---|---|---|---|
| `moodle/course:view` | read | COURSE | manager | "enter without enrolment" — **not** students |
| `moodle/course:viewparticipants` | read | COURSE | student, teacher, editingteacher, manager | |
| `moodle/course:viewhiddencourses` | read | COURSE | *(none)* — teacher/manager via role edits | gates hidden courses in "my courses" |
| `moodle/course:viewhiddensections` | read | COURSE | *(none by archetype)* | teachers get it in the shipped role definitions |
| `moodle/course:viewhiddenactivities` | read | **MODULE** | teacher, editingteacher, manager | drives `uservisible` on hidden activities |
| `moodle/course:isincompletionreports` | read | COURSE | **student** | if a user lacks this they are not "tracked" for completion (§7) |
| `moodle/course:togglecompletion` | write | MODULE | user | lets a user tick manual completion |
| `moodle/course:overridecompletion` | write | COURSE | *(none)* | teachers, via role definition |
| `moodle/course:manageactivities` | write | MODULE | *(none by archetype)* | editingteacher in shipped roles; `RISK_XSS` |
| `moodle/grade:view` | read | COURSE | **student** | "see my own grades" |
| `moodle/grade:viewall` | read | COURSE | teacher, editingteacher, manager | `RISK_PERSONAL`; needed to read other users' grades |
| `moodle/grade:viewhidden` | read | COURSE | teacher, editingteacher, manager | `RISK_PERSONAL`; see hidden grade items/grades |
| `moodle/site:accessallgroups` | read | **MODULE** | editingteacher, manager | bypasses SEPARATEGROUPS filtering (§9) |
| `moodle/site:viewuseridentity` | read | MODULE | *(none by archetype)* | controls whether email/idnumber appear in user lists |
| `moodle/user:viewdetails` | read | COURSE | guest, student, teacher, editingteacher, manager | course-scoped profile |
| `moodle/user:viewalldetails` | read | **USER** | manager | full profile in the user context |
| `moodle/calendar:manageownentries` | write | COURSE | user, manager | `RISK_SPAM` |
| `moodle/calendar:manageentries` | write | COURSE | *(none by archetype)* | course events; teachers in shipped roles |
| `moodle/calendar:managegroupentries` | write | COURSE | *(none by archetype)* | group events |
| `moodle/webservice:createtoken` | write | **SYSTEM** | manager | `RISK_CONFIG\|DATALOSS\|SPAM\|PERSONAL\|XSS` — create a token for **any** service |
| `moodle/webservice:createmobiletoken` | write | **SYSTEM** | **user** | `RISK_SPAM\|PERSONAL` — this is why every ordinary user can mint a Moodle-app token |
| `moodle/webservice:managealltokens` | write | SYSTEM | *(none)* | admin-level token management |
| `moodle/site:config` | write | SYSTEM | *(none)* | admin only, all five risks |

The `moodle/webservice:createmobiletoken` / `moodle/webservice:createtoken` split is the whole story
behind why integrations usually authenticate as the Moodle *mobile* service: ordinary users can mint
that token themselves, but only managers can mint an arbitrary-service token. Details in
`web-services-api.md`.

## 2.7 Probing permissions from outside

You cannot call `has_capability` remotely. Instead there are small "access information" services that
tell you the results of the checks a given report/page would perform. [verified 4.5.13], called as an
ordinary enrolled student:

```jsonc
// gradereport_user_get_access_information (courseid=42767)
{"canviewusergradereport": true, "canviewmygrades": true, "canviewallgrades": false}

// core_calendar_get_calendar_access_information (courseid=58630)
{"canmanageentries": false, "canmanageownentries": true, "canmanagegroupentries": false}

// core_calendar_get_allowed_event_types (courseid=58630)
{"allowedeventtypes": ["user"]}

// core_course_get_user_navigation_options (courseids[0]=58630)
{"courses":[{"id":58630,"options":[
   {"name":"badges","available":false}, {"name":"blogs","available":false},
   {"name":"competencies","available":false}, {"name":"grades","available":true},
   {"name":"notes","available":false}, {"name":"participants","available":true},
   {"name":"search","available":false}, {"name":"tags","available":false},
   {"name":"communication","available":false}]}]}

// core_group_get_activity_allowed_groups (cmid=4176595)
{"groups": [], "canaccessallgroups": false}
```

These are the cheapest reliable way to branch your integration on "is this account a student or a
teacher here" without guessing role ids.

---

# 3. Course structure

## 3.1 `course_categories`

| Column | Meaning |
|---|---|
| `id` | category id |
| `name`, `idnumber`, `description`, `descriptionformat` | |
| `parent` | parent `course_categories.id`; **0 = top level** |
| `sortorder` | global ordering, in steps (Moodle rewrites these in bulk) |
| `coursecount` | denormalised count of courses directly in this category |
| `visible`, `visibleold` | see §3.7 |
| `depth` | 1 for top level |
| `path` | `/`-separated **category ids**, e.g. `/8` or `/3/17/104` |
| `theme` | optional per-category theme |

[verified 4.5.13] `core_course_get_categories` on a top-level category returned
`{"id":8,"parent":0,"sortorder":10000,"coursecount":8648,"depth":1,"path":"/8"}`.

Note `course_categories.path` is a path of **category** ids, whereas `context.path` is a path of
**context** ids. Two different `path` columns with two different meanings.

## 3.2 `course`

Selected columns (full list in `lib/db/install.xml`):

| Column | Notes |
|---|---|
| `id` | **`1` is the site/front page course** (`SITEID`). It has sections and activities but no enrolment in the normal sense |
| `category` | `course_categories.id`; 0 for the site course |
| `sortorder` | ordering within the category |
| `fullname`, `shortname`, `idnumber` | `shortname` is *not* enforced unique by the DB, only by the UI |
| `summary`, `summaryformat` | see §11 |
| `format` | plugin name of the course format — `topics`, `weeks`, `singleactivity`, `social` in core |
| `startdate`, `enddate` | epoch seconds; `enddate` 0 = no end |
| `relativedatesmode` | 1 = activity dates displayed relative to the user's enrolment start |
| `visible`, `visibleold` | §3.7 |
| `groupmode`, `groupmodeforce`, `defaultgroupingid` | §9 |
| `enablecompletion`, `completionnotify` | §7 |
| `showgrades` | 0 hides the gradebook from students entirely |
| `showactivitydates` | 1 = render the `dates[]` block on activities |
| `showcompletionconditions` | 1 = render completion conditions to students |
| `lang`, `theme`, `calendartype` | forced overrides; `''` = do not force |
| `marker` | the "current" section number, for formats that highlight one |
| `cacherev` | bumped on any structural change; used to invalidate the course cache |
| `newsitems` | number of latest-announcement items |
| `maxbytes`, `legacyfiles`, `showreports`, `downloadcontent` | |
| `originalcourseid` | set when the course came from a restore of another course on this site |
| `timecreated`, `timemodified` | |

## 3.3 `course_sections`

| Column | Meaning |
|---|---|
| `id` | the row id — **this is what `course_modules.section` points at** |
| `course` | `course.id` |
| `section` | the **section number**, 0-based. Unique per course together with `course` |
| `name` | `NULL`/empty means "use the format's default name" (`Topic 3`, `9 March – 15 March`, …) |
| `summary`, `summaryformat` | |
| `sequence` | **comma-separated list of cmids**, in display order, e.g. `"4414641,4414642,4460916"` |
| `visible` | 0 = hidden section |
| `availability` | availability JSON or NULL (§4) |
| `component` | 4.5+: the delegating plugin, e.g. `mod_subsection`; NULL for ordinary sections |
| `itemid` | 4.5+: the delegating plugin's instance id |
| `timemodified` | 4.5+ |

**Section 0** is the special top section ("General"): it exists in every course, cannot be deleted or
moved, and holds course-wide items (announcements forum, course info). Formats generally render it
above the numbered sections.

`sequence` is the authoritative activity ordering — the `course_modules` table has no sort column.
The order of `modules[]` in `core_course_get_contents` already follows it.

**`numsections` no longer exists** as a course field for core formats (removed for topics/weeks in
3.3+). The sections that exist in `course_sections` *are* the sections. Some third-party formats
still keep a `numsections` entry in `course_format_options`;
`core_courseformat\base::get_last_section_number()` handles both cases
[source `course/format/classes/base.php`]. The `hiddenbynumsections` flag in
`core_course_get_contents` section objects exists for that legacy case and is `0` on core formats
[verified 4.5.13].

## 3.4 `course_modules` and `modules`

`{modules}` is a tiny site-level registry: `id`, `name` (`'assign'`, `'quiz'`, …), `visible`
(0 = module type disabled site-wide), plus legacy `cron`/`lastcron`/`search`.

`{course_modules}` columns worth knowing:

| Column | Meaning |
|---|---|
| `id` | the cmid |
| `course`, `module`, `instance`, `section` | see §1.1 |
| `idnumber` | teacher-assigned; used by grade item mapping and external SIS integrations |
| `added` | creation time (epoch) |
| `indent` | indentation level on the course page (0..) — deprecated in newer themes but still stored |
| `visible`, `visibleoncoursepage`, `visibleold` | §3.7 |
| `groupmode`, `groupingid` | §9 |
| `completion`, `completionview`, `completiongradeitemnumber`, `completionexpected`, `completionpassgrade` | §7 |
| `availability` | availability JSON or NULL (§4) |
| `showdescription` | 1 = also show the activity's intro on the course page |
| `deletioninprogress` | 1 = queued for async delete; treat as gone |
| `downloadcontent` | 1 = include in "download course content" |
| `lang` | forced language for this activity (4.0+) |
| `score` | vestigial, unused |

## 3.5 Course formats and what they do to section semantics

`course.format` names a `format_*` plugin. Core ships four:

| Format | Section semantics | Notes |
|---|---|---|
| `topics` | Sections are arbitrary "topics", named by the teacher or `Topic N` | The default |
| `weeks` | Section *N* maps to calendar week *N* counted from `course.startdate`; default names are date ranges | Section numbering is therefore date-meaningful |
| `singleactivity` | The course *is* one activity. There is effectively one section; the course page redirects to the module | `core_course_get_contents` still returns a section structure |
| `social` | The course page is a forum. Sections exist but are not the navigation model | |

Everything else (`onetopic`, `grid`, `tiles`, `flexsections`, `remuiformat`, …) is a contributed
plugin. [verified 4.5.13] the sample site had courses using `topics`, `onetopic` and `grid` in a
single user's enrolment list. **Your integration must not assume the format is one of the core four.**
Third-party formats can and do change what a "section" means (e.g. `onetopic` renders each section as
a tab; `flexsections` nests sections arbitrarily). What is *always* true:

* `course_sections` rows + `sequence` still describe the real structure.
* `core_course_get_contents` still returns sections in `section`-number order with `modules[]` in
  `sequence` order.

Per-format settings live in `{course_format_options}`:

| Column | Meaning |
|---|---|
| `courseid`, `format` | which course, which format (options survive a format switch, keyed by format) |
| `sectionid` | **0 = a course-level option**; otherwise `course_sections.id` for a per-section option |
| `name`, `value` | |

Unique on `(courseid, format, sectionid, name)`.

[verified 4.5.13] `core_course_get_courses_by_field(field=id, value=58630)` on a `topics` course
returned:

```json
"courseformatoptions": [
  {"name": "hiddensections", "value": 0},
  {"name": "coursedisplay",  "value": 0},
  {"name": "indentation",    "value": "1"}
]
```

* `hiddensections`: `0` = hidden sections are shown to students in collapsed "not available" form;
  `1` = hidden sections are completely invisible.
  [source `course/format/topics/lib.php`, strings `hiddensectionscollapsed` / `hiddensectionsinvisible`]
* `coursedisplay`: `COURSE_DISPLAY_SINGLEPAGE = 0` (all sections on one page),
  `COURSE_DISPLAY_MULTIPAGE = 1` (one section per page).
  [source `lib/moodlelib.php` lines 565/569]

## 3.6 Delegated sections and `mod_subsection` — **4.5+**

Moodle 4.5 introduced *delegated sections*: a section row whose existence and lifecycle are owned by
a plugin rather than by the course format. The mechanism is the two new `course_sections` columns:

```
course_sections.component  -- e.g. 'mod_subsection'  (NULL for ordinary sections)
course_sections.itemid     -- the owning plugin's instance id
```

[source `lib/db/install.xml`: *"The delegate component of this section if any"* / *"The optional item
id delegate component can use to identify its instance"*; index `component_itemid`.]
The plugin implements `<plugin>\courseformat\sectiondelegate` extending
`core_courseformat\sectiondelegate` [source `course/format/classes/sectiondelegate.php`].

The only core user is the new **`mod_subsection`** activity module. Its own table is deliberately
minimal [source `mod/subsection/db/install.xml`]:

```
{subsection}: id, course, name, timemodified
```

— everything else about a subsection lives in its `course_sections` row. The wiring is:

```
course_modules row   (modname='subsection', id=CMID, instance=SUBID)   lives in the PARENT section
        │
        │  customdata: {"sectionid":"<delegated section row id>"}
        ▼
course_sections row  (id=<delegated section row id>, component='mod_subsection', itemid=SUBID)
        │
        └─ sequence: the cmids of the activities INSIDE the subsection
```

[verified 4.5.13] on course 58630:

```jsonc
// the delegating activity, sitting in section number 1 (row id 738168)
{ "id": 4460916, "modname": "subsection", "instance": 22079,
  "contextid": 6407758, "modplural": "Subsections", "purpose": "content",
  "customdata": "{\"sectionid\":\"747015\"}" }

// the delegated section itself, returned as a TOP-LEVEL section by core_course_get_contents
{ "id": 747015, "name": "Weekly Reflective Learning Diaries", "section": 11,
  "visible": 1, "uservisible": true,
  "component": "mod_subsection", "itemid": 22079,
  "modules": [ … the activities inside the subsection … ] }
```

Consequences for integrations:

* **`core_course_get_contents` returns delegated sections as ordinary, flat, top-level sections** with
  their own `section` numbers (9, 10, 11, 12 in the verified course), *appended after* the real
  sections. There is no nesting in the JSON. To rebuild the visual hierarchy you must:
  1. find the `subsection` modules and read `customdata.sectionid`, **or**
  2. match `course_sections.itemid` against the `subsection` module's `instance`.
* The subsection's activities are **not** listed in the parent section's `sequence`; they are in the
  delegated section's `sequence`.
* Naïvely flattening `sections[].modules[]` therefore still gets you every activity exactly once —
  which is usually what you want — but the *section numbers* will not match what a student sees.
* On a 4.4-or-earlier site, `component`/`itemid` do not exist in the API output at all. On 4.5 they
  are present and `null` for ordinary sections [verified 4.5.13].

## 3.7 Visibility: `visible`, `visibleold`, `visibleoncoursepage`, `uservisible`

Four different flags, three different jobs.

**`visible`** (on `course_categories`, `course`, `course_modules`, `course_sections`) — the
teacher-set "shown / hidden" switch.

**`visibleold`** (`course_categories`, `course`, `course_modules`) — a *backup* of `visible` used
when a parent is hidden. Hiding a category sets `visible = 0` on all its courses but preserves each
course's own intent in `visibleold`; un-hiding the category restores from `visibleold`. Same for
hiding a section: the section's activities get `visible = 0` while `visibleold` remembers whether the
teacher had them shown. **Never read `visibleold` as "is this visible"** — it is a restore buffer.

**`visibleoncoursepage`** (`course_modules`, 3.3+) — the *stealth* flag. `visible = 1` +
`visibleoncoursepage = 0` means: the activity is fully available and usable to students, it just does
not appear on the course page. Students reach it via a direct link, a URL resource, or an embedded
link in a page. This requires `$CFG->allowstealth` and the format to permit it.

[verified 4.5.13] a stealth resource in course 58666:

```json
{ "id": 4176571, "modname": "resource", "name": "Luentomoniste",
  "visible": 1, "visibleoncoursepage": 0, "uservisible": true }
```

**`uservisible`** — *not a database column*. It is computed per user by `cm_info` and returned by the
API. It is the answer to "can **this** user actually use this thing right now", folding together:

* `visible` (and `moodle/course:viewhiddenactivities` for the hidden case),
* the section's `visible`,
* the availability tree (§4),
* group/grouping restrictions,
* `deletioninprogress`.

The four states you will see in `core_course_get_contents` [all verified 4.5.13]:

| `visible` | `visibleoncoursepage` | `uservisible` | `availabilityinfo` | Meaning |
|---|---|---|---|---|
| 1 | 1 | `true` | absent | Normal, available |
| 1 | 0 | `true` | absent | **Stealth** — available, hidden from the course page |
| 1 | 1 | `false` | present | **Restricted** — student can see *that* it exists and why it is locked |
| 0 | — | `false` (student) / `true` (teacher) | absent | Hidden by the teacher |

When a *section* is hidden and the user cannot see hidden sections, the API returns the section
object with `visible: 0`, `uservisible: false` and **`modules: []`** — the contents are stripped, not
merely flagged. [verified 4.5.13, course 42767 section 7]

```json
{ "id": 495632, "name": "Kurssin päätös ja palaute", "section": 7,
  "visible": 0, "uservisible": false, "hiddenbynumsections": 0,
  "component": null, "itemid": null, "modules": [] }
```

So: **you cannot enumerate hidden content as a student, at all.** A "missing" activity in your sync
is more often a hidden section than a bug.

## 3.8 The shape of `core_course_get_contents` in 4.5

For orientation, one complete real module object with a file attached [verified 4.5.13]:

```jsonc
{
  "id": 4414641,                                   // cmid
  "url": "https://moodle.tuni.fi/mod/resource/view.php?id=4414641",
  "name": "Course User Manual",
  "instance": 1640780,                             // {resource}.id
  "contextid": 6345135,                            // CONTEXT_MODULE context id
  "visible": 1, "uservisible": true, "visibleoncoursepage": 1,
  "modicon": "https://…/theme/image.php/…/f/pdf?filtericon=1",
  "modname": "resource",
  "purpose": "content",                            // FEATURE_MOD_PURPOSE: content|assessment|
                                                   // collaboration|communication|interactivecontent|
                                                   // administration|interface|other
  "branded": false,                                // 4.4+: plugin ships a branded (non-monochrome) icon
  "modplural": "Files",
  "indent": 0,
  "onclick": "",                                   // JS for modules that open in a popup (lti, url)
  "afterlink": null,
  "activitybadge": {"badgecontent": "PDF", "badgestyle": "badge-none"},   // 4.3+
  "customdata": "{\"filtericon\":true,\"displayoptions\":\"a:3:{…}\",\"display\":5}",
  "noviewlink": false,                             // true for label-like modules with no view page
  "completion": 0,                                 // course_modules.completion (tracking mode)
  "downloadcontent": 1,
  "dates": [],                                     // see below
  "groupmode": 0,
  "contents": [ { "type": "file", "filename": "…pdf", "filepath": "/",
                  "filesize": 3200413,
                  "fileurl": "https://…/webservice/pluginfile.php/6345135/mod_resource/content/1/…pdf?forcedownload=1",
                  "timecreated": 1787391761, "timemodified": 1787391764,
                  "sortorder": 1, "mimetype": "application/pdf",
                  "isexternalfile": false, "userid": 2873,
                  "author": "Jouni Lyly-Yrjänäinen", "license": "allrightsreserved" } ],
  "contentsinfo": { "filescount": 1, "filessize": 3200413,
                    "lastmodified": 1787391764,
                    "mimetypes": ["application/pdf"], "repositorytype": "" }
}
```

Notes:

* **`customdata` is a JSON *string*, not an object** — you must `JSON.parse` it, and its contents are
  entirely module-defined. For `assign` it carries `{"duedate":…, "allowsubmissionsfromdate":"…"}`;
  for `subsection` it carries `{"sectionid":"747015"}`; for `resource` it carries a *PHP-serialised*
  `displayoptions` string nested inside the JSON [all verified 4.5.13]. Treat it as opaque unless you
  know the module.
* **`dates[]`** is the normalised "activity dates" block (4.0+), populated from
  `\core\activity_dates`. Each entry is `{"label": "Due:", "timestamp": 1788469200, "dataid":
  "duedate"}`. `dataid` is the stable machine key; `label` is localised and ends with a colon.
  [verified 4.5.13]
* `completiondata` appears only when the course has `enablecompletion = 1` (§7).
* `availabilityinfo` appears only when the item is restricted (§4).
* `description` appears only when `course_modules.showdescription = 1`.

---

# 4. Availability and access restrictions

Reference: <https://moodledev.io/docs/apis/subsystems/availability>; source `availability/classes/`
and `availability/condition/*/classes/condition.php`.

## 4.1 Where it is stored

Two columns, both `TEXT NULL`, both holding a JSON document:

```
course_modules.availability
course_sections.availability
```

`NULL` (or the JSON `null`) means "no restrictions". The value is *never* exposed raw by
`core_course_get_contents` — see §4.4.

## 4.2 The tree format

[source `availability/classes/tree.php`, class docblock]

```
{ "op": "&", "c": [ … ] }
```

* `op` — one of `"&"` (AND), `"|"` (OR), `"!&"` (NOT AND), `"!|"` (NOT OR).
* `c` — array of children. A child is either another tree node (a nested *restriction set*) or a leaf
  condition object.
* At the **root only**, one extra key describes what students see when the check fails:
  * with `op` `"|"` or `"!&"` → **`"show": true|false"`** — a single boolean for the whole tree;
  * with `op` `"&"` or `"!|"` → **`"showc": [true, false, …]`** — one boolean *per child*, same length
    as `c`. Any `false` takes precedence (i.e. hides the item entirely).

`show`/`showc` = `true` means "greyed out with an explanation"; `false` means "invisible".

A realistic value:

```json
{
  "op": "&",
  "c": [
    {"type": "date", "d": ">=", "t": 1788469200},
    {"type": "grade", "id": 476879, "min": 50},
    {"op": "|", "c": [
        {"type": "group", "id": 4711},
        {"type": "profile", "op": "isequalto", "sf": "institution", "v": "tuni.fi"}
    ]}
  ],
  "showc": [true, true, false]
}
```

Empty tree (created and then emptied in the UI) serialises as `{"op":"&","c":[],"showc":[]}` — treat
as unrestricted.

## 4.3 Core condition types

Each `availability_<name>` plugin defines its leaf JSON via a static `get_json()`. From
`MOODLE_405_STABLE`:

| `type` | Keys | Produced by | Semantics |
|---|---|---|---|
| `date` | `d` (`">="` = from, `"<"` = until), `t` (epoch seconds) | `availability_date` | `DIRECTION_FROM = '>='`, `DIRECTION_UNTIL = '<'` |
| `grade` | `id` (**`grade_items.id`**), optional `min`, optional `max` (percentages, 0–100) | `availability_grade` | available iff a grade exists **and** `score >= min` **and** `score < max` |
| `completion` | `cm` (**cmid**; `-1` = "the previous activity"), `e` (expected `COMPLETION_*` state) | `availability_completion` | `OPTION_PREVIOUS = -1` |
| `group` | optional `id` (`groups.id`); absent = "any group" | `availability_group` | users with `moodle/site:accessallgroups` always pass |
| `grouping` | `id` (`groupings.id`) **or** `"activity": true` (= use the activity's own grouping) | `availability_grouping` | ditto |
| `profile` | `op`, plus `sf` (standard field name) **or** `cf` (custom field shortname), plus `v` for value-taking operators | `availability_profile` | operators: `isequalto`, `contains`, `doesnotcontain`, `startswith`, `endswith`, `isempty`, `isnotempty` |
| *(nested)* | `{"op": …, "c": […]}` | restriction set | arbitrary nesting depth |

Contributed condition plugins add their own `type` values (`availability_role`, `availability_badge`,
`availability_language`, `availability_coursecompleted`, …). **Handle unknown `type` gracefully.**

`grade` conditions are the one place where a raw `grade_items.id` leaks into course structure data.

`completion` `e` values are the `COMPLETION_*` constants (§7.2): `0` incomplete, `1` complete,
`2` complete-pass, `3` complete-fail.

## 4.4 `availabilityinfo` — what the API actually returns

The external course-contents API **does not return the JSON tree**. It returns the *rendered,
localised HTML explanation* under `availabilityinfo`, and only when the item is currently
unavailable to the requesting user. [verified 4.5.13, course 58666, an LTI activity]

```json
{ "id": 4176603,
  "name": "MATLAB Grader: Exercise 3, Task 1",
  "modname": "lti",
  "visible": 1, "visibleoncoursepage": 1,
  "uservisible": false,
  "availabilityinfo": "Available from <strong>7 September 2026, 8:15 AM</strong>",
  "completion": 1,
  "completiondata": { "state": 0, "hascompletion": true, "isautomatic": false,
                      "istrackeduser": true, "uservisible": false, "details": [],
                      "isoverallcomplete": false } }
```

Practical consequences:

* `availabilityinfo` is **HTML**, **localised to the caller's language**, and its wording changes
  between Moodle versions. Do not parse it for dates. If you need machine-readable restrictions you
  need the raw `availability` column, which only teacher-level functions expose (see
  `web-services-api.md`).
* When multiple conditions fail you get a `<ul>` of them.
* When `show`/`showc` is `false` for a failing condition, **you get nothing at all** — the item is
  simply absent from `modules[]`. So an item disappearing is indistinguishable from it never having
  existed.
* Sections carry `availabilityinfo` too, on the section object.
* `\core_availability\info::is_available()` is also what feeds `uservisible`; the two always agree.

## 4.5 Interaction with completion

Availability and completion are separate systems that reference each other:

* an availability `completion` condition reads `course_modules_completion`;
* an availability `grade` condition reads `grade_grades`;
* completion of an activity the user cannot access stays at 0 (`uservisible: false` in
  `completiondata`, as in the JSON above [verified 4.5.13]).

This creates chains: activity B unavailable until A is complete; A's completion is "receive a grade";
the grade arrives asynchronously via cron. Your integration may therefore observe a window where A is
graded but B is still `uservisible: false`.

---

# 5. Enrolment

Reference: <https://moodledev.io/docs/apis/core/enrol>; source `lib/enrollib.php`, `enrol/*/lib.php`.

Moodle separates three things that other LMSs conflate:

1. **Enrolment instance** — a configured enrolment *method* inside one course (`{enrol}` row).
2. **User enrolment** — one user's participation via one instance (`{user_enrolments}` row).
3. **Role assignment** — what that user is *allowed to do* (`{role_assignments}` row, §2.3).

A user is "in" a course iff they have at least one `user_enrolments` row for an `enrol` instance of
that course. Their role is a separate fact.

## 5.1 `{enrol}` — enrolment instances

| Column | Meaning |
|---|---|
| `id` | the **enrolid** |
| `enrol` | plugin name: `manual`, `self`, `guest`, `cohort`, `meta`, `lti`, `database`, `flatfile`, `imsenterprise`, `ldap`, `paypal`/`fee`, `category`, `mnet` |
| `courseid` | the course |
| `status` | `ENROL_INSTANCE_ENABLED = 0`, `ENROL_INSTANCE_DISABLED = 1` |
| `sortorder` | order of methods within the course |
| `name` | optional instance label (shown instead of the plugin name) |
| `roleid` | default role granted by this instance |
| `enrolperiod`, `enrolstartdate`, `enrolenddate` | plugin-interpreted duration/window |
| `expirynotify`, `expirythreshold`, `notifyall` | expiry notification config |
| `password` | enrolment key (self enrolment) |
| `cost`, `currency` | payment plugins |
| `customint1..8`, `customchar1..3`, `customdec1..2`, `customtext1..4` | **plugin-defined**; core never touches them |

The `custom*` columns are why enrolment configuration is opaque from the outside: e.g. for
`enrol_meta`, `customint1` is the *linked* course id; for `enrol_cohort`, `customint1` is the cohort
id; for `enrol_self`, `customint1` is "group key enabled", `customint6` is "allow new enrolments".
There is no generic decoder.

The core plugins in one line each:

| Plugin | What it does |
|---|---|
| `manual` | Teacher/admin adds users by hand. Present in nearly every course. |
| `self` | Users enrol themselves, optionally with an enrolment key (`enrol.password`). |
| `guest` | *Not really enrolment.* Grants read access without a `user_enrolments` row. Guests never appear in participant lists or the gradebook. |
| `cohort` | Everyone in a site/category cohort (`{cohort}`, `{cohort_members}`) is synced in. |
| `meta` | Mirrors the enrolments of another course ("parent" course). Used for combining course instances. |
| `lti` | Users arriving over LTI from an external platform are auto-enrolled. `role_assignments.component = 'enrol_lti'`. |
| `database` / `flatfile` / `ldap` / `imsenterprise` | External SIS sync. This is what a university actually runs. |
| `fee` / `paypal` / `stripe` | Payment gated. |
| `category` | Role assigned at the category level implies enrolment in its courses. |

[verified 4.5.13] `core_course_get_courses_by_field` reports the active methods as
`"enrollmentmethods": ["manual"]` (note the *double-l* spelling in the API key).

## 5.2 `{user_enrolments}`

| Column | Meaning |
|---|---|
| `id` | |
| `enrolid` | → `enrol.id` (which implies the course) |
| `userid` | → `user.id` |
| `status` | `ENROL_USER_ACTIVE = 0`, `ENROL_USER_SUSPENDED = 1` |
| `timestart` | epoch; `0` = "no start restriction" |
| `timeend` | epoch; `0` = "never ends". **The DB default is `2147483647`**, so you will see both `0` and `2147483647` meaning "forever" |
| `timecreated`, `timemodified`, `modifierid` | |

Unique on `(enrolid, userid)` — a user can be enrolled at most once per instance, but *can* be
enrolled several times in one course through different instances (e.g. `manual` + `cohort`). Their
access is the union.

## 5.3 "Active enrolment" — the exact predicate

[source `lib/enrollib.php::enrol_get_all_users_courses()`]:

```sql
WHERE ue.status = :active        -- ENROL_USER_ACTIVE (0)
  AND e.status  = :enabled       -- ENROL_INSTANCE_ENABLED (0)
  AND ue.timestart < :now
  AND (ue.timeend = 0 OR ue.timeend > :now)
```

All four must hold. In particular **disabling the enrolment *method* silently deactivates every
enrolment made through it** without touching `user_enrolments` — a common cause of "the student
vanished from the course" tickets.

Suspended (`ue.status = 1`) users keep their `role_assignments` and their grades, but
`is_enrolled($ctx, $user, '', true)` is false, they drop out of default participant lists, and their
gradebook rows are hidden unless the teacher enables "show only active enrolments".

## 5.4 How "my courses" is actually computed

`enrol_get_users_courses($userid, $onlyactive, $fields, $sort)` [source `lib/enrollib.php`]:

1. `enrol_get_all_users_courses()` — join `course` ← `enrol` ← `user_enrolments` for the user,
   applying the four-clause active filter **only if `$onlyactive`**.
2. Then, again only if `$onlyactive`, drop courses with `course.visible = 0` unless the user has
   `moodle/course:viewhiddencourses` in that course's context.
3. Guest user (`isguestuser()`) always gets an empty array.

Things this implies:

* Courses reached through the `guest` enrolment plugin are **never** in "my courses" — there is no
  `user_enrolments` row.
* Course *visibility* is only checked in the `$onlyactive` path. The external
  `core_enrol_get_users_courses` passes `$onlyactive = true`, so hidden courses are filtered for
  students.
* A user with a category-level `manager` role sees nothing extra here; role assignments alone do not
  create enrolments.

[verified 4.5.13] `core_enrol_get_users_courses(userid)` returns per course:

```jsonc
{
  "id": 58849,
  "shortname": "DATA.STAT.120-2026-2027-2-TAU",
  "fullname": "…", "displayname": "…",
  "enrolledusercount": 45,                    // only when returnusercount=1 (default) and permitted
  "idnumber": "otm-d108c227-…_2026",
  "visible": 1, "summary": "", "summaryformat": 1,
  "format": "onetopic",
  "courseimage": "https://…/pluginfile.php/6001538/course/generated/course.svg",
  "showgrades": true, "lang": "",
  "enablecompletion": false,
  "completionhascriteria": false,             // any {course_completion_criteria} rows?
  "completionusertracked": false,             // is THIS user tracked for completion? (§7.5)
  "category": 8,
  "progress": null,                           // % of completion-tracked activities done, or null
  "completed": null,                          // course-level completion, or null
  "startdate": 1787518800, "enddate": 1791838800,
  "marker": 0,
  "lastaccess": 1787916634,                   // {user_lastaccess}.timeaccess
  "isfavourite": false,                       // {favourite} table
  "hidden": false,                            // user preference block_myoverview_hidden_course_<id>
  "overviewfiles": [],
  "showactivitydates": false, "showcompletionconditions": null,
  "timemodified": 1786908035
}
```

`progress`/`completed`/`completionhascriteria`/`completionusertracked` are `null`/`false` whenever
`enablecompletion = 0`. `progress` is also `null` when the course has completion enabled but **no
activities have completion tracking configured** [verified 4.5.13 — several courses returned
`enablecompletion: true, completionusertracked: true, progress: null`].

`hidden` and `isfavourite` are *per-user dashboard state*, not course properties: `isfavourite` comes
from the `{favourite}` table and `hidden` from a `user_preferences` row named
`block_myoverview_hidden_course_<courseid>` [verified 4.5.13 — the preference was present with value
`"1"` for exactly the course reported as hidden].

## 5.5 Reading participants

`core_enrol_get_enrolled_users(courseid, options[])` returns user records with a `roles[]` array
[verified 4.5.13]:

```json
[{"id": 1753, "fullname": "…", "email": "…",
  "roles": [{"roleid": 3, "name": "", "shortname": "editingteacher", "sortorder": 0}]},
 {"id": 28427, "fullname": "…",
  "roles": [{"roleid": 5, "name": "", "shortname": "student", "sortorder": 0}]}]
```

Which *fields* come back is governed by `$CFG->showuseridentity` and
`moodle/site:viewuseridentity`; which *users* come back is governed by group mode (§9),
`moodle/course:viewparticipants`, and `moodle/course:viewsuspendedusers`.

`core_enrol_get_course_enrolment_methods(courseid)` lists the *self/guest* instances a user could use
to join. [verified 4.5.13] it returned `[]` for a course whose only method is `manual` — it only
reports instances that expose a "enrol me" UI, not the full `{enrol}` table.

---

# 6. The gradebook

The gradebook is the most misunderstood part of Moodle's data model, and the most valuable to get
right. References: <https://docs.moodle.org/en/Grades>, <https://docs.moodle.org/en/Grade_aggregation>,
source `lib/grade/grade_item.php`, `lib/grade/grade_category.php`, `lib/grade/grade_grade.php`,
`lib/grade/constants.php`, `lib/gradelib.php`.

## 6.1 The three tables

```
grade_categories   the TREE structure (folders)          one row per category, incl. the course root
grade_items        the COLUMNS                            one row per gradeable thing + one per category + one per course
grade_grades       the CELLS                              one row per (grade_item, user)
```

The crucial structural fact:

> **Every `grade_category` has a matching `grade_item` that holds its total.**
> The link is `grade_items.iteminstance = grade_categories.id` with
> `grade_items.itemtype IN ('category', 'course')`.

The root category of a course is represented by a `grade_item` with `itemtype = 'course'`; every
nested category by one with `itemtype = 'category'`. That is why "Course total" and "Category total"
behave exactly like ordinary grade columns — because they *are* ordinary grade columns.

[source `lib/grade/grade_item.php`:
`WHERE (gi.itemtype = 'category' OR gi.itemtype = 'course') AND gi.iteminstance = gc.id`]

## 6.2 `{grade_items}`

| Column | Meaning |
|---|---|
| `id` | the **gradeitemid** |
| `courseid` | |
| `categoryid` | the grade category this item **sits inside** → `grade_categories.id`. **`NULL` for `category`/`course` total rows** (their parent is expressed by `grade_categories.parent` instead) |
| `itemname` | display name. **Empty/NULL for `category` and `course` rows** — the name comes from `grade_categories.fullname` |
| `itemtype` | `'mod'`, `'manual'`, `'category'`, `'course'` (schema comment also mentions `'blocks'`, `'import'`, `'calculated'`; core 4.5 only writes the four) |
| `itemmodule` | for `itemtype='mod'`: the module name (`'assign'`, `'quiz'`, `'attendance'`, …); NULL otherwise |
| `iteminstance` | for `'mod'`: the module **instance** id (`{assign}.id`). For `'category'`/`'course'`: **`grade_categories.id`**. NULL for `'manual'` |
| `itemnumber` | disambiguates multiple grade columns from one activity (workshop has 0 = submission grade, 1 = assessment grade; a module with outcomes gets 1000+). `NULL` for category/course rows, `0` for the usual single-grade case |
| `iteminfo`, `idnumber` | free text / teacher-assigned stable key (used in calculation formulas as `[[idnumber]]`) |
| `calculation` | a formula like `=max([[hw]], 2*[[exam]])`, stored internally as `##gi476903##` references |
| `gradetype` | `GRADE_TYPE_NONE 0`, `GRADE_TYPE_VALUE 1` (points), `GRADE_TYPE_SCALE 2`, `GRADE_TYPE_TEXT 3` |
| `grademax`, `grademin` | numeric bounds (for scales: 1..count(scale items)) |
| `scaleid` | → `{scale}.id` when `gradetype = 2` |
| `outcomeid` | → `{grade_outcomes}.id`; an "outcome item" |
| `gradepass` | pass mark; drives completion-with-pass and pass/fail colouring. `0` = not set |
| `multfactor`, `plusfactor` | linear transform applied to raw grades: `final = raw * multfactor + plusfactor` |
| `aggregationcoef` | **meaning depends on the parent category's aggregation** — see §6.5 |
| `aggregationcoef2` | the **normalised weight, 0..1**, used by Natural aggregation |
| `weightoverride` | 1 = the teacher pinned `aggregationcoef2` manually |
| `sortorder` | column order within the report |
| `display` | `GRADE_DISPLAY_TYPE_*`; `0` = inherit course/site default |
| `decimals` | `NULL` = inherit course/site default |
| `hidden` | `0` visible, `1` hidden, `>1` = an epoch timestamp: hidden **until** that time |
| `locked` | `0` unlocked, `1` locked, `>1` = epoch: locked from that time |
| `locktime` | auto-lock date |
| `needsupdate` | 1 = the column is stale and will be recomputed by cron / next gradebook load |
| `timecreated`, `timemodified` | |

Note `hidden` and `locked` are **overloaded**: `1` is a flag, anything `>1` is a timestamp. Test
`> 1` before treating the value as a date.

## 6.3 `{grade_categories}` — the tree

| Column | Meaning |
|---|---|
| `id` | |
| `courseid` | |
| `parent` | parent `grade_categories.id`; **`NULL` for the course root category** |
| `depth`, `path` | `path` is `/`-separated **category ids**, e.g. `/65351/72900` |
| `fullname` | the display name (`'?'` for the auto-created root, rendered as the course name) |
| `aggregation` | `GRADE_AGGREGATE_*` (§6.4) |
| `keephigh` | keep only the N highest grades; 0 = off |
| `droplow` | drop the N lowest grades; 0 = off |
| `aggregateonlygraded` | 1 = ungraded items are excluded rather than counted as 0 |
| `aggregateoutcomes` | 1 = include outcome items in the aggregate |
| `hidden` | |

The root category is auto-created with the course and cannot be deleted. Its `fullname` is literally
`?` on many sites — the UI substitutes the course name.

## 6.4 Aggregation methods

[source `lib/grade/constants.php`]

| Constant | Value | UI name | What it does |
|---|---|---|---|
| `GRADE_AGGREGATE_MEAN` | **0** | Mean of grades | arithmetic mean of the children's *normalised* (0..1) grades |
| `GRADE_AGGREGATE_MEDIAN` | 2 | Median of grades | the median child gets weight 1, everything else 0 |
| `GRADE_AGGREGATE_MIN` | 4 | Lowest grade | |
| `GRADE_AGGREGATE_MAX` | 6 | Highest grade | |
| `GRADE_AGGREGATE_MODE` | 8 | Mode of grades | most frequent value |
| `GRADE_AGGREGATE_WEIGHTED_MEAN` | 10 | Weighted mean of grades | weight = each item's `aggregationcoef` (teacher-entered) |
| `GRADE_AGGREGATE_WEIGHTED_MEAN2` | 11 | Simple weighted mean of grades | weight = each item's grade *range* (`grademax - grademin`); `aggregationcoef` acts as an extra-credit flag |
| `GRADE_AGGREGATE_EXTRACREDIT_MEAN` | 12 | Mean of grades (with extra credits) | legacy; `aggregationcoef` > 0 marks extra credit |
| `GRADE_AGGREGATE_SUM` | **13** | **Natural** (formerly "Sum of grades") | the modern default; see below |

Values 1, 3, 5, 7, 9 are deliberately unused (they were reserved for "…of graded" variants).

**Natural (13)** is what almost every modern course uses and it is the one that confuses people:

* The category total's `grademax` is the **sum of the children's `grademax`** — not 100.
  [verified 4.5.13: a "Homework" category containing items of max 12+10+10+10+10+20 reported
  `"grademax": 21` because the teacher had overridden the category max; the course total reported
  `"grademax": 1005`.]
* Each child's contribution is `aggregationcoef2`, a **normalised fraction**. Moodle recomputes it as
  `grademax / totalgrademax` unless the teacher overrode it
  [source `lib/grade/grade_category.php` ≈line 1740:
  `$gradeitem->aggregationcoef2 = $totalgrademax ? ($gradeitem->grademax / $totalgrademax) : 0;`].
* `aggregationcoef` becomes a boolean **extra-credit** flag (1 = this item adds points without adding
  to the maximum).
* `weightoverride = 1` pins a child's weight; the remaining children are re-normalised over what is
  left.

`grade_category::aggregation_uses_aggregationcoef()` returns true for exactly
`WEIGHTED_MEAN`, `WEIGHTED_MEAN2`, `EXTRACREDIT_MEAN` and `SUM` — for the other methods
`aggregationcoef*` are meaningless leftovers you should ignore.

`droplow`/`keephigh` are applied by `grade_category::apply_limit_rules()` *after* the children's
grades are collected. They are disabled (`can_apply_limit_rules()` false) for Natural aggregation
when weights have been overridden or extra credit is present, because the result would be ambiguous.

## 6.5 `aggregationcoef` vs `aggregationcoef2` — the cheat sheet

| Parent aggregation | `aggregationcoef` means | `aggregationcoef2` means |
|---|---|---|
| Natural (13) | extra credit flag (0/1) | **normalised weight, 0..1** |
| Weighted mean (10) | **the weight** (teacher-entered, any positive number) | unused |
| Simple weighted mean (11) | extra credit flag | unused (weight = grade range) |
| Mean with extra credits (12) | extra credit multiplier | unused |
| Everything else | unused | unused |

Defaults on item creation [source `grade_category::get_default_aggregation_coefficients()`]:
`aggregationcoef = 1` for weighted mean; `aggregationcoef2 = 1` for Natural; `0` otherwise.

## 6.6 `{grade_grades}` — rawgrade vs finalgrade

| Column | Meaning |
|---|---|
| `itemid`, `userid` | unique together |
| `rawgrade` | the value **as the activity reported it**, in the activity's own scale at the time |
| `rawgrademin`, `rawgrademax`, `rawscaleid` | a snapshot of the item's bounds when the grade was stored — so that later changes to `grademax` do not silently rescale history |
| `finalgrade` | the **computed** value in the *current* `grade_items.grademin..grademax` scale, after `multfactor`/`plusfactor`, calculation formulas, aggregation and overrides. **This is the number you want.** |
| `overridden` | 0 = not overridden; otherwise the epoch when a teacher typed the grade directly into the gradebook. When non-zero, `finalgrade` no longer tracks the activity |
| `excluded` | 0, or the epoch when this grade was excluded from aggregation |
| `hidden` | 0 / 1 / epoch-until, same overloading as `grade_items.hidden` |
| `locked`, `locktime` | ditto |
| `feedback`, `feedbackformat` | teacher feedback (see §11 for `*format`) |
| `information`, `informationformat` | module-supplied notes |
| `aggregationstatus` | how this grade was treated by the parent category's aggregation: `'unknown'`, `'used'`, `'novalue'`, `'dropped'`, `'extra'` |
| `aggregationweight` | the actual weight this grade contributed |
| `usermodified`, `timecreated`, `timemodified`, `exported` | |

A **missing row** is not the same as `finalgrade = NULL`, but for reading purposes treat both as
"not graded". Moodle creates rows lazily.

`aggregationstatus`/`aggregationweight` are the audit trail for "why is my total not what I expect":
`'dropped'` = removed by `droplow`/`keephigh`; `'novalue'` = ungraded and `aggregateonlygraded` was
on; `'extra'` = counted as extra credit.

## 6.7 Scales, points and letters

* **Points** (`gradetype = 1`): plain numbers between `grademin` and `grademax`.
* **Scales** (`gradetype = 2`): `{scale}.scale` is a **comma-separated, ordered list of labels**,
  lowest first, e.g. `"Not met,Borderline,Met"`. The stored numeric grade is the 1-based index, so
  `grademin = 1` and `grademax = 3`. `{scale}.courseid = 0` means a site-wide scale.
  A scale grade of `0`/NULL means "no grade", *not* the first item.
* **Letters**: not a `gradetype`. Letters are a *display* transform of a percentage, defined by
  `{grade_letters}` = `(contextid, lowerboundary, letter)`. `grade_get_letters($context)` walks
  **up the context path** and returns the first non-empty set it finds; if none exists anywhere it
  returns the hard-coded default
  [source `lib/gradelib.php`]:

  ```php
  array('93'=>'A','90'=>'A-','87'=>'B+','83'=>'B','80'=>'B-',
        '77'=>'C+','73'=>'C','70'=>'C-','67'=>'D+','60'=>'D','0'=>'F')
  ```

  `lowerboundary` is a **percentage** (0–100), and each letter's upper bound is the next letter's
  lower bound.

## 6.8 Display type and decimals

`grade_items.display` (`GRADE_DISPLAY_TYPE_*`):

| Constant | Value | Renders as |
|---|---|---|
| `DEFAULT` | 0 | inherit course setting, then `$CFG->grade_displaytype` |
| `REAL` | 1 | `39.70` |
| `PERCENTAGE` | 2 | `79.40 %` |
| `LETTER` | 3 | `B-` |
| `REAL_PERCENTAGE` | 12 | `39.70 (79.40 %)` |
| `REAL_LETTER` | 13 | `39.70 (B-)` |
| `PERCENTAGE_REAL` | 21 | `79.40 % (39.70)` |
| `PERCENTAGE_LETTER` | 23 | `79.40 % (B-)` |
| `LETTER_REAL` | 31 | `B- (39.70)` |
| `LETTER_PERCENTAGE` | 32 | `B- (79.40 %)` |

The two-digit values are literally *"first digit = outer, second digit = parenthesised"*.

Three-level inheritance for both display type and decimals [source `grade_item::get_displaytype()`,
`get_decimals()`]: **item → course (`{grade_settings}` name `displaytype`/`decimalpoints`) → site
(`$CFG->grade_displaytype`, `$CFG->grade_decimalpoints`)**. `grade_items.decimals IS NULL` means
"inherit"; `0` means "zero decimals" — do not conflate them.

`{grade_settings}` is a simple `(courseid, name, value)` key-value store for per-course gradebook
settings.

## 6.9 Hidden and locked grades

* `grade_items.hidden` hides the whole column; `grade_grades.hidden` hides one cell.
* Users without `moodle/grade:viewhidden` do not see hidden items **and** the totals that contain
  them are adjusted according to `$CFG->grade_report_showtotalsifcontainhidden`:
  `GRADE_REPORT_HIDE_TOTAL_IF_CONTAINS_HIDDEN = 0` (show `-`),
  `GRADE_REPORT_SHOW_TOTAL_IF_CONTAINS_HIDDEN = 1` (show the total *excluding* hidden items),
  `GRADE_REPORT_SHOW_REAL_TOTAL_IF_CONTAINS_HIDDEN = 2` (show the real total).
  **This is the single most common reason a course total comes back as `"-"` for a student who
  clearly has grades.**
* `locked` prevents further updates from the activity — the grade freezes at its current value. A
  locked grade still displays normally.

## 6.10 `gradereport_user_get_grade_items` — the real shape

This is the workhorse read API. It requires `userid` unless you hold `moodle/grade:viewall`
(otherwise: `required_capability_exception` / `nopermissions`, [verified 4.5.13]).

Top level [verified 4.5.13, course 42767]:

```json
{"usergrades":[{"courseid":42767,
                "courseidnumber":"otm-886d114b-…_2024",
                "userid":135266,
                "userfullname":"Damir Kairov",
                "useridnumber":"tuni.fi:153104963",
                "maxdepth":3,
                "gradeitems":[ … 29 rows … ]}],
 "warnings":[]}
```

`maxdepth` is the depth of the grade-category tree (3 = course root → category → item).

**An activity row** (`itemtype: "mod"`) — note `cmid` is present and `iteminstance` is the *module
instance*, not the cmid:

```json
{"id": 476878, "itemname": "Homework 0 submission",
 "itemtype": "mod", "itemmodule": "assign",
 "iteminstance": 213128, "itemnumber": 0, "idnumber": "hw0",
 "categoryid": 72899, "outcomeid": null, "scaleid": null, "locked": null,
 "cmid": 3274929,
 "graderaw": null, "gradedatesubmitted": null, "gradedategraded": 1736937545,
 "gradehiddenbydate": false, "gradeneedsupdate": false,
 "gradeishidden": false, "gradeislocked": null, "gradeisoverridden": null,
 "gradeformatted": "-", "grademin": 0, "grademax": 12,
 "rangeformatted": "0&ndash;12", "percentageformatted": "-",
 "feedback": "Hello.\r\n\r\nThe problems submitted here…", "feedbackformat": 4}
```

**A manual row** (`itemtype: "manual"`) — no `cmid`, no `iteminstance`:

```json
{"id": 476903, "itemname": "Final exam (max. 50 points)",
 "itemtype": "manual", "itemmodule": null, "iteminstance": null,
 "itemnumber": 0, "idnumber": "f50", "categoryid": 72901,
 "graderaw": 39.7, "gradedategraded": 1741336376,
 "gradeformatted": "39.70", "grademin": 0, "grademax": 50,
 "rangeformatted": "0&ndash;50", "percentageformatted": "79.40 %"}
```

**A category total row** — this is the one that trips everyone up:

```json
{"id": 476916, "itemname": "",
 "itemtype": "category", "itemmodule": null,
 "iteminstance": 72899,          //  <-- grade_categories.id, NOT a module instance
 "itemnumber": null,
 "idnumber": "homework",
 "categoryid": null,             //  <-- NULL, because its parent is expressed in grade_categories
 "gradeformatted": "-", "grademin": 0, "grademax": 21,
 "rangeformatted": "0&ndash;21", "percentageformatted": "-"}
```

**The course total row** — exactly one per course, always last in `sortorder`:

```json
{"id": 436604, "itemname": "",
 "itemtype": "course", "iteminstance": 65351,   // the ROOT grade_categories.id
 "itemnumber": null, "idnumber": "totalpoints", "categoryid": null,
 "gradeformatted": "-", "grademin": 0, "grademax": 1005,
 "rangeformatted": "0&ndash;1005", "percentageformatted": "-"}
```

### Why `itemname` is empty on category and course rows

Because the name of a category total lives in `grade_categories.fullname`, not in
`grade_items.itemname`. The report joins them at render time. Over the web service **you do not get
the join** — `gradereport_user_get_grade_items` returns the `grade_items` row verbatim. To label
those rows you must:

* use `idnumber` if the teacher set one (`"homework"`, `"quiz"`, `"exams"`, `"totalpoints"` in the
  verified course), **or**
* fall back to `gradereport_user_get_grades_table`, which returns the *rendered HTML* of the report
  including the category names (§6.12), **or**
* label `itemtype == 'course'` as "Course total" and reconstruct category names from position: the
  category row always comes **immediately after** the items whose `categoryid` equals its
  `iteminstance` [true in the verified data, and guaranteed by `sortorder` when
  `$CFG->grade_aggregationposition = GRADE_REPORT_AGGREGATION_POSITION_LAST` (1), which is the
  default; with `POSITION_FIRST` (0) the total comes *before* its children].

### Other fields

* `graderaw` — `grade_grades.finalgrade` (despite the name), as a float; `null` if ungraded.
* `gradeformatted` — the display string per §6.8; `"-"` for ungraded **and** for grades the user is
  not allowed to see.
* `percentageformatted`, `rangeformatted` — pre-rendered, HTML-entity-encoded (`0&ndash;12`).
* `gradedatesubmitted` / `gradedategraded` — epoch or null.
* `weightraw` / `weightformatted` — **only present when the report is configured to show weights**
  (`grade_report_user_showweight`); they are `VALUE_OPTIONAL` in the schema
  [source `grade/report/user/classes/external/user.php`] and were **absent** in the verified course.
  Do not assume they exist.
* `averageformatted` — likewise optional (`grade_report_user_showaverage`).
* `gradeishidden`, `gradehiddenbydate`, `gradeislocked`, `gradeisoverridden`, `gradeneedsupdate` —
  booleans/nulls mirroring §6.2/§6.6. Note several come back as `null` rather than `false`.

## 6.11 `gradereport_user` vs `gradereport_overview`

| | `gradereport_user` | `gradereport_overview` |
|---|---|---|
| Scope | **one course, one user**, full item list | **all the user's courses**, one number each |
| Backing report | "User report" | "Overview report" |
| Web service | `gradereport_user_get_grade_items`, `gradereport_user_get_grades_table` | `gradereport_overview_get_course_grades` |
| Returns | every `grade_item` + the user's grade | only the **course total** per course |
| Capability | `gradereport/user:view` (+ `moodle/grade:viewall` for other users) | `gradereport/overview:view` |

[verified 4.5.13] `gradereport_overview_get_course_grades(userid)` returned one entry per enrolled
course, all `{"grade":"-","rawgrade":null}` — including a course whose user report shows several
graded activities. That is §6.9 in action: the course total contains hidden/ungraded components, so
the *total* is suppressed even though individual grades exist. **Do not use the overview report to
decide whether a student has grades.**

## 6.12 `gradereport_user_get_grades_table` — HTML, not data

This function returns the user report *as rendered table cells*: each row is a map of column name →
`{class, content, headers, colspan/rowspan}` where `content` is **HTML**. [verified 4.5.13]

```jsonc
{"tables":[{"courseid":42767,"userid":135266,"maxdepth":3,
  "tabledata":[
    {"itemname":{"class":"level1 d1 b1b b1t category column-itemname","colspan":9,
                 "content":"<div class=\"d-flex category-content\">… <span>MATH.APP.160-… Differential and Integral Calculus</span></div>",
                 "id":"cat_65351_135266"},
     "parentcategories":[]},
    {"leader":{"class":"level1 d1 b1t b2b b1l","rowspan":43},"parentcategories":[65351]},
    {"itemname":{"class":"level2 d2 … category column-itemname","colspan":8,
                 "content":"… <span>Homework max. 21 points</span></div>","id":"cat_72899_135266"},
     "parentcategories":[65351]},
    {"itemname":{"class":"level3 item b1b column-itemname","colspan":1,
                 "content":"…<a href=\"…/mod/assign/view.php?id=3274929\">Homework 0 submission</a>…",
                 "id":"row_476878_135266"},
     "weight":{"content":"-", …}, "grade":{"content":"-", …},
     "range":{"content":"0&ndash;12", …}, "percentage":{"content":"-", …},
     "feedback":{"content":"<p>Hello.</p>…", …},
     "parentcategories":[65351,72899]}
  ]}], "warnings":[]}
```

Useful facts hidden in there:

* The DOM ids encode the ids you need: `cat_<gradecategoryid>_<userid>` and
  `row_<gradeitemid>_<userid>`.
* `parentcategories[]` gives the ancestry of each row — **this is the only place the API hands you the
  grade-category tree**, and it is why this function is worth calling despite the HTML.
* `leader` rows are pure layout (rowspan spacers); skip them.
* `class` carries `level1`/`level2`/`level3` and `category`/`item`.

Combine `get_grade_items` (clean data) with `get_grades_table` (tree + names) to reconstruct a full
gradebook.

## 6.13 Outcomes

`{grade_outcomes}` are competency-like statements graded on a scale. An outcome attached to an
activity creates an **additional** `grade_item` with the same `itemmodule`/`iteminstance` but a
different `itemnumber` (1000+) and `outcomeid` set. If you group grade items by
`(itemmodule, iteminstance)` you will get duplicates unless you also key on `itemnumber` or filter
`outcomeid IS NULL`. `{grade_outcomes_courses}` links site-wide outcomes into courses.

## 6.14 History tables

`{grade_grades_history}`, `{grade_items_history}`, `{grade_categories_history}`,
`{grade_outcomes_history}` mirror their live tables plus `action` (`GRADE_HISTORY_INSERT 1`,
`UPDATE 2`, `DELETE 3`), `oldid`, `source`, `timemodified`, `loggeduser`. They are not exposed by any
core web service, but they are what the "grade history" report reads.

---

# 7. Activity completion and course completion

Reference: <https://docs.moodle.org/en/Activity_completion>,
<https://moodledev.io/docs/apis/subsystems/completion>; source `lib/completionlib.php`,
`completion/classes/cm_completion_details.php`, `completion/criteria/*.php`.

These are **two separate systems**. "Activity completion" ticks off individual activities; "course
completion" decides whether the *course* is complete, using criteria that may (but need not) include
activity completion.

## 7.1 The master switch

Nothing exists unless **both**:

* site setting `$CFG->enablecompletion` = 1 (reported by `core_webservice_get_site_info` in
  `advancedfeatures` as `{"name":"enablecompletion","value":1}` [verified 4.5.13]), **and**
* `course.enablecompletion` = 1 for the course.

If either is off, `core_completion_get_activities_completion_status` returns
`{"statuses": [], "warnings": []}` — **an empty list, not an error** [verified 4.5.13, course 58630
before enabling]. An empty result therefore does not mean "nothing completed".

## 7.2 Activity completion storage

`{course_modules_completion}`:

| Column | Meaning |
|---|---|
| `coursemoduleid` | the **cmid** |
| `userid` | |
| `completionstate` | 0..3, see below |
| `overrideby` | `user.id` of the teacher who manually overrode this state, else NULL |
| `timemodified` | when the state last changed — this is what the API reports as `timecompleted` |

Unique on `(userid, coursemoduleid)`. **No row = state 0.**

`{course_modules_viewed}` (4.0+) is a separate table `(coursemoduleid, userid, timecreated)` recording
"the user has viewed this activity". It was split out of `course_modules_completion` so that "viewed"
is tracked even when completion is off.

Completion states [source `lib/completionlib.php`]:

| Constant | Value | Meaning |
|---|---|---|
| `COMPLETION_INCOMPLETE` | 0 | Not completed (also the meaning of a missing row) |
| `COMPLETION_COMPLETE` | 1 | Completed |
| `COMPLETION_COMPLETE_PASS` | 2 | Completed **with a passing grade** |
| `COMPLETION_COMPLETE_FAIL` | 3 | Completed **with a failing grade** |
| `COMPLETION_COMPLETE_FAIL_HIDDEN` | 4 | internal: failed but the grade is hidden — never stored |
| `COMPLETION_UNKNOWN` | -1 | internal sentinel |

States 2 and 3 only occur when the activity has a `gradepass` and "require passing grade" is set.
**A state of 3 still means the activity is "done"** — if you are computing "how many activities are
finished" you must count 1, 2 and 3.

## 7.3 Tracking mode — `course_modules.completion`

| Constant | Value | Meaning |
|---|---|---|
| `COMPLETION_TRACKING_NONE` | 0 | No completion tracking for this activity |
| `COMPLETION_TRACKING_MANUAL` | 1 | The student ticks a box (`moodle/course:togglecompletion`) |
| `COMPLETION_TRACKING_AUTOMATIC` | 2 | Moodle evaluates rules |

The automatic rules are stored on `course_modules`:

* `completionview` (`COMPLETION_VIEW_REQUIRED = 1`) — must open the activity;
* `completiongradeitemnumber` — non-NULL means "must receive a grade"; the value is the
  `grade_items.itemnumber` to watch;
* `completionpassgrade` — must receive a *passing* grade;
* plus **module-specific rules** stored in the module's own table (`assign.completionsubmit`,
  `forum.completiondiscussions/completionreplies/completionposts`, `quiz.completionminattempts`, …).
  Those are documented per module in `activity-modules.md`.

`completionexpected` is a display-only "students should finish by" date. It also generates a calendar
event (§8.4).

## 7.4 What the API returns

`core_completion_get_activities_completion_status(courseid, userid)` [verified 4.5.13, course 42767]:

```json
{"statuses":[
  {"cmid": 3274931, "modname": "quiz", "instance": 78852,
   "state": 1,
   "timecompleted": 1737539954,
   "tracking": 2,
   "overrideby": null,
   "valueused": false,
   "hascompletion": true,
   "isautomatic": true,
   "istrackeduser": true,
   "uservisible": true,
   "details": [{"rulename": "completionusegrade",
                "rulevalue": {"status": 1, "description": "Receive a grade"}}],
   "isoverallcomplete": true},
  {"cmid": 3274953, "modname": "quiz", "instance": 78857,
   "state": 0, "timecompleted": 0, "tracking": 2, "overrideby": null,
   "valueused": false, "hascompletion": true, "isautomatic": true,
   "istrackeduser": true, "uservisible": true,
   "details": [{"rulename": "completionusegrade",
                "rulevalue": {"status": 0, "description": "Receive a grade"}}],
   "isoverallcomplete": false}
 ], "warnings":[]}
```

The identical structure is embedded per module in `core_course_get_contents` as **`completiondata`**
(without the `cmid`/`modname`/`instance` keys, which are already on the module object)
[verified 4.5.13]. So:

| You want | Read |
|---|---|
| One course, all activities, one user | `core_completion_get_activities_completion_status` → `statuses[].state` |
| Course structure *and* completion in one call | `core_course_get_contents` → `modules[].completiondata.state` |

Field meanings:

* **`state`** — `completionstate`, 0..3 as above. Present in both APIs.
* **`tracking`** — `course_modules.completion`, 0/1/2.
* **`hascompletion`** — `tracking != 0`.
* **`isautomatic`** — `tracking == 2`.
* **`istrackeduser`** — whether *this user's* completion is recorded at all. It is
  `is_enrolled($coursecontext, $userid, 'moodle/course:isincompletionreports', true)`
  [source `lib/completionlib.php::is_tracked_user()`]. Teachers are **not** tracked users by default
  (they lack that capability), so a teacher's own `state` will be 0 everywhere. If your integration
  authenticates as a teacher and reports "0% complete", this is why.
* **`uservisible`** — mirrors §3.7. A restricted activity shows `"uservisible": false` inside
  `completiondata` [verified 4.5.13].
* **`valueused`** — whether this activity's completion is used by a *course* completion criterion.
* **`overrideby`** — non-null when a teacher forced the state.
* **`details[]`** — one entry per automatic rule, `{rulename, rulevalue:{status, description}}`.
  Only returned for `isautomatic` activities [source
  `completion/classes/cm_completion_details.php::get_details()` returns `[]` early otherwise].
  Core rule names: `completionview` ("View"), `completionusegrade` ("Receive a grade"),
  `completionpassgrade` ("Receive a passing grade"); modules add their own via
  `\core_completion\activity_custom_completion` (`completionsubmit`, `completionminattempts`,
  `completiondiscussions`, `completionreplies`, `completionposts`, `completionentries`, …).
  `description` is **localised prose** — key on `rulename`.
* **`isoverallcomplete`** (4.3+) — the module's own verdict, folding in states 2/3. Prefer this over
  comparing `state == 1`.

### `completionstate` vs `completiondata`

`completionstate` is the raw DB column name and the name used by the older
`core_completion_update_activity_completion_status_manually` write API. `completiondata` is the
*structure* embedded in course contents, whose `state` key holds that value. They are not
alternatives — one is a field, the other is an object containing it.

## 7.5 Course completion

`{course_completions}` — one row per (user, course):

| Column | Meaning |
|---|---|
| `userid`, `course` | unique together |
| `timeenrolled`, `timestarted` | |
| `timecompleted` | **NULL until the course is complete** |
| `reaggregate` | non-zero = flagged for recomputation by the `\core\task\completion_regular_task` cron task |

`{course_completion_criteria}` — the rules, one row each:

| Column | Meaning |
|---|---|
| `course` | |
| `criteriatype` | see table below |
| `module` | module name, for ACTIVITY criteria |
| `moduleinstance` | despite the name, this is the **cmid** for ACTIVITY criteria |
| `courseinstance` | the other course's id, for COURSE criteria |
| `enrolperiod` | days after enrolment, for DURATION |
| `timeend` | deadline, for DATE |
| `gradepass` | required course grade, for GRADE |
| `role` | `role.id`, for ROLE (a holder of that role marks the student complete) |

| Constant | Value | Criterion |
|---|---|---|
| `COMPLETION_CRITERIA_TYPE_SELF` | 1 | Student ticks "complete this course" themselves |
| `COMPLETION_CRITERIA_TYPE_DATE` | 2 | After a fixed date |
| `COMPLETION_CRITERIA_TYPE_UNENROL` | 3 | On unenrolment |
| `COMPLETION_CRITERIA_TYPE_ACTIVITY` | 4 | A specific activity is complete |
| `COMPLETION_CRITERIA_TYPE_DURATION` | 5 | N days after enrolment |
| `COMPLETION_CRITERIA_TYPE_GRADE` | 6 | Course grade ≥ `gradepass` |
| `COMPLETION_CRITERIA_TYPE_ROLE` | 7 | Manually marked by a holder of `role` |
| `COMPLETION_CRITERIA_TYPE_COURSE` | 8 | Another course is complete |

`{course_completion_crit_compl}` — one row per (user, course, criteriaid) that has been *met*, with
`timecompleted`, `gradefinal`, `unenroled`.

`{course_completion_aggr_methd}` — how criteria combine:

| Column | Meaning |
|---|---|
| `course` | |
| `criteriatype` | **NULL = the overall aggregation across criteria types**; otherwise the aggregation *within* one type |
| `method` | `COMPLETION_AGGREGATION_ALL = 1`, `COMPLETION_AGGREGATION_ANY = 2` (the schema comment also lists 3 = fraction, 4 = unit, which the UI does not expose) |
| `value` | NULL for all/any |

So the model is two-level: within each criteria type (ALL activities vs ANY activity), and then
across types.

[verified 4.5.13] `core_completion_get_course_completion_status(courseid=2167, userid)` on a completed
course:

```json
{"completionstatus":{
   "completed": true,
   "aggregation": 1,                          // COMPLETION_AGGREGATION_ALL
   "completions": [
     {"type": 4, "title": "Activity completion", "status": "Yes",
      "complete": true, "timecompleted": 1726653092,
      "details": {"type": "Activity completion",
                  "criteria": "<a href=\"https://…/mod/lesson/view.php?id=759508\">Why should I care</a>",
                  "requirement": "", "status": ""}},
     … one entry per criterion …
   ]}, "warnings":[]}
```

Note `details.criteria` is **HTML containing a link whose `id=` is the cmid** — that is the only
machine-usable identifier in that payload. `type` is the `COMPLETION_CRITERIA_TYPE_*` value.
`title`, `requirement` and `status` are localised strings.

`core_enrol_get_users_courses` surfaces the same information cheaply as `completionhascriteria`
(are there any criteria rows?), `completionusertracked` (is this user tracked?), `progress` (percent
of *activity* completion, independent of criteria) and `completed`.

## 7.6 Timing and staleness

Activity completion is updated **synchronously** for view- and submission-based rules, but
grade-based rules fire from the gradebook, which itself may be recomputed by cron
(`grade_items.needsupdate`). Course completion is aggregated by a scheduled task, not immediately.
Expect lag of up to the cron interval between "student was graded" and
"course_completions.timecompleted is set".

---

# 8. Calendar and events

Reference: <https://moodledev.io/docs/apis/core/calendar>; source `calendar/lib.php`,
`calendar/classes/local/event/*`, `calendar/classes/external/event_exporter_base.php`.

## 8.1 `{event}`

| Column | Meaning |
|---|---|
| `id` | |
| `name`, `description`, `format` | `format` is a `FORMAT_*` value (§11) |
| `categoryid`, `courseid`, `groupid`, `userid` | **which one is non-zero determines the event's scope** |
| `repeatid` | groups a repeating series; equals the first event's id |
| `component` | e.g. `mod_assign`, `mod_quiz`; NULL for user-created events. **Only the owning component may edit/delete it** |
| `modulename` | module name for activity events |
| `instance` | the module **instance** id (`{assign}.id`) — see §1.3 |
| `type` | `CALENDAR_EVENT_TYPE_STANDARD = 0` or `CALENDAR_EVENT_TYPE_ACTION = 1` |
| `eventtype` | a *string* — see §8.2 |
| `timestart` | when the event happens |
| `timeduration` | seconds; 0 = point in time |
| `timesort` | when it should appear in "upcoming" lists — usually equals `timestart`, but not always (§8.3) |
| `visible` | 0 = hidden |
| `priority` | for override events: higher wins when several events share `(modulename, instance, eventtype)`. `CALENDAR_EVENT_USER_OVERRIDE_PRIORITY = 0` |
| `location` | free text (4.0+) |
| `uuid`, `sequence`, `subscriptionid` | iCal import/subscription plumbing |
| `timemodified` | |

Indexes worth knowing: `(type, timesort)` — the dashboard query; `(modulename, instance, eventtype)`
— how modules find and update their own events; `(component, eventtype, instance)`.

## 8.2 Event scope vs `eventtype`

There are two orthogonal classifications and they are easy to confuse.

**Scope** is determined by which of `userid`/`groupid`/`courseid`/`categoryid` is set, and by the
`eventtype` string for the non-module cases:

| `eventtype` | Scope | Visible to |
|---|---|---|
| `'user'` | personal | just that user |
| `'course'` | one course | everyone in the course |
| `'group'` | one group | members of the group |
| `'category'` | one category | everyone in courses in that category |
| `'site'` | site-wide | everyone |

The legacy bitmask constants `CALENDAR_EVENT_SITE 1`, `CALENDAR_EVENT_COURSE 2`,
`CALENDAR_EVENT_GROUP 4`, `CALENDAR_EVENT_USER 8`, `CALENDAR_EVENT_COURSECAT 16` are used for
*filtering* queries, not stored on the row.

**Module events** set `component`/`modulename`/`instance` and use a module-defined `eventtype`
string. Common ones:

| `eventtype` | Emitted by | Meaning |
|---|---|---|
| `'due'` | assign, quiz(`close`), lesson, data, forum, workshop, feedback, scorm | Deadline |
| `'gradingdue'` | assign | Teacher's grading deadline |
| `'open'` / `'close'` | quiz, choice, feedback, lesson, scorm, workshop | Availability window ends |
| `'opensubmission'` / `'closesubmission'` | workshop | |
| `'openassessment'` / `'closeassessment'` | workshop | |
| `'expectcompletionon'` | **core**, for any module with `completionexpected` | "you should be done by" |

The exporter also produces a `normalisedeventtype` field, which flattens module events to
`"course"`: *"Activity events are normalised to 'look' like course events"*
[source `event_exporter_base.php`]. So `normalisedeventtype` is for CSS, not for logic.

## 8.3 `timestart` vs `timesort`

* `timestart` — the semantic moment: "this quiz closes at 14:00".
* `timesort` — the moment used for ordering and for the "upcoming events / timeline" queries.

For most events they are equal. They diverge where a module wants an event to *surface* at a
different time than it *occurs* — historically the assign `gradingdue` event, and any module that
overrides `get_sort_time()`. Always **query and order by `timesort`**
(`core_calendar_get_action_events_by_timesort` demands a `timesortfrom`/`timesortto`, not a
`timestart`).

`timeusermidnight` in the exported output is the user-timezone midnight of the event's day — use it
for day bucketing rather than doing timezone maths yourself.

## 8.4 Why one activity produces several events

Every date field a module exposes becomes its own `{event}` row. One quiz with an open date, a close
date and an expected-completion date yields three rows sharing `(modulename='quiz', instance=N)` and
differing in `eventtype`. [verified 4.5.13] a single quiz cmid 4176595 appeared twice in one
action-event page:

```
1913567  quiz  close               instance(cmid)=4176595  timesort=1788758100
2118836  quiz  expectcompletionon  instance(cmid)=4176595  timesort=1788758100
```

Deduplicate on `(modulename, instance, eventtype)` — **not** on the activity — or your "deadlines"
list will double-count.

User and group *overrides* add still more rows: a quiz with a per-user override creates a second
`close` event with `userid` set and `priority` non-null. The one with the higher `priority` wins for
that user.

## 8.5 Action events and `\core_calendar\action_factory`

An **action event** is a calendar event that has something for *this* user to do. It is produced at
read time, not stored:

1. `container::apply_component_provide_event_action()` calls the owning component's
   `core_calendar_provide_event_action($event, $factory, $userid)` callback.
2. The module builds an action via `\core_calendar\action_factory::create_instance($name, $url,
   $itemcount, $actionable)` [source `calendar/classes/action_factory.php`].
3. If the callback returns `null` (or the module doesn't implement it), the event stays an ordinary
   event and **is not shown on the dashboard timeline at all**.

The exported `action` object [verified 4.5.13]:

```json
"action": {"name": "Add submission",
           "url": "https://…/mod/assign/view.php?id=4461003&action=editsubmission",
           "itemcount": 1,
           "actionable": true,
           "showitemcount": false}
```

* `name` — localised call to action ("Add submission", "Attempt quiz now", "View choices",
  "View workshop summary", "Grade" for teachers).
* `itemcount` — how many things need doing (for a teacher: the number of ungraded submissions).
* `actionable` — whether the user can act *right now* (e.g. before the open date this is `false`).
* `showitemcount` — whether the UI should render the count.

## 8.6 When an event disappears from the action list

[source `calendar/classes/local/event/container.php::apply_component_is_event_visible()`]:

```php
// Do not display the event if there is nothing to action.
if ($event instanceof action_event_interface && $event->get_action()->get_item_count() === 0) {
    return false;
}
```

plus the module's optional `core_calendar_is_event_visible($event, $userid)` callback.

Concretely, an event vanishes from `core_calendar_get_action_events_by_*` when:

* **the student has submitted** — `mod_assign` returns `itemcount = 0` once a submission exists;
* the quiz has been attempted to its attempt limit;
* the activity is no longer `uservisible` (hidden, restricted, unenrolled);
* the module's `core_calendar_provide_event_action` returns `null` (e.g. a `gradingdue` event for a
  user who is not a grader);
* the course is hidden or the user's enrolment has ended.

It does **not** vanish merely because the deadline passed — see `overdue`.

Because visibility is computed per requesting user, **you cannot cache an action-event list across
users**, and the same event id will be present for one user and absent for another.

## 8.7 `overdue`

[source `event_exporter_base.php`, constructor]:

```php
$data->overdue = $data->timesort < time();
```

That is the entire definition: `overdue` is `true` iff the event's `timesort` is in the past. It says
nothing about whether the student actually did the work — an event that is still in the action list
*and* overdue means "past due and still not done", because a completed item would have been filtered
out by §8.6. [verified 4.5.13 — one assignment came back `"overdue": true` with an
`"Add submission"` action still attached.]

## 8.8 The two read APIs, side by side

[verified 4.5.13] the same event id 2133415 via both functions:

```jsonc
// core_calendar_get_calendar_events — close to the raw table
{"id":2133415,"name":"Guest Lecture 01 (Ankur Dahama) Learning Diary is due",
 "description":"","format":1,"courseid":58630,"categoryid":null,"groupid":null,
 "userid":133288,"repeatid":null,"modulename":"assign","instance":284465,
 "eventtype":"due","timestart":1788469200,"timeduration":0,
 "visible":1,"sequence":1,"timemodified":1787897280,"subscriptionid":null}

// core_calendar_get_action_events_by_timesort — exported, user-specific
{"id":2133415,"name":"…","descriptionformat":1,"location":"",
 "categoryid":null,"groupid":null,"userid":133288,"repeatid":null,"eventcount":null,
 "component":"mod_assign","modulename":"assign",
 "activityname":"Guest Lecture 01 (Ankur Dahama) Learning Diary",
 "activitystr":"Assignment is due",
 "instance":4445248,                     //  <-- CMID here!
 "eventtype":"due","timestart":1788469200,"timeduration":0,
 "timesort":1788469200,"timeusermidnight":1788382800,
 "visible":1,"timemodified":1787897280,"overdue":false,
 "icon":{"key":"monologo","component":"assign","alttext":"Activity event","iconurl":"…"},
 "course":{ …full course summary… },
 "subscription":{"displayeventsource":false},
 "canedit":false,"candelete":false,
 "deleteurl":"…/calendar/delete.php?id=2133415&course=58630",
 "editurl":"…/course/mod.php?update=4445248&return=1&sesskey=…",
 "viewurl":"…/calendar/view.php?view=day&course=58630&time=1788469200#event_2133415",
 "formattedtime":"<span …><a …>Thursday, 3 September</a>, 2:00 PM</span>",
 "formattedlocation":"",
 "isactionevent":true,"iscourseevent":false,"iscategoryevent":false,
 "groupname":null,"normalisedeventtype":"course","normalisedeventtypetext":"Course event",
 "action":{"name":"Add submission","url":"…/mod/assign/view.php?id=4445248&action=editsubmission",
           "itemcount":1,"actionable":true,"showitemcount":false},
 "purpose":"assessment","branded":false,
 "url":"https://moodle.tuni.fi/mod/assign/view.php?id=4445248"}
```

`activitystr` comes from the module's `core_calendar_get_event_action_string` callback, falling back
to the generic *"<Modulename> requires action"* string. `formattedtime` is **pre-rendered HTML in the
user's language and timezone** — never parse it; use `timestart`/`timesort`.

The action-event endpoints return `firstid`/`lastid` alongside `events[]` for cursor paging
(`aftereventid`); `limitnum` is capped at 50 [source `calendar/classes/local/api.php`].

---

# 9. Groups and groupings

Reference: <https://moodledev.io/docs/apis/core/group>; source `lib/grouplib.php`.

## 9.1 Tables

`{groups}`: `id`, `courseid`, `idnumber`, `name`, `description`, `descriptionformat`, `enrolmentkey`,
`picture`, **`visibility`**, **`participation`**, `timecreated`, `timemodified`.

`{groupings}`: `id`, `courseid`, `name`, `idnumber`, `description`, `descriptionformat`, `configdata`.

`{groups_members}`: `groupid`, `userid`, `timeadded`, `component`, `itemid` — unique on
`(userid, groupid)`. `component`/`itemid` mark memberships created by a plugin (cohort sync, LTI,
`enrol_*`), which cannot be removed through the normal UI.

`{groupings_groups}`: `groupingid`, `groupid`, `timeadded`. A group may belong to several groupings
**within the same course**.

Groups and groupings are strictly **course-scoped**. There is no site-level group (that is what
`{cohort}` is for).

`groups.visibility` (4.3+) [source `lib/grouplib.php`]:

| Constant | Value | Who can see the membership |
|---|---|---|
| `GROUPS_VISIBILITY_ALL` | 0 | Everyone in the course |
| `GROUPS_VISIBILITY_MEMBERS` | 1 | Only members of that group |
| `GROUPS_VISIBILITY_OWN` | 2 | Members see only themselves |
| `GROUPS_VISIBILITY_NONE` | 3 | Nobody (except those with group-management capability) |

`groups.participation` (4.3+): 0 = the group exists for organisation only and cannot be selected for
group activity work.

## 9.2 Group modes

| Constant | Value | Effect |
|---|---|---|
| `NOGROUPS` | 0 | Groups are ignored |
| `SEPARATEGROUPS` | 1 | Users only see, and only interact with, members of their own group(s) |
| `VISIBLEGROUPS` | 2 | Users work in their own group but can *see* the other groups' work |

Set at two levels:

* `course.groupmode` + `course.groupmodeforce`
* `course_modules.groupmode`

[source `lib/grouplib.php::groups_get_activity_groupmode()`]:

```php
return empty($course->groupmodeforce) ? $cm->groupmode : $course->groupmode;
```

So: **if `course.groupmodeforce = 1` the course-level mode wins everywhere and the per-activity
setting is ignored.** Otherwise each activity decides for itself. `cm_info::effectivegroupmode`
precomputes this and is what `core_course_get_contents` reports as the module's `groupmode`
[verified 4.5.13 — modules carried `"groupmode": 0`].

`course_modules.groupingid` further restricts an activity to the groups in one grouping;
`course.defaultgroupingid` supplies the default for new activities.

## 9.3 How group mode filters API results

`moodle/site:accessallgroups` (defined at `CONTEXT_MODULE`, default archetypes editingteacher +
manager) is the master bypass. Without it, under `SEPARATEGROUPS`:

| Function | Filtering |
|---|---|
| `core_enrol_get_enrolled_users` | Only users sharing a group with you |
| `core_group_get_activity_allowed_groups` | Only your own groups; also returns `canaccessallgroups` |
| `core_group_get_course_user_groups` | The groups a user is in (only visible ones per §9.1) |
| `mod_forum_get_forum_discussions` | Only discussions in your group(s) + all-participants ones |
| `mod_assign_get_submissions` | Only your group's submissions |
| `gradereport_*` | Only your group's rows |
| calendar | Group events only for your groups |
| availability `group`/`grouping` conditions | evaluated against your memberships; `accessallgroups` holders always pass [source `availability/condition/group/classes/condition.php`] |

[verified 4.5.13, as a student] `core_group_get_activity_allowed_groups(cmid)` returned
`{"groups": [], "canaccessallgroups": false}` and `core_group_get_course_user_groups(courseid,
userid)` returned `{"groups": []}` for a course with no groups — an empty `groups[]` is the normal
"no groups here" answer, not an error. `core_group_get_course_groupings` requires
`moodle/course:managegroups` and returned a `required_capability_exception` (*"Manage groups"*) for a
student — **listing groupings is a teacher-only operation.**

Under `VISIBLEGROUPS` the *visibility* filters relax but the *participation* ones do not: a student
can read the other groups' forum discussions but cannot post in them.

## 9.4 The "all participants" pseudo-group

`groupid = 0` in a query means "all participants" / "no group filter". Content posted with
`groupid = 0` (e.g. a forum discussion with no group) is visible to every group. Do not treat 0 as a
real group id.

---

# 10. The Files API

Reference: <https://moodledev.io/docs/apis/subsystems/files>; source `lib/filestorage/*`,
`lib/filelib.php`.

Moodle never stores a file "in a folder". It stores **content** in a SHA-1-addressed pool on disk and
**metadata** in the `{files}` table. A file's *identity* is a six-part address.

## 10.1 `{files}`

| Column | Meaning |
|---|---|
| `id` | |
| `contenthash` | SHA-1 of the file **content**. Identical files anywhere on the site share one pool entry — this is Moodle's deduplication |
| `pathnamehash` | SHA-1 of the file's **address**. Unique index. This is the lookup key |
| `contextid` | → `context.id`. Which context owns the file |
| `component` | frankenstyle owner: `mod_resource`, `mod_assign`, `user`, `course`, `question`, `block_html`, … |
| `filearea` | the owner's sub-area: `content`, `intro`, `submission_files`, `draft`, `summary`, `overviewfiles`, `section`, `post`, `attachment`, … |
| `itemid` | plugin-defined sub-key: 0 when unused, otherwise a submission id, forum post id, draft id, user id, … |
| `filepath` | virtual directory, **always begins and ends with `/`** (`/`, `/images/`) |
| `filename` | file name; **`'.'` marks a *directory* record** |
| `filesize`, `mimetype` | `filesize = 0` and `mimetype = NULL` for directory records |
| `userid` | who uploaded it (plugin-defined meaning) |
| `author`, `license` | metadata for reuse |
| `source` | original filename / import reference |
| `status` | > 0 means something is wrong (infected, missing) |
| `sortorder` | display order; `sortorder = 1` conventionally marks "the main file" of a resource |
| `referencefileid` | → `{files_reference}.id` when the file is an **alias** to an external repository |
| `timecreated`, `timemodified` | |

The address hash [source `lib/filestorage/file_storage.php`]:

```php
public static function get_pathname_hash($contextid, $component, $filearea, $itemid, $filepath, $filename) {
    if (substr($filepath, 0, 1) != '/') { $filepath = '/' . $filepath; }
    if (substr($filepath, -1)   != '/') { $filepath .= '/'; }
    return sha1("/$contextid/$component/$filearea/$itemid".$filepath.$filename);
}
```

You can compute a `pathnamehash` client-side and check it against what the API gave you — useful for
detecting a moved/renamed file.

`{files_reference}`: `repositoryid`, `reference`, `referencehash`, `lastsync`. An **alias** (Moodle's
term for a live link into Dropbox/Google Drive/a file-system repository) has `files.referencefileid`
set and its `contenthash` is only a cached copy. The API exposes this as
`"isexternalfile": true` plus `"repositorytype"` in `contentsinfo`. [verified 4.5.13 — all files
returned `"isexternalfile": false` and `"repositorytype": ""`, i.e. ordinary uploaded files; no
external-repository example was available on the test site.]

## 10.2 Serving files: `pluginfile.php`

Files are **never** served from a public path. Every request goes through a PHP script that
re-checks permissions by calling the owning component's `<component>_pluginfile()` callback.

```
{wwwroot}/pluginfile.php/{contextid}/{component}/{filearea}/{itemid}/{filepath}{filename}
```

Variants:

| Script | Auth | Used by |
|---|---|---|
| `pluginfile.php` | the browser session cookie | normal web pages |
| `webservice/pluginfile.php?token=…` | a web-service token | **what the external API returns** |
| `tokenpluginfile.php/{token}/…` | a per-user file key (`{user_private_key}`, `core_files` script) | embedded content in mobile app / `includetoken` |
| `draftfile.php` | session | draft areas |

[verified 4.5.13] `core_course_get_contents` returned:

```
https://moodle.tuni.fi/webservice/pluginfile.php/6345135/mod_resource/content/1/Basics%20of%20Industrial%20Management_2026.pdf?forcedownload=1
                                                 ^context  ^component   ^area   ^"itemid"  ^filename
```

and the module's own `contextid` in the same JSON was `6345135` — confirming the first path segment
is the **module context id**, not the cmid.

**The segment after `filearea` is not always `itemid`.** Several components put a *revision number*
there for cache-busting and then look the file up with `itemid = 0`:

```php
// mod/resource/lib.php::resource_pluginfile()
array_shift($args);   // ignore revision - designed to prevent caching problems only
$fullpath = rtrim("/$context->id/mod_resource/$filearea/0/$relativepath", '/');
```

So for `mod_resource` the `/1/` in the URL above is a revision, and the real `files.itemid` is `0`.
Do not reverse-engineer `itemid` from a URL; take it from the API's file record where available, or
just fetch the URL you were given verbatim.

You must append your token to `webservice/pluginfile.php` URLs yourself
(`&token=…`); the API returns them without one. Details in `web-services-api.md`.

## 10.3 Draft areas

When a user edits a form containing files, Moodle first copies them into a **draft area**:

```
contextid  = the USER's context (CONTEXT_USER, instanceid = user.id)
component  = 'user'
filearea   = 'draft'
itemid     = a random "draftitemid" obtained from core_files_get_unused_draft_itemid()
```

On submit, the plugin calls `file_save_draft_area_files()` which syncs the draft area into the real
area. Consequences:

* draft files belong to the *user*, not the activity, until the form is saved;
* `draftfile.php` (not `pluginfile.php`) serves them;
* unsaved drafts are garbage-collected after `$CFG->draftfilelifetime` (default 4 days);
* any write API that accepts files (`mod_assign_save_submission`, `core_user_add_user_private_files`)
  takes a `draftitemid`, never raw bytes.

## 10.4 File metadata in API responses

The standard file record returned inside `contents[]`, `introfiles[]`, `attachments[]` etc.
[verified 4.5.13]:

```json
{"type": "file", "filename": "Study Guide 2026.pdf", "filepath": "/",
 "filesize": 432624,
 "fileurl": "https://…/webservice/pluginfile.php/6345136/mod_resource/content/1/Study%20Guide%202026.pdf?forcedownload=1",
 "timecreated": 1787391821, "timemodified": 1787391823,
 "sortorder": 1, "mimetype": "application/pdf",
 "isexternalfile": false, "userid": 2873,
 "author": "Jouni Lyly-Yrjänäinen", "license": "allrightsreserved"}
```

and the summary block:

```json
"contentsinfo": {"filescount": 1, "filessize": 3200413, "lastmodified": 1787391764,
                 "mimetypes": ["application/pdf"], "repositorytype": ""}
```

`type` can also be `"url"` (a URL resource) or `"content"` (inline HTML) — check it before assuming
`fileurl` points at a real file.

`license` holds a **shortname** from `{license}`. Core ships nine
[source `lib/licenses.json`, 4.5]:

`unknown`, `allrightsreserved`, `public`, `cc-4.0`, `cc-nc-4.0`, `cc-nd-4.0`, `cc-nc-nd-4.0`,
`cc-nc-sa-4.0`, `cc-sa-4.0`

Older sites carry the retired `cc`, `cc-nd`, `cc-nc-nd`, `cc-nc`, `cc-nc-sa`, `cc-sa` shortnames
(disabled but still referenced by old files). `{license}.custom = 1` marks site-added licences.

## 10.5 Reading the file table directly

`core_files_get_files(contextid, component, filearea, itemid, filepath, filename)` walks a file area
like a directory listing, returning `{parents: [...], files: [...]}`. [verified 4.5.13] it returned
`{"parents": [], "files": []}` for `mod_resource/content` with `itemid=0` — either because the
student lacks the capability the component's `pluginfile` callback requires, or because the revision
indirection means the caller guessed the wrong `itemid`. **In practice, prefer the file lists
embedded in module-specific functions over `core_files_get_files`.**

---

# 11. Text formats and filters

Reference: <https://moodledev.io/docs/apis/subsystems/output/format_text>; source `lib/weblib.php`,
`lib/filterlib.php`, `lib/external/classes/util.php`.

## 11.1 The `*format` columns

Every text column in Moodle is paired with an integer `…format` column. The constants are **strings
containing digits** in PHP but come back as JSON numbers [source `lib/weblib.php`]:

| Constant | Value | Meaning |
|---|---|---|
| `FORMAT_MOODLE` | 0 | Legacy "Moodle auto-format": plain text with auto-linking and `\n` → `<br>` |
| `FORMAT_HTML` | 1 | Raw HTML. **The default for everything modern** |
| `FORMAT_PLAIN` | 2 | Plain text, no processing, HTML escaped |
| `FORMAT_WIKI` | 3 | **Removed.** Never produced; may still exist in ancient rows |
| `FORMAT_MARKDOWN` | 4 | Markdown, converted to HTML on output |

`\core_external\util::validate_format()` accepts only `HTML`, `MOODLE`, `PLAIN`, `MARKDOWN` and
throws `formatnotsupported` otherwise.

[verified 4.5.13] real values seen: course `summaryformat: 1`, section `summaryformat: 1`, calendar
event `descriptionformat: 1`, and a grade feedback with `feedbackformat: 4` (Markdown) —
**so you will meet Markdown in the wild, in feedback fields especially.**

## 11.2 `format_text()` and what the web service does

`format_text($text, $format, $options)` is the server-side renderer. It (a) converts the source
format to HTML, (b) cleans the HTML unless `$CFG->forceclean` says otherwise, and (c) runs the
**filters** for the given context.

Over the external API this is wrapped by `\core_external\util::format_text($text, $textformat,
$context, $component, $filearea, $itemid)` [source `lib/external/classes/util.php`], which does three
things in order:

1. **Rewrite `@@PLUGINFILE@@`** — if `$component` and `$filearea` were supplied and the `fileurl`
   setting is on.
2. **Run `format_text()`** — unless the caller asked for raw.
3. **Rewrite the reported format to `FORMAT_HTML`** — *"Once converted to html (from markdown,
   plain…) let's inform consumer this is already HTML"*.

So: when `moodlewssettingraw = 0` (the default) **every text field you receive is HTML and its
`*format` field says `1`, regardless of how it was authored.** If you set `moodlewssettingraw = 1`
you get the DB content verbatim and the true format value — including unrewritten `@@PLUGINFILE@@`
placeholders and unrendered Markdown.

The per-request settings and their **web-service defaults**
[source `lib/external/classes/external_settings.php`]:

| Setting | WS default | Effect |
|---|---|---|
| `raw` | `false` | skip `format_text()` entirely, return DB content |
| **`filter`** | **`false`** | run text filters (multilang, MathJax, media, …) |
| `fileurl` | `true` | rewrite `@@PLUGINFILE@@` |
| `file` | `'webservice/pluginfile.php'` | the script embedded in rewritten URLs |
| `lang`, `timezone` | `''` | override for this request |

⚠️ Note that `filter` defaults to **false for web services** but **true for normal page loads**
(the constructor flips it when not in `WS_SERVER` mode). **This is why multilang tags come back
un-processed over the API by default** — see §11.4.

## 11.3 `@@PLUGINFILE@@`

Text authored in the editor may embed images and links to files that live in the *same* file area as
the text. Moodle stores those URLs as the placeholder `@@PLUGINFILE@@/<filepath><filename>` so the
text survives a backup/restore into a different context.

[source `lib/filelib.php::file_rewrite_pluginfile_urls()`]:

```php
$baseurl  = "{$CFG->wwwroot}/{$file}";          // e.g. .../webservice/pluginfile.php
$baseurl .= "/{$contextid}/{$component}/{$filearea}/";
if ($itemid !== null) { $baseurl .= "$itemid/"; }
return str_replace('@@PLUGINFILE@@/', $baseurl, $text);
```

With `options['reverse'] = true` it does the inverse (used when saving).
With `options['includetoken']` it emits `tokenpluginfile.php/{userkey}/…` instead, so the URL works
without a session — this is how the Moodle app embeds images.

**Practical rule:** if you ever see the literal string `@@PLUGINFILE@@` in API output, the text is
unusable as-is. It means either `moodlewssettingraw = 1`, or the function forgot to pass
`component`/`filearea` to `format_text` (a real and not-uncommon Moodle bug in third-party plugins).
Either fetch it non-raw, or rewrite it yourself using the record's `contextid` + the component's file
area (usually `<component>` + `intro`/`content`).

[Could not verify live: no content accessible to the test account contained embedded files, so no
`@@PLUGINFILE@@` placeholder appeared in either raw or non-raw responses on the 4.5.13 site. The
mechanism above is from source.]

## 11.4 Filters

`{filter_active}`: `(filter, contextid, active, sortorder)`, unique on `(contextid, filter)`.

| Constant | Value | Meaning |
|---|---|---|
| `TEXTFILTER_ON` | 1 | enabled here |
| `TEXTFILTER_INHERIT` | 0 | inherit from the parent context (usually stored as *no row*) |
| `TEXTFILTER_OFF` | -1 | disabled here |
| `TEXTFILTER_DISABLED` | -9999 | **only meaningful at the system context**: the filter is switched off site-wide |

`sortorder` is only used on the system-context rows and fixes the order filters run in.
`{filter_config}` holds `(filter, contextid, name, value)` per-context filter settings.

`core_course_get_courses_by_field` exposes the resolved state per course [verified 4.5.13]:

```json
"filters": [
  {"filter":"filtercodes","localstate":0,"inheritedstate":1},
  {"filter":"multilang","localstate":0,"inheritedstate":1},
  {"filter":"multilang2","localstate":0,"inheritedstate":1},
  {"filter":"mathjaxloader","localstate":0,"inheritedstate":1},
  {"filter":"mediaplugin","localstate":0,"inheritedstate":1},
  {"filter":"jsxgraph","localstate":0,"inheritedstate":1},
  {"filter":"glossary","localstate":0,"inheritedstate":-1},
  {"filter":"imageopt","localstate":0,"inheritedstate":-1},
  {"filter":"displayh5p","localstate":0,"inheritedstate":1}
]
```

`localstate` = the course's own `filter_active.active` (0 = inherit), `inheritedstate` = what it
resolves to. Note this list mixes core filters (`multilang`, `mathjaxloader`, `mediaplugin`,
`glossary`, `displayh5p`, `activitynames`, `urltolink`, `emoticon`, `censor`, `emailprotect`) with
site-installed contributed ones (`filtercodes`, `multilang2`, `jsxgraph`, `imageopt`) — **assume
nothing about which filters a site runs.**

### Multilang

Two conventions coexist:

* **core `filter_multilang`**: `<span lang="en" class="multilang">English</span><span lang="fi"
  class="multilang">Suomeksi</span>` (also accepts `<lang lang="xx">`).
* **contributed `filter_multilang2`**: `{mlang en}English{mlang}{mlang fi}Suomeksi{mlang}`. Very
  widely deployed in bilingual countries — the test site has it enabled.

With `moodlewssettingfilter = 0` (the API default) **both syntaxes reach you literally**, so a course
name may arrive as
`{mlang en}Introduction to X{mlang}{mlang fi}Johdatus X:ään{mlang}`.
Either set `moodlewssettingfilter=1` (plus `moodlewssettinglang=<code>`) and let the server pick, or
strip the markup client-side. `format_string()` (used for short names/titles) applies multilang too,
but only when filters are on.

[Could not verify live: no multilang-tagged strings were present in the courses accessible to the
test account, so the raw-vs-filtered difference was not observed on 4.5.13. Both filters were
reported as active at course level.]

### Other filters that change text materially

* `mathjaxloader` — leaves `\( … \)` / `$$ … $$` alone but injects a script tag; over the API you get
  the raw TeX, which is usually what you want.
* `mediaplugin` — turns a bare link to an `.mp4`/`.mp3` into an embedded player. Over the API with
  filters off you get the plain link.
* `activitynames` / `glossary` — turn matching words into links. These *add* markup that is not in
  the DB.
* `filter_urltolink`, `filter_emoticon`, `filter_censor` — cosmetic.

## 11.5 `format_string()` vs `format_text()`

* `format_string()` — for **short, single-line, no-HTML-expected** values: course names, activity
  names, section names, group names. Strips tags (unless `$CFG->formatstringstriptags` is off), runs
  multilang, does **not** run the full filter chain.
* `format_text()` — for **rich content**: summaries, intros, forum posts, feedback. Full pipeline.

The external API applies `format_string()` to `name`/`fullname`/`shortname` fields and
`format_text()` to `summary`/`description`/`intro`/`content`/`feedback`. That is why a `name` never
contains HTML but a `summary` always does.

---

# 12. Users, profile fields and preferences

## 12.1 `{user}` essentials

| Column | Notes |
|---|---|
| `id` | the userid. `id = 1` is the **guest** account on a default install; `id = 2` is the first admin |
| `username` | unique together with `mnethostid` |
| `auth` | auth plugin: `manual`, `email`, `shibboleth`, `oauth2`, `ldap`, `nologin`, `webservice`, … |
| `idnumber` | institutional id — the field a SIS integration should key on. Not unique at DB level |
| `firstname`, `lastname`, `middlename`, `alternatename`, `firstnamephonetic`, `lastnamephonetic` | the full "all names" set; `fullname()` composes them per `$CFG->fullnamedisplay` |
| `email`, `emailstop`, `maildisplay`, `mailformat`, `maildigest` | `maildisplay` controls who may see the address |
| `deleted` | 1 = soft-deleted. **Deleted users keep their row**, with `username` mangled and `email` cleared. Always filter `deleted = 0` |
| `suspended` | 1 = cannot log in, but is not deleted |
| `confirmed` | email confirmation |
| `policyagreed` | site policy acceptance |
| `lang`, `timezone`, `calendartype`, `theme` | `timezone = '99'` means "use the server default" |
| `firstaccess`, `lastaccess`, `lastlogin`, `currentlogin`, `lastip` | `lastaccess` is site-wide (see §12.3 for per-course) |
| `picture` | 0 = no picture; positive = a revision counter used for cache-busting in the image URL |
| `description`, `descriptionformat` | the profile "About me" |
| `city`, `country`, `institution`, `department`, `address`, `phone1`, `phone2` | |
| `trackforums`, `autosubscribe` | forum preferences that live on `user`, not in `user_preferences` |
| `mnethostid` | 0/local host id; MNet is legacy |
| `timecreated`, `timemodified` | |

Which of these a caller may see is decided by `$CFG->showuseridentity`,
`moodle/site:viewuseridentity`, `moodle/user:viewdetails` / `viewalldetails`, and `maildisplay`.
[verified 4.5.13] `core_user_get_users_by_field(field=id, values[0]=<self>)` returned `username`,
`email`, `idnumber`, `institution`, `auth`, `suspended`, `confirmed`, `lang`, `theme`, `timezone`,
`mailformat`, `trackforums`, `description`, `descriptionformat`, the two `profileimageurl*` fields —
**and a full `preferences[]` array** — because the caller was asking about themselves. For other
users most of that is stripped.

## 12.2 Custom profile fields

Three tables:

* `{user_info_category}` — `(name, sortorder)`, the tabs in the profile form.
* `{user_info_field}` — `(shortname, name, datatype, categoryid, sortorder, required, locked,
  visible, forceunique, signup, defaultdata, defaultdataformat, param1..param5)`.
  `datatype` is a `profilefield_*` plugin name: `text`, `textarea`, `checkbox`, `menu`, `datetime`,
  `social`. `param1..5` are plugin-defined (for `menu`, `param1` holds the newline-separated options).
  `visible`: 0 = not visible, 1 = visible to the user, 2 = visible to everyone.
* `{user_info_data}` — `(userid, fieldid, data, dataformat)`, unique on `(userid, fieldid)`.

Over the API custom fields appear as a `customfields[]` array of
`{type, value, displayvalue, name, shortname}` on user records (when the caller may see them). The
`shortname` is what availability `profile` conditions reference as `cf`.

**Note the naming collision:** `{user_info_field}` is the *user* custom-field system and predates the
generic 3.7+ custom-field API in `{customfield_category}` / `{customfield_field}` / `{customfield_data}`,
which is what **courses**, **course categories** and some modules use. They are different subsystems
with different tables. Course custom fields come back from `core_course_get_courses_by_field` as
`customfields[]`.

## 12.3 `{user_preferences}` and `{user_lastaccess}`

`{user_preferences}`: `(userid, name, value)`, unique on `(userid, name)`, `value` is
`VARCHAR(1333)`. It is Moodle's general per-user key-value store — anything a plugin wants to
remember about a user without a schema change goes here.

[verified 4.5.13] a real slice of one user's preferences:

```json
[{"name":"block_myoverview_hidden_course_2166","value":"1"},
 {"name":"block_myoverview_user_grouping_preference","value":"inprogress"},
 {"name":"block_myoverview_user_paging_preference","value":"0"},
 {"name":"block_timeline_user_filter_preference","value":"next7days"},
 {"name":"core_message_migrate_data","value":"1"},
 {"name":"core_user_welcome","value":"1724224197"},
 {"name":"coursesectionspreferences_41785","value":"{\"indexcollapsed\":[496418]}"},
 {"name":"c4l_components_variants","value":"{}"}]
```

Patterns worth knowing:

| Preference | Meaning |
|---|---|
| `block_myoverview_hidden_course_<courseid>` | the "hidden" flag reported by `core_enrol_get_users_courses` |
| `block_myoverview_user_grouping_preference` | the dashboard course filter (`all`, `inprogress`, `future`, `past`, `favourites`, `hidden`) |
| `block_timeline_user_filter_preference` | timeline range (`next7days`, `next30days`, `all`, `overdue`) |
| `coursesectionspreferences_<courseid>` | JSON: which sections the user has collapsed |
| `grade_report_showonlyactiveenrol` | gradebook: hide suspended users |
| `grade_report_user_showweight` / `_showaverage` | whether `weightraw`/`averageformatted` appear in the API (§6.10) |
| `htmleditor`, `filepickerviewmode`, `email_bounce_count` | misc |

Values are **always strings**, even when they hold JSON or a number.

`{user_lastaccess}`: `(userid, courseid, timeaccess)`, unique together. This is the per-course last
access, surfaced as `lastaccess` in `core_enrol_get_users_courses` [verified 4.5.13]. It is distinct
from `user.lastaccess` (site-wide) and from `user.lastlogin`/`currentlogin` (session-based).

## 12.4 What `core_webservice_get_site_info` tells you about the site

[verified 4.5.13] — this one call is the cheapest capability/feature probe there is:

```jsonc
{"sitename":"TUNI Moodle | Tampere universities",
 "username":"drv382@tuni.fi","userid":135266,"fullname":"Damir Kairov","lang":"en",
 "siteurl":"https://moodle.tuni.fi","siteid":1,
 "release":"4.5.13 (Build: 20260810)", "version":"2024100713",
 "functions":[{"name":"core_course_get_contents","version":"2024100713"}, … 450 entries …],
 "downloadfiles":1,"uploadfiles":1,
 "usercanmanageownfiles":true,"userquota":524288000,"usermaxuploadfilesize":1073741824,
 "userhomepage":1,"userprivateaccesskey":"…","userissiteadmin":false,
 "theme":"maisteriboost","sitecalendartype":"gregorian","usercalendartype":"gregorian",
 "limitconcurrentlogins":0,"policyagreed":1,
 "advancedfeatures":[{"name":"usecomments","value":1},{"name":"usetags","value":1},
   {"name":"enablenotes","value":1},{"name":"messaging","value":1},
   {"name":"enableblogs","value":0},{"name":"enablecompletion","value":1},
   {"name":"enablebadges","value":0},{"name":"messagingallusers","value":0},
   {"name":"enablecustomreports","value":1},{"name":"enableglobalsearch","value":0},
   {"name":"mnet_dispatcher_mode","value":0},{"name":"enablecompetencies","value":0}]}
```

* `siteid` is the front-page course id (always 1).
* `functions[]` is **the authoritative list of what this token may call** — 450 on the test site.
  Feature-detect against it instead of catching `dml_missing_record_exception` /
  `"Can't find data record in database table external_functions"`, which is what you get when you
  call a function the site has not exposed.
* `advancedfeatures[]` gates whole subsystems: `enablecompletion` 0 makes §7 return empty arrays,
  `enablebadges` 0 makes badge functions useless, `enablecompetencies` 0 likewise.
* `userprivateaccesskey` is the key for `tokenpluginfile.php` (§10.2).

---

# Appendix A — constant reference

## Context levels (`lib/accesslib.php`)
```
CONTEXT_SYSTEM 10   CONTEXT_USER 30   CONTEXT_COURSECAT 40
CONTEXT_COURSE 50   CONTEXT_MODULE 70 CONTEXT_BLOCK 80
```

## Capability permissions
```
CAP_INHERIT 0   CAP_ALLOW 1   CAP_PREVENT -1   CAP_PROHIBIT -1000
```

## Risk bitmask
```
RISK_MANAGETRUST 0x0001  RISK_CONFIG 0x0002  RISK_XSS 0x0004
RISK_PERSONAL    0x0008  RISK_SPAM   0x0010  RISK_DATALOSS 0x0020
```

## Enrolment (`lib/enrollib.php`)
```
ENROL_INSTANCE_ENABLED 0   ENROL_INSTANCE_DISABLED 1
ENROL_USER_ACTIVE      0   ENROL_USER_SUSPENDED    1
ENROL_MAX_TIMESTAMP 2147483647
ENROL_EXT_REMOVED_UNENROL 0  _KEEP 1  _SUSPEND 2  _SUSPENDNOROLES 3
```

## Grades (`lib/grade/constants.php`)
```
GRADE_TYPE_NONE 0   GRADE_TYPE_VALUE 1   GRADE_TYPE_SCALE 2   GRADE_TYPE_TEXT 3

GRADE_AGGREGATE_MEAN 0            GRADE_AGGREGATE_MEDIAN 2
GRADE_AGGREGATE_MIN  4            GRADE_AGGREGATE_MAX 6
GRADE_AGGREGATE_MODE 8            GRADE_AGGREGATE_WEIGHTED_MEAN 10
GRADE_AGGREGATE_WEIGHTED_MEAN2 11 GRADE_AGGREGATE_EXTRACREDIT_MEAN 12
GRADE_AGGREGATE_SUM 13            (Natural)

GRADE_DISPLAY_TYPE_DEFAULT 0   REAL 1   PERCENTAGE 2   LETTER 3
  REAL_PERCENTAGE 12  REAL_LETTER 13  PERCENTAGE_REAL 21
  PERCENTAGE_LETTER 23  LETTER_REAL 31  LETTER_PERCENTAGE 32

GRADE_REPORT_AGGREGATION_POSITION_FIRST 0   _LAST 1
GRADE_REPORT_HIDE_TOTAL_IF_CONTAINS_HIDDEN 0
GRADE_REPORT_SHOW_TOTAL_IF_CONTAINS_HIDDEN 1
GRADE_REPORT_SHOW_REAL_TOTAL_IF_CONTAINS_HIDDEN 2
GRADE_MIN_MAX_FROM_GRADE_ITEM 1   _FROM_GRADE_GRADE 2
```

## Completion (`lib/completionlib.php`, `completion/criteria/completion_criteria.php`)
```
COMPLETION_DISABLED 0   COMPLETION_ENABLED 1
COMPLETION_TRACKING_NONE 0  _MANUAL 1  _AUTOMATIC 2
COMPLETION_INCOMPLETE 0  COMPLETE 1  COMPLETE_PASS 2  COMPLETE_FAIL 3
  COMPLETE_FAIL_HIDDEN 4   COMPLETION_UNKNOWN -1   COMPLETION_GRADECHANGE -2
COMPLETION_VIEW_NOT_REQUIRED 0  _REQUIRED 1
COMPLETION_NOT_VIEWED 0  COMPLETION_VIEWED 1
COMPLETION_OR false   COMPLETION_AND true
COMPLETION_AGGREGATION_ALL 1   _ANY 2
COMPLETION_SHOW_CONDITIONS 1   COMPLETION_HIDE_CONDITIONS 0

COMPLETION_CRITERIA_TYPE_SELF 1  DATE 2  UNENROL 3  ACTIVITY 4
  DURATION 5  GRADE 6  ROLE 7  COURSE 8
```

## Calendar (`calendar/lib.php`)
```
CALENDAR_EVENT_SITE 1  COURSE 2  GROUP 4  USER 8  COURSECAT 16
CALENDAR_EVENT_TYPE_STANDARD 0   CALENDAR_EVENT_TYPE_ACTION 1
CALENDAR_EVENT_USER_OVERRIDE_PRIORITY 0
```

## Groups (`lib/grouplib.php`)
```
NOGROUPS 0   SEPARATEGROUPS 1   VISIBLEGROUPS 2
GROUPS_VISIBILITY_ALL 0  MEMBERS 1  OWN 2  NONE 3
```

## Course display (`lib/moodlelib.php`, `course/lib.php`)
```
COURSE_DISPLAY_SINGLEPAGE 0   COURSE_DISPLAY_MULTIPAGE 1
COURSE_TIMELINE_ALL / _ALLINCLUDINGHIDDEN / _PAST / _INPROGRESS / _FUTURE / _SEARCH / _HIDDEN
SITEID 1
```

## Text formats & filters (`lib/weblib.php`, `lib/filterlib.php`)
```
FORMAT_MOODLE 0  FORMAT_HTML 1  FORMAT_PLAIN 2  FORMAT_WIKI 3 (removed)  FORMAT_MARKDOWN 4
TEXTFILTER_ON 1  TEXTFILTER_INHERIT 0  TEXTFILTER_OFF -1  TEXTFILTER_DISABLED -9999
```

## Availability (`availability/classes/tree.php` and condition plugins)
```
OP_AND '&'   OP_OR '|'   OP_NOT_AND '!&'   OP_NOT_OR '!|'
date:      DIRECTION_FROM '>='   DIRECTION_UNTIL '<'
profile:   contains | doesnotcontain | isequalto | startswith | endswith | isempty | isnotempty
completion: OPTION_PREVIOUS -1
```

---

# Appendix B — what was verified live

Site: `https://moodle.tuni.fi`, **Moodle 4.5.13 (Build 20260810)**, `version 2024100713`, 450
exposed web-service functions, authenticated as an ordinary enrolled **student** (not a teacher, not
an admin). Everything was read-only (`*_get_*` functions only).

| § | Verified |
|---|---|
| 1.1, 1.4 | cmid / instance / contextid / section-row-id all distinct; `core_course_get_course_module` returning `section` (row id 738168) **and** `sectionnum` (1) for the same object |
| 1.3 | The **same event id 2133415** returning `instance: 284465` from `core_calendar_get_calendar_events` and `instance: 4445248` (the cmid) from `core_calendar_get_action_events_by_timesort` |
| 2.5 | `core\exception\required_capability_exception` / `errorcode: nopermissions` shape |
| 2.7 | `gradereport_user_get_access_information`, `core_calendar_get_calendar_access_information`, `core_calendar_get_allowed_event_types`, `core_course_get_user_navigation_options`, `core_group_get_activity_allowed_groups` outputs for a student |
| 3.1 | `core_course_get_categories` → `depth`, `path: "/8"`, `parent: 0` |
| 3.5 | `courseformatoptions` = `hiddensections`/`coursedisplay`/`indentation`; live courses using `topics`, `onetopic`, `grid`; `filters[]` with `localstate`/`inheritedstate` |
| 3.6 | **Delegated sections**: `component: "mod_subsection"`, `itemid`, the `subsection` module carrying `customdata: {"sectionid":"747015"}`, delegated sections returned flat as top-level sections 9–12 |
| 3.7 | Stealth activity (`visible 1`, `visibleoncoursepage 0`, `uservisible true`); restricted activity (`uservisible false` + `availabilityinfo`); hidden section returning `modules: []` |
| 3.8 | Full module object shape incl. `purpose`, `branded`, `activitybadge`, `dates[]`, `customdata` as a JSON *string*, `contents[]`, `contentsinfo` |
| 4.4 | `availabilityinfo: "Available from <strong>7 September 2026, 8:15 AM</strong>"` — rendered HTML, no raw JSON tree |
| 5.4 | `core_enrol_get_users_courses` full field list incl. `progress`, `completionusertracked`, `isfavourite`, `hidden`, `lastaccess` |
| 5.5 | `core_enrol_get_enrolled_users` roles array with `roleid` 3/5 and empty `name` |
| 6.10 | `gradereport_user_get_grade_items` for a fully-populated 29-item gradebook: `mod`/`manual`/`category`/`course` rows, empty `itemname` on category & course rows, `iteminstance` = `grade_categories.id`, `categoryid: null`, `cmid` only on `mod` rows, **absent** `weightraw`/`weightformatted` |
| 6.11 | `gradereport_overview_get_course_grades` returning `"-"` for every course including the one with grades |
| 6.12 | `gradereport_user_get_grades_table` HTML shape, `cat_<id>_<userid>` / `row_<id>_<userid>` ids, `parentcategories[]` |
| 7.1 | Empty `statuses[]` for a course with completion effectively unused |
| 7.4 | `core_completion_get_activities_completion_status` full shape incl. `details[].rulename = "completionusegrade"`, `istrackeduser`, `isoverallcomplete`; identical structure as `completiondata` inside `core_course_get_contents` |
| 7.5 | `core_completion_get_course_completion_status` with `aggregation: 1`, `type: 4` criteria and HTML `details.criteria` |
| 8.4 | One quiz cmid producing both a `close` and an `expectcompletionon` event with identical `timesort` |
| 8.5, 8.7 | `action` object with `name`/`url`/`itemcount`/`actionable`/`showitemcount`; `overdue: true` on a past-due assignment still carrying an "Add submission" action |
| 8.8 | Side-by-side raw vs exported event payloads |
| 9.3 | `core_group_get_course_groupings` → `required_capability_exception` ("Manage groups") for a student; empty `groups[]` from the two allowed group functions |
| 10.2, 10.4 | `webservice/pluginfile.php/{contextid}/…` matching the module's `contextid`; full file record with `isexternalfile`, `author`, `license: "allrightsreserved"`; `contentsinfo` |
| 11.1 | `feedbackformat: 4` (Markdown) in real grade feedback; `summaryformat: 1` everywhere else |
| 11.4 | Course-level `filters[]` list mixing core and contributed filters |
| 12.1, 12.3 | `core_user_get_users_by_field` self-record incl. `preferences[]`; the `block_myoverview_hidden_course_<id>` preference matching `hidden: true` in the courses list |
| 12.4 | `core_webservice_get_site_info` full shape, 450 functions, `advancedfeatures[]` |

**Not verified live** (documented from `MOODLE_405_STABLE` source only, because the test account
could not reach an example):

* `@@PLUGINFILE@@` placeholder round-trip (`moodlewssettingraw` 0 vs 1) — no accessible content
  embedded a file in its text.
* Multilang filtered vs unfiltered output — no multilang-tagged strings in reach.
* External-repository aliases (`isexternalfile: true`, `files_reference`).
* `grade_letters` / letter display types — no course in reach used letter grades.
* Scale-based grade items (`gradetype = 2`) — all reachable items were points or manual.
* Availability trees with `showc`/nested restriction sets — only single-condition date restrictions
  were observable, and only via their rendered `availabilityinfo`.
* Group-mode filtering under `SEPARATEGROUPS` — no reachable course used groups.
* `enrol` plugin `custom*` column meanings.
