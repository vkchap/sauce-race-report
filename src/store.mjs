/*
 * Race Report - storage.
 *
 * WHAT THIS FILE DOES: saves, lists, loads and deletes recordings, holds the settings, and holds
 * the in-progress snapshot that survives Sauce restarting. Pure logic over small adapters, so it
 * can be tested with fakes in node. Nothing in here reaches for a browser global: ui.mjs hands in
 * IndexedDB, localStorage and the storage estimate.
 *
 * WHY NOTHING IS WRITTEN UNDER A "/" KEY ANY MORE. Van, 16 Sep 2026, after a 69 minute session
 * with this window minimised: "screen flicker - have to get rid of it - it's distracting - it was
 * the whole screen - not just sauce". Every localStorage write fires a 'storage' event in every
 * other window of the same origin, and every Sauce window listens: for any key starting with "/"
 * it JSON.parses the whole new value and dispatches a 'globalupdate' event
 * (pages/src/common.mjs:66, :69-84), which SettingsStore turns into a remote 'set'
 * (pages/src/common.mjs:988-996). What the overlays do with that is worse than the parsing. The
 * Watching window calls window.location.reload() for any key but /theme, /imperialUnits and
 * themeOverride (pages/src/watching.mjs:1473-1486); the Overview bar stops its renderer and builds
 * its layout again (pages/src/overview.mjs:68-89); a gauge is set up again with its animation off
 * (pages/src/gauge.mjs:385-396). A removal counts too: JSON.parse(null) is null, and the event
 * still fires. This mod used to keep every recording, and a snapshot of the race in progress
 * rewritten whole every 20 seconds, under "/" keys, so every Watching overlay reloaded about
 * three times a minute for as long as a race ran. That is not proven to be the whole-screen
 * flicker, but it is the one thing this mod did to every other window, and it is gone:
 *
 *   IndexedDB   Recordings, their index and the crash snapshot live in an IndexedDB database in
 *               this window's own origin. IndexedDB fires no event in any other window. Sauce's
 *               own pages never use it, so nothing of Sauce's shares it. A mod window is
 *               sandboxed Chromium (src/windows.mjs:1479-1481) on a persistent session partition
 *               (src/windows.mjs:457-458), where IndexedDB is normally there and kept on disk,
 *               but that has not been checked inside Sauce, so it is feature detected, opened
 *               (and opened once more if the first try fails), and proven with a write and a
 *               read before anything relies on it.
 *   fallback    If it is missing or fails, the same data goes to localStorage under keys that do
 *               NOT start with "/". Sauce's handler only parses keys that start with "/" or with
 *               the listening window's own id prefix (pages/src/common.mjs:75-81), so those it
 *               ignores. They are written with localStorage directly, not through Common.storage,
 *               which would put this window's id in front of them (pages/src/common.mjs:103) and
 *               lose them when the window is removed and added again (src/windows.mjs:986). Every
 *               value is written in pieces of at most LOCAL_PIECE_CHARS, so no single write is
 *               more than a few kB, and ui.mjs writes the crash snapshot less often.
 *   settings    The handful of settings are in localStorage under KEY_SETTINGS, also with no
 *               leading "/", written directly (LocalSettings) so they survive the window being
 *               re-added and a reinstall from the mod store, which replaces the mod's own id
 *               (src/mods.mjs:315-318). They used to be under "/sauce-race-report/settings", and
 *               every change reloaded the overlays the same way. That old key is read once as the
 *               starting values and never written or removed, because removing it would fire the
 *               event one last time.
 *
 * Moving races an earlier version saved under "/" keys (see MOVING OLD RACES IN) removes those
 * keys once, in one go, at a moment no race is recording. The overlays reload that once.
 *
 * Common.storage schedules a flushSessionStorage RPC 500 ms after every write
 * (pages/src/common.mjs:224-228, src/windows.mjs:886-889) so an ordinary quit does not lose it.
 * The localStorage writes here ask for the same through onWrite. IndexedDB needs no flush: a
 * readwrite transaction is on disk when it completes.
 *
 * Races kept in IndexedDB stay with the Sauce profile they were recorded in. Sauce's Clone and
 * Export profile copy localStorage only (src/windows.mjs:1148-1190, src/preload/storage-proxy.js),
 * so they do not carry the races; "Save every race to one file" does.
 *
 * THE CRASH SNAPSHOT is written in pieces rather than whole. A three hour race is megabytes, and
 * rewriting all of it every 20 seconds would be the same mistake again in another place. Each save
 * writes the rows added since the last one as one numbered chunk, the riders whose entry changed
 * since the last save as another, and a small head: the snapshot with its row arrays and riders
 * taken out, which carries the counts and notes that change in place, and the order of the riders.
 * A big field that keeps changing would otherwise rewrite hundreds of kB of riders on every save.
 * Riders are written again whole, as rider chunk 0, once what the rider chunks hold has grown to
 * twice the riders themselves, so they never take much more room than one copy. Reading it back
 * joins the chunks in order, and checks that every chunk is there, every series has the rows the
 * head says and every rider is found, so a snapshot that lost a chunk is never offered as if it
 * were whole. Anything that rewrites rows already written (the recorder moving a recording onto
 * the gun clock, see THE GUN in recorder.mjs) bumps the recorder's rowsEpoch, and the last row
 * written of every series is checked too, so the next save starts again from chunk 0 rather than
 * joining rows from two different clocks.
 *
 * THE SIZE RULE. With IndexedDB the budgets come from navigator.storage.estimate() when Chromium
 * gives one (see indexedDBBudgets), and the recorder keeps the rider's own numbers every second and
 * the pack every two seconds for as long as the race runs. Only the localStorage fallback keeps the
 * old rule: that pool is shared by every Sauce window and every other enabled mod in this Sauce
 * profile (src/windows.mjs:452-466, :1468), Sauce's own window settings live in it
 * (pages/src/common.mjs:1072), Sauce handles QuotaExceededError nowhere, and Chromium's
 * per-origin localStorage limit is commonly around 5 MB. There one recording is capped at 400 kB,
 * the total at 1 MB, the warning comes at 700 kB, and the recorder's size ladder thins long races.
 * A race that will not fit either way is still handed back as a file download rather than lost,
 * and its crash snapshot is kept, to be offered again on the next start.
 */

// The keys this mod used in Common.storage before IndexedDB. They are only read, to move what is
// in them (see MOVING OLD RACES IN), and removed once the move has been confirmed.
export const KEY_PREFIX = '/sauce-race-report';
export const KEY_INDEX = `${KEY_PREFIX}/index`;
export const KEY_LIVE = `${KEY_PREFIX}/live`;
export const KEY_PENDING = `${KEY_PREFIX}/pending`;
export const LEGACY_KEY_SETTINGS = `${KEY_PREFIX}/settings`;
export const keyForRecording = id => `${KEY_PREFIX}/rec/${id}`;

// No leading "/", so Sauce's storage handler never parses these (pages/src/common.mjs:75-81).
export const LOCAL_PREFIX = 'sauce-race-report:';
export const LOCAL_PIECE_CHARS = 4000;
export const KEY_SETTINGS = `${LOCAL_PREFIX}settings`;

// The keys inside the new store, the same for IndexedDB and for the localStorage fallback.
const K_INDEX = 'index';
const K_LIVE = 'live';          // {id} of the snapshot of the recording running now
const K_PENDING = 'pending';    // {id} of the snapshot last session left behind
const K_UNSAVED = 'unsaved';    // [id, ...] of snapshots still to be offered: a save that failed
const K_MOVED = 'moved';        // what was copied in from an older place, see MOVING OLD RACES IN
const K_PROBE = 'probe';
const RACE_PREFIX = 'race/';
const SNAP_PREFIX = 'snap/';
const kRace = id => `${RACE_PREFIX}${id}`;
const kSnapHead = id => `${SNAP_PREFIX}${id}/head`;
const kSnapRows = (id, n) => `${SNAP_PREFIX}${id}/rows/${n}`;
const kSnapRiders = (id, n) => `${SNAP_PREFIX}${id}/riders/${n}`;

export const DB_NAME = 'sauce-race-report';
export const DB_VERSION = 1;
export const DB_STORE = 'kv';
const DB_OPEN_TIMEOUT_MS = 5000;
// A second, longer try, for a window that comes up while Sauce and Zwift are still starting.
const DB_OPEN_RETRY_TIMEOUT_MS = 15000;

/*
 * A snapshot no slot points at, and not saved to for this long, is left over from a window that
 * closed in a way nothing cleaned up after (two Race Report windows, a crash between steps), and is
 * removed at startup. A window still recording saves every 20 or 60 seconds, so it is never this
 * old.
 */
const STALE_SNAPSHOT_MS = 10 * 60 * 1000;

export const DEFAULT_TOTAL_BUDGET = 1_000_000;
export const DEFAULT_WARN_AT = 700_000;
export const LOCAL_BUDGETS = {perRace: 400_000, total: DEFAULT_TOTAL_BUDGET, warnAt: DEFAULT_WARN_AT};

/*
 * IndexedDB budgets. Chromium lets an origin use a large share of the disk and reports it through
 * navigator.storage.estimate(). A quarter of that quota, but never more than 512 MB, is the total;
 * one race may take an eighth of the total, between 8 MB and 64 MB. A three hour race at full
 * resolution is under 2 MB. Without an estimate the fixed budgets below are used.
 */
export const IDB_FIXED_BUDGETS = {perRace: 32_000_000, total: 256_000_000, warnAt: 204_800_000};
const IDB_MAX_TOTAL = 512_000_000;
const IDB_MIN_PER_RACE = 8_000_000;
const IDB_MAX_PER_RACE = 64_000_000;

// The key in a snapshot head that says how its rows were written. Taken out again on reading.
const ROWS_KEY = '__rows';
// The layout written now: row chunks as arrays in the order of the head's `paths`, and riders
// in their own chunks. Snapshots an earlier version wrote have rows keyed by path.
const SNAPSHOT_FORMAT = 2;

export const DEFAULT_SETTINGS = {
    // Records any event by itself. Off means nothing is recorded unless "Start now" is pressed.
    autoRecord: true,
    /*
     * OFF by default, deliberately. When it was on, an event Zwift lists as GROUP_RIDE was
     * recorded and then deleted with nothing on screen to say why, and plenty of community races
     * are listed as GROUP_RIDE. With it off every event is kept and the ones that are not races
     * are simply labelled in the list.
     */
    racesOnly: false,
    /*
     * ON by default (Van, 16 Sep 2026). Everything shown inside the window uses the names Sauce
     * itself shows. This setting only governs the text the two copy buttons put on the clipboard,
     * which leaves the computer as soon as it is pasted, and the copied text says so in its last
     * line. Unticked, every rider is a per-race label and team tags are left out.
     */
    namesInCopy: true,
    /*
     * Two minutes by default (Van, 16 Sep 2026: "I think adding 2 minutes to any race likely
     * captures anything interesting"). An automatic recording keeps watching this long after the
     * rider's own finish, to see the riders behind come in. Every number about the race still
     * stops at the line. 0 stops at the line exactly as before; see AFTER THE LINE in recorder.mjs.
     */
    afterLineSeconds: 120,
    /*
     * The rider's team tag for the race commentary, which is written about the team (Van, 18 Sep
     * 2026). Empty means the tag Sauce reads from the rider's own Zwift name.
     */
    teamTag: '',
};

const isNum = x => typeof x === 'number' && isFinite(x);


export function summarize(rec) {
    const tl = rec.timeline || {};
    const pos = rec.finishPosition != null ? rec.finishPosition : lastNonNull(tl.eventPosition);
    const participants = rec.finishParticipants != null ?
        rec.finishParticipants :
        lastNonNull(tl.eventParticipants);
    return {
        id: rec.id,
        startedISO: rec.startedISO,
        endedISO: rec.endedISO,
        elapsedSeconds: rec.elapsedSeconds ?? null,
        eventName: rec.event ? rec.event.name : null,
        eventType: rec.event ? rec.event.eventType : null,
        subgroupLabel: rec.event ? rec.event.subgroupLabel : null,
        // For the debrief's earlier races, without loading every race (isEarlierRace in factpack.mjs).
        trigger: rec.trigger || null,
        eventSubgroupId: rec.eventSubgroupId ?? null,
        position: pos,
        participants,
        riders: rec.counts ? rec.counts.riders : 0,
        incomplete: !!rec.incomplete,
        incompleteReasons: rec.incompleteReasons || [],
        stopReason: rec.stopReason,
        storedIn: rec.storedIn || null,
        bytes: 0,
    };
}


export function lastNonNull(arr) {
    if (!Array.isArray(arr)) {
        return null;
    }
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] != null) {
            return arr[i];
        }
    }
    return null;
}


/* The budgets for the IndexedDB store, from navigator.storage.estimate() when there is one. */
export function indexedDBBudgets(estimate) {
    const quota = estimate && estimate.quota;
    if (!isNum(quota) || quota <= 0) {
        return {...IDB_FIXED_BUDGETS, source: 'fixed'};
    }
    const total = Math.min(IDB_MAX_TOTAL, Math.floor(quota / 4));
    const perRace = Math.min(total, IDB_MAX_PER_RACE, Math.max(IDB_MIN_PER_RACE, Math.floor(total / 8)));
    return {perRace, total, warnAt: Math.floor(total * 0.8), source: 'estimate'};
}


/* A stored list of ids, or of index entries: missing is empty, unreadable is an error. */
function parseList(raw) {
    if (raw == null) {
        return [];
    }
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) {
        throw new Error('a stored list is not a list');
    }
    return list;
}


/* ------------------------------------------------------------------ the snapshot in pieces */

/*
 * The row series a snapshot holds, which are what grows: the race's own rows and membership log,
 * and after the line the extra time's rows beside the race frozen there (see snapshotForCrash in
 * recorder.mjs).
 */
const ROW_GROUPS = [
    ['timeline', s => s.timeline, (s, g) => (s.timeline = g)],
    ['pack', s => s.pack, (s, g) => (s.pack = g)],
    // The membership log only grows, like the rows (WHO WAS IN THE OTHER GROUPS in recorder.mjs).
    ['moves', s => s.moves, (s, g) => (s.moves = g)],
    // Each rider's power and draft in the rider's group, which only grows too (recorder.mjs).
    ['inGroup', s => s.inGroup, (s, g) => (s.inGroup = g)],
    // Every group in view on each pack row, which only grows too (recorder.mjs).
    ['roadGroups', s => s.roadGroups, (s, g) => (s.roadGroups = g)],
    ['afterLine.timeline', s => s.afterLine && s.afterLine.timeline, (s, g) => (s.afterLine.timeline = g)],
    ['afterLine.pack', s => s.afterLine && s.afterLine.pack, (s, g) => (s.afterLine.pack = g)],
];

const isPlainObject = x => !!x && typeof x === 'object' && !Array.isArray(x);


/*
 * Takes a snapshot apart into a head with every row array replaced by null, and the arrays
 * themselves by path ("timeline.power"). The snapshot is left alone. The nulls keep each key where
 * it was, so joining the parts gives back the same JSON, key for key.
 */
export function splitSnapshot(snap) {
    const head = {...snap};
    if (isPlainObject(snap.afterLine)) {
        head.afterLine = {...snap.afterLine};
    }
    const rows = {};
    for (const [name, get, set] of ROW_GROUPS) {
        const group = get(snap);
        if (!isPlainObject(group)) {
            continue;
        }
        const kept = {};
        for (const [k, v] of Object.entries(group)) {
            if (Array.isArray(v)) {
                rows[`${name}.${k}`] = v;
                kept[k] = null;
            } else {
                kept[k] = v;
            }
        }
        set(head, kept);
    }
    return {head, rows};
}


/*
 * The other way: a head, its row chunks and its rider chunks, oldest first, back into one
 * snapshot. Row chunks are either the current layout ({rows: [array per path in the head's
 * `paths`]}) or rows keyed by path. Throws when the chunks do not hold what the head says, rather
 * than returning a snapshot with rows or riders missing.
 */
export function joinSnapshot(head, chunks, riderChunks = []) {
    const meta = head[ROWS_KEY] || {counts: {}};
    const snap = {...head};
    delete snap[ROWS_KEY];
    if (isPlainObject(snap.afterLine)) {
        snap.afterLine = {...snap.afterLine};
    }
    const byPath = {};
    const append = (path, part) => {
        if (Array.isArray(part)) {
            const arr = byPath[path] || (byPath[path] = []);
            for (const x of part) {
                arr.push(x);
            }
        }
    };
    for (const c of chunks) {
        if (!isPlainObject(c)) {
            throw new Error('a chunk of the snapshot is missing');
        }
        if (Array.isArray(meta.paths)) {
            (c.rows || []).forEach((part, i) => append(meta.paths[i], part));
        } else {
            for (const [path, part] of Object.entries(c)) {
                append(path, part);
            }
        }
    }
    for (const [name, get, set] of ROW_GROUPS) {
        const group = get(snap);
        if (!isPlainObject(group)) {
            continue;
        }
        const out = {...group};
        for (const k of Object.keys(group)) {
            const path = `${name}.${k}`;
            if (!(path in meta.counts)) {
                continue;
            }
            const arr = byPath[path] || [];
            if (arr.length !== meta.counts[path]) {
                throw new Error(`the snapshot has ${arr.length} of ${meta.counts[path]} rows of ` +
                                `${path}`);
            }
            out[k] = arr;
        }
        set(snap, out);
    }
    if (Array.isArray(meta.riderKeys)) {
        const seen = {};
        for (const c of riderChunks) {
            if (!isPlainObject(c)) {
                throw new Error('a rider chunk of the snapshot is missing');
            }
            Object.assign(seen, c);
        }
        const riders = {};
        for (const k of meta.riderKeys) {
            if (!(k in seen)) {
                throw new Error(`the snapshot is missing rider ${k}`);
            }
            riders[k] = seen[k];
        }
        snap.riders = riders;
    }
    return snap;
}


/*
 * What one save of the snapshot writes, given what the writer `w` has already written (null for
 * nothing). Pure: returns the head, the row chunk and the rider chunk (each null when nothing in it
 * changed), the rider chunks a rewrite of the riders leaves behind, and the writer's state after
 * it, without touching `w`.
 */
function planChunk(snap, w, at) {
    const {head, rows} = splitSnapshot(snap);
    const riders = isPlainObject(head.riders) ? head.riders : null;
    if (riders) {
        head.riders = null;
    }
    const paths = w ? w.paths.slice() : [];
    for (const p of Object.keys(rows)) {
        if (!paths.includes(p)) {
            paths.push(p);
        }
    }
    const counts = {};
    const tails = {};
    const chunkRows = [];
    let added = 0;
    for (const p of paths) {
        const arr = rows[p];
        const part = arr.slice(w ? (w.counts[p] || 0) : 0);
        chunkRows.push(part);
        added += part.length;
        counts[p] = arr.length;
        tails[p] = tailOf(arr, arr.length);
    }
    while (chunkRows.length && !chunkRows[chunkRows.length - 1].length) {
        chunkRows.pop();
    }
    let riderJson = null;
    let changed = null;
    let changedBytes = 0;
    let rosterBytes = 0;
    if (riders) {
        riderJson = new Map();
        for (const [k, v] of Object.entries(riders)) {
            const json = JSON.stringify(v);
            riderJson.set(k, json);
            rosterBytes += k.length + json.length;
            if (!w || !w.riders || w.riders.get(k) !== json) {
                changed = changed || {};
                changed[k] = v;
                changedBytes += k.length + json.length;
            }
        }
    }
    let riderChunks = w ? w.riderChunks : 0;
    let riderBytes = w ? w.riderBytes : 0;
    let ridersChunk = null;
    let ridersIndex = null;
    const riderDrops = [];
    if (riders && (!w || changed)) {
        if (!w || (riderChunks > 0 && riderBytes + changedBytes > 2 * rosterBytes)) {
            // All of them again as chunk 0, and the chunks after it go.
            for (let i = 1; i < riderChunks; i++) {
                riderDrops.push(i);
            }
            ridersChunk = riders;
            ridersIndex = 0;
            riderChunks = 1;
            riderBytes = rosterBytes;
        } else {
            ridersChunk = changed;
            ridersIndex = riderChunks;
            riderChunks++;
            riderBytes += changedBytes;
        }
    }
    const chunks = w ? w.chunks : 0;
    const writeChunk = !w || added > 0;
    head[ROWS_KEY] = {
        format: SNAPSHOT_FORMAT,
        paths,
        counts,
        chunks: writeChunk ? chunks + 1 : chunks,
        riderKeys: riders ? Array.from(riderJson.keys()) : undefined,
        riderChunks: riders ? riderChunks : undefined,
        at,
    };
    return {
        head,
        chunk: writeChunk ? {rows: chunkRows} : null,
        chunkIndex: writeChunk ? chunks : null,
        ridersChunk,
        ridersIndex,
        riderDrops,
        state: {paths, counts, tails, riders: riderJson, riderChunks, riderBytes,
                chunks: writeChunk ? chunks + 1 : chunks},
    };
}


function tailOf(arr, n) {
    return n > 0 ? JSON.stringify(arr[n - 1]) : null;
}


/* ------------------------------------------------------------------ the two places it can live */

/*
 * IndexedDB, as a string key-value store with one object store and out-of-line keys. Values are
 * JSON strings, so what is read back can be compared with what was written character for
 * character (see MOVING OLD RACES IN). `factory` is window.indexedDB, or the fake in the tests.
 */
export class IndexedDBKV {
    constructor(factory, name = DB_NAME) {
        this.factory = factory;
        this.name = name;
        this.kind = 'indexeddb';
        this.db = null;
    }

    open(timeoutMs = DB_OPEN_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            let done = false;
            const fail = e => {
                if (!done) {
                    done = true;
                    reject(e || new Error('IndexedDB could not be opened'));
                }
            };
            let req;
            try {
                req = this.factory.open(this.name, DB_VERSION);
            } catch(e) {
                fail(e);
                return;
            }
            const timer = setTimeout(() => fail(new Error('IndexedDB did not open in time')), timeoutMs);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(DB_STORE)) {
                    db.createObjectStore(DB_STORE);
                }
            };
            req.onsuccess = () => {
                clearTimeout(timer);
                if (done) {
                    // Too late: the fallback, or a second try, is already in use.
                    try {
                        req.result.close();
                    } catch(e) {
                        // nothing to do
                    }
                    return;
                }
                done = true;
                this.db = req.result;
                // Never hold up a newer version of this mod opening the same database.
                this.db.onversionchange = () => this.db.close();
                resolve(this);
            };
            req.onerror = () => {
                clearTimeout(timer);
                fail(req.error);
            };
            req.onblocked = () => {
                clearTimeout(timer);
                fail(new Error('IndexedDB is blocked by another connection'));
            };
        });
    }

    _transaction(mode, fn) {
        return new Promise((resolve, reject) => {
            let tx;
            let result;
            const box = {error: null};
            try {
                tx = this.db.transaction(DB_STORE, mode);
                result = fn(tx.objectStore(DB_STORE), tx, box);
            } catch(e) {
                reject(e);
                return;
            }
            let failed = false;
            const fail = () => {
                if (!failed) {
                    failed = true;
                    reject(box.error || tx.error || new Error('IndexedDB transaction failed'));
                }
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = fail;
            tx.onabort = fail;
        });
    }

    async getMany(keys) {
        const out = new Array(keys.length);
        await this._transaction('readonly', os => {
            keys.forEach((k, i) => {
                const req = os.get(k);
                req.onsuccess = () => {
                    out[i] = typeof req.result === 'string' ? req.result : undefined;
                };
            });
        });
        return out;
    }

    async get(key) {
        return (await this.getMany([key]))[0];
    }

    /* Every key that starts with `prefix`. */
    async keys(prefix) {
        let out = [];
        await this._transaction('readonly', os => {
            const req = os.getAllKeys();
            req.onsuccess = () => {
                out = (req.result || []).filter(k => typeof k === 'string' && k.startsWith(prefix));
            };
        });
        return out;
    }

    /* All of it or none of it, in one readwrite transaction. */
    write(puts = [], deletes = []) {
        return this._transaction('readwrite', os => {
            for (const [k, v] of puts) {
                os.put(v, k);
            }
            for (const k of deletes) {
                os.delete(k);
            }
        });
    }

    /*
     * Reads `key` and writes what `fn` makes of it in the same readwrite transaction. IndexedDB
     * runs readwrite transactions over the same store one after another, across every connection,
     * so a second Race Report window cannot slip a change in between the read and the write.
     * `fn(raw)` returns {value, puts, deletes}; if it throws, nothing is written.
     */
    update(key, fn) {
        return this._transaction('readwrite', (os, tx, box) => {
            const req = os.get(key);
            req.onsuccess = () => {
                let r;
                try {
                    r = fn(typeof req.result === 'string' ? req.result : undefined);
                } catch(e) {
                    box.error = e;
                    tx.abort();
                    return;
                }
                os.put(r.value, key);
                for (const [k, v] of (r.puts || [])) {
                    os.put(v, k);
                }
                for (const k of (r.deletes || [])) {
                    os.delete(k);
                }
            };
        });
    }
}


/*
 * localStorage, or anything with getItem, setItem, removeItem, key and length. Each value is kept
 * as a count under its own key and the text in pieces of at most LOCAL_PIECE_CHARS under "key#0",
 * "key#1" and so on, so no one write, and no one 'storage' event, is bigger than that. A write that
 * fails part way is put back as it was, so a failed save cannot leave half a race behind. A write
 * cut off by the process being killed can still leave a value that does not read back; the index
 * is rebuilt from the races when that happens (see _readIndex), and a snapshot is checked whole
 * before it is offered.
 */
export class LocalStorageKV {
    constructor(storage, {kind = 'localstorage', onWrite = null} = {}) {
        this.storage = storage;
        this.kind = kind;
        this.onWrite = onWrite;
    }

    _item(key) {
        return LOCAL_PREFIX + key;
    }

    _pieceCount(key) {
        const n = Number(this.storage.getItem(this._item(key)));
        return Number.isInteger(n) && n > 0 ? n : 0;
    }

    _getNow(key) {
        const head = this.storage.getItem(this._item(key));
        if (head == null) {
            return undefined;
        }
        const n = this._pieceCount(key);
        let s = '';
        for (let i = 0; i < n; i++) {
            const piece = this.storage.getItem(`${this._item(key)}#${i}`);
            if (piece == null) {
                return undefined;
            }
            s += piece;
        }
        return s;
    }

    async getMany(keys) {
        return keys.map(k => this._getNow(k));
    }

    async get(key) {
        return this._getNow(key);
    }

    async keys(prefix) {
        const out = [];
        const start = this._item(prefix);
        for (let i = 0; i < this.storage.length; i++) {
            const item = this.storage.key(i);
            if (item && item.startsWith(start) && !item.includes('#')) {
                out.push(item.slice(LOCAL_PREFIX.length));
            }
        }
        return out;
    }

    async write(puts = [], deletes = []) {
        this._writeNow(puts, deletes);
    }

    async update(key, fn) {
        // One JS turn from the read to the last write: nothing else in this window runs between.
        const r = fn(this._getNow(key));
        this._writeNow([[key, r.value], ...(r.puts || [])], r.deletes || []);
    }

    _writeNow(puts, deletes) {
        const before = [];
        const seen = new Set();
        const remember = item => {
            if (!seen.has(item)) {
                seen.add(item);
                before.push([item, this.storage.getItem(item)]);
            }
        };
        const set = (item, value) => {
            remember(item);
            this.storage.setItem(item, value);
        };
        const remove = item => {
            remember(item);
            this.storage.removeItem(item);
        };
        try {
            for (const [key, value] of puts) {
                const item = this._item(key);
                const old = this._pieceCount(key);
                const n = Math.max(1, Math.ceil(value.length / LOCAL_PIECE_CHARS));
                for (let i = 0; i < n; i++) {
                    set(`${item}#${i}`, value.slice(i * LOCAL_PIECE_CHARS, (i + 1) * LOCAL_PIECE_CHARS));
                }
                for (let i = n; i < old; i++) {
                    remove(`${item}#${i}`);
                }
                set(item, String(n));
            }
            for (const key of deletes) {
                const item = this._item(key);
                const old = this._pieceCount(key);
                for (let i = 0; i < old; i++) {
                    remove(`${item}#${i}`);
                }
                if (this.storage.getItem(item) != null) {
                    remove(item);
                }
            }
        } catch(e) {
            // Newest first, so what was removed goes back only after what was added has gone.
            for (const [item, value] of before.reverse()) {
                try {
                    if (value == null) {
                        this.storage.removeItem(item);
                    } else {
                        this.storage.setItem(item, value);
                    }
                } catch(e2) {
                    // Putting back a value that was there a moment ago only fails if something
                    // else filled the pool in between; nothing more can be done.
                }
            }
            throw e;
        } finally {
            if (before.length && this.onWrite) {
                this.onWrite();
            }
        }
    }
}


/* A Storage in memory, for the tests and as a last resort when localStorage throws. */
export class MemoryStorage {
    constructor() {
        this.map = new Map();
        this.limit = Infinity;
    }

    get length() {
        return this.map.size;
    }

    key(i) {
        return Array.from(this.map.keys())[i] ?? null;
    }

    _size() {
        let n = 0;
        for (const [k, v] of this.map) {
            n += k.length + v.length;
        }
        return n;
    }

    getItem(key) {
        return this.map.has(key) ? this.map.get(key) : null;
    }

    setItem(key, value) {
        const prev = this.map.get(key);
        this.map.set(key, String(value));
        if (this._size() > this.limit) {
            if (prev === undefined) {
                this.map.delete(key);
            } else {
                this.map.set(key, prev);
            }
            const e = new Error('QuotaExceededError');
            e.name = 'QuotaExceededError';
            throw e;
        }
    }

    removeItem(key) {
        this.map.delete(key);
    }
}


/*
 * The settings, in localStorage under KEY_SETTINGS, written directly so no window id goes in front
 * of the key. Until the rider first changes one, the settings an earlier version kept under
 * LEGACY_KEY_SETTINGS are read as they are; that key is never written or removed (see the top).
 */
export class LocalSettings {
    constructor(storage, {onWrite = null} = {}) {
        this.storage = storage;
        this.onWrite = onWrite;
    }

    get(key, def) {
        let raw = this.storage.getItem(key);
        if (raw == null && key === KEY_SETTINGS) {
            raw = this.storage.getItem(LEGACY_KEY_SETTINGS);
        }
        return raw == null ? def : JSON.parse(raw);
    }

    set(key, value) {
        this.storage.setItem(key, JSON.stringify(value));
        if (this.onWrite) {
            this.onWrite();
        }
    }
}


/*
 * The keys this mod wrote before, read as the exact text that was stored. `storage` is
 * localStorage itself: those keys start with "/", which Common.storage stores as they are
 * (pages/src/common.mjs:103, :122), so reading them directly reads the same thing.
 */
export class LegacyStorage {
    constructor(storage, {onWrite = null} = {}) {
        this.storage = storage;
        this.onWrite = onWrite;
    }

    getRaw(key) {
        return this.storage.getItem(key);
    }

    /* Removes every key given, back to back, and asks for one flush. */
    deleteAll(keys) {
        let n = 0;
        for (const key of keys) {
            if (this.storage.getItem(key) != null) {
                this.storage.removeItem(key);
                n++;
            }
        }
        if (n && this.onWrite) {
            this.onWrite();
        }
        return n;
    }
}


/* ------------------------------------------------------------------ the store */

export class Store {
    /*
     * kv          where recordings and the crash snapshot live: an IndexedDBKV, or a
     *             LocalStorageKV when IndexedDB is not usable (see openStore)
     * settings    {get(key), set(key, value)} for the small settings: a LocalSettings in Sauce
     * budgets     {perRace, total, warnAt} in bytes of JSON
     */
    constructor(kv, settings, budgets = LOCAL_BUDGETS, {now = () => Date.now()} = {}) {
        this.kv = kv;
        this.settingsAdapter = settings;
        this.perRaceBudget = budgets.perRace ?? LOCAL_BUDGETS.perRace;
        this.totalBudget = budgets.total ?? DEFAULT_TOTAL_BUDGET;
        this.warnAt = budgets.warnAt ?? DEFAULT_WARN_AT;
        this.budgetSource = budgets.source || 'fixed';
        this.now = now;
        this.fallbackReason = null;
        this.indexedDBFailed = false;
        this.migration = null;
        this.indexRebuilt = false;
        this.writeErrors = 0;
        this.lastWriteError = null;
        // Tells this start's copies apart from an earlier start's (see MOVING OLD RACES IN).
        this.session = `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        this._index = [];
        this._chain = Promise.resolve();
        this._live = null;
        this._liveGen = 0;
        this._removed = new Set();
        this._drops = [];
    }

    /* 'indexeddb', 'localstorage' or 'memory'. Written into every race saved as storedIn. */
    get kind() {
        return this.kv.kind;
    }

    /*
     * Every read and write goes through one queue, so the index is never rewritten from a stale
     * copy and a snapshot's chunks land in the order they were taken.
     */
    _serial(fn) {
        const run = this._chain.then(fn, fn);
        this._chain = run.catch(() => undefined);
        return run;
    }

    _noteWriteError(e) {
        this.writeErrors++;
        this.lastWriteError = e;
    }

    async init() {
        try {
            await this._serial(() => this._readIndex());
        } catch(e) {
            // Nothing can be listed, but nothing is overwritten either: every change reads the
            // index again first and fails if it still cannot.
            this._index = [];
            this._noteWriteError(e);
        }
        return this;
    }

    /*
     * Read again before every change, not only at startup. A store that cannot be read throws,
     * so a change is refused rather than written over a list it never saw. An index that is
     * missing while races are stored, or that does not parse (a localStorage write cut off by the
     * process being killed), is rebuilt from the races themselves, so no race drops out of the
     * list because of it.
     */
    async _readIndex() {
        const raw = await this.kv.get(K_INDEX);
        let idx = null;
        try {
            idx = raw != null ? parseList(raw) : null;
        } catch(e) {
            idx = null;
        }
        if (!idx && (raw != null || (await this.kv.keys(RACE_PREFIX)).length)) {
            idx = await this._rebuildIndex();
        }
        this._index = idx || [];
        return this._index;
    }

    async _rebuildIndex() {
        const idx = [];
        for (const key of await this.kv.keys(RACE_PREFIX)) {
            const raw = await this.kv.get(key);
            try {
                const entry = summarize(JSON.parse(raw));
                entry.bytes = raw.length;
                idx.push(entry);
            } catch(e) {
                // A race that does not parse cannot be opened from the list either.
            }
        }
        await this.kv.write([[K_INDEX, JSON.stringify(idx)]]);
        this.indexRebuilt = true;
        return idx;
    }

    settings() {
        let s;
        try {
            s = this.settingsAdapter.get(KEY_SETTINGS);
        } catch(e) {
            s = null;
        }
        return {...DEFAULT_SETTINGS, ...(s || {})};
    }

    setSetting(key, value) {
        const s = this.settings();
        s[key] = value;
        try {
            this.settingsAdapter.set(KEY_SETTINGS, s);
        } catch(e) {
            // A full pool must not stop a checkbox working for the rest of the session.
        }
        return s;
    }

    /* The saved races, as last read or written. Synchronous, so the list can draw at once. */
    index() {
        return this._index.slice();
    }

    list() {
        return this.index().sort((a, b) =>
            String(b.startedISO || '').localeCompare(String(a.startedISO || '')));
    }

    totalBytes() {
        return this._index.reduce((acc, x) => acc + (x.bytes || 0), 0);
    }

    _noRoomError() {
        return this.kind === 'indexeddb' ?
            'There was no room to save this race on this computer. Download this race to a file, ' +
            'then delete older races here and try again.' :
            'There was no room to save this race. Sauce keeps mod storage in one shared pool. ' +
            'Download this race to a file, then delete older races here and try again.';
    }

    /*
     * Returns {ok: true, entry, json} or {ok: false, error, json, entry} so the caller can still
     * offer the user a download of a recording that would not fit.
     *
     * With dropSnapshot, the race's crash snapshot is removed in the same write, so it goes only
     * if the race is stored, and IndexedDB is never asked to hold the snapshot a moment after the
     * race has been written. A snapshot a pending or unsaved slot still offers is left for that.
     */
    save(rec, {dropSnapshot = false} = {}) {
        let json;
        let entry;
        try {
            const stored = {...rec, storedIn: this.kind};
            json = JSON.stringify(stored);
            entry = summarize(stored);
            entry.bytes = json.length;
        } catch(e) {
            return Promise.resolve({ok: false, error: `Could not serialize the recording: ${e.message}`});
        }
        if (this.kind === 'indexeddb' && json.length > this.perRaceBudget) {
            // In localStorage the size ladder is what keeps a race near its cap and the pool's own
            // quota is the hard limit, as it always was. In IndexedDB there is no ladder, so this is.
            return Promise.resolve({ok: false, error: this._noRoomError(), json, entry});
        }
        return this._serial(async () => {
            let idx;
            try {
                await this._readIndex();
                const deletes = dropSnapshot ? await this._snapshotDeletes(rec.id) : [];
                await this.kv.update(K_INDEX, raw => {
                    idx = parseList(raw).filter(x => x.id !== entry.id);
                    idx.push(entry);
                    return {value: JSON.stringify(idx), puts: [[kRace(rec.id), json]], deletes};
                });
            } catch(e) {
                this._noteWriteError(e);
                return {ok: false, error: this._noRoomError(), json, entry};
            }
            this._index = idx;
            this._removed.delete(rec.id);
            if (dropSnapshot && this._live && this._live.id === rec.id) {
                this._live = null;
            }
            const total = this.totalBytes();
            return {
                ok: true,
                entry,
                json,
                overBudget: total > this.totalBudget,
                nearBudget: total > this.warnAt,
            };
        });
    }

    /* The race exactly as stored, as JSON text, which is what a download wants. */
    loadRaw(id) {
        return this._serial(async () => {
            try {
                return (await this.kv.get(kRace(id))) ?? null;
            } catch(e) {
                return null;
            }
        });
    }

    async load(id) {
        const raw = await this.loadRaw(id);
        try {
            return raw ? JSON.parse(raw) : null;
        } catch(e) {
            return null;
        }
    }

    remove(id) {
        this._removed.add(id);
        return this._serial(async () => {
            let idx;
            try {
                await this._readIndex();
                await this.kv.update(K_INDEX, raw => {
                    idx = parseList(raw).filter(x => x.id !== id);
                    return {value: JSON.stringify(idx), deletes: [kRace(id)]};
                });
            } catch(e) {
                this._noteWriteError(e);
                return false;
            }
            this._index = idx;
            return true;
        });
    }

    /*
     * Whether the rider deleted this race in this session. A race deleted during the extra time
     * after the line must not come back when the extra time ends (onFinalized in ui.mjs).
     */
    wasRemoved(id) {
        return this._removed.has(id);
    }

    removeAll() {
        this._live = null;
        for (const x of this._index) {
            this._removed.add(x.id);
        }
        return this._serial(async () => {
            try {
                const deletes = [K_LIVE, K_PENDING, K_UNSAVED, ...await this.kv.keys(RACE_PREFIX),
                                 ...await this.kv.keys(SNAP_PREFIX)];
                await this.kv.write([[K_INDEX, '[]']], deletes);
                this._index = [];
            } catch(e) {
                this._noteWriteError(e);
                return false;
            }
            return true;
        });
    }

    // ------------------------------------------------------------------ the crash snapshot

    async _pointer(slot) {
        try {
            const raw = await this.kv.get(slot);
            const p = raw ? JSON.parse(raw) : null;
            return p && p.id != null ? p.id : null;
        } catch(e) {
            return null;
        }
    }

    async _unsavedIds() {
        try {
            return parseList(await this.kv.get(K_UNSAVED));
        } catch(e) {
            return [];
        }
    }

    /* The ids of every snapshot a slot still offers. */
    async _snapshotRefs() {
        const refs = new Set(await this._unsavedIds());
        for (const slot of [K_LIVE, K_PENDING]) {
            const id = await this._pointer(slot);
            if (id != null) {
                refs.add(id);
            }
        }
        return refs;
    }

    /* Every key a stored snapshot occupies. */
    async _snapshotKeys(id) {
        const keys = [kSnapHead(id)];
        try {
            const raw = await this.kv.get(kSnapHead(id));
            const head = raw ? JSON.parse(raw) : null;
            const meta = head && head[ROWS_KEY];
            for (let i = 0; i < (meta ? meta.chunks : 0); i++) {
                keys.push(kSnapRows(id, i));
            }
            for (let i = 0; i < (meta && meta.riderChunks || 0); i++) {
                keys.push(kSnapRiders(id, i));
            }
        } catch(e) {
            // A head that cannot be read has no chunks anybody can find either.
        }
        return keys;
    }

    /* What removing the snapshot of a race that has just been saved deletes. */
    async _snapshotDeletes(id) {
        const deletes = [];
        if ((await this._pointer(K_LIVE)) === id) {
            deletes.push(K_LIVE);
        }
        if ((await this._pointer(K_PENDING)) !== id && !(await this._unsavedIds()).includes(id)) {
            deletes.push(...await this._snapshotKeys(id));
        }
        return deletes;
    }

    async _readSnapshot(id) {
        try {
            const raw = await this.kv.get(kSnapHead(id));
            if (!raw) {
                return null;
            }
            const head = JSON.parse(raw);
            const meta = head[ROWS_KEY];
            if (!meta) {
                return head;
            }
            const keys = [];
            for (let i = 0; i < meta.chunks; i++) {
                keys.push(kSnapRows(id, i));
            }
            const riderCount = meta.riderChunks || 0;
            for (let i = 0; i < riderCount; i++) {
                keys.push(kSnapRiders(id, i));
            }
            const parts = (await this.kv.getMany(keys)).map(x => (x != null ? JSON.parse(x) : null));
            // joinSnapshot throws if a chunk is missing or a series is short: a second window, or
            // a write cut off, and the rider is not offered a race with a hole in it.
            return joinSnapshot(head, parts.slice(0, meta.chunks), parts.slice(meta.chunks));
        } catch(e) {
            return null;
        }
    }

    /*
     * Decides, synchronously and at the moment it is called, what this save writes: the rows
     * added and riders changed since the last save as the next chunk, or everything as chunk 0
     * when this is a new recording, the recorder has rewritten rows (rowsEpoch), or the last row
     * written of any series is not what it was. The rows are copied now, so rows the recorder
     * adds before the write lands go in the next chunk rather than being missed or written twice.
     */
    _planLive(snap, rowsEpoch) {
        const {rows} = splitSnapshot(snap);
        let w = this._live;
        const fresh = !w || w.id !== snap.id || w.epoch !== rowsEpoch ||
            (isPlainObject(snap.riders) !== !!w.riders) ||
            w.paths.some(p => !rows[p]) ||
            Object.entries(rows).some(([p, arr]) => {
                const n = w.counts[p] || 0;
                return arr.length < n || tailOf(arr, n) !== (w.tails[p] ?? null);
            });
        if (fresh) {
            w = this._live = {id: snap.id, epoch: rowsEpoch, gen: ++this._liveGen};
        }
        const plan = planChunk(snap, fresh ? null : w, this.now());
        Object.assign(w, plan.state);
        return {
            writer: w,
            gen: w.gen,
            id: snap.id,
            fresh,
            chunkIndex: plan.chunkIndex,
            rowsJson: plan.chunk ? JSON.stringify(plan.chunk) : null,
            ridersIndex: plan.ridersIndex,
            ridersJson: plan.ridersChunk ? JSON.stringify(plan.ridersChunk) : null,
            riderDrops: plan.riderDrops,
            headJson: JSON.stringify(plan.head),
        };
    }

    /*
     * Writes the crash snapshot. See THE CRASH SNAPSHOT at the top. rowsEpoch is the recorder's,
     * which changes whenever rows already written are rewritten. Resolves true once it is on disk.
     * A save that fails is counted in writeErrors, which ui.mjs reports once.
     */
    saveLive(snapshot, {rowsEpoch = null} = {}) {
        if (!snapshot || snapshot.id == null) {
            return Promise.resolve(false);
        }
        let plan;
        try {
            plan = this._planLive(snapshot, rowsEpoch);
        } catch(e) {
            this._live = null;
            return Promise.resolve(false);
        }
        return this._serial(async () => {
            if (this._live !== plan.writer || plan.writer.gen !== plan.gen) {
                // Cleared, or started again, since this was planned: a later save covers it.
                return false;
            }
            try {
                const puts = [[kSnapHead(plan.id), plan.headJson],
                              [K_LIVE, JSON.stringify({id: plan.id})]];
                if (plan.ridersJson != null) {
                    puts.unshift([kSnapRiders(plan.id, plan.ridersIndex), plan.ridersJson]);
                }
                if (plan.rowsJson != null) {
                    puts.unshift([kSnapRows(plan.id, plan.chunkIndex), plan.rowsJson]);
                }
                const deletes = plan.riderDrops.map(i => kSnapRiders(plan.id, i));
                if (plan.fresh) {
                    // Chunks left by an earlier start of this same snapshot. Another recording's
                    // snapshot is never touched here: it may be a second window's, still being
                    // written. One nothing points at any more is removed at a later startup
                    // (collectSnapshots).
                    for (const k of await this._snapshotKeys(plan.id)) {
                        if (!puts.some(x => x[0] === k)) {
                            deletes.push(k);
                        }
                    }
                }
                await this.kv.write(puts, deletes);
                return true;
            } catch(e) {
                this._noteWriteError(e);
                if (this._live === plan.writer) {
                    // Nobody knows which chunks made it, so the next save writes them all again.
                    this._live = null;
                }
                return false;
            }
        });
    }

    loadLive() {
        return this._serial(async () => {
            const id = await this._pointer(K_LIVE);
            return id != null ? this._readSnapshot(id) : null;
        });
    }

    /*
     * With `onlyId`, the snapshot of that recording, and the live slot only when it still holds
     * that recording: a race saved after awaits must not clear the snapshot of a new recording that
     * started in the meantime.
     */
    clearLive(onlyId = null) {
        if (onlyId == null || (this._live && this._live.id === onlyId)) {
            this._live = null;
        }
        return this._serial(async () => {
            const liveId = await this._pointer(K_LIVE);
            const id = onlyId ?? liveId;
            if (id == null) {
                return;
            }
            const deletes = liveId === id ? [K_LIVE] : [];
            if ((await this._pointer(K_PENDING)) !== id && !(await this._unsavedIds()).includes(id)) {
                deletes.push(...await this._snapshotKeys(id));
            }
            try {
                await this.kv.write([], deletes);
            } catch(e) {
                // Left for the next start to offer, which is the safe way to fail.
                this._noteWriteError(e);
            }
        });
    }

    /*
     * For a finished race whose save failed: its snapshot moves out of the live slot into the
     * unsaved list, so the next recording cannot take its place and the next start offers it.
     */
    keepUnsaved(id) {
        if (this._live && this._live.id === id) {
            this._live = null;
        }
        return this._serial(async () => {
            try {
                if ((await this._pointer(K_PENDING)) === id) {
                    return;
                }
                const unsaved = (await this._unsavedIds()).filter(x => x !== id);
                unsaved.push(id);
                const deletes = (await this._pointer(K_LIVE)) === id ? [K_LIVE] : [];
                await this.kv.write([[K_UNSAVED, JSON.stringify(unsaved)]], deletes);
            } catch(e) {
                this._noteWriteError(e);
            }
        });
    }

    /*
     * Moves whatever the last session left behind out of the live slot and into the pending slot,
     * at startup, before anything can record again.
     *
     * Without this, Sauce restarting mid race leaves the rider with two half recordings that
     * fight: the window offers the interrupted one while the recorder, seeing a race still in
     * progress, immediately starts a new one and overwrites the live slot under it. Keeping them
     * in separate slots means the rider can save the first half and keep recording the second.
     * Only the pointers move; the snapshot's chunks stay where they are. A snapshot already in the
     * pending slot that was never answered goes to the unsaved list rather than being deleted, and
     * when the pending slot is empty the first unsaved snapshot is offered.
     */
    takePending() {
        return this._serial(async () => {
            const liveId = await this._pointer(K_LIVE);
            const live = liveId != null ? await this._readSnapshot(liveId) : null;
            let pendingId = await this._pointer(K_PENDING);
            let unsaved = await this._unsavedIds();
            if (live && live.inProgress) {
                if (pendingId != null && pendingId !== liveId) {
                    unsaved = [pendingId, ...unsaved.filter(x => x !== pendingId)];
                }
                unsaved = unsaved.filter(x => x !== liveId);
                try {
                    await this.kv.write([[K_PENDING, JSON.stringify({id: liveId})],
                                         [K_UNSAVED, JSON.stringify(unsaved)]], [K_LIVE]);
                } catch(e) {
                    // If it will not move, the live copy is still there to offer.
                    this._noteWriteError(e);
                    return live;
                }
                if (this._live && this._live.id === liveId) {
                    this._live = null;
                }
                return live;
            }
            if (pendingId == null && unsaved.length) {
                pendingId = unsaved[0];
                try {
                    await this.kv.write([[K_PENDING, JSON.stringify({id: pendingId})],
                                         [K_UNSAVED, JSON.stringify(unsaved.slice(1))]]);
                } catch(e) {
                    this._noteWriteError(e);
                }
            }
            return pendingId != null ? this._readSnapshot(pendingId) : null;
        });
    }

    loadPending() {
        return this._serial(async () => {
            const id = await this._pointer(K_PENDING);
            return id != null ? this._readSnapshot(id) : null;
        });
    }

    clearPending() {
        return this._serial(async () => {
            const id = await this._pointer(K_PENDING);
            if (id == null) {
                return;
            }
            const liveId = await this._pointer(K_LIVE);
            const deletes = [K_PENDING];
            if (id !== liveId && !(await this._unsavedIds()).includes(id)) {
                deletes.push(...await this._snapshotKeys(id));
            }
            try {
                await this.kv.write([], deletes);
            } catch(e) {
                this._noteWriteError(e);
            }
        });
    }

    /*
     * A whole snapshot into a slot in one go, as chunk 0. Used to move an old one in. A slot that
     * already holds another snapshot is not overwritten: this one goes to the unsaved list.
     */
    async _putSnapshot(slot, snap) {
        const {head, chunk, ridersChunk} = planChunk(snap, null, this.now());
        const puts = [[kSnapRows(snap.id, 0), JSON.stringify(chunk)],
                      [kSnapHead(snap.id), JSON.stringify(head)]];
        if (ridersChunk) {
            puts.push([kSnapRiders(snap.id, 0), JSON.stringify(ridersChunk)]);
        }
        const deletes = (await this._snapshotKeys(snap.id)).filter(k => !puts.some(x => x[0] === k));
        const held = slot === K_UNSAVED ? null : await this._pointer(slot);
        if (slot !== K_UNSAVED && (held == null || held === snap.id)) {
            puts.push([slot, JSON.stringify({id: snap.id})]);
        } else {
            const unsaved = (await this._unsavedIds()).filter(x => x !== snap.id);
            unsaved.push(snap.id);
            puts.push([K_UNSAVED, JSON.stringify(unsaved)]);
        }
        await this.kv.write(puts, deletes);
    }

    /*
     * Removes, at startup, snapshots no slot points at that nothing has saved to for
     * STALE_SNAPSHOT_MS. Returns how many.
     */
    collectSnapshots() {
        return this._serial(async () => {
            const refs = await this._snapshotRefs();
            const byId = new Map();
            for (const key of await this.kv.keys(SNAP_PREFIX)) {
                const id = key.slice(SNAP_PREFIX.length).replace(/\/(head|rows\/\d+|riders\/\d+)$/, '');
                if (!byId.has(id)) {
                    byId.set(id, []);
                }
                byId.get(id).push(key);
            }
            const deletes = [];
            let n = 0;
            for (const [id, keys] of byId) {
                if (refs.has(id)) {
                    continue;
                }
                let at = null;
                try {
                    const head = JSON.parse(await this.kv.get(kSnapHead(id)));
                    at = head && head[ROWS_KEY] ? head[ROWS_KEY].at : null;
                } catch(e) {
                    at = null;
                }
                if (!isNum(at) || this.now() - at > STALE_SNAPSHOT_MS) {
                    deletes.push(...keys);
                    n++;
                }
            }
            if (deletes.length) {
                await this.kv.write([], deletes);
            }
            return n;
        });
    }

    // ------------------------------------------------------------------ moving old races in

    /*
     * MOVING OLD RACES IN. At startup, races and crash snapshots kept anywhere this mod kept them
     * before are copied into this store: from the "/" keys an earlier version used (LegacySource),
     * and, when this store is IndexedDB, from the localStorage fallback a start that could not open
     * IndexedDB used (LocalSource). Otherwise a race saved while the fallback was in use would drop
     * out of the list the next time IndexedDB opened.
     *
     * Nothing is lost on the way. Each race is written here and read back, and counts as copied
     * only when what came back is character for character the old text plus the storedIn field.
     * A copy that does not read back is removed again, and the old one tried on the next start. A
     * race already here is never overwritten: it may be newer (official results fetched).
     *
     * The old copy is NOT removed in the same start. Each copy is recorded under K_MOVED with this
     * start's session, and the old copy is removed only by a later start that still finds that
     * record, which is the proof the copy survived Sauce closing (a write and a read in the same
     * session cannot tell a store kept on disk from one that is not). A race the rider deleted in
     * between is then not brought back either. The removals themselves wait for dropMovedCopies,
     * which ui.mjs calls when no race is recording, because removing a "/" key reloads Sauce's
     * overlays once.
     */
    async migrateFrom(source, report = {moved: 0, kept: 0, snapshots: 0, waiting: 0}) {
        if (!source) {
            return report;
        }
        const moved = await this._movedEntries();
        const find = (kind, id) => moved.find(x =>
            x.from === source.name && x.kind === kind && x.id === id);
        const drops = {races: [], snapshots: []};
        const added = [];
        for (const {id, raw} of await source.races()) {
            if (raw == null) {
                continue;
            }
            const earlier = find('race', id);
            if (earlier) {
                if (earlier.session !== this.session) {
                    drops.races.push(id);
                }
                continue;
            }
            let copied = false;
            try {
                const old = JSON.parse(raw);
                const canonical = JSON.stringify(old);
                if ((await this.loadRaw(id)) != null) {
                    // Already here, from an earlier copy or saved here since: never overwritten.
                    copied = true;
                } else {
                    const res = await this.save(old);
                    copied = res.ok && sameRecording(await this.loadRaw(id), canonical);
                    if (res.ok && !copied) {
                        await this._forget(id);
                    }
                }
            } catch(e) {
                copied = false;
            }
            if (copied) {
                added.push({from: source.name, kind: 'race', id, session: this.session});
                report.moved++;
            } else {
                report.kept++;
            }
        }
        for (const {slot, id, snap, key} of await source.snapshots()) {
            const earlier = find('snapshot', id);
            if (earlier) {
                if (earlier.session !== this.session) {
                    drops.snapshots.push({id, key});
                }
                continue;
            }
            let copied = false;
            try {
                const canonical = JSON.stringify(snap);
                if ((await this._serial(() => this._snapshotRefs())).has(id) &&
                    await this._serial(() => this._readSnapshot(id))) {
                    copied = true;
                } else {
                    await this._serial(() => this._putSnapshot(slot, snap));
                    const back = await this._serial(() => this._readSnapshot(id));
                    copied = !!back && JSON.stringify(back) === canonical;
                }
            } catch(e) {
                copied = false;
            }
            if (copied) {
                added.push({from: source.name, kind: 'snapshot', id, session: this.session});
                report.snapshots++;
            }
        }
        if (added.length) {
            try {
                await this._serial(() => this.kv.update(K_MOVED, raw => ({
                    value: JSON.stringify([...readMoved(raw), ...added]),
                })));
            } catch(e) {
                // Without the record the old copies simply stay, and the next start records them.
                this._noteWriteError(e);
            }
        }
        if (drops.races.length || drops.snapshots.length) {
            this._drops.push({source, drops});
            report.waiting += drops.races.length + drops.snapshots.length;
        }
        return report;
    }

    /* A race's copy that did not read back, taken out again without marking it deleted. */
    _forget(id) {
        return this._serial(async () => {
            await this.kv.update(K_INDEX, raw => ({
                value: JSON.stringify(parseList(raw).filter(x => x.id !== id)),
                deletes: [kRace(id)],
            }));
            this._index = this._index.filter(x => x.id !== id);
        });
    }

    async _movedEntries() {
        try {
            return readMoved(await this._serial(() => this.kv.get(K_MOVED)));
        } catch(e) {
            return [];
        }
    }

    /*
     * Removes the old copies a later start has confirmed (see MOVING OLD RACES IN), and their
     * entries from the record. Returns how many were removed.
     */
    async dropMovedCopies() {
        const drops = this._drops;
        this._drops = [];
        const done = [];
        for (const {source, drops: d} of drops) {
            try {
                await source.drop(d);
                for (const id of d.races) {
                    done.push([source.name, 'race', id]);
                }
                for (const s of d.snapshots) {
                    done.push([source.name, 'snapshot', s.id]);
                }
            } catch(e) {
                // Left where they are; the next start confirms them again.
            }
        }
        if (done.length) {
            const gone = new Set(done.map(x => x.join('\n')));
            try {
                await this._serial(() => this.kv.update(K_MOVED, raw => ({
                    value: JSON.stringify(readMoved(raw).filter(x =>
                        !gone.has([x.from, x.kind, x.id].join('\n')))),
                })));
            } catch(e) {
                this._noteWriteError(e);
            }
        }
        return done.length;
    }
}


function readMoved(raw) {
    try {
        return parseList(raw);
    } catch(e) {
        return [];
    }
}


/*
 * What was read back is the old recording with this store's storedIn, and nothing else. A race
 * from the fallback already says storedIn "localstorage"; that one field is allowed to differ.
 */
function sameRecording(backRaw, canonical) {
    if (backRaw == null) {
        return false;
    }
    const back = JSON.parse(backRaw);
    const old = JSON.parse(canonical);
    if (!('storedIn' in old)) {
        delete back.storedIn;
    } else {
        back.storedIn = old.storedIn;
    }
    return JSON.stringify(back) === canonical;
}


/*
 * The races and snapshots an earlier version kept whole under "/" keys, through Common.storage.
 * Removing them never rewrites the old index, because every write to a "/" key reloads Sauce's
 * overlays: it goes with the last race it lists.
 */
export class LegacySource {
    constructor(legacy) {
        this.legacy = legacy;
        this.name = 'legacy';
    }

    _index() {
        try {
            const idx = JSON.parse(this.legacy.getRaw(KEY_INDEX));
            return Array.isArray(idx) ? idx : [];
        } catch(e) {
            return [];
        }
    }

    async races() {
        const out = [];
        for (const entry of this._index()) {
            const id = entry && entry.id;
            if (id != null) {
                out.push({id, raw: this.legacy.getRaw(keyForRecording(id))});
            }
        }
        return out;
    }

    async snapshots() {
        const out = [];
        // Pending first, then live, in the slots they had.
        for (const [key, slot] of [[KEY_PENDING, K_PENDING], [KEY_LIVE, K_LIVE]]) {
            try {
                const snap = JSON.parse(this.legacy.getRaw(key));
                if (snap && snap.id != null) {
                    out.push({slot, id: snap.id, snap, key});
                }
            } catch(e) {
                // Nothing readable there.
            }
        }
        return out;
    }

    async drop({races, snapshots}) {
        const keys = [...races.map(keyForRecording), ...snapshots.map(x => x.key)];
        const going = new Set(keys);
        if (this._index().every(x => !x || x.id == null || going.has(keyForRecording(x.id)) ||
                                     this.legacy.getRaw(keyForRecording(x.id)) == null)) {
            keys.push(KEY_INDEX);
        }
        this.legacy.deleteAll(keys);
    }
}


/* What a start that could not open IndexedDB kept in the localStorage fallback. */
export class LocalSource {
    constructor(kv) {
        this.kv = kv;
        this.store = new Store(kv, new MemoryAdapter(), LOCAL_BUDGETS);
        this.name = 'local';
    }

    async races() {
        const ids = new Set();
        try {
            for (const x of await this.store._readIndex()) {
                ids.add(x.id);
            }
        } catch(e) {
            // The race keys below still find them.
        }
        for (const key of await this.kv.keys(RACE_PREFIX)) {
            ids.add(key.slice(RACE_PREFIX.length));
        }
        const out = [];
        for (const id of ids) {
            out.push({id, raw: (await this.kv.get(kRace(id))) ?? null});
        }
        return out;
    }

    async snapshots() {
        const out = [];
        const slots = [[K_PENDING, await this.store._pointer(K_PENDING)],
                       [K_LIVE, await this.store._pointer(K_LIVE)],
                       ...(await this.store._unsavedIds()).map(id => [K_UNSAVED, id])];
        for (const [slot, id] of slots) {
            if (id == null) {
                continue;
            }
            const snap = await this.store._readSnapshot(id);
            if (snap) {
                out.push({slot, id, snap, key: null});
            }
        }
        return out;
    }

    async drop({races, snapshots}) {
        const raceIds = new Set(races);
        const snapIds = new Set(snapshots.map(x => x.id));
        const deletes = races.map(kRace);
        for (const id of snapIds) {
            deletes.push(...await this.store._snapshotKeys(id));
        }
        const puts = [];
        const idx = (await this.store._readIndex()).filter(x => !raceIds.has(x.id));
        const live = await this.store._pointer(K_LIVE);
        const pending = await this.store._pointer(K_PENDING);
        const unsaved = (await this.store._unsavedIds()).filter(x => !snapIds.has(x));
        for (const [slot, id] of [[K_LIVE, live], [K_PENDING, pending]]) {
            if (id != null && snapIds.has(id)) {
                deletes.push(slot);
            }
        }
        const left = (await this.kv.keys(RACE_PREFIX)).filter(k => !deletes.includes(k)).length +
            (await this.kv.keys(SNAP_PREFIX)).filter(k => !deletes.includes(k)).length;
        if (!idx.length && !left) {
            // Nothing is left in the fallback, so neither is its list or its own record.
            deletes.push(K_INDEX, K_UNSAVED, K_MOVED);
        } else {
            puts.push([K_INDEX, JSON.stringify(idx)], [K_UNSAVED, JSON.stringify(unsaved)]);
        }
        await this.kv.write(puts, deletes);
    }
}


/*
 * Opens the store the way ui.mjs uses it: IndexedDB when it is there and proves itself with a
 * write, a read and a delete (tried twice), and localStorage under keys Sauce ignores when it is
 * not; then the index is read, anything kept elsewhere before is copied in (MOVING OLD RACES IN),
 * and snapshots nothing points at any more are cleared away.
 *
 *   indexedDB     window.indexedDB, or null
 *   localStorage  window.localStorage, or null (then an in-memory store, which keeps nothing)
 *   settings      a LocalSettings, for the settings only
 *   legacy        a LegacyStorage over localStorage, to move old races from
 *   estimate      what navigator.storage.estimate() returned, or null
 *   onLocalWrite  called after every localStorage write, to schedule Sauce's flush
 */
export async function openStore({indexedDB = null, localStorage = null, settings = null,
                                 legacy = null, estimate = null, onLocalWrite = null,
                                 openTimeoutMs = DB_OPEN_TIMEOUT_MS,
                                 retryTimeoutMs = DB_OPEN_RETRY_TIMEOUT_MS,
                                 now = () => Date.now()} = {}) {
    let kv = null;
    let why = indexedDB ? null : 'IndexedDB is not available in this window';
    if (indexedDB) {
        for (const timeoutMs of [openTimeoutMs, retryTimeoutMs]) {
            try {
                kv = await new IndexedDBKV(indexedDB).open(timeoutMs);
                const probe = String(now());
                await kv.write([[K_PROBE, probe]]);
                if ((await kv.get(K_PROBE)) !== probe) {
                    throw new Error('IndexedDB did not read back what was written');
                }
                await kv.write([], [K_PROBE]);
                break;
            } catch(e) {
                why = `IndexedDB failed: ${e && e.message || e}`;
                try {
                    if (kv && kv.db) {
                        kv.db.close();
                    }
                } catch(e2) {
                    // nothing to do
                }
                kv = null;
            }
        }
    }
    if (!kv) {
        kv = localStorage ?
            new LocalStorageKV(localStorage, {onWrite: onLocalWrite}) :
            new LocalStorageKV(new MemoryStorage(), {kind: 'memory'});
    }
    const budgets = kv.kind === 'indexeddb' ? indexedDBBudgets(estimate) : LOCAL_BUDGETS;
    const store = new Store(kv, settings || new MemoryAdapter(), budgets, {now});
    store.fallbackReason = kv.kind === 'indexeddb' ? null : why;
    // IndexedDB is there but would not open: races kept in it earlier cannot be listed this time.
    store.indexedDBFailed = !!indexedDB && kv.kind !== 'indexeddb';
    await store.init();
    const report = {moved: 0, kept: 0, snapshots: 0, waiting: 0};
    try {
        if (kv.kind === 'indexeddb' && localStorage) {
            const local = new LocalStorageKV(localStorage, {onWrite: onLocalWrite});
            await store.migrateFrom(new LocalSource(local), report);
        }
        if (legacy) {
            await store.migrateFrom(new LegacySource(legacy), report);
        }
        store.migration = report;
    } catch(e) {
        store.migration = {...report, error: String(e && e.message || e)};
    }
    try {
        await store.collectSnapshots();
    } catch(e) {
        // Only tidying.
    }
    return store;
}


/* An in-memory settings adapter, used by the tests and as a last resort if localStorage is missing. */
export class MemoryAdapter {
    constructor() {
        this.map = new Map();
        this.limit = Infinity;
    }

    _size() {
        let n = 0;
        for (const v of this.map.values()) {
            n += v.length;
        }
        return n;
    }

    get(key, def) {
        if (!this.map.has(key)) {
            return def;
        }
        return JSON.parse(this.map.get(key));
    }

    set(key, value) {
        const json = JSON.stringify(value);
        const prev = this.map.get(key);
        this.map.set(key, json);
        if (this._size() > this.limit) {
            if (prev === undefined) {
                this.map.delete(key);
            } else {
                this.map.set(key, prev);
            }
            const e = new Error('QuotaExceededError');
            e.name = 'QuotaExceededError';
            throw e;
        }
    }

    delete(key) {
        this.map.delete(key);
    }
}
