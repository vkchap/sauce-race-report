/*
 * A synthetic Sauce feed.
 *
 * WHAT THIS FILE DOES: builds payloads the same shape Sauce for Zwift v2.3.0 emits, and drives a
 * whole race through a recorder, so the mod's logic can be exercised in plain node with no Sauce,
 * no Electron and no Zwift. The citations are the lines each shape was read at, so this file can
 * be checked against the source:
 *
 *   athlete/self/v2 payload      src/stats.mjs:4327-4386  (_formatAthleteDataV2)
 *     BASE, always present: version, createdServerTime, created, updated, age, self, watching,
 *     courseId, athleteId, lapCount, eventSubgroupId, eventPosition, eventParticipants,
 *     gameState, gap, gapDistance, isGapEst (true or ABSENT, never false, :4349), wBal, and the
 *     event or route fields from _getEventOrRouteInfo (:4293-4325): remaining, remainingMetric,
 *     remainingType, remainingEnd.
 *     ONLY WITH RESOURCES: athlete, state, timeInPowerZones, stats, lap, laps, segments, events.
 *     The mod asks for `state` alone, so the payloads below default to that.
 *
 *   state                        src/zwift.proto:4-56 plus src/zwift.mjs:305-323
 *     power, heartrate, draft, speed (km/h), cadence, distance, eventDistance (m), time, laps,
 *     activePowerUp, courseId, roadCompletion, plus Sauce's own state.grade, a rise-over-run
 *     fraction computed in processState (src/stats.mjs:3174).
 *     state.time is the rider's elapsed seconds and is what Sauce starts its event slice on
 *     (src/stats.mjs:3050): zero in the pen, counting up after it starts. worldTime is Zwift's
 *     world time, which Sauce turns into server time (src/zwift.mjs:111-113). runSyntheticRace and
 *     runLineFinish start state.time at the gun; runGunRace starts it late, as it did for Van on
 *     16 Sep 2026.
 *
 *   groups/v2 payload            src/stats.mjs:4224-4230 over the group objects built at
 *                                :4562-4664
 *     weight, weightCount, power, draft, heartrate, heartrateCount, speed, gap, isGapEst,
 *     lengthTime, lengthDistance, id (ONLY for groups of more than one rider, :4653-4659),
 *     created, watching (ONLY on the watched rider's group, :4586), athletes[]
 *     The mod asks for NO resources, so each rider inside carries only the base fields
 *     (:4332-4353) and NO athlete object at all. Names come from a separate local lookup.
 *     The base fields include each rider's own remaining, remainingMetric and remainingType
 *     (:4351, over _getEventOrRouteInfo at :4293-4316), which is how the mod sees a rider behind
 *     reach the line.
 *
 *   event slice inside `events`  src/stats.mjs:1743-1763 (_formatDataSlice) plus
 *                                :1726-1728 (_formatEventDataSlice adds eventSubgroupId)
 *     id, stats (NULL unless stats:true was requested, :1750-1754), active, startIndex,
 *     endIndex, startServerTime, start, end, sport, courseId, eventSubgroupId
 *
 *   event slice stats V1         src/stats.mjs:2666-2713 (_getBucketStats). Peaks are keyed by
 *                                period number in V1 (:221-247) and are an array in V2 (:196-219).
 *                                getAthleteEvents returns the V1 shape (:1717-1718).
 *
 *   getAthleteStreams            src/stats.mjs:1782-1797. `time` is seconds on the athlete data's
 *                                own clock; sliced from the event slice's startIndex it begins at
 *                                the gun, which is the clock the recorder puts its rows on.
 */

const FTP = 300;
export const SELF_ID = 12345;

// Zwift's world time epoch; Sauce's server time is worldTime plus this (src/zwift.mjs:91, :111-113).
const ZWIFT_EPOCH_MS = 1414016074400;


/*
 * localMs, when given, makes the payload's clocks what Sauce sends: `updated` is the state's world
 * time on the computer's clock (src/stats.mjs:3495) and state.worldTime is Sauce's server time
 * minus Zwift's epoch, the server clock being serverOffsetMs ahead of the computer's. Without it
 * the two keep the placeholder values every older test was written with, which the recorder
 * rejects as unmeasurable.
 */
export function makeSelfPayload({t, stateTime, eventSubgroupId, power, hr, cadence, speed, draft,
                                 distance, eventDistance, grade, wBal, eventPosition,
                                 eventParticipants, activePowerUp, endDistance, created = 1000,
                                 watching = true, inSlice = false, sliceActive = false,
                                 withEventsResource = false, withAthleteResource = false,
                                 remainingType = 'event', localMs = null, serverOffsetMs = 0,
                                 createdServerTime = 1700000000000, roadId = undefined,
                                 roadTime = undefined, reverse = undefined}) {
    /*
     * When the event has neither an end distance nor an end time, Sauce computes
     * `sg.endDistance - state.eventDistance` with endDistance undefined, which is NaN, and still
     * tags it remainingType 'event' (src/stats.mjs:4310-4315). That case is reproduced here by
     * leaving endDistance out while keeping remainingType 'event'.
     */
    const remaining = remainingType === 'event' ?
        (endDistance != null && eventDistance != null ? endDistance - eventDistance : NaN) :
        (eventDistance != null ? 1000 : undefined);
    const data = {
        version: 2,
        createdServerTime,
        created,
        updated: localMs != null ? localMs : created + t * 1000,
        age: 0,
        self: true,
        // Sauce emits `true` or leaves the key out. It never emits false (src/stats.mjs:4338).
        watching: watching ? true : undefined,
        courseId: 6,
        athleteId: SELF_ID,
        lapCount: 1,
        eventSubgroupId,
        eventPosition,
        eventParticipants,
        gap: 0,
        gapDistance: 0,
        // isGapEst is deliberately absent: Sauce emits `true` or nothing, never false.
        wBal,
        remaining,
        remainingMetric: 'distance',
        remainingType,
        remainingEnd: endDistance,
        state: {
            athleteId: SELF_ID,
            worldTime: localMs != null ?
                localMs + serverOffsetMs - ZWIFT_EPOCH_MS :
                1700000000000 + t * 1000,
            power,
            heartrate: hr,
            cadence,
            speed,
            draft,
            distance,
            eventDistance,
            grade,
            time: stateTime,
            laps: 0,
            courseId: 6,
            eventSubgroupId,
            activePowerUp,
            roadCompletion: (t * 700) % 1000000,
            sport: 'cycling',
        },
    };
    if (roadId !== undefined) {
        // state.roadId, state.reverse and state.roadTime, as Sauce decodes them
        // (src/zwift.mjs:240-253, :268-270, src/zwift.proto:8).
        Object.assign(data.state, {roadId, roadTime, reverse: !!reverse});
    }
    if (withAthleteResource) {
        data.athlete = {id: SELF_ID, sanitizedFullname: 'Test Rider', ftp: FTP, weight: 74.5};
    }
    if (withEventsResource) {
        data.events = inSlice ? [{
            id: 77,
            stats: null,               // stats:false was requested, so Sauce sends null
            active: sliceActive,
            startIndex: 0,
            endIndex: t,
            startServerTime: 1700000000000,
            start: 0,
            end: sliceActive ? undefined : t,
            sport: 'cycling',
            courseId: 6,
            eventSubgroupId,
        }] : [];
    }
    return data;
}


/*
 * A groups/v2 payload as it arrives when the subscription asks for no resources: group aggregates,
 * and riders carrying only their base fields. No athlete object, because Sauce only attaches one
 * when the `athlete` resource is requested (src/stats.mjs:4357-4359).
 *
 * A group may carry `remaining`, the metres to the line for its first rider. Each rider after the
 * first sits 0.2 s further back at 12 m/s, so their own remaining is 2.4 m more per place.
 */
export function makeGroupsPayload({myGroup, aheadGroups = [], behindGroups = []}) {
    const mk = (g, watching) => ({
        weight: 74,
        weightCount: g.ids.length,
        power: g.power,
        draft: g.draft,
        heartrate: g.hr,
        heartrateCount: g.ids.length,
        speed: g.speed,
        gap: g.gap,
        isGapEst: undefined,
        lengthTime: 2.1,
        lengthDistance: 30,
        id: g.ids.length > 1 ? g.id : undefined,
        created: 1700000000000,
        watching: watching ? true : undefined,
        athletes: g.ids.map((id, i) => ({
            version: 2,
            athleteId: id,
            self: id === SELF_ID ? true : undefined,
            watching: (watching && id === SELF_ID) ? true : undefined,
            courseId: 6,
            eventSubgroupId: 999,
            eventPosition: undefined,
            eventParticipants: undefined,
            gap: g.gap + (i * 0.2),
            gapDistance: (g.gap + i * 0.2) * 12,
            wBal: 15000,
            remaining: g.remaining != null ? g.remaining + i * 0.2 * 12 : undefined,
            remainingMetric: g.remaining != null ? 'distance' : undefined,
            remainingType: g.remaining != null ? 'event' : undefined,
            // Each rider's own numbers, as the groups feed carries them with resources ['state']
            // (WHO DID WHAT IN YOUR GROUP in recorder.mjs): the first rider of a group takes the
            // wind, the rest are in the draft, and power steps down the group.
            state: isFinite(g.power) ? {power: Math.max(0, Math.round(g.power + 40 - (i % 8) * 10)),
                                        draft: i % 5 === 1 ? 0 : (g.draft ?? 60), speed: g.speed} : undefined,
        })),
    });
    return [
        ...aheadGroups.map(g => mk(g, false)),
        mk(myGroup, true),
        ...behindGroups.map(g => mk(g, false)),
    ];
}


/*
 * What Sauce's getAthletes returns for a list of ids: the privacy filtered athlete, or nothing at
 * all for a rider Sauce has no profile for, which includes every rider on the opt-out list
 * (src/stats.mjs:2377-2386, 2414-2416). This is the shape ui.mjs feeds into Recorder.setRiderName.
 */
export function fakeGetAthletes(ids, anonymousIds = []) {
    return ids.map(id => anonymousIds.includes(id) ?
        undefined :
        {id, sanitizedFullname: `Racer ${id}`, ftp: 280, weight: 72, team: FAKE_TEAMS[id]});
}

/*
 * The team Sauce reads out of a Zwift name, as `athlete.team` (src/stats.mjs:70-89, :2275-2282).
 * Only some riders have one, as in a real field.
 */
export const FAKE_TEAMS = {2001: 'SAUCE', 2002: 'SAUCE', 4001: 'ZRL-A', 4002: 'ZRL-A', 4003: 'ZRL-A',
                           4021: 'ZRL-A', 4022: 'CRIT', 4040: 'CRIT'};


/*
 * Sauce's stats hold work in kJ, not J: the saved race of 16 Sep 2026 has soloKj 18.58 for 267 s at
 * 70 W. So each class's kJ is its seconds times the power in them, over 1000, and the three add up
 * to power.kj.
 *
 * Without `samples` the figures are placeholders, kept consistent with each other: every second at
 * the average power. With `samples` ({power, hr, speed, cadence, draft, cls}, one entry per second
 * of the race, cls 'follow', 'work' or 'solo'), every figure is worked out from those seconds, as
 * Sauce works it out from the rider's own, and the class times come from cls.
 */
export function makeEventSliceStatsV1({elapsedTime, activeTime, followTime, workTime, soloTime,
                                       samples = null}) {
    if (samples) {
        return sliceStatsFromSamples({elapsedTime, activeTime, samples});
    }
    const avg = 268;
    const np = 291;
    const kjOf = s => Math.round(s * avg / 10) / 100;
    const worked = followTime + workTime + soloTime;
    return {
        elapsedTime,
        activeTime,
        coffeeTime: 0,
        workTime,
        followTime,
        soloTime,
        workKj: kjOf(workTime),
        followKj: kjOf(followTime),
        soloKj: kjOf(soloTime),
        power: {
            avg,
            max: 812,
            peaks: {
                5: {period: 5, avg: 742, time: 5, ts: 1700000060000},
                15: {period: 15, avg: 611, time: 15, ts: 1700000060000},
                60: {period: 60, avg: 392, time: 60, ts: 1700000090000},
                300: {period: 300, avg: 318, time: 300, ts: 1700000300000},
                1200: {period: 1200, avg: null, time: null, ts: null},
                3600: {period: 3600, avg: null, time: null, ts: null},
            },
            smooth: {5: 270, 15: 268, 60: 265},
            np,
            tss: worked * np * (np / FTP) / (FTP * 3600) * 100,
            kj: kjOf(followTime) + kjOf(workTime) + kjOf(soloTime),
        },
        np: {avg: np, max: 340, peaks: {}, smooth: {}},
        speed: {avg: 41.2, max: 66.1, peaks: {}, smooth: {}},
        hr: {avg: 168, max: 185, peaks: {}, smooth: {}},
        cadence: {avg: 88, max: 121, peaks: {}, smooth: {}},
        draft: {avg: 61, max: 220, peaks: {}, smooth: {}, kj: Math.round(worked * 61 / 10) / 100},
    };
}

function sliceStatsFromSamples({elapsedTime, activeTime, samples}) {
    const {power, hr, speed, cadence, draft, cls} = samples;
    const n = power.length;
    const sum = a => a.reduce((s, x) => s + x, 0);
    const avg = a => sum(a) / a.length;
    const max = a => a.reduce((m, x) => Math.max(m, x), -Infinity);
    const timeOf = c => cls.filter(x => x === c).length;
    const kjOf = c => sum(power.filter((_, i) => cls[i] === c)) / 1000;
    // Normalised power: the fourth-power mean of the 30 s rolling average.
    const rolling = [];
    let run = 0;
    for (let i = 0; i < n; i++) {
        run += power[i] - (i >= 30 ? power[i - 30] : 0);
        if (i >= 29) {
            rolling.push(run / 30);
        }
    }
    const np = Math.pow(avg(rolling.map(x => x ** 4)), 0.25);
    const peak = period => {
        if (n < period) {
            return {period, avg: null, time: null, ts: null};
        }
        let s = sum(power.slice(0, period));
        let best = s;
        let end = period;
        for (let i = period; i < n; i++) {
            s += power[i] - power[i - period];
            if (s > best) {
                best = s;
                end = i + 1;
            }
        }
        return {period, avg: best / period, time: end, ts: 1700000000000 + end * 1000};
    };
    const peaks = Object.fromEntries([5, 15, 60, 300, 1200, 3600].map(p => [p, peak(p)]));
    return {
        elapsedTime,
        activeTime,
        coffeeTime: 0,
        workTime: timeOf('work'),
        followTime: timeOf('follow'),
        soloTime: timeOf('solo'),
        workKj: kjOf('work'),
        followKj: kjOf('follow'),
        soloKj: kjOf('solo'),
        power: {
            avg: avg(power),
            max: max(power),
            peaks,
            smooth: {},
            np,
            tss: n * np * (np / FTP) / (FTP * 3600) * 100,
            kj: sum(power) / 1000,
        },
        np: {avg: np, max: max(rolling), peaks: {}, smooth: {}},
        speed: {avg: avg(speed), max: max(speed), peaks: {}, smooth: {}},
        hr: {avg: avg(hr), max: max(hr), peaks: {}, smooth: {}},
        cadence: {avg: avg(cadence), max: max(cadence), peaks: {}, smooth: {}},
        draft: {avg: avg(draft), max: max(draft), peaks: {}, smooth: {}, kj: sum(draft) / 1000},
    };
}


export function makeEventInfo() {
    return {
        id: 999,
        eventId: 888,
        name: 'Ocean Lava Cliffside Loop Scratch Race',
        subgroupLabel: 'B',
        eventType: 'RACE',
        prettyType: 'Race',
        routeId: 1234,
        routeName: 'Ocean Lava Cliffside Loop',
        routeDistance: 19240,
        routeClimbing: 156,
        distanceInMeters: 0,
        durationInSeconds: 0,
        endDistance: 19240,
        laps: 1,
        powerUps: ['FEATHER', 'ANVIL'],
        tags: ['powerup_percent=FEATHER:50,ANVIL:50'],
        rulesSet: [],
    };
}


/*
 * Sauce's own per-second arrays for the event slice, as ui.mjs attaches them. `time` starts at
 * the gun, which is second 1 in the scripted race below.
 */
export function makeStreams(seconds, {powerAt = t => (t < 120 ? 360 : 255)} = {}) {
    const time = [];
    const power = [];
    const hr = [];
    const speed = [];
    const draft = [];
    const cadence = [];
    const distance = [];
    const wbal = [];
    for (let t = 1; t <= seconds; t++) {
        time.push(t);
        power.push(powerAt(t));
        hr.push(168);
        speed.push(43);
        draft.push(55);
        cadence.push(88);
        distance.push(Math.round(t * 12));
        wbal.push(18000);
    }
    return {time, power, hr, speed, draft, cadence, distance, altitude: [], wbal};
}


export const SYNTHETIC_END_DISTANCE = 19240;


/*
 * Drives a whole race through a recorder: three minutes in the start pen, a hard start, a split
 * on a climb where four riders including one Sauce cannot name go up the road, a long middle, and
 * a finish where Sauce's own end-distance test trips.
 *
 * options:
 *   seconds            length of the race in seconds
 *   anonymousIds       riders Sauce has no profile for, so no name ever arrives for them
 *   penSeconds         seconds spent in the start pen with state.time zero
 *   startAtSecond      pretend the window only opened this far into the race
 *   dropEveryNth       drop this fraction of self packets, as a frozen window would
 *   noEventEnd         the event has no end distance and no end time, so `remaining` is NaN
 *   emptyGroupsFrom/To seconds during which Sauce has nobody at all in view
 *   nameLookupEvery    seconds between the local name lookups ui.mjs does (0 = never)
 *   endDistance        the event's end distance, for a race long enough to need a later line
 *   afterSeconds       keep the feed going this many seconds after the rider's finish packet
 *   afterRiders        whether anybody is in view after the line (default true): the rider's
 *                      own bunch crossing a second or two behind, a chase group of two that
 *                      starts 48 s back and gains 0.1 s every second, reaching the line inside
 *                      two minutes, and a group of two 200 s back that does not
 *   leaveEventAt       the second after the finish at which the rider leaves the event
 */
export function runSyntheticRace(recorder, clock, {seconds = 1500, anonymousIds = [5005],
                                                   withEventsResource = false,
                                                   penSeconds = 180, startAtSecond = 1,
                                                   dropEveryNth = 0, noEventEnd = false,
                                                   emptyGroupsFrom = null, emptyGroupsTo = null,
                                                   nameLookupEvery = 20,
                                                   endDistance: endDistanceOption = SYNTHETIC_END_DISTANCE,
                                                   afterSeconds = 0, afterRiders = true,
                                                   leaveEventAt = null} = {}) {
    const sgId = 999;
    const endDistance = noEventEnd ? undefined : endDistanceOption;
    // Metres to the line for a rider `gap` seconds behind the rider, at 12 m/s.
    const remainingFor = (d, gap) => endDistance == null ? undefined : endDistance - d + gap * 12;
    const named = [2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012];
    const anon = anonymousIds;
    let pack = [SELF_ID, ...named, ...anon];
    let gone = [];

    // In the start pen: in the subgroup, but state.time is 0, so Sauce has not opened an event
    // slice and the mod must not record. Skipped entirely when the window opens mid race.
    if (startAtSecond <= 1) {
        for (let i = 0; i < penSeconds; i++) {
            clock.t += 1000;
            recorder.onSelf(makeSelfPayload({
                t: 0, stateTime: 0, eventSubgroupId: sgId, withEventsResource,
                inSlice: false, sliceActive: false,
                power: 120, hr: 110, cadence: 70, speed: 0, draft: 0, distance: 0,
                eventDistance: 0, grade: 0, wBal: 20000, eventPosition: undefined,
                eventParticipants: undefined, activePowerUp: null, endDistance,
            }));
        }
    }

    let wBal = 20000;
    let dist = 0;
    let lastLookup = 0;
    for (let t = 1; t <= seconds; t++) {
        const climbing = t >= 600 && t < 700;
        const finishing = t > seconds - 120;
        const power = climbing ? 405 : (t < 120 ? 360 : (finishing ? 340 : 255));
        const speed = climbing ? 26 : (finishing ? 46 : 43);
        dist += speed / 3.6;
        wBal = wPrimeBalance(wBal, power);
        const pos = Math.max(1, 30 - Math.floor(t / 60));

        // The split: at 620 s four riders, one of whom Sauce cannot name, leave the group.
        if (t === 620) {
            gone = [2001, 2002, 2003, ...anon];
            pack = pack.filter(x => !gone.includes(x));
        }

        if (t < startAtSecond) {
            continue;
        }
        clock.t += 1000;
        const dropThis = dropEveryNth > 1 && (t % dropEveryNth !== 0);
        if (!dropThis) {
            recorder.onSelf(makeSelfPayload({
                t,
                stateTime: t,
                eventSubgroupId: sgId,
                withEventsResource,
                inSlice: true,
                sliceActive: true,
                power,
                hr: climbing ? 182 : 168,
                cadence: 88,
                speed,
                draft: (t % 7 === 0) ? 0 : 55,
                distance: Math.round(dist),
                eventDistance: Math.round(dist),
                grade: climbing ? 0.062 : 0.004,
                wBal: Math.round(wBal),
                eventPosition: pos,
                eventParticipants: 46,
                activePowerUp: (t >= 300 && t < 330) ? 'FEATHER' :
                    ((t >= seconds - 40 && t < seconds - 10) ? 'AERO' : null),
                endDistance,
            }));
        }

        const blind = emptyGroupsFrom != null && t >= emptyGroupsFrom && t <= emptyGroupsTo;
        if (!dropThis) {
            recorder.onGroups(blind ? [] : makeGroupsPayload({
                myGroup: {
                    ids: pack,
                    power: 300,
                    draft: 60,
                    hr: 170,
                    speed,
                    gap: 0,
                    id: 11,
                    remaining: remainingFor(dist, 0),
                },
                aheadGroups: gone.length ? [{
                    ids: gone,
                    power: 340,
                    draft: 70,
                    hr: 176,
                    speed: speed + 1,
                    gap: -(t - 620) * 0.12,
                    id: 12,
                    remaining: remainingFor(dist, -(t - 620) * 0.12),
                }] : [],
                behindGroups: [{
                    ids: [3001, 3002],
                    power: 240,
                    draft: 40,
                    hr: 160,
                    speed: speed - 2,
                    gap: 18 + t * 0.02,
                    id: 13,
                    remaining: remainingFor(dist, 18 + t * 0.02),
                }],
            }));
        }

        // What ui.mjs does on a slow timer: ask Sauce, locally, for the names of the ids seen so
        // far. Riders Sauce has no profile for never get one.
        if (nameLookupEvery && t - lastLookup >= nameLookupEvery) {
            lastLookup = t;
            const ids = recorder.unnamedRiderIds();
            const athletes = fakeGetAthletes(ids, anon);
            athletes.forEach((a, i) => {
                if (a && a.sanitizedFullname) {
                    recorder.setRiderName(ids[i], a.sanitizedFullname, a.team);
                }
            });
        }
    }

    // The finish: eventDistance passes the event's end distance, which is exactly when Sauce
    // closes its own event slice (src/stats.mjs:3059-3062). With no end distance there is nothing
    // to pass, so the recording is left running, which is the point of that case.
    clock.t += 1000;
    recorder.onSelf(makeSelfPayload({
        t: seconds + 1,
        stateTime: seconds + 1,
        eventSubgroupId: sgId,
        withEventsResource,
        inSlice: true,
        sliceActive: false,
        power: 0, hr: 150, cadence: 0, speed: 20,
        distance: Math.round(dist),
        eventDistance: noEventEnd ? Math.round(dist) : endDistanceOption + 5,
        grade: 0, wBal: Math.round(wBal), eventPosition: 8, eventParticipants: 46,
        activePowerUp: null, endDistance,
    }));

    /*
     * After the line. Second 0 is the finish packet above; its groups payload follows here. A
     * rider `gap` seconds behind at after-second s has (gap - s) * 12 m to go, so they reach the
     * line, in Sauce's own test, the second that goes below zero.
     */
    if (!afterSeconds) {
        return;
    }
    const finishT = seconds + 1;
    const behindAtLine = 18 + finishT * 0.02;
    for (let s = 0; s <= afterSeconds; s++) {
        const t = finishT + s;
        if (s > 0) {
            clock.t += 1000;
            const left = leaveEventAt != null && s >= leaveEventAt;
            recorder.onSelf(makeSelfPayload({
                t,
                stateTime: t,
                eventSubgroupId: left ? undefined : sgId,
                withEventsResource,
                inSlice: !left,
                sliceActive: false,
                power: 90, hr: 140, cadence: 60, speed: 18,
                distance: Math.round(dist) + s * 5,
                eventDistance: left ? undefined : endDistanceOption + 5 + s * 5,
                grade: 0, wBal: Math.round(wBal), eventPosition: 8, eventParticipants: 46,
                activePowerUp: null, endDistance,
                remainingType: left ? 'route' : 'event',
            }));
        }
        const group = (ids, gap, id) => ({
            ids, power: 250, draft: 40, hr: 165, speed: 40, gap, id,
            remaining: (gap - s) * 12,
        });
        recorder.onGroups(afterRiders ? makeGroupsPayload({
            myGroup: {...group(pack, 0, 11), power: 90, speed: 18},
            aheadGroups: gone.length ? [group(gone, -(finishT - 620) * 0.12, 12)] : [],
            behindGroups: [
                group([3001, 3002], behindAtLine - 0.1 * s, 13),
                group([3003, 3004], 200, 14),
            ],
        }) : makeGroupsPayload({
            myGroup: {ids: [SELF_ID], power: 90, draft: 0, hr: 140, speed: 18, gap: 0, id: 11},
        }));
        if (nameLookupEvery && s % nameLookupEvery === 0) {
            const ids = recorder.unnamedRiderIds();
            const athletes = fakeGetAthletes(ids, anon);
            athletes.forEach((a, i) => {
                if (a && a.sanitizedFullname) {
                    recorder.setRiderName(ids[i], a.sanitizedFullname);
                }
            });
        }
    }
}


/*
 * A short race finish driven packet by packet on a millisecond clock, for what the whole-second
 * feed above cannot show. In Sauce the two feeds are independent: athlete/self/v2 goes out on
 * every state packet the rider sends (src/stats.mjs:3509-3513) and groups/v2 on its own 1 s timer
 * (src/stats.mjs:4182-4216), so inside one second either can arrive first, and a late packet can
 * share a second with the one before it.
 *
 * Sauce time here is arrival time. Self packet s arrives at s seconds plus selfPhase ms (the
 * finish packet, s = race + 1, plus finishLateMs as well, the first packet plus gunLateMs); groups
 * payload s arrives at s seconds plus groupsPhase ms. The rider crosses the line between packets
 * race and race + 1.
 *
 * options:
 *   race            seconds of racing before the finish packet
 *   after           seconds the feed runs on after it
 *   selfPhase, groupsPhase, finishLateMs, gunLateMs   see above
 *   metric          'distance' (remaining in metres, each rider on their own) or 'time'
 *                   (remaining in seconds to one end time, the same for everybody,
 *                   src/stats.mjs:4298-4306)
 *   riders          [{id, gap, group, subgroup, hidden: [from, to], name}] where gap is seconds
 *                   behind the rider (negative is ahead), group 0 is the rider's own group and a
 *                   higher number is further back, hidden is a span of seconds the rider is not
 *                   in the payload at all, and name is 'always', 'never' or 'afterLine' (Sauce
 *                   has a profile, has none, or only finds it after the rider's finish)
 *   ridersCarryRemaining   false leaves `remaining` off every other rider
 *   nameLookupEvery        seconds between ui.mjs's name lookups
 *   onSecond        called with (s) after each second's packets, to stop, leave or add notes
 */
export function runLineFinish(recorder, clock, {race = 250, after = 125, selfPhase = 100,
                                                groupsPhase = 300, finishLateMs = 0, gunLateMs = 0,
                                                metric = 'distance', riders = [],
                                                ridersCarryRemaining = true, nameLookupEvery = 5,
                                                onSecond = null} = {}) {
    const SPEED = 12;
    const END = race * SPEED;
    const base = clock.t;
    const cross = race + 0.5 + selfPhase / 1000;
    const events = [];
    for (let s = 1; s <= race + 1 + after; s++) {
        const late = (s === race + 1 ? finishLateMs : 0) + (s === 1 ? gunLateMs : 0);
        events.push({at: base + s * 1000 + selfPhase + late, kind: 'self', s, sec: s + selfPhase / 1000});
        events.push({at: base + s * 1000 + groupsPhase, kind: 'groups', s, sec: s + groupsPhase / 1000});
        events.push({at: base + s * 1000 + 999, kind: 'second', s});
    }
    events.sort((a, b) => (a.at - b.at) || (a.kind === 'second') - (b.kind === 'second'));
    const remainingAt = (sec, gap) => metric === 'time' ? cross - sec : (cross + gap - sec) * SPEED;
    let finished = false;
    for (const e of events) {
        clock.t = e.at;
        if (e.kind === 'self') {
            const p = makeSelfPayload({
                t: e.s, stateTime: e.s, eventSubgroupId: 999,
                power: e.s > race ? 90 : 250 + (e.s % 17) * 5, hr: 160, cadence: 88, speed: 43,
                draft: 20, distance: Math.round(e.s * SPEED),
                eventDistance: Math.round(e.sec * SPEED),
                grade: 0, wBal: 18000, eventPosition: 8, eventParticipants: 40, activePowerUp: null,
                endDistance: END,
            });
            p.remaining = remainingAt(e.sec, 0);
            p.remainingMetric = metric;
            recorder.onSelf(p);
            finished = finished || e.s > race;
        } else if (e.kind === 'groups') {
            const visible = riders.filter(r => !(r.hidden && e.s >= r.hidden[0] && e.s <= r.hidden[1]));
            const keys = [...new Set([0, ...visible.map(r => r.group ?? 0)])].sort((a, b) => a - b);
            recorder.onGroups(keys.map(k => {
                const members = visible.filter(r => (r.group ?? 0) === k);
                const athletes = members.map(r => ({
                    version: 2, athleteId: r.id, courseId: 6, eventSubgroupId: r.subgroup ?? 999,
                    gap: r.gap, gapDistance: r.gap * SPEED, wBal: 15000,
                    remaining: ridersCarryRemaining ? remainingAt(e.sec, r.gap) : undefined,
                    remainingMetric: ridersCarryRemaining ? metric : undefined,
                    remainingType: ridersCarryRemaining ? 'event' : undefined,
                }));
                if (k === 0) {
                    athletes.unshift({version: 2, athleteId: SELF_ID, self: true, watching: true,
                                      courseId: 6, eventSubgroupId: 999, gap: 0, gapDistance: 0,
                                      wBal: 15000, remaining: remainingAt(e.sec, 0),
                                      remainingMetric: metric, remainingType: 'event'});
                }
                return {
                    weight: 74, weightCount: athletes.length, power: 250, draft: 40, heartrate: 160,
                    heartrateCount: athletes.length, speed: 43,
                    gap: k === 0 ? 0 : Math.min(...members.map(r => r.gap)), isGapEst: undefined,
                    lengthTime: 1, lengthDistance: 12, id: athletes.length > 1 ? 100 + k : undefined,
                    created: 1700000000000, watching: k === 0 ? true : undefined, athletes,
                };
            }));
        } else {
            if (nameLookupEvery && e.s % nameLookupEvery === 0) {
                for (const id of recorder.unnamedRiderIds()) {
                    const r = riders.find(x => x.id === id);
                    const name = r && (r.name === 'always' || (r.name === 'afterLine' && finished));
                    if (name) {
                        recorder.setRiderName(id, `Racer ${id}`);
                    }
                }
            }
            if (onSecond) {
                onSecond(e.s);
            }
        }
    }
}


/*
 * The 16 Sep 2026 case, on whole server seconds counted from the gun: the category's scheduled
 * start is GUN_SERVER_MS (09:40:00Z, as Zwift listed category A of event 5694402), the rider rides
 * out of the pen at the gun, and Zwift's state.time only reads 1 at gun second `zwiftClockAt`,
 * counting on from there. Gun second s arrives at server time GUN_SERVER_MS + s * 1000, which is
 * serverOffsetMs later on the computer's clock than the server's. Nothing here says why Zwift's
 * clock starts late; the feed only reproduces the numbers.
 *
 * options:
 *   penSeconds       seconds in the start pen before the gun, stopped, with state.time 0
 *   seconds          gun seconds of racing before the finish packet
 *   zwiftClockAt     gun second on which state.time first reads 1
 *   scheduledStart   hand the scheduled start to the recorder, as ui.mjs does once Sauce has it
 *   serverOffsetMs   Sauce's server clock minus the computer's
 *   serverTime       false leaves worldTime and updated as placeholders, so no server clock
 *   joinAt           the gun second the rider joins the event; before it they ride outside any
 *                    event with state.time as the session's elapsed time, and there is no pen
 *   joinFromHome     with joinAt, nothing at all arrives before the join, as when the rider joins
 *                    from Zwift's home screen
 *   joinStateTime    with joinAt, what state.time is on the join: by default it is 0 until
 *                    zwiftClockAt; a number here keeps the session's elapsed time running into
 *                    the event from that value instead
 *   sauceIdLag       with joinAt, seconds after the join during which only the game's own
 *                    state.eventSubgroupId has the subgroup and Sauce's eventSubgroupId is still
 *                    missing, as while Sauce loads it (src/stats.mjs:3029-3036, :4343)
 *   startLookupAt    hand the scheduled start over only after the self packet of this gun second,
 *                    the way ui.mjs does once its asynchronous lookup comes back; null hands it
 *                    over before the first packet
 *   afterSeconds     keep the feed going this many seconds after the finish packet
 *   onSecond         called with (s) after each gun second's packets
 *
 * Riders: the rider's bunch [2001..2005], and a pair [3001, 3002] 30 s behind that reaches the
 * line 30 s after the rider does.
 */
export const GUN_SERVER_MS = Date.parse('2026-09-16T09:40:00Z');
export const GUN_SPEED = 10;   // m/s from the gun

/*
 * Sauce's createdServerTime for the rider in a gun race: the server time its stream times count
 * from (src/stats.mjs:3389, :4334). Chosen so that the sample for gun second 67 is taken 382 ms
 * into it and reads 240.63, as the first stream sample of the real 16 Sep 2026 recording did.
 */
export const GUN_CREATED_SERVER_MS = GUN_SERVER_MS + 67382 - 240630;

/* The time Sauce's stream sample for gun second `s` carries, on GUN_CREATED_SERVER_MS. */
export function gunStreamTime(s) {
    return (GUN_SERVER_MS + s * 1000 + 382 - GUN_CREATED_SERVER_MS) / 1000;
}

export function gunRacePowerAt(s) {
    return 150 + (s % 60) * 3;
}

export function runGunRace(recorder, clock, {penSeconds = 60, seconds = 600, zwiftClockAt = 67,
                                             scheduledStart = true, serverOffsetMs = 0,
                                             serverTime = true, joinAt = null, joinFromHome = false,
                                             joinStateTime = null, sauceIdLag = 0,
                                             startLookupAt = null,
                                             afterSeconds = 0, onSecond = null} = {}) {
    const sgId = 999;
    const rideFrom = joinAt ?? 0;
    const endDistance = (seconds - rideFrom) * GUN_SPEED;
    if (scheduledStart && startLookupAt == null) {
        recorder.setScheduledStart(sgId, GUN_SERVER_MS);
    }
    const bunch = [SELF_ID, 2001, 2002, 2003, 2004, 2005];
    const first = joinAt != null ? (joinFromHome ? joinAt : joinAt - 30) : -penSeconds;
    for (let s = first; s <= seconds + 1 + afterSeconds; s++) {
        const serverMs = GUN_SERVER_MS + s * 1000;
        clock.t = serverMs - serverOffsetMs;
        const inEvent = joinAt == null || s >= joinAt;
        const moving = s > rideFrom || (joinAt != null && s < joinAt);
        const after = s - (seconds + 1);   // 0 on the finish packet, then seconds after the line
        const eventDistance = !inEvent ? undefined :
            (after >= 0 ? endDistance + 5 + after * 5 : Math.max(0, s - rideFrom) * GUN_SPEED);
        const stateTime = !inEvent ? 5000 + s : joinStateTime != null ? joinStateTime + s - joinAt :
            Math.max(0, s - zwiftClockAt + 1);
        const p = makeSelfPayload({
            t: s, stateTime, eventSubgroupId: inEvent ? sgId : undefined,
            power: moving ? gunRacePowerAt(s) : 0, hr: 150, cadence: moving ? 88 : 0,
            speed: moving ? GUN_SPEED * 3.6 : 0, draft: 20,
            distance: Math.max(0, s - first) * GUN_SPEED, eventDistance,
            grade: 0.01, wBal: 18000, eventPosition: 5, eventParticipants: 10, activePowerUp: null,
            endDistance: inEvent ? endDistance : undefined, remainingType: inEvent ? 'event' : 'route',
            localMs: serverTime ? clock.t : null, serverOffsetMs,
            createdServerTime: GUN_CREATED_SERVER_MS,
        });
        if (inEvent && joinAt != null && s < joinAt + sauceIdLag) {
            p.eventSubgroupId = undefined;
        }
        recorder.onSelf(p);
        if (scheduledStart && startLookupAt != null && s === startLookupAt) {
            recorder.setScheduledStart(sgId, GUN_SERVER_MS);
        }
        if (inEvent && s > rideFrom) {
            const behindRemaining = after >= 0 ? (30 - after) * GUN_SPEED :
                endDistance - eventDistance + 30 * GUN_SPEED;
            recorder.onGroups(makeGroupsPayload({
                myGroup: {ids: bunch, power: 250, draft: 40, hr: 160, speed: 36, gap: 0, id: 11},
                behindGroups: [{ids: [3001, 3002], power: 240, draft: 40, hr: 155, speed: 36,
                                gap: 30, id: 13, remaining: behindRemaining}],
            }));
        }
        if (onSecond) {
            onSecond(s);
        }
    }
}


/*
 * The differential W'bal model Sauce uses (Sauce.power.makeIncWPrimeBalDifferential, configured
 * at src/stats.mjs:375-383), at a CP of FTP and Sauce's default W' of 20 kJ (src/stats.mjs:15), one
 * second at a time.
 */
export function wPrimeBalance(wBal, power, cp = FTP, wPrime = 20000) {
    const next = power > cp ? wBal - (power - cp) : wBal + (wPrime - wBal) * (cp - power) / wPrime;
    return Math.max(0, Math.min(wPrime, next));
}


/* A small seeded random number generator, so a flickering field is the same on every run. */
export function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}


/*
 * The route segment Sauce knows on the long race's climb (a segment as Env.getRoadSegments returns
 * it, src/env.mjs:115-131), which ui.mjs looks up by road when the race is saved.
 */
export const LONG_RACE_SEGMENTS = [
    {id: 901, name: 'Test Ridge KOM', courseId: 6, roadId: 21, reverse: false, roadStart: 0.1,
     roadFinish: 0.9, distance: 600, loop: false},
    {id: 902, name: 'Test Lap Banner', courseId: 6, roadId: 20, reverse: false, roadStart: 0,
     roadFinish: 1, distance: 9000, loop: true},
];

/*
 * The long race's road and the rider's own riding on it, second by second (see runLongRace).
 * A lap is 13 minutes: a 90 s climb at 5.5% from 8:00 into the lap, a 60 s descent at -3%, and
 * 0.4% everywhere else.
 */
export const LONG_RACE_LAP_SECONDS = 780;

export function longRaceGradeAt(t) {
    const s = t % LONG_RACE_LAP_SECONDS;
    return s >= 480 && s < 570 ? 0.055 : (s >= 570 && s < 630 ? -0.03 : 0.004);
}

export function longRaceSpeedAt(t) {
    const g = longRaceGradeAt(t);
    return g > 0.03 ? 25 : g < 0 ? 55 : 42;
}

export function longRaceSelfPower(t, seconds) {
    if (t <= 60) {
        return 420;
    }
    if ((t >= 1290 && t < 1320) || (t >= 3000 && t < 3030)) {
        return 480;
    }
    if (t > seconds - 60) {
        return 520;
    }
    if (longRaceGradeAt(t) > 0.03) {
        return 380;
    }
    return Math.round(250 + 20 * Math.sin(t / 37));
}

const longRaceHrAt = t => (longRaceGradeAt(t) > 0.03 ? 178 : 165);
const longRaceDraftAt = t => (t % 5 === 0 ? 0 : 60);

/*
 * Sauce's event slice stats for the long race, worked out from the rider's own seconds 1 to
 * `seconds`: a second with draft is in a group with draft, one without is in a group with no draft
 * (the rider is never alone in this race).
 */
export function makeLongRaceStats(seconds = 3900) {
    const ts = Array.from({length: seconds}, (_, i) => i + 1);
    return makeEventSliceStatsV1({
        elapsedTime: seconds, activeTime: seconds,
        samples: {
            power: ts.map(t => longRaceSelfPower(t, seconds)),
            hr: ts.map(longRaceHrAt),
            speed: ts.map(longRaceSpeedAt),
            cadence: ts.map(() => 88),
            draft: ts.map(longRaceDraftAt),
            cls: ts.map(t => (longRaceDraftAt(t) > 0 ? 'follow' : 'work')),
        },
    });
}

/*
 * As Sauce gives it for a lapped event (the saved race of 16 Sep 2026: routeDistance and endDistance
 * both 16178.7 m for 4 laps, routeClimbing 155.7 m), the distance and climbing are the whole
 * event's: here the race's own distance, laps and height gained over `seconds`.
 */
export function makeLongEventInfo(endDistance, seconds = 3900) {
    let climbing = 0;
    for (let t = 1; t <= seconds; t++) {
        climbing += Math.max(0, longRaceGradeAt(t)) * longRaceSpeedAt(t) / 3.6;
    }
    return {
        id: 999, eventId: 889, name: 'Synthetic Long Crit', subgroupLabel: 'A', eventType: 'RACE',
        prettyType: 'Race', routeId: 4321, routeName: 'Synthetic Ridge Loop', routeDistance: endDistance,
        routeClimbing: Math.round(climbing * 10) / 10, distanceInMeters: null, durationInSeconds: 0,
        endDistance, laps: Math.round(seconds / LONG_RACE_LAP_SECONDS),
        powerUps: {LIGHTNESS: 0.5, AERO: 0.5}, tags: [], rulesSet: [],
    };
}


/*
 * A long race in a big field whose grouping flickers, as on Van's 69 minute session of
 * 16 Sep 2026, for the membership log, the split hold, and the size of the copied texts on a race
 * with many moments. Five laps of 13 minutes, each with a 90 s climb at 5.5% on a road of its own
 * (with a route segment on it) and a short descent. 80 riders plus the rider, two of whom Sauce
 * cannot name, some with team tags.
 *
 * What happens on the road:
 *    5:00  three riders go clear of the bunch; they are caught at 15:00
 *   21:40  on the second climb twenty riders go clear and six are dropped behind
 *   43:20  three of the twenty come back to the rider's group
 *   50:00  five riders go clear of the rider's group, between it and the twenty
 *   60:40  on the last climb ten riders are dropped from the rider's group
 *   65:00  the line, with the rider's group crossing over a few seconds
 * The rider rides hard at the start, on every climb, at 21:30 and 50:00, and in the last minute.
 *
 * The flicker, from a seeded generator: in about one second in eight, two to four riders of the
 * rider's group show up for that one payload as a group of their own 0.9 s behind; in about two
 * in a hundred, the rider's group shows up cut in two, the rider in a back part of ten. A flicker
 * never lasts a second payload in a row, but it can come back on the payload after that, which is
 * what a recorder looking only every other second would take for a change that held.
 *
 * options: seconds (the race), afterSeconds, flicker (default true), seed, penSeconds,
 * nameLookupEvery
 */
export function runLongRace(recorder, clock, {seconds = 3900, afterSeconds = 125, flicker = true, seed = 7,
                                              penSeconds = 30, nameLookupEvery = 20} = {}) {
    const sgId = 999;
    const LAP = LONG_RACE_LAP_SECONDS;
    const rnd = seeded(seed);
    const range = (a, b) => Array.from({length: b - a + 1}, (_, i) => a + i);
    const anon = [4079, 4080];
    const gradeAt = longRaceGradeAt;
    const speedAt = longRaceSpeedAt;
    const dists = [0];
    for (let t = 1; t <= seconds + 1 + afterSeconds; t++) {
        dists[t] = dists[t - 1] + speedAt(t) / 3.6;
    }
    const endDistance = Math.round(dists[seconds]) + 3;
    const remainingFor = (t, gap) => endDistance - dists[t] + gap * 12;
    const selfPower = t => longRaceSelfPower(t, seconds);
    for (let i = 0; i < penSeconds; i++) {
        clock.t += 1000;
        recorder.onSelf(makeSelfPayload({
            t: 0, stateTime: 0, eventSubgroupId: sgId, power: 100, hr: 100, cadence: 60, speed: 0,
            draft: 0, distance: 0, eventDistance: 0, grade: 0, wBal: 20000, activePowerUp: null,
            endDistance, roadId: 20, roadTime: 5000, reverse: false,
        }));
    }
    let wBal = 20000;
    let lastLookup = 0;
    let flickered = false;
    const lookup = () => {
        const ids = recorder.unnamedRiderIds();
        fakeGetAthletes(ids, anon).forEach((a, i) => {
            if (a && a.sanitizedFullname) {
                recorder.setRiderName(ids[i], a.sanitizedFullname, a.team);
            }
        });
    };
    for (let t = 1; t <= seconds + 1 + afterSeconds; t++) {
        const after = t - (seconds + 1);
        clock.t += 1000;
        const power = after >= 0 ? 90 : selfPower(t);
        wBal = wPrimeBalance(wBal, power);
        const lapS = t % LAP;
        const onClimbRoad = lapS >= 470 && lapS < 580;
        recorder.onSelf(makeSelfPayload({
            t, stateTime: t, eventSubgroupId: sgId, power, hr: longRaceHrAt(t),
            cadence: 88, speed: speedAt(t), draft: longRaceDraftAt(t),
            distance: Math.round(dists[t]),
            eventDistance: after >= 0 ? endDistance + 5 + after * 5 : Math.round(dists[t]),
            grade: gradeAt(t), wBal: Math.round(wBal), eventPosition: Math.max(1, 40 - Math.floor(t / 120)),
            eventParticipants: 81,
            activePowerUp: (t >= 1250 && t < 1265) ? 'LIGHTNESS' : (t >= seconds - 30 && t < seconds - 15) ? 'AERO' : null,
            endDistance,
            roadId: onClimbRoad ? 21 : 20,
            roadTime: 5000 + Math.round(1e6 * (onClimbRoad ? (lapS - 470) / 110 : lapS / LAP)),
            reverse: false,
        }));

        // Who is where, by the script above.
        let bunch = range(4001, 4080);
        const groupsAhead = [];
        const groupsBehind = [];
        const take = ids => {
            bunch = bunch.filter(x => !ids.includes(x));
            return ids;
        };
        if (t >= 300 && t < 900) {
            const gap = t < 700 ? -(t - 300) * 0.15 : -(900 - t) * 0.3;
            groupsAhead.push({ids: take([4001, 4002, 4003]), gap});
        }
        let front = null;
        if (t >= 1300) {
            const ids = take(t >= 2600 ? range(4001, 4017) : range(4001, 4020));
            front = {ids, gap: -Math.min(120, (t - 1300) * 0.2)};
        }
        let chase = null;
        if (t >= 3000) {
            chase = {ids: take(range(4021, 4025)), gap: -Math.min(40, (t - 3000) * 0.1)};
        }
        if (front) {
            groupsAhead.push(front);
        }
        if (chase) {
            groupsAhead.push(chase);
        }
        if (t >= 3640) {
            groupsBehind.push({ids: take(range(4061, 4070)), gap: Math.min(60, (t - 3640) * 0.2)});
        }
        if (t >= 1320) {
            groupsBehind.push({ids: take(range(4071, 4076)), gap: Math.min(200, (t - 1320) * 0.15)});
        }
        let mine = {ids: [SELF_ID, ...bunch], gap: 0};
        const r = rnd();
        if (flicker && after < 0 && t > 10 && !flickered) {
            if (r < 0.02) {
                // The rider's group cut in two for one payload, the rider in a back part of ten.
                const others = bunch.slice();
                const back = others.splice(others.length - 9, 9);
                groupsAhead.push({ids: others, gap: -0.9});
                mine = {ids: [SELF_ID, ...back], gap: 0};
            } else if (r < 0.14) {
                const n = 2 + Math.floor(rnd() * 3);
                const out = [];
                while (out.length < n) {
                    const id = bunch[Math.floor(rnd() * bunch.length)];
                    if (!out.includes(id)) {
                        out.push(id);
                    }
                }
                mine = {ids: [SELF_ID, ...bunch.filter(x => !out.includes(x))], gap: 0};
                groupsBehind.unshift({ids: out, gap: 0.9});
            }
        }
        flickered = !flickered && flicker && after < 0 && t > 10 && r < 0.14;
        const g = x => ({...x, power: 260, draft: 50, hr: 165, speed: speedAt(t), id: x.ids[0],
                         remaining: after >= 0 ? (x.gap - after) * 12 : remainingFor(t, x.gap)});
        recorder.onGroups(makeGroupsPayload({
            myGroup: {...g(mine), power: 270},
            aheadGroups: groupsAhead.sort((a, b) => a.gap - b.gap).map(g),
            behindGroups: groupsBehind.sort((a, b) => a.gap - b.gap).map(g),
        }));
        if (nameLookupEvery && t - lastLookup >= nameLookupEvery) {
            lastLookup = t;
            lookup();
        }
    }
}


export class FakeClock {
    constructor(start = 1700000000000) {
        this.t = start;
    }
    now() {
        return this.t;
    }
}
