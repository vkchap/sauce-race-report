/*
 * Race Report - the window.
 *
 * WHAT THIS FILE DOES: wires the recorder, the store, the report and the fact pack to the page,
 * and holds every line in the mod that touches Sauce. Everything else is pure logic so it can be
 * tested without Zwift.
 *
 * Things in here that look fussy and are not:
 *
 *  - Both subscriptions pass {persistent: true}. Without it Sauce suspends them when the window
 *    is hidden or minimised and DROPS the events rather than queueing them
 *    (src/main.mjs:211-230, :285-288), and a subscription created while the window is already
 *    hidden never delivers anything at all (src/main.mjs:302). That would lose the race.
 *
 *  - Nothing in here ever navigates. No location.href, no reload, no link that leaves the page.
 *    "did-navigate" tears down every subscription a window holds, persistent included
 *    (src/main.mjs:213, :231-247).
 *
 *  - No window.confirm and no window.alert. A mod page is a sandboxed Electron renderer and
 *    neither is something Sauce itself ever uses, so both deletes ask in the page instead.
 *
 *  - Logging happens on transitions only. A window that logs in a tight loop is destroyed by
 *    Sauce with a "Terminated misbehaving window" dialog (src/windows.mjs:335-357).
 *
 *  - Recordings and the crash snapshot are kept in IndexedDB, not localStorage, and nothing this
 *    file writes goes under a key starting with "/", the settings included. Every localStorage
 *    write reaches every other Sauce window as a 'storage' event, Sauce's windows parse the whole
 *    value of any key starting with "/" (pages/src/common.mjs:66-84), and the Watching window
 *    reloads itself for it (pages/src/watching.mjs:1473-1486). See src/store.mjs for why, and for
 *    the fallback when IndexedDB is not there.
 *
 *  - The self subscription asks for `resources: ['state']` and nothing else. Sauce merges every
 *    listener on one event into a single query and masks the extra resources back out per
 *    listener (src/stats.mjs:751-838). ['state'] is exactly what Sauce's own Elevation window
 *    asks for (pages/src/geo.mjs:436-439), so with this mod running both windows stay on one
 *    unmasked query. Everything the recorder needs for the start, the finish, race position and
 *    W'bal is in the base payload anyway.
 *
 *  - If some other window or mod does widen that query, the masking filter walks the payload as
 *    an array, and an athlete payload is an object, so the masked listener receives nonsense
 *    (src/stats.mjs:806-823). The recorder reports those as bad payloads and this file switches
 *    to polling getAthleteData, which does not go through that emitter at all.
 *
 *  - The groups subscription asks for ['state'] and nothing else, exactly what Sauce's own Groups
 *    window asks for (pages/src/groups.mjs:824-830), for each rider's power and draft in the
 *    rider's group (WHO DID WHAT IN YOUR GROUP, recorder.mjs; Van, 22 Sep 2026). It asked for none
 *    before then. `athlete` is the most expensive resource in Sauce's own
 *    cost table (src/stats.mjs:783). Asking for `athlete` would make Sauce build and serialise
 *    every nearby rider's whole profile once a second so that this mod could keep one field of
 *    it. Instead the names are looked up slowly, locally, from the profiles Sauce already has on
 *    disk: getAthletes is a pure map read with no network (src/stats.mjs:2414-2416).
 *
 *  - The live snapshot is written from inside the data callback as well as on a timer, because
 *    Chromium throttles timers in a hidden window and a mod cannot ask for that to be turned
 *    off: webPreferences is not in the manifest schema (src/mods-core.mjs:33-81).
 */

import * as Common from '/pages/src/common.mjs';
import {Recorder, isRaceLike, isSelfPayload, eventBlocksRecording, withAfterLine,
        MOD_VERSION, MIN_SAUCE_VERSION} from './recorder.mjs';
import {openStore, LegacyStorage, LocalSettings, MemoryAdapter} from './store.mjs';
import {buildReport, renderReportHTML, fmtDuration, esc, resultsErrorText} from './report.mjs';
import {buildFactPack, MAX_EARLIER_RACES, isEarlierRace, raceOverviewLines} from './factpack.mjs';
import {ZEN_DB, segmentPointsFrom, segmentPointsFromZwift} from './zenmaster.mjs';

const AUTOSAVE_SECONDS = 20;
// With the localStorage fallback every write still reaches every other window as a 'storage'
// event, so the snapshot is written less often there. See src/store.mjs.
const LOCAL_AUTOSAVE_SECONDS = 60;
const NAME_LOOKUP_SECONDS = 20;
const SILENCE_BEFORE_EXPLAINING = 60;
const SELF_RESOURCES = ['state'];
const GROUPS_RESOURCES = ['state'];
const BAD_PAYLOADS_BEFORE_FALLBACK = 5;

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

let store;
let recorder;
let imperial = false;
let currentRecId = null;
let currentModel = null;
let currentRec = null;
let lastLiveSaveAt = 0;
let lastNameLookupAt = 0;
let pollingSelf = false;
let startedAt = Date.now();
let explainedSilence = false;
let reportedWriteErrors = 0;
let droppedMovedCopies = false;
let lastSelfInEvent = false;


/*
 * The settings, in localStorage under a key with no leading "/" (LocalSettings in store.mjs), not
 * in Common.storage under "/sauce-race-report/settings" as before: every change there reloaded
 * every Watching overlay.
 */
function settingsAdapter(ls) {
    if (ls) {
        return new LocalSettings(ls, {onWrite: scheduleFlush});
    }
    // Should not happen inside Sauce, but never lose the window over it.
    return new MemoryAdapter();
}


/* window.indexedDB, feature detected: where storage is blocked even reading it can throw. */
function indexedDBFactory() {
    try {
        return typeof indexedDB !== 'undefined' && indexedDB ? indexedDB : null;
    } catch(e) {
        return null;
    }
}


function localStorageOrNull() {
    try {
        return typeof localStorage !== 'undefined' && localStorage ? localStorage : null;
    } catch(e) {
        return null;
    }
}


/*
 * Asks Chromium to keep this origin's storage when the disk runs low. Without it IndexedDB is
 * "best effort" storage, which Chromium may clear under disk pressure (a headless Chromium probe on
 * a file:// page, 16 Sep 2026, reported persisted() false and persist() false). Electron grants
 * permission requests by default and Sauce sets no permission handler, so it may be granted in
 * Sauce; the console says which, once.
 */
async function requestPersistence() {
    try {
        return navigator.storage && navigator.storage.persist ?
            await navigator.storage.persist() :
            null;
    } catch(e) {
        return null;
    }
}


/* How much Chromium lets this origin keep, for the IndexedDB budgets (indexedDBBudgets). */
async function storageEstimate() {
    try {
        return navigator.storage && navigator.storage.estimate ?
            await navigator.storage.estimate() :
            null;
    } catch(e) {
        return null;
    }
}


/*
 * The flush Common.storage schedules 500 ms after each of its own writes
 * (pages/src/common.mjs:224-228), for the writes this mod makes to localStorage directly: the
 * settings, the fallback store, and removing the old "/" keys once they have moved.
 */
let flushTimer = null;

function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushNow, 500);
}


function flushNow() {
    try {
        const p = Common.rpc.flushSessionStorage();
        if (p && p.catch) {
            p.catch(() => undefined);
        }
    } catch(e) {
        // nothing to do
    }
}


function autosaveSeconds() {
    return store.kind === 'indexeddb' ? AUTOSAVE_SECONDS : LOCAL_AUTOSAVE_SECONDS;
}


function setStatus(text, cls) {
    const el = $('#status');
    el.textContent = text;
    el.className = `status ${cls || ''}`;
}


function showBanner(id, text) {
    const el = $(id);
    if (!el) {
        return;
    }
    if (text != null) {
        const t = el.querySelector('.banner-text');
        if (t) {
            t.textContent = text;
        }
    }
    el.hidden = false;
}


function refreshLive() {
    const rec = recorder.rec;
    const recording = recorder.state === 'recording';
    $('#btn-start').disabled = recording;
    $('#btn-stop').disabled = !recording;
    if (recording && rec && recorder.isAfterLine()) {
        setStatus(`You have finished. Watching the riders behind you come in for another ` +
            `${fmtDuration(recorder.afterLineSecondsLeft())}. Press Stop to end it now; your race ` +
            `is already recorded up to the line.`, 'recording');
    } else if (recording && rec) {
        const secs = Math.round((Date.now() - rec.startedAt) / 1000);
        setStatus(`Recording, ${fmtDuration(secs)}. ` +
            `${rec.counts.selfRows} seconds of your ride, ${rec.counts.packRows} seconds of pack, ` +
            `${rec.counts.riders} riders seen.`, 'recording');
    } else if (recorder.lastSelfAt) {
        setStatus('Waiting for an event to start. Leave this window open.', 'waiting');
    } else if (recorder.badSelfPayloads > 0 && recorder.goodSelfPayloads === 0) {
        setStatus('Another Sauce window is filtering this mod\'s data feed. Reading your data ' +
                  'directly instead.', 'warn');
    } else {
        setStatus('Waiting for Zwift. Leave this window open.', 'idle');
    }
}


/* ------------------------------------------------------------------ Sauce reads */

async function findEventInfo(subgroupId) {
    /*
     * Cached first. getCachedEvents is a pure memory read (src/stats.mjs:1328-1330). Only if the
     * event is not already cached do we call getEventSubgroup, which can ask Zwift
     * (src/stats.mjs:1386-1410). Sauce polls the event feed by itself from an hour back to four
     * hours ahead (src/stats.mjs:3837), so in practice the event is already there.
     */
    let sg = null;
    let event = null;
    try {
        const cached = await Common.rpc.getCachedEvents();
        for (const ev of (cached || [])) {
            const found = (ev.eventSubgroups || []).find(x => x.id === subgroupId);
            if (found) {
                sg = found;
                event = ev;
                break;
            }
        }
    } catch(e) {
        console.warn('Race Report: could not read the cached event list', e);
    }
    if (!sg) {
        try {
            sg = await Common.rpc.getEventSubgroup(subgroupId);
            if (sg && sg.eventId) {
                event = await Common.rpc.getCachedEvent(sg.eventId);
            }
        } catch(e) {
            console.warn('Race Report: could not read the event', e);
        }
    }
    if (!sg) {
        return null;
    }
    let routeName = null;
    try {
        const route = sg.routeId != null ? await Common.rpc.getRoute(sg.routeId) : null;
        routeName = route && (route.name || route.routeName) || null;
    } catch(e) {
        // Route lookup is local (src/env.mjs) but not worth failing a report over.
    }
    return {
        id: sg.id,
        eventId: sg.eventId ?? null,
        name: (event && event.name) || sg.name || null,
        subgroupLabel: sg.subgroupLabel ?? null,
        eventType: (event && event.eventType) || sg.eventType || null,
        prettyType: (event && event.prettyType) || null,
        routeId: sg.routeId ?? null,
        routeName,
        routeDistance: sg.routeDistance ?? null,
        routeClimbing: sg.routeClimbing ?? null,
        distanceInMeters: sg.distanceInMeters ?? null,
        durationInSeconds: sg.durationInSeconds ?? null,
        endDistance: sg.endDistance ?? null,
        laps: sg.laps ?? null,
        powerUps: sg.powerUps || null,
        tags: sg.allTags || null,
        rulesSet: sg.rulesSet || null,
    };
}


/*
 * THE GUN in recorder.mjs. The scheduled start of the rider's category, read from the events Sauce
 * already holds in memory: getCachedEvents is a pure memory read (src/stats.mjs:1328-1330), and
 * Sauce sets `sg.ts = +new Date(sg.eventSubgroupStart)` on every subgroup it loads
 * (src/stats.mjs:3724-3728, and for a meetup eventSubgroupStart is meetup.eventStart, :3796).
 *
 * Deliberately NOT getEventSubgroup: when Sauce's own lookup has failed that call can ask Zwift
 * again (src/stats.mjs:1386-1410), and this mod makes no network requests. Sauce queues that
 * lookup itself as soon as the rider's state carries a subgroup (src/stats.mjs:3029-3033), so
 * asking the cache every few seconds finds it as soon as Sauce has it. The raw
 * state.eventSubgroupId is used to ask, because Sauce's own eventSubgroupId on the payload only
 * appears once that lookup is done (src/stats.mjs:4343), and it comes first because Sauce's can
 * still be the previous event's (src/stats.mjs:3030-3036).
 *
 * A new subgroup is asked about at once. The answer still arrives after the payload that
 * prompted it, which is why the recorder moves a recording that already started on Zwift's clock
 * onto the gun when it lands (setScheduledStart). Once found, it is read again every minute until
 * a recording counts from it, because Sauce re-adds events on every feed sync with the current
 * start (src/stats.mjs:3843-3847, :3728) and Zwift can move one.
 *
 * What it costs Sauce. getCachedEvents sorts every event Sauce has cached and its main process
 * JSON.stringifies the whole answer (src/stats.mjs:1328-1330, src/main.mjs:339-340), a few MB with
 * a full event feed, on the same thread that serves every overlay. So the whole list is read only
 * until the subgroup is found, backing off from every 5 seconds to every minute while it is not;
 * after that only its event is read, with getCachedEvent, a single map read
 * (src/stats.mjs:1324-1326).
 * And nothing is asked while no recording could use the answer (wantsScheduledStart in
 * recorder.mjs), which covers the whole of a hand-started recording.
 */
const SCHEDULE_LOOKUP_SECONDS = [5, 15, 30, 60];
const SCHEDULE_REFRESH_SECONDS = 60;
let scheduleLookupAt = 0;
let scheduleLookupId = null;
let scheduleLookupMisses = 0;
let scheduleLookupBusy = false;
const scheduleEventIds = new Map();

async function maybeLookUpScheduledStart(data) {
    const st = data && data.state;
    const id = (st && st.eventSubgroupId) || data.eventSubgroupId || null;
    if (id == null || recorder.usesScheduledStart(id) || !recorder.wantsScheduledStart(id) ||
        scheduleLookupBusy) {
        return;
    }
    if (id !== scheduleLookupId) {
        scheduleLookupId = id;
        scheduleLookupAt = 0;
        scheduleLookupMisses = 0;
    }
    const now = Date.now();
    const every = recorder.hasScheduledStart(id) ? SCHEDULE_REFRESH_SECONDS :
        SCHEDULE_LOOKUP_SECONDS[Math.min(scheduleLookupMisses, SCHEDULE_LOOKUP_SECONDS.length - 1)];
    if (now - scheduleLookupAt < every * 1000) {
        return;
    }
    scheduleLookupAt = now;
    scheduleLookupBusy = true;
    try {
        const sg = await cachedSubgroup(id);
        const ms = sg ? (Number.isFinite(sg.ts) ? sg.ts : Date.parse(sg.eventSubgroupStart)) : NaN;
        if (Number.isFinite(ms)) {
            scheduleLookupMisses = 0;
            recorder.setScheduledStart(id, ms);
        } else {
            scheduleLookupMisses++;
        }
    } catch(e) {
        // Asked again later. Without it the recorder counts from state.time and says so.
        scheduleLookupMisses++;
    } finally {
        scheduleLookupBusy = false;
    }
}


/* A subgroup from Sauce's event cache: through its event once that is known, else the whole list. */
async function cachedSubgroup(id) {
    const eventId = scheduleEventIds.get(id);
    if (eventId != null) {
        const ev = await Common.rpc.getCachedEvent(eventId);
        const sg = ev && (ev.eventSubgroups || []).find(x => x.id === id);
        if (sg) {
            return sg;
        }
    }
    const cached = await Common.rpc.getCachedEvents();
    for (const ev of (cached || [])) {
        const sg = (ev.eventSubgroups || []).find(x => x.id === id);
        if (sg) {
            scheduleEventIds.set(id, sg.eventId ?? ev.id);
            return sg;
        }
    }
    return null;
}


async function resolveRiderNames() {
    /*
     * Ask Sauce for the names of the riders seen so far, for the ones it has not named yet.
     * getAthletes is a pure local read of profiles Sauce already stored (src/stats.mjs:2414-2416
     * -> _getAthlete -> _loadAthlete). It makes no network call and it returns nothing for a
     * rider on Sauce's opt-out list, which is exactly the behaviour this mod wants.
     */
    const ids = recorder.unnamedRiderIds();
    if (!ids.length) {
        return;
    }
    let athletes;
    try {
        athletes = await Common.rpc.getAthletes(ids.slice(0, 200));
    } catch(e) {
        return;
    }
    if (!Array.isArray(athletes)) {
        return;
    }
    for (let i = 0; i < athletes.length; i++) {
        const a = athletes[i];
        const name = a && a.sanitizedFullname;
        if (name) {
            // The team tag Sauce itself reads out of the Zwift name (src/stats.mjs:2275-2282) and
            // shows as a badge in its Groups window (pages/src/groups.mjs:437-479). Nothing else
            // from the profile is kept.
            recorder.setRiderName(ids[i], name, typeof a.team === 'string' && a.team ? a.team : null);
        }
    }
}


/*
 * The route segments Sauce knows for every road the rider rode in the race, so the copied texts
 * can name a climb where Sauce has a segment for it (ROAD POSITION in recorder.mjs).
 * getSegmentsForRoad is a filter over the segment files Sauce ships (src/app.mjs:320-327 over
 * Env.getCourseSegments, src/env.mjs:115-117), with no network. Only what the report needs is kept.
 */
const MAX_SEGMENT_ROADS = 60;

async function attachSegments(rec) {
    const roads = new Map();
    for (const [, courseId, roadId, reverse] of (rec.timeline && rec.timeline.roadEvents) || []) {
        if (courseId != null && roadId != null) {
            roads.set(`${courseId}/${roadId}/${reverse ? 1 : 0}`, [courseId, roadId, !!reverse]);
        }
    }
    const out = new Map();
    for (const [courseId, roadId, reverse] of [...roads.values()].slice(0, MAX_SEGMENT_ROADS)) {
        try {
            for (const x of (await Common.rpc.getSegmentsForRoad(courseId, roadId, reverse)) || []) {
                if (x && x.id != null && x.name) {
                    out.set(x.id, {id: x.id, name: x.name, courseId, roadId: x.roadId, reverse: !!x.reverse,
                                   roadStart: x.roadStart, roadFinish: x.roadFinish,
                                   distance: x.distance ?? null, loop: !!x.loop});
                }
            }
        } catch(e) {
            // An older Sauce without the call: the climbs stay unnamed.
            break;
        }
    }
    rec.segments = [...out.values()];
}


async function attachSauceExtras(rec) {
    /* Pull the closed event slice and Sauce's own per-second arrays for the race. */
    try {
        const slices = await Common.rpc.getAthleteEvents('self', {active: true});
        if (Array.isArray(slices) && slices.length) {
            let slice = null;
            if (rec.eventSliceId != null) {
                slice = slices.find(x => x.id === rec.eventSliceId) || null;
            }
            if (!slice && rec.eventSubgroupId != null) {
                const matches = slices.filter(x => x.eventSubgroupId === rec.eventSubgroupId);
                slice = matches[matches.length - 1] || null;
            }
            if (!slice) {
                slice = slices[slices.length - 1];
            }
            if (slice) {
                rec.stats = slice.stats || null;
                rec.sliceWindow = {startIndex: slice.startIndex, endIndex: slice.endIndex};
                try {
                    const s = await Common.rpc.getAthleteStreams('self');
                    if (s && Array.isArray(s.time)) {
                        const a = Math.max(0, slice.startIndex | 0);
                        const b = Math.min(s.time.length - 1, slice.endIndex | 0);
                        if (b > a + 5) {
                            rec.streams = {
                                time: s.time.slice(a, b + 1),
                                power: round(s.power, a, b, 0),
                                hr: round(s.hr, a, b, 0),
                                cadence: round(s.cadence, a, b, 0),
                                speed: round(s.speed, a, b, 1),
                                draft: round(s.draft, a, b, 0),
                                distance: round(s.distance, a, b, 0),
                                altitude: round(s.altitude, a, b, 1),
                                wbal: round(s.wbal, a, b, 0),
                            };
                        }
                    }
                } catch(e) {
                    console.warn('Race Report: no per-second streams available', e);
                }
            }
        }
    } catch(e) {
        console.warn('Race Report: no event slice available', e);
    }
    try {
        rec.sauce = {version: await Common.rpc.getVersion()};
    } catch(e) {
        rec.sauce = {version: null};
    }
}


function round(arr, a, b, dp) {
    if (!Array.isArray(arr)) {
        return [];
    }
    const f = Math.pow(10, dp);
    return arr.slice(a, b + 1).map(x =>
        (typeof x === 'number' && isFinite(x)) ? Math.round(x * f) / f : null);
}


/* ------------------------------------------------------------------ lifecycle */

/*
 * A race that goes on past the line is saved AT the line, by the same steps a race with no extra
 * time goes through when it finalizes on that packet: the event, the rider's own profile, Sauce's
 * slice stats and streams, then the save. Keyed by recording id, so the save at the end of the
 * extra time can wait for it and add only the afterLine block. A rider who finishes and closes
 * Sauce straight away then loses nothing the race would have had with the setting at 0.
 */
const savedAtLine = new Map();

function onLine(race) {
    console.info('Race Report: reached the line, saving the race and watching on:', race.counts);
    // First, at once and with no await: a snapshot that already holds the whole race.
    saveLiveNow();
    savedAtLine.set(race.id, saveFinishedRace(race, {stillRecording: true}));
}


async function onFinalized(rec) {
    console.info('Race Report: recording finished:', rec.stopReason, rec.counts);
    const atLine = rec.afterLine ? savedAtLine.get(rec.id) : null;
    savedAtLine.delete(rec.id);
    if (!atLine) {
        await saveFinishedRace(rec, {stillRecording: false});
        return;
    }
    const done = await atLine;
    if (!done.kept || store.wasRemoved(rec.id)) {
        // "only keep races" turned the race away at the line, or the rider deleted the race saved
        // there during the extra time, so there is nothing to add to.
        await store.clearLive(rec.id);
        refreshLive();
        return;
    }
    // What is in the store wins over the copy in memory: official results may have been fetched
    // for the race during the extra time.
    const race = withAfterLine(await store.load(rec.id) || done.rec, rec);
    // The snapshot goes in the same write as the race, so only if the race is stored.
    const res = await store.save(race, {dropSnapshot: true});
    if (!res.ok) {
        await store.keepUnsaved(race.id);
        showSaveProblem(res, race);
    }
    renderList();
    if (res.ok && (currentRecId == null || currentRecId === race.id)) {
        showRecording(race.id);
    }
    refreshLive();
}


/*
 * Sprint and KOM results from the Zenmaster mod, when it saved any for this race (zenmaster.mjs).
 * Read only: the database is opened with no version, so nothing is created or upgraded, and not at
 * all unless indexedDB.databases() lists it, so a rider without Zenmaster gets no empty database.
 */
async function readZenmaster(sgId) {
    const idb = indexedDBFactory();
    if (!idb || typeof idb.databases !== 'function' || sgId == null) {
        return null;
    }
    const names = await idb.databases();
    if (!names.some(x => x && x.name === ZEN_DB)) {
        return null;
    }
    const db = await new Promise((resolve, reject) => {
        const req = idb.open(ZEN_DB);
        req.onupgradeneeded = () => req.transaction && req.transaction.abort();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    const get = (store, how) => new Promise(resolve => {
        try {
            if (!db.objectStoreNames.contains(store)) {
                return resolve(null);
            }
            const req = how(db.transaction(store, 'readonly').objectStore(store));
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
        } catch(e) {
            resolve(null);
        }
    });
    try {
        const keys = [sgId, String(sgId)];
        let config = null;
        let results = [];
        for (const k of keys) {
            config = config || await get('segmentConfig', s => s.get(k));
            for (const store of ['segmentResults', 'segmentResultsLive']) {
                if (!results.length) {
                    results = (await get(store, s => s.index('eventSubgroupId').getAll(k))) || [];
                }
            }
        }
        return config && results.length ? {config, results} : null;
    } finally {
        db.close();
    }
}


/* Sauce's names and team tags for these athlete ids, as a Map, from the profiles it already holds. */
async function whoMap(ids) {
    const who = new Map();
    const list = ids.slice(0, 300);
    const athletes = list.length ? await Common.rpc.getAthletes(list) : [];
    list.forEach((id, i) => {
        const a = athletes && athletes[i];
        // Sauce's own name, which it withholds for a rider on its opt-out list.
        who.set(id, a ? {name: a.sanitizedFullname || null, team: a.team || null} : {name: null, team: null});
    });
    return who;
}


/*
 * Sprint and KOM results from Zwift's segment times, with the official results, when Zenmaster saved
 * none (zenmaster.mjs). One getSegmentResults call a segment, over the race's time, which is the
 * call Sauce's own Analysis window makes for an event's segments (pages/src/analysis.mjs:1082).
 */
async function attachZwiftSegmentPoints(rec, participants) {
    if (rec.segmentPoints && rec.segmentPoints.source === 'zenmaster') {
        return;
    }
    try {
        const segs = (rec.segments || []).filter(x => x && x.id != null && x.name && !x.loop).slice(0, 12);
        const gun = Date.parse(rec.scheduledStartISO || '') || rec.startedAt;
        const race = rec.elapsedSeconds || 3600;
        const bySegment = new Map();
        for (const seg of segs) {
            const res = await Common.rpc.getSegmentResults(seg.id, {from: gun - 60_000, to: gun + (race + 300) * 1000});
            bySegment.set(String(seg.id), Array.isArray(res) ? res : []);
        }
        const ids = [...new Set([...bySegment.values()].flat().map(x => x.athleteId).filter(id => participants.has(id)))];
        if (!ids.length) {
            return;
        }
        const who = await whoMap(ids);
        const sp = segmentPointsFromZwift({segments: segs, bySegment, participants, whoOf: id => who.get(id),
                                           selfId: rec.self && rec.self.athleteId});
        if (sp) {
            rec.segmentPoints = sp;
        }
    } catch(e) {
        console.warn('Race Report: could not fetch Zwift\'s segment times', e);
    }
}


async function attachSegmentPoints(rec) {
    try {
        const zen = await readZenmaster(rec.eventSubgroupId);
        if (!zen) {
            return;
        }
        const ids = [...new Set(zen.results.map(x => x.athleteId).filter(x => x != null))];
        const who = await whoMap(ids);
        const sp = segmentPointsFrom({config: zen.config, results: zen.results, whoOf: id => who.get(id),
                                      selfId: rec.self && rec.self.athleteId});
        if (sp) {
            rec.segmentPoints = sp;
        }
    } catch(e) {
        console.warn('Race Report: could not read Zenmaster\'s segment results', e);
    }
}


async function saveFinishedRace(rec, {stillRecording}) {
    if (rec.eventSubgroupId != null) {
        rec.event = await findEventInfo(rec.eventSubgroupId);
    }
    await captureSelfProfile(rec);
    await attachSegments(rec);
    await attachSauceExtras(rec);
    await attachSegmentPoints(rec);
    const settings = store.settings();
    if (rec.trigger === 'auto' && settings.racesOnly && rec.event && !isRaceLike(rec.event)) {
        // Never silently. A community "race" is often listed as a group ride, and a rider who
        // finds nothing in the list has to be told why.
        showBanner('#not-a-race',
            `"${rec.event.name || 'That event'}" is listed by Zwift as ` +
            `${rec.event.prettyType || rec.event.eventType || 'not a race'}, and "only keep races" ` +
            `is on, so it was not saved. Turn that setting off under "How this works" if you want ` +
            `events like it kept.`);
        if (!stillRecording) {
            store.clearLive(rec.id);
        }
        refreshLive();
        renderList();
        return {rec, kept: false};
    }
    // While the extra time runs, the live snapshot is still the thing that protects it. Otherwise
    // it goes in the same write as the race, so only if the race is stored, and a race that could
    // not be stored keeps its snapshot for the next start to offer.
    const res = await store.save(rec, {dropSnapshot: !stillRecording});
    if (!res.ok && !stillRecording) {
        store.keepUnsaved(rec.id);
    }
    if (!res.ok) {
        showSaveProblem(res, rec);
    } else if (res.overBudget || res.nearBudget) {
        showBanner('#budget-warning', null);
    }
    renderList();
    if (res.ok) {
        showRecording(rec.id);
    }
    refreshLive();
    return {rec, kept: true};
}


function showSaveProblem(res, rec) {
    showBanner('#save-problem', res.error);
    $('#save-problem-download').onclick = () => downloadJSON(res.json || JSON.stringify(rec),
        fileNameFor(rec));
}


async function captureSelfProfile(rec) {
    /*
     * The rider's own name, FTP and weight, read at the end from Sauce's local athlete database
     * rather than carried on every packet. getAthlete with no options does not fetch from Zwift
     * (src/stats.mjs:2396-2416); it returns what Sauce already stored. Only the rider's own
     * profile is ever read this way.
     */
    if (rec.self) {
        return;
    }
    try {
        const a = await Common.rpc.getAthlete('self');
        if (a) {
            // cp and wPrime are what Sauce's W'bal model runs on (src/stats.mjs:2864-2868), so the
            // copied texts can say what the W'bal shares are shares of.
            rec.self = {
                athleteId: a.id ?? null,
                name: a.sanitizedFullname || null,
                ftp: typeof a.ftp === 'number' ? a.ftp : null,
                weight: typeof a.weight === 'number' ? a.weight : null,
                cp: typeof a.cp === 'number' ? a.cp : null,
                wPrime: typeof a.wPrime === 'number' ? a.wPrime : null,
                // The tag Sauce reads from the rider's own Zwift name (src/stats.mjs:2275-2282),
                // for the team in the race commentary unless the setting names one.
                team: typeof a.team === 'string' && a.team ? a.team : null,
            };
        }
    } catch(e) {
        console.warn('Race Report: could not read your own profile from Sauce', e);
    }
}


/* ------------------------------------------------------------------ rendering */

function renderList() {
    const list = store.list();
    const el = $('#recordings');
    if (!list.length) {
        el.innerHTML = '<div class="empty">No races recorded yet.</div>';
        $('#total-size').textContent = '';
        return;
    }
    el.innerHTML = list.map(x => `
        <div class="rec-row${x.id === currentRecId ? ' selected' : ''}" data-id="${esc(x.id)}">
            <div class="rec-main">
                <div class="rec-name">${esc(x.eventName || 'Unnamed event')}` +
                    `${x.subgroupLabel ? ` <span class="tag">${esc(x.subgroupLabel)}</span>` : ''}` +
                    `${x.eventType && x.eventType !== 'RACE' ?
                        ` <span class="tag">${esc(String(x.eventType).toLowerCase().replace(/_/g, ' '))}</span>` : ''}` +
                    `${x.incomplete ? ' <span class="tag warn">incomplete</span>' : ''}</div>
                <div class="rec-meta">${esc(new Date(x.startedISO).toLocaleString())} &middot; ` +
                    `${esc(fmtDuration(x.elapsedSeconds))}` +
                    `${x.position != null ? ` &middot; position ${esc(x.position)}` : ''}` +
                    `${x.riders ? ` &middot; ${esc(x.riders)} riders` : ''} &middot; ` +
                    `${Math.round((x.bytes || 0) / 1024)} kB</div>` +
                `${x.incomplete && x.incompleteReasons && x.incompleteReasons.length ?
                    `<div class="rec-why">Incomplete: ${esc(x.incompleteReasons.join('; '))}</div>` : ''}
            </div>
            <div class="rec-actions">
                <button class="open" data-id="${esc(x.id)}">Open</button>
                <button class="download" data-id="${esc(x.id)}">Save file</button>
                <button class="delete" data-id="${esc(x.id)}">Delete</button>
            </div>
        </div>`).join('');
    $('#total-size').textContent = `${Math.round(store.totalBytes() / 1024)} kB stored`;
}


async function showRecording(id) {
    const rec = await store.load(id);
    if (!rec) {
        $('#report').innerHTML = '<p class="empty">That recording could not be read back.</p>';
        return;
    }
    currentRecId = id;
    currentRec = rec;
    currentModel = buildReport(rec, {imperial});
    // The same overview the copied texts open with, as the window's first section.
    try {
        const lines = raceOverviewLines(rec, {imperial, model: currentModel});
        if (lines.length) {
            currentModel.sections.unshift({id: 'overview', title: 'The race in brief', lines});
        }
    } catch(e) {
        console.warn('Race Report: no overview for this race', e);
    }
    $('#report').innerHTML = renderReportHTML(currentModel);
    $('#report-actions').hidden = false;
    $('#btn-results').hidden = !(rec.eventSubgroupId != null);
    $('#btn-results').dataset.id = id;
    $('#results-error').hidden = true;
    $('#results-hint').hidden = !(rec.eventSubgroupId != null && !(rec.results && rec.results.length));
    renderList();
    $('#report').scrollTop = 0;
}


/*
 * The copied text for one of the two styles (see factpack.mjs). The debrief also summarises the
 * rider's earlier races, read from the store only when that button is pressed: the most recent
 * ones that started before this race, up to MAX_EARLIER_RACES, that are earlier races at all
 * (isEarlierRace).
 */
async function currentFactPack(style) {
    if (!currentRec || !currentModel) {
        return '';
    }
    const rec = currentRec;
    const earlier = [];
    if (style === 'debrief') {
        for (const x of store.list()) {
            if (earlier.length >= MAX_EARLIER_RACES) {
                break;
            }
            if (x.id !== rec.id && String(x.startedISO || '') < String(rec.startedISO || '') &&
                isEarlierRace(x, rec)) {
                const prev = await store.load(x.id);
                // An entry listed before the index kept the trigger is checked on the race itself.
                if (prev && isEarlierRace(prev, rec)) {
                    earlier.push(prev);
                }
            }
        }
    }
    if (currentRec !== rec) {
        return '';
    }
    return buildFactPack(rec, {
        style,
        imperial,
        model: currentModel,
        includeNames: !!store.settings().namesInCopy,
        teamTag: String(store.settings().teamTag || '').trim() || (rec.self && rec.self.team) || null,
        earlier,
    });
}


/* ------------------------------------------------------------------ file + clipboard */

/* From a recording, or from its entry in the list, which carries the same name and start. */
function fileNameFor(rec) {
    const name = ((rec.event && rec.event.name) || rec.eventName || 'race')
        .replace(/[^a-z0-9]+/ig, '-').slice(0, 48);
    const d = (rec.startedISO || new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '-');
    return `race-report-${name}-${d}.json`;
}


function downloadJSON(json, filename) {
    /*
     * Same shape Sauce's own FIT export uses (pages/src/analysis.mjs:299-313). The window open
     * handler allows the save-to-disk disposition (src/windows.mjs:1298-1301). Where the file
     * lands is Electron's default, because Sauce registers no will-download handler.
     *
     * `json` is the text as stored, or a list of pieces of it, so a race of several MB, or every
     * race at once, is never parsed and turned back into text first.
     */
    const f = new File(Array.isArray(json) ? json : [json], filename, {type: 'application/json'});
    const l = document.createElement('a');
    l.download = f.name;
    l.style.display = 'none';
    l.href = URL.createObjectURL(f);
    try {
        document.body.appendChild(l);
        l.click();
    } finally {
        setTimeout(() => URL.revokeObjectURL(l.href), 2000);
        l.remove();
    }
}


async function copyText(text) {
    /* Three ways, because a sandboxed mod window is not a normal web page. */
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return 'clipboard';
        }
    } catch(e) {
        // fall through
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
        if (document.execCommand('copy')) {
            return 'execCommand';
        }
    } catch(e) {
        // fall through
    } finally {
        ta.remove();
    }
    const box = $('#copy-fallback');
    box.hidden = false;
    $('#copy-fallback-text').value = text;
    $('#copy-fallback-text').select();
    return 'manual';
}


/* ------------------------------------------------------------------ asking in the page */

let pendingConfirm = null;

function askInPage(question, onYes) {
    /*
     * window.confirm is not something Sauce itself ever uses and a mod page is a sandboxed
     * Electron renderer, so the question is asked in the page where it is certain to work.
     */
    pendingConfirm = onYes;
    $('#confirm-text').textContent = question;
    $('#confirm').hidden = false;
}


/* ------------------------------------------------------------------ results */

async function fetchResults(id) {
    const rec = await store.load(id);
    if (!rec || rec.eventSubgroupId == null) {
        return;
    }
    const btn = $('#btn-results');
    btn.disabled = true;
    btn.textContent = 'Asking Zwift...';
    $('#results-error').hidden = true;
    try {
        const results = await Common.rpc.getEventSubgroupResults(rec.eventSubgroupId);
        rec.results = mapResults(results, rec.self && rec.self.athleteId);
        // Zenmaster may have saved more segment results since the race was saved; without any from
        // it, Zwift's own segment times for the riders in these results.
        await attachSegmentPoints(rec);
        await attachZwiftSegmentPoints(rec, new Set((results || []).filter(x => x && !x.dns && x.profileId != null)
            .map(x => x.profileId)));
        const res = await store.save(rec);
        if (!res.ok) {
            showSaveProblem(res, rec);
        }
        await showRecording(id);
    } catch(e) {
        console.warn('Race Report: results call failed', e);
        let estimatedFinish = null;
        try {
            const sg = await Common.rpc.getEventSubgroup(rec.eventSubgroupId);
            estimatedFinish = sg && sg.estimatedFinish;
        } catch(e2) {
            // Only used to say when to try again.
        }
        $('#results-error').hidden = false;
        $('#results-error').textContent = resultsErrorText(e.message, estimatedFinish);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Get official results';
    }
}


export function mapResults(results, selfId = null) {
    /*
     * Names come from x.athlete.sanitizedFullname, which is Sauce's own exclusion aware,
     * privacy filtered accessor and is exactly what Sauce's own results table renders
     * (pages/templates/events/subgroup.html.tpl:83-88). This deliberately does NOT read
     * x.profileData.firstName, which Zwift returns even for a rider Sauce will not name
     * (src/stats.mjs:1533-1543 fills profileData from the raw Zwift profile).
     *
     * A rider with no name shows as "(no name)", the same blank Sauce's own results table shows.
     * They are NOT given a "Rider A" label here: the story's labels carry no athlete id, so there
     * is no honest way to say that a row in this table is the same rider, and a label that meant
     * two different people in one report would be worse than none.
     *
     * Place is counted the way Sauce counts it (same template, :29-42): riders on virtual power
     * and riders flagged for cheating or sandbagging do not take a number.
     */
    let place = 0;
    const out = [];
    for (const x of (results || [])) {
        const noPower = x.sensorData && x.sensorData.powerType === 'VIRTUAL_POWER';
        const valid = !noPower && !x.flaggedCheating && !x.flaggedSandbagging;
        if (valid && !x.dnf && !x.dns) {
            place++;
        }
        const name = x.athlete && x.athlete.sanitizedFullname || null;
        const flags = [
            x.dns ? 'DNS' : null,
            x.dnf && !x.dns ? 'DNF' : null,
            x.flaggedCheating ? 'flagged' : null,
            x.flaggedSandbagging ? 'sandbagging' : null,
            noPower ? 'virtual power' : null,
        ].filter(Boolean).join(', ');
        out.push({
            place: (valid && !x.dnf && !x.dns) ? place : null,
            name,
            timeSeconds: x.activityData && x.activityData.durationInMilliseconds != null ?
                x.activityData.durationInMilliseconds / 1000 : null,
            avgWatts: x.sensorData && typeof x.sensorData.avgWatts === 'number' ?
                x.sensorData.avgWatts : null,
            flags,
            // The tag Sauce reads from the name it shows, for the team's places in the race
            // commentary, and which row is the rider's own.
            team: x.athlete && typeof x.athlete.team === 'string' && x.athlete.team ? x.athlete.team : null,
            isSelf: selfId != null && x.profileId === selfId,
        });
    }
    return out;
}


/* ------------------------------------------------------------------ the watchdog */

async function explainSilence() {
    /*
     * Nothing has arrived on the push feed for a minute. There are four reasons that happen, and
     * a window that just says "Waiting for Zwift" forever is useless in every one of them, so ask
     * Sauce once and say which it is.
     *
     * One poll of getAthleteData tells three of them apart, because that RPC reads the athlete
     * record directly rather than through the emitter:
     *
     *   nothing back          Zwift is not running, or Sauce has not seen the rider yet.
     *   a payload with an     Sauce created the athlete record and set the event on it, then
     *   eventSubgroupId but   returned before recording anything, which is what it does for an
     *   no push events        event tagged hidethehud or nooverlays (src/stats.mjs:3048-3049,
     *                         3071-3073). Nothing at all can be recorded in those events.
     *   a payload, no event   The push emitter is not delivering: either another window is
     *   tag                   filtering it, or this Sauce is older than the athlete/self/v2
     *                         emitter, in which case the subscription registers and nothing is
     *                         ever emitted (src/stats.mjs:921-928).
     */
    if (explainedSilence) {
        return;
    }
    explainedSilence = true;
    let data = null;
    try {
        data = await Common.rpc.getAthleteData('self', {version: 2, resources: []});
    } catch(e) {
        data = null;
    }
    if (!isSelfPayload(data)) {
        showBanner('#feed-problem',
            'Sauce has no data for you yet. That usually means Zwift is not running, or Sauce has ' +
            'not connected to it. Nothing is wrong with the mod: leave this window open and it ' +
            'will start on its own.');
        return;
    }
    if (data.eventSubgroupId != null) {
        let tags = null;
        try {
            const sg = await Common.rpc.getEventSubgroup(data.eventSubgroupId);
            tags = sg && sg.allTags;
        } catch(e) {
            tags = null;
        }
        if (eventBlocksRecording(tags)) {
            showBanner('#feed-problem',
                'The organiser tagged this event "hidethehud" or "nooverlays". Sauce records ' +
                'nothing at all for you in an event tagged that way, so no mod can report on it. ' +
                'This is not something the mod can work around.');
            recorder.addNote('The organiser tagged this event hidethehud or nooverlays, so Sauce ' +
                             'recorded nothing for you in it.');
            return;
        }
    }
    showBanner('#feed-problem',
        `Sauce has your data but is not pushing it to this window. This mod needs Sauce ` +
        `${MIN_SAUCE_VERSION} or newer. Reading your data directly instead, once a second, which ` +
        `works but can miss a second here and there.`);
    startPolling('the live feed is not delivering');
}


/* ------------------------------------------------------------------ wiring */

function wire() {
    $('#btn-start').addEventListener('click', () => {
        recorder.startManual();
        refreshLive();
    });
    $('#btn-stop').addEventListener('click', () => {
        recorder.stopManual();
        refreshLive();
    });
    // Two buttons, one per style, each with its own prompt and facts (factpack.mjs).
    for (const btn of [$('#btn-copy-commentary'), $('#btn-copy-debrief')]) {
        btn.addEventListener('click', async () => {
            const text = await currentFactPack(btn.dataset.style);
            if (!text) {
                return;
            }
            const how = await copyText(text);
            const was = btn.dataset.label || (btn.dataset.label = btn.textContent);
            btn.textContent = how === 'manual' ? 'Copy it from the box below' : 'Copied';
            setTimeout(() => (btn.textContent = was), 2500);
        });
    }
    $('#btn-download-current').addEventListener('click', async () => {
        if (!currentRecId) {
            return;
        }
        const id = currentRecId;
        const json = await store.loadRaw(id);
        if (json) {
            downloadJSON(json, fileNameFor(currentRec && currentRec.id === id ? currentRec :
                store.list().find(x => x.id === id) || {}));
        }
    });
    $('#btn-results').addEventListener('click', ev => fetchResults(ev.target.dataset.id));
    $('#recordings').addEventListener('click', ev => {
        const id = ev.target.dataset && ev.target.dataset.id;
        if (!id) {
            return;
        }
        if (ev.target.classList.contains('open')) {
            // Open used to load the report into the Report tab and leave the list showing, so it
            // looked as if nothing happened (Van, 17 Sep 2026).
            showRecording(id).then(() => showPane('report'));
        } else if (ev.target.classList.contains('delete')) {
            askInPage('Delete this recording? It cannot be brought back.', async () => {
                await store.remove(id);
                if (currentRecId === id) {
                    currentRecId = null;
                    currentRec = null;
                    $('#report').innerHTML = '';
                    $('#report-actions').hidden = true;
                }
                renderList();
            });
        } else if (ev.target.classList.contains('download')) {
            store.loadRaw(id).then(json => {
                if (json) {
                    downloadJSON(json, fileNameFor(store.list().find(x => x.id === id) || {}));
                }
            });
        }
    });
    $('#btn-download-all').addEventListener('click', async () => {
        // The same JSON as {mod, modVersion, races: [...]}, put together from each race's stored
        // text rather than from every race parsed at once.
        const races = [];
        for (const x of store.list()) {
            const json = await store.loadRaw(x.id);
            if (json) {
                races.push(races.length ? ',' : '', json);
            }
        }
        if (!races.length) {
            return;
        }
        const d = new Date().toISOString().slice(0, 10);
        downloadJSON([`{"mod":"race-report","modVersion":${JSON.stringify(MOD_VERSION)},"races":[`,
                      ...races, ']}'], `race-reports-${d}.json`);
    });
    $('#btn-delete-all').addEventListener('click', () => {
        askInPage('Delete every recording this mod has saved? It cannot be brought back.', async () => {
            await store.removeAll();
            currentRecId = null;
            currentRec = null;
            $('#report').innerHTML = '';
            $('#report-actions').hidden = true;
            $('#budget-warning').hidden = true;
            renderList();
        });
    });
    $('#confirm-yes').addEventListener('click', () => {
        const fn = pendingConfirm;
        pendingConfirm = null;
        $('#confirm').hidden = true;
        if (fn) {
            fn();
        }
    });
    $('#confirm-no').addEventListener('click', () => {
        pendingConfirm = null;
        $('#confirm').hidden = true;
    });
    for (const el of $$('.dismiss')) {
        el.addEventListener('click', ev => {
            const box = ev.target.closest('.banner');
            if (box) {
                box.hidden = true;
            }
        });
    }
    for (const key of ['autoRecord', 'racesOnly', 'namesInCopy']) {
        for (const el of $$(`[data-setting="${key}"]`)) {
            el.checked = !!store.settings()[key];
            el.addEventListener('change', () => {
                store.setSetting(key, el.checked);
                for (const other of $$(`[data-setting="${key}"]`)) {
                    other.checked = el.checked;
                }
            });
        }
    }
    // A number of seconds rather than a tick box. The recorder reads it on every payload, so a
    // change takes effect at once, including during the extra time itself.
    for (const el of $$('[data-setting="teamTag"]')) {
        el.value = String(store.settings().teamTag || '');
        el.addEventListener('change', () => {
            store.setSetting('teamTag', el.value.trim());
        });
    }
    for (const el of $$('[data-setting="afterLineSeconds"]')) {
        el.value = String(store.settings().afterLineSeconds);
        el.addEventListener('change', () => {
            store.setSetting('afterLineSeconds', Number(el.value) || 0);
        });
    }
    for (const tab of $$('.tab')) {
        tab.addEventListener('click', () => showPane(tab.dataset.pane));
    }
}

function showPane(name) {
    for (const t of $$('.tab')) {
        t.classList.toggle('active', t.dataset.pane === name);
    }
    for (const p of $$('.pane')) {
        p.hidden = p.dataset.pane !== name;
    }
}


async function offerResume() {
    /*
     * takePending moves last session's interrupted recording out of the live slot before the
     * recorder can write to it, so a race that is still running can keep recording into a new
     * one while this banner waits to be answered.
     */
    const live = await store.takePending();
    if (!live || !live.inProgress) {
        return;
    }
    showBanner('#resume', `A recording was interrupted on ` +
        `${new Date(live.startedISO).toLocaleString()} with ` +
        `${live.counts ? live.counts.selfRows : 0} seconds of your ride in it. Sauce restarting, ` +
        `or the window closing, will do that. If the race is still running, a second recording of ` +
        `the rest of it is being made now.`);
    $('#resume-save').onclick = async () => {
        let rec = {...live};
        delete rec.inProgress;
        rec.endedAt = live.snapshotAt || Date.now();
        rec.endedISO = new Date(rec.endedAt).toISOString();
        const savedRace = rec.afterLine ? await store.load(rec.id) : null;
        if (savedRace) {
            // It closed during the extra time after the line, and the race had already been
            // saved at the line with Sauce's stats and streams (onLine). Only the extra time so
            // far is added to it.
            rec = withAfterLine(savedRace, rec);
        } else if (rec.afterLine) {
            // It closed after the line but before the save at the line finished. The snapshot
            // already holds the race frozen at the line, finished and checked for completeness
            // (snapshotForCrash in recorder.mjs). Sauce's stats and streams are not attached:
            // after a restart Sauce no longer has that slice, and another slice for the same
            // event could be taken for it. A race with no extra time closed at that moment
            // would have lost the same. Its profile is read below, as for every resumed race.
        } else {
            rec.stopReason = rec.stopReason || 'window-closed';
            rec.incomplete = true;
            rec.incompleteReasons = [...(rec.incompleteReasons || []),
                                     'the window or Sauce closed while it was running'];
            rec.elapsedSeconds = Math.round((rec.endedAt - rec.startedAt) / 1000);
        }
        // A snapshot carries no profile, and without it both copied texts lose FTP, W/kg, the hard
        // efforts and the W'bal model's CP and W'. It returns at once for a race that has one.
        await captureSelfProfile(rec);
        if (rec.eventSubgroupId != null && !rec.event) {
            rec.event = await findEventInfo(rec.eventSubgroupId);
        }
        if (!rec.segments) {
            await attachSegments(rec);
        }
        const res = await store.save(rec);
        if (res.ok) {
            // Only once it is stored: otherwise the next start offers it again.
            await store.clearPending();
        }
        $('#resume').hidden = true;
        renderList();
        if (res.ok) {
            showRecording(rec.id);
        } else {
            showSaveProblem(res, rec);
        }
    };
    $('#resume-discard').onclick = () => {
        store.clearPending();
        $('#resume').hidden = true;
    };
}


async function main() {
    const ls = localStorageOrNull();
    store = await openStore({
        indexedDB: indexedDBFactory(),
        localStorage: ls,
        settings: settingsAdapter(ls),
        legacy: ls ? new LegacyStorage(ls, {onWrite: scheduleFlush}) : null,
        estimate: await storageEstimate(),
        onLocalWrite: scheduleFlush,
    });
    const persisted = store.kind === 'indexeddb' ? await requestPersistence() : null;
    // Once, at startup, so a rider's report of a problem can say where their races are kept.
    console.info(`Race Report: recordings are kept in ${store.kind}` +
                 `${store.fallbackReason ? ` (${store.fallbackReason})` : ''}` +
                 `${store.kind === 'indexeddb' ? `, kept when the disk runs low: ${persisted}` : ''}.`);
    const moved = store.migration;
    if (moved && (moved.moved || moved.kept || moved.snapshots || moved.waiting || moved.error)) {
        console.info('Race Report: races kept elsewhere before:', moved);
    }
    if (store.indexedDBFailed) {
        showBanner('#store-problem', null);
    }
    try {
        imperial = !!(Common.settingsStore && Common.settingsStore.get('/imperialUnits'));
    } catch(e) {
        imperial = false;
    }
    recorder = new Recorder({onLine, onFinalized, autoRecord: store.settings().autoRecord,
                             afterLineSeconds: store.settings().afterLineSeconds,
                             gunClock: true, listeningSince: startedAt,
                             // The size ladder is for the localStorage fallback only (store.mjs).
                             sizeBudgetBytes: store.perRaceBudget,
                             sizeGuard: store.kind !== 'indexeddb'});
    wire();
    renderList();
    await offerResume();
    refreshLive();

    $('#mod-version').textContent = MOD_VERSION;
    $('#min-sauce-version').textContent = MIN_SAUCE_VERSION;
    try {
        $('#sauce-version').textContent = await Common.rpc.getVersion();
    } catch(e) {
        $('#sauce-version').textContent = 'unknown';
    }

    // Both persistent. See the note at the top of this file.
    Common.subscribe('athlete/self/v2', onSelfPayload, {
        persistent: true,
        options: {resources: SELF_RESOURCES, stats: false},
    });

    // ['state'], exactly as Sauce's own Groups window asks (pages/src/groups.mjs:824-830), for each
    // rider's power and draft in the rider's group (WHO DID WHAT IN YOUR GROUP, recorder.mjs).
    Common.subscribe('groups/v2', onGroupsPayload, {
        persistent: true,
        options: {resources: GROUPS_RESOURCES},
    });

    setInterval(() => {
        recorder.tick();
        refreshLive();
        reportWriteErrors();
        if (!droppedMovedCopies && recorder.state !== 'recording' &&
            (recorder.lastSelfAt ? !lastSelfInEvent :
                (Date.now() - startedAt) / 1000 > SILENCE_BEFORE_EXPLAINING)) {
            // Old copies of races that moved, removed only outside an event, because removing an
            // old "/" key reloads Sauce's overlays once (MOVING OLD RACES IN, store.mjs).
            droppedMovedCopies = true;
            store.dropMovedCopies().catch(() => undefined);
        }
        if (!recorder.lastSelfAt && !pollingSelf &&
            (Date.now() - startedAt) / 1000 > SILENCE_BEFORE_EXPLAINING) {
            explainSilence();
        }
    }, 1000);

    setInterval(() => saveLiveIfDue(true), autosaveSeconds() * 1000);

    for (const ev of ['beforeunload', 'pagehide']) {
        addEventListener(ev, () => {
            if (recorder.state === 'recording') {
                saveLiveNow();
                // For the localStorage fallback: the flush is scheduled 500 ms after a write, and
                // that timer will not run on a closing window (pages/src/common.mjs:224-228), so
                // ask for it now. An IndexedDB write started here may not complete either. The
                // autosave is what actually protects the recording.
                flushNow();
            }
        });
    }
}


function syncSettings() {
    const settings = store.settings();
    recorder.autoRecord = settings.autoRecord;
    recorder.afterLineSeconds = settings.afterLineSeconds;
}


function noteInEvent(data) {
    const st = data && data.state;
    lastSelfInEvent = !!((st && st.eventSubgroupId) || (data && data.eventSubgroupId));
}


function onSelfPayload(data) {
    noteInEvent(data);
    syncSettings();
    const result = recorder.onSelf(data);
    if (result === 'bad') {
        maybeStartPolling();
        return;
    }
    maybeLookUpScheduledStart(data);
    saveLiveIfDue(false);
    maybeResolveNames();
}


function onGroupsPayload(groups) {
    syncSettings();
    recorder.onGroups(groups);
    maybeResolveNames();
}


function maybeResolveNames() {
    if (recorder.state !== 'recording') {
        return;
    }
    const now = Date.now();
    if (now - lastNameLookupAt < NAME_LOOKUP_SECONDS * 1000) {
        return;
    }
    lastNameLookupAt = now;
    resolveRiderNames();
}


function saveLiveIfDue(force) {
    /*
     * Called from the data callback as well as from a timer, because Chromium throttles timers in
     * a hidden window. A crash or a Sauce restart then loses at most AUTOSAVE_SECONDS, or
     * LOCAL_AUTOSAVE_SECONDS with the localStorage fallback. Each save writes only the rows added
     * since the last one (THE CRASH SNAPSHOT in store.mjs).
     */
    if (recorder.state !== 'recording') {
        return;
    }
    const now = Date.now();
    if (!force && now - lastLiveSaveAt < autosaveSeconds() * 1000) {
        return;
    }
    saveLiveNow();
}


/* A failed write is said once in the console, not once a save. */
function reportWriteErrors() {
    if (store.writeErrors > reportedWriteErrors) {
        if (!reportedWriteErrors) {
            console.warn('Race Report: a write to the recordings store failed. The recording ' +
                         'is still held in this window and is offered as a file if it cannot be ' +
                         'saved.', store.lastWriteError);
        }
        reportedWriteErrors = store.writeErrors;
    }
}


function saveLiveNow() {
    lastLiveSaveAt = Date.now();
    return store.saveLive(recorder.snapshotForCrash(), {rowsEpoch: recorder.rowsEpoch});
}


async function maybeStartPolling() {
    /*
     * The push feed is delivering something that is not an athlete payload. That happens when
     * another window or mod widens the shared query for this event: Sauce's per-listener mask
     * walks the payload as an array and an athlete payload is an object
     * (src/stats.mjs:806-823). Polling the RPC instead skips the emitter completely.
     */
    if (recorder.consecutiveBadSelfPayloads < BAD_PAYLOADS_BEFORE_FALLBACK) {
        return;
    }
    startPolling('another Sauce window or mod is filtering the live feed');
}


let pollTimer = null;

async function startPolling(why) {
    if (pollingSelf) {
        return;
    }
    pollingSelf = true;
    console.warn(`Race Report: ${why}, so this mod is reading your data directly instead.`);
    try {
        await Common.unsubscribe('athlete/self/v2');
    } catch(e) {
        // Nothing to undo if it was never there.
    }
    pollTimer = setInterval(async () => {
        let data;
        try {
            data = await Common.rpc.getAthleteData('self', {version: 2, resources: SELF_RESOURCES});
        } catch(e) {
            return;
        }
        if (isSelfPayload(data)) {
            noteInEvent(data);
            syncSettings();
            recorder.onSelf(data);
            maybeLookUpScheduledStart(data);
            recorder.addNote(POLLING_NOTE);
            saveLiveIfDue(false);
            maybeResolveNames();
        }
    }, 1000);
}


const POLLING_NOTE = 'The live data feed was not usable, so this recording was read once a ' +
    'second instead of being pushed. Seconds can be missing from it.';

main().catch(e => {
    console.error('Race Report failed to start', e);
    const el = document.querySelector('#status');
    if (el) {
        el.textContent = `Race Report could not start: ${e.message}`;
    }
});
