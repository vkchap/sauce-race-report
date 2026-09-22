/*
 * Race Report - the facts behind the two copied texts.
 *
 * WHAT THIS FILE DOES: works out, from a finished recording, what the race commentary and the
 * coach's debrief are told (see factpack.mjs): the key moments by fixed rules, the climbs, how the
 * gaps between groups moved, the rider's finish, the powerups, the rider's hard efforts and what
 * they cost, and a summary of an earlier race. Pure logic, testable in node. It returns lines of
 * text; factpack.mjs decides which of them each style gets and in what order.
 *
 * Van, 16 Sep 2026, after reading a sample of each: "both styles are good - they would be useful
 * for different purposes - commentary to share with team mates, debrief to review with my coach".
 * The rules below are the ones those samples were built and checked on
 * (spec/report-styles/input-design.md, version 2), ported from the experiment's reference script.
 *
 * Rules this file keeps to, on top of report.mjs's:
 *   - Every moment is found by a fixed rule, never by judging what mattered, so the rules can be
 *     checked against the recording.
 *   - Other riders appear only as Sauce showed them: which group they were in, the gap to it, the
 *     name and the team tag Sauce reads out of that name, and Sauce's own average power of the
 *     rider's group. Nothing about any other rider's own effort is worked out or implied.
 *   - Group membership, and the size of every group, come from the recorder's membership log (WHO
 *     WAS IN THE OTHER GROUPS in recorder.mjs), which only holds changes that lasted, so a group
 *     that flickered never appears as a move or a size. Sauce's gaps come from the pack rows, and
 *     only from a row whose group there is the size the log says (gapAt).
 *   - No em dashes anywhere in the text.
 */

import {
    ownSeries, findSplits, bestWindow, fmtClock, fmtDuration, prettyPowerUp, afterLineFacts, REJOIN_SECONDS,
    joinedLateSecond, groupSizesFromLog, splitSizes,
} from './report.mjs';
import {MOVE_HOLD_SECONDS, SAME_SIDE_HOLD_FACTOR} from './recorder.mjs';

const isNum = x => typeof x === 'number' && isFinite(x);

// Sauce's own default W' when a profile has none (src/stats.mjs:15, :2865).
export const SAUCE_DEFAULT_W_PRIME = 20000;

// The fixed rules (spec/report-styles/input-design.md, "How key moments are found").
export const START_SECONDS = 150;
export const FINISH_SECONDS = 120;
export const MOMENT_BEFORE = 30;
export const MOMENT_AFTER = 60;
export const EFFORT_BEFORE = 20;
export const EFFORT_AFTER = 40;
export const EFFORT_FTP_SHARE = 1.1;
export const EFFORT_MIN_SECONDS = 10;
export const EFFORT_COUNT = 5;
export const MAX_MOMENTS = 8;
// Every moment gets at least this many rows, however coarse the shared budget makes them.
export const MIN_MOMENT_ROWS = 3;
// Moves of riders within this many seconds of each other, the same way, are one move.
export const MOVE_CLUSTER_SECONDS = 10;
// At most this many moves between groups become moments before merging, the biggest first.
export const MOVE_MOMENTS = 6;
export const CLIMB_MIN_GRADE = 0.03;
export const CLIMB_MIN_SECONDS = 30;
export const CLIMB_BRIDGE_SECONDS = 10;
// Riders within this much of the rider at the line are too close to call on Sauce's live gaps.
export const FINISH_CLOSE_SECONDS = 1.0;
// Races longer than this get two minute rows in the overview (and never more than OVERVIEW_ROWS).
export const OVERVIEW_TWO_MINUTES_AFTER = 40 * 60;
export const OVERVIEW_ROWS = 40;


/* ------------------------------------------------------------------ fast series */

/*
 * A time series with prefix sums, so an average over any span is a binary search rather than a
 * walk over every row. The copied texts ask for thousands of spans, and a three hour race has ten
 * thousand rows.
 */
export class Series {
    constructor(times, values) {
        this.t = times || [];
        this.v = values || [];
        const n = this.t.length;
        this.sum = new Float64Array(n + 1);
        this.cnt = new Uint32Array(n + 1);
        for (let i = 0; i < n; i++) {
            const x = this.v[i];
            const ok = isNum(x);
            this.sum[i + 1] = this.sum[i] + (ok ? x : 0);
            this.cnt[i + 1] = this.cnt[i] + (ok ? 1 : 0);
        }
    }

    /* First index with time >= t. */
    lower(t) {
        let a = 0;
        let b = this.t.length;
        while (a < b) {
            const m = (a + b) >> 1;
            if (this.t[m] < t) {
                a = m + 1;
            } else {
                b = m;
            }
        }
        return a;
    }

    /* Average over [t0, t1], or null. */
    avg(t0, t1) {
        const i = this.lower(t0);
        // Race seconds are whole, so the first row past t1 is the first at t1 + 0.5 or later.
        const j = this.lower(t1 + 0.5);
        const k = j > i ? j : i;
        const c = this.cnt[k] - this.cnt[i];
        return c ? (this.sum[k] - this.sum[i]) / c : null;
    }

    /* Highest and lowest value over [t0, t1], with the time of the lowest. */
    extremes(t0, t1) {
        let max = null;
        let min = null;
        let minT = null;
        for (let i = this.lower(t0); i < this.t.length && this.t[i] <= t1; i++) {
            const x = this.v[i];
            if (!isNum(x)) {
                continue;
            }
            if (max == null || x > max) {
                max = x;
            }
            if (min == null || x < min) {
                min = x;
                minT = this.t[i];
            }
        }
        return {max, min, minT};
    }

    /* The nearest value to t within `tolerance` seconds, or null. */
    at(t, tolerance = 3) {
        const n = this.t.length;
        if (!n) {
            return null;
        }
        const i = this.lower(t);
        let best = -1;
        let bestD = Infinity;
        for (const k of [i - 1, i]) {
            if (k >= 0 && k < n && isNum(this.v[k]) && Math.abs(this.t[k] - t) < bestD) {
                best = k;
                bestD = Math.abs(this.t[k] - t);
            }
        }
        if (best === -1 || bestD > tolerance) {
            // The nearest row may hold nothing; look a little further either way.
            for (let d = 1; d <= tolerance; d++) {
                for (const k of [i - 1 - d, i + d]) {
                    if (k >= 0 && k < n && isNum(this.v[k]) && Math.abs(this.t[k] - t) <= tolerance) {
                        return this.v[k];
                    }
                }
            }
            return null;
        }
        return this.v[best];
    }
}


/* First index of a sorted array with value >= t. */
function lowerIndex(arr, t) {
    let a = 0;
    let b = arr.length;
    while (a < b) {
        const m = (a + b) >> 1;
        if (arr[m] < t) {
            a = m + 1;
        } else {
            b = m;
        }
    }
    return a;
}


/* ------------------------------------------------------------------ formatting */

/* A gap in seconds, or in minutes and seconds once it is a minute or more. */
export function fmtGap(s) {
    const a = Math.abs(s);
    if (a < 59.95) {
        return `${a.toFixed(1)} s`;
    }
    const whole = Math.round(a);
    return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

export function listNames(names, max = 10) {
    return names.length <= max ? names.join(', ') :
        `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export const ordinal = n => ORDINALS[n - 1] ||
    `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

// A group of up to NAMES_IN_FULL riders is named in full; a bigger one by its first NAMES_IN_BRIEF.
const NAMES_IN_FULL = 15;
const NAMES_IN_BRIEF = 4;


/* ------------------------------------------------------------------ the membership log */

const PLACE_WORDS = {
    '-2': 'a group further up the road',
    '-1': 'the group ahead of yours',
    '0': 'your group',
    '1': 'the group behind yours',
    '2': 'a group further back',
    'null': 'out of Sauce\'s view',
};

export const placeWords = p => PLACE_WORDS[String(p)];

/*
 * Replays the membership log to say where every rider was at any second. Asked for seconds in
 * order it only moves forward; asked for an earlier second it starts again.
 */
export class Replay {
    constructor(moves) {
        const m = moves || {};
        const n = Array.isArray(m.t) ? m.t.length : 0;
        this.list = Array.from({length: n}, (_, i) => [m.t[i], m.rider[i], m.from[i], m.to[i]])
            .filter(x => isNum(x[0]) && isNum(x[1]))
            .sort((a, b) => a[0] - b[0]);
        // A rider's first entry is where Sauce first placed them, not a move: the fifth field.
        const seen = new Set();
        for (const x of this.list) {
            x.push(!seen.has(x[1]));
            seen.add(x[1]);
        }
        this.reset();
    }

    reset() {
        this.k = 0;
        this.now = -Infinity;
        this.places = new Map();
    }

    at(t) {
        if (t < this.now) {
            this.reset();
        }
        while (this.k < this.list.length && this.list[this.k][0] <= t) {
            const [, seq, , to] = this.list[this.k];
            if (to == null) {
                this.places.delete(seq);
            } else {
                this.places.set(seq, to);
            }
            this.k++;
        }
        this.now = t;
        return this.places;
    }

    /* The riders (seq numbers) in each place at second t. */
    groupsAt(t) {
        const out = {'-2': [], '-1': [], '0': [], '1': [], '2': []};
        for (const [seq, p] of this.at(t)) {
            out[String(p)].push(seq);
        }
        return out;
    }
}

/* Sauce's own test for "the same group" from one second to the next: Jaccard over 0.5 (src/stats.mjs:4617-4640). */
export function sameGroup(a, b) {
    if (!a || !b || !a.length || !b.length) {
        return false;
    }
    const B = new Set(b);
    let inter = 0;
    for (const x of a) {
        if (B.has(x)) {
            inter++;
        }
    }
    return inter / (a.length + b.length - inter) > 0.5;
}


/* ------------------------------------------------------------------ the context */

/*
 * Everything the two texts are built from, worked out once. `nameOfKey(key)` gives the name, or
 * the label, a rider is to appear under in this copy; `teamOfKey(key)` the team tag to show, or
 * null.
 */
export function raceContext(rec, {model, units, nameOfKey = k => k, teamOfKey = () => null} = {}) {
    const own = ownSeries(rec);
    const pack = rec.pack || {};
    const tl = rec.timeline || {};
    const ev = rec.event || {};
    const self = rec.self || {};
    const first = model.meta.firstSecond || 0;
    const line = model.meta.raceSeconds ?? first;
    const finished = rec.stopReason === 'finish';
    const al = rec.afterLine && isNum(rec.afterLine.finishRaceSecond) ? rec.afterLine : null;
    const S = {
        power: new Series(own.t, own.power),
        hr: new Series(own.t, own.hr),
        speed: new Series(own.t, own.speed),
        draft: new Series(own.t, own.draft),
        wbal: new Series(own.t, own.wbal),
        grade: new Series(own.t, own.grade),
        dist: new Series(own.t, own.eventDistance),
        alt: new Series(own.t, own.altitude || []),
    };
    // A recording made before the membership log existed has no `moves`; one ridden alone has an
    // empty log, which is not the same thing.
    const hasMoves = !!(rec.moves && Array.isArray(rec.moves.t));
    /*
     * Group sizes come from the membership log, which sees every payload and holds each change,
     * never from a pack row alone: a row is one payload in two and carries whatever flicker that
     * payload had (groupSizesFromLog in report.mjs). The gaps can only come from the rows, so a gap
     * is used only from a row whose group there is about as big as the log says (gapAt). A
     * recording with no log has only its rows, less the ones that flickered (steadyPack).
     */
    const logSizes = hasMoves ? groupSizesFromLog(rec) : null;
    const sp = logSizes ? {...pack, ...logSizes} : steadyPack(pack);
    const P = {
        size: new Series(sp.t, sp.myGroupSize),
        aheadSize: new Series(sp.t, sp.sizeAheadGroup),
        aheadGap: new Series(sp.t, sp.gapAheadGroup),
        behindSize: new Series(sp.t, sp.sizeBehindGroup),
        behindGap: new Series(sp.t, sp.gapBehindGroup),
        groupPower: new Series(sp.t, sp.groupPower),
    };
    const packStep = (rec.degraded && rec.degraded.packRowInterval) || 2;
    const bySeq = new Map();
    for (const [key, r] of Object.entries(rec.riders || {})) {
        if (isNum(r.seq)) {
            bySeq.set(r.seq, key);
        }
    }
    const ftp = isNum(self.ftp) && self.ftp > 0 ? self.ftp : null;
    // Sauce's W'bal model runs on the profile's CP, or its FTP, and W' (src/stats.mjs:2864-2868).
    const cp = isNum(self.cp) && self.cp > 0 ? self.cp : ftp;
    const cpFromFtp = !(isNum(self.cp) && self.cp > 0);
    /*
     * A recording saved before the mod kept the profile's W' does not say what W' the model ran
     * on. The model starts full and never goes above W' (src/stats.mjs:2864-2868), so the highest
     * W'bal the record holds is the best reading of it there is; the texts say that is what it is.
     * Only with no W'bal at all is Sauce's own default used, and said to be a default.
     */
    let wPrime = SAUCE_DEFAULT_W_PRIME;
    let wPrimeSource = 'default';
    const highestWbal = own.wbal.reduce((a, x) => (isNum(x) && x > a ? x : a), 0);
    if (isNum(self.wPrime) && self.wPrime > 0) {
        wPrime = self.wPrime;
        // Sauce writes its default into an athlete with no W' of their own (src/stats.mjs:2296-2297),
        // so exactly that value in the profile is Sauce's default, not a setting (Van, 17 Sep 2026).
        wPrimeSource = self.wPrime === SAUCE_DEFAULT_W_PRIME ? 'sauce-default' : 'profile';
    } else if (highestWbal >= 1000) {
        wPrime = highestWbal;
        wPrimeSource = 'highest';
    }
    const weight = isNum(self.weight) && self.weight > 0 ? self.weight : null;
    // km to go counts back from the rider's own distance counter at the line, so it is right even
    // when that counter and the listed distance disagree. A race that did not reach the line
    // counts back from the listed distance, and without one there is no "to go" at all.
    const lineDistance = finished ? S.dist.at(line, 10) : null;
    const toGoFrom = isNum(lineDistance) ? lineDistance :
        (isNum(ev.endDistance) && ev.endDistance > 0 ? ev.endDistance : null);
    const ctx = {
        rec, own, pack, tl, ev, self, model, S, P, packStep, first, line, finished,
        crossedAt: al ? al.finishRaceSecond : (finished ? line + 1 : null),
        ftp, cp, cpFromFtp, wPrime, wPrimeSource, weight, lineDistance, toGoFrom,
        hasMoves,
        // What findSplits reads (splitSizes in report.mjs).
        splitPack: logSizes || pack,
        units: units || {imperial: false},
        replay: new Replay(hasMoves ? rec.moves : null),
        nameOfKey: key => {
            const team = teamOfKey(key);
            return `${nameOfKey(key)}${team ? ` [${team}]` : ''}`;
        },
        nameOfSeq: seq => {
            const key = bySeq.get(seq);
            return key == null ? 'a rider with no record' : ctx.nameOfKey(key);
        },
        keyOfSeq: seq => bySeq.get(seq),
        joinedLate: joinedLateSecond(rec),
    };
    // The start is only a moment when the record reaches back to it (the gun, or the join).
    ctx.hasStart = first - (ctx.joinedLate ?? 0) <= 15;
    ctx.watchedFrom = isNum(rec.startedAtRaceSecond) ? Math.max(first, rec.startedAtRaceSecond) : first;
    // The pack rows a second is read from: the nearest steady row, up to three rows away.
    ctx.packNear = 3 * packStep + 1;
    // Nobody is placed until Sauce's first groups have held (MOVE_HOLD_SECONDS), so the groups at
    // an earlier second are read at the first second anybody was placed.
    ctx.placedFrom = ctx.replay.list.length ? ctx.replay.list[0][0] : null;
    // A row stands for the seconds up to the next one, so a race whose rows thinned to every five
    // seconds (the size guard in recorder.mjs) still counts kJ and seconds right.
    ctx.rowSeconds = i => (i + 1 < own.t.length ? Math.max(1, Math.min(own.t[i + 1] - own.t[i], 5)) : 1);
    return ctx;
}

/*
 * For a recording made before the membership log, whose pack rows are all there is: the rows the
 * texts read, without the ones that flickered. A row is kept when its group size,
 * and the size of the group ahead and behind, are each the median of the rows either side of it
 * (two each way). A one-payload flicker such as "your group 10, the group ahead 45 @ 0.9 s" in a
 * bunch of 55 is dropped; a real change is kept from its first row, because from there on the
 * median follows it. report.mjs's window still reads every row.
 */
export function steadyPack(pack) {
    const t = pack.t || [];
    const keys = ['myGroupSize', 'sizeAheadGroup', 'sizeBehindGroup'];
    const keep = [];
    for (let k = 0; k < t.length; k++) {
        const ok = keys.every(key => {
            const arr = pack[key] || [];
            const w = [];
            for (let i = Math.max(0, k - 2); i <= Math.min(t.length - 1, k + 2); i++) {
                w.push(isNum(arr[i]) ? arr[i] : -1);
            }
            w.sort((a, b) => a - b);
            return (isNum(arr[k]) ? arr[k] : -1) === w[w.length >> 1];
        });
        if (ok) {
            keep.push(k);
        }
    }
    const out = {};
    for (const key of ['t', ...keys, 'gapAheadGroup', 'gapBehindGroup', 'groupPower']) {
        const arr = pack[key] || [];
        out[key] = keep.map(k => arr[k] ?? null);
    }
    return out;
}

export const distNum = (ctx, m) => ctx.units.imperial ? (m / 1609.344).toFixed(2) : (m / 1000).toFixed(2);
export const distUnit = ctx => ctx.units.imperial ? 'mi' : 'km';

export function toGoAt(ctx, t) {
    const d = ctx.S.dist.at(t, 5);
    return isNum(d) && isNum(ctx.toGoFrom) ? Math.max(0, ctx.toGoFrom - d) : null;
}

export function toGoText(ctx, t) {
    const g = toGoAt(ctx, t);
    return isNum(g) ? distNum(ctx, g) : '-';
}

export function wkg(ctx, w) {
    return isNum(w) && ctx.weight ? `${(w / ctx.weight).toFixed(1)} W/kg` : null;
}

export function wbalShare(ctx, j) {
    return isNum(j) ? `${Math.round(j / ctx.wPrime * 100)}%` : '?';
}

export function pctFtp(ctx, w) {
    return isNum(w) && ctx.ftp ? `${Math.round(w / ctx.ftp * 100)} percent of FTP` : null;
}

/*
 * Sauce's gap, in seconds and positive, to the nearest group on one side at second t, taken from
 * the nearest pack row within ctx.packNear whose group there is about as big as `n`, the size the
 * membership log gives it. A row whose group there is another size is a row where Sauce's nearest
 * group was a different one, often a flicker, and its gap belongs to that group. Null when no row
 * agrees. Without a log, the nearest steady row's gap.
 */
export function gapAt(ctx, t, side, n) {
    if (!ctx.hasMoves) {
        const g = (side === 'ahead' ? ctx.P.aheadGap : ctx.P.behindGap).at(t, ctx.packNear);
        return isNum(g) ? Math.abs(g) : null;
    }
    const T = ctx.pack.t || [];
    const sizes = ctx.pack[side === 'ahead' ? 'sizeAheadGroup' : 'sizeBehindGroup'] || [];
    const gaps = ctx.pack[side === 'ahead' ? 'gapAheadGroup' : 'gapBehindGroup'] || [];
    let best = null;
    let bestD = Infinity;
    for (let k = Math.max(0, lowerIndex(T, t - ctx.packNear)); k < T.length && T[k] <= t + ctx.packNear; k++) {
        const d = Math.abs(T[k] - t);
        if (d < bestD && agrees(sizes[k], n) && isNum(gaps[k])) {
            best = gaps[k];
            bestD = d;
        }
    }
    return isNum(best) ? Math.abs(best) : null;
}

const agrees = (size, n) => isNum(size) && Math.abs(size - n) <= Math.max(1, Math.round(n * 0.2));

/* The riders (seq numbers) in the nearest group on one side at second t, by the membership log. */
function sideSeqs(ctx, t, side) {
    const at = isNum(ctx.placedFrom) ? Math.max(t, ctx.placedFrom) : t;
    return ctx.replay.groupsAt(at)[side === 'ahead' ? '-1' : '1'];
}

/*
 * "4 @ 9.5 s" for the nearest group on one side, or "-" for none. The size is the membership log's,
 * the gap Sauce's (gapAt); "4 @ ?" is a group whose gap no row near that second could be matched to.
 */
export function sideCell(ctx, t, side) {
    if (!ctx.hasMoves || !isNum(ctx.placedFrom) || t < ctx.placedFrom) {
        const size = (side === 'ahead' ? ctx.P.aheadSize : ctx.P.behindSize).at(t, ctx.packNear);
        const gap = (side === 'ahead' ? ctx.P.aheadGap : ctx.P.behindGap).at(t, ctx.packNear);
        return isNum(size) && isNum(gap) ? `${size} @ ${Math.abs(gap).toFixed(1)} s` : '-';
    }
    const n = sideSeqs(ctx, t, side).length;
    if (!n) {
        return '-';
    }
    const gap = gapAt(ctx, t, side, n);
    return `${n} @ ${isNum(gap) ? `${gap.toFixed(1)} s` : '?'}`;
}

export function powerUpAt(ctx, t) {
    let cur = null;
    for (const [pt, name] of ctx.tl.powerUpEvents || []) {
        if (pt <= t) {
            cur = name;
        } else {
            break;
        }
    }
    return cur;
}

/* Sauce's classes per second: in a group with draft, in a group with none, no group (src/stats.mjs:3411-3460). */
export function draftClass(ctx, t, draft) {
    const gs = ctx.P.size.at(t, ctx.packNear);
    if (!isNum(gs) || gs < 2) {
        return 'solo';
    }
    return isNum(draft) && draft > 0 ? 'follow' : 'work';
}


/* ------------------------------------------------------------------ groups on the road */

/*
 * The groups on the road at second t: the group ahead and behind with who was in them, how many
 * riders were further away, and the rider's own group. Sizes of the groups are counted from the
 * membership log, so they agree with the names; the gaps are Sauce's own.
 */
export function roadAt(ctx, t, {namesInOwnGroup = true, memo = null, brief = false, until = null} = {}) {
    const placed = ctx.P.size.at(t, ctx.packNear);
    if (!isNum(placed)) {
        return ['  Sauce did not place you in a group at this second.'];
    }
    if (!ctx.hasMoves) {
        return [`  your group ${placed} riders; group ahead ${sideCell(ctx, t, 'ahead')}; ` +
            `group behind ${sideCell(ctx, t, 'behind')} (who was in the other groups was not ` +
            'recorded by the version of the mod that made this recording)'];
    }
    const g = ctx.replay.groupsAt(isNum(ctx.placedFrom) ? Math.max(t, ctx.placedFrom) : t);
    // With `until`, one listing for a span in which nobody changed place: the gaps at both ends.
    const gapTo = (which, n) => {
        if (until == null) {
            return '';
        }
        const b = gapAt(ctx, until, which, n);
        return isNum(b) ? ` to ${fmtGap(b)}` : ' to a gap not known';
    };
    const L = [];
    // A big group gets a few names, and a group listed just before with the same riders none.
    const names = (seqs, place) => {
        const key = [...seqs].sort((a, b) => a - b).join(',');
        if (memo && memo.get(place) === key) {
            return 'same riders as before';
        }
        if (memo) {
            memo.set(place, key);
        }
        return listNames(seqs.map(ctx.nameOfSeq),
            brief ? NAMES_IN_BRIEF : seqs.length > NAMES_IN_FULL ? NAMES_IN_BRIEF : NAMES_IN_FULL);
    };
    const far = (n, where) => n ? `  further ${where}: ${plural(n, 'rider')}` : null;
    const side = (seqs, which) => {
        if (!seqs.length) {
            return null;
        }
        const gap = gapAt(ctx, t, which, seqs.length);
        return `  ${which}, ${plural(seqs.length, 'rider')} @ ${isNum(gap) ? fmtGap(gap) : '?'}` +
            `${gapTo(which, seqs.length)}: ${names(seqs, which)}`;
    };
    L.push(far(g['-2'].length, 'ahead'));
    L.push(side(g['-1'], 'ahead'));
    // Your own group is named only while it is small enough to name in full.
    L.push(`  YOUR GROUP, ${plural(g['0'].length + 1, 'rider')} counting you` +
        `${namesInOwnGroup && g['0'].length && g['0'].length <= NAMES_IN_FULL ? `: ${names(g['0'], 'mine')}` : ''}`);
    L.push(side(g['1'], 'behind'));
    L.push(far(g['2'].length, 'back'));
    return L.filter(Boolean);
}

/* Whether nobody changed place against the rider's group between t0 and t1, by the log. */
export function samePlaces(ctx, t0, t1) {
    if (!ctx.hasMoves) {
        return false;
    }
    const from = isNum(ctx.placedFrom) ? Math.max(t0, ctx.placedFrom) : t0;
    return !ctx.replay.list.some(x => x[0] > from && x[0] <= t1);
}

/*
 * The nearest group on one side from the membership log, with Sauce's gap to it (gapAt), or null
 * for no group there. The gap is null when no pack row near t can be matched to that group.
 */
export function groupAt(ctx, t, side) {
    const seqs = ctx.replay.groupsAt(t)[side === 'ahead' ? '-1' : '1'];
    return seqs.length ? {seqs, gap: gapAt(ctx, t, side, seqs.length)} : null;
}

/* groupAt, only when Sauce's gap to that group is known: {seqs, gap} or null. */
export function neighbourAt(ctx, t, side) {
    const n = groupAt(ctx, t, side);
    return n && isNum(n.gap) ? n : null;
}


/* ------------------------------------------------------------------ moves between groups */

/*
 * The membership log as lines: every change that held, grouped when several riders made the same
 * change at the same second. Only changes that involve the rider's group or the groups next to it;
 * riders coming into and going out of view far up or down the road are counted, not listed.
 */
export function moveEvents(ctx, t0 = -Infinity, t1 = Infinity) {
    const byKey = new Map();
    for (const [t, seq, from, to, first] of ctx.replay.list) {
        if (t < t0 || t > t1 || first) {
            continue;
        }
        const k = `${t}|${from}|${to}`;
        if (!byKey.has(k)) {
            byKey.set(k, {t, from, to, seqs: []});
        }
        byKey.get(k).seqs.push(seq);
    }
    return [...byKey.values()].sort((a, b) => a.t - b.t);
}

const nearPlace = p => p === -1 || p === 0 || p === 1;

/*
 * A change of group that was undone within this long is left out of WHO WAS WHERE, both ways. The race
 * commentary of 17 Sep 2026 ran to about 800 words against its 600, much of it riders who "lost contact
 * briefly" or went "a second clear" and were back within seconds.
 */
export const BRIEF_CHANGE_SECONDS = 60;

/* e (moveEvents) without the riders whose change here was undone, or undid one, within BRIEF_CHANGE_SECONDS. */
export function withoutBriefChanges(ctx, e) {
    const list = ctx.replay.list;
    const brief = seq => {
        const mine = list.filter(x => x[1] === seq && !x[4]);
        const i = mine.findIndex(x => x[0] === e.t && x[2] === e.from && x[3] === e.to);
        if (i < 0) {
            return false;
        }
        const next = mine[i + 1];
        const prev = mine[i - 1];
        return (next && next[3] === e.from && next[0] - e.t <= BRIEF_CHANGE_SECONDS) ||
            (prev && prev[2] === e.to && e.t - prev[0] <= BRIEF_CHANGE_SECONDS);
    };
    const seqs = e.seqs.filter(seq => !brief(seq));
    return seqs.length ? {...e, seqs} : null;
}

export function isNearMove(e) {
    // Into or out of view counts only for the rider's own group: a rider appearing far behind is
    // Sauce's view, not the race.
    if (e.from == null || e.to == null) {
        return e.from === 0 || e.to === 0;
    }
    return nearPlace(e.from) || nearPlace(e.to);
}

/*
 * One change of place as a line. The words say where the riders were before and after, never who
 * moved: when the rider is dropped, it is everybody else whose place against the rider's group
 * changes, and "20 riders went from your group to the group ahead" would invite a story of twenty
 * riders going clear (review of 16 Sep 2026). A change between the group next to the rider's and a
 * group further away on the same side only means another group now sat between, or no longer did,
 * and is said that way.
 */
export function moveLine(ctx, e, maxNames = 8) {
    const who = listNames(e.seqs.map(ctx.nameOfSeq), maxNames);
    const n = e.seqs.length;
    if (isNum(e.from) && isNum(e.to) && e.from !== 0 && e.to !== 0 && Math.sign(e.from) === Math.sign(e.to)) {
        const way = e.to < 0 ? 'ahead of' : 'behind';
        if (Math.abs(e.to) > Math.abs(e.from)) {
            /*
             * Say which group is now between, and when it came out of the same group, that the
             * group split. The texts used to say only "another group was now on the road between
             * yours and ...", which a tester found hard to read (22 Sep 2026).
             */
            const side = e.to < 0 ? '-1' : '1';
            const was = new Set(ctx.replay.groupsAt(e.t - 1)[side]);
            const now = ctx.replay.groupsAt(e.t + 1)[side].filter(x => !e.seqs.includes(x));
            const names = listNames(now.map(ctx.nameOfSeq), maxNames);
            if (now.length && now.every(x => was.has(x))) {
                return `${fmtClock(e.t)}: the group ${e.to < 0 ? 'ahead' : 'behind'} split: ${who} ` +
                    `${n === 1 ? 'was' : 'were'} now further ${e.to < 0 ? 'up the road' : 'back'}, and ${names} ` +
                    `${now.length === 1 ? 'was' : 'were'} left as the nearest group ${way} yours.`;
            }
            return `${fmtClock(e.t)}: ${now.length ? `${names} now between your group and ${who}` :
                `another group was now on the road between yours and ${who}`}, so ${who} ` +
                `${n === 1 ? 'was' : 'were'} no longer the nearest group ${way} yours.`;
        }
        return Math.abs(e.to) > Math.abs(e.from) ? '' :
            `${fmtClock(e.t)}: ${who} ${n === 1 ? 'was' : 'were'} now the nearest group ${way} yours; ` +
            'no group was between any more.';
    }
    let detail = '';
    if (e.to === -1 || e.to === 1) {
        const g = neighbourAt(ctx, e.t + MOVE_HOLD_SECONDS, e.to === -1 ? 'ahead' : 'behind');
        if (g) {
            detail = ` (a group of ${g.seqs.length}, ${fmtGap(g.gap)} ${e.to === -1 ? 'ahead' : 'behind'} ` +
                `${MOVE_HOLD_SECONDS} s later)`;
        }
    }
    const c = clusterOf(ctx, e);
    const clear = c && c.who ? `; ${c.who}` : '';
    return `${fmtClock(e.t)}: ${who}, ${IN_PLACE_WORDS[String(e.from)]} until then, ` +
        `${IN_PLACE_WORDS[String(e.to)]} from then on${detail}${clear}.`;
}

/*
 * Whether the rider went clear at t, rather than the others falling back. Sauce's groups alone
 * cannot tell the two apart, but the rider's own power can: on 17 Sep 2026 Van's power went from
 * about 230 W to 400 W at 27:45 and at 28:10 his four companions were in a group behind him, which
 * the commentary told as them falling back (Van, 18 Sep 2026: "it talks about it as if they fell
 * back instead of me attacking"). It counts when the rider's power over the 35 s up to the change
 * was a quarter or more above the minute before it, and at FTP or above where FTP is known.
 */
export const WENT_CLEAR_RISE = 1.25;

export function riderWentClear(ctx, t, nBehind) {
    // Most of the group has to end up behind: one rider dropped off a group that stays with the
    // rider is that rider falling back, however hard the rider was riding (14:01 on 17 Sep 2026).
    const stayed = ctx.replay.groupsAt(t)['0'].length + 1;
    if (!(nBehind >= stayed)) {
        return false;
    }
    const before = ctx.S.power.avg(t - 95, t - 36);
    const during = ctx.S.power.avg(t - 35, t);
    return isNum(before) && isNum(during) && before > 0 && during >= before * WENT_CLEAR_RISE &&
        (!ctx.ftp || during >= ctx.ftp);
}

/* The move cluster (moveClusters, before any is left out) a change of place belongs to, or null. */
function clusterOf(ctx, e) {
    if (!ctx._allClusters) {
        moveClusters(ctx);
    }
    const kind = e.from === 0 && isNum(e.to) ? (e.to < 0 ? 'clear' : 'dropped') :
        e.to === 0 && isNum(e.from) ? (e.from < 0 ? 'caught' : 'joined') : null;
    return kind && (ctx._allClusters || []).find(c => c.kind === kind && Math.abs(c.t - e.t) <= MOVE_CLUSTER_SECONDS &&
        c.seqs.some(s => e.seqs.includes(s))) || null;
}

/*
 * Who moved, for a change of place between the rider's group and the one next to it. A tester,
 * 22 Sep 2026: "It struggled quite a bit understanding who was catching vs getting dropped." The
 * facts said only where riders were before and after. These words say who moved where the data
 * can show it, and nothing where it cannot:
 *   riders into a group behind   they were dropped (the rider's own move is riderWentClear)
 *   riders into a group ahead    most of the group: you were dropped; a few: they rode clear
 *   riders from the group ahead  the gap to it came down in the minute before: your group caught
 *                                them; it held: they dropped back to you; not known: nothing
 *   riders from the group behind the gap came down in the minute before: they caught your group
 */
export const CLOSING_SECONDS = 1.5;

function gapTrend(ctx, t, side) {
    const a = neighbourAt(ctx, t - 60, side);
    const b = neighbourAt(ctx, t - 8, side);
    if (!a || !b) {
        return null;
    }
    const from = Math.abs(a.gap);
    const to = Math.abs(b.gap);
    return {from, to, closing: from - to >= CLOSING_SECONDS};
}

export function whoMoved(ctx, kind, t, n) {
    if (kind === 'dropped') {
        return 'they were dropped';
    }
    if (kind === 'clear') {
        const stayed = ctx.replay.groupsAt(t)['0'].length + 1;
        return n >= stayed ? 'you were dropped' : 'they rode clear';
    }
    const side = kind === 'caught' ? 'ahead' : 'behind';
    const g = gapTrend(ctx, t, side);
    const how = g && `gap ${fmtGap(g.from)} to ${fmtGap(g.to)} in the minute before`;
    if (kind === 'caught') {
        return !g ? null : g.closing ? `your group caught them, ${how}` : 'they dropped back to you';
    }
    if (g && g.closing) {
        return `they caught your group, ${how}`;
    }
    // Riders from behind with no gap closing: say so when the rider had eased, as at 2:30 on
    // 17 Sep 2026, when the 14 came back as the rider's own power fell from 410 W.
    // Easing shows sooner than a surge, so the last 20 s against the minute before them.
    const before = ctx.S.power.avg(t - 80, t - 21);
    const during = ctx.S.power.avg(t - 20, t);
    return isNum(before) && isNum(during) && during <= before * 0.75 ?
        'they came back as your power fell' : null;
}

const WENT_CLEAR_WORDS = 'your move: you rode clear, your power up sharply';

const IN_PLACE_WORDS = {
    '-2': 'in a group further up the road',
    '-1': 'in the group ahead of yours',
    '0': 'in your group',
    '1': 'in the group behind yours',
    '2': 'in a group further back',
    'null': 'out of Sauce\'s view',
};


/* ------------------------------------------------------------------ climbs */

/*
 * Climbs: runs of at least CLIMB_MIN_SECONDS where Sauce's grade was CLIMB_MIN_GRADE or more, with
 * dips of up to CLIMB_BRIDGE_SECONDS bridged.
 */
export function findClimbs(ctx) {
    const {own, line} = ctx;
    const runs = [];
    let cur = null;
    for (let i = 0; i < own.t.length && own.t[i] <= line; i++) {
        const g = own.grade[i];
        if (isNum(g) && g >= CLIMB_MIN_GRADE) {
            if (cur && own.t[i] - cur.t1 <= CLIMB_BRIDGE_SECONDS + 1) {
                cur.t1 = own.t[i];
            } else {
                cur = {t0: own.t[i], t1: own.t[i]};
                runs.push(cur);
            }
        }
    }
    return runs.filter(r => r.t1 - r.t0 + 1 >= CLIMB_MIN_SECONDS);
}

/*
 * The route segments Sauce knows for the road the rider was on between t0 and t1, by Sauce's own
 * active segment test (src/stats.mjs:3527-3546): a segment counts when the rider was inside it for
 * at least half the rows. rec.segments is what ui.mjs looked up when the race was saved.
 */
export function segmentsDuring(ctx, t0, t1) {
    const segs = (ctx.rec.segments || []).filter(x => x && x.name && !x.loop &&
        isNum(x.roadStart) && isNum(x.roadFinish) && x.roadStart !== x.roadFinish);
    const roads = ctx.tl.roadEvents || [];
    const rt = ctx.tl.roadTime || [];
    const tt = ctx.tl.t || [];
    if (!segs.length || !roads.length || !rt.length) {
        return [];
    }
    const counts = new Map();
    let rows = 0;
    let r = -1;
    for (let i = 0; i < tt.length && tt[i] <= t1; i++) {
        while (r + 1 < roads.length && roads[r + 1][0] <= tt[i]) {
            r++;
        }
        if (tt[i] < t0 || r < 0 || !isNum(rt[i])) {
            continue;
        }
        rows++;
        const [, courseId, roadId, reverse] = roads[r];
        const p = (rt[i] - 5000) / 1e6;
        for (const x of segs) {
            if (x.roadId !== roadId || !!x.reverse !== !!reverse ||
                (isNum(x.courseId) && isNum(courseId) && x.courseId !== courseId)) {
                continue;
            }
            const progress = reverse ?
                1 - (p - x.roadFinish) / (x.roadStart - x.roadFinish) :
                (p - x.roadStart) / (x.roadFinish - x.roadStart);
            if (progress > 0 && progress < 1) {
                counts.set(x.name, (counts.get(x.name) || 0) + 1);
            }
        }
    }
    return [...counts.entries()].filter(([, n]) => rows && n >= rows / 2).map(([name]) => name);
}

/* With `brief`, one line a climb: the rider's own numbers and group, without the groups either side. */
export function climbLines(ctx, climbs, {debrief = false, brief = false} = {}) {
    if (!climbs.length) {
        return ['None found.'];
    }
    const L = [];
    climbs.forEach((c, k) => {
        const d0 = ctx.S.dist.at(c.t0, 5);
        const d1 = ctx.S.dist.at(c.t1, 5);
        const avgGrade = ctx.S.grade.avg(c.t0, c.t1);
        const maxGrade = ctx.S.grade.extremes(c.t0, c.t1).max;
        const p = ctx.S.power.avg(c.t0, c.t1);
        const gp = ctx.P.groupPower.avg(c.t0, c.t1);
        const tg0 = toGoAt(ctx, c.t0);
        const segments = segmentsDuring(ctx, c.t0, c.t1);
        const pct = x => (isNum(x) ? `${(x * 100).toFixed(1)}%` : '?');
        L.push(`Climb ${k + 1}: ${fmtClock(c.t0)} to ${fmtClock(c.t1)} (${fmtDuration(c.t1 - c.t0 + 1)})` +
            `${isNum(d0) && isNum(d1) ? `, ${Math.round(d1 - d0)} m` : ''} at ${pct(avgGrade)} ` +
            `(steepest ${pct(maxGrade)})${isNum(tg0) ? `, from ${distNum(ctx, tg0)} ${distUnit(ctx)} to go` : ''}` +
            `${segments.length ? `; Sauce's route segment for this road: ${segments.join(', ')}` : ''}.`);
        const side = which => {
            const cell = t => {
                const n = groupAt(ctx, t, which);
                return n ? `${n.seqs.length} @ ${isNum(n.gap) ? fmtGap(n.gap) : '?'}` : 'none';
            };
            return ctx.hasMoves ? `${which} ${cell(c.t0)} to ${cell(c.t1)}` :
                `${which} ${sideCell(ctx, c.t0, which)} to ${sideCell(ctx, c.t1, which)}`;
        };
        const you = isNum(p) ? [`${Math.round(p)} W`, wkg(ctx, p), pctFtp(ctx, p)].filter(Boolean) : ['not recorded'];
        // The race commentary gets no rider's power (see findMoments in factpack.mjs).
        if (brief && !debrief) {
            L[L.length - 1] = L[L.length - 1].replace(/\.$/, '') +
                `; your group ${ctx.P.size.at(c.t0, ctx.packNear) ?? '?'} to ${ctx.P.size.at(c.t1, ctx.packNear) ?? '?'}.`;
            return;
        }
        if (brief) {
            L[L.length - 1] = L[L.length - 1].replace(/\.$/, '') + `; you ${you.slice(0, 2).join(', ')}` +
                `${debrief ? `, W'bal model ${wbalShare(ctx, ctx.S.wbal.at(c.t0, 3))} to ${wbalShare(ctx, ctx.S.wbal.at(c.t1, 3))}` : ''}` +
                `; your group ${ctx.P.size.at(c.t0, ctx.packNear) ?? '?'} to ${ctx.P.size.at(c.t1, ctx.packNear) ?? '?'}.`;
            return;
        }
        L.push(`  ${debrief ? `You ${you[0]}${you.length > 1 ? ` (${you.slice(1).join(', ')})` : ''}` +
            `${isNum(gp) ? `, your group's average ${Math.round(gp)} W` : ''}` :
            `${isNum(gp) ? `Your group's average ${Math.round(gp)} W` : 'Your group\'s average power not recorded'}`}` +
            `${debrief ? `, W'bal model ${wbalShare(ctx, ctx.S.wbal.at(c.t0, 3))} to ${wbalShare(ctx, ctx.S.wbal.at(c.t1, 3))}` : ''}` +
            `; bottom to top: your group ${ctx.P.size.at(c.t0, ctx.packNear) ?? '?'} to ` +
            `${ctx.P.size.at(c.t1, ctx.packNear) ?? '?'}, ${side('ahead')}, ${side('behind')}.`);
    });
    return L;
}


/* ------------------------------------------------------------------ hard efforts */

/*
 * Efforts: runs where the rider's 10 second average stayed at or above EFFORT_FTP_SHARE of FTP,
 * trimmed to the first and last second at that level, at least EFFORT_MIN_SECONDS long. The
 * EFFORT_COUNT biggest by work above FTP, which is what the W'bal model draws on, in time order.
 */
export function findEfforts(ctx) {
    const {own, line, ftp} = ctx;
    if (!ftp) {
        return [];
    }
    const level = ftp * EFFORT_FTP_SHARE;
    const P = ctx.S.power;
    const out = [];
    const n = own.t.length;
    let start = null;
    const close = (i0, i1) => {
        let a = i0;
        let b = i1;
        while (a < b && !(own.power[a] >= level)) {
            a++;
        }
        while (b > a && !(own.power[b] >= level)) {
            b--;
        }
        if (own.t[b] - own.t[a] + 1 >= EFFORT_MIN_SECONDS && own.power[a] >= level) {
            let above = 0;
            for (let k = a; k <= b; k++) {
                if (isNum(own.power[k])) {
                    above += Math.max(0, own.power[k] - ftp) * ctx.rowSeconds(k) / 1000;
                }
            }
            out.push({start: own.t[a], end: own.t[b], kjAbove: above});
        }
    };
    for (let i = 0; i < n && own.t[i] <= line; i++) {
        const a10 = P.avg(own.t[i] - 9, own.t[i]);
        const hard = isNum(a10) && a10 >= level;
        if (hard && start == null) {
            start = P.lower(own.t[i] - 9);
        }
        const lastRow = i + 1 >= n || own.t[i + 1] > line;
        if (start != null && (!hard || lastRow)) {
            close(start, hard ? i : i - 1);
            start = null;
        }
    }
    // The biggest by work above FTP; of two that did the same work, the later, nearer the line.
    const top = out.slice().sort((a, b) => (b.kjAbove - a.kjAbove) || (b.start - a.start)).slice(0, EFFORT_COUNT)
        .sort((a, b) => a.start - b.start);
    // Every effort that met the rule, not only the ones kept, so "your next hard effort" is the next
    // one ridden and not the next one listed.
    top.all = out;
    return top;
}

/* What a stretch of the race cost the rider: the debrief's cost block. */
export function costLines(ctx, t0, t1) {
    const {own, S} = ctx;
    const p = S.power.avg(t0, t1);
    if (!isNum(p)) {
        return ['Nothing recorded.'];
    }
    let kj = 0;
    let above = 0;
    let secAbove = 0;
    const cls = {follow: 0, work: 0, solo: 0};
    for (let i = S.power.lower(t0); i < own.t.length && own.t[i] <= t1; i++) {
        const P = own.power[i] || 0;
        const dt = ctx.rowSeconds(i);
        kj += P * dt / 1000;
        if (ctx.ftp) {
            above += Math.max(0, P - ctx.ftp) * dt / 1000;
            secAbove += P > ctx.ftp ? dt : 0;
        }
        cls[draftClass(ctx, own.t[i], own.draft[i])] += dt;
    }
    const w0 = S.wbal.at(t0, 3);
    const w1 = S.wbal.at(t1, 3);
    const {min: low, minT: lowT} = S.wbal.extremes(t0, t1);
    const idx = [];
    for (let i = S.power.lower(t0); i < own.t.length && own.t[i] <= t1; i++) {
        idx.push(i);
    }
    const peak5 = bestWindow(idx.map(i => own.tExact[i]), idx.map(i => own.power[i]), 5);
    const h0 = S.hr.at(t0, 3);
    const hMax = S.hr.extremes(t0, t1).max;
    // How long after the lowest point the model took to win back half of what this stretch took.
    let back = null;
    if (isNum(w0) && isNum(low) && w0 - low >= 500) {
        const target = low + (w0 - low) / 2;
        let found = null;
        for (let i = S.wbal.lower(lowT + 1); i < own.t.length && own.t[i] <= ctx.line; i++) {
            if (isNum(own.wbal[i]) && own.wbal[i] >= target) {
                found = own.t[i];
                break;
            }
        }
        back = found != null ?
            `Half of what it took was back ${fmtDuration(found - lowT)} after the lowest point` :
            'Half of what it took had not come back by the line';
    }
    const dj = j => (isNum(j) ? `${Math.round(j)} J` : '? J');
    return [
        `Power ${Math.round(p)} W` +
        `${[wkg(ctx, p), pctFtp(ctx, p)].filter(Boolean).length ?
            ` (${[wkg(ctx, p), pctFtp(ctx, p)].filter(Boolean).join(', ')})` : ''}` +
        `${peak5 ? `, best 5 s ${Math.round(peak5.avg)} W` : ''}; ` +
        `${Math.round(kj)} kJ${ctx.ftp ? `, ${Math.round(above)} kJ and ${secAbove} s above FTP` : ''}; ` +
        `heart rate ${isNum(h0) ? Math.round(h0) : '?'} bpm at the start, ${isNum(hMax) ? Math.round(hMax) : '?'} highest; ` +
        `f/w/s ${cls.follow}/${cls.work}/${cls.solo} s.`,
        `W'bal model: ${wbalShare(ctx, w0)} at ${fmtClock(t0)}, ` +
        (lowT === t1 || !isNum(lowT) ? `${wbalShare(ctx, low)} (${dj(low)}) at ${fmtClock(t1)}, the lowest` :
            `lowest ${wbalShare(ctx, low)} (${dj(low)}) at ${fmtClock(lowT)}, ${wbalShare(ctx, w1)} at ${fmtClock(t1)}`) +
        `${back ? `. ${back}` : ''}.`,
    ];
}

/* A stretch's cost in one line, for a key moment with no hard effort in it. */
export function costBrief(ctx, t0, t1) {
    const p = ctx.S.power.avg(t0, t1);
    if (!isNum(p)) {
        return 'nothing recorded.';
    }
    let kj = 0;
    for (let i = ctx.S.power.lower(t0); i < ctx.own.t.length && ctx.own.t[i] <= t1; i++) {
        kj += (ctx.own.power[i] || 0) * ctx.rowSeconds(i) / 1000;
    }
    return `${Math.round(p)} W${wkg(ctx, p) ? ` (${wkg(ctx, p)})` : ''}, ${Math.round(kj)} kJ; W'bal model ` +
        `${wbalShare(ctx, ctx.S.wbal.at(t0, 3))} to ${wbalShare(ctx, ctx.S.wbal.at(t1, 3))}, lowest ` +
        `${wbalShare(ctx, ctx.S.wbal.extremes(t0, t1).min)}.`;
}

export function effortBlocks(ctx, efforts) {
    const L = [];
    const all = efforts.all || efforts;
    efforts.forEach((e, k) => {
        const next = all.find(x => x.start > e.end);
        const listed = next && efforts.includes(next);
        const a0 = sideCell(ctx, e.start, 'ahead');
        const a1 = sideCell(ctx, e.end, 'ahead');
        L.push('', `${fmtClock(e.start)} to ${fmtClock(e.end)} (${fmtDuration(e.end - e.start + 1)}), ` +
            `${toGoText(ctx, e.start)} ${distUnit(ctx)} to go; your group ` +
            `${ctx.P.size.at(e.start, ctx.packNear) ?? '?'} then ${ctx.P.size.at(e.end, ctx.packNear) ?? '?'} ` +
            `riders${a0 === '-' && a1 === '-' ? '' : `; group ahead ${a0} then ${a1}`}.`);
        L.push(...costLines(ctx, e.start, e.end).map(x => `  ${x}`));
        L.push(next ?
            `  Reserve before your next hard effort, at ${fmtClock(next.start)}` +
            `${listed ? '' : ` (${fmtDuration(next.end - next.start + 1)} at ` +
                `${Math.round(ctx.S.power.avg(next.start, next.end))} W, not one of the five listed)`}: ` +
            `${wbalShare(ctx, ctx.S.wbal.at(next.start, 3))}.` :
            '  This was your last hard effort before the line.');
    });
    const others = all.filter(x => !efforts.includes(x));
    if (efforts.length && others.length) {
        L.push('', `${plural(others.length, 'other effort')} met the same rule but did less work above FTP, so ` +
            `${others.length === 1 ? 'it is' : 'they are'} not listed: ` +
            `${others.map(x => `${fmtClock(x.start)} (${fmtDuration(x.end - x.start + 1)})`).join(', ')}.`);
    }
    return L;
}


/* ------------------------------------------------------------------ key moments */

/*
 * The moments: the start, every split of the rider's group (findSplits, with its hold), the
 * biggest moves of riders between the rider's group and another, the rider's hard efforts, and
 * the finish, each with a fixed window. Overlapping windows merge and keep every reason. A race
 * with more than MAX_MOMENTS keeps the start, the finish and the ones with the most reasons.
 */
export function findMoments(ctx, {efforts, climbs, minSplitSeconds = 0}) {
    const {first, line} = ctx;
    const raw = [];
    /*
     * A split whose riders were back together within minSplitSeconds is no key moment. The race
     * commentary asks for 30 s (Van, 18 Sep 2026: "splits are fine to include....but probably needs
     * to be more than i don't know - 30 seconds to be relevant"): on 17 Sep 2026 the splits at 2:00
     * and 2:53 were back together after 30 s and 28 s. The debrief keeps them all.
     */
    const clusters = moveClusters(ctx);
    const brief = c => c.back && c.back.t - c.t <= minSplitSeconds;
    const undoneAt = clusters.filter(brief).map(c => c.t);
    const wasUndone = t => undoneAt.some(u => Math.abs(u - t) <= 15);
    if (ctx.hasStart) {
        raw.push({t0: first, t1: first + START_SECONDS, tags: ['the start'], start: true, weight: 0});
    }
    for (const sp of findSplits(ctx.splitPack)) {
        if (sp.t1 > line || wasUndone(sp.t1)) {
            continue;
        }
        raw.push({t0: sp.t0 - MOMENT_BEFORE, t1: sp.t1 + MOMENT_AFTER, changed: true, weight: sp.drop,
                  tags: [`your group went from ${sp.before} to ${sp.after} riders`]});
    }
    for (const c of clusters.filter(c => !brief(c))
        .sort((a, b) => b.seqs.length - a.seqs.length || a.t - b.t).slice(0, MOVE_MOMENTS)) {
        raw.push({t0: c.t - MOMENT_BEFORE, t1: c.t + MOMENT_AFTER, changed: true, weight: c.seqs.length,
                  tags: [c.text]});
    }
    for (const e of efforts) {
        raw.push({t0: e.start - EFFORT_BEFORE, t1: e.end + EFFORT_AFTER, weight: e.kjAbove,
                  tags: [`a hard effort by you from ${fmtClock(e.start)} to ${fmtClock(e.end)}`]});
    }
    if (ctx.finished) {
        raw.push({t0: line - FINISH_SECONDS, t1: line, tags: ['the finish'], finish: true, weight: 0});
    }
    const merged = [];
    for (const m of raw.map(x => ({...x, t0: Math.max(first, x.t0), t1: Math.min(line, x.t1)}))
        .filter(x => x.t1 > x.t0).sort((a, b) => a.t0 - b.t0)) {
        const last = merged[merged.length - 1];
        if (last && m.t0 <= last.t1) {
            last.t1 = Math.max(last.t1, m.t1);
            last.changed = last.changed || m.changed;
            last.start = last.start || m.start;
            last.finish = last.finish || m.finish;
            last.weight += m.weight;
            for (const tag of m.tags) {
                if (!last.tags.includes(tag)) {
                    last.tags.push(tag);
                }
            }
        } else {
            merged.push({...m, tags: [...m.tags]});
        }
    }
    let kept = merged;
    if (merged.length > MAX_MOMENTS) {
        const fixed = merged.filter(m => m.start || m.finish);
        const rest = merged.filter(m => !m.start && !m.finish)
            .sort((a, b) => (b.tags.length - a.tags.length) || (b.weight - a.weight) || (a.t0 - b.t0))
            .slice(0, MAX_MOMENTS - fixed.length);
        kept = [...fixed, ...rest].sort((a, b) => a.t0 - b.t0);
    }
    for (const m of kept) {
        m.climbs = climbs.map((c, i) => ({...c, n: i + 1})).filter(c => c.t1 >= m.t0 && c.t0 <= m.t1);
        m.efforts = efforts.filter(e => e.end >= m.t0 && e.start <= m.t1);
    }
    return {moments: kept, dropped: merged.length - kept.length};
}

/*
 * Moves between the rider's group and another, as moments: riders making the same change within
 * MOVE_CLUSTER_SECONDS of each other are one move. A move counts when two or more riders made it,
 * or when riders went clear of the rider's group into the group ahead.
 */
export function moveClusters(ctx) {
    if (!ctx.hasMoves) {
        return [];
    }
    const kinds = [
        // The same neutral words as moveLine: where riders were, not who moved.
        ['clear', e => e.from === 0 && e.to != null && e.to < 0, n => `your group split: ${plural(n, 'rider')} of it now in a group ahead of you`],
        ['dropped', e => e.from === 0 && e.to != null && e.to > 0, n => `your group split: ${plural(n, 'rider')} of it now in a group behind you`],
        ['caught', e => e.to === 0 && e.from != null && e.from < 0, n => `${plural(n, 'rider')} from a group ahead now in your group`],
        ['joined', e => e.to === 0 && e.from != null && e.from > 0, n => `${plural(n, 'rider')} from a group behind now in your group`],
    ];
    const out = [];
    for (const [kind, test, words] of kinds) {
        let cur = null;
        for (const [t, seq, from, to, first] of ctx.replay.list) {
            if (t > ctx.line || first || !test({from, to})) {
                continue;
            }
            if (cur && t - cur.t <= MOVE_CLUSTER_SECONDS) {
                cur.seqs.push(seq);
            } else {
                cur = {kind, t, seqs: [seq]};
                out.push(cur);
            }
        }
        for (const c of out.filter(x => x.kind === kind)) {
            c.text = words(c.seqs.length);
            if (kind === 'dropped' && riderWentClear(ctx, c.t, c.seqs.length)) {
                c.wentClear = true;
                c.who = WENT_CLEAR_WORDS;
                c.text = `your move: you rode clear of your group at ${fmtClock(c.t)}, ${plural(c.seqs.length, 'rider')} of it ` +
                    'now behind you, your power up sharply';
            } else {
                c.who = whoMoved(ctx, kind, c.t, c.seqs.length);
                c.text += c.who ? ` (${c.who})` : '';
            }
        }
    }
    /*
     * A split that came back together is one move, not two. On Van's race of 17 Sep 2026 a group
     * of 4 was clear of 14 from 2:00 to 2:30, and the key moment's reasons read "your group split:
     * 14 riders of it now in a group behind you; 14 riders from a group behind now in your group",
     * twice over. When most of the riders of a split came back from the same side within
     * REJOIN_SECONDS, the two become one reason and the return is not listed again.
     */
    const backOf = {dropped: 'joined', clear: 'caught'};
    for (const c of out) {
        if (!backOf[c.kind] || c.back) {
            continue;
        }
        const r = out.find(x => x.kind === backOf[c.kind] && !x.pairedWith && x.t > c.t &&
            x.t - c.t <= REJOIN_SECONDS &&
            x.seqs.filter(s => c.seqs.includes(s)).length >= Math.ceil(c.seqs.length * 0.75));
        if (r) {
            r.pairedWith = c;
            c.back = r;
            c.text = `your group split: ${plural(c.seqs.length, 'rider')} of it in a group ` +
                `${c.kind === 'dropped' ? 'behind' : 'ahead of'} you from ${fmtClock(c.t)}` +
                `${c.who ? ` (${c.who})` : ''}, ` +
                `${r.seqs.length >= c.seqs.length ? 'all' : r.seqs.length} back in your group by ${fmtClock(r.t)}` +
                `${r.who ? ` (${r.who})` : ''}`;
        }
    }
    ctx._allClusters = out;
    return out.filter(c => !c.pairedWith && (c.seqs.length >= 2 || c.kind === 'clear'));
}

/*
 * Rows of a moment share one budget across the race, so a long race with many moments gets coarser
 * rows rather than a bigger paste. A moment where the groups changed gets the finest step; a quiet
 * one twice as coarse.
 */
export function rowStep(moments, {finest, budget}) {
    const total = moments.reduce((a, m) => a + (m.t1 - m.t0 + 1) / (m.changed ? 1 : 2), 0);
    return Math.max(finest, Math.ceil(total / budget / 5) * 5);
}

export function momentRowsHead(ctx, {debrief}) {
    const u = distUnit(ctx);
    return debrief ?
        `time | ${u} to go | grade | power | hr | draft | speed | W'bal | your group | ahead | position` :
        `time | ${u} to go | grade | speed | your group | ahead | behind | position`;
}

export function momentRows(ctx, m, {debrief, step: wanted}) {
    // At least MIN_MOMENT_ROWS rows, and always one that ends where the moment ends, or a finish
    // sprint in the last partial step would be in no row at all.
    const span = m.t1 - m.t0 + 1;
    const step = Math.max(5, Math.min(wanted, Math.ceil(span / MIN_MOMENT_ROWS / 5) * 5));
    const ends = [];
    for (let t = m.t0 + step - 1; t < m.t1; t += step) {
        ends.push(t);
    }
    // A last full row that ends within half a step of the moment's end becomes the closing row,
    // rather than leaving a closing row of a second or two.
    if (ends.length && m.t1 - ends[ends.length - 1] < step / 2) {
        ends.pop();
    }
    ends.push(m.t1);
    const rows = [`Rows every ${step} s, the last to the moment's end:`];
    ends.forEach((t, k) => {
        const a = k ? ends[k - 1] + 1 : m.t0;
        const avg = (s, dp = 0) => {
            const v = s.avg(a, t);
            return isNum(v) ? (dp ? v.toFixed(dp) : Math.round(v)) : '-';
        };
        const g = ctx.S.grade.at(t, 3);
        const pu = powerUpAt(ctx, t);
        const pos = ctx.tl.t ? posAt(ctx, t) : null;
        const cols = [fmtClock(t), toGoText(ctx, t), isNum(g) ? `${(g * 100).toFixed(1)}%` : '-'];
        if (debrief) {
            const wb = ctx.S.wbal.at(t, 3);
            cols.push(`${avg(ctx.S.power)} W`, avg(ctx.S.hr), `${avg(ctx.S.draft)} W`, avg(ctx.S.speed, 1),
                      isNum(wb) ? wbalShare(ctx, wb) : '-');
        } else {
            cols.push(avg(ctx.S.speed, 1));
        }
        const gs = ctx.P.size.at(t, ctx.packNear);
        cols.push(isNum(gs) ? gs : '-', sideCell(ctx, t, 'ahead'));
        if (!debrief) {
            cols.push(sideCell(ctx, t, 'behind'));
        }
        cols.push(isNum(pos) ? pos : '-');
        rows.push(cols.join(' | ') + (pu ? ` | ${prettyPowerUp(pu)} active` : ''));
    });
    return rows;
}

function posAt(ctx, t) {
    if (!ctx._pos) {
        ctx._pos = new Series(ctx.tl.t || [], ctx.tl.eventPosition || []);
    }
    return ctx._pos.at(t, 3);
}


/* ------------------------------------------------------------------ the overview */

/* `factor` makes the rows further apart when a text has to be shortened (factpack.mjs). */
export function overviewStep(ctx, factor = 1) {
    const span = ctx.line - ctx.first + 1;
    const base = span > OVERVIEW_TWO_MINUTES_AFTER ? 120 : 60;
    return Math.max(base, Math.ceil(span / OVERVIEW_ROWS / 60) * 60) * factor;
}

export function overviewRows(ctx, {debrief, factor = 1}) {
    const u = distUnit(ctx);
    const step = overviewStep(ctx, factor);
    const L = [debrief ?
        `from-to | ${u} to go at end | power | hr | W'bal at end | class (f/w/s) | your group | ahead | position` :
        `from-to | ${u} to go at end | your power | your group | your group's average power | ahead | behind | position`];
    for (let t0 = ctx.first; t0 <= ctx.line; t0 += step) {
        const t1 = Math.min(ctx.line, t0 + step - 1);
        const p = ctx.S.power.avg(t0, t1);
        const gs = ctx.P.size.at(t1, ctx.packNear);
        const gp = ctx.P.groupPower.avg(t0, t1);
        const pos = posAt(ctx, t1);
        const cols = [`${fmtClock(t0)}-${fmtClock(t1)}`, toGoText(ctx, t1), isNum(p) ? `${Math.round(p)} W` : '-'];
        if (debrief) {
            const h = ctx.S.hr.avg(t0, t1);
            const wb = ctx.S.wbal.at(t1, 3);
            const cls = {follow: 0, work: 0, solo: 0};
            for (let i = ctx.S.power.lower(t0); i < ctx.own.t.length && ctx.own.t[i] <= t1; i++) {
                cls[draftClass(ctx, ctx.own.t[i], ctx.own.draft[i])] += ctx.rowSeconds(i);
            }
            cols.push(isNum(h) ? Math.round(h) : '-', isNum(wb) ? wbalShare(ctx, wb) : '-',
                      `${cls.follow}/${cls.work}/${cls.solo}`, isNum(gs) ? gs : '-', sideCell(ctx, t1, 'ahead'));
        } else {
            cols.push(isNum(gs) ? gs : '-', isNum(gp) ? `${Math.round(gp)} W` : '-',
                      sideCell(ctx, t1, 'ahead'), sideCell(ctx, t1, 'behind'));
        }
        cols.push(isNum(pos) ? pos : '-');
        L.push(cols.join(' | '));
    }
    L.push(`One row every ${step === 60 ? 'minute' : `${step / 60} minutes`}. A dash means nothing was recorded.`);
    return L;
}


/* ------------------------------------------------------------------ how the gaps moved */

/*
 * The gap to the nearest group ahead and behind, stretch by stretch. A stretch is a span where
 * that group stayed the same group by Sauce's own test (sameGroup), cut where a climb or one of
 * the rider's hard efforts starts or ends, and cut again where the gap turned or levelled off
 * (gapTurns), so a rate never runs across a gap that grew and then came down. Cuts closer than
 * 20 s to each other or to a span's ends are dropped, and stretches under 30 s are not listed. At
 * most `max` lines: the last stretch on each side, so the end of the race is always there, then
 * the biggest changes.
 */
export function gapStretchLines(ctx, cutTimes, {max = 8} = {}) {
    if (!ctx.hasMoves) {
        return ['Not available: who was in the other groups was not recorded by the version of the ' +
                'mod that made this recording.'];
    }
    const times = (ctx.pack.t || []).filter(t => t <= ctx.line);
    const out = [];
    const cuts = [...cutTimes].sort((a, b) => a - b);
    for (const side of ['ahead', 'behind']) {
        const spans = [];
        let cur = null;
        for (const t of times) {
            const n = groupAt(ctx, t, side);
            if (!n) {
                cur = null;
                continue;
            }
            if (!isNum(n.gap)) {
                // No row near this second can be matched to the group: skip it, not the span.
                continue;
            }
            if (cur && sameGroup(cur.last, n.seqs) && t - cur.t1 <= 3 * ctx.packStep) {
                cur.t1 = t;
                cur.last = n.seqs;
                cur.pts.push([t, n.gap]);
            } else {
                cur = {seqs: n.seqs, last: n.seqs, t0: t, t1: t, pts: [[t, n.gap]]};
                spans.push(cur);
            }
        }
        for (const s of spans.filter(x => x.t1 - x.t0 >= 30)) {
            const marks = [s.t0];
            for (const c of cuts) {
                if (c - marks[marks.length - 1] >= 20 && s.t1 - c >= 20) {
                    marks.push(c);
                }
            }
            marks.push(s.t1);
            const all = [marks[0]];
            for (let k = 0; k + 1 < marks.length; k++) {
                all.push(...gapTurns(s.pts.filter(([t]) => t >= marks[k] && t <= marks[k + 1])), marks[k + 1]);
            }
            const pieces = [];
            for (let k = 0; k + 1 < all.length; k++) {
                const a = all[k];
                const b = all[k + 1];
                const ga = b - a >= 30 && neighbourAt(ctx, a, side);
                const gb = b - a >= 30 && neighbourAt(ctx, b, side);
                if (!ga || !gb) {
                    continue;
                }
                const rate = (gb.gap - ga.gap) / (b - a) * 60;
                const p = ctx.S.power.avg(a, b);
                const last = pieces[pieces.length - 1];
                // Two stretches next to each other are one when the gap moved at the same rate and
                // you rode about the same power: a cut earns its place only when something differed.
                if (last && last.b === a && Math.abs(last.rate - rate) < 0.5 && isNum(p) && isNum(last.p) &&
                    Math.abs(p - last.p) <= 0.1 * last.p) {
                    last.b = b;
                    last.gb = gb;
                    last.rate = (gb.gap - last.ga.gap) / (b - last.a) * 60;
                } else {
                    pieces.push({a, b, ga, gb, rate, p});
                }
            }
            for (const {a, b, ga, gb, rate} of pieces) {
                const p = ctx.S.power.avg(a, b);
                const gp = ctx.P.groupPower.avg(a, b);
                const trend = Math.abs(rate) < 0.5 ? 'about the same' :
                    `${rate > 0 ? 'growing' : 'shrinking'} by about ${Math.abs(rate).toFixed(1)} s a minute`;
                out.push({t: a, change: Math.abs(gb.gap - ga.gap), side, seqs: ga.seqs,
                    text: `${fmtClock(a)} to ${fmtClock(b)}: group ${side} (\u0000) ` +
                        `went from ${fmtGap(ga.gap)} to ${fmtGap(gb.gap)}, ${trend}; your power ` +
                        `${isNum(p) ? `${Math.round(p)} W` : '?'}` +
                        `${isNum(gp) ? `, your group's average ${Math.round(gp)} W` : ''}.`});
            }
        }
    }
    if (!out.length) {
        return ['No group ahead or behind stayed the same group for 30 seconds or more.'];
    }
    const keep = new Set();
    for (const side of ['ahead', 'behind']) {
        const last = out.filter(x => x.side === side).sort((x, y) => y.t - x.t)[0];
        if (last) {
            keep.add(last);
        }
    }
    for (const x of out.slice().sort((x, y) => y.change - x.change)) {
        if (keep.size >= max) {
            break;
        }
        keep.add(x);
    }
    // A group is named the first time it appears here, and after that only as the same riders.
    const named = new Set();
    const lines = [...keep].sort((x, y) => x.t - y.t).map(x => {
        const key = `${x.side}|${[...x.seqs].sort((a, b) => a - b).join(',')}`;
        const who = named.has(key) ? 'same riders' : listNames(x.seqs.map(ctx.nameOfSeq), 3);
        named.add(key);
        return x.text.replace('\u0000', who);
    });
    if (out.length > keep.size) {
        lines.push(`${out.length - keep.size} smaller stretches are not listed.`);
    }
    return lines;
}

// A gap has turned when it strays this far from a straight line between the ends of a stretch.
const GAP_TURN_SECONDS = 2;
const GAP_TURN_SHARE = 0.2;

/*
 * The seconds inside one stretch of [t, gap] points where the gap turned or levelled off: the point
 * furthest from the straight line between the ends, when it is at least GAP_TURN_SECONDS and
 * GAP_TURN_SHARE of the range the gap covered away from it, then the same again either side of
 * it. Each part is kept at least 20 s long.
 */
export function gapTurns(pts) {
    if (pts.length < 3) {
        return [];
    }
    const [ta, ga] = pts[0];
    const [tb, gb] = pts[pts.length - 1];
    let lo = Infinity;
    let hi = -Infinity;
    let worst = -1;
    let far = 0;
    for (let i = 0; i < pts.length; i++) {
        const [t, g] = pts[i];
        lo = Math.min(lo, g);
        hi = Math.max(hi, g);
        const d = Math.abs(g - (ga + (gb - ga) * (t - ta) / Math.max(1, tb - ta)));
        if (d > far && t - ta >= 20 && tb - t >= 20) {
            far = d;
            worst = i;
        }
    }
    if (worst === -1 || far < Math.max(GAP_TURN_SECONDS, GAP_TURN_SHARE * (hi - lo))) {
        return [];
    }
    return [...gapTurns(pts.slice(0, worst + 1)), pts[worst][0], ...gapTurns(pts.slice(worst))];
}

/* When the gap to the group ahead or behind first passed 10, 30, 60 and 90 seconds, or came back under. */
export function gapMilestoneLines(ctx, {thresholds = [10, 30, 60, 90], max = 8} = {}) {
    if (!ctx.hasMoves) {
        return [];
    }
    const out = [];
    for (const side of ['ahead', 'behind']) {
        let lastBand = null;
        let last = null;
        const lastCross = new Map();
        const firsts = new Set();
        for (const t of (ctx.pack.t || []).filter(x => x <= ctx.line)) {
            const n = groupAt(ctx, t, side);
            if (!n) {
                lastBand = null;
                last = null;
                continue;
            }
            if (!isNum(n.gap)) {
                continue;
            }
            const band = thresholds.filter(x => n.gap >= x).length;
            if (lastBand != null && sameGroup(last, n.seqs) && band !== lastBand) {
                const crossed = band > lastBand ? thresholds[band - 1] : thresholds[band];
                // A gap wobbling across a line is one crossing, not one a second; and a group
                // passing a line it already passed the same way is not listed again.
                const once = `${crossed}|${band > lastBand}|${[...n.seqs].sort((a, b) => a - b).join(',')}`;
                if (t - (lastCross.get(crossed) ?? -Infinity) >= 60 && !firsts.has(once)) {
                    lastCross.set(crossed, t);
                    firsts.add(once);
                    out.push({t, text: `${fmtClock(t)}: the gap to the group ${side} ` +
                        `(${listNames(n.seqs.map(ctx.nameOfSeq), 3)}) ${band > lastBand ? 'grew past' : 'came under'} ` +
                        `${crossed} s.`});
                }
            }
            lastBand = band;
            last = n.seqs;
        }
    }
    // More than `max`: spread over the race rather than the first few, so the last lap is there.
    out.sort((a, b) => a.t - b.t);
    const picked = out.length <= max ? out : max <= 1 ? out.slice(out.length - max) :
        Array.from({length: max}, (_, i) => out[Math.round(i * (out.length - 1) / (max - 1))]);
    return picked.map(x => x.text);
}


/* ------------------------------------------------------------------ the finish */

/*
 * The rider's finish, worked out once so the AI does not have to: where the rider crossed within
 * their own group, the groups ahead and behind, and the one live position to use.
 */
export function finishLines(ctx, {officialResults, maxNames = 6}) {
    const {rec, line} = ctx;
    const L = [];
    if (!ctx.finished) {
        L.push('This recording did not reach the finish line, so your finish is not known.');
        return L;
    }
    L.push(`You crossed the line at ${fmtClock(ctx.crossedAt)}.`);
    const al = afterLineFacts(rec);
    const size = ctx.P.size.at(line, ctx.packNear);
    if (ctx.hasMoves) {
        const g = ctx.replay.groupsAt(line);
        const mates = g['0'].map(ctx.keyOfSeq).filter(k => k != null);
        L.push(`Your group at the line: ${plural(mates.length + 1, 'rider')} including you` +
            `${isNum(size) && size !== mates.length + 1 ? ` (Sauce's own count on its last row: ${size})` : ''}.`);
        if (!al) {
            L.push('The recorder did not watch past the line, so where you crossed within your group is not known.');
        } else if (al.onClock) {
            L.push('This event ended on the clock, for every rider at once, so nobody crossed a line ' +
                'behind you and your place within your group is not known.');
        } else {
            const byKey = new Map(al.arrivals.map(a => [String(a.key), a]));
            const mateKeys = new Set(mates.map(String));
            const behind = mates.map(k => byKey.get(String(k))).filter(Boolean).sort((a, b) => a.gap - b.gap);
            // Riders of the rider's own group who were ahead of the rider as the rider reached the
            // line; a recording made before the mod kept them has null here and can only say who
            // came in after.
            const ahead = al.aheadInGroup ? al.aheadInGroup
                .filter(a => mateKeys.has(String(a.key)) && !byKey.has(String(a.key)))
                .sort((a, b) => b.gap - a.gap) : null;
            const unseen = mates.length - behind.length - (ahead ? ahead.length : 0);
            const size = mates.length + 1;
            const behindText = behind.length ?
                `${behind.length} reached the line after you, ${behind[0].gap.toFixed(1)} to ` +
                `${behind[behind.length - 1].gap.toFixed(1)} s behind` : null;
            const aheadText = ahead && ahead.length ?
                `${ahead.length} ${ahead.length === 1 ? 'was' : 'were'} ahead of you on the road as you reached it, ` +
                `${Math.abs(ahead[0].gap).toFixed(1)} to ${Math.abs(ahead[ahead.length - 1].gap).toFixed(1)} s` : null;
            if (!mates.length) {
                L.push('Nobody else was in your group at the line.');
            } else if (unseen === 0 && ahead) {
                L.push(`On the road you crossed ${ordinal(ahead.length + 1)} of your group of ${size}: ` +
                    `${[aheadText, behindText].filter(Boolean).join('; ')}.`);
            } else if (unseen === 0) {
                L.push(`All ${behind.length} other riders of your group reached the line after you, ` +
                    `${behind[0].gap.toFixed(1)} to ${behind[behind.length - 1].gap.toFixed(1)} s behind. ` +
                    'None is recorded crossing before you, so on the road you crossed first of your group.');
            } else if (ahead) {
                L.push(`Of the other ${mates.length} riders of your group, ` +
                    `${[aheadText, behindText].filter(Boolean).join('; ') || 'none was recorded either side of you'}` +
                    `; ${unseen} ${unseen === 1 ? 'was' : 'were'} not recorded ` +
                    `either way. Your place within your group is not known: between ${ordinal(ahead.length + 1)} ` +
                    `and ${ordinal(ahead.length + 1 + unseen)} of ${size}.`);
            } else {
                L.push(`${behind.length} of the other ${mates.length} riders of your group reached the line ` +
                    `after you; ${unseen} ${unseen === 1 ? 'was' : 'were'} not recorded reaching it after you ` +
                    'and may have crossed before you. Your place within your group is not known.');
            }
            const close = [
                ...(ahead || []).filter(a => Math.abs(a.gap) <= FINISH_CLOSE_SECONDS)
                    .map(a => `${ctx.nameOfKey(a.key)} ${Math.abs(a.gap).toFixed(1)} s ahead`),
                ...behind.filter(a => a.gap <= FINISH_CLOSE_SECONDS)
                    .map(a => `${ctx.nameOfKey(a.key)} ${a.gap.toFixed(1)} s behind`),
            ];
            if (close.length) {
                L.push(`Within about ${FINISH_CLOSE_SECONDS.toFixed(1)} s of you, which is inside the error of ` +
                    `Sauce's live gaps: ${close.join(', ')}. The order between you and these riders is not certain.`);
            }
        }
        // The groups either side from the log, with Sauce's gap only from a row whose group there
        // is the same size (gapAt): a fragment that formed in the last seconds is not their gap.
        const ga = groupAt(ctx, line, 'ahead');
        if (ga) {
            L.push(`Group ahead: ${plural(ga.seqs.length, 'rider')} (${listNames(ga.seqs.map(ctx.nameOfSeq), maxNames)})` +
                `${isNum(ga.gap) ? `, ${fmtGap(ga.gap)} up the road as you crossed. That is a gap on the road` :
                    '. Sauce\'s gap to these riders as you crossed could not be matched to them, so it is not known'}` +
                '; when they crossed is not recorded.');
        }
        if (g['-2'].length) {
            L.push(`${plural(g['-2'].length, 'more rider')} in groups further up the road.`);
        }
        const gb = groupAt(ctx, line, 'behind');
        if (gb) {
            const keys = new Set(gb.seqs.map(ctx.keyOfSeq).map(String));
            const came = al && !al.onClock ? al.arrivals.filter(a => keys.has(String(a.key))) : [];
            L.push(`Group behind: ${plural(gb.seqs.length, 'rider')} (${listNames(gb.seqs.map(ctx.nameOfSeq), maxNames)})` +
                (came.length ?
                    `; the first of them reached the line ${fmtGap(came[0].gap)} after you, and ` +
                    `${came.length} of the ${gb.seqs.length} reached it while the recorder watched. ` +
                    'For their finish, use that time to the line, not a road gap.' :
                    `${isNum(gb.gap) ? `, ${fmtGap(gb.gap)} back on the road as you crossed` : ''}. ` +
                    'When they reached the line is not recorded.'));
        }
    } else {
        L.push(`Your group at the line: ${isNum(size) ? `${size} riders` : 'not known'}. Who was in the ` +
            'other groups was not recorded by the version of the mod that made this recording.');
    }
    if (al && al.stillOnRoad) {
        L.push(`Riders behind you not yet at the line when the recorder stopped watching: ${al.stillOnRoad}.`);
    }
    const pos = isNum(rec.finishPosition) ?
        `${rec.finishPosition}${isNum(rec.finishParticipants) ? ` of ${rec.finishParticipants}` : ''}` : null;
    L.push(pos ?
        `Zwift's live position as you crossed: ${pos}. It is the last thing Zwift reported at the line and ` +
        'the one to use. The position column in the rows is the live reading during the race. Neither is ' +
        'an official result.' :
        'Zwift did not report a live position at the line.');
    L.push(officialResults ? 'Official results were fetched: see OFFICIAL RESULTS AS ZWIFT RETURNED THEM.' :
        'Official results were not fetched, so the winner and the full finishing order are not known.');
    const ev = rec.event || {};
    if (isNum(ctx.lineDistance) && isNum(ev.endDistance) && Math.abs(ctx.lineDistance - ev.endDistance) > 200) {
        L.push(`Distance note, not part of the race story: Zwift's distance counter read ` +
            `${distNum(ctx, ctx.lineDistance)} ${distUnit(ctx)} at the line against the listed ` +
            `${distNum(ctx, ev.endDistance)} ${distUnit(ctx)}; every "to go" here counts back from the counter.`);
    }
    return L;
}

/* ------------------------------------------------------------------ powerups */

/*
 * One general line on what each powerup does, from general Zwift knowledge rather than anything
 * measured, and with no numbers in it. Van approved these lines on 16 Sep 2026. A powerup not in
 * this table gets no line rather than a guess.
 */
/* ------------------------------------------------------------------ terrain */

/*
 * The shape of the road, km by km. A tester, 22 Sep 2026: "You should pass it some info about the
 * elevation. My output had no idea what terrain was like." CLIMBS only gives stretches of 3% or
 * more, so the rest of the road was invisible. Elevation comes from Sauce's altitude stream where
 * the record has it, and otherwise from the grade over the distance ridden.
 */
export const TERRAIN_FLAT = 0.01;
export const TERRAIN_CLIMB = 0.03;
export const TERRAIN_DESCENT = -0.02;

/* Rise in metres, distance in metres, and steepest and most downhill grade over [t0, t1]. */
export function terrainBetween(ctx, t0, t1) {
    const own = ctx.own;
    let d0 = null;
    let d1 = null;
    let a0 = null;
    let a1 = null;
    let rise = 0;
    let max = null;
    let min = null;
    let prevD = null;
    for (let i = ctx.S.grade.lower(t0); i < own.t.length && own.t[i] <= t1; i++) {
        const d = own.eventDistance[i];
        const g = own.grade[i];
        const a = own.altitude ? own.altitude[i] : null;
        if (isNum(d)) {
            d0 = d0 == null ? d : d0;
            if (isNum(prevD) && isNum(g) && d > prevD) {
                rise += g * (d - prevD);
            }
            prevD = d;
            d1 = d;
        }
        if (isNum(a)) {
            a0 = a0 == null ? a : a0;
            a1 = a;
        }
        if (isNum(g)) {
            max = max == null || g > max ? g : max;
            min = min == null || g < min ? g : min;
        }
    }
    if (!isNum(d0) || !isNum(d1) || d1 <= d0) {
        return null;
    }
    // Sauce's altitude where the record has it for the whole stretch, else the grade summed.
    const byAlt = isNum(a0) && isNum(a1) && own.altitude[ctx.S.grade.lower(t0)] != null;
    return {dist: d1 - d0, rise: byAlt ? a1 - a0 : rise, max, min};
}

// A grade as a percentage with one decimal, and never "-0.0%".
const pct = g => `${(Math.abs(g) < 0.0005 ? 0 : g * 100).toFixed(1)}%`;

export function terrainWord({dist, rise, max, min}) {
    const avg = rise / dist;
    if (avg >= TERRAIN_CLIMB) {
        return 'climbing';
    }
    if (avg <= TERRAIN_DESCENT) {
        return 'descending';
    }
    if (Math.abs(avg) < TERRAIN_FLAT && (max ?? 0) < TERRAIN_CLIMB && (min ?? 0) > TERRAIN_DESCENT) {
        return 'flat';
    }
    return avg > 0 ? 'rolling, mostly up' : avg < 0 ? 'rolling, mostly down' : 'rolling';
}

/* A few words on the road over [t0, t1], for a key moment. */
export function terrainText(ctx, t0, t1) {
    const x = terrainBetween(ctx, t0, t1);
    if (!x) {
        return null;
    }
    return `${terrainWord(x)}, ${x.rise >= 0 ? '+' : ''}${Math.round(x.rise)} m over ` +
        `${distNum(ctx, x.dist)} ${distUnit(ctx)} (${pct(x.rise / x.dist)} average)`;
}

/*
 * Stretches of road by what it was doing: cut wherever the gradient changed character, never
 * shorter than TERRAIN_MIN_METRES, instead of a row every km. Van, 22 Sep 2026: one row a km "doesn't
 * seem frequent enough", and a 150 m kick hides in a km's average.
 */
export const TERRAIN_MIN_METRES = 200;
const TERRAIN_SAMPLE_METRES = 50;
const TERRAIN_KINDS = [
    [0.06, 'steep climb'], [0.03, 'climb'], [0.01, 'drag'], [-0.01, 'flat'], [-0.03, 'gentle descent'],
    [-Infinity, 'descent'],
];
const terrainKind = g => TERRAIN_KINDS.find(([min]) => g >= min)[1];

/* Elevation and race time by distance ridden, one sample every TERRAIN_SAMPLE_METRES. */
function terrainProfile(ctx) {
    const own = ctx.own;
    const {first, line} = ctx;
    const pts = [];
    let elev = 0;
    let prevD = null;
    const byAlt = own.altitude && own.altitude.some(isNum);
    for (let i = 0; i < own.t.length; i++) {
        const t = own.t[i];
        const d = own.eventDistance[i];
        if (t < first || t > line || !isNum(d)) {
            continue;
        }
        const g = own.grade[i];
        const a = own.altitude ? own.altitude[i] : null;
        if (isNum(prevD) && isNum(g) && d > prevD) {
            elev += g * (d - prevD);
        }
        prevD = d;
        pts.push({d, t, e: byAlt && isNum(a) ? a : null, ge: elev});
    }
    // Sauce's altitude where it covers the stretch, the summed grade before it, joined at the seam.
    const firstAlt = pts.findIndex(p => p.e != null);
    if (firstAlt > 0) {
        const shift = pts[firstAlt].e - pts[firstAlt].ge;
        for (let i = 0; i < firstAlt; i++) {
            pts[i].e = pts[i].ge + shift;
        }
    }
    for (const p of pts) {
        p.e = p.e ?? p.ge;
    }
    const out = [];
    let k = 0;
    for (let d = pts.length ? pts[0].d : 0; pts.length && d <= pts[pts.length - 1].d; d += TERRAIN_SAMPLE_METRES) {
        while (k + 1 < pts.length && pts[k + 1].d <= d) {
            k++;
        }
        const a = pts[k];
        const b = pts[Math.min(k + 1, pts.length - 1)];
        const f = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
        out.push({d, e: a.e + (b.e - a.e) * f, t: a.t + (b.t - a.t) * f});
    }
    return out;
}

/* The road as runs of one kind, none shorter than minMetres: {prof, g, runs: [{kind, i, j}]}, or null. */
export function terrainRuns(ctx, minMetres = TERRAIN_MIN_METRES, maxRows = Infinity) {
    const prof = ctx._terrainProfile || (ctx._terrainProfile = terrainProfile(ctx));
    if (prof.length < 10) {
        return null;
    }
    // The gradient of each sample over the 100 m around it, so one noisy reading is not a stretch.
    const g = prof.map((p, i) => {
        const a = prof[Math.max(0, i - 1)];
        const b = prof[Math.min(prof.length - 1, i + 1)];
        return b.d > a.d ? (b.e - a.e) / (b.d - a.d) : 0;
    });
    const build = minMetres => {
        let runs = [];
        for (let i = 0; i < prof.length - 1; i++) {
            const kind = terrainKind(g[i]);
            const last = runs[runs.length - 1];
            if (last && last.kind === kind) {
                last.j = i + 1;
            } else {
                runs.push({kind, i, j: i + 1});
            }
        }
        // Fold runs shorter than minMetres into the neighbour they are most like, shortest first.
        const len = r => prof[r.j].d - prof[r.i].d;
        const grade = r => (prof[r.j].e - prof[r.i].e) / Math.max(1, len(r));
        for (;;) {
            let si = -1;
            for (let x = 0; x < runs.length; x++) {
                if (len(runs[x]) < minMetres && (si < 0 || len(runs[x]) < len(runs[si]))) {
                    si = x;
                }
            }
            if (si < 0 || runs.length === 1) {
                break;
            }
            const r = runs[si];
            const left = runs[si - 1];
            const right = runs[si + 1];
            const near = !left ? right : !right ? left :
                Math.abs(grade(left) - grade(r)) <= Math.abs(grade(right) - grade(r)) ? left : right;
            near.i = Math.min(near.i, r.i);
            near.j = Math.max(near.j, r.j);
            runs.splice(si, 1);
            near.kind = terrainKind(grade(near));
            // Two neighbours now of one kind become one stretch.
            runs = runs.reduce((acc, x) => {
                const p = acc[acc.length - 1];
                if (p && p.kind === x.kind) {
                    p.j = x.j;
                } else {
                    acc.push(x);
                }
                return acc;
            }, []);
        }
        return runs;
    };
    let runs = build(minMetres);
    while (runs.length > maxRows) {
        minMetres *= 2;
        runs = build(minMetres);
    }
    return {prof, g, runs, minMetres};
}

export function terrainLines(ctx, {maxRows = 40} = {}) {
    const tr = terrainRuns(ctx, TERRAIN_MIN_METRES, maxRows);
    if (!tr) {
        return ['Not enough distance was recorded to describe the road.'];
    }
    const {prof, g, runs, minMetres} = tr;
    const u = distUnit(ctx);
    const end = ctx.toGoFrom ?? prof[prof.length - 1].d;
    const togo = m => distNum(ctx, Math.max(0, end - m));
    const L = [`The road in stretches of one kind, none shorter than ${minMetres} m: from-to ${u} to go | ` +
        'race time | length | rise or fall | average | steepest 100 m | the road.'];
    let up = 0;
    let down = 0;
    for (const r of runs) {
        const a = prof[r.i];
        const b = prof[r.j];
        const rise = b.e - a.e;
        const steep = Math.max(...g.slice(r.i, r.j));
        const low = Math.min(...g.slice(r.i, r.j));
        up += Math.max(0, rise);
        down += Math.max(0, -rise);
        L.push(`${togo(a.d)}-${togo(b.d)} | ${fmtClock(a.t)}-${fmtClock(b.t)} | ${Math.round(b.d - a.d)} m | ` +
            `${rise >= 0 ? '+' : ''}${Math.round(rise)} m | ${pct(rise / (b.d - a.d))} | ` +
            `${pct(r.kind.includes('descent') ? low : steep)} | ${r.kind}`);
    }
    L.push(`In all about ${Math.round(up)} m up and ${Math.round(down)} m down. Steep climb 6% or more, ` +
        'climb 3 to 6%, drag 1 to 3%, flat within 1%, gentle descent -1 to -3%, descent steeper; for a ' +
        'descent the steepest column is the steepest downhill.');
    return L;
}


/* ------------------------------------------------------------------ who did what in your group */

/*
 * From each rider's power and draft while in the rider's group (WHO DID WHAT IN YOUR GROUP in
 * recorder.mjs). Van, 22 Sep 2026: use it "to call out things like most and least in the draft...
 * and highest and least power". A rider counts in a stretch only when they were in the group for at
 * least IN_GROUP_MIN_SHARE of the time the most present rider was, so a rider who passed through for
 * ten seconds does not top a list.
 */
export const IN_GROUP_MIN_SHARE = 0.3;
// Time out of the draft counts as shared when this many riders each had at least a fifth of it.
const SHARED_SHARE = 0.2;

export function hasInGroup(rec) {
    return !!(rec.inGroup && Array.isArray(rec.inGroup.t) && rec.inGroup.t.length);
}

/* Each rider's numbers in the rider's group over [t0, t1), as [{seq, n, power, draft, windShare, wind}]. */
export function inGroupStats(ctx, t0 = -Infinity, t1 = Infinity) {
    const g = ctx.rec.inGroup;
    const by = new Map();
    for (let i = 0; i < (g && g.t ? g.t.length : 0); i++) {
        const t = g.t[i];
        if (t < t0 || t >= t1 || t > ctx.line) {
            continue;
        }
        const x = by.get(g.rider[i]) || {seq: g.rider[i], n: 0, p: 0, d: 0, wind: 0};
        x.n += g.n[i];
        x.p += g.power[i] * g.n[i];
        x.d += g.draft[i] * g.n[i];
        x.wind += g.wind[i];
        by.set(g.rider[i], x);
    }
    const all = [...by.values()];
    const most = Math.max(0, ...all.map(x => x.n));
    return all.filter(x => x.n >= most * IN_GROUP_MIN_SHARE && x.n > 0).map(x => ({
        seq: x.seq, n: x.n, power: x.p / x.n, draft: x.d / x.n, wind: x.wind, windShare: x.wind / x.n,
    }));
}

const riderName = (ctx, seq) => seq === -1 ? 'you' : ctx.nameOfSeq(seq);

/* The lines for one stretch; `brief` gives one line for a key moment. */
export function inGroupLines(ctx, t0, t1, {brief = false} = {}) {
    const xs = inGroupStats(ctx, t0, t1);
    if (xs.length < 2) {
        return [];
    }
    const list = (arr, f, k) => arr.slice(0, k).map(x => `${riderName(ctx, x.seq)} (${f(x)})`).join(', ');
    const k = brief ? 1 : 2;
    const byDraft = [...xs].sort((a, b) => b.draft - a.draft);
    const byPower = [...xs].sort((a, b) => b.power - a.power);
    const byWind = [...xs].sort((a, b) => b.windShare - a.windShare);
    const totalWind = xs.reduce((a, x) => a + x.wind, 0);
    const w = x => `${Math.round(x.draft)} W of draft`;
    const pw = x => `${Math.round(x.power)} W`;
    const ws = x => `${Math.round(x.windShare * 100)}% of the time with no draft`;
    let shared = '';
    if (totalWind > 0) {
        const big = xs.filter(x => x.wind / totalWind >= SHARED_SHARE);
        const top = byWind[0];
        const most = [...xs].sort((a, b) => b.wind - a.wind)[0];
        const whose = most.seq === -1 ? 'yours' : `${riderName(ctx, most.seq)}'s`;
        const share = most.wind / totalWind;
        const withWind = xs.filter(x => x.wind > 0).length;
        shared = big.length >= 3 ? `the time with no draft was shared: ${big.length} riders each had a fifth or more of it` :
            share >= 0.4 ? `the time with no draft was mostly ${whose} (${Math.round(share * 100)}% of it)` :
            `the time with no draft was spread across ${withWind} riders, the most ${whose} at ${Math.round(share * 100)}% of it`;
        void top;
    }
    const windy = byWind.filter(x => x.windShare > 0);
    const parts = [
        `most draft ${list(byDraft, w, k)}; least ${list([...byDraft].reverse(), w, k)}`,
        `highest power ${list(byPower, pw, k)}; lowest ${list([...byPower].reverse(), pw, k)}`,
        windy.length ? `longest with no draft ${list(windy, ws, k)}` : 'nobody had any time with no draft',
        shared,
    ].filter(Boolean);
    return brief ? [`In your group (${xs.length} riders with numbers): ${parts.join('; ')}.`] :
        parts.map(x => `${x[0].toUpperCase()}${x.slice(1)}.`);
}

export function inGroupSection(ctx) {
    if (!hasInGroup(ctx.rec)) {
        return [ctx.rec.schema >= 5 ?
            'Nobody\'s power or draft was recorded in your group, so who did what in it is not known.' :
            'The version of the mod that made this recording did not keep other riders\' numbers, so who did what in your group is not known.'];
    }
    const xs = inGroupStats(ctx);
    return [
        'Each rider\'s own power and draft while in your group, from Sauce\'s live numbers, averaged over ' +
        'the time they were in it; "you" is the rider whose recording this is. Draft is the watts Sauce ' +
        'says the draft saved. No draft means in the wind, at the front or the side of the group: it is ' +
        'not proof of being on the front. Riders in your group for under a third of the time are left out.',
        `The whole race (${xs.length} riders):`,
        ...inGroupLines(ctx, -Infinity, Infinity),
    ];
}


/* ------------------------------------------------------------------ the groups on the road */

/*
 * Every group in view, not just the ones next to the rider's (THE GROUPS ON THE ROAD in
 * recorder.mjs). A tester, 22 Sep 2026: "a good race report would have called out the group
 * splitting apart ahead of me." Splits and merges of other groups are found by Sauce's own group id,
 * which it carries from one second to the next by who is in the group (src/stats.mjs:4617-4640), and
 * only once they have held ROAD_HOLD_SECONDS, so a group that flickers apart for a payload is no
 * split. Sizes, gaps, power and speed only: who is in a group further away is not recorded.
 */
export const ROAD_HOLD_SECONDS = 10;
const ROAD_EVENTS = 12;

export function hasRoadGroups(rec) {
    return !!(rec.roadGroups && Array.isArray(rec.roadGroups.t) && rec.roadGroups.t.length);
}

/* The pack rows' groups, as [t, [{rel, id, size, gap, power, speed}, ...]] in time order. */
function roadRows(ctx) {
    if (ctx._roadRows) {
        return ctx._roadRows;
    }
    const g = ctx.rec.roadGroups;
    const by = new Map();
    for (let i = 0; i < g.t.length; i++) {
        if (g.t[i] > ctx.line) {
            continue;
        }
        const list = by.get(g.t[i]) || [];
        list.push({rel: g.rel[i], id: g.id[i], size: g.size[i], gap: g.gap[i], power: g.power[i], speed: g.speed[i]});
        by.set(g.t[i], list);
    }
    return (ctx._roadRows = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, l]) => [t, l.sort((a, b) => a.rel - b.rel)]));
}

const fmtRoadGap = g => isNum(g) ? fmtGap(Math.abs(g)) : '?';

/* The splits and merges of groups other than the rider's that held, in time order. */
export function roadEvents(ctx) {
    const rows = roadRows(ctx);
    const events = [];
    const seen = new Map();   // id -> [{t, size, rel, gap}]
    for (const [t, list] of rows) {
        for (const x of list) {
            if (x.id == null || x.rel === 0 || !isNum(x.size)) {
                continue;
            }
            const h = seen.get(x.id) || [];
            h.push({t, size: x.size, rel: x.rel, gap: x.gap});
            seen.set(x.id, h);
        }
    }
    const rowAt = t => rows.find(([rt]) => rt >= t) || null;
    for (const [id, h] of seen) {
        let lastAt = -Infinity;
        for (let i = 1; i < h.length; i++) {
            const t = h[i].t;
            const before = h.filter(x => x.t >= t - ROAD_HOLD_SECONDS && x.t < t);
            const after = h.filter(x => x.t >= t && x.t <= t + ROAD_HOLD_SECONDS);
            if (!before.length || after.length < 2 || after[after.length - 1].t - t < ROAD_HOLD_SECONDS * 0.6) {
                continue;
            }
            const was = Math.min(...before.map(x => x.size));
            const now = Math.max(...after.map(x => x.size));
            const lost = was - now;
            if (lost >= 2 && lost / was >= 0.25 && t - lastAt > 2 * ROAD_HOLD_SECONDS) {
                // The part that left: a group next to this one after the hold, about that size.
                const r = rowAt(t + ROAD_HOLD_SECONDS);
                const me = r && r[1].find(x => x.id === id);
                const part = me && r[1].filter(x => Math.abs(x.rel - me.rel) === 1 && x.rel !== 0 &&
                    Math.abs(x.size - lost) <= Math.max(1, Math.round(lost * 0.3)))
                    .sort((a, b) => Math.abs(a.size - lost) - Math.abs(b.size - lost))[0];
                events.push({t, kind: 'split', side: h[i].rel < 0 ? 'ahead' : 'behind', was, now,
                             gap: h[i].gap, part: part ? {size: part.size, gap: part.gap} : null});
                lastAt = t;
            }
            const gained = now - was;
            if (gained >= 2 && gained / now >= 0.25 && t - lastAt > 2 * ROAD_HOLD_SECONDS) {
                events.push({t, kind: 'grew', side: h[i].rel < 0 ? 'ahead' : 'behind', was, now, gap: h[i].gap});
                lastAt = t;
            }
        }
    }
    return events.sort((a, b) => a.t - b.t);
}

export function roadEventLine(ctx, e) {
    const where = `${fmtClock(e.t)} (${toGoText(ctx, e.t)} ${distUnit(ctx)} to go)`;
    const which = `the group of ${e.was} ${fmtRoadGap(e.gap)} ${e.side} of yours`;
    if (e.kind === 'split') {
        return `${where}: ${which} split, ${e.now} riders left in it` +
            (e.part ? ` and ${e.part.size} now ${fmtRoadGap(e.part.gap)} ${e.side}` : '') + '.';
    }
    return `${where}: ${which} grew to ${e.now} riders as others joined it.`;
}

/*
 * One line of the road at t: up to three groups either side of the rider's, with size, gap and
 * speed. The row used is the nearest within ctx.packNear whose group of the rider's is the size the
 * membership log says (within one rider or a fifth), because a pack row is one payload and carries
 * any flicker on it: the long synthetic race's field of 55 read as "10" beside "45 @ 0.9 s".
 */
export function roadLineAt(ctx, t) {
    const rows = roadRows(ctx);
    const want = ctx.P.size.at(t, ctx.packNear);
    let best = null;
    for (const r of rows) {
        if (Math.abs(r[0] - t) > ctx.packNear) {
            continue;
        }
        const mine = r[1].find(x => x.rel === 0);
        const ok = !isNum(want) || (mine && Math.abs(mine.size - want) <= Math.max(1, want * 0.2));
        if (ok && (!best || Math.abs(r[0] - t) < Math.abs(best[0] - t))) {
            best = r;
        }
    }
    if (!best) {
        return null;
    }
    const cell = x => `${x.size}${x.rel === 0 ? '' : ` @ ${fmtRoadGap(x.gap)}`}` +
        `${isNum(x.speed) ? ` ${x.speed.toFixed(0)} km/h` : ''}`;
    const ahead = best[1].filter(x => x.rel < 0 && x.rel >= -3).map(cell);
    const mine = best[1].find(x => x.rel === 0);
    const behind = best[1].filter(x => x.rel > 0 && x.rel <= 3).map(cell);
    const more = n => n > 0 ? `; ${n} more` : '';
    // "at 2:01:", not "2:01 |", so these are never read as rows of MINUTE BY MINUTE or a key moment.
    return `at ${fmtClock(t)}: ${ahead.length ? ahead.join('; ') : '-'}${more(best[1].filter(x => x.rel < -3).length)} | ` +
        `${mine ? cell(mine) : '-'} | ${behind.length ? behind.join('; ') : '-'}${more(best[1].filter(x => x.rel > 3).length)}`;
}

export function roadGroupsSection(ctx, {factor = 1, maxEvents = ROAD_EVENTS} = {}) {
    if (!hasRoadGroups(ctx.rec)) {
        return [ctx.rec.schema >= 5 ?
            'The groups further up and down the road were not recorded for this race.' :
            'The version of the mod that made this recording kept only the groups next to yours.'];
    }
    const L = ['The groups Sauce had in view, up to three either side of yours: size @ gap to your group ' +
        'and the group\'s speed (Sauce\'s median over it), furthest ahead first. Who is in a group further ' +
        'away than the next one is not recorded.'];
    const step = overviewStep(ctx, factor);
    L.push(`Every ${step >= 120 ? `${step / 60} minutes` : 'minute'}: at race time: groups ahead | your group | groups behind`);
    for (let t = ctx.first + step; t <= ctx.line; t += step) {
        const line = roadLineAt(ctx, t);
        if (line) {
            L.push(line);
        }
    }
    const events = roadEvents(ctx);
    L.push('Splits and joins of the other groups that held ' + ROAD_HOLD_SECONDS + ' s' +
        (events.length ? ':' : ': none.'));
    L.push(...events.slice(0, maxEvents).map(e => roadEventLine(ctx, e)));
    if (events.length > maxEvents) {
        L.push(`${events.length - maxEvents} more, not listed.`);
    }
    return L;
}


/* ------------------------------------------------------------------ your race, stretch by stretch */

/*
 * A rider's own race told in order, as one tester wrote theirs (22 Sep 2026): "~1 minute off the
 * front pack, was 1:23 behind by the start of the climb, caught 1 rider on the lead up to the climb,
 * then a few riders on the climb... Briefly lost touch with [two riders] on the flat top of
 * the climb, but caught them early on the descent." Van: that belongs in the coach's debrief. These
 * are its facts: the gap to the front of the race, and for each stretch of road (each climb and the
 * road before it, then the run to the line) who came into the rider's group, who left it, and the
 * rider's own brief losses of contact, which the race commentary leaves out.
 */

/*
 * The gap from the rider's group to the front group Sauce had in view at t, in seconds (0 when the
 * rider's group was the front), from THE GROUPS ON THE ROAD, or null.
 */
export function frontGapAt(ctx, t) {
    if (!hasRoadGroups(ctx.rec)) {
        return null;
    }
    const rows = roadRows(ctx);
    let best = null;
    for (const r of rows) {
        if (Math.abs(r[0] - t) <= ctx.packNear && (!best || Math.abs(r[0] - t) < Math.abs(best[0] - t))) {
            best = r;
        }
    }
    if (!best) {
        return null;
    }
    const front = best[1][0];
    return front.rel === 0 ? 0 : isNum(front.gap) ? Math.abs(front.gap) : null;
}

const frontText = (ctx, t) => {
    const g = frontGapAt(ctx, t);
    return g == null ? null : g === 0 ? 'your group was the front group in view' : `${fmtGap(g)} behind the front group in view`;
};

/*
 * The stretches: the road cut where it changes character, none shorter than STRETCH_MIN_METRES, as a
 * rider tells it ("on the flat top of the climb", "early on the descent"), each climb by its number
 * and the stretch before one as its lead-up.
 */
const STRETCH_MIN_METRES = 1000;
const STRETCH_MAX = 12;
const ROAD_NAMES = {
    'steep climb': 'a steep climb', 'climb': 'a climb', 'drag': 'a drag', 'flat': 'the flat',
    'gentle descent': 'a gentle descent', 'descent': 'the descent',
};

function stretches(ctx, climbs) {
    const tr = terrainRuns(ctx, STRETCH_MIN_METRES, STRETCH_MAX);
    if (!tr) {
        return [{t0: ctx.first, t1: ctx.line, what: 'the race'}];
    }
    const {prof, runs} = tr;
    const out = runs.map(r => ({t0: Math.round(prof[r.i].t), t1: Math.round(prof[r.j].t), kind: r.kind}))
        .filter(x => x.t1 > x.t0);
    // Name each stretch by its road, a climb by its number in CLIMBS, and the stretch before a climb
    // as its lead-up.
    const named = out.map((x, k) => {
        const n = climbs.findIndex(c => c.t0 <= x.t1 && c.t1 >= x.t0 && Math.min(c.t1, x.t1) - Math.max(c.t0, x.t0) >= (x.t1 - x.t0) / 2);
        const next = out[k + 1];
        const nextClimb = next ? climbs.findIndex(c => c.t0 <= next.t1 && c.t1 >= next.t0) : -1;
        return {...x, t0: k === 0 ? ctx.first : x.t0, t1: k === out.length - 1 ? ctx.line : x.t1,
                climb: n, before: n < 0 && !x.kind.includes('climb') ? nextClimb : -1};
    });
    // A stretch longer than STRETCH_LONG_SECONDS is told in parts of about STRETCH_PART_SECONDS, so a
    // rider who joined and left again inside it is not lost; the last part before a climb is its lead-up.
    const parts = [];
    for (const x of named) {
        const climbName = x.climb >= 0 ? `climb ${x.climb + 1}` : null;
        const len = x.t1 - x.t0;
        const n = len > STRETCH_LONG_SECONDS ? Math.ceil(len / STRETCH_PART_SECONDS) : 1;
        for (let k = 0; k < n; k++) {
            const t0 = Math.round(x.t0 + len * k / n);
            const t1 = k === n - 1 ? x.t1 : Math.round(x.t0 + len * (k + 1) / n) - 1;
            const lead = x.before >= 0 && k === n - 1;
            // Each part named by its own road, so a rolling part of a long flat is not called flat.
            const tb = terrainBetween(ctx, t0, t1);
            const word = tb ? terrainWord(tb) : x.kind;
            const road = climbName || ({descending: 'the descent', flat: 'the flat', climbing: 'a climb'}[word] ||
                'rolling road');
            parts.push({t0, t1, what: `${road}${n > 1 && climbName ? `, part ${k + 1} of ${n}` : ''}` +
                `${lead ? `, the lead-up to climb ${x.before + 1}` : ''}`});
        }
    }
    return parts;
}
const STRETCH_LONG_SECONDS = 360;
const STRETCH_PART_SECONDS = 240;

export function stretchLines(ctx, {climbs = [], maxNames = 6} = {}) {
    if (!ctx.hasMoves) {
        return ['Who came into and left your group was not recorded by the version of the mod that made this recording.'];
    }
    const names = seqs => listNames(seqs.map(ctx.nameOfSeq), maxNames);
    const L = ['Your own race in order, stretch by stretch: the gap from your group to the front group Sauce ' +
        'had in view (Sauce sees about fifteen minutes either way), and who was in your group at the end of ' +
        'each stretch but not at its start, and the reverse. Riders who left and came back inside a stretch ' +
        'are not counted. "Lost contact" is you leaving your group behind.'];
    const start = frontText(ctx, ctx.first + 30);
    if (start) {
        L.push(`Early on (${fmtClock(ctx.first + 30)}): ${start}.`);
    }
    for (const st of stretches(ctx, climbs)) {
        // Net: where each rider was at the start and at the end of the stretch.
        const at0 = new Map(ctx.replay.at(Math.max(st.t0, ctx.placedFrom ?? st.t0)));
        const at1 = new Map(ctx.replay.at(st.t1));
        const seqs = new Set([...at0.keys(), ...at1.keys()]);
        const caught = [];
        const joined = [];
        const ahead = [];
        const behind = [];
        for (const q of seqs) {
            const a = at0.get(q) ?? null;
            const b = at1.get(q) ?? null;
            if (a === b) {
                continue;
            }
            if (b === 0) {
                (isNum(a) && a < 0 ? caught : joined).push(q);
            } else if (a === 0) {
                (isNum(b) && b < 0 ? ahead : behind).push(q);
            }
        }
        const road = terrainText(ctx, st.t0, st.t1);
        const f0 = frontText(ctx, st.t0);
        const f1 = frontText(ctx, st.t1);
        const bits = [];
        if (caught.length) {
            bits.push(`${plural(caught.length, 'rider')} from ahead now in your group (${names(caught)})`);
        }
        if (behind.length) {
            bits.push(`${plural(behind.length, 'rider')} of your group now behind you or out of view (${names(behind)})`);
        }
        if (ahead.length) {
            bits.push(`${plural(ahead.length, 'rider')} of your group now ahead of you (${names(ahead)})`);
        }
        if (joined.length) {
            bits.push(`${plural(joined.length, 'rider')} from behind now in your group (${names(joined)})`);
        }
        L.push(`${st.what}, ${fmtClock(st.t0)} to ${fmtClock(st.t1)} (${toGoText(ctx, st.t0)} to ` +
            `${toGoText(ctx, st.t1)} ${distUnit(ctx)} to go)${road ? `, ${road}` : ''}: ` +
            `${bits.length ? bits.join('; ') : 'your group the same riders at the end as at the start'}` +
            `${f0 && f1 ? `. Front: ${f0} at the start, ${f1} at the end` : ''}.`);
    }
    // The rider's own brief losses of contact: most of the group ahead of the rider, back within
    // REJOIN_SECONDS. The race commentary leaves these out; for the rider they are part of the story.
    moveClusters(ctx);
    for (const c of (ctx._allClusters || []).filter(c => c.kind === 'clear' && c.back)) {
        const stayed = ctx.replay.groupsAt(c.t)['0'].length + 1;
        if (c.seqs.length < stayed) {
            continue;
        }
        L.push(`${fmtClock(c.t)}: you lost contact with ${names(c.seqs)} (${terrainText(ctx, c.t - 15, c.t + 15) || 'road not known'}), ` +
            `back with them at ${fmtClock(c.back.t)} (${terrainText(ctx, c.back.t - 15, c.back.t + 15) || 'road not known'}).`);
    }
    const end = frontText(ctx, ctx.line);
    if (end) {
        L.push(`At the line: ${end}.`);
    }
    return L;
}


/* ------------------------------------------------------------------ the race in brief */

/*
 * Van's testers, 18 Sep 2026: both texts should open with an overview of the race before the
 * detail. These lines are what that overview is written from, worked out here so the AI does not
 * piece the big picture together from rows: the field, the winner, when the field Sauce could see
 * was last one group, where the riders who finished ahead of the rider were last in the rider's
 * group, and how the rider finished. The window shows them too, as its first section.
 */

/* A place as results give it: 1st, 2nd, 9th, 11th. */
const nth = n => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

/* The rider's own row of the official results, or null. */
export function ownResult(rec) {
    const res = rec.results || [];
    const selfName = rec.self && rec.self.name;
    return res.find(r => r.isSelf) || (selfName ? res.find(r => r.name === selfName) : null) || null;
}

/* The key in rec.riders of the rider whose results row this is, matched by name, or null. */
function riderKeyOfResult(rec, r) {
    if (!r || !r.name) {
        return null;
    }
    const hit = Object.entries(rec.riders || {}).find(([, x]) => x.name === r.name);
    return hit ? hit[0] : null;
}

/* The last second before the line the rider with this seq left the rider's group, or null. */
function lastLeftGroup(ctx, seq) {
    let last = null;
    for (const [t, s, from, , first] of ctx.replay.list) {
        if (t > ctx.line) {
            break;
        }
        if (s === seq && from === 0 && !first) {
            last = t;
        }
    }
    return last;
}

/* The place (-2..2, 0 = the rider's group) of the rider with this seq at the line, or null out of view. */
function placeAtLine(ctx, seq) {
    const p = ctx.replay.at(ctx.line).get(seq);
    return p == null ? null : p;
}

export function raceBriefLines(ctx, {climbs = [], nameOfResult = r => r.name, field = false} = {}) {
    const {rec, line} = ctx;
    const L = [];
    const res = rec.results || [];
    const finished = res.filter(r => isNum(r.timeSeconds));
    const dnf = res.filter(r => /DNF/.test(r.flags || ''));
    const dns = res.filter(r => /DNS/.test(r.flags || ''));
    const own = ownResult(rec);
    if (res.length) {
        L.push(`The field, from the official results: ${finished.length + dnf.length} started, ` +
            `${finished.length} finished, ${dnf.length} did not finish` +
            `${dns.length ? `, and ${dns.length} signed up and did not start` : ''}.`);
        const win = res.find(r => r.place === 1);
        if (win) {
            L.push(`The winner: ${nameOfResult(win)}, in ${fmtDuration(win.timeSeconds)}.`);
        }
        if (field) {
            const podium = res.filter(r => isNum(r.place) && r.place <= 3).sort((a, b) => a.place - b.place);
            if (podium.length > 1) {
                L.push(`The podium: ${podium.map(r => `${nth(r.place)} ${nameOfResult(r)}, ${fmtDuration(r.timeSeconds)}`).join('; ')}.`);
            }
        }
        if (own && isNum(own.place) && !field) {
            L.push(`You: ${nth(own.place)} of ${finished.length} finishers, in ` +
                `${fmtDuration(own.timeSeconds)}` +
                `${win && isNum(win.timeSeconds) && own.place !== 1 ?
                    `, ${(own.timeSeconds - win.timeSeconds).toFixed(1)} s behind the winner` : ''}.`);
        }
    } else {
        const n = [...(ctx.tl.eventParticipants || [])].reverse().find(isNum);
        L.push(`Official results were not fetched, so the winner and the full order are not known.` +
            `${isNum(n) ? ` Zwift's live count of riders in the event at the end: ${n}.` : ''}`);
    }

    // When every rider Sauce had in view was last one group, for ten seconds or more.
    const pack = ctx.pack;
    let runStart = null;
    let together = null;
    for (let i = 0; i < (pack.t || []).length && pack.t[i] <= line; i++) {
        if ((pack.groupsVisible || [])[i] === 1) {
            runStart = runStart == null ? pack.t[i] : runStart;
            if (pack.t[i] - runStart >= 10) {
                together = pack.t[i];
            }
        } else {
            runStart = null;
        }
    }
    const climbAt = t => climbs.find(c => t >= c.t0 - 10 && t <= c.t1 + 10);
    const where = t => {
        const c = climbAt(t);
        const seg = c && segmentsDuring(ctx, c.t0, c.t1)[0];
        return `${toGoText(ctx, t)} ${distUnit(ctx)} to go` +
            `${c ? `, on climb ${climbs.indexOf(c) + 1}${seg ? ` (${seg})` : ''}` : ''}`;
    };
    if (isNum(together) && ctx.hasMoves && field) {
        L.push(`Every rider Sauce had in view was in one group until ${fmtClock(together)} into the ` +
            `race, with ${where(together)}.`);
    } else if (isNum(together) && ctx.hasMoves) {
        L.push(`Every rider Sauce had in view was in one group, yours, until ${fmtClock(together)} into the ` +
            `race, with ${where(together)}. Sauce sees only the riders within a few minutes of you on the road.`);
    }

    // Where the riders who finished ahead of the rider were last in the rider's group.
    if (ctx.hasMoves) {
        let aheadKeys;
        let how;
        if (own && isNum(own.place)) {
            aheadKeys = res.filter(r => isNum(r.place) && r.place < own.place)
                .map(r => riderKeyOfResult(rec, r)).filter(k => k != null);
            how = 'finished ahead of you in the official results';
        } else {
            aheadKeys = Object.keys(rec.riders || {}).filter(k => {
                const p = placeAtLine(ctx, rec.riders[k].seq);
                return p != null && p < 0;
            });
            how = 'were in groups ahead of you at the line';
        }
        const byTime = new Map();
        let never = 0;
        for (const k of aheadKeys) {
            const seq = rec.riders[k].seq;
            const t = lastLeftGroup(ctx, seq);
            if (t == null) {
                never++;
                continue;
            }
            let slot = [...byTime.keys()].find(x => Math.abs(x - t) <= 15);
            if (slot == null) {
                slot = t;
                byTime.set(slot, []);
            }
            byTime.get(slot).push(k);
        }
        if (aheadKeys.length) {
            const parts = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, ks]) =>
                `${fmtClock(t)} into the race (${where(t)}): ${listNames(ks.map(k => ctx.nameOfKey(k)), 8)}`);
            L.push(field ?
                // The field's words: the riders who finished at the front, by when they went clear
                // of the group Sauce was watching from, which is not about the recording rider.
                `How the front of the race formed: the ${plural(aheadKeys.length, 'rider')} who finished at the front ` +
                `went clear of the group behind them at${parts.length ? ` ${parts.join('; ')}` : ''}` +
                `${never ? `${parts.length ? ';' : ''} ${never} were ahead of it all race` : ''}.` :
                `Of the ${plural(aheadKeys.length, 'rider')} Sauce saw who ${how}, the last time each ` +
                `was in your group:${parts.length ? ` ${parts.join('; ')}` : ''}` +
                `${never ? `${parts.length ? ';' : ''} ${never} never in your group while this was recorded` : ''}.`);
        }
    }

    if (ctx.finished && ctx.hasMoves && !field) {
        const mates = ctx.replay.groupsAt(line)['0'].length;
        L.push(`At the line you were ${mates ? `in a group of ${mates + 1}` : 'with nobody else in your group'}.`);
    }
    return L;
}


/* ------------------------------------------------------------------ the rider's team */

/* A team tag reduced for matching: case, spaces and punctuation ignored. */
export const tagKey = t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/*
 * Van, 18 Sep 2026: the race commentary is for the team, "if I'm on MNSTRS and there are other
 * people with the same name then the report should focus on that group as a team and how those
 * people did". The mod lists the riders whose tag matches the rider's exactly, ignoring case and
 * punctuation, and gives every other tag in the race, because tags are sometimes spelled
 * differently and the prompt asks the AI to judge those.
 */
export function teamLines(ctx, {teamTag, includeNames, shortTag, nameOfResult = r => r.name}) {
    const {rec} = ctx;
    const L = [];
    if (!includeNames) {
        return ['Team tags were left out with the names, so the rider\'s team cannot be shown. ' +
            'Tell the race of the whole field.'];
    }
    const tag = shortTag(teamTag);
    if (!tag) {
        return ['The rider\'s team tag is not known. Tell the race of the whole field.'];
    }
    L.push(`The rider's team tag: ${tag}.`);
    const res = rec.results || [];
    const want = tagKey(tag);
    const own = ownResult(rec);
    const mates = new Map();
    for (const [k, r] of Object.entries(rec.riders || {})) {
        if (r.team && tagKey(r.team) === want) {
            mates.set(r.name || k, {key: k});
        }
    }
    // A team mate Sauce saw has their results row found by name, as a row may carry no tag.
    for (const [name, m] of mates) {
        m.result = res.find(r => r.name === name) || null;
    }
    for (const r of res) {
        if (r !== own && r.team && tagKey(r.team) === want) {
            const m = mates.get(r.name) || {key: riderKeyOfResult(rec, r)};
            m.result = r;
            mates.set(r.name, m);
        }
    }
    if (!mates.size) {
        L.push('No other rider in this race carries that tag exactly.');
    } else {
        L.push(`Riders with the same tag, ignoring case and punctuation (${mates.size}):`);
        for (const [name, m] of mates) {
            const bits = [];
            const r = m.key != null ? rec.riders[m.key] : null;
            if (r && ctx.hasMoves) {
                const p = placeAtLine(ctx, r.seq);
                bits.push(`at the line in ${placeWords(p)}`);
                const left = lastLeftGroup(ctx, r.seq);
                if (p !== 0 && left != null) {
                    bits.push(`last in your group at ${fmtClock(left)}`);
                } else if (p !== 0 && left == null) {
                    bits.push('never in your group while this was recorded');
                }
            } else {
                bits.push('not seen by Sauce during the race, only in the results');
            }
            if (m.result) {
                bits.push(m.result.place != null ?
                    `officially ${nth(m.result.place)} in ${fmtDuration(m.result.timeSeconds)}` +
                    `${isNum(m.result.avgWatts) ? `, ${Math.round(m.result.avgWatts)} W average` : ''}` :
                    `officially ${m.result.flags || 'unplaced'}`);
            }
            L.push(`  ${m.key != null ? ctx.nameOfKey(m.key) : `${nameOfResult(m.result)} [${tag}]`}: ${bits.join('; ')}.`);
        }
    }
    const others = new Map();
    for (const t of [...Object.values(rec.riders || {}).map(r => r.team), ...res.map(r => r.team)]) {
        const st = shortTag(t);
        if (st && tagKey(st) !== want) {
            others.set(tagKey(st), st);
        }
    }
    L.push(others.size ?
        `Other tags in this race: ${[...others.values()].join(', ')}. A tag or name that is plainly ` +
        `another spelling of ${tag} counts as the same team.` :
        'No other tags in this race.');
    return L;
}


export const POWERUP_EFFECTS = {
    LIGHTNESS: 'Feather makes you lighter for a short time, which helps most uphill.',
    FEATHER: 'Feather makes you lighter for a short time, which helps most uphill.',
    AERO: 'Aero cuts your air drag for a short time, which helps most at high speed.',
    DRAFTBOOST: 'Draft Truck makes the draft you get stronger for a short time.',
    ANVIL: 'Anvil makes you heavier for a short time, which helps most downhill.',
    NINJA: 'Ghost hides you from other riders for a short time.',
    GHOST: 'Ghost hides you from other riders for a short time.',
    UNDRAFTABLE: 'Undraftable stops riders behind you getting a draft from you for a short time.',
};

export function powerUpLines(ctx) {
    const ev = (ctx.tl.powerUpEvents || []).filter(([t]) => t <= ctx.line);
    const L = [];
    const used = new Set();
    ev.forEach(([t, name], i) => {
        if (!name) {
            return;
        }
        used.add(name);
        const next = ev[i + 1];
        const g = ctx.S.grade.at(t, 3);
        const tg = toGoAt(ctx, t);
        L.push(`${fmtClock(t)} to ${next ? fmtClock(next[0] - 1) : 'the line'}: ${prettyPowerUp(name)}, ` +
            `on a ${isNum(g) ? (g * 100).toFixed(1) : '?'}% grade` +
            `${isNum(tg) ? `, ${distNum(ctx, tg)} ${distUnit(ctx)} from the line` : ''}, in a group of ` +
            `${ctx.P.size.at(t, ctx.packNear) ?? '?'}.`);
    });
    if (!L.length) {
        L.push('No powerup was active on you before the line.');
    }
    const effects = [...new Set([...used].map(n => POWERUP_EFFECTS[n]).filter(Boolean))];
    if (effects.length) {
        L.push(`What these do, in general Zwift terms, not measured in this race: ${effects.join(' ')}`);
    }
    L.push('Which powerup you were holding and did not use is not in this data unless Sauce Game Connection is on.');
    return L;
}


/* ------------------------------------------------------------------ an earlier race */

/*
 * An earlier recording, summarised by the same rules. A record that is not complete withholds its
 * start and its lowest W'bal: the model starts again with the recording, and a start that was not
 * recorded is not a start.
 */
export function earlierRaceLines(prev, {units} = {}) {
    const model = {meta: {}};
    const own = ownSeries(prev);
    model.meta.firstSecond = own.t.length ? own.t[0] : 0;
    model.meta.raceSeconds = own.t.length ? own.t[own.t.length - 1] : 0;
    const ctx = raceContext(prev, {model, units});
    const ev = prev.event || {};
    const L = [];
    const date = prev.startedISO ? prev.startedISO.slice(0, 10) : 'date not known';
    L.push(`${date}: ${ev.name || 'event not known'}${ev.subgroupLabel ? ` (${ev.subgroupLabel})` : ''}, ` +
        `${ev.routeName || 'route not known'}` +
        `${isNum(ev.endDistance) && ev.endDistance > 0 ? `, ${distNum(ctx, ev.endDistance)} ${distUnit(ctx)}` : ''}.`);
    if (!own.t.length) {
        L.push('  Nothing of your own ride was recorded.');
        return L;
    }
    const whole = !prev.incomplete && ctx.hasStart;
    if (!whole) {
        L.push(`  NOT a complete record${(prev.incompleteReasons || []).length ?
            `: ${prev.incompleteReasons.join('; ')}` : ''}. Compare only the part it covers ` +
            `(${fmtClock(ctx.first)} to ${fmtClock(ctx.line)}), and not its start.`);
    }
    const all = ctx.S.power.avg(ctx.first, ctx.line);
    const m1 = ctx.S.power.avg(ctx.first, ctx.first + 59);
    const m5 = ctx.S.power.avg(ctx.first, ctx.first + 299);
    const b60 = bestWindow(own.tExact, own.power, 60);
    const low = ctx.S.wbal.extremes(ctx.first, ctx.line).min;
    L.push(`  Recorded ${fmtDuration(ctx.line - ctx.first + 1)}; ${isNum(all) ? Math.round(all) : '?'} W average` +
        `${whole ? `; first minute ${isNum(m1) ? Math.round(m1) : '?'} W, first five ` +
            `${isNum(m5) ? Math.round(m5) : '?'} W` : ''}` +
        `; best 60 s ${b60 ? Math.round(b60.avg) : '?'} W` +
        `${!whole ? '; no lowest W\'bal, as the model restarts with the recording' :
            ctx.wPrimeSource === 'profile' ? `; lowest W'bal ${wbalShare(ctx, low)}` :
            // Without the W' the model ran on, a share would be a share of a guess: joules only.
            `; lowest W'bal ${isNum(low) ? `${Math.round(low)} J` : '?'} (the W' it ran on was not saved with that race)`}; `);
    const st = prev.stats;
    const total = st ? (st.followTime || 0) + (st.workTime || 0) + (st.soloTime || 0) : 0;
    const share = x => `${Math.round((x || 0) / total * 100)}%`;
    const pos = isNum(prev.finishPosition) ?
        `${prev.finishPosition}${isNum(prev.finishParticipants) ? ` of ${prev.finishParticipants}` : ''}` : 'not known';
    L[L.length - 1] += `${total ? `f/w/s ${share(st.followTime)}/${share(st.workTime)}/${share(st.soloTime)}; ` : ''}` +
        `splits of your group ${findSplits(splitSizes(prev)).length}; live position at the end ${pos}.`;
    return L;
}
