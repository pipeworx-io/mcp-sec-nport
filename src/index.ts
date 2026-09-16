interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * SEC Form N-PORT — fund and ETF holdings, asked security-first.
 *
 * THE POINT OF HOSTING THIS. "Which ETFs hold the largest positions in NVDA?"
 * returned no_match before this pack, and the router said why in its own words:
 * it would have to check each ETF individually. `edgar_fund_holdings` goes fund
 * -> holdings. Nothing went security -> funds, because SEC publishes N-PORT
 * filing-first and so does every API over it. That is a shape problem, not a
 * rate-limit problem, and holding the flat table is the only fix.
 *
 * WHY THIS IS NOT 13F WARMED OVER. 13F is institutional MANAGERS over $100M,
 * long US equity only. N-PORT is registered FUNDS — mutual funds and ETFs — and
 * carries their bond positions too. "Which funds hold this corporate bond" has
 * no 13F answer at all.
 *
 * SCOPE, stated because a partial load read as a complete one is a wrong
 * answer. The quarterly archive is 441MB across 32 tables; this loads equity,
 * preferred and debt positions (~3.6M of 5.35M rows/quarter). Derivatives,
 * loans, repos and structured products are NOT loaded — a swap notional is not
 * a holding of the underlying, and reporting it as one would be a wrong answer
 * wearing a right one's clothes. Every response says so.
 *
 * TICKER RESOLUTION. N-PORT's holdings table keys on CUSIP, which is
 * proprietary to CUSIP Global Services, so this pack does NOT build or cache a
 * bulk CUSIP<->ticker table. A ticker-shaped input resolves LIVE through
 * OpenFIGI (Bloomberg FIGI, openly licensed) to a canonical company name, which
 * is matched against issuer_name in our own already-ingested rows — preferring
 * the candidate that is not an ETF/option wrapper, because "NVDA" otherwise
 * matches "Direxion Daily NVDA Bull 2X" alongside NVIDIA itself and ranks them
 * together. Same discipline as the 13F pack, deliberately.
 *
 * WHAT THIS CANNOT TELL YOU:
 *  - N-PORT is filed monthly but made PUBLIC quarterly, on a lag. Every
 *    response carries the as-of period and the lag. A holdings answer that
 *    implies real-time is wrong.
 *  - N-PORT has no ETF flag. A fund is a fund here; the series name is the only
 *    hint that one is an ETF, and responses say that rather than pretending to
 *    a classification the filing does not carry.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'SEC Nport');
}


interface Cfg { url: string; key: string }

const HOLDINGS = 'sec_nport_holdings';
const FUNDS = 'sec_nport_funds';
// One row per (cusip, issuer_name) — the resolve target, NOT the holdings heap.
// See resolveTicker below and migration 159.
const SECURITIES = 'sec_nport_securities';

async function pg<T>(cfg: Cfg, table: string, query: string): Promise<T> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) throw new Error(`data query ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

function cfgOf(args: Record<string, unknown>): Cfg {
  const url = args._supabaseUrl as string | undefined;
  const key = args._supabaseKey as string | undefined;
  // Never names what sits behind the connection — see the hosting-disclosure gate.
  if (!url || !key) throw new Error('sec-nport was called without its data connection');
  return { url, key };
}

// ── ticker resolution (OpenFIGI, live — no bulk CUSIP<->ticker table) ──

const OPENFIGI_BASE = 'https://api.openfigi.com/v3';
const OPENFIGI_UA = 'pipeworx-mcp-secnport/1.0 (+https://pipeworx.io)';

const isCusip = (s: string) => /^[A-Za-z0-9]{9}$/.test(s) && /\d/.test(s);
const isTickerShape = (s: string) => /^[A-Za-z]{1,6}(\.[A-Za-z]{1,2})?$/.test(s);

/**
 * Wrapper products whose issuer_name mentions the underlying ticker but which
 * are NOT the underlying. Excluded when deciding which CUSIP a ticker means.
 */
const NOISE_RE = /\b(ETF|FUND|TRUST|OPTION|OPTIONS|STRATEGY|LEVERAGED|BULL|BEAR|INVERSE|SWAP|NOTES?|WARRANTS?|UNITS?|2X|3X)\b/i;
const SUFFIX_RE = /\b(CORPORATION|CORP|INCORPORATED|INC|COMPANY|CO|LTD|LIMITED|PLC|GROUP|HOLDINGS?|CLASS\s+[A-Z])\b\.?/g;

function canonicalToken(name: string): string {
  const cleaned = name.toUpperCase().replace(SUFFIX_RE, '').replace(/[.,]/g, '').trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens[0] === 'THE') tokens.shift();
  return tokens[0] ?? name;
}

async function openfigiMapTicker(ticker: string): Promise<{ figi: string; ticker: string; name: string } | null> {
  try {
    const res = await pwFetch(`${OPENFIGI_BASE}/mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': OPENFIGI_UA },
      body: JSON.stringify([{ idType: 'TICKER', idValue: ticker.toUpperCase(), exchCode: 'US' }]),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ data?: Array<{ figi: string; ticker: string; name: string; securityType?: string }> }>;
    const hits = body?.[0]?.data ?? [];
    const hit = hits.find((d) => (d.securityType ?? '').toLowerCase().includes('common stock')) ?? hits[0];
    return hit ? { figi: hit.figi, ticker: hit.ticker, name: hit.name } : null;
  } catch {
    return null;
  }
}

interface HoldingRow {
  holding_id?: number;
  accession_number: string;
  issuer_name: string | null;
  issuer_lei: string | null;
  cusip: string | null;
  balance: number | null;
  value_usd: number | null;
  pct_of_net: number | null;
  asset_cat: string | null;
  quarter: string | null;
}

interface FundRow {
  accession_number: string;
  series_name: string | null;
  registrant_name: string | null;
  cik: string | null;
  net_assets: number | null;
  report_period: string | null;
  quarter: string | null;
}

interface Resolved { cusip: string; issuer_name: string; figi: string; ticker: string }
interface SecurityRow { cusip: string | null; issuer_name: string | null; max_value_usd: number | null }

/**
 * THIS READS sec_nport_securities, NOT sec_nport_holdings (fleet #1255).
 *
 * The same query against the holdings heap cost 867 ms of Bitmap Heap Scan on
 * 2026-09-05 (871 ms total) for the rows one trigram token matches at 3.6M
 * holdings — and it grows with every quarter loaded, because holdings do.
 * sec_nport_securities holds one row per (cusip, issuer_name), does not grow
 * when quarters are added, and stays cached. sec-13f made exactly this change
 * one order of magnitude later in its life and went 8,510 ms -> 2.1 ms.
 *
 * Ranking is unchanged, which is the whole point: max_value_usd per security
 * orders candidates exactly as ORDER BY value_usd DESC over individual holding
 * rows did, because the top individual row belongs to the security with the
 * highest max. Still returns null rather than throwing, so callers fall back to
 * the issuer_name search on any failure.
 */
async function resolveTicker(cfg: Cfg, raw: string): Promise<Resolved | null> {
  const fig = await openfigiMapTicker(raw);
  if (!fig) return null;
  const token = canonicalToken(fig.name);
  if (!token || token.length < 2) return null;
  const rows = await pg<SecurityRow[]>(
    cfg, SECURITIES,
    `select=cusip,issuer_name,max_value_usd&issuer_name=ilike.*${encodeURIComponent(token)}*&order=max_value_usd.desc&limit=50`,
  ).catch(() => [] as SecurityRow[]);
  const best = rows.find((r) => r.cusip && !NOISE_RE.test(r.issuer_name ?? '')) ?? rows.find((r) => r.cusip);
  if (!best?.cusip) return null;
  return { cusip: best.cusip, issuer_name: best.issuer_name ?? fig.name, figi: fig.figi, ticker: fig.ticker || raw.toUpperCase() };
}

const SCOPE =
  'N-PORT is filed monthly but released publicly on a quarterly lag, so this is a snapshot of the as-of period, never a position today. Equity, preferred and debt positions are loaded; derivatives, loans, repos and structured products are not, so a fund that holds exposure through a swap will not appear here.';

const ETF_NOTE =
  'N-PORT carries no ETF flag — these are registered funds, which include both ETFs and mutual funds. The series name is the only hint, so an ETF-only answer cannot be given honestly from this filing.';

const ASSET_CATS: Record<string, string> = { EC: 'equity-common', EP: 'equity-preferred', DBT: 'debt' };

/**
 * 28 funds file a literal "N/A" as their series name, and one of them is the
 * SPDR S&P 500 ETF Trust — the largest ETF there is. Returning "N/A" as the
 * fund name would drop SPY out of every holders list in all but name. The
 * registrant is the fund's real identity in those filings.
 */
const fundName = (f?: FundRow): string => {
  const s = (f?.series_name ?? '').trim();
  if (s && s.toUpperCase() !== 'N/A') return s;
  const r = (f?.registrant_name ?? '').trim();
  return r || '(unnamed series)';
};

async function fundsFor(cfg: Cfg, accessions: string[]): Promise<Map<string, FundRow>> {
  if (!accessions.length) return new Map();
  const list = accessions.map((a) => `"${a}"`).join(',');
  const rows = await pg<FundRow[]>(
    cfg, FUNDS,
    `select=accession_number,series_name,registrant_name,cik,net_assets,report_period,quarter&accession_number=in.(${encodeURIComponent(list)})&limit=1000`,
  );
  return new Map(rows.map((r) => [r.accession_number, r]));
}

async function fundOwners(args: Record<string, unknown>) {
  const cfg = cfgOf(args);
  const raw = String(args.security ?? '').trim();
  if (!raw) throw new Error('user_error: `security` is required — a ticker, a company name, or a CUSIP.');
  const limit = Math.min(200, Math.max(1, (args.limit as number) ?? 25));
  const quarter = args.quarter ? String(args.quarter).trim() : null;

  let cusip: string | null = null;
  let resolved: Resolved | null = null;
  let matchedOn = 'issuer_name';

  if (isCusip(raw)) { cusip = raw.toUpperCase(); matchedOn = 'cusip'; }
  else if (isTickerShape(raw)) {
    resolved = await resolveTicker(cfg, raw);
    if (resolved) { cusip = resolved.cusip; matchedOn = 'ticker_via_openfigi'; }
  }

  const filter = quarter ? `&quarter=eq.${encodeURIComponent(quarter)}` : '';
  const q = cusip
    ? `select=accession_number,issuer_name,cusip,balance,value_usd,pct_of_net,asset_cat,quarter&cusip=eq.${encodeURIComponent(cusip)}${filter}&order=value_usd.desc&limit=${limit}`
    : `select=accession_number,issuer_name,cusip,balance,value_usd,pct_of_net,asset_cat,quarter&issuer_name=ilike.*${encodeURIComponent(raw)}*${filter}&order=value_usd.desc&limit=${limit}`;

  const rows = await pg<HoldingRow[]>(cfg, HOLDINGS, q);

  if (!rows.length) {
    return {
      found: false,
      security: raw,
      matched_on: matchedOn,
      resolved_via: resolved ? { cusip: resolved.cusip, ticker: resolved.ticker, figi: resolved.figi } : null,
      reason: isTickerShape(raw) && !resolved ? 'ticker_not_resolved' : 'no_fund_positions',
      hint: isTickerShape(raw) && !resolved
        ? `Could not resolve "${raw}" to a security through OpenFIGI. Try the company name ("NVIDIA") or a CUSIP.`
        : `No registered fund reported a position in "${raw}" in the loaded period. ${SCOPE}`,
      scope: SCOPE,
      source: 'SEC Form N-PORT',
    };
  }

  const funds = await fundsFor(cfg, [...new Set(rows.map((r) => r.accession_number))]);
  const asOf = [...new Set(rows.map((r) => funds.get(r.accession_number)?.report_period).filter(Boolean))].sort().at(-1) ?? null;

  return {
    found: true,
    security: raw,
    matched_on: matchedOn,
    resolved_via: resolved ? { cusip: resolved.cusip, ticker: resolved.ticker, figi: resolved.figi, issuer_name: resolved.issuer_name } : null,
    as_of_period: asOf,
    release: rows[0].quarter,
    funds_returned: rows.length,
    holders: rows.map((r) => {
      const f = funds.get(r.accession_number);
      return {
        fund: fundName(f),
        registrant: f?.registrant_name ?? null,
        cik: f?.cik ?? null,
        issuer_as_reported: r.issuer_name,
        cusip: r.cusip,
        value_usd: r.value_usd,
        shares_or_principal: r.balance,
        pct_of_fund_net_assets: r.pct_of_net,
        asset_category: r.asset_cat ? (ASSET_CATS[r.asset_cat] ?? r.asset_cat) : null,
        as_of: f?.report_period ?? null,
      };
    }),
    etf_note: ETF_NOTE,
    scope: SCOPE,
    source: 'SEC Form N-PORT structured data',
  };
}

async function fundPortfolio(args: Record<string, unknown>) {
  const cfg = cfgOf(args);
  const name = String(args.fund ?? '').trim();
  if (!name) throw new Error('user_error: `fund` is required — a fund or ETF series name.');
  const limit = Math.min(500, Math.max(1, (args.limit as number) ?? 50));
  const quarter = args.quarter ? String(args.quarter).trim() : null;
  const filter = quarter ? `&quarter=eq.${encodeURIComponent(quarter)}` : '';

  const matches = await pg<FundRow[]>(
    cfg, FUNDS,
    `select=accession_number,series_name,registrant_name,cik,net_assets,report_period,quarter&series_name=ilike.*${encodeURIComponent(name)}*${filter}&order=net_assets.desc&limit=5`,
  );

  if (!matches.length) {
    return {
      found: false,
      fund: name,
      reason: 'no_such_fund',
      hint: `No N-PORT filer matched "${name}" in the loaded period. Only registered funds file N-PORT — a hedge fund or a separate account never appears. Names are as filed ("Vanguard Total Stock Market Index Fund").`,
      scope: SCOPE,
      source: 'SEC Form N-PORT',
    };
  }

  const fund = matches[0];
  const rows = await pg<HoldingRow[]>(
    cfg, HOLDINGS,
    `select=issuer_name,cusip,balance,value_usd,pct_of_net,asset_cat&accession_number=eq.${encodeURIComponent(fund.accession_number)}&order=value_usd.desc&limit=${limit}`,
  );

  return {
    found: true,
    fund: fundName(fund),
    registrant: fund.registrant_name,
    cik: fund.cik,
    net_assets: fund.net_assets,
    as_of_period: fund.report_period,
    release: fund.quarter,
    other_matches: matches.slice(1).map((m) => fundName(m)),
    positions_returned: rows.length,
    holdings: rows.map((r) => ({
      issuer: r.issuer_name,
      cusip: r.cusip,
      value_usd: r.value_usd,
      shares_or_principal: r.balance,
      pct_of_net_assets: r.pct_of_net,
      asset_category: r.asset_cat ? (ASSET_CATS[r.asset_cat] ?? r.asset_cat) : null,
    })),
    reading_note:
      'Ranked by reported value. pct_of_net_assets is the fund\'s own figure. Because derivatives are not loaded, these percentages will not sum to 100 for a fund that uses them.',
    scope: SCOPE,
    source: 'SEC Form N-PORT structured data',
  };
}

/**
 * Row counts come from PostgREST's `count=exact` content-range header, NEVER
 * from the length of a selected page. A `limit=20000` select is silently capped
 * at 1,000 rows, so counting what came back reported 1,000 funds for a release
 * holding 14,416 — a wrong number wearing a right one's clothes, in the one
 * tool whose whole job is to say how much data there is.
 *
 * A failed count returns null rather than 0, because "the count query broke"
 * and "there is nothing here" must not look the same.
 */
async function countRows(cfg: Cfg, table: string, filter: string): Promise<number | null> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${filter}select=accession_number&limit=1`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' },
  });
  if (!res.ok) return null;
  const total = res.headers.get('content-range')?.split('/')[1];
  return total === undefined || total === '*' ? null : Number(total);
}

async function coverage(args: Record<string, unknown>) {
  const cfg = cfgOf(args);
  const newest = await pg<FundRow[]>(cfg, FUNDS, 'select=report_period&order=report_period.desc&limit=1');
  const releaseRows = await pg<Array<{ quarter: string | null }>>(
    cfg, FUNDS, 'select=quarter&order=quarter.desc&limit=1000',
  );
  const releases = [...new Set(releaseRows.map((r) => r.quarter).filter((q): q is string => !!q))].sort().reverse();

  const per = await Promise.all(
    releases.map(async (q) => ({
      release: q,
      funds: await countRows(cfg, FUNDS, `quarter=eq.${encodeURIComponent(q)}&`),
      holdings: await countRows(cfg, HOLDINGS, `quarter=eq.${encodeURIComponent(q)}&`),
    })),
  );
  const incomplete = per.some((r) => r.funds === null || r.holdings === null);

  return {
    source: 'SEC Form N-PORT structured data',
    releases_loaded: releases,
    releases: per,
    total_funds: per.reduce((s, r) => s + (r.funds ?? 0), 0),
    total_holdings: per.reduce((s, r) => s + (r.holdings ?? 0), 0),
    counts_incomplete: incomplete,
    ...(incomplete
      ? { counts_incomplete_note: 'One or more counts above failed and are reported as null, not 0 — the totals undercount by whatever those releases hold. This is a query failure, not evidence of missing data.' }
      : {}),
    newest_report_period: newest[0]?.report_period ?? null,
    can_diff_releases: releases.length >= 2,
    cadence:
      'Funds file N-PORT monthly; SEC releases the data publicly once a quarter, roughly 60 days after the quarter ends. The as-of period on every answer is the filing date, not today.',
    scope: SCOPE,
    etf_note: ETF_NOTE,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'nport_fund_owners',
    description:
      'Which mutual funds and ETFs hold a given stock or bond, ranked by position size, from SEC Form N-PORT portfolio filings — the reverse of a fund fact sheet, which makes you name the fund first. Give a ticker ("NVDA"), a company name ("NVIDIA"), or a CUSIP. Returns each fund, its sponsor, the position value, share or principal count, and what percent of that fund\'s net assets it is. Answers "which ETFs hold the largest positions in NVDA", "what funds own this corporate bond", "who are the biggest fund holders of this stock".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        security: { type: 'string', description: 'Ticker, company name, or CUSIP. A ticker resolves through OpenFIGI to the underlying company.' },
        quarter: { type: 'string', description: 'Release to search, e.g. "2026q2". Omit to search everything loaded.' },
        limit: { type: 'number', description: 'How many holders to return, 1-200 (default 25).' },
      },
      required: ['security'],
    },
  },
  {
    name: 'nport_fund_portfolio',
    description:
      'The portfolio a mutual fund or ETF reported to the SEC on Form N-PORT: its largest positions with issuer, value, share or principal count, and percent of net assets. Give the fund or ETF series name ("Vanguard Total Stock Market Index Fund", "SPDR S&P 500 ETF"). Answers "what does this ETF hold", "what are this fund\'s biggest positions", "how much of this fund is in one stock".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fund: { type: 'string', description: 'Fund or ETF series name, or a fragment of it.' },
        quarter: { type: 'string', description: 'Release to read, e.g. "2026q2". Omit for everything loaded.' },
        limit: { type: 'number', description: 'How many positions to return, 1-500 (default 50).' },
      },
      required: ['fund'],
    },
  },
  {
    name: 'nport_holdings_coverage',
    description:
      'Which SEC Form N-PORT releases are loaded, how many funds each carries, the newest reporting period, and what the data does and does not cover. Use this to check how current fund holdings answers are before quoting them.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'nport_fund_owners': return fundOwners(args);
    case 'nport_fund_portfolio': return fundPortfolio(args);
    case 'nport_holdings_coverage': return coverage(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
