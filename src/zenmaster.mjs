/*
 * Race Report - sprint and KOM results from Zenmaster.
 *
 * WHAT THIS FILE DOES: turns the segment results that Arend teRaa's Zenmaster mod saves during a
 * points race into who was first across the line (FAL) and fastest through (FTS) each scoring
 * segment. Pure logic, testable in node; ui.mjs reads Zenmaster's database and hands it in.
 *
 * Van, 22 Sep 2026: "You should get it info from Arend's points mod", then "let's start with 1":
 * the order on each segment, without points. Zenmaster works points and team scores out in its own
 * window as the race runs and does not save them, and copying its scoring rules (ties, bonuses,
 * per-event FTS, custom teams) would drift from what riders saw in its window.
 *
 * Zenmaster keeps, in its IndexedDB database "segmentResultsDatabase" in the Sauce origin every
 * window shares (Zenmaster-s4z-mods, pages/src/segments-xCoord.mjs openSegmentsDB):
 *   segmentResults, segmentResultsLive   Sauce's segment results, by eventSubgroupId: athleteId,
 *                                        segmentId, elapsed (s), ts (ms, Sauce's server clock)
 *   segmentConfig                        per eventSubgroupId: the race's segments, each with name,
 *                                        segmentId, repeat, enabled and scoreFormat ("FAL,FTS")
 * and ranks them as its points leaderboard does (points-leaderboard.mjs, getEventResults): each
 * rider's result for the nth pass of a segment is their nth by time, FAL orders by ts, FTS by
 * elapsed, and custom and Finish segments are not scoring segments. Race Report only reads.
 *
 * What is saved in the recording is names and team tags as Sauce shows them, never an athlete id,
 * the same as for the riders around you.
 */

export const ZEN_DB = 'segmentResultsDatabase';
// How many riders each segment keeps, plus the rider and team mates wherever they were.
export const SEGMENT_LIST = 10;

const isNum = x => typeof x === 'number' && isFinite(x);

/*
 * `config` is Zenmaster's segmentConfig record for the race, `results` its saved results for it,
 * `whoOf(athleteId)` gives {name, team} as Sauce shows them (name null when Sauce cannot name the
 * rider), and `selfId` the rider's own id. Returns null when there is nothing to report.
 */
export function segmentPointsFrom({config, results, whoOf, selfId}) {
    const segs = ((config && config.segments) || []).filter(s => s && s.type !== 'custom' &&
        !String(s.name || '').includes('Finish') && s.enabled !== false);
    if (!segs.length || !Array.isArray(results) || !results.length) {
        return null;
    }
    const out = [];
    for (const seg of segs) {
        const repeat = isNum(+seg.repeat) && +seg.repeat > 0 ? +seg.repeat : 1;
        const byRider = new Map();
        for (const r of results) {
            if (String(r.segmentId) !== String(seg.segmentId) || r.athleteId == null || !isNum(r.ts)) {
                continue;
            }
            const list = byRider.get(r.athleteId) || [];
            list.push(r);
            byRider.set(r.athleteId, list);
        }
        const passes = [];
        for (const list of byRider.values()) {
            list.sort((a, b) => (a.worldTime ?? a.ts) - (b.worldTime ?? b.ts));
            if (list.length >= repeat) {
                passes.push(list[repeat - 1]);
            }
        }
        if (!passes.length) {
            continue;
        }
        const row = r => {
            const who = whoOf(r.athleteId) || {};
            return {name: who.name || null, team: who.team || null, self: r.athleteId === selfId || undefined};
        };
        const fal = [...passes].sort((a, b) => a.ts - b.ts);
        const fts = [...passes].filter(r => isNum(r.elapsed)).sort((a, b) => a.elapsed - b.elapsed);
        const keep = (list, i) => i < SEGMENT_LIST || list[i].athleteId === selfId;
        out.push({
            name: seg.name || 'a segment',
            repeat,
            scored: String(seg.scoreFormat || '').toUpperCase().split(',').map(x => x.trim()).filter(Boolean),
            riders: passes.length,
            fal: fal.map((r, i) => keep(fal, i) ? {...row(r), place: i + 1, behind: (r.ts - fal[0].ts) / 1000} : null)
                .filter(Boolean),
            fts: fts.map((r, i) => keep(fts, i) ? {...row(r), place: i + 1, elapsed: r.elapsed} : null)
                .filter(Boolean),
        });
    }
    return out.length ? {source: 'zenmaster', segments: out} : null;
}

/*
 * The same from Zwift's own segment times, when Zenmaster saved nothing for the race: what ui.mjs
 * fetches with Sauce's getSegmentResults for each sprint and KOM segment on the roads ridden, over
 * the race's time, as Sauce's own Analysis window does (pages/src/analysis.mjs:1082), kept to the
 * riders in the official results. Every pass is given, since which the organiser scored is not known.
 * `segments` are the recording's route segments, `bySegment` maps a segment id to its results.
 */
export const ZWIFT_PASSES = 5;

export function segmentPointsFromZwift({segments, bySegment, participants, whoOf, selfId}) {
    const config = {segments: []};
    const results = [];
    for (const seg of segments || []) {
        const list = ((bySegment && bySegment.get(String(seg.id))) || [])
            .filter(r => r && participants.has(r.athleteId) && isNum(r.ts));
        if (!list.length) {
            continue;
        }
        const counts = new Map();
        for (const r of list) {
            counts.set(r.athleteId, (counts.get(r.athleteId) || 0) + 1);
            results.push({...r, segmentId: String(seg.id)});
        }
        const passes = Math.min(ZWIFT_PASSES, Math.max(...counts.values()));
        for (let k = 1; k <= passes; k++) {
            config.segments.push({name: seg.name, segmentId: String(seg.id), repeat: k, enabled: true, scoreFormat: ''});
        }
    }
    const sp = segmentPointsFrom({config, results, whoOf, selfId});
    return sp ? {...sp, source: 'zwift'} : null;
}

export function segmentPointsTitle(sp) {
    return sp && sp.source === 'zwift' ? 'SPRINTS AND KOMS, FROM ZWIFT\'S SEGMENT TIMES' : 'SPRINTS AND KOMS, FROM ZENMASTER';
}

/* The lines for the copied texts. `teamKey(tag)` reduces a tag for matching the rider's team. */
export function segmentPointsLines(sp, {includeNames = true, teamTag = null, teamKey = x => x} = {}) {
    if (!sp || !sp.segments || !sp.segments.length) {
        return [];
    }
    const want = teamTag ? teamKey(teamTag) : null;
    const who = x => x.self ? 'you' : includeNames ? (x.name || '(no name)') + (x.team ? ` [${x.team}]` : '') :
        '(name withheld)';
    const mate = x => want && !x.self && x.team && teamKey(x.team) === want;
    const L = [sp.source === 'zwift' ?
        'From Zwift\'s segment times for the riders in the official results, fetched after the race: first ' +
        'across the line (FAL) and fastest through (FTS) on each sprint and KOM on the roads ridden, each ' +
        'pass given. Which of them the organiser scored is not known. The order only, not points.' :
        'From the Zenmaster mod\'s saved segment results, ordered as its points leaderboard orders ' +
        'them: first across the line (FAL) and fastest through (FTS). The order only, not points, and ' +
        'not an official result.'];
    for (const s of sp.segments) {
        const top = (list, f) => list.slice(0, 5).map(x => `${x.place} ${who(x)}${f(x)}`).join(', ');
        const mine = (list, f) => list.filter(x => (x.self || (includeNames && mate(x))) && x.place > 5)
            .map(x => `${x.place} ${who(x)}${f(x)}`);
        // How close the rider came to 10th, which is where points often stop (a tester, 22 Sep 2026:
        // "Was close to top 10 FTS, but didn't get it").
        const tenth = list => list.find(x => x.place === 10);
        const falTail = mine(s.fal, x => ` +${x.behind.toFixed(1)} s` +
            (x.self && x.place > 10 && tenth(s.fal) ? `, ${(x.behind - tenth(s.fal).behind).toFixed(1)} s after 10th` : ''));
        const ftsTail = mine(s.fts, x => ` ${x.elapsed.toFixed(1)} s` +
            (x.self && x.place > 10 && tenth(s.fts) ? `, ${(x.elapsed - tenth(s.fts).elapsed).toFixed(1)} s off 10th` : ''));
        L.push(`${s.name}${s.repeat > 1 ? `, pass ${s.repeat}` : ''}` +
            `${s.scored.length ? ` (scored ${s.scored.join(' and ')})` : ''}, ${s.riders} riders:`);
        L.push(`  first across: ${top(s.fal, x => x.place === 1 ? '' : ` +${x.behind.toFixed(1)} s`)}` +
            `${falTail.length ? `; ${falTail.join(', ')}` : ''}`);
        if (s.fts.length) {
            L.push(`  fastest: ${top(s.fts, x => ` ${x.elapsed.toFixed(1)} s`)}` +
                `${ftsTail.length ? `; ${ftsTail.join(', ')}` : ''}`);
        }
    }
    return L;
}
