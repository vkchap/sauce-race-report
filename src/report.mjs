/*
 * Race Report - the report.
 *
 * WHAT THIS FILE DOES: takes a finished recording and returns a model of plain sentences and
 * tables, then renders that model to HTML. Pure logic: no DOM, no Sauce imports, so the whole
 * thing runs in node against a synthetic recording (see test/).
 *
 * Rules this file keeps to:
 *   - It describes what happened. It never says why anyone did anything, and it gives no training
 *     advice and no prescriptions.
 *   - Every number comes from the recording. Where a number is not available it says so instead
 *     of estimating.
 *   - A recording with holes in it, or one that started after the gun, is described as such
 *     before any of its numbers are given.
 *   - Other riders appear under the name Sauce itself gave, or under a per-race "Rider A" label
 *     when Sauce gave no name.
 *
 * ALL TIMES ARE RACE TIMES: seconds since the gun. The recorder anchors them there (see THE CLOCK
 * and THE GUN in recorder.mjs). Sauce's own per-second streams are sliced from its event slice,
 * which opens when Zwift's state.time does, and that can be well after the gun; ownSeries puts
 * them on the gun clock and fills the stretch before them from the mod's own rows.
 */

/*
 * Zwift's race clock starting more than this many seconds after the gun is said plainly. Anything
 * inside it is the one second resolution of state.time and packet timing.
 */
export const ZWIFT_CLOCK_LATE_SECONDS = 5;

/*
 * When Zwift's race clock for the rider started more than a few seconds away from the gun (or
 * from the rider's join, for a late join), when the recording counts from the scheduled start:
 * {at, seconds, afterJoin}, where `at` is the race second it started on and `seconds` how far
 * after the gun or the join that was (negative is before). Otherwise null.
 */
export function zwiftClockLate(rec) {
    if (rec.gunSource !== 'scheduled-start' || !isNum(rec.zwiftClockStartedAtRaceSecond)) {
        return null;
    }
    const at = rec.zwiftClockStartedAtRaceSecond;
    const joined = joinedLateSecond(rec);
    const seconds = at - (joined ?? 0);
    return Math.abs(seconds) > ZWIFT_CLOCK_LATE_SECONDS ? {at, seconds, afterJoin: joined != null} : null;
}

/* The words for zwiftClockLate, the same in the report and the copied text. */
export function zwiftClockLateText(late, who = 'you') {
    const from = late.afterJoin ? `${who === 'you' ? 'you' : 'they'} joined` : 'the gun';
    return late.seconds > 0 ?
        `Zwift's race clock for ${who} started ${late.seconds} seconds after ${from}.` :
        `Zwift's race clock for ${who} started ${-late.seconds} seconds before ` +
        `${late.afterJoin ? from : 'the scheduled start'}.`;
}

/*
 * The race second the rider joined after the gun, or null. Whenever it is set, lateness is
 * measured against it rather than against the gun, however long after it the recording began.
 */
export function joinedLateSecond(rec) {
    return isNum(rec.joinedAtRaceSecond) ? rec.joinedAtRaceSecond : null;
}

/*
 * How late the recording started: after the join when there was one, after the gun otherwise.
 * Null when it did not start on the race clock.
 */
export function startedLateBy(rec) {
    if (!isNum(rec.startedAtRaceSecond)) {
        return null;
    }
    return rec.startedAtRaceSecond - (joinedLateSecond(rec) ?? 0);
}

/*
 * The source citations behind each of these lines, kept out of the rider's view:
 *   leader gap        Zwift sends it (src/zwift.proto:174, 186); Sauce reads only ep.players10,
 *                     ep.position and ep.activeAthleteCount (src/stats.mjs:2530-2550)
 *   fifteen minutes   const maxGap = 15 * 60 (src/stats.mjs:4526), plus a separate 15 second
 *                     staleness filter (src/stats.mjs:4447-4448)
 *   held powerup      PlayerState carries only the ACTIVE powerup (src/zwift.mjs:267); the held
 *                     one comes from the optional Game Connection (src/stats.mjs:905-912)
 *   frame and wheels  EventSubgroup carries opaque bikeHash and jerseyHash only
 *                     (src/zwift.proto:1932, 1936) and Sauce never decodes them
 *   hidden events     ad.disabledByEvent, then processState returns before recording anything
 *                     (src/stats.mjs:3048-3049, 3071-3073)
 */
export const CANNOT_KNOW = [
    'Why anyone did anything. Nothing in the data marks intent, so this report never says who ' +
    'attacked, who chased or who sat on.',
    'The official finishing order, unless you press "Get official results", which asks Zwift ' +
    'for them using your own Zwift login.',
    'Your time gap to the race leader. Zwift sends it and Sauce does not keep it.',
    'Riders more than about fifteen minutes ahead of or behind you. That is where Sauce stops ' +
    'tracking them.',
    'Which powerup another rider was holding. Only the powerup a rider is using is in the data.',
    'Which frame or wheels anyone was on, including assigned equipment. Sauce does not decode it.',
    'Anything at all about a race the organiser tagged hidethehud or nooverlays. Sauce records ' +
    'nothing in those events.',
];

export const DISCLAIMER_TITLE = 'About the data in this report';

/*
 * The opt-out paragraph is written the way it is because the plain version would be wrong on the
 * Sauce most people are running. Sauce fetches an opt-out list of athlete id hashes at startup
 * (src/app.mjs:346-365) and drops those riders from each packet before the stats processor sees
 * them (src/zwift.mjs:2186-2200). On v2.3.0 that drop loop splices by the loop counter rather
 * than by the index it collected, `pb.playerStates.splice(i, 1)` at src/zwift.mjs:2197-2201, so
 * it removes the first N riders in the packet instead of the right ones: the opted-out rider can
 * still arrive, and a different rider is dropped in their place. The main branch fixes it to
 * `splice(this._dropList[i], 1)`. Either way Sauce refuses to load a profile for an opted-out id
 * (src/stats.mjs:2377-2386), so such a rider can only ever appear here as an unnamed label.
 */
export const DISCLAIMER = [
    'This mod runs inside Sauce for Zwift and reads only what Sauce already has. It keeps ' +
    'everything on this computer. The report window makes no network requests of its own.',
    'A race report does not work without knowing who raced, so this mod holds and shows other ' +
    'riders the way Sauce itself does: the rider id and the name Sauce already shows in its own ' +
    'Nearby and Events windows, and the team tag Sauce reads out of that name and shows in its ' +
    'Groups window. It stores no avatar, no country, no weight and no FTP for anyone but you. It ' +
    'never asks Zwift for another rider\'s profile.',
    'Sauce keeps an opt-out list of riders and drops them from the data before a mod sees them. ' +
    'On some Sauce versions that drop is known to remove the wrong riders from a packet, so an ' +
    'opted-out rider can still reach a mod, always without a name. This mod never shows a rider ' +
    'id on screen and never puts one in a saved report for anyone Sauce could not name: they ' +
    'appear as "Rider A", "Rider B" and so on. Those labels are good for one race only and mean ' +
    'nothing in any other report.',
    'Recordings are kept in Sauce\'s own storage for this Sauce profile, which every Sauce window ' +
    'and every other enabled mod can read. Save what you want to keep to a file, and delete the ' +
    'rest.',
    'Nothing here is uploaded anywhere. If you press either copy button, the facts go to your ' +
    'clipboard and it is your choice where you paste them. Anything you paste into an AI service ' +
    'goes to that service under their terms.',
    'Mods are written by third parties. Use at your own risk.',
];


/* ------------------------------------------------------------------ formatting */

export function fmtDuration(sec) {
    if (sec == null || !isFinite(sec)) {
        return 'unknown';
    }
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h) {
        return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    }
    if (m) {
        return `${m}m ${String(s).padStart(2, '0')}s`;
    }
    return `${s}s`;
}

export function fmtClock(sec) {
    if (sec == null || !isFinite(sec)) {
        return '--:--';
    }
    sec = Math.round(sec);
    // A second before the gun, which a clock that ran early can give, reads as -0:08.
    const sign = sec < 0 ? '-' : '';
    sec = Math.abs(sec);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${sign}${m}:${String(s).padStart(2, '0')}`;
}

export function makeUnits(imperial) {
    return {
        imperial: !!imperial,
        dist(m) {
            if (m == null || !isFinite(m)) {
                return 'unknown';
            }
            return imperial ?
                `${(m / 1609.344).toFixed(2)} mi` :
                `${(m / 1000).toFixed(2)} km`;
        },
        shortDist(m) {
            if (m == null || !isFinite(m)) {
                return 'unknown';
            }
            return imperial ?
                `${Math.round(m * 3.28084)} ft` :
                `${Math.round(m)} m`;
        },
        speed(kph) {
            if (kph == null || !isFinite(kph)) {
                return 'unknown';
            }
            return imperial ?
                `${(kph / 1.609344).toFixed(1)} mph` :
                `${kph.toFixed(1)} km/h`;
        },
        elev(m) {
            if (m == null || !isFinite(m)) {
                return 'unknown';
            }
            return imperial ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`;
        },
    };
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const isNum = x => typeof x === 'number' && isFinite(x);
const countOf = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;


/* ------------------------------------------------------------------ series maths */

/* The longest a sample is taken to hold its value, so a hole in a recording is not filled. */
export const MAX_SAMPLE_HOLD_SECONDS = 5;

export function bestWindow(times, values, windowSec, {minCover = 0.9} = {}) {
    /*
     * Best average of `values` over any `windowSec` window. Returns {avg, startT, endT, i, j}.
     *
     * The window is the half-open span (t - windowSec, t], so at one row per second a 5 second
     * window is five rows, not six. Keeping the far edge out matters: including it made every
     * peak in the report an average of one extra second, which drags a short peak down.
     *
     * The average is over time, not over samples: each sample holds its value from the sample
     * before it (at most MAX_SAMPLE_HOLD_SECONDS). Sauce's own per-second streams are not one a
     * second: on Van's race of 17 Sep 2026 a quarter of them were 1.2 s apart, so a "5 s" window
     * held four samples, and averaging the samples gave a best 5 s of 637 W against Sauce's own
     * 588 W. Pass times unrounded (ownSeries' tExact) for the same reason.
     *
     * The window must also be reasonably full before it counts (minCover of it, and two samples),
     * so that a recording that dropped to a row every five seconds (see the size guard in
     * recorder.mjs), or one with holes in it, does not report a "best 5 seconds" from one row.
     */
    if (!times || !values || times.length < 2) {
        return null;
    }
    // A sample holds at most half as long again as the series' usual spacing, so Sauce's 1.2 s
    // samples count whole while a second missing from one a second rows is not filled in.
    const gaps = [];
    for (let k = 1; k < times.length; k++) {
        gaps.push(times[k] - times[k - 1]);
    }
    const usual = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const maxHold = Math.min(MAX_SAMPLE_HOLD_SECONDS * 1.5, Math.max(1, usual) * 1.5);
    const hold = k => {
        const gap = k > 0 ? times[k] - times[k - 1] : times[1] - times[0];
        return Math.max(0, Math.min(gap, maxHold));
    };
    let best = null;
    for (let j = 0; j < times.length; j++) {
        const end = times[j];
        const from = end - windowSec;
        let sum = 0;
        let covered = 0;
        let count = 0;
        let i = j;
        for (let k = j; k >= 0 && times[k] > from; k--) {
            i = k;
            const v = values[k];
            if (!isNum(v)) {
                continue;
            }
            const span = times[k] - Math.max(times[k] - hold(k), from);
            sum += v * span;
            covered += span;
            count++;
        }
        if (count > 1 && covered >= windowSec * minCover) {
            const avg = sum / covered;
            if (!best || avg > best.avg) {
                best = {avg, startT: times[i], endT: end, i, j};
            }
        }
    }
    return best;
}

export function sliceStats(times, values, t0, t1) {
    let sum = 0;
    let count = 0;
    let max = null;
    for (let i = 0; i < times.length; i++) {
        if (times[i] < t0 || times[i] > t1) {
            continue;
        }
        const v = values[i];
        if (!isNum(v)) {
            continue;
        }
        sum += v;
        count++;
        if (max == null || v > max) {
            max = v;
        }
    }
    return count ? {avg: sum / count, max, count} : null;
}

export function valueAt(times, values, t, tolerance = 15) {
    /* Nearest recorded value to time t, or null if nothing was recorded near it. */
    if (!times || !times.length) {
        return null;
    }
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < times.length; i++) {
        const d = Math.abs(times[i] - t);
        if (d < bestD) {
            bestD = d;
            bestI = i;
        }
    }
    if (bestI === -1 || bestD > tolerance) {
        return null;
    }
    return values[bestI] ?? null;
}

export function indexAtDistanceToGo(times, eventDistance, endDistance, toGo) {
    /* First index at which fewer than `toGo` metres of the event remained. */
    if (!isNum(endDistance)) {
        return null;
    }
    for (let i = 0; i < times.length; i++) {
        const d = eventDistance[i];
        if (isNum(d) && endDistance - d <= toGo) {
            return i;
        }
    }
    return null;
}


/* ------------------------------------------------------------------ own series */

export function resampleNearest(srcTimes, srcValues, dstTimes, tolerance = 10) {
    /*
     * Nearest-sample resample of a series onto another set of times. Both are race seconds, so
     * this is a merge, not an interpolation.
     */
    const out = new Array(dstTimes.length).fill(null);
    if (!srcTimes.length || !srcValues.length) {
        return out;
    }
    let i = 0;
    for (let k = 0; k < dstTimes.length; k++) {
        const want = dstTimes[k];
        while (i + 1 < srcTimes.length &&
               Math.abs(srcTimes[i + 1] - want) <= Math.abs(srcTimes[i] - want)) {
            i++;
        }
        out[k] = Math.abs(srcTimes[i] - want) <= tolerance ? (srcValues[i] ?? null) : null;
    }
    return out;
}


/*
 * A function from a time in Sauce's streams (seconds, Sauce's stream time) to race seconds, or null
 * when the recording's streams cannot be placed on the race clock. See ownSeries for why.
 */
export function streamTimeToRace(rec) {
    const s = rec && rec.streams;
    const fromSchedule = rec && rec.gunSource === 'scheduled-start';
    const gunMs = fromSchedule ? Date.parse(rec.scheduledStartISO) : NaN;
    const onServer = fromSchedule && isNum(rec.createdServerTime) && isNum(gunMs);
    const streamStart = fromSchedule ? rec.zwiftClockStartedAtRaceSecond : 0;
    if (!s || !Array.isArray(s.time) || !s.time.length || rec.clock !== 'race' ||
        !(onServer || isNum(streamStart))) {
        return null;
    }
    const t0 = s.time[0];
    const fn = onServer ? x => (rec.createdServerTime + x * 1000 - gunMs) / 1000 : x => x - t0 + streamStart;
    fn.onServer = onServer;
    return fn;
}

/*
 * Sauce's own power peaks for the race, as Map period -> {avg, startT}. Sauce's peak `time` is in
 * stream time at the end of its window, so startT is that on the race clock less the period, or
 * null when the streams cannot be placed. Sauce's windows are not quite this mod's (its rolling
 * average spans a sample more), so its short peaks read a little lower than bestWindow's: on Van's
 * race of 17 Sep 2026, 588 W against 626 W for 5 s. The window and the debrief give Sauce's.
 */
export function saucePowerPeaks(rec, maxPeriod = 300) {
    const peaks = (rec && rec.stats && rec.stats.power && rec.stats.power.peaks) || {};
    const toRace = streamTimeToRace(rec);
    const out = new Map();
    for (const [k, v] of Object.entries(peaks)) {
        const period = v && v.period != null ? Number(v.period) : Number(k);
        if (v && isNum(v.avg) && isNum(period) && period <= maxPeriod) {
            let startT = toRace && isNum(v.time) ? Math.round(toRace(v.time) - period) : null;
            // A time that does not land inside the race is not trusted as a place in it.
            const end = isNum(rec.elapsedSeconds) ? rec.elapsedSeconds : Infinity;
            if (!isNum(startT) || startT < 0 || startT + period > end + 1) {
                startT = null;
            }
            out.set(period, {avg: v.avg, startT});
        }
    }
    return out;
}


export function ownSeries(rec) {
    /*
     * Prefer Sauce's own per-second arrays, which are gap filled and aligned
     * (src/stats.mjs:1782-1797) and cover the whole race even if this window came up late. They
     * are only usable when the recording is on the race clock, because Sauce's arrays start at
     * the gun and there would otherwise be no way to line the two up.
     *
     * Fall back to the rows this mod recorded live, which is what survives Sauce restarting mid
     * race, and which is all there is for a recording started by hand outside an event.
     *
     * A recording that ran on past the line needs no cut here: these arrays already stop at the
     * line. ui.mjs takes them from Sauce's event slice, which Sauce closes on the very state that
     * trips the recorder's finish, before it records that state (src/stats.mjs:3059-3062, then
     * _recordAthleteStats at :3079), and a closed slice never grows again (src/stats.mjs:3372-3375,
     * :3476-3481, endIndex at :1747). ui.mjs also takes them at the line (onLine). An earlier
     * version cut them again here at the line's wall clock second, which could drop the last
     * second of the race.
     *
     * THE GUN (recorder.mjs). Sauce's slice, and so these arrays, begin when Sauce opens it,
     * usually on the packet where state.time first reads non-zero (src/stats.mjs:3050-3058), which
     * can be well after the gun. Each sample's time is seconds after ad.wtOffset
     * (src/stats.mjs:3389), which every payload carries as createdServerTime (:4334) and the
     * recorder saves, so each sample goes on the race second its own server time falls in, the
     * same whole second a row is on. Samples before the gun are left out, like rows. The mod's own
     * rows cover every race second before the first sample, so the two join without a second
     * counted twice. A recording that counts from the scheduled start without createdServerTime
     * starts the arrays at zwiftClockStartedAtRaceSecond, and one that never saw Zwift's clock
     * run cannot be lined up, so it uses its own rows. A recording that counts from state.time
     * itself keeps the alignment it always had, starting the arrays at 0.
     */
    const s = rec.streams;
    const tl = rec.timeline || {};
    const fromSchedule = rec.gunSource === 'scheduled-start';
    const toRace = streamTimeToRace(rec);
    let streamT = null;
    let streamExact = null;
    let k0 = 0;
    if (toRace) {
        streamExact = s.time.map(toRace);
        streamT = streamExact.map(x => toRace.onServer ? Math.floor(x) : Math.round(x));
        while (fromSchedule && k0 < streamT.length && streamT[k0] < 0) {
            k0++;
        }
        streamT = streamT.slice(k0);
        streamExact = streamExact.slice(k0);
    }
    if (streamT && streamT.length > 5) {
        const rowT = tl.t || [];
        let before = 0;
        while (before < rowT.length && rowT[before] < streamT[0]) {
            before++;
        }
        const t = [...rowT.slice(0, before), ...streamT];
        // A series Sauce did not send stays empty rather than becoming a run of rows with nothing
        // after it.
        const join = (rows, stream) => (!stream || !stream.length) ? [] : [
            ...Array.from({length: before}, (_, i) => (rows && rows[i] != null) ? rows[i] : null),
            ...stream.slice(k0),
        ];
        // grade and event distance are not in Sauce's stream set, so take them from the rows this
        // mod recorded and put them on the stream times by nearest sample. Both are race seconds.
        const resample = arr => resampleNearest(rowT, arr || [], t);
        return {
            source: 'sauce-streams',
            rowsBeforeStreams: before,
            t,
            // The same times unrounded, for averages over time (bestWindow).
            tExact: [...rowT.slice(0, before), ...streamExact],
            power: join(tl.power, s.power),
            hr: join(tl.hr, s.hr),
            cadence: join(tl.cadence, s.cadence),
            speed: join(tl.speed, s.speed),
            draft: join(tl.draft, s.draft),
            distance: join(tl.distance, s.distance),
            altitude: join(null, s.altitude),
            wbal: join(tl.wbal, s.wbal),
            grade: resample(tl.grade),
            eventDistance: resample(tl.eventDistance),
        };
    }
    return {
        source: 'live-rows',
        t: tl.t || [],
        tExact: tl.t || [],
        power: tl.power || [],
        hr: tl.hr || [],
        cadence: tl.cadence || [],
        speed: tl.speed || [],
        draft: tl.draft || [],
        distance: tl.distance || [],
        altitude: [],
        wbal: tl.wbal || [],
        grade: tl.grade || [],
        eventDistance: tl.eventDistance || [],
    };
}


/* ------------------------------------------------------------------ splits */

/*
 * A group size has to hold this long, before and after, for a split to count. On Van's 69 minute
 * session of 16 Sep 2026, in a big field, Sauce's grouping flickered from one payload to the next
 * (riders a few tenths apart fall either side of its 0.8 s and 2 s cuts, src/stats.mjs:4553-4556),
 * and the copied text listed splits such as "group 91 -> 10" and "88 -> 19" that no minute of the
 * race showed, and riders leaving twice, or leaving and still there at the end.
 */
export const SPLIT_HOLD_SECONDS = 10;

/*
 * The group size as it held: with side 'before', the smallest size in the `hold` seconds up to
 * each row (the group was at least that big for all of them); with 'after', the largest in the
 * `hold` seconds from it (at most that big for all of them). Null where the rows do not reach that
 * far, or hold no size at all.
 */
export function heldGroupSize(times, sizes, hold, side) {
    const out = new Array(times.length).fill(null);
    const first = times[0];
    const last = times[times.length - 1];
    for (let k = 0; k < times.length; k++) {
        const a = side === 'before' ? times[k] - hold : times[k];
        const b = side === 'before' ? times[k] : times[k] + hold;
        // Three seconds of slack, for pack rows every two seconds.
        if (a < first - 3 || b > last + 3) {
            continue;
        }
        let v = null;
        for (let i = k; i >= 0 && i < times.length && times[i] >= a && times[i] <= b;
            i += side === 'before' ? -1 : 1) {
            const x = sizes[i];
            if (isNum(x) && (v == null || (side === 'before' ? x < v : x > v))) {
                v = x;
            }
        }
        out[k] = v;
    }
    return out;
}

export function findSplits(pack, {minDrop = 3, minFraction = 0.25, window = 45,
                                  hold = SPLIT_HOLD_SECONDS} = {}) {
    /*
     * A "split" here is only this: the group Sauce put you in got materially smaller over a short
     * window, and stayed smaller (SPLIT_HOLD_SECONDS). It is not a claim that anybody attacked.
     */
    const out = [];
    if (!pack || !Array.isArray(pack.t) || pack.t.length < 5) {
        return out;
    }
    const t = pack.t;
    const sizeBefore = heldGroupSize(t, pack.myGroupSize || [], hold, 'before');
    const sizeAfter = heldGroupSize(t, pack.myGroupSize || [], hold, 'after');
    let lastEnd = -Infinity;
    for (let j = 0; j < t.length; j++) {
        if (t[j] - lastEnd < window) {
            continue;
        }
        // Find the earliest index within `window` seconds before j.
        let i = j;
        while (i > 0 && t[j] - t[i - 1] <= window) {
            i--;
        }
        const before = sizeBefore[i];
        const after = sizeAfter[j];
        if (!isNum(before) || !isNum(after) || before < 4) {
            continue;
        }
        const drop = before - after;
        if (drop >= minDrop && drop / before >= minFraction) {
            out.push({
                t0: t[i],
                t1: t[j],
                before,
                after,
                drop,
                fraction: drop / before,
            });
            lastEnd = t[j];
        }
    }
    // Keep the largest few so the report stays readable.
    return out.sort((a, b) => b.drop - a.drop).slice(0, 4).sort((a, b) => a.t0 - b.t0);
}

export function ridersWhoLeft(riders, t0, t1, {hold = SPLIT_HOLD_SECONDS} = {}) {
    // A rider back in the group within `hold` seconds did not leave it: that is the flicker
    // SPLIT_HOLD_SECONDS describes.
    const out = [];
    for (const [id, r] of Object.entries(riders || {})) {
        const spans = r.withMe || [];
        for (let k = 0; k < spans.length; k++) {
            const [a, b] = spans[k];
            const back = spans[k + 1] && spans[k + 1][0] - b <= hold;
            if (b >= t0 - 5 && b <= t1 + 5 && a < t0 && !back) {
                out.push({id, name: r.name || r.label, leftAt: b});
                break;
            }
        }
    }
    return out.sort((a, b) => a.leftAt - b.leftAt);
}

/*
 * The membership log (WHO WAS IN THE OTHER GROUPS in recorder.mjs) in time order, as
 * [t, seq, from, to, first], with `first` true on a rider's first entry, which is where Sauce first
 * placed them rather than a move. Null for a recording made before the log existed.
 */
export function movesList(rec) {
    const m = rec && rec.moves;
    if (!m || !Array.isArray(m.t)) {
        return null;
    }
    const list = m.t.map((t, i) => [t, (m.rider || [])[i], (m.from || [])[i] ?? null, (m.to || [])[i] ?? null])
        .filter(x => isNum(x[0]) && isNum(x[1]))
        .sort((a, b) => a[0] - b[0]);
    const seen = new Set();
    for (const x of list) {
        x.push(!seen.has(x[1]));
        seen.add(x[1]);
    }
    return list;
}

/*
 * The sizes of the rider's group and of the groups next to it at each pack row, counted from the
 * membership log rather than read off that row. A pack row is one groups payload in two, so a
 * flicker that comes back on alternate payloads lands on every row for as long as it lasts: a
 * synthetic bunch of 61 read "10" on six rows in a row and gave a split of 61 to 10 that the log,
 * which sees every payload and holds each change, never had (review of 16 Sep 2026). Rows before
 * anybody was placed, and rows where Sauce did not place the rider, keep what the row says. Null
 * for a recording with no log, whose rows are all there is.
 */
export function groupSizesFromLog(rec) {
    const list = movesList(rec);
    const pack = (rec && rec.pack) || {};
    if (!list || !Array.isArray(pack.t)) {
        return null;
    }
    const count = {'-2': 0, '-1': 0, '0': 0, '1': 0, '2': 0};
    const places = new Map();
    const firstPlaced = list.length ? list[0][0] : Infinity;
    const out = {t: pack.t, myGroupSize: [], sizeAheadGroup: [], sizeBehindGroup: []};
    const raw = key => pack[key] || [];
    let k = 0;
    for (let i = 0; i < pack.t.length; i++) {
        const t = pack.t[i];
        for (; k < list.length && list[k][0] <= t; k++) {
            const [, seq, , to] = list[k];
            if (places.has(seq)) {
                count[places.get(seq)]--;
            }
            if (to == null) {
                places.delete(seq);
            } else {
                places.set(seq, String(to));
                count[String(to)]++;
            }
        }
        if (!isNum(raw('myGroupSize')[i]) || t < firstPlaced) {
            out.myGroupSize.push(raw('myGroupSize')[i] ?? null);
            out.sizeAheadGroup.push(raw('sizeAheadGroup')[i] ?? null);
            out.sizeBehindGroup.push(raw('sizeBehindGroup')[i] ?? null);
        } else {
            out.myGroupSize.push(1 + count['0']);
            out.sizeAheadGroup.push(count['-1'] || null);
            out.sizeBehindGroup.push(count['1'] || null);
        }
    }
    return out;
}

/* What findSplits reads: the sizes from the membership log when there is one, the pack rows if not. */
export function splitSizes(rec) {
    return groupSizesFromLog(rec) || (rec && rec.pack);
}

/*
 * ridersWhoLeft by the membership log: riders whose change out of the rider's group, which held,
 * began between t0 - 5 and t1 + 5. Each rider once.
 */
export function ridersWhoLeftByLog(rec, t0, t1) {
    const list = movesList(rec) || [];
    const bySeq = new Map(Object.entries(rec.riders || {}).map(([id, r]) => [r.seq, [id, r]]));
    // Each rider's last change out of the group in the window: a rider who left, came back and
    // left again is said to have left when they last did.
    const last = new Map();
    for (const [t, seq, from, to, first] of list) {
        if (first || from !== 0 || to === 0 || t < t0 - 5 || t > t1 + 5 || !bySeq.has(seq)) {
            continue;
        }
        const [id, r] = bySeq.get(seq);
        last.set(seq, {id, seq, name: r.name || r.label, leftAt: t, to});
    }
    return [...last.values()].sort((a, b) => a.leftAt - b.leftAt);
}

/*
 * How long a split has to be undone in for the report to say the riders were back: Van's race of
 * 17 Sep 2026 had a group of 4 clear of 14 at 2:00 that was back together at 2:30, which the window
 * listed as 14 riders "who were with you and were not after".
 */
export const REJOIN_SECONDS = 120;

/*
 * Of `left` (ridersWhoLeftByLog), those whose next change that held put them back in the rider's
 * group within REJOIN_SECONDS of leaving and by `until`, as [{...rider, backAt}].
 */
export function ridersBackInGroup(rec, left, until = Infinity) {
    const list = movesList(rec) || [];
    const out = [];
    for (const x of left) {
        const next = list.find(e => e[1] === x.seq && e[0] > x.leftAt);
        if (next && next[3] === 0 && next[0] - x.leftAt <= REJOIN_SECONDS && next[0] <= until) {
            out.push({...x, backAt: next[0]});
        }
    }
    return out;
}

/*
 * companions by the membership log: the seconds each rider was in the rider's group between
 * startT and endT, counted from changes that held, so a rider Sauce showed a few tenths outside the
 * group for one payload is not docked for it.
 */
export function companionsFromLog(rec, endT, startT = 0) {
    const list = movesList(rec);
    if (!list || !isNum(endT)) {
        return null;
    }
    const bySeq = new Map(Object.entries(rec.riders || {}).map(([id, r]) => [r.seq, [id, r]]));
    const since = new Map();
    const total = new Map();
    const add = (seq, a, b) => {
        const x = Math.max(a, startT);
        const y = Math.min(b, endT + 1);
        if (y > x) {
            total.set(seq, (total.get(seq) || 0) + (y - x));
        }
    };
    for (const [t, seq, from, to] of list) {
        if (t > endT) {
            break;
        }
        if (from === 0 && since.has(seq)) {
            add(seq, since.get(seq), t);
            since.delete(seq);
        }
        if (to === 0) {
            since.set(seq, t);
        }
    }
    const out = [];
    for (const [seq, a] of since) {
        add(seq, a, endT + 1);
    }
    for (const [seq, seconds] of total) {
        if (!bySeq.has(seq)) {
            continue;
        }
        const [id, r] = bySeq.get(seq);
        out.push({id, name: r.name || r.label, named: !!r.name, seconds, toTheEnd: since.has(seq)});
    }
    return out.sort((a, b) => b.seconds - a.seconds);
}

export function companions(riders, endT, startT = 0) {
    /*
     * Share is measured against the span the recording actually covers, not against the whole
     * race, so a window opened late does not report everyone as having been there a third of
     * the time.
     */
    const span = (isNum(endT) && isNum(startT)) ? Math.max(1, endT - startT + 1) : null;
    const out = [];
    for (const [id, r] of Object.entries(riders || {})) {
        let total = 0;
        let longest = 0;
        let lastEnd = null;
        for (const [a, b] of (r.withMe || [])) {
            total += (b - a) + 1;
            longest = Math.max(longest, (b - a) + 1);
            lastEnd = b;
        }
        if (!total) {
            continue;
        }
        out.push({
            id,
            name: r.name || r.label,
            named: !!r.name,
            seconds: total,
            longest,
            share: span ? Math.min(1, total / span) : null,
            toTheEnd: lastEnd != null && isNum(endT) && endT - lastEnd <= 10,
        });
    }
    return out.sort((a, b) => b.seconds - a.seconds);
}


/* ------------------------------------------------------------------ the report */

export function buildReport(rec, options = {}) {
    const U = makeUnits(options.imperial);
    const own = ownSeries(rec);
    const pack = rec.pack || {};
    const stats = rec.stats || null;
    const cov = rec.coverage || null;
    // Race seconds: the point in the race the described data runs to, counted from the gun.
    const raceSeconds = own.t.length ?
        own.t[own.t.length - 1] :
        (rec.elapsedSeconds ?? null);
    const firstSecond = own.t.length ? own.t[0] : 0;
    const coveredSpan = own.t.length ? (raceSeconds - firstSecond + 1) : null;
    /*
     * When the window came up mid race, Sauce's own streams still cover the rider's whole race,
     * so `firstSecond` is zero while everything the mod itself watched starts much later. Both
     * facts have to be said, or the report reads as complete when half the pack story is missing.
     */
    const joinedLate = joinedLateSecond(rec);
    const clockLate = zwiftClockLate(rec);
    const lateBy = startedLateBy(rec);
    const startedLate = isNum(lateBy) && lateBy > 15;
    // Sauce's own record reaches back before this window started watching, and whether it reaches
    // all the way to the gun (or the join). It does not when Zwift's race clock started late.
    const ownBeforeWatching = own.source === 'sauce-streams' && isNum(rec.startedAtRaceSecond) &&
        firstSecond < rec.startedAtRaceSecond;
    const ownFromStart = firstSecond - (joinedLate ?? 0) <= ZWIFT_CLOCK_LATE_SECONDS;
    const lateWhat = joinedLate != null ?
        `This recording only started at ${fmtClock(rec.startedAtRaceSecond)}, ` +
        `${fmtDuration(lateBy)} after you joined` :
        `This window only started watching at ${fmtClock(rec.startedAtRaceSecond)}`;
    const watchedFrom = isNum(rec.startedAtRaceSecond) ?
        Math.max(firstSecond, rec.startedAtRaceSecond) :
        firstSecond;
    const sections = [];
    const notes = [...(rec.notes || [])];
    const cannot = [...CANNOT_KNOW];

    // ---------------------------------------------------------------- how good is this record
    /*
     * This comes first on purpose. A window that was frozen, or opened after the gun, produces a
     * recording whose numbers are real but whose story has holes. Saying so before any of the
     * numbers is the difference between an honest report and a confident wrong one.
     */
    if (rec.incomplete && (rec.incompleteReasons || []).length) {
        notes.unshift(`This is not a complete record of the race: ` +
            `${joinList(rec.incompleteReasons)}. Everything below describes only what was ` +
            `recorded.`);
    }
    if (cov && cov.missingSeconds > 0 && own.source === 'live-rows') {
        notes.push(`${cov.missingSeconds} of the ${cov.spanSeconds} seconds this recording covers ` +
            `are missing` +
            `${cov.largestGapSeconds > 0 ? `, the longest gap being ${fmtDuration(cov.largestGapSeconds)}` : ''}` +
            `. A window that was minimised, or a computer that was busy, will do that.`);
    }
    if (cov && cov.missingSeconds > 0 && own.source === 'sauce-streams') {
        notes.push(`This window missed ${cov.missingSeconds} of the ${cov.spanSeconds} seconds it ` +
            `covers, so your own power and heart rate below come from Sauce's own complete record ` +
            `while the pack around you has gaps in it.`);
    }

    // ---------------------------------------------------------------- the race
    const ev = rec.event || {};
    const headLines = [];
    const eventTitle = ev.name ?
        `${ev.name}${ev.subgroupLabel ? ` (${ev.subgroupLabel})` : ''}` :
        'An event Sauce could not name';
    const when = rec.startedISO ? new Date(rec.startedISO) : null;
    headLines.push(`${eventTitle}${ev.prettyType ? `, a ${ev.prettyType.toLowerCase()}` : ''}` +
        `${when ? `, ${when.toLocaleString()}` : ''}.`);
    if (isNum(ev.routeDistance) || isNum(ev.distanceInMeters)) {
        const d = isNum(ev.distanceInMeters) && ev.distanceInMeters ? ev.distanceInMeters : ev.routeDistance;
        headLines.push(`Route ${ev.routeName || 'unknown'}, ${U.dist(d)}` +
            `${isNum(ev.routeClimbing) ? `, ${U.elev(ev.routeClimbing)} of climbing` : ''}` +
            `${isNum(ev.laps) && ev.laps > 1 ? `, ${ev.laps} laps` : ''}.`);
    }
    const ownDistance = lastNum(own.eventDistance) ?? lastNum(own.distance);
    if (rec.clock === 'race') {
        if (rec.gunSource === 'scheduled-start' && rec.scheduledStartISO) {
            headLines.push(`Race times count from the gun, the scheduled start of your category at ` +
                `${new Date(rec.scheduledStartISO).toLocaleTimeString()}.`);
        }
        headLines.push(`This report covers from ${fmtClock(firstSecond)} to ` +
            `${fmtClock(raceSeconds)} of the race` +
            `${isNum(ownDistance) ? `, ${U.dist(ownDistance)} in` : ''}.`);
        if (startedLate) {
            headLines.push(ownBeforeWatching ?
                `${lateWhat}. Your own power, heart rate and speed come from Sauce's own record ` +
                `and ${ownFromStart ? `cover the whole ${joinedLate != null ? 'of your ' : ''}race` :
                    `begin at ${fmtClock(firstSecond)}`}, but the group around you, the gaps and ` +
                `who was with you only begin at ${fmtClock(rec.startedAtRaceSecond)}.` :
                `${lateWhat}, so nothing before that is in this report at all.`);
        }
    } else {
        headLines.push(`You were recorded for ${fmtDuration(coveredSpan ?? rec.elapsedSeconds)}` +
            `${isNum(ownDistance) ? ` over ${U.dist(ownDistance)}` : ''}.`);
    }
    const finalPos = isNum(rec.finishPosition) ?
        rec.finishPosition :
        lastNum(rec.timeline && rec.timeline.eventPosition);
    const participants = isNum(rec.finishParticipants) ?
        rec.finishParticipants :
        lastNum(rec.timeline && rec.timeline.eventParticipants);
    if (isNum(finalPos)) {
        headLines.push(`The last race position Zwift reported for you was ${finalPos}` +
            `${isNum(participants) ? ` of ${participants}` : ''}. That is Zwift's own live ` +
            `position, not an official result, and Sauce warns it can stick after the finish.`);
    } else {
        headLines.push('Zwift did not report a race position for you in this event.');
    }
    if (rec.stopReason && rec.stopReason !== 'finish') {
        headLines.push(`This recording did not end at the finish line: it stopped because ` +
            `${stopReasonText(rec.stopReason)}.`);
    }
    if (rec.watchingSelfThroughout === false) {
        headLines.push('For part of this race Sauce was watching another rider, so the group ' +
            'and gap figures below describe the race around that rider, not around you.');
    }
    if (own.source === 'live-rows') {
        headLines.push('Sauce\'s own per-second numbers were not available for this recording, so ' +
            'this report uses the copy this mod made second by second while you rode.');
    }
    sections.push({id: 'race', title: 'The race', lines: headLines});

    // ---------------------------------------------------------------- the start
    const startLines = [];
    if (joinedLate != null) {
        startLines.push(`You joined this event ${fmtDuration(joinedLate)} after the gun` +
            `${startedLate ? '' : ', so this report starts there'}. Times still count from the gun.`);
    }
    if (clockLate != null) {
        // Said as it is, without a reason: why Zwift's clock started when it did is not known.
        startLines.push(zwiftClockLateText(clockLate));
        if (clockLate.seconds > 0 && own.source === 'sauce-streams' && own.rowsBeforeStreams) {
            startLines.push(`Sauce's own record of your ride begins with that clock, at ` +
                `${fmtClock(clockLate.at)}, so everything before it here comes from this mod's own ` +
                `second by second copy.`);
        }
    }
    if (startedLate) {
        startLines.push(`${joinedLate != null ?
            `This recording missed the first ${fmtDuration(lateBy)} after you joined` :
            `This window was not watching for the first ${fmtDuration(rec.startedAtRaceSecond)} ` +
            `of the race`}, so nothing can be said about who was around you at the start` +
            `${!ownBeforeWatching ? ' and nothing at all about how you rode it' : ownFromStart ?
                '. Your own numbers below are Sauce\'s own record and do cover it' :
                `. Your own numbers below are Sauce's own record, which only begins at ` +
                `${fmtClock(firstSecond)}`}.`);
    }
    const s0 = firstSecond;
    const first60 = sliceStats(own.t, own.power, s0, s0 + 60);
    const first300 = sliceStats(own.t, own.power, s0, s0 + 300);
    const whole = sliceStats(own.t, own.power, s0, raceSeconds ?? 1e9);
    if (first60 && whole && firstSecond <= 15) {
        startLines.push(`The first minute averaged ${Math.round(first60.avg)} W, ` +
            `${cmpText(first60.avg, whole.avg)} the ${Math.round(whole.avg)} W you averaged for ` +
            `the whole race.`);
    }
    if (first300 && whole && (raceSeconds ?? 0) > 360 && firstSecond <= 15) {
        startLines.push(`The first five minutes averaged ${Math.round(first300.avg)} W, ` +
            `${cmpText(first300.avg, whole.avg)} the race average.`);
    }
    const peak15start = bestWindow(clipVals(own.t, own.tExact, s0, s0 + 300),
                                   clipVals(own.t, own.power, s0, s0 + 300), 15);
    if (peak15start && firstSecond <= 15) {
        startLines.push(`Your hardest 15 seconds of the first five minutes was ` +
            `${Math.round(peak15start.avg)} W, at ${fmtClock(Math.floor(peak15start.startT))}.`);
    }
    const wbal0 = firstNum(own.wbal);
    const wbal300 = valueAt(own.t, own.wbal, s0 + 300);
    if (isNum(wbal0) && isNum(wbal300) && (raceSeconds ?? 0) > 360 && firstSecond <= 15) {
        const drop = wbal0 - wbal300;
        startLines.push(`Sauce's W'bal model had you ${drop >= 0 ? 'down' : 'up'} ` +
            `${Math.abs(Math.round(drop))} J after five minutes from ${Math.round(wbal0)} J. ` +
            `W'bal is a model, not a measurement, and it uses your FTP as the critical power.`);
    }
    const startGroup = valueAt(pack.t || [], pack.myGroupSize || [], watchedFrom + 60);
    const startAhead = valueAt(pack.t || [], pack.ridersAheadOtherGroups || [], watchedFrom + 60);
    if (isNum(startGroup)) {
        startLines.push(`A minute after this window started watching, Sauce put you in a group of ` +
            `${startGroup}` +
            `${isNum(startAhead) ? `, with ${startAhead} rider${startAhead === 1 ? '' : 's'} ` +
            `visible in groups up the road` : ''}.`);
    }
    if (!startLines.length) {
        startLines.push('There was not enough recorded to describe the start.');
    }
    sections.push({id: 'start', title: 'The start', lines: startLines});

    // ---------------------------------------------------------------- the shape
    const splitLines = [];
    const splits = findSplits(splitSizes(rec));
    if (!splits.length) {
        if (isNum(lastNum(pack.myGroupSize))) {
            splitLines.push('Your group never lost a quarter of its riders inside three quarters ' +
                'of a minute, so this report found no clean split around you.');
        } else {
            splitLines.push('No group information was recorded, so nothing can be said about the ' +
                'field breaking up.');
        }
    }
    const splitRows = [];
    const toldLeaving = new Set();
    for (const sp of splits) {
        const p = sliceStats(own.t, own.power, sp.t0, sp.t1);
        const g = valueAt(own.t, own.grade, sp.t1);
        const d = valueAt(own.t, own.eventDistance, sp.t1) ?? valueAt(own.t, own.distance, sp.t1);
        const wa = valueAt(own.t, own.wbal, sp.t0);
        const wb = valueAt(own.t, own.wbal, sp.t1);
        const byLog = !!movesList(rec);
        /*
         * A rider back in the group before the split's own end did not leave it, and a change of
         * group already given under an earlier split is not given again: two splits 46 s apart on
         * the Epic KOM on 17 Sep 2026 had overlapping windows, and the second listed 12 riders
         * leaving a group of 9.
         */
        const left = (byLog ?
            ridersWhoLeftByLog(rec, sp.t0, sp.t1).filter(x => !ridersBackInGroup(rec, [x], sp.t1).length) :
            ridersWhoLeft(rec.riders, sp.t0, sp.t1)).filter(x => !toldLeaving.has(`${x.id}@${x.leftAt}`));
        for (const x of left) {
            toldLeaving.add(`${x.id}@${x.leftAt}`);
        }
        const names = left.slice(0, 6).map(x => x.name).filter(Boolean);
        /*
         * Where the riders who left went. Your group getting smaller reads as you being dropped,
         * and on Van's race of 17 Sep 2026 both of its biggest splits were the other way round:
         * the riders who left were in a group behind him.
         */
        const nAhead = left.filter(x => isNum(x.to) && x.to < 0).length;
        const nBehind = left.filter(x => isNum(x.to) && x.to > 0).length;
        const where = nAhead && nBehind ?
            `, ${nAhead} of them now in a group ahead of you and ${nBehind} in a group behind` :
            nBehind ? `, ${nBehind === left.length ? 'the riders who left' : `${nBehind} of them`} now in a group behind you` :
            nAhead ? `, ${nAhead === left.length ? 'the riders who left' : `${nAhead} of them`} now in a group ahead of you` : '';
        const namesHead = nAhead && !nBehind && nAhead === left.length ? 'Riders now in a group ahead of you' :
            nBehind && !nAhead && nBehind === left.length ? 'Riders now in a group behind you' :
            'Riders who were with you and were not after';
        const back = byLog ? ridersBackInGroup(rec, left, raceSeconds ?? Infinity) : [];
        const backBy = back.length ? Math.max(...back.map(x => x.backAt)) : null;
        const backText = !back.length ? '' : back.length === left.length ?
            ` All of them were back in your group by ${fmtClock(backBy)}, ${fmtDuration(backBy - sp.t1)} later.` :
            ` ${back.length} of them ${back.length === 1 ? 'was' : 'were'} back in your group by ` +
            `${fmtClock(backBy)}, ${fmtDuration(backBy - sp.t1)} later.`;
        splitRows.push({
            at: fmtClock(sp.t1),
            where: isNum(d) ? U.dist(d) : 'unknown',
            grade: isNum(g) ? `${(g * 100).toFixed(1)}%` : 'unknown',
            before: sp.before,
            after: sp.after,
            power: p ? `${Math.round(p.avg)} W` : 'unknown',
            wbal: (isNum(wa) && isNum(wb)) ? `${Math.round(wb - wa)} J` : 'unknown',
            who: (names.length ?
                names.join(', ') + (left.length > names.length ? ` and ${left.length - names.length} more` : '') :
                'nobody the recording can name') +
                (nAhead || nBehind ? ` (${nBehind && !nAhead ? 'behind' : nAhead && !nBehind ? 'ahead' : 'ahead and behind'})` : '') +
                (back.length ? `, ${back.length === left.length ? 'all' : back.length} back by ${fmtClock(backBy)}` : ''),
        });
        splitLines.push(`At ${fmtClock(sp.t1)}` +
            `${isNum(d) ? `, ${U.dist(d)} in` : ''}` +
            `${isNum(g) ? `, on a ${(g * 100).toFixed(1)} percent grade` : ''}` +
            `, your group went from ${countOf(sp.before, 'rider')} to ${sp.after}${where}` +
            `${p ? `, while you held ${Math.round(p.avg)} W` : ''}` +
            `${(isNum(wa) && isNum(wb)) ? ` and your W'bal moved ${Math.round(wb - wa)} J` : ''}.` +
            (names.length ? ` ${namesHead}: ${names.join(', ')}` +
                `${left.length > names.length ? ` and ${left.length - names.length} more` : ''}.` : '') +
            backText);
    }
    sections.push({
        id: 'shape',
        title: 'How the race broke up around you',
        lines: splitLines,
        table: splitRows.length ? {
            columns: ['At', 'Where', 'Grade', 'Group before', 'Group after', 'Your power', "W'bal change", 'Who left'],
            rows: splitRows.map(x => [x.at, x.where, x.grade, x.before, x.after, x.power, x.wbal, x.who]),
        } : null,
    });

    // ---------------------------------------------------------------- where you sat
    const sitLines = [];
    const visible = (pack.groupsVisible || []);
    /*
     * Pack rows are one every two seconds, not one a second, so a count of rows is not a count of
     * seconds. Everything below is stated to the rider in seconds, so the rows are converted once,
     * here, rather than left to be read as seconds by accident.
     */
    const packStep = (rec.degraded && rec.degraded.packRowInterval) || 1;
    const blindSeconds = secondsWhere(pack.t || [], i => visible[i] === 0, packStep);
    const sizes = [];
    for (let i = 0; i < (pack.t || []).length; i++) {
        if (visible[i] === 0) {
            continue;
        }
        const sz = (pack.myGroupSize || [])[i];
        if (isNum(sz)) {
            sizes.push(sz);
        }
    }
    const aloneSeconds = secondsWhere(pack.t || [],
        i => visible[i] !== 0 && (pack.myGroupSize || [])[i] <= 1, packStep);
    if (sizes.length) {
        const sorted = sizes.slice().sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        sitLines.push(`Your group was ${sorted[0] === 1 ? 'just you' : countOf(sorted[0], 'rider')} at its smallest, ` +
            `${sorted[sorted.length - 1]} at its biggest, and ${med} for most of the recording.`);
        if (aloneSeconds) {
            sitLines.push(`For ${fmtDuration(aloneSeconds)} Sauce had riders in view but none of ` +
                `them in your group, which is the closest this data comes to saying you were alone.`);
        }
    }
    if (blindSeconds) {
        sitLines.push(`For ${fmtDuration(blindSeconds)} Sauce had no rider in view at all. That ` +
            `means nothing was there to see, not that you were on your own: riders more than ` +
            `about fifteen minutes away are not tracked.`);
    }
    const aheadArr = (pack.ridersAheadOtherGroups || []).filter(isNum);
    if (aheadArr.length) {
        const ahead0 = pack.ridersAheadOtherGroups || [];
        const clear = secondsWhere(pack.t || [], i => ahead0[i] === 0, packStep);
        const notClear = secondsWhere(pack.t || [], i => isNum(ahead0[i]) && ahead0[i] > 0, packStep);
        sitLines.push(`For ${fmtDuration(clear)} of the recording there was no group visible ahead ` +
            `of yours, and for ${fmtDuration(notClear)} there was. This counts ` +
            `riders in other groups up the road, not the riders in your own group, and Sauce ` +
            `only sees about fifteen minutes either way, so read it as a shape rather than a ` +
            `placing.`);
    }
    const gapAhead = (pack.gapAheadGroup || []).filter(isNum);
    if (gapAhead.length) {
        const worst = Math.max(...gapAhead.map(Math.abs));
        const best = Math.min(...gapAhead.map(Math.abs));
        sitLines.push(`The nearest group ahead of yours was between ` +
            `${best.toFixed(1)} and ${worst.toFixed(1)} seconds up the road.`);
    }
    if (!sitLines.length) {
        sitLines.push('No group information was recorded for this race.');
    }
    sections.push({id: 'position', title: 'Where you sat', lines: sitLines});

    // ---------------------------------------------------------------- draft
    const draftLines = [];
    if (stats && isNum(stats.followTime)) {
        const total = (stats.followTime || 0) + (stats.workTime || 0) + (stats.soloTime || 0);
        draftLines.push(`Sauce classified every second of this race for you: ` +
            `${fmtDuration(stats.followTime)} in a group getting draft, ` +
            `${fmtDuration(stats.workTime)} in a group getting none, and ` +
            `${fmtDuration(stats.soloTime)} with no group at all` +
            `${total ? ` (${pct(stats.followTime, total)}, ${pct(stats.workTime, total)} and ` +
            `${pct(stats.soloTime, total)} percent)` : ''}.`);
        if (isNum(stats.followKj) || isNum(stats.workKj) || isNum(stats.soloKj)) {
            draftLines.push(`The work in each: ${fmtKj(stats.followKj)} in the draft, ` +
                `${fmtKj(stats.workKj)} in a group with no draft, and ${fmtKj(stats.soloKj)} alone.`);
        }
        // Sauce's classifier: groupId set and draft non-zero is follow, groupId set and draft
        // zero is work, no groupId is solo (src/stats.mjs:3411-3460).
        draftLines.push('Sauce\'s "no draft in a group" is not the same as "on the front": a ' +
            'rider sitting in the wind at the side of a bunch reads the same way.');
        draftLines.push(clockLate != null && clockLate.seconds > 0 ?
            `This split is Sauce's own. It covers the race from when Zwift's race clock for you ` +
            `started, at ${fmtClock(clockLate.at)}, including any seconds this window did not ` +
            `record, but not the ${clockLate.seconds} seconds before it.` :
            'This split is Sauce\'s own and covers the whole race, including any ' +
            'seconds this window did not record.');
    } else {
        // Own rows are one a second unless a very long race thinned them (see the size guard).
        const ownStep = own.source === 'sauce-streams' ?
            1 :
            ((rec.degraded && rec.degraded.selfRowInterval) || 1);
        const dr = own.draft || [];
        const draftSecs = secondsWhere(own.t, i => isNum(dr[i]) && dr[i] > 0, ownStep);
        const noDraftSecs = secondsWhere(own.t, i => isNum(dr[i]) && dr[i] === 0, ownStep);
        if (draftSecs || noDraftSecs) {
            draftLines.push(`Sauce's own follow, work and solo split was not available for this ` +
                `recording. From the raw draft numbers, you had some draft for ` +
                `${fmtDuration(draftSecs)} and none for ${fmtDuration(noDraftSecs)}. That is a ` +
                `rougher measure than Sauce's, which also takes account of whether you were in a ` +
                `group at all.`);
        } else {
            draftLines.push('No draft information was recorded for this race.');
        }
    }
    const draftAvg = avgOf(own.draft);
    if (isNum(draftAvg)) {
        draftLines.push(`Your draft benefit averaged ${Math.round(draftAvg)} W across the ` +
            `${own.source === 'sauce-streams' ? 'race' : 'recorded part of the race'}.`);
    }
    sections.push({id: 'draft', title: 'In the draft against in the wind', lines: draftLines});

    // ---------------------------------------------------------------- efforts
    const effortLines = [];
    const effortRows = [];
    const peaks = saucePowerPeaks(rec);
    for (const w of [5, 15, 60, 300]) {
        if ((coveredSpan ?? 0) < w) {
            continue;
        }
        // Sauce's own peak where it has one, so the window, the debrief and Sauce give one number.
        const b = bestWindow(own.tExact, own.power, w);
        const sp = peaks.get(w);
        const avg = sp ? sp.avg : b && b.avg;
        const at = sp && isNum(sp.startT) ? sp.startT : b ? own.t[b.i] : null;
        if (!isNum(avg) || !isNum(at)) {
            continue;
        }
        // Where and the grade are read where the effort started, the time the table gives.
        const d = valueAt(own.t, own.eventDistance, at) ?? valueAt(own.t, own.distance, at);
        const g = valueAt(own.t, own.grade, at);
        effortRows.push([
            `${w} s`,
            `${Math.round(avg)} W`,
            fmtClock(at),
            isNum(d) ? U.dist(d) : 'unknown',
            isNum(g) ? `${(g * 100).toFixed(1)}%` : 'unknown',
        ]);
    }
    if (effortRows.length) {
        effortLines.push(`The hardest stretches of the ` +
            `${own.source === 'sauce-streams' ? 'race' : 'recorded part of the race'}, measured ` +
            `inside the race itself rather than across the whole ride.`);
    } else {
        effortLines.push('There was not enough power recorded to pick out efforts.');
    }
    if (stats && stats.power && isNum(stats.power.np)) {
        effortLines.push(`Sauce put the race at ${Math.round(stats.power.avg)} W average, ` +
            `${Math.round(stats.power.np)} W normalised` +
            `${isNum(stats.power.kj) ? `, ${Math.round(stats.power.kj)} kJ of work` : ''}` +
            `${isNum(stats.power.tss) ? `, ${Math.round(stats.power.tss)} TSS` : ''}` +
            `${clockLate != null && clockLate.seconds > 0 ? `, counted from ${fmtClock(clockLate.at)} when ` +
            `Zwift's race clock for you started` : ''}.`);
    }
    const wbalMin = minOf(own.wbal);
    if (isNum(wbalMin) && isNum(wbal0)) {
        effortLines.push(`The lowest W'bal the model reached was ${Math.round(wbalMin)} J, ` +
            `against ${Math.round(wbal0)} J at the start of the recording.`);
    }
    sections.push({
        id: 'efforts',
        title: 'The efforts',
        lines: effortLines,
        table: effortRows.length ? {
            columns: ['Window', 'Best average', 'Started at', 'Where', 'Grade'],
            rows: effortRows,
        } : null,
    });

    // ---------------------------------------------------------------- powerups
    const puLines = [];
    const pus = (rec.timeline && rec.timeline.powerUpEvents) || [];
    const used = pus.filter(x => x[1]);
    if (used.length) {
        for (const [t, name] of used) {
            const p = sliceStats(own.t, own.power, t, t + 30);
            const s = sliceStats(own.t, own.speed, t, t + 30);
            const pretty = prettyPowerUp(name);
            const article = 'AEIOU'.includes(pretty[0].toUpperCase()) ? 'an' : 'a';
            puLines.push(`At ${fmtClock(t)} ${article} ${pretty} was active on you` +
                `${p ? `. Over the next 30 seconds you averaged ${Math.round(p.avg)} W` : ''}` +
                `${s ? ` at ${U.speed(s.avg)}` : ''}.`);
        }
    } else {
        puLines.push('No powerup was recorded as active on you during this race.');
    }
    puLines.push('This is the powerup that was active, which is what Zwift broadcasts. Which ' +
        'powerup you were holding, and when you threw one away, is only available if you run ' +
        'Sauce\'s optional Game Connection.');
    puLines.push('The names are Sauce\'s own enum names for the powerups, mapped to the names ' +
        'riders use where that mapping could be checked. Anything unmapped is shown as Sauce ' +
        'spells it.');
    // Sauce gives sg.powerUps as {NAME: share} from _parsePowerupPercents (src/stats.mjs:3733-3735);
    // an array is kept for recordings made against the older synthetic shape.
    const offered = !ev.powerUps ? [] : Array.isArray(ev.powerUps) ? ev.powerUps : Object.keys(ev.powerUps);
    if (offered.length) {
        puLines.push(`The organiser listed these powerups for the event: ` +
            `${offered.map(prettyPowerUp).join(', ')}.`);
    } else {
        puLines.push('The organiser did not tag this event with its powerup list, so the mod ' +
            'cannot say which powerups the event offered.');
    }
    sections.push({id: 'powerups', title: 'Powerups', lines: puLines});

    // ---------------------------------------------------------------- the finish
    const finishLines = [];
    if (rec.stopReason !== 'finish') {
        finishLines.push('This recording did not reach the finish line, so nothing here describes ' +
            'the end of the race.');
    }
    const endDistance = isNum(ev.endDistance) ? ev.endDistance :
        (isNum(ev.distanceInMeters) && ev.distanceInMeters ? ev.distanceInMeters : ev.routeDistance);
    const kmIdx = indexAtDistanceToGo(own.t, own.eventDistance, endDistance, 1000);
    const lastKmT = kmIdx != null ? own.t[kmIdx] : (raceSeconds != null ? raceSeconds - 120 : null);
    if (lastKmT != null && raceSeconds != null && lastKmT >= firstSecond) {
        const p = sliceStats(own.t, own.power, lastKmT, raceSeconds);
        const tl = rec.timeline || {};
        const posStart = valueAt(tl.t || [], tl.eventPosition || [], lastKmT);
        const posEnd = lastNum(tl.eventPosition);
        finishLines.push(`${kmIdx != null ? 'Over the last kilometre' : 'Over the last two minutes'}` +
            `${p ? `, you averaged ${Math.round(p.avg)} W with a peak of ${Math.round(p.max)} W` : ''}.`);
        if (isNum(posStart) && isNum(posEnd)) {
            const moved = posStart - posEnd;
            finishLines.push(`Zwift's live position had you ${posStart} at that point and ` +
                `${posEnd} at the end, ${moved === 0 ? 'no change' :
                `a change of ${Math.abs(moved)} place${Math.abs(moved) === 1 ? '' : 's'} ` +
                `${moved > 0 ? 'forward' : 'back'}`}.`);
        }
        /*
         * The groups either side as well as your own: "a group of 1" on its own read as dropped on
         * Van's race of 17 Sep 2026, where the other four were 1.3 seconds behind him.
         */
        const sizes = splitSizes(rec) || pack;
        const gs = valueAt(sizes.t || [], sizes.myGroupSize || [], lastKmT);
        if (isNum(gs)) {
            const side = (sizeKey, gapKey, word) => {
                const n = valueAt(sizes.t || [], sizes[sizeKey] || [], lastKmT);
                const gap = valueAt(pack.t || [], pack[gapKey] || [], lastKmT);
                return isNum(n) && n > 0 ? `${n === 1 ? 'a rider' : `a group of ${n}`}` +
                    `${isNum(gap) ? `${n === 1 ? '' : ','} ${Math.abs(gap).toFixed(1)} seconds` : ''} ${word}` : null;
            };
            const around = [side('sizeAheadGroup', 'gapAheadGroup', 'ahead of you'),
                side('sizeBehindGroup', 'gapBehindGroup', 'behind you')].filter(Boolean);
            finishLines.push(`${gs <= 1 ? 'Sauce had nobody else in your group at that point' :
                `You were in a group of ${gs} at that point`}` +
                `${around.length ? `, with ${around.join(' and ')}` : ''}.`);
        }
    } else if (rec.stopReason === 'finish') {
        finishLines.push('There was not enough recorded at the end of the race to describe the finish.');
    }
    const finalCompanions = companions(rec.riders, raceSeconds, watchedFrom).filter(x => x.toTheEnd);
    if (finalCompanions.length) {
        finishLines.push(`Still in your group when the recording ended: ` +
            `${finalCompanions.slice(0, 8).map(x => x.name).join(', ')}` +
            `${finalCompanions.length > 8 ? ` and ${finalCompanions.length - 8} more` : ''}.`);
    }
    sections.push({id: 'finish', title: 'The finish', lines: finishLines});

    // ---------------------------------------------------------------- who was there
    const comps = companions(rec.riders, raceSeconds, watchedFrom);
    const compRows = comps.slice(0, 15).map(x => [
        x.name,
        fmtDuration(x.seconds),
        x.share != null ? `${Math.round(x.share * 100)}%` : 'unknown',
        x.toTheEnd ? 'yes' : 'no',
    ]);
    const whoLines = [];
    if (comps.length) {
        const unnamed = comps.filter(x => !x.named).length;
        whoLines.push(`${comps.length} rider${comps.length === 1 ? '' : 's'} spent time in your ` +
            `group during the recorded part of this race.`);
        if (unnamed) {
            whoLines.push(`${unnamed} of them reached this mod without a name from Sauce and ` +
                `${unnamed === 1 ? 'appears' : 'appear'} as "Rider A", "Rider B" and so on. That ` +
                `happens when Sauce has no profile stored for a rider, and it is also what a ` +
                `rider on Sauce's opt-out list looks like if their packet reaches a mod at all. ` +
                `Those labels are saved with no rider id attached and mean nothing outside this ` +
                `one report.`);
        }
    } else {
        whoLines.push('No other rider was recorded in your group.');
    }
    sections.push({
        id: 'who',
        title: 'Who was around you',
        lines: whoLines,
        table: compRows.length ? {
            columns: ['Rider', 'Time in your group', 'Share of the recording', 'There at the end'],
            rows: compRows,
        } : null,
    });

    // ---------------------------------------------------------------- after the line
    /*
     * Its own part, read only from rec.afterLine. Everything above stops at the line, so this is
     * the only place the extra time after it is described at all.
     */
    const after = afterLineFacts(rec);
    if (after) {
        const nameList = list => list.slice(0, 8).map(x => x.name).join(', ') +
            (list.length > 8 ? ` and ${list.length - 8} more` : '');
        const afterLines = [];
        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        afterLines.push(`For ${fmtDuration(after.captured)} after you crossed the line at ` +
            `${fmtClock(after.finish)}, this window kept watching the riders behind you. ` +
            `Nothing here changes any number above: those all stop at the line.`);
        if (after.endedBy && after.endedBy !== 'time' && after.captured < after.requested) {
            afterLines.push(`It stopped after ${fmtDuration(after.captured)} rather than the ` +
                `${fmtDuration(after.requested)} asked for, because ${afterLineEndedText(after.endedBy)}.`);
        }
        afterLines.push('Exact finish times and places come from the official results, not from ' +
            'this part.');
        if (!after.watchingSelf) {
            afterLines.push('For part of this time Sauce was watching another rider, so these gaps ' +
                'describe the road around that rider, not around you.');
        }
        if (after.onClock) {
            // Nobody comes in one by one when the clock ends the event: it runs out for everyone
            // at once (see AFTER THE LINE in recorder.mjs).
            afterLines.push('This event ended on the clock rather than at a distance, so it ended ' +
                'for every rider at the same moment and nobody can be seen coming in after you.');
            if (!after.behindAtClock.length) {
                afterLines.push('When the clock ran out nobody came into view behind you. Sauce ' +
                    'only places riders on the last few roads you rode, so that is behind you as ' +
                    'Sauce saw it.');
            } else {
                afterLines.push(`When the clock ran out, Sauce had ` +
                    `${plural(after.behindAtClock.length, 'rider')} of this event behind you on the ` +
                    `road. The gaps are Sauce's live gaps on the road, and can be a second or so out.`);
                for (const g of after.clockGroups) {
                    const first = g.riders[0];
                    const last = g.riders[g.riders.length - 1];
                    afterLines.push(g.riders.length === 1 ?
                        `${first.name} was ${first.gap.toFixed(1)} seconds behind you.` :
                        `A group of ${g.riders.length} was between ${first.gap.toFixed(1)} and ` +
                        `${last.gap.toFixed(1)} seconds behind you: ${nameList(g.riders)}.`);
                }
            }
        } else if (!after.arrivals.length && !after.seenBehind) {
            afterLines.push('In that time nobody came into view behind you, so there is nothing ' +
                'to describe here. Sauce only places riders on the last few roads you rode, so ' +
                'that is behind you as Sauce saw it.');
        } else if (!after.arrivals.length && !after.ridersReportedFinish) {
            afterLines.push(`Sauce had ${plural(after.seenBehind, 'rider')} ` +
                `in view behind you, but it did not say whether any of them had reached the ` +
                `line, so nobody can be counted in.`);
        } else if (!after.arrivals.length) {
            afterLines.push(`Sauce had ${plural(after.seenBehind, 'rider')} ` +
                `in view behind you, but none of them reached the line inside this time.`);
        } else {
            const n = after.arrivals.length;
            afterLines.push(`${plural(n, 'rider')} reached the line behind you inside ` +
                `this time. The gaps are Sauce's live gaps on the road as each rider reached the ` +
                `line, and can be a second or so out.`);
            for (const g of after.groups) {
                const first = g.riders[0];
                const last = g.riders[g.riders.length - 1];
                if (g.riders.length === 1) {
                    afterLines.push(`${first.name} came in ${first.gap.toFixed(1)} seconds behind ` +
                        `you, at ${fmtClock(first.t)}.`);
                } else {
                    afterLines.push(`A group of ${g.riders.length} came in between ` +
                        `${first.gap.toFixed(1)} and ${last.gap.toFixed(1)} seconds behind you, ` +
                        `${first.t === last.t ? `at ${fmtClock(first.t)}` :
                            `from ${fmtClock(first.t)} to ${fmtClock(last.t)}`}: ${nameList(g.riders)}.`);
                }
                if (g.closedBy != null) {
                    afterLines.push(`${g.riders.length === 1 ? first.name : `That group of ${g.riders.length}`} ` +
                        `was ${g.firstSeenGap.toFixed(1)} seconds behind you when this window first ` +
                        `saw ${g.riders.length === 1 ? 'them' : 'it'} after the line, at ` +
                        `${fmtClock(g.firstSeenT)}, and came in ${first.gap.toFixed(1)} seconds ` +
                        `behind, ${g.closedBy.toFixed(1)} seconds closer.`);
                }
            }
        }
        if (after.stillOnRoad) {
            afterLines.push(`When this window stopped watching, ${after.stillOnRoad} ` +
                `rider${after.stillOnRoad === 1 ? '' : 's'} Sauce had in view behind you had not ` +
                `reached the line yet.`);
        }
        sections.push({
            id: 'afterline',
            title: 'After the line',
            lines: afterLines,
            table: after.arrivals.length ? {
                columns: ['Rider', 'Came in at', 'Behind you'],
                rows: after.arrivals.slice(0, 40).map(x =>
                    [x.name, fmtClock(x.t), `${x.gap.toFixed(1)} s`]),
            } : after.behindAtClock.length ? {
                columns: ['Rider', 'Behind you when the clock ran out'],
                rows: after.behindAtClock.slice(0, 40).map(x => [x.name, `${x.gap.toFixed(1)} s`]),
            } : null,
        });
    }

    // ---------------------------------------------------------------- results
    if (rec.results && rec.results.length) {
        const rows = rec.results.slice(0, 40).map(x => [
            x.place ?? '',
            x.name || '(no name)',
            x.timeSeconds != null ? fmtDuration(x.timeSeconds) : '',
            x.avgWatts != null ? `${Math.round(x.avgWatts)} W` : '',
            x.flags || '',
        ]);
        sections.push({
            id: 'results',
            title: 'Official results, as Zwift returned them',
            lines: [
                'You asked for these, so the mod made the same call to Zwift that Sauce\'s own ' +
                'Events window makes when you open a finished event. It runs on your Zwift login ' +
                'and Sauce saves every entrant\'s profile to its own athlete database as a result.',
                'Place is counted the way Sauce counts it: riders flagged for cheating or ' +
                'sandbagging, and riders on virtual power, are left out of the numbering.',
            ],
            table: {columns: ['Place', 'Rider', 'Time', 'Average power', 'Flags'], rows},
        });
    }

    // ---------------------------------------------------------------- caveats
    if (rec.degraded && rec.degraded.packRowInterval > 2) {
        notes.push(`This race ran long enough that the group around you was recorded every ` +
            `${rec.degraded.packRowInterval} seconds rather than every two.`);
    }
    if (rec.degraded && rec.degraded.selfRowInterval > 1) {
        notes.push(`This race ran long enough that your own numbers were recorded every ` +
            `${rec.degraded.selfRowInterval} seconds rather than every second.`);
    }
    if (rec.resetDetected) {
        notes.push('Sauce reset its own ride data at the gun, which it does when the ' +
            '"auto reset events" setting is on. The numbers below come from the race itself ' +
            'either way.');
    }
    if (rec.trigger === 'manual') {
        notes.push('This recording was started by hand rather than by the start of an event.');
    }
    if (!stats) {
        cannot.push("Sauce's own follow, work and solo split for this race, which was not " +
            'available when the recording was saved.');
    }

    return {
        recId: rec.id,
        title: eventTitle,
        subtitle: when ? when.toLocaleString() : '',
        incomplete: !!rec.incomplete,
        sections,
        notes,
        cannot,
        disclaimer: {title: DISCLAIMER_TITLE, lines: DISCLAIMER},
        meta: {
            source: own.source,
            clock: rec.clock || 'wall',
            gunSource: rec.gunSource || null,
            zwiftClockLate: clockLate,
            joinedLate,
            selfRows: own.t.length,
            packRows: (pack.t || []).length,
            riders: Object.keys(rec.riders || {}).length,
            raceSeconds,
            firstSecond,
            watchedFrom,
            coveredSpan,
            coverage: cov,
        },
    };
}


/* ------------------------------------------------------------------ after the line */

/*
 * Riders reaching the line within this many seconds of the one before them count as one group.
 * It is the gap at which Sauce itself starts a new group (src/stats.mjs:4555). A group "closed a
 * gap" when it came in at least this much nearer than it was first seen after the line: anything
 * smaller is inside the wobble of one bunch.
 */
export const AFTER_LINE_GROUP_GAP = 2;

/*
 * WHAT THIS DOES: turns rec.afterLine into plain facts, for the report and the fact pack alike.
 * Returns null for a recording that did not run on past the line. Reads nothing but
 * rec.afterLine, apart from the race's riders for the names of riders it already knew.
 */
export function afterLineFacts(rec) {
    const al = rec.afterLine;
    if (!al || !isNum(al.finishRaceSecond)) {
        return null;
    }
    const riderOf = key => (al.riders && al.riders[key]) || (rec.riders && rec.riders[key]) || null;
    const named = list => (list || [])
        .filter(x => isNum(x.gap) && isNum(x.t))
        .map(x => {
            const r = riderOf(x.rider);
            return {
                key: x.rider,
                name: (r && (r.name || r.label)) || x.rider || 'a rider with no name',
                t: x.t,
                gap: x.gap,
                firstSeenT: x.firstSeenT,
                firstSeenGap: x.firstSeenGap,
            };
        })
        .sort((a, b) => (a.gap - b.gap) || (a.t - b.t));
    const grouped = list => {
        const groups = [];
        for (const x of list) {
            const g = groups[groups.length - 1];
            if (g && x.gap - g.riders[g.riders.length - 1].gap <= AFTER_LINE_GROUP_GAP) {
                g.riders.push(x);
            } else {
                groups.push({riders: [x]});
            }
        }
        return groups;
    };
    const onClock = al.finishMetric === 'time';
    const arrivals = onClock ? [] : named(al.arrivals);
    const behindAtClock = onClock ? named(al.behindWhenClockRanOut) : [];
    const groups = grouped(arrivals);
    for (const g of groups) {
        const head = g.riders[0];
        g.firstSeenGap = isNum(head.firstSeenGap) ? head.firstSeenGap : null;
        g.firstSeenT = isNum(head.firstSeenT) ? head.firstSeenT : null;
        const closed = g.firstSeenGap != null ? g.firstSeenGap - head.gap : null;
        g.closedBy = closed != null && closed >= AFTER_LINE_GROUP_GAP ? Math.round(closed * 10) / 10 : null;
    }
    return {
        finish: al.finishRaceSecond,
        finishMetric: al.finishMetric ?? null,
        onClock,
        requested: al.requestedSeconds ?? null,
        captured: al.secondsCaptured ?? 0,
        endedBy: al.endedBy ?? null,
        watchingSelf: al.watchingSelfThroughout !== false,
        ridersReportedFinish: !!al.ridersReportedFinish,
        seenBehind: al.ridersSeenBehind || 0,
        // Only a count Sauce's own finish test backs: riders with no `remaining` are not "out".
        stillOnRoad: (!onClock && al.ridersReportedFinish && al.stillOnRoad) || 0,
        arrivals,
        // Riders of the rider's own group ahead of the rider at the line; null in a recording
        // made before the mod kept them.
        aheadInGroup: onClock || !Array.isArray(al.aheadInGroup) ? null :
            named(al.aheadInGroup.map(x => ({...x, t: al.finishRaceSecond}))),
        groups,
        behindAtClock,
        clockGroups: grouped(behindAtClock),
    };
}

export function afterLineEndedText(endedBy) {
    return {
        stop: 'you pressed Stop',
        // Not "you left": Sauce stops putting the rider in the event when Zwift's state no longer
        // carries it (src/stats.mjs:3065-3070), and Sauce's own code expects that to happen on
        // its own some while after a finish, its "cooldown window" (src/stats.mjs:2030).
        'left-event': 'Sauce stopped showing you in the event',
        'changed-event': 'Sauce showed you in a different event',
        'lost-feed': 'the data from Zwift stopped arriving',
        'window-closed': 'the window or Sauce closed while it was running',
    }[endedBy] || endedBy;
}


/* ------------------------------------------------------------------ small helpers */

/*
 * How many SECONDS of a series satisfy `test`, when the series is not one row per second.
 *
 * A row's worth of time is the distance to the next row, capped at twice the nominal interval so
 * that a hole where nothing was recorded is not counted as time that was. Counting rows and
 * calling them seconds is how "For 5m 10s there was no group ahead" ended up being half of the
 * real figure, in a report whose whole point is not to overstate what it knows.
 */
export function secondsWhere(times, test, nominal = 1) {
    if (!times || !times.length) {
        return 0;
    }
    const cap = Math.max(nominal * 2, nominal + 1);
    let total = 0;
    for (let i = 0; i < times.length; i++) {
        if (!test(i)) {
            continue;
        }
        const step = i + 1 < times.length ? Math.min(times[i + 1] - times[i], cap) : nominal;
        total += Math.max(0, step);
    }
    return total;
}


function joinList(items) {
    if (!items.length) {
        return '';
    }
    if (items.length === 1) {
        return items[0];
    }
    return `${items.slice(0, -1).join('; ')}; and ${items[items.length - 1]}`;
}

function clipTimes(t, t0, t1) {
    return t.filter(x => x >= t0 && x <= t1);
}

function clipVals(t, v, t0, t1) {
    const out = [];
    for (let i = 0; i < t.length; i++) {
        if (t[i] >= t0 && t[i] <= t1) {
            out.push(v[i]);
        }
    }
    return out;
}

function firstNum(arr) {
    for (const x of (arr || [])) {
        if (isNum(x)) {
            return x;
        }
    }
    return null;
}

function lastNum(arr) {
    if (!Array.isArray(arr)) {
        return null;
    }
    for (let i = arr.length - 1; i >= 0; i--) {
        if (isNum(arr[i])) {
            return arr[i];
        }
    }
    return null;
}

function avgOf(arr) {
    let s = 0;
    let n = 0;
    for (const x of (arr || [])) {
        if (isNum(x)) {
            s += x;
            n++;
        }
    }
    return n ? s / n : null;
}

function minOf(arr) {
    let m = null;
    for (const x of (arr || [])) {
        if (isNum(x) && (m == null || x < m)) {
            m = x;
        }
    }
    return m;
}

function fmtKj(x) {
    return isNum(x) ? `${Math.round(x)} kJ` : 'an unknown amount';
}

function cmpText(a, b) {
    if (!isNum(a) || !isNum(b) || !b) {
        return 'against';
    }
    const r = a / b;
    if (r > 1.02) {
        return `${Math.round((r - 1) * 100)} percent above`;
    }
    if (r < 0.98) {
        return `${Math.round((1 - r) * 100)} percent below`;
    }
    return 'level with';
}

function stopReasonText(reason) {
    return {
        manual: 'you pressed stop',
        // Not "you left": Sauce stops putting the rider in the event when Zwift's state no longer
        // carries it (src/stats.mjs:3065-3070), and Sauce's own code expects that to happen on
        // its own some while after a finish, its "cooldown window" (src/stats.mjs:2030).
        'left-event': 'Sauce stopped showing you in the event',
        'changed-event': 'Sauce showed you in a different event',
        'lost-feed': 'the data from Zwift stopped arriving',
        'window-closed': 'the window or Sauce closed while it was running',
    }[reason] || reason;
}

/*
 * Sauce gives the enum name for the powerup in use (src/zwift.proto POWERUP_TYPE, decoded at
 * src/zwift.mjs:267). The friendly names riders use are not in Sauce's source at all, so anything
 * not in this table is shown as Sauce spells it rather than guessed at.
 */
export function prettyPowerUp(name) {
    if (!name) {
        return 'powerup';
    }
    // Zwift's enum names are LIGHTNESS for the feather and UNDRAFTABLE for the one riders behind
    // get no draft from (src/zwift.proto:910-923); Sauce shows them as Feather and Undraftable
    // (pages/src/fields.mjs:683-697).
    return {
        LIGHTNESS: 'Feather',
        UNDRAFTABLE: 'Undraftable',
        BOOST: 'Boost',
        FEATHER: 'Feather',
        AERO: 'Aero',
        DRAFTBOOST: 'Draft Truck',
        ANVIL: 'Anvil',
        POWERUP_CNT: 'powerup',
        STEAMROLLER: 'Steamroller',
        NINJA: 'Ghost',
        GHOST: 'Ghost',
        UNDEFINED: 'powerup',
        COFFEE_STOP: 'Coffee Stop',
        BONUS_XP_LIGHT: 'Small XP bonus',
        BONUS_XP: 'XP bonus',
    }[name] || String(name).toLowerCase().replace(/_/g, ' ');
}


/*
 * What the window says when "Get official results" fails.
 *
 * Seen for real on 17 Sep 2026: "Cannot read properties of null (reading 'id')". That is thrown
 * inside Sauce, not by Zwift. In v2.3.0 getEventSubgroupResults reads ad.eventSubgroup.id for a
 * rider who joined, has no result and whom Sauce saw in this event (src/stats.mjs:1515), and
 * ad.eventSubgroup is null once that rider has left the event (:3084). Main fixes it with "?.".
 * That branch only runs while Sauce does not yet count the event as finished (:1495), which is
 * the subgroup's scheduled start plus Sauce's own rough estimate of its length (:1356-1383), so
 * asking again after that time works on 2.3.x too.
 */
export function resultsErrorText(message, estimatedFinishMs = null, nowMs = Date.now()) {
    if (!/null \(reading 'id'\)/.test(String(message))) {
        return `Zwift did not return results: ${message}`;
    }
    const when = Number.isFinite(estimatedFinishMs) && estimatedFinishMs > nowMs ?
        `after ${new Date(estimatedFinishMs).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}, ` +
        'when Sauce counts the event as over' :
        'in a few minutes';
    return 'Sauce could not put the results together yet. Your version of Sauce has a fault in its ' +
        'own results code that trips while it thinks the event is still running and a rider who ' +
        `started it has left without finishing. Nothing is lost: try again ${when}.`;
}


/* ------------------------------------------------------------------ rendering */

export function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function renderReportHTML(model) {
    const parts = [];
    parts.push(`<header class="report-head"><h1>${esc(model.title)}</h1>` +
        `<div class="sub">${esc(model.subtitle)}` +
        `${model.incomplete ? ' <span class="tag warn">incomplete recording</span>' : ''}</div></header>`);
    if (model.notes && model.notes.length) {
        parts.push(`<div class="notes"><ul>` +
            model.notes.map(x => `<li>${esc(x)}</li>`).join('') + `</ul></div>`);
    }
    for (const s of model.sections) {
        parts.push(`<section id="sec-${esc(s.id)}"><h2>${esc(s.title)}</h2>`);
        if (s.lines && s.lines.length) {
            parts.push(`<ul class="lines">` + s.lines.map(x => `<li>${esc(x)}</li>`).join('') + `</ul>`);
        }
        if (s.table) {
            parts.push(`<table><thead><tr>` +
                s.table.columns.map(c => `<th>${esc(c)}</th>`).join('') +
                `</tr></thead><tbody>` +
                s.table.rows.map(r => `<tr>` + r.map(c => `<td>${esc(c)}</td>`).join('') + `</tr>`).join('') +
                `</tbody></table>`);
        }
        parts.push(`</section>`);
    }
    parts.push(`<section id="sec-cannot"><h2>What this report cannot know</h2><ul class="lines">` +
        model.cannot.map(x => `<li>${esc(x)}</li>`).join('') + `</ul></section>`);
    parts.push(`<section id="sec-disclaimer" class="disclaimer"><h2>${esc(model.disclaimer.title)}</h2>` +
        `<ul class="lines">` + model.disclaimer.lines.map(x => `<li>${esc(x)}</li>`).join('') +
        `</ul></section>`);
    return parts.join('\n');
}
