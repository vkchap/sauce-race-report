/*
 * Race Report - the recorder.
 *
 * WHAT THIS FILE DOES: it turns two Sauce data feeds into one saved recording of a race. It is
 * pure logic. No DOM, no Sauce imports, no network, no timers of its own, so the whole thing runs
 * in plain node against a synthetic feed (see test/). Everything that touches Sauce is in ui.mjs.
 *
 * It is fed exactly two payload shapes, both read from Sauce for Zwift v2.3.0 source:
 *
 *   athlete/self/v2   src/stats.mjs:4327-4386  (_formatAthleteDataV2), asked for with
 *                     resources ['state'] only
 *   groups/v2         src/stats.mjs:4224-4230  (_formatGroupsWithFormattedNearby) over the group
 *                     objects built at src/stats.mjs:4562-4664 (_computeGroups), asked for with
 *                     NO resources at all
 *
 * START AND FINISH are Sauce's own tests, re-run on the payload rather than inferred:
 *
 *   start   The gun is the scheduled start of the rider's category, when Sauce has it (see THE
 *           GUN below): once the rider is in the event subgroup and that moment has passed, the
 *           recording starts, even while state.time is still zero. Without it, the start is
 *           Sauce's own: Sauce opens an "event slice" when state.time becomes non-zero while the
 *           rider is in an event subgroup (src/stats.mjs:3050-3058). In the start pen state.time
 *           is zero, so `eventSubgroupId != null && state.time > 0` is that start, not merely
 *           being in an event.
 *
 *   finish  Sauce closes the slice when state.eventDistance passes sg.endDistance, or when the
 *           server clock passes sg.endTS (src/stats.mjs:3059-3062). Both are published on every
 *           payload as `remaining` with `remainingType: 'event'`, because _getEventOrRouteInfo
 *           computes remaining as exactly `sg.endDistance - state.eventDistance` or
 *           `(sg.endTS - serverTime) / 1000` (src/stats.mjs:4293-4316).
 *
 *           CAREFUL: when Sauce knows neither an end distance nor an end time for the event,
 *           `sg.endDistance` is undefined and `remaining` comes out NaN while remainingType is
 *           still 'event' (src/stats.mjs:4310-4315). Every comparison against NaN is false, so a
 *           naive `remaining < 0` test would never fire and the recording would never stop. That
 *           is why isPastEventEnd insists on a finite number and hasUnknownEventEnd exists.
 *
 * THE CLOCK. Every time in a saved recording is "seconds since the gun", not "seconds since this
 * window started recording". The offset between the two is taken once and added to every row
 * after that. Without it, a window opened ten minutes into a race produces rows numbered from
 * zero that cannot be lined up against Sauce's own per-second streams, and the report ends up
 * saying "recorded for 20s" over forty minutes of power.
 *
 * THE GUN. On 16 Sep 2026 (event 5694402, category A scheduled for 09:40:00) Zwift's state.time
 * for Van only began counting 67 seconds after the scheduled start, while he was already riding
 * out of the pen and Zwift's own HUD clock counted from 09:40:00. Why is not known, and nothing
 * here assumes a reason. So the gun is the category's scheduled start, not state.time:
 *
 *   where   Sauce keeps each subgroup it has loaded with `sg.ts = +new Date(sg.eventSubgroupStart)`
 *           (src/stats.mjs:3726-3728; for a meetup eventSubgroupStart is meetup.eventStart,
 *           :3796). ui.mjs reads it with getCachedEvents, a pure memory read
 *           (src/stats.mjs:1328-1330), and hands it in through setScheduledStart. Sauce does not
 *           always have it: its subgroup lookup needs the event id in its local database. When
 *           that id is there and the request to Zwift fails, Sauce allows a retry after 30 s
 *           (src/stats.mjs:1391-1404, :1343-1350). When it is not there, Sauce logs "Could not
 *           find subgroup eventId required for lookup" and never asks again by itself
 *           (:1405-1407, and processState only queues a lookup for a subgroup it has never tried,
 *           :3031-3033), so until a later event feed sync brings the event in (:3843-3847) the
 *           payload never carries Sauce's eventSubgroupId and nothing starts at all.
 *   late    The answer is asynchronous, so it can reach the recorder after a recording has
 *           already started on state.time: a window opened mid race, a window reloaded, Sauce
 *           restarted, or a late join with Zwift's clock already running. setScheduledStart then
 *           moves that recording onto the gun clock. Every row is the whole seconds since the
 *           recording started plus one offset, so moving it is one exact shift of every race
 *           second the recording holds.
 *   clock   The scheduled start is a server time, so it is compared with Sauce's server clock.
 *           Every state carries worldTime, and Sauce turns that into server time as
 *           `worldTime + epoch` (src/zwift.mjs:91, :111-113), the same test it uses for an
 *           event's end time (src/stats.mjs:3061). That is the state's own time, so it, and not
 *           the moment the payload reaches this window, decides whether the gun has passed. The
 *           payload's `updated` is that same world time on the computer's clock
 *           (src/stats.mjs:3495, src/zwift.mjs:103-105), so the difference between the two is
 *           exactly Sauce's own correction of the computer clock, with no network latency in it.
 *           It is measured, saved, and used; only when a payload does not carry it does the
 *           recorder fall back to the computer's clock, and says so.
 *   rows    Each self row also keeps state.time as it was, so a file on its own shows where
 *           Zwift's clock started against the gun (zwiftClockStartedAtRaceSecond). Sauce's own
 *           event slice, stats and streams start on Zwift's clock, not the gun
 *           (src/stats.mjs:3050-3058), which is why report.mjs puts the mod's own rows in front
 *           of Sauce's streams for the stretch before it. Sauce's stream times are seconds after
 *           ad.wtOffset (src/stats.mjs:3389) and every payload carries that moment as
 *           createdServerTime (:4334), so the last one before the line is saved and report.mjs
 *           places each stream sample on the gun clock from it, rather than guessing where
 *           Sauce's slice began.
 *   stale   Sauce's own eventSubgroupId only changes once a new subgroup has loaded
 *           (src/stats.mjs:3030-3036), so for a while after the game moves the rider into another
 *           event it can still be the previous one. The gun, and Zwift's clock as a start, are
 *           only used while the game's own state.eventSubgroupId agrees with it.
 *   join    A join is dated when this window saw the rider enter the subgroup. A late join from
 *           Zwift's home screen sends nothing before it (Sauce emits athlete/self/v2 only for a
 *           state it processes, src/stats.mjs:3493-3513), so the window's very first payload
 *           already has the rider in the event. That counts as a join only when the window had
 *           been listening since before the gun and Zwift's event distance on it is still near
 *           zero; otherwise it is a window that came up late.
 *   none    Without a scheduled start the recording starts and counts the way it did before this
 *           existed, from state.time, and a note says so.
 *
 *           Not taken: treating the raw state.eventSubgroupId as "in the event" while Sauce's own
 *           eventSubgroupId (ad.eventSubgroup?.id, src/stats.mjs:4343) is still missing. Sauce
 *           only adopts the raw id once the subgroup has loaded and its course matches the
 *           rider's, with the comment "state.eventSubgroupId races" (src/stats.mjs:3029-3036),
 *           and state.time outside an event is the session's elapsed time, so a start on the raw
 *           id alone could anchor a race to the wrong clock. The raw id is only used to date when
 *           the rider joined, to check Sauce's id is not stale, and by ui.mjs to look the
 *           scheduled start up early.
 *
 * COVERAGE. At the end the recorder counts the seconds it actually has against the seconds the
 * race ran, and writes that into the recording. A window that was frozen, or opened late, or
 * interrupted, produces a recording that says so rather than one that reads as complete.
 *
 * AFTER THE LINE. Van, 16 Sep 2026: "yes add it - I think adding 2 minutes to any race likely
 * captures anything interesting". An automatic recording can keep running for a set time after
 * the rider's own finish, to see the riders behind come in. The race itself still ends at the
 * line. The moment the finish packet arrives, the race is frozen: a copy is taken of exactly the
 * rows, riders, counts and notes that a recording with no extra time would have saved on that
 * same packet, and handed to ui.mjs through onLine so it is saved there and then. Rows are cut by
 * how many existed when the finish packet arrived, not by second, because Sauce's self and
 * groups feeds arrive in either order inside a second (src/stats.mjs:3509-3513 against the 1 s
 * timer at :4182-4216). After the line nothing can change the frozen race: not names, notes, the
 * size ladder or caveats. The same race saved with no extra time and with two minutes of it
 * therefore carries the same race data.
 *
 *           A rider behind "came in" when Sauce's own finish test flips for them. Each rider in a
 *           groups/v2 payload is formatted by _formatAthleteDataV2 (src/stats.mjs:4213-4215,
 *           :4229), so it carries the same `remaining` and `remainingType` as the rider's own
 *           payload (src/stats.mjs:4293-4316, :4351), and `gap`, which for a rider behind is how
 *           long ago the watched rider was where they are now (src/stats.mjs:4459). At the moment
 *           they reach the line that is their gap at the line. It is a live road gap, not a
 *           result, and the report says so.
 *
 *           Not in an event that ends on the clock. There `remaining` is
 *           `(sg.endTS - serverTime) / 1000` with one endTS for the whole subgroup
 *           (src/stats.mjs:4298-4306, :3748-3749), so it goes below zero for every rider at the
 *           same moment and nobody "comes in" one by one. For those events the mod keeps only
 *           who was behind on the road when the clock ran out.
 *
 * WHO WAS IN THE OTHER GROUPS. Van, 16 Sep 2026, choosing both report styles: "commentary to
 * share with team mates, debrief to review with my coach". Both need the groups up and down the
 * road, not only the rider's own, so the recorder keeps a membership log, `moves`: one entry each
 * time another rider's place against the rider's group changes, as [race second, rider, from,
 * to]. The rider is the per-race `seq` number in `riders`, never an athlete id, so a rider Sauce
 * could not name stays unidentifiable. A place is one of:
 *
 *   -2  a group further up the road than the group just ahead of the rider's
 *   -1  the group just ahead of the rider's
 *    0  the rider's own group
 *    1  the group just behind
 *    2  a group further back than that
 *   null  not in any group Sauce had in view
 *
 * Only a change that held is logged. On Van's 69 minute session of 16 Sep 2026, in a big field,
 * Sauce's grouping flickered from second to second: riders a few tenths apart fall either side of
 * its 0.8 s and 2 s cuts (src/stats.mjs:4553-4556) from one payload to the next. So, checked on
 * every groups payload rather than every pack row:
 *
 *   - a rider's place changes once they have been somewhere else on every payload for
 *     MOVE_HOLD_SECONDS, and the new place is the one seen most in that time, the group next to
 *     the rider's winning over one further away when seen on a third of the payloads (Roster);
 *   - between the group next to the rider's and one further away on the same side (-1 and -2, or
 *     1 and 2) the change has to hold SAME_SIDE_HOLD_FACTOR times as long, because a real group
 *     straddling one of Sauce's cuts moves every rider beyond it back and forth;
 *   - a gap of more than MAX_PAYLOAD_GAP_SECONDS in the feed starts the hold again;
 *   - at the line, a change Sauce showed on every payload for LINE_HOLD_SECONDS counts, so a split
 *     in the final sprint is not lost (Roster.flushAtLine).
 *
 * Each change is logged at the second it began. Groups further up or down the road are not told
 * apart from each other (-2 and 2), so a change among them is not a move at all, and nothing is
 * logged after the line. The report reads group sizes from this log too (groupSizesFromLog in
 * report.mjs), because a pack row is one payload in two and carries whatever flicker it had.
 *
 * WHO CROSSED BEFORE THE RIDER. The riders of the rider's own group who were ahead of the rider on
 * Sauce's last groups payload before the line are kept once, at the line, with Sauce's gap then
 * (afterLine.aheadInGroup), by the same per-race key as the arrivals. With the arrivals behind, that
 * says where in the group the rider crossed.
 *
 * ROAD POSITION. Each self row also keeps state.roadTime, and each change of road is kept as
 * [race second, courseId, roadId, reverse]. With them the report can name the route segments
 * Sauce itself knows for a stretch of road, using Sauce's own active segment test
 * (src/stats.mjs:3527-3546). The segment names are looked up locally by ui.mjs when the race is
 * saved (getSegmentsForRoad, src/app.mjs:320-327).
 */

// 5: inGroup, each rider's power and draft while in the rider's group (WHO DID WHAT IN YOUR GROUP),
//    and roadGroups, every group in view on each pack row (THE GROUPS ON THE ROAD).
// 4: moves, timeline.roadTime and timeline.roadEvents, and each rider's seq and team.
// 3: the gun clock fields (scheduledStartISO, gunSource, timeSource, zwiftClockStartedAtRaceSecond
// and friends) and timeline.stateTime. A version 2 recording counts from state.time.
export const SCHEMA_VERSION = 5;
export const MOD_VERSION = '1.0.7';

/*
 * The oldest Sauce this mod is known to work on. 2.3.0 is the oldest release whose source was
 * read line by line while this was written; the mod platform and the data model are unchanged
 * between it and the 2.4.0-alpha.2 main branch. Older builds may not have the athlete/self/v2
 * emitter at all, in which case the subscription registers and nothing is ever delivered
 * (src/stats.mjs:921-928), which is why ui.mjs says so on screen instead of waiting forever.
 */
export const MIN_SAUCE_VERSION = '2.3.0';

// Rough JSON cost of one number plus separator. Used only for the size guard.
const BYTES_PER_NUMBER = 6;
// And of one rider's entry in `riders`, and of one more [from, to] span in its withMe.
const BYTES_PER_RIDER = 90;
const BYTES_PER_SPAN = 12;

/*
 * The longest "keep recording after you finish" the mod accepts. The size guard is not run after
 * the line (it would change the race's own row intervals), so this is what keeps a race that
 * already sits at the size ladder's top step under the 400 kB cap used with no database:
 * five minutes of rows is about 30 kB. See THE SIZE RULE in store.mjs.
 */
export const MAX_AFTER_LINE_SECONDS = 300;

/*
 * A rider's last `remaining` only counts towards "came in" if it was seen this recently. groups/v2
 * arrives once a second (src/stats.mjs:4182-4216), but a rider drops out of it whenever Sauce
 * cannot place them on the watched rider's last roads or their state is over 15 s old
 * (src/stats.mjs:4441-4457). Without this, a rider last seen minutes ago short of the line and
 * seen again past it would be counted as coming in now.
 */
const LINE_SIGHTING_SECONDS = 3;

/*
 * A rider behind whose own crossing reached this window up to this many seconds before the
 * rider's own finish packet still counts as coming in behind. The two feeds are independent, so
 * in a sprint the payload showing a rider 0.3 s back already past the line can arrive first.
 */
const LINE_ORDER_SECONDS = 2;

/* Zwift's world time counts from this epoch; Sauce adds it to get server time (src/zwift.mjs:91). */
export const ZWIFT_EPOCH_MS = 1414016074400;

/*
 * A measured server clock offset bigger than this is not a clock being off, it is a payload whose
 * worldTime or updated is not what Sauce sends, so it is not used.
 */
const MAX_SERVER_OFFSET_MS = 24 * 3600 * 1000;

/*
 * A window's first payload is only a late join (see THE GUN) when Zwift's event distance on it is
 * no more than this. A rider seen already this far into the event is somebody the window missed.
 */
const JOIN_MAX_EVENT_DISTANCE_M = 200;

/*
 * A rider's new place against the rider's group has to hold this long before the membership log
 * records it (see WHO WAS IN THE OTHER GROUPS at the top). Five seconds is the rule the report
 * styles were designed on (spec/report-styles/input-design.md); a flicker lasts a payload or two.
 */
export const MOVE_HOLD_SECONDS = 5;

/*
 * A change between the group next to the rider's and a group further away on the same side (-1 and
 * -2, or 1 and 2) has to hold this many times as long. Places are Sauce's group order, so a real
 * group straddling Sauce's 2 s cut behind the rider's pushes every rider beyond it from 1 to 2 and
 * back on alternate payloads; a 3 hour synthetic race logged 160 such changes that never happened.
 */
export const SAME_SIDE_HOLD_FACTOR = 4;

/* Payloads further apart than this (a frozen window, a stall in the feed) end a change's run. */
const MAX_PAYLOAD_GAP_SECONDS = 2;

/* At the line, a change seen on every payload for this long counts (Roster.flushAtLine). */
export const LINE_HOLD_SECONDS = 3;

/*
 * The place a run of payloads points to: the one seen most, and of those the one seen last. Except
 * that the group next to the rider's wins over a group further away on the same side when it was
 * seen on at least a third of the run's payloads: a rider can only show further away when some
 * group is between, and a group between that is really there is there on nearly every payload,
 * while one that flickers is not.
 */
function pendingTarget(p) {
    let best = null;
    let total = 0;
    for (const [place, [n, , last]] of p.seen) {
        total += n;
        if (!best || n > best[1] || (n === best[1] && last > best[2])) {
            best = [place, n, last];
        }
    }
    const near = typeof best[0] === 'number' && Math.abs(best[0]) === 2 ? p.seen.get(Math.sign(best[0])) : null;
    return near && near[0] * 3 >= total ? Math.sign(best[0]) : best[0];
}

const ZWIFT_CLOCK_FALLBACK_NOTE = 'Sauce did not have the scheduled start of this event when the ' +
    'recording began, so times in it count from when Zwift\'s own race clock for you started, not ' +
    'from the gun. If that clock started late, the opening of the race is not in this recording.';

const r0 = x => (x == null || !isFinite(x)) ? null : Math.round(x);
const r1 = x => (x == null || !isFinite(x)) ? null : Math.round(x * 10) / 10;
const r3 = x => (x == null || !isFinite(x)) ? null : Math.round(x * 1000) / 1000;
const isNum = x => typeof x === 'number' && isFinite(x);


/*
 * WHAT THIS CLASS DOES: keeps track of the other riders seen during one race, and decides what is
 * written down about them.
 *
 * Names are NOT taken from the live feed. The groups/v2 subscription asks for no resources at
 * all, so no rider profile crosses into this window once a second. Instead ui.mjs asks Sauce, at
 * a slow interval, for the names of the ids seen so far, using getAthletes, which is a pure read
 * of the profiles Sauce already has on disk (src/stats.mjs:2414-2416 -> _getAthlete ->
 * _loadAthlete, no network). Those names arrive here through setName.
 *
 * A rider Sauce has no name for is labelled, in order of first appearance, and saved WITHOUT the
 * athlete id. A reader of two saved reports therefore cannot tell whether "Rider A" in one is
 * "Rider A" in the other, which is what Van asked for on 16 Sep 2026. Riders Sauce did name keep
 * their id, which is what Sauce itself stores in athletes.sqlite (src/stats.mjs:3570-3577).
 *
 * Labels are worked out at save time rather than when a rider first appears, so a rider whose
 * profile turns up half way through the race does not burn a label and leave a gap.
 *
 * WHAT IS KEPT PER RIDER, and nothing else: the name Sauce already shows, the id when there is a
 * name, the team tag Sauce reads out of that name when it finds one (src/stats.mjs:70-89,
 * :2275-2282, shown as a badge in Sauce's own Groups window, pages/src/groups.mjs:437-479; Van,
 * 16 Sep 2026, for ZRL teammates), a per-race sequence number the membership log refers to, when
 * they were first and last seen, and the spans of seconds they were in the rider's own group.
 * At the line, for a rider of the rider's own group who was ahead of the rider, their gap then,
 * once (see WHO CROSSED BEFORE THE RIDER at the top). After the line, only for a rider behind in
 * the same event who reaches it (or, in an
 * event that ends on the clock, who was behind when it ran out), the second they did and their
 * gap then, once, which is what the After the line part of the report reads (see AFTER THE LINE
 * at the top). Other riders in view after the line are not kept at all. An earlier version also
 * kept each rider's gap to the rider every five seconds; that was dropped because no line of the report ever read it, and keeping a second by second track of
 * somebody else's position on disk for something nothing uses is not defensible.
 */
export class Roster {
    constructor() {
        this.byId = new Map();
    }

    static labelFor(seq) {
        // A..Z, then AA, AB, ...
        let n = seq;
        let s = '';
        do {
            s = String.fromCharCode(65 + (n % 26)) + s;
            n = Math.floor(n / 26) - 1;
        } while (n >= 0);
        return `Rider ${s}`;
    }

    see(athleteId, t) {
        let rec = this.byId.get(athleteId);
        if (!rec) {
            rec = {name: null, team: null, seq: this.byId.size, firstT: t, lastT: t, withMe: [],
                   place: undefined, pending: null};
            this.byId.set(athleteId, rec);
        }
        rec.lastT = t;
        return rec;
    }

    /*
     * A rider who came in after the rider's own line. It never touches what the race recorded
     * about a rider (last seen, time in the rider's group), and a rider seen for the first time
     * here is kept apart from the race's riders, so the race reads the same with or without the
     * extra time. Such a rider still gets a name or a label, because the After the line part names
     * who came in.
     */
    seeAfterLine(athleteId, t) {
        let rec = this.byId.get(athleteId);
        if (!rec) {
            rec = {name: null, team: null, seq: this.byId.size, firstT: t, lastT: t, withMe: [],
                   afterLineOnly: true};
            this.byId.set(athleteId, rec);
        }
        return rec;
    }

    /* The team tag only arrives with a name: a rider Sauce cannot name has no profile to read it from. */
    setName(athleteId, name, team = null) {
        const rec = this.byId.get(athleteId);
        if (rec && name && !rec.name) {
            rec.name = name;
            rec.team = team ? String(team) : null;
        }
    }

    /*
     * One groups payload's worth of evidence for the membership log: `place` is where the rider was
     * against the rider's group on it (see WHO WAS IN THE OTHER GROUPS at the top). Returns the move
     * to log, as [t, seq, from, to] with t the second the new place began, once it has held for
     * `hold` seconds; otherwise null. A rider's first place counts as a move from null, so the log
     * alone says who was where at any second.
     */
    observePlace(athleteId, place, t, hold) {
        const rec = this.byId.get(athleteId);
        if (!rec || rec.afterLineOnly) {
            return null;
        }
        const was = rec.place === undefined ? null : rec.place;
        if (place === was && rec.place !== undefined) {
            rec.pending = null;
            return null;
        }
        /*
         * A change is a run of payloads on which the rider was somewhere other than their place,
         * whatever mix of other places Sauce showed. Where a real group straddles one of Sauce's
         * cuts, a rider really dropped can show as the group behind on one payload and a group
         * further back on the next; asking for one exact new place to repeat would never log them
         * leaving (Van's review, 16 Sep 2026). A gap in the feed ends the run: the hold counts
         * payloads that were seen, not seconds nobody saw.
         */
        let p = rec.pending;
        if (!p || t - p.lastT > MAX_PAYLOAD_GAP_SECONDS) {
            p = rec.pending = {since: t, lastT: t, seen: new Map()};
        }
        p.lastT = t;
        const s = p.seen.get(place) || [0, t, t];
        s[0]++;
        s[2] = t;
        p.seen.set(place, s);
        const to = pendingTarget(p);
        // Between the group next to the rider's and a group further away on the same side is only
        // a group forming or going between them, which a group straddling a cut does on every
        // other payload, so that change has to hold much longer.
        const sameSide = isNum(rec.place) && isNum(to) && rec.place !== 0 && to !== 0 &&
            Math.sign(rec.place) === Math.sign(to);
        if (t - p.since < (sameSide ? hold * SAME_SIDE_HOLD_FACTOR : hold)) {
            return null;
        }
        return this._confirm(rec, to, was);
    }

    _confirm(rec, to, was) {
        const move = [rec.pending.seen.get(to)[1], rec.seq, was, to];
        rec.place = to;
        rec.pending = null;
        return to === was ? null : move;
    }

    /*
     * At the line: a change that had begun but not yet held MOVE_HOLD_SECONDS still counts when
     * Sauce showed it on every payload of the last LINE_HOLD_SECONDS or more, or a split in the
     * final sprint would leave riders who crossed clear of the rider in "your group". A change
     * between groups on the same side is left as it was. Returns the moves to log.
     */
    flushAtLine(t) {
        const out = [];
        for (const rec of this.byId.values()) {
            const p = rec.pending;
            if (rec.afterLineOnly || !p || t - p.lastT > MAX_PAYLOAD_GAP_SECONDS) {
                continue;
            }
            const to = pendingTarget(p);
            const [n, first] = p.seen.get(to);
            const was = rec.place === undefined ? null : rec.place;
            const sameSide = isNum(was) && isNum(to) && was !== 0 && to !== 0 && Math.sign(was) === Math.sign(to);
            // One place on every payload of the run, and the run long enough.
            if (sameSide || p.seen.size !== 1 || p.lastT - first + 1 < LINE_HOLD_SECONDS || n < LINE_HOLD_SECONDS) {
                continue;
            }
            const move = this._confirm(rec, to, was);
            if (move) {
                out.push(move);
            }
        }
        return out;
    }

    /*
     * The ids Sauce has not given this mod a name for yet, so ui.mjs can ask again. With
     * afterLineOnly, only the riders first seen after the line: the race's riders are frozen then.
     */
    unnamedIds({afterLineOnly = false} = {}) {
        const out = [];
        for (const [id, rec] of this.byId) {
            if (!rec.name && (!afterLineOnly || rec.afterLineOnly)) {
                out.push(id);
            }
        }
        return out;
    }

    /*
     * Open or extend a "was in my group" interval. `tolerance` is how big a gap between two
     * sightings still counts as continuous: it has to follow the interval pack rows are recorded
     * at, or a long race that thinned its rows would shatter every interval into single seconds.
     */
    markWithMe(athleteId, t, tolerance = 3) {
        const rec = this.byId.get(athleteId);
        if (!rec) {
            return;
        }
        const last = rec.withMe[rec.withMe.length - 1];
        if (last && t - last[1] <= tolerance) {
            last[1] = t;
        } else {
            rec.withMe.push([t, t]);
        }
    }

    labels() {
        // Labels in order of first appearance, so the report never shows a "Rider B" with no
        // "Rider A" in it. Riders first seen after the line come after every race rider, so they
        // take the next labels and leave the race's own labels as they were.
        const unnamed = Array.from(this.byId.entries())
            .filter(([, r]) => !r.name)
            .sort((a, b) => (!!a[1].afterLineOnly - !!b[1].afterLineOnly) || (a[1].firstT - b[1].firstT));
        const labels = new Map();
        unnamed.forEach(([id], i) => labels.set(id, Roster.labelFor(i)));
        return labels;
    }

    /* The key a rider is saved under: the athlete id when Sauce named them, the label if not. */
    keyFor(athleteId, labels = this.labels()) {
        const rec = this.byId.get(athleteId);
        if (!rec) {
            return null;
        }
        return rec.name ? String(athleteId) : labels.get(athleteId);
    }

    /* The race's riders, or with afterLineOnly the riders first seen after the line. */
    toJSON({afterLineOnly = false} = {}) {
        const entries = Array.from(this.byId.entries())
            .filter(([, r]) => !!r.afterLineOnly === afterLineOnly);
        const labels = this.labels();
        const out = {};
        for (const [id, rec] of entries) {
            if (rec.name) {
                out[String(id)] = {
                    athleteId: id,
                    label: null,
                    name: rec.name,
                    team: rec.team || null,
                    seq: rec.seq,
                    firstT: rec.firstT,
                    lastT: rec.lastT,
                    withMe: rec.withMe,
                };
            } else {
                const label = labels.get(id);
                out[label] = {
                    athleteId: null,
                    label,
                    name: null,
                    team: null,
                    seq: rec.seq,
                    firstT: rec.firstT,
                    lastT: rec.lastT,
                    withMe: rec.withMe,
                };
            }
        }
        return out;
    }

    anonymousCount() {
        let n = 0;
        for (const rec of this.byId.values()) {
            if (!rec.name && !rec.afterLineOnly) {
                n++;
            }
        }
        return n;
    }
}


function emptyTimeline() {
    return {
        t: [],               // seconds since the gun (see THE CLOCK at the top)
        stateTime: [],       // Zwift's state.time on the same packet, as it was (see THE GUN)
        power: [],
        hr: [],
        cadence: [],
        speed: [],
        draft: [],
        distance: [],
        eventDistance: [],
        grade: [],
        wbal: [],
        eventPosition: [],
        eventParticipants: [],
        roadTime: [],        // state.roadTime, where on its road the rider was (ROAD POSITION)
        powerUpEvents: [],   // [t, name] transitions of state.activePowerUp
        roadEvents: [],      // [t, courseId, roadId, reverse 0 or 1] changes of road
    };
}


/* The membership log (WHO WAS IN THE OTHER GROUPS at the top), one entry per index. */
/*
 * WHO DID WHAT IN YOUR GROUP. Van, 22 Sep 2026, on a tester's "it didn't track pack dynamics at all
 * - didn't know who in the group was pulling, drafting, if they were taking turns": keep each
 * rider's power and draft while they were in the rider's group, "to call out things like most and
 * least in the draft... and highest and least power". Sauce shows both for every nearby rider in its
 * Nearby and Groups windows; keeping them in the recording and pasting them into an AI is the step
 * past Sauce that Van agreed to. They come from each rider's `state` on the groups feed, asked for
 * exactly as Sauce's own Groups window asks (pages/src/groups.mjs:824-830).
 *
 * One row per rider per IN_GROUP_SECONDS they were in the rider's group, by the rider's per-race
 * `seq` (the rider themselves as -1, so the texts can rank them too), never by athlete id: average
 * power, average draft (Sauce's watts saved), the payloads with no draft at all, and how many
 * payloads the row stands for. Nothing is kept after the line, or for riders in other groups.
 */
export const IN_GROUP_SECONDS = 10;
export const SELF_SEQ = -1;

/*
 * THE GROUPS ON THE ROAD. A tester, 22 Sep 2026: "It tracks a lot about my group, but not about
 * other groups. In my case a good race report would have called out the group splitting apart ahead
 * of me." Sauce sends every group in view on each groups payload, with its size, gap, average power
 * and speed and its own group id (src/stats.mjs:4562-4664), at no extra cost. The pack rows kept only
 * the groups next to the rider's; this keeps all of them, on each pack row, up to ROAD_GROUPS_EACH_SIDE
 * either side: the group's place against the rider's (-1 the group just ahead), Sauce's id for it
 * (null for a rider alone, which Sauce gives none), size, gap, power and speed. No riders' names or
 * ids. Kept only where there is room for it, like inGroup.
 */
export const ROAD_GROUPS_EACH_SIDE = 6;

function emptyRoadGroups() {
    return {t: [], rel: [], id: [], size: [], gap: [], power: [], speed: []};
}

function emptyInGroup() {
    return {t: [], rider: [], power: [], draft: [], wind: [], n: []};
}

function emptyMoves() {
    return {
        t: [],       // the race second the new place began
        rider: [],   // the rider's seq in `riders`
        from: [],    // -2 | -1 | 0 | 1 | 2 | null
        to: [],
    };
}


function emptyPack() {
    return {
        t: [],
        myGroupSize: [],
        ridersAheadOtherGroups: [],   // riders in groups AHEAD of mine, not riders in my own group
        ridersBehindOtherGroups: [],
        gapAheadGroup: [],
        sizeAheadGroup: [],
        gapBehindGroup: [],
        sizeBehindGroup: [],
        groupPower: [],
        groupDraft: [],
        groupHr: [],
        groupSpeed: [],
        groupsVisible: [],            // 0 means Sauce had nobody in view at all, which is not
        ridersVisible: [],            // the same thing as riding alone
    };
}


export class Recorder {
    /*
     * options:
     *   now                 () => epoch ms. Injected so tests can drive the clock.
     *   packRowInterval     seconds between pack rows (default 2). The rider's own numbers are
     *                       kept every second; the shape of the race around them is kept every
     *                       two, which is finer than anything the report reads and roughly halves
     *                       the size of a recording. See THE SIZE RULE in store.mjs.
     *   sizeBudgetBytes     soft cap on one recording (default 400 kB, see store.mjs)
     *   sizeGuard           thin long races as they near sizeBudgetBytes (default true). ui.mjs
     *                       turns it off when recordings are kept in IndexedDB, where a race of
     *                       hours fits at full resolution; the ladder is for the localStorage
     *                       fallback only. See THE SIZE RULE in store.mjs.
     *   lostFeedSeconds     finalize as incomplete after this long with no self packet
     *   autoRecord          start by itself when a race starts (default true)
     *   afterLineSeconds    keep an automatic recording running this long after the rider's
     *                       finish (default 0 here, which is the behaviour before the setting
     *                       existed; ui.mjs passes the rider's setting, which defaults to 120,
     *                       see store.mjs). See AFTER THE LINE at the top.
     *   gunClock            count from the category's scheduled start when setScheduledStart has
     *                       given one, and note it when it has not (default false here, which is
     *                       the behaviour before it existed; ui.mjs passes true). See THE GUN.
     *   listeningSince      epoch ms on this computer's clock from which the window was listening
     *                       for the rider's data (ui.mjs passes when it loaded), so a first
     *                       payload after the gun can be told to be a join. See THE GUN.
     *   onChange          called whenever state or counters change
     *   onLine              called with (race, roster) the moment an automatic recording that is
     *                       going on past the line reaches it. `race` is the race exactly as a
     *                       recording with no extra time would have finalized it on that packet,
     *                       so ui.mjs can save it, with Sauce's stats and streams, there and then.
     *   onFinalized         called with (recording, roster) when a recording closes. After extra
     *                       time it is that same race with endedAt and afterLine filled in.
     */
    constructor(options = {}) {
        this.now = options.now || (() => Date.now());
        this.packRowInterval = options.packRowInterval ?? 2;
        this.sizeBudgetBytes = options.sizeBudgetBytes ?? 400_000;
        this.sizeGuard = options.sizeGuard !== false;
        // WHO DID WHAT IN YOUR GROUP only where there is room for it: IndexedDB, where ui.mjs turns
        // the size guard off. With no database the 400 kB a race keeps the race itself first.
        this.keepInGroup = options.keepInGroup ?? !this.sizeGuard;
        this.lostFeedSeconds = options.lostFeedSeconds ?? 120;
        this.autoRecord = options.autoRecord !== false;
        this.afterLineSeconds = options.afterLineSeconds ?? 0;
        this.gunClock = options.gunClock === true;
        this.listeningSince = isNum(options.listeningSince) ? options.listeningSince : null;
        this.onChange = options.onChange || (() => undefined);
        this.onLine = options.onLine || (() => undefined);
        this.onFinalized = options.onFinalized || (() => undefined);

        this.state = 'idle';           // idle | recording
        this.rec = null;
        this.lastSelfAt = null;
        this.lastGroupsAt = null;
        this.lastSelfPayloadAge = null;
        this.goodSelfPayloads = 0;
        this.badSelfPayloads = 0;
        this.consecutiveBadSelfPayloads = 0;
        this.lastSubgroupId = null;    // last event subgroup seen, recording or not
        this._roster = null;
        this._sliceId = null;
        this._subgroupId = null;
        this._adCreated = null;
        this._approxBytes = 0;
        this._clockOffset = null;
        this._lastSelfSecond = -Infinity;
        this._lastPackSecond = -Infinity;
        this._inGroupAcc = new Map();
        this._inGroupBucket = null;
        this._lastPowerUp = undefined;
        this._lastRoad = null;         // "courseId/roadId/reverse" of the last road event
        this._selfRowInterval = 1;
        this._packInterval = this.packRowInterval;
        this._packRowsBeforeClock = 0;
        this._afterLine = null;        // set while an automatic recording runs on past the line
        this._lastRemaining = new Map();
        this._recentCrossings = new Map();
        this._lastMine = null;         // {t, ahead: [[athleteId, gap]]} on the last groups payload
        this._scheduledStarts = new Map();   // eventSubgroupId -> scheduled start, server epoch ms
        this._serverOffsetMs = null;   // Sauce's server clock minus this computer's, last measured
        // The subgroup on the last payload, the game's raw id first: {id, serverMs, firstPayload,
        // eventDistance}, where serverMs is when this window saw the rider in it first.
        this._seenSubgroup = null;
        this._startServerMs = null;    // server time of the state a recording started on
        this._startServerOffsetMs = null;
        this._zeroClockUntil = null;   // race second after the last in-event row with state.time 0
        // Changes whenever rows already recorded are rewritten rather than added to, so the crash
        // snapshot, which writes only the rows added since its last save, starts again instead.
        // See THE CRASH SNAPSHOT in store.mjs.
        this.rowsEpoch = 0;
    }

    /*
     * The scheduled start of an event subgroup, in server epoch ms, as Sauce holds it
     * (sg.ts, src/stats.mjs:3728). ui.mjs looks it up, and asks again now and then so a start
     * Zwift moves is picked up; see THE GUN at the top. A recording already counting from the
     * scheduled start keeps the one it started with. One that fell back to Zwift's clock for this
     * subgroup is moved onto the gun clock.
     */
    setScheduledStart(eventSubgroupId, startMs) {
        if (eventSubgroupId == null || !isNum(startMs)) {
            return;
        }
        this._scheduledStarts.set(eventSubgroupId, startMs);
        const rec = this.rec;
        if (this.gunClock && this.state === 'recording' && rec && rec.gunSource === 'zwift-clock' &&
            rec.eventSubgroupId === eventSubgroupId && !this._afterLine && this._clockOffset != null) {
            this._moveOntoGun(startMs);
            this.onChange(this);
        }
    }

    hasScheduledStart(eventSubgroupId) {
        return this._scheduledStarts.has(eventSubgroupId);
    }

    /*
     * Whether a scheduled start for this subgroup could still change anything: with nothing
     * recording, the next automatic recording may count from it; while recording, only an
     * automatic recording of this subgroup still on Zwift's clock before the line can be moved onto
     * it (setScheduledStart). ui.mjs does not ask Sauce otherwise, for instance during the whole of
     * a hand-started recording, which never counts from a scheduled start.
     */
    wantsScheduledStart(eventSubgroupId) {
        if (this.state !== 'recording' || !this.rec) {
            return true;
        }
        return this.gunClock && this.rec.gunSource === 'zwift-clock' &&
            this.rec.eventSubgroupId === eventSubgroupId && !this._afterLine;
    }

    /* True while a recording counts from this subgroup's scheduled start, which then stays put. */
    usesScheduledStart(eventSubgroupId) {
        return this.state === 'recording' && !!this.rec && this.rec.gunSource === 'scheduled-start' &&
            this.rec.eventSubgroupId === eventSubgroupId;
    }

    /*
     * The clock fields of a recording that counts from the scheduled start `gun`, once
     * _clockOffset is on it: the gun and time source, and a join, with their notes.
     */
    _applyGun(gun) {
        const rec = this.rec;
        const offset = this._startServerOffsetMs;
        rec.clock = 'race';
        rec.gunSource = 'scheduled-start';
        rec.scheduledStartISO = new Date(gun).toISOString();
        rec.timeSource = offset != null ? 'sauce-server-clock' : 'computer-clock';
        rec.serverClockOffsetMs = offset;
        rec.startedAtRaceSecond = this._clockOffset;
        const joined = this._joinedAt(gun);
        if (joined != null) {
            rec.joinedAtRaceSecond = joined;
            const lag = rec.startedAtRaceSecond - joined;
            rec.notes.push(lag <= 15 ?
                `You joined this event ${joined} seconds after the gun, so this recording starts ` +
                `there. Race times still count from the gun.` :
                `You joined this event ${joined} seconds after the gun, but this recording only ` +
                `starts ${lag} seconds after that, when Sauce first showed you in the event. Race ` +
                `times still count from the gun.`);
        }
        if (offset == null) {
            rec.notes.push('Sauce\'s server clock was not in the data, so the gun was placed ' +
                           'with this computer\'s clock, which can be a few seconds out.');
        }
    }

    /* The race second the rider joined this recording's subgroup, if it was after the gun. */
    _joinedAt(gun) {
        const seen = this._seenSubgroup;
        if (!seen || seen.id !== this.rec.eventSubgroupId) {
            return null;
        }
        if (seen.firstPayload) {
            // Nothing arrived before it. See "join" under THE GUN at the top.
            const since = this.listeningSince;
            if (since == null || since + (this._serverOffsetMs ?? 0) >= gun ||
                !isNum(seen.eventDistance) || seen.eventDistance > JOIN_MAX_EVENT_DISTANCE_M) {
                return null;
            }
        }
        const joined = Math.floor((seen.serverMs - gun) / 1000);
        return joined > 0 ? joined : null;
    }

    /*
     * A recording that started on Zwift's clock learns the scheduled start: shift every race
     * second it holds onto the gun clock. Rows are the whole seconds since the recording started
     * plus _clockOffset, so the shift is exact. See "late" under THE GUN at the top.
     */
    _moveOntoGun(gun) {
        const rec = this.rec;
        const offset = Math.floor((this._startServerMs - gun) / 1000);
        const d = offset - this._clockOffset;
        this.rowsEpoch++;
        const shift = arr => {
            for (let i = 0; i < arr.length; i++) {
                arr[i] += d;
            }
        };
        shift(rec.timeline.t);
        for (const x of [...rec.timeline.powerUpEvents, ...rec.timeline.roadEvents]) {
            x[0] += d;
        }
        shift(rec.pack.t);
        shift(rec.moves.t);
        for (const r of this._roster.byId.values()) {
            r.firstT += d;
            r.lastT += d;
            for (const span of r.withMe) {
                shift(span);
            }
            if (r.pending) {
                r.pending.since += d;
                r.pending.lastT += d;
                for (const s of r.pending.seen.values()) {
                    s[1] += d;
                    s[2] += d;
                }
            }
        }
        for (const m of [this._lastRemaining, this._recentCrossings]) {
            for (const x of m.values()) {
                x.t += d;
            }
        }
        if (this._lastMine) {
            this._lastMine.t += d;
        }
        this._lastSelfSecond += d;
        this._lastPackSecond += d;
        this._clockOffset = offset;
        rec.notes = rec.notes.filter(x => x !== ZWIFT_CLOCK_FALLBACK_NOTE);
        this._applyGun(gun);
        const tl = rec.timeline;
        const i = tl.stateTime.findIndex(x => isNum(x) && x > 0);
        if (i !== -1) {
            rec.zwiftClockStartedAtRaceSecond = zwiftClockStart(tl.t[i], tl.stateTime[i],
                i > 0 ? tl.t[i - 1] + 1 : null, rec.joinedAtRaceSecond);
        }
    }

    // ---------------------------------------------------------------- lifecycle

    _startRecording(startedAt, trigger, selfData, startServerMs = null) {
        this.rec = {
            schema: SCHEMA_VERSION,
            id: `rec-${startedAt}`,
            modVersion: MOD_VERSION,
            trigger,                            // 'auto' | 'manual'
            startedAt,
            startedISO: new Date(startedAt).toISOString(),
            endedAt: null,
            endedISO: null,
            stopReason: null,
            incomplete: false,
            incompleteReasons: [],
            clock: 'wall',                      // 'race' once the gun has anchored it
            startedAtRaceSecond: null,          // how far into the race this window started
            // THE GUN at the top. gunSource says what race second 0 is: 'scheduled-start', or
            // 'zwift-clock' when Sauce had no scheduled start and state.time was used instead.
            gunSource: null,
            scheduledStartISO: null,
            timeSource: null,                   // 'sauce-server-clock' | 'computer-clock'
            serverClockOffsetMs: null,          // Sauce's server clock minus this computer's
            serverClockOffsetMsLast: null,      // the same, on the last packet before the line
            zwiftClockStartedAtRaceSecond: null, // race second on which state.time first read 1
            joinedAtRaceSecond: null,           // set only when the rider joined after the gun
            // Sauce's createdServerTime on the last payload before the line: the server time its
            // stream times count from (src/stats.mjs:3389, :4334). See THE GUN.
            createdServerTime: null,
            coverage: null,                    // filled at finalize
            watchingSelfThroughout: true,
            resetDetected: false,
            eventSubgroupId: selfData ? selfData.eventSubgroupId ?? null : null,
            eventSliceId: null,
            finishPosition: null,
            finishParticipants: null,
            // The intervals as they are at the end, and each step as [first row, seconds between
            // rows from that row on], so a row can be counted at the interval it was recorded at
            // (computeCoverage).
            degraded: {selfRowInterval: 1, packRowInterval: this.packRowInterval,
                       selfRowIntervals: [[0, 1]], packRowIntervals: [[0, this.packRowInterval]]},
            counts: {selfRows: 0, packRows: 0, riders: 0, anonymousRiders: 0},
            timeline: emptyTimeline(),
            pack: emptyPack(),
            moves: emptyMoves(),                 // WHO WAS IN THE OTHER GROUPS at the top
            inGroup: emptyInGroup(),             // WHO DID WHAT IN YOUR GROUP, above emptyMoves
            roadGroups: emptyRoadGroups(),       // THE GROUPS ON THE ROAD, above emptyInGroup
            riders: null,                        // filled at finalize from the roster
            event: null,                         // attached by ui.mjs
            self: null,                          // attached by ui.mjs (own profile only)
            sauce: null,                         // attached by ui.mjs
            stats: null,                         // attached by ui.mjs (Sauce's event slice stats)
            streams: null,                       // attached by ui.mjs (Sauce's per-second arrays)
            results: null,                       // only if the user asks for them
            afterLine: null,                     // filled at finalize, only if it ran past the line
            notes: [],
        };
        this._roster = new Roster();
        this.rowsEpoch++;
        this._approxBytes = 0;
        this._clockOffset = null;
        this._startServerMs = startServerMs ?? this._serverNow(startedAt);
        this._startServerOffsetMs = this._serverOffsetMs;
        this._zeroClockUntil = null;
        this._lastSelfSecond = -Infinity;
        this._lastPackSecond = -Infinity;
        this._inGroupAcc = new Map();
        this._inGroupBucket = null;
        this._lastPowerUp = undefined;
        this._lastRoad = null;
        this._selfRowInterval = 1;
        this._packInterval = this.packRowInterval;
        this._packRowsBeforeClock = 0;
        this._afterLine = null;
        this._lastRemaining = new Map();
        this._recentCrossings = new Map();
        this._lastMine = null;
        this.state = 'recording';
        this.onChange(this);
    }

    startManual() {
        if (this.state === 'recording') {
            return false;
        }
        this._startRecording(this.now(), 'manual', null);
        this.rec.notes.push('Started by hand, so anything before the button was pressed is not in ' +
                            'this recording. A recording started by hand keeps running until you ' +
                            'press Stop: it is not stopped by an event finishing.');
        return true;
    }

    stopManual() {
        if (this.state !== 'recording') {
            return false;
        }
        if (this._afterLine) {
            // The race already ended at the line; Stop only cuts the extra time short.
            this._finalize('finish', 'stop');
            return true;
        }
        this._finalize('manual');
        return true;
    }

    /* The scheduled start for the subgroup on this payload, or undefined. See THE GUN. */
    _gunFor(data) {
        return this.gunClock && data.eventSubgroupId != null ?
            this._scheduledStarts.get(data.eventSubgroupId) : undefined;
    }

    /* Now on Sauce's server clock, or on this computer's when no offset was ever measured. */
    _serverNow(now) {
        return now + (this._serverOffsetMs ?? 0);
    }

    /* True while an automatic recording is running on past the rider's own finish. */
    isAfterLine() {
        return this.state === 'recording' && !!this._afterLine;
    }

    /* Seconds of the extra time still to run, for the status line, or null. */
    afterLineSecondsLeft() {
        if (!this.isAfterLine()) {
            return null;
        }
        const gone = Math.floor((this.now() - this._afterLine.finishedAt) / 1000);
        return Math.max(0, this._afterLineLimit() - gone);
    }

    _afterLineLimit() {
        const n = Number(this.afterLineSeconds);
        return isFinite(n) && n > 0 ? Math.min(Math.round(n), MAX_AFTER_LINE_SECONDS) : 0;
    }

    /*
     * The rider's own finish was just detected on `data`. Either finalize, exactly as before the
     * setting existed, or keep going and watch the riders behind come in. The packet that tripped
     * the finish is not a second of racing; when the recording goes on, it becomes the first row
     * after the line.
     */
    _reachLine(data, now) {
        const rec = this.rec;
        const F = this._clockOffset == null ? null : Math.floor((now - rec.startedAt) / 1000) + this._clockOffset;
        if (F != null) {
            for (const move of this._roster.flushAtLine(F)) {
                this._logMove(move);
            }
        }
        if (!this._afterLineLimit() || this._clockOffset == null) {
            this._finalize('finish');
            return true;
        }
        this._flushGroupRiders();
        const al = this._afterLine = {
            finishedAt: now,
            finishRaceSecond: F,
            finishMetric: data.remainingType === 'event' ? (data.remainingMetric ?? null) : null,
            // What the race holds: every row written before this packet, and nothing after it.
            rowsAtLine: {
                self: rec.timeline.t.length,
                pack: rec.pack.t.length,
                powerUps: rec.timeline.powerUpEvents.length,
                roads: rec.timeline.roadEvents.length,
                moves: rec.moves.t.length,
            },
            race: null,
            requestedSeconds: this._afterLineLimit(),
            watchingSelf: true,
            remainingSeen: false,
            seenBehind: new Set(),
            firstGap: new Map(),
            arrived: new Map(),
            // The riders of the rider's own group who were ahead of the rider on Sauce's last
            // payload before the line, with Sauce's gap then: they crossed before the rider, which
            // is how YOUR FINISH can say where in the group the rider crossed. Once, at the line.
            aheadInGroup: this._lastMine && F - this._lastMine.t <= LINE_SIGHTING_SECONDS ?
                this._lastMine.ahead : [],
            stillOnRoad: 0,
            notes: [],
        };
        al.race = this._raceAtLine(now);
        if (al.finishMetric !== 'time') {
            // Riders behind whose crossing reached this window just before the rider's own did.
            for (const [id, x] of this._recentCrossings) {
                if (F - x.t <= LINE_ORDER_SECONDS) {
                    this._roster.seeAfterLine(id, F);
                    al.seenBehind.add(id);
                    al.firstGap.set(id, [F, x.gap]);
                    al.arrived.set(id, {t: F, gap: x.gap});
                }
            }
        }
        this._recentCrossings = new Map();
        this.onChange(this);
        this.onLine(al.race, this._roster);
        return false;
    }

    /*
     * The race as a recording with no extra time would have finalized it on the finish packet:
     * the same rows, riders, counts, notes, length, coverage and completeness. Built once, at the
     * line, and never touched again.
     */
    _raceAtLine(now) {
        const rec = this.rec;
        const roster = this._roster;
        const split = splitAtLine(rec, this._afterLine.rowsAtLine);
        const race = {
            ...rec,
            degraded: {...rec.degraded},
            counts: {...rec.counts},
            timeline: split.timeline,
            pack: split.pack,
            moves: split.moves,
            // Nothing is added after the line, so the race keeps all of it, like the log.
            inGroup: JSON.parse(JSON.stringify(rec.inGroup || emptyInGroup())),
            roadGroups: JSON.parse(JSON.stringify(rec.roadGroups || emptyRoadGroups())),
            notes: [...rec.notes],
        };
        race.endedAt = now;
        race.endedISO = new Date(now).toISOString();
        race.stopReason = 'finish';
        race.counts.selfRows = race.timeline.t.length;
        race.counts.packRows = race.pack.t.length;
        race.riders = JSON.parse(JSON.stringify(roster.toJSON()));
        race.counts.riders = Object.keys(race.riders).length;
        race.counts.anonymousRiders = roster.anonymousCount();
        race.elapsedSeconds = Math.round((now - rec.startedAt) / 1000);
        race.coverage = computeCoverage(race);
        applyIncompleteness(race);
        return race;
    }

    /* The extra time has run its course, measured on the race clock like every row. */
    _afterLineIsOver(t) {
        return !!this._afterLine && t - this._afterLine.finishRaceSecond >= this._afterLineLimit();
    }

    /* Lets ui.mjs put an explanation it learned from Sauce into the recording itself. */
    addNote(text) {
        // After the line a note belongs to the extra time: the race was frozen at the line.
        const notes = this._afterLine ? this._afterLine.notes : this.rec && this.rec.notes;
        if (notes && text && !notes.includes(text)) {
            notes.push(text);
        }
    }

    /*
     * Names arrive from ui.mjs's slow, local, no-network lookup. See the Roster comment. After the
     * line only riders first seen after it can still be named: a race rider named then would be
     * keyed and labelled differently from the same race recorded with no extra time.
     */
    setRiderName(athleteId, name, team = null) {
        if (!this._roster) {
            return;
        }
        if (this._afterLine) {
            const r = this._roster.byId.get(athleteId);
            if (!r || !r.afterLineOnly) {
                return;
            }
        }
        this._roster.setName(athleteId, name, team);
    }

    unnamedRiderIds() {
        return this._roster ? this._roster.unnamedIds({afterLineOnly: !!this._afterLine}) : [];
    }

    /*
     * afterLineEndedBy says what ended the extra time after the line, when there was any:
     * 'time', 'stop', 'left-event', 'changed-event' or 'lost-feed'. The stop reason is still
     * 'finish' in every one of those cases, because the race itself ended at the line.
     */
    _finalize(stopReason, afterLineEndedBy = null) {
        if (this.state !== 'recording') {
            return null;
        }
        if (!this._afterLine) {
            this._flushGroupRiders();
        }
        const roster = this._roster;
        const al = this._afterLine;
        let rec;
        if (al) {
            // The race was frozen at the line (see _raceAtLine). Only the extra time is added, and
            // the race's own length, coverage and completeness stay as they were there.
            const endedAt = this.now();
            rec = {
                ...al.race,
                endedAt,
                endedISO: new Date(endedAt).toISOString(),
                afterLine: this._afterLineJSON(afterLineEndedBy),
            };
        } else {
            rec = this.rec;
            rec.endedAt = this.now();
            rec.endedISO = new Date(rec.endedAt).toISOString();
            rec.stopReason = stopReason;
            rec.riders = roster.toJSON();
            rec.counts.riders = Object.keys(rec.riders).length;
            rec.counts.anonymousRiders = roster.anonymousCount();
            rec.elapsedSeconds = Math.round((rec.endedAt - rec.startedAt) / 1000);
            rec.coverage = computeCoverage(rec);
            applyIncompleteness(rec);
        }
        this.state = 'idle';
        this.rec = null;
        this._sliceId = null;
        this._subgroupId = null;
        this._afterLine = null;
        this._lastRemaining = new Map();
        this._recentCrossings = new Map();
        this.onChange(this);
        this.onFinalized(rec, roster);
        return rec;
    }

    // ------------------------------------------------------------------- feeds

    /*
     * athlete/self/v2 payload. Requested with {resources: ['state']}, which is all the start,
     * finish, position and W'bal fields need: they live in the base payload.
     *
     * Returns 'bad' for a payload that is not an athlete payload at all, so the caller can count
     * them and switch to the polling fallback. See the note at the top of ui.mjs.
     */
    onSelf(data) {
        if (!isSelfPayload(data)) {
            this.badSelfPayloads++;
            this.consecutiveBadSelfPayloads++;
            return 'bad';
        }
        this.goodSelfPayloads++;
        this.consecutiveBadSelfPayloads = 0;
        const now = this.now();
        this.lastSelfAt = now;
        this.lastSelfPayloadAge = data.age ?? null;
        this.lastSubgroupId = data.eventSubgroupId ?? null;

        const slice = activeEventSlice(data);
        const inEvent = data.eventSubgroupId != null;
        const st = data.state || null;
        // Sauce's own start: state.time non-zero inside an event subgroup (src/stats.mjs:3050).
        const gunFired = inEvent && !!(st && st.time);
        const pastEnd = isPastEventEnd(data);
        const serverOffset = serverClockOffset(data);
        if (serverOffset != null) {
            this._serverOffsetMs = serverOffset;
        }
        // This state's own time on Sauce's server clock (see THE GUN), or the moment it arrived
        // when the payload does not carry it.
        const stateServerMs = serverOffset != null ? st.worldTime + ZWIFT_EPOCH_MS : this._serverNow(now);
        // When the rider entered the subgroup, for "joined N seconds after the gun". The game's
        // raw id counts here, and comes first (see THE GUN).
        const rawId = (st && st.eventSubgroupId) || null;
        const seenId = rawId ?? data.eventSubgroupId ?? null;
        if (seenId !== (this._seenSubgroup ? this._seenSubgroup.id : null)) {
            this._seenSubgroup = seenId == null ? null : {
                id: seenId,
                serverMs: stateServerMs,
                firstPayload: this.goodSelfPayloads === 1,
                eventDistance: st ? st.eventDistance : undefined,
            };
        }
        // A game subgroup that is not Sauce's is a subgroup Sauce has not loaded yet, and Sauce's
        // own id is then the previous event's ("stale" under THE GUN).
        const idsAgree = !rawId || rawId === data.eventSubgroupId;
        const gun = idsAgree ? this._gunFor(data) : undefined;
        // The gun: the scheduled start has passed, on Sauce's server clock.
        const gunPassed = gun != null && stateServerMs > gun;

        if (this.state !== 'recording') {
            if (!this.autoRecord) {
                return 'ok';
            }
            // In the pen after the gun Sauce may still have no slice open, because state.time can
            // stay zero (see THE GUN), so that case starts too.
            const penAfterGun = gunPassed && !(st && st.time);
            // With the gun clock on, Zwift's clock only starts a recording while the game agrees
            // with Sauce on the subgroup, and never before a scheduled start that is known.
            const zwiftStart = gunFired && (!this.gunClock || (idsAgree && (gun == null || gunPassed)));
            if (!(slice || (slice !== null && (zwiftStart || gunPassed)) || penAfterGun)) {
                return 'ok';
            }
            if (pastEnd && !slice) {
                // The event is already over. Nothing to record.
                return 'ok';
            }
            this._startRecording(now, 'auto', data, stateServerMs);
            this._subgroupId = data.eventSubgroupId;
            this._adCreated = data.created ?? null;
            if (slice) {
                this._sliceId = slice.id ?? null;
                this.rec.eventSliceId = slice.id ?? null;
            }
            if (hasUnknownEventEnd(data)) {
                this.rec.notes.push('Sauce had no end distance and no end time for this event, so ' +
                                    'the recording will run until you leave the event rather than ' +
                                    'stopping itself at the finish line.');
            }
        } else {
            // Already recording. Decide whether this is still the same race.
            //
            // A recording the rider started by hand is never stopped by an event: it runs until
            // Stop is pressed or the feed dies. Only recordings that started themselves at a gun
            // stop themselves at a line.
            const auto = this.rec.trigger === 'auto';
            if (auto && !inEvent && this._subgroupId != null) {
                // After the line this only ends the extra time: the race still ended at the line.
                if (this._afterLine) {
                    this._finalize('finish', 'left-event');
                } else {
                    this._finalize('left-event');
                }
                return 'ok';
            }
            if (inEvent && this.rec.eventSubgroupId == null) {
                // Started by hand, and the rider is now in an event. Remember which one so the
                // report can name it, but leave the stopping to the rider.
                this.rec.eventSubgroupId = data.eventSubgroupId;
            }
            if (auto) {
                if (this._subgroupId != null && data.eventSubgroupId !== this._subgroupId) {
                    if (this._afterLine) {
                        this._finalize('finish', 'changed-event');
                    } else {
                        this._finalize('changed-event');
                    }
                    return 'ok';
                }
                if (this._afterLine) {
                    // Already past the line. Every later packet is past it too, so the finish
                    // tests below would only fire again. Time, Stop or leaving ends this.
                } else if (slice === null && this._sliceId != null) {
                    // The slice we were following closed: Sauce says the race finished.
                    if (this._reachLine(data, now)) {
                        return 'ok';
                    }
                } else if (slice && this._sliceId != null && slice.id !== this._sliceId) {
                    if (this._reachLine(data, now)) {
                        return 'ok';
                    }
                } else {
                    if (slice && this._sliceId == null) {
                        this._sliceId = slice.id ?? null;
                        this.rec.eventSliceId = slice.id ?? null;
                    }
                    if (pastEnd) {
                        // Sauce's own close test, re-run on the payload (see the note at the
                        // top). This packet is already past the line, so it is not recorded as a
                        // second of racing, but the position on it is the last thing Zwift said
                        // as the line went by.
                        this.rec.finishPosition = r0(data.eventPosition);
                        this.rec.finishParticipants = r0(data.eventParticipants);
                        if (this._reachLine(data, now)) {
                            return 'ok';
                        }
                    }
                }
            }
            if (!this._afterLine && this._adCreated != null && data.created != null &&
                data.created !== this._adCreated) {
                // Sauce's autoResetEvents setting wipes athlete data at the gun
                // (src/stats.mjs:2968-2971). Our own rows survive it; Sauce's streams do not.
                this.rec.resetDetected = true;
                this._adCreated = data.created;
            }
        }

        const rec = this.rec;
        if (!rec) {
            return 'ok';
        }
        if (data.watching !== true) {
            // Self is not the athlete Sauce is "watching", so nearby and groups are computed
            // around somebody else (_computeNearby starts from this.watchingId,
            // src/stats.mjs:4427). After the line that is a caveat on the extra time only.
            if (this._afterLine) {
                this._afterLine.watchingSelf = false;
            } else {
                rec.watchingSelfThroughout = false;
            }
        }
        if (!st) {
            return 'ok';
        }
        const wall = Math.floor((now - rec.startedAt) / 1000);
        if (this._clockOffset == null) {
            // Anchor every time in this recording to the race clock, once.
            if (inEvent && gun != null && (gunPassed || (isNum(st.time) && st.time > 0))) {
                // The scheduled start, on Sauce's server clock (see THE GUN at the top). Taken
                // from the state the recording started on, so every row after it is that plus
                // the whole seconds since, exactly as on the state.time clock below.
                this._clockOffset = Math.floor((this._startServerMs - gun) / 1000);
                this._applyGun(gun);
            } else if (inEvent && isNum(st.time) && st.time > 0) {
                // state.time is the rider's elapsed seconds in the event and is what Sauce itself
                // uses to start its event slice, so it is zero in the pen and counts after it.
                // Outside an event it is the whole session's elapsed time and means nothing to a
                // race, so a recording started by hand outside an event stays on the wall clock.
                this._clockOffset = st.time - wall;
                rec.clock = 'race';
                rec.gunSource = 'zwift-clock';
                rec.startedAtRaceSecond = this._clockOffset;
                if (this.gunClock) {
                    // Taken out again if the scheduled start arrives (_moveOntoGun).
                    rec.notes.push(ZWIFT_CLOCK_FALLBACK_NOTE);
                }
            } else {
                this._clockOffset = 0;
                rec.clock = 'wall';
                rec.startedAtRaceSecond = null;
            }
        }
        const t = wall + this._clockOffset;
        if (!this._afterLine && isNum(data.createdServerTime)) {
            rec.createdServerTime = data.createdServerTime;
        }
        if (!this._afterLine && rec.gunSource === 'scheduled-start') {
            rec.serverClockOffsetMsLast = this._serverOffsetMs;
            if (rec.zwiftClockStartedAtRaceSecond == null && inEvent && isNum(st.time)) {
                if (st.time > 0) {
                    // The race second on which Zwift's clock read 1, which is usually when Sauce's
                    // own event slice, and so its stats, begins (src/stats.mjs:3050-3058).
                    rec.zwiftClockStartedAtRaceSecond = zwiftClockStart(t, st.time,
                        this._zeroClockUntil, rec.joinedAtRaceSecond);
                } else {
                    this._zeroClockUntil = t + 1;
                }
            }
        }
        if (this._afterLineIsOver(t)) {
            this._finalize('finish', 'time');
            return 'ok';
        }
        if (t - this._lastSelfSecond < this._selfRowInterval) {
            return 'ok';
        }
        this._lastSelfSecond = t;
        const tl = rec.timeline;
        tl.t.push(t);
        tl.stateTime.push(r0(st.time));
        tl.power.push(r0(st.power));
        tl.hr.push(r0(st.heartrate));
        tl.cadence.push(r0(st.cadence));
        tl.speed.push(r1(st.speed));
        tl.draft.push(r0(st.draft));
        tl.distance.push(r0(st.distance));
        tl.eventDistance.push(r0(st.eventDistance));
        tl.grade.push(r3(st.grade));
        tl.wbal.push(r0(data.wBal));
        tl.eventPosition.push(r0(data.eventPosition));
        tl.eventParticipants.push(r0(data.eventParticipants));
        tl.roadTime.push(r0(st.roadTime));
        rec.counts.selfRows = tl.t.length;
        this._approxBytes += 13 * BYTES_PER_NUMBER;

        const pu = st.activePowerUp ?? null;
        if (pu !== this._lastPowerUp) {
            tl.powerUpEvents.push([t, pu]);
            this._lastPowerUp = pu;
        }
        if (isNum(st.roadId)) {
            // A change of road only, like the powerups. state.reverse is decoded from the flags
            // Zwift sends (src/zwift.mjs:240-253, :268-270).
            const road = [r0(st.courseId ?? data.courseId), st.roadId, st.reverse ? 1 : 0];
            const key = road.join('/');
            if (key !== this._lastRoad) {
                tl.roadEvents.push([t, ...road]);
                this._lastRoad = key;
                this._approxBytes += 4 * BYTES_PER_NUMBER;
            }
        }
        if (!this._afterLine) {
            // Never after the line: thinning the rows then would change the race's own record.
            this._applySizeGuard();
        }
        this.onChange(this);
        return 'ok';
    }

    /*
     * groups/v2 payload: an array of groups, front of the road first.
     *
     * Requested with NO resources, so no rider profile crosses into this window at 1 Hz. Every
     * field used here is in the base payload: a group's own aggregates are computed by Sauce
     * whatever the query (src/stats.mjs:4600-4613), and each rider inside carries athleteId, gap
     * and gapDistance unconditionally (src/stats.mjs:4332-4353). Names are looked up later, in
     * one slow local call, by ui.mjs.
     *
     * An EMPTY array is recorded as a row of its own rather than skipped, because "Sauce had
     * nobody in view" and "the feed stopped" have to be tellable apart in the report.
     */
    onGroups(groups) {
        const now = this.now();
        this.lastGroupsAt = now;
        if (this.state !== 'recording' || !Array.isArray(groups)) {
            return;
        }
        const rec = this.rec;
        if (this._clockOffset == null) {
            // No self payload yet, so the race clock is not anchored and this row could not be
            // lined up with anything. At 1 Hz this is at most a second or two at the very start.
            this._packRowsBeforeClock++;
            return;
        }
        const t = Math.floor((now - rec.startedAt) / 1000) + this._clockOffset;
        if (this._afterLineIsOver(t)) {
            this._finalize('finish', 'time');
            return;
        }
        if (rec.trigger === 'auto' && (this._afterLine || this._afterLineLimit())) {
            // Every second, not every pack row: a rider's gap as they reach the line is only as
            // good as the payload that catches them doing it.
            this._watchTheLine(groups, t);
        }
        if (!this._afterLine) {
            // Every payload, not every pack row, or a flicker that came back on alternate seconds
            // would be seen on every pack row and read as a change that held.
            this._watchPlaces(groups, t);
            this._watchGroupRiders(groups, t);
            // Who in the rider's own group was ahead of the rider on this payload, kept in memory
            // only until the next one (see aheadInGroup in _reachLine).
            const mine = groups.find(x => x.watching === true);
            this._lastMine = mine ? {t, ahead: (mine.athletes || [])
                .filter(a => a && a.athleteId != null && a.self !== true && isNum(a.gap) && a.gap < 0)
                .map(a => [a.athleteId, r1(a.gap)])} : null;
        }
        if (t - this._lastPackSecond < this._packInterval) {
            return;
        }
        this._lastPackSecond = t;
        const p = rec.pack;

        if (!groups.length) {
            p.t.push(t);
            p.myGroupSize.push(null);
            p.ridersAheadOtherGroups.push(null);
            p.ridersBehindOtherGroups.push(null);
            p.gapAheadGroup.push(null);
            p.sizeAheadGroup.push(null);
            p.gapBehindGroup.push(null);
            p.sizeBehindGroup.push(null);
            p.groupPower.push(null);
            p.groupDraft.push(null);
            p.groupHr.push(null);
            p.groupSpeed.push(null);
            p.groupsVisible.push(0);
            p.ridersVisible.push(0);
            rec.counts.packRows = p.t.length;
            this.onChange(this);
            return;
        }

        const myIdx = groups.findIndex(x => x.watching === true);
        const mine = myIdx === -1 ? null : groups[myIdx];
        const ahead = myIdx > 0 ? groups[myIdx - 1] : null;
        const behind = (myIdx !== -1 && myIdx + 1 < groups.length) ? groups[myIdx + 1] : null;

        /*
         * Riders ahead means riders in a group AHEAD of the rider's own, not every rider with a
         * negative gap. Inside one bunch the gaps are fractions of a second and half of them are
         * negative, so counting by sign would report "22 riders ahead of you on the road" one
         * minute into a 40 rider bunch. Sauce also warns that gap signs flip for lapped riders in
         * a circuit race (src/stats.mjs:3978-3980), which is a second reason not to count by sign.
         */
        let ridersAhead = 0;
        let ridersBehind = 0;
        let ridersVisible = 0;
        for (let gi = 0; gi < groups.length; gi++) {
            const grp = groups[gi];
            const athletes = grp.athletes || [];
            for (let ai = 0; ai < athletes.length; ai++) {
                const a = athletes[ai];
                if (a == null || a.athleteId == null) {
                    continue;
                }
                ridersVisible++;
                if (a.self === true) {
                    continue;
                }
                if (myIdx !== -1 && gi < myIdx) {
                    ridersAhead++;
                } else if (myIdx !== -1 && gi > myIdx) {
                    ridersBehind++;
                }
                if (this._afterLine) {
                    // Nobody is added to the race after the line. _watchTheLine keeps the riders
                    // who came in, and nobody else in view.
                    continue;
                }
                const known = this._roster.byId.get(a.athleteId);
                const spans = known ? known.withMe.length : 0;
                const seen = this._roster.see(a.athleteId, t);
                if (gi === myIdx) {
                    this._roster.markWithMe(a.athleteId, t, this._packInterval + 1);
                }
                // The riders are saved too, so the size guard counts them: a big field adds
                // hundreds of entries that no row count shows.
                this._approxBytes += (known ? 0 : BYTES_PER_RIDER) +
                    (seen.withMe.length - spans) * BYTES_PER_SPAN;
            }
        }

        p.t.push(t);
        p.myGroupSize.push(mine ? (mine.athletes ? mine.athletes.length : null) : null);
        p.ridersAheadOtherGroups.push(myIdx === -1 ? null : ridersAhead);
        p.ridersBehindOtherGroups.push(myIdx === -1 ? null : ridersBehind);
        p.gapAheadGroup.push(ahead ? r1(ahead.gap) : null);
        p.sizeAheadGroup.push(ahead && ahead.athletes ? ahead.athletes.length : null);
        p.gapBehindGroup.push(behind ? r1(behind.gap) : null);
        p.sizeBehindGroup.push(behind && behind.athletes ? behind.athletes.length : null);
        p.groupPower.push(mine ? r0(mine.power) : null);
        p.groupDraft.push(mine ? r0(mine.draft) : null);
        p.groupHr.push(mine ? r0(mine.heartrate) : null);
        p.groupSpeed.push(mine ? r1(mine.speed) : null);
        p.groupsVisible.push(groups.length);
        p.ridersVisible.push(ridersVisible);
        if (this.keepInGroup && myIdx !== -1 && !this._afterLine) {
            const rg = rec.roadGroups || (rec.roadGroups = emptyRoadGroups());
            for (let gi = Math.max(0, myIdx - ROAD_GROUPS_EACH_SIDE);
                 gi <= Math.min(groups.length - 1, myIdx + ROAD_GROUPS_EACH_SIDE); gi++) {
                const grp = groups[gi];
                rg.t.push(t);
                rg.rel.push(gi - myIdx);
                rg.id.push(grp.id ?? null);
                rg.size.push(grp.athletes ? grp.athletes.length : null);
                rg.gap.push(r1(grp.gap));
                rg.power.push(r0(grp.power));
                rg.speed.push(r1(grp.speed));
                this._approxBytes += 7 * BYTES_PER_NUMBER;
            }
        }
        rec.counts.packRows = p.t.length;
        this._approxBytes += 13 * BYTES_PER_NUMBER;
        if (!this._afterLine) {
            rec.counts.riders = this._roster.byId.size;
            this._applySizeGuard();
        }
        this.onChange(this);
    }

    /*
     * One payload's evidence for the membership log (WHO WAS IN THE OTHER GROUPS at the top): where
     * each rider the roster knows was against the rider's group. A payload that could not place the
     * rider says nothing about anyone else; an empty one says everybody is out of view. A rider not
     * in the roster yet is placed from the next payload after the pack row that adds them.
     */
    _watchPlaces(groups, t) {
        const myIdx = groups.findIndex(x => x.watching === true);
        if (groups.length && myIdx === -1) {
            return;
        }
        const inView = new Set();
        for (let gi = 0; gi < groups.length; gi++) {
            const d = gi - myIdx;
            const place = d === 0 ? 0 : d < 0 ? Math.max(-2, d) : Math.min(2, d);
            for (const a of (groups[gi].athletes || [])) {
                if (a == null || a.athleteId == null || a.self === true || !this._roster.byId.has(a.athleteId)) {
                    continue;
                }
                inView.add(a.athleteId);
                this._logMove(this._roster.observePlace(a.athleteId, place, t, MOVE_HOLD_SECONDS));
            }
        }
        for (const [id, r] of this._roster.byId) {
            if (!inView.has(id) && !r.afterLineOnly && (r.place != null || r.pending)) {
                this._logMove(this._roster.observePlace(id, null, t, MOVE_HOLD_SECONDS));
            }
        }
    }

    /* One payload's power and draft for each rider in the rider's own group (WHO DID WHAT IN YOUR GROUP). */
    _watchGroupRiders(groups, t) {
        if (!this.keepInGroup) {
            return;
        }
        const b = Math.floor(t / IN_GROUP_SECONDS) * IN_GROUP_SECONDS;
        if (this._inGroupBucket !== b) {
            this._flushGroupRiders();
            this._inGroupBucket = b;
        }
        const mine = groups.find(x => x.watching === true);
        for (const a of (mine && mine.athletes) || []) {
            const st = a && a.state;
            if (!st || !isNum(st.power)) {
                continue;
            }
            const known = a.self === true ? null : this._roster.byId.get(a.athleteId);
            const seq = a.self === true ? SELF_SEQ : known ? known.seq : null;
            if (seq == null) {
                continue;
            }
            const acc = this._inGroupAcc.get(seq) || {p: 0, d: 0, w: 0, n: 0};
            acc.p += st.power;
            acc.d += isNum(st.draft) ? st.draft : 0;
            acc.w += isNum(st.draft) && st.draft < 1 ? 1 : 0;
            acc.n++;
            this._inGroupAcc.set(seq, acc);
        }
    }

    _flushGroupRiders() {
        const acc = this._inGroupAcc;
        if (!acc || !acc.size || this._inGroupBucket == null) {
            this._inGroupAcc = new Map();
            return;
        }
        const g = this.rec.inGroup || (this.rec.inGroup = emptyInGroup());
        for (const [seq, x] of acc) {
            g.t.push(this._inGroupBucket);
            g.rider.push(seq);
            g.power.push(Math.round(x.p / x.n));
            g.draft.push(Math.round(x.d / x.n));
            g.wind.push(x.w);
            g.n.push(x.n);
        }
        this._approxBytes += 6 * BYTES_PER_NUMBER * acc.size;
        this._inGroupAcc = new Map();
    }

    _logMove(move) {
        if (!move) {
            return;
        }
        const m = this.rec.moves;
        m.t.push(move[0]);
        m.rider.push(move[1]);
        m.from.push(move[2]);
        m.to.push(move[3]);
        this._approxBytes += 4 * BYTES_PER_NUMBER;
    }

    /*
     * WHAT THIS DOES: watches for riders behind reaching the line, using Sauce's own finish test
     * on each of them (see AFTER THE LINE at the top).
     *
     * Before the rider's own finish it only remembers each rider's last `remaining` and when it
     * was seen, which is never saved, plus any rider behind who crossed in the last couple of
     * seconds (see LINE_ORDER_SECONDS). A rider "came in" when that number goes from zero or more
     * to below zero, on two sightings no more than LINE_SIGHTING_SECONDS apart, while they are
     * behind the rider (a gap of zero or more) in the same event. A rider first seen already past
     * the line is not counted: nothing says when they got there. Riders ahead, who finished first,
     * carry negative gaps (src/stats.mjs:4459-4462) and are never counted.
     *
     * In an event that ends on the clock nobody is counted in (see AFTER THE LINE at the top).
     * Instead the riders behind in the first LINE_SIGHTING_SECONDS after the line are kept, with
     * their gap then, as who was behind on the road when the clock ran out.
     */
    _watchTheLine(groups, t) {
        const al = this._afterLine;
        const onClock = !!al && al.finishMetric === 'time';
        let onRoad = 0;
        for (const grp of groups) {
            for (const a of (grp.athletes || [])) {
                if (a == null || a.athleteId == null || a.self === true) {
                    continue;
                }
                const id = a.athleteId;
                const hasRemaining = a.remainingType === 'event' && isNum(a.remaining);
                const prev = this._lastRemaining.get(id);
                const crossed = hasRemaining && a.remaining < 0 && !!prev && prev.remaining >= 0 &&
                    t - prev.t <= LINE_SIGHTING_SECONDS;
                if (hasRemaining) {
                    this._lastRemaining.set(id, {remaining: a.remaining, t});
                }
                const behind = a.eventSubgroupId === this._subgroupId && isNum(a.gap) && a.gap >= 0;
                if (!al) {
                    if (crossed && behind) {
                        this._recentCrossings.set(id, {t, gap: r1(a.gap)});
                    }
                    continue;
                }
                if (hasRemaining) {
                    al.remainingSeen = true;
                }
                if (!behind) {
                    continue;
                }
                al.seenBehind.add(id);
                if (!al.firstGap.has(id)) {
                    al.firstGap.set(id, [t, r1(a.gap)]);
                    if (onClock && t - al.finishRaceSecond <= LINE_SIGHTING_SECONDS) {
                        this._roster.seeAfterLine(id, t);
                        al.arrived.set(id, {t, gap: r1(a.gap)});
                    }
                }
                if (onClock || al.arrived.has(id)) {
                    continue;
                }
                if (crossed) {
                    this._roster.seeAfterLine(id, t);
                    al.arrived.set(id, {t, gap: r1(a.gap)});
                } else if (hasRemaining && a.remaining >= 0) {
                    onRoad++;
                }
            }
        }
        if (al) {
            al.stillOnRoad = onRoad;
        }
    }

    /*
     * The saved `afterLine` block. Only numbers and per-race keys; no athlete id for the unnamed,
     * and only the riders who came in (or, on the clock, were behind when it ran out).
     */
    _afterLineJSON(endedBy) {
        const al = this._afterLine;
        const roster = this._roster;
        const labels = roster.labels();
        const F = al.finishRaceSecond;
        const split = splitAtLine(this.rec, al.rowsAtLine);
        const at = split.afterTimeline.t;
        const interval = (this.rec.degraded && this.rec.degraded.selfRowInterval) || 1;
        // A row stands for `interval` seconds, the same way computeCoverage counts them.
        const span = at.length ? at[at.length - 1] - F + interval : 0;
        const arrivals = [];
        for (const [id, x] of al.arrived) {
            const first = al.firstGap.get(id) || [null, null];
            arrivals.push({
                rider: roster.keyFor(id, labels),
                t: x.t,
                gap: x.gap,
                firstSeenT: first[0],
                firstSeenGap: first[1],
            });
        }
        arrivals.sort((a, b) => (a.gap - b.gap) || (a.t - b.t));
        const onClock = al.finishMetric === 'time';
        return {
            finishRaceSecond: F,                 // the race second the rider's finish was seen on
            finishMetric: al.finishMetric,       // 'distance' or 'time', as Sauce tagged it
            requestedSeconds: al.requestedSeconds,
            secondsCaptured: Math.min(span, at.length * interval),
            endedBy,
            watchingSelfThroughout: al.watchingSelf,
            ridersReportedFinish: al.remainingSeen,  // Sauce gave the riders a finish test at all
            ridersSeenBehind: al.seenBehind.size,
            // Distance events: riders who came in. On the clock: riders behind when it ran out.
            arrivals: onClock ? [] : arrivals,
            behindWhenClockRanOut: onClock ? arrivals : [],
            // Riders of the rider's own group ahead of the rider as the rider reached the line.
            aheadInGroup: onClock ? [] : (al.aheadInGroup || [])
                .map(([id, gap]) => ({rider: roster.keyFor(id, labels), gap}))
                .filter(x => x.rider != null),
            stillOnRoad: onClock ? 0 : al.stillOnRoad,  // behind and not yet in, on the last payload
            riders: roster.toJSON({afterLineOnly: true}),
            notes: [...al.notes],
            timeline: split.afterTimeline,
            pack: split.afterPack,
        };
    }

    /*
     * Called on a timer by ui.mjs. Catches a race that ends with the feed simply stopping, for
     * instance because Zwift quit. Recording itself never depends on this: every row is written
     * inside a data callback, because Chromium throttles timers in a hidden window and a mod
     * cannot ask for that to be turned off (webPreferences is not in the manifest schema,
     * src/mods-core.mjs:33-81).
     */
    tick() {
        if (this.state !== 'recording') {
            return;
        }
        const now = this.now();
        if (this._afterLine) {
            // The extra time also ends on the timer, in case the feed goes quiet after the line.
            // It is never what ends it in a hidden window, where the data callbacks do.
            if ((now - this._afterLine.finishedAt) / 1000 >= this._afterLineLimit()) {
                this._finalize('finish', 'time');
            } else if (this.lastSelfAt && (now - this.lastSelfAt) / 1000 > this.lostFeedSeconds) {
                this._finalize('finish', 'lost-feed');
            }
            return;
        }
        if (this.lastSelfAt && (now - this.lastSelfAt) / 1000 > this.lostFeedSeconds) {
            this._finalize('lost-feed');
        }
    }

    _applySizeGuard() {
        const rec = this.rec;
        if (!rec || !this.sizeGuard) {
            return;
        }
        /*
         * A step starts at the last row already written: from that row on, the next row is due
         * after the new interval, so that row stands for that many seconds (computeCoverage).
         */
        const step = (list, rows, seconds) => {
            if (Array.isArray(list)) {
                list.push([Math.max(0, rows - 1), seconds]);
            }
        };
        if (this._packInterval < 5 && this._approxBytes > this.sizeBudgetBytes * 0.6) {
            this._packInterval = 5;
            rec.degraded.packRowInterval = 5;
            step(rec.degraded.packRowIntervals, rec.pack.t.length, 5);
            rec.notes.push('This race ran long enough that the group around you dropped from ' +
                           'every two seconds to every five, to keep the recording small. Your ' +
                           'own numbers kept recording every second.');
        }
        if (this._selfRowInterval === 1 && this._approxBytes > this.sizeBudgetBytes * 0.85) {
            this._selfRowInterval = 5;
            rec.degraded.selfRowInterval = 5;
            step(rec.degraded.selfRowIntervals, rec.timeline.t.length, 5);
            rec.notes.push('This race ran long enough that your own numbers dropped from every ' +
                           'second to every five seconds.');
        }
    }

    // ------------------------------------------------------------------ helpers

    approxBytes() {
        return this._approxBytes;
    }

    /*
     * A copy of the in-progress recording, good enough to finish a report from if Sauce restarts
     * mid race. Sauce's own per-second streams do not survive a restart; these rows do.
     */
    snapshotForCrash() {
        if (this.state !== 'recording') {
            return null;
        }
        if (this._afterLine) {
            // Past the line, so the snapshot is the race frozen at the line, and the extra time
            // so far on its own.
            return {
                ...this._afterLine.race,
                afterLine: this._afterLineJSON('window-closed'),
                inProgress: true,
                snapshotAt: this.now(),
            };
        }
        return {
            ...this.rec,
            riders: this._roster.toJSON(),
            coverage: computeCoverage(this.rec),
            inProgress: true,
            snapshotAt: this.now(),
        };
    }
}


/*
 * WHAT THIS DOES: puts the extra time after the line onto the race that was saved at the line.
 * `race` is what was saved there (with whatever ui.mjs attached since, such as Sauce's stats and
 * streams or official results); `withExtra` is the finished recording, or a crash snapshot, that
 * carries the afterLine block. Nothing about the race itself is taken from `withExtra`.
 */
export function withAfterLine(race, withExtra) {
    return {
        ...race,
        endedAt: withExtra.endedAt,
        endedISO: withExtra.endedISO,
        afterLine: withExtra.afterLine,
    };
}


/*
 * WHAT THIS DOES: cuts a recording's rows at the line. `rowsAtLine` is how many self rows, pack
 * rows and power-up changes existed when the finish packet arrived: those are the race, and every
 * row written after it is the extra time. The cut is by count, not by second, because a groups
 * payload or a second self packet can land in the finish second before the finish packet does.
 * Returns new objects and leaves the recording itself alone, so a snapshot taken mid way does not
 * disturb it.
 */
export function splitAtLine(rec, rowsAtLine) {
    const cut = (series, k, extraKeys = []) => {
        const before = {};
        const after = {};
        for (const [key, arr] of Object.entries(series)) {
            if (extraKeys.includes(key) || !Array.isArray(arr)) {
                continue;
            }
            before[key] = arr.slice(0, k);
            after[key] = arr.slice(k);
        }
        return [before, after];
    };
    const [timeline, afterTimeline] = cut(rec.timeline || emptyTimeline(), rowsAtLine.self,
                                          ['powerUpEvents', 'roadEvents']);
    const events = (rec.timeline && rec.timeline.powerUpEvents) || [];
    timeline.powerUpEvents = events.slice(0, rowsAtLine.powerUps);
    afterTimeline.powerUpEvents = events.slice(rowsAtLine.powerUps);
    const roads = (rec.timeline && rec.timeline.roadEvents) || [];
    timeline.roadEvents = roads.slice(0, rowsAtLine.roads ?? roads.length);
    afterTimeline.roadEvents = roads.slice(rowsAtLine.roads ?? roads.length);
    const [pack, afterPack] = cut(rec.pack || emptyPack(), rowsAtLine.pack);
    // Nothing is added to the log after the line, so the race keeps all of it.
    const [moves] = cut(rec.moves || emptyMoves(), rowsAtLine.moves ?? Infinity);
    return {timeline, pack, moves, afterTimeline, afterPack};
}


/*
 * WHAT THIS DOES: counts the seconds of the race this recording actually holds, against the
 * seconds it covers, so the report can say "40 of these 2400 seconds were recorded" rather than
 * presenting a frozen window's forty rows as a complete race.
 *
 * Each row counts for the interval in force when it was recorded, from degraded.selfRowIntervals,
 * and never for more than the seconds up to the next row; the last row counts for its own second,
 * where the span ends. An earlier version counted every row at the final interval, so a long race
 * that stepped down to every five seconds counted its one-second rows five times over and hid its
 * gaps: Van's 69 minute session of 16 Sep 2026 said "Missing: 0" beside "longest single gap 23 s".
 * A recording saved before the steps were kept has only the final interval, and the cap at the
 * next row still counts its one-second rows as one second each.
 */
export function computeCoverage(rec) {
    const t = (rec.timeline && rec.timeline.t) || [];
    const degraded = rec.degraded || {};
    const interval = degraded.selfRowInterval || 1;
    if (t.length < 2) {
        return {
            startSecond: t.length ? t[0] : null,
            endSecond: t.length ? t[0] : null,
            spanSeconds: t.length,
            rowsRecorded: t.length,
            secondsRecorded: t.length,
            missingSeconds: 0,
            rowInterval: interval,
            gaps: [],
            largestGapSeconds: 0,
        };
    }
    const steps = Array.isArray(degraded.selfRowIntervals) && degraded.selfRowIntervals.length ?
        degraded.selfRowIntervals :
        [[0, interval]];
    let s = 0;
    const intervalAt = i => {
        while (s + 1 < steps.length && i >= steps[s + 1][0]) {
            s++;
        }
        return steps[s][1] || 1;
    };
    const start = t[0];
    const end = t[t.length - 1];
    const span = end - start + 1;
    const gaps = [];
    let largest = 0;
    let seconds = 1;
    for (let i = 1; i < t.length; i++) {
        const d = t[i] - t[i - 1];
        const every = intervalAt(i - 1);
        seconds += Math.min(every, d);
        if (d > Math.max(3, every * 3)) {
            largest = Math.max(largest, d);
            if (gaps.length < 25) {
                gaps.push([t[i - 1], t[i]]);
            }
        }
    }
    const secondsRecorded = Math.min(span, seconds);
    return {
        startSecond: start,
        endSecond: end,
        spanSeconds: span,
        rowsRecorded: t.length,
        secondsRecorded,
        missingSeconds: Math.max(0, span - secondsRecorded),
        rowInterval: interval,
        gaps,
        largestGapSeconds: largest,
    };
}


/*
 * WHAT THIS DOES: decides whether a recording may be presented as a whole race, and records the
 * reasons if not. A recording is complete only when it ran from the gun to the line with no
 * material holes in it.
 */
export function applyIncompleteness(rec) {
    const reasons = [];
    if (rec.stopReason !== 'finish') {
        reasons.push(stopReasonReason(rec.stopReason));
    }
    // A rider who joined after the gun has no opening to miss: the recording is measured against
    // the join instead.
    const joined = isNum(rec.joinedAtRaceSecond) ? rec.joinedAtRaceSecond : null;
    if (isNum(rec.startedAtRaceSecond) && joined != null && rec.startedAtRaceSecond - joined > 15) {
        reasons.push(`it started ${rec.startedAtRaceSecond - joined} seconds after you joined the ` +
                     `event, so the first part of your race is not in it`);
    } else if (isNum(rec.startedAtRaceSecond) && joined == null && rec.startedAtRaceSecond > 15) {
        reasons.push(`it started ${rec.startedAtRaceSecond} seconds after the gun, so the opening ` +
                     `of the race is not in it`);
    }
    const cov = rec.coverage;
    if (cov && cov.spanSeconds > 30) {
        const tolerance = Math.max(10, Math.round(cov.spanSeconds * 0.05));
        if (cov.missingSeconds > tolerance) {
            reasons.push(`${cov.missingSeconds} of the ${cov.spanSeconds} seconds it covers were ` +
                         `not recorded`);
        }
    }
    rec.incompleteReasons = reasons;
    rec.incomplete = reasons.length > 0;
    return rec;
}


function stopReasonReason(reason) {
    return {
        finish: 'it ended at the finish line',
        manual: 'it was stopped by hand rather than at a finish line',
        'left-event': 'you left the event before the finish',
        'changed-event': 'you joined a different event',
        'lost-feed': 'the data from Zwift stopped arriving',
        'window-closed': 'the window or Sauce closed while it was running',
    }[reason] || `it stopped for an unexpected reason (${reason})`;
}


/*
 * True only for something that really is an athlete payload from Sauce.
 *
 * Worth the ten lines: Sauce merges every listener on one event into a single query and then
 * masks the extra resources back out per listener, and its masking filter walks the payload as an
 * array (src/stats.mjs:806-823). An athlete payload is an object, so a masked listener receives an
 * array with one meaningless entry instead of its data. That happens when another window, or
 * another mod, subscribes to athlete/self/v2 asking for resources this mod did not ask for.
 * Silent data loss is the worst possible failure for a recorder, so it is detected and reported.
 *
 * groups/v2 is NOT exposed to this: nearby/v2 and groups/v2 share the canonical context
 * 'nearby/groups' (src/stats.mjs:922-925) whose getter really does return an array.
 */
export function isSelfPayload(data) {
    return !!data && typeof data === 'object' && !Array.isArray(data) && data.athleteId != null;
}


/*
 * Sauce's own event-finished test, re-run on the payload.
 *
 * _getEventOrRouteInfo publishes `remaining` as `sg.endDistance - state.eventDistance` for a
 * distance event, or `(sg.endTS - serverTime) / 1000` for a duration event, tagged remainingType
 * 'event' (src/stats.mjs:4293-4316). Sauce closes the event slice on exactly those two
 * comparisons (src/stats.mjs:3059-3062).
 *
 * The isFinite check is load bearing. With neither sg.endDistance nor sg.endTS set, remaining is
 * `undefined - number`, which is NaN, and remainingType is still 'event'. Without the check the
 * finish would never be detected and the recording would never stop.
 */
export function isPastEventEnd(data) {
    return !!data && data.remainingType === 'event' && isNum(data.remaining) && data.remaining < 0;
}


/*
 * Sauce's server clock minus this computer's clock, in ms, from one athlete/self/v2 payload, or
 * null when the payload does not carry what it takes. state.worldTime plus Zwift's epoch is
 * Sauce's server time for that state (src/zwift.mjs:111-113), and `updated` is the same world time
 * on the computer's clock (src/stats.mjs:3495 with src/zwift.mjs:103-105), so the difference is
 * Sauce's own correction of the computer clock (worldTimer._offt), with no network latency in it.
 */
export function serverClockOffset(data) {
    const wt = data && data.state && data.state.worldTime;
    if (!isNum(wt) || !isNum(data.updated)) {
        return null;
    }
    const offset = wt + ZWIFT_EPOCH_MS - data.updated;
    return Math.abs(offset) < MAX_SERVER_OFFSET_MS ? Math.round(offset) : null;
}


/*
 * The race second on which Zwift's clock read 1, from the first in-event row `t` on which
 * state.time was non-zero: worked back from state.time, but never before a second on which this
 * recording still saw it read 0, nor before the rider joined. Outside the event state.time is the
 * session's elapsed time, so a join with it already running would otherwise put Zwift's clock
 * thousands of seconds before the gun.
 */
export function zwiftClockStart(t, stateTime, zeroUntil = null, joined = null) {
    return Math.max(t - stateTime + 1, zeroUntil ?? -Infinity, joined ?? -Infinity);
}


/* The event has no end Sauce can see, so nothing will ever trip the finish test. */
export function hasUnknownEventEnd(data) {
    return !!data && data.eventSubgroupId != null &&
        (data.remainingType !== 'event' || !isNum(data.remaining));
}


/*
 * Returns the open event slice for the subgroup the rider is currently in.
 *   an object  -> the race is running
 *   null       -> in an event, but no slice is open (start pen, or the race has finished)
 *   undefined  -> the `events` resource is not in the payload at all, which is the normal case
 *                 because the mod asks Sauce only for `state`
 */
export function activeEventSlice(data) {
    if (!data || data.eventSubgroupId == null) {
        return null;
    }
    if (data.events === undefined) {
        return undefined;
    }
    if (!Array.isArray(data.events)) {
        return null;
    }
    for (const s of data.events) {
        if (s && s.active && s.eventSubgroupId === data.eventSubgroupId) {
            return s;
        }
    }
    return null;
}


export function isRaceLike(event) {
    if (!event || !event.eventType) {
        return false;
    }
    // src/stats.mjs:39-43 eventRaceTypes
    return ['RACE', 'TIME_TRIAL', 'TEAM_TIME_TRIAL'].includes(event.eventType);
}


/* The event tags that make Sauce record nothing at all for the rider (src/stats.mjs:3048-3049). */
export const RECORDING_BLOCKED_TAGS = ['hidethehud', 'nooverlays'];

export function eventBlocksRecording(tags) {
    if (!tags) {
        return false;
    }
    const list = Array.isArray(tags) ? tags : String(tags).split(/[;,]/);
    return list.some(x => RECORDING_BLOCKED_TAGS.includes(String(x).trim().toLowerCase()));
}
